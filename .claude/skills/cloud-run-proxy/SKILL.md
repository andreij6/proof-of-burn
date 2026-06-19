---
name: cloud-run-proxy
description: Build, deploy, and operate the off-chain LLM proxy on Google Cloud Run (the FastAPI + google-genai service the IC canister calls for Gemini). Use when editing proxy/, deploying or redeploying to Cloud Run, adding an endpoint (/v1/tweets, /v1/review, images), rotating the bearer, reading logs, or debugging 404/401/502/model-not-found errors.
---

# Cloud Run LLM proxy

The repo's only off-chain component: a tiny **FastAPI + `google-genai`** service on
**Cloud Run** that the IC canister calls (non-replicated HTTPS outcall) to get
grounded, structured Gemini output. One service, multiple endpoints:
`POST /v1/tweets` (x-farm, live) and `POST /v1/review` (ai-proposal-review, stubbed).

Lives in `proxy/`. Design rationale + research: `ideas/x-farm/06-cloud-run-proxy-build.md`.
Frozen request/response contract + parallel-work status: `ideas/x-farm/PARALLEL-WORK.md`.

## HARD RULE: deploys are billable

`gcloud run deploy` and any API-enabling / resource-creating `gcloud` command spends
the owner's money. **Only deploy when the owner explicitly asks in the current
conversation.** Local `uvicorn` testing is always fine. Never run interactive auth
(`gcloud auth login`) yourself — it's owner-only via the `!` prefix.

## The deployment (already live)

| Thing | Value |
|---|---|
| Project | `pob-x-farm-proxy` |
| Service URL | `https://xfarm-proxy-1032507435523.us-central1.run.app` |
| Region | `us-central1` |
| Service name | `xfarm-proxy` |
| Runtime SA | `xfarm-runtime@pob-x-farm-proxy.iam.gserviceaccount.com` (roles: `aiplatform.user`, secret accessor) |
| Bearer | Secret Manager `xfarm-bearer:latest` — **never commit it** |
| Vertex model | `gemini-3.5-flash` |
| Billing | account `01A04A-E6CBA3-E43B43`; `$10` budget alert (50/90/100%) |
| Auth | `--allow-unauthenticated` + app-level bearer (see gotchas) |

Console: https://console.cloud.google.com/run/detail/us-central1/xfarm-proxy/metrics?project=pob-x-farm-proxy

## Local run + test (no console, always safe)

```bash
cd proxy
python3 -m venv .venv && source .venv/bin/activate   # reuse .venv if present
pip install -r requirements.txt
export GOOGLE_CLOUD_PROJECT=pob-x-farm-proxy GOOGLE_CLOUD_LOCATION=us XFARM_BEARER=local-test-secret
uvicorn main:app --host 127.0.0.1 --port 8080         # uses your ADC for Vertex
```
Test in another shell:
```bash
curl -s localhost:8080/health
curl -s localhost:8080/v1/tweets -H "Authorization: Bearer local-test-secret" \
  -H "Content-Type: application/json" \
  -d '{"drafts_per_day":3,"persona":"a pragmatic ICP builder","history":[]}' | python3 -m json.tool
```
Requires ADC: `gcloud auth application-default login` (done) + quota project
`pob-x-farm-proxy`. Kill the server with `pkill -f "uvicorn main:app"`.

## Redeploy after a code change

From `proxy/` (builds via Cloud Build → Artifact Registry → Cloud Run; ~2–5 min,
run it backgrounded):
```bash
gcloud run deploy xfarm-proxy --source . --region=us-central1 \
  --project=pob-x-farm-proxy \
  --service-account=xfarm-runtime@pob-x-farm-proxy.iam.gserviceaccount.com \
  --set-env-vars="GOOGLE_CLOUD_PROJECT=pob-x-farm-proxy,GOOGLE_CLOUD_LOCATION=us" \
  --set-secrets="XFARM_BEARER=xfarm-bearer:latest" \
  --min-instances=0 --max-instances=10 --concurrency=80 --timeout=300 \
  --cpu=2 --memory=1Gi --cpu-boost --allow-unauthenticated
```
The service URL is stable across redeploys. Each deploy = a new revision
(`xfarm-proxy-0000N-xxx`).

## Common operations

- **Add an endpoint** (e.g. implement `/v1/review`, or an images endpoint per
  `ideas/x-farm/07-premium-images-nano-banana.md`): add the route to `proxy/main.py`
  behind `_check_auth`, test locally, then redeploy. Keep the same bearer scheme.
- **Rotate the bearer:** `printf '%s' "$NEW" | gcloud secrets versions add xfarm-bearer --data-file=-`
  then redeploy (picks up `:latest`), then owner re-calls the canister's
  `admin_set_xfarm_proxy(url, bearer)`. Generate with `openssl rand -hex 32`.
- **Read logs:** `gcloud run services logs read xfarm-proxy --region=us-central1 --limit=50`
  or the console Logs tab.
- **List available Vertex models:** `python3 -c "from google import genai; [print(m.name) for m in genai.Client(vertexai=True, project='pob-x-farm-proxy', location='us').models.list()]"`

## Gotchas (hard-won — don't re-derive)

- **Model:** use `gemini-3.5-flash` (GA). `gemini-3-flash-preview` **lists but 404s**
  in this project (preview-gated). `gemini-3.1-flash-lite` also works.
- **SDK pin `google-genai==2.9.*`** (not 1.14). 1.14 predates the `url_context` tool
  and Gemini 3 (`types.UrlContext` is absent) → `AttributeError`.
- **Config fields:** the SDK uses `response_mime_type="application/json"` +
  `response_schema=<PydanticModel>` inside `types.GenerateContentConfig`. There is no
  `response_format=` field (that's pseudo-code in older spec drafts).
- **`/healthz` is intercepted by Google Front End** on Cloud Run (never reaches the
  container → Google's own 404 page). Use `/health`. Verify a path reaches the app:
  `/` returns FastAPI's `{"detail":"Not Found"}`, GFE-shadowed paths return Google HTML.
- **`--allow-unauthenticated` is required**, not a shortcut: an IC canister's HTTPS
  outcall can only send a static bearer header, never a Google-signed OIDC identity
  token, so Cloud IAM gating (`--no-allow-unauthenticated`) would block it. Security =
  the app-level bearer + the project `$10` budget cap. Don't "harden" it back to IAM.
- **`--min-instances=0`** on purpose: the caller is a once-daily tick; cold starts are
  irrelevant and scale-to-zero keeps it in the free tier (min-instances=1 with
  cpu=2/1Gi runs a billable instance 24/7).
- **JSON mode (`response_schema`) returns no `grounding_chunks`** — `grounding_metadata`
  is present but its chunks are `None`, so cited source URLs come back inside each
  `Draft.cited_url` (schema-constrained), not from metadata.
- **First request after deploy is a cold start** — a transient 404/503 there can be
  retried; confirm with a second call before concluding the route is broken.

## Frozen API contract (what the canister depends on)

`POST /v1/tweets`, `Authorization: Bearer <bearer>`:
- in: `{"drafts_per_day": int(1..10), "persona": str(required), "history": [str]}`
- out 200: `{"drafts": [{"text": "<=270 chars", "cited_url": "url|null"}]}`
- errors: `401` bad/missing bearer · `422` bad input · `502` generation failed
  (canister marks a Failed day, skips burn tick) · `501` `/v1/review` not built.

Do not change this shape without updating `ideas/x-farm/PARALLEL-WORK.md` and the
canister side. Wiring: owner sets URL + bearer via `admin_set_xfarm_proxy`.
