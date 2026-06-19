# proof-of-burn proxy

Off-chain LLM proxy (Cloud Run). One service, two endpoints:

- `POST /v1/tweets` — x-farm: grounded, structured pro-ICP tweet drafts (live).
- `POST /v1/review` — ai-proposal-review (stubbed, 501).

Keyless: uses Vertex AI via Application Default Credentials (the Cloud Run runtime
service account). No Gemini API key. App-level bearer + Cloud IAM = defense in depth.

See [`ideas/x-farm/06-cloud-run-proxy-build.md`](../ideas/x-farm/06-cloud-run-proxy-build.md).

## Local run + curl test

Requires ADC (`gcloud auth application-default login`, already done) and an
ADC quota project (`pob-x-farm-proxy`).

```bash
cd proxy
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

export GOOGLE_CLOUD_PROJECT=pob-x-farm-proxy
export GOOGLE_CLOUD_LOCATION=us
export XFARM_BEARER=local-test-secret

uvicorn main:app --host 0.0.0.0 --port 8080
```

In another shell:

```bash
# health
curl -s localhost:8080/health

# tweets (note the bearer)
curl -s localhost:8080/v1/tweets \
  -H "Authorization: Bearer local-test-secret" \
  -H "Content-Type: application/json" \
  -d '{"drafts_per_day":2,"persona":"an upbeat ICP developer who loves on-chain apps","history":[]}' | jq
```

A 200 with `{"drafts":[{"text":...,"cited_url":...}]}` confirms Gemini 3
grounding + structured output in one call (the `cited_url` per draft is the
grounding source — in JSON mode the SDK exposes it there, not in metadata).

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `GOOGLE_CLOUD_PROJECT` | — (required) | Vertex project |
| `GOOGLE_CLOUD_LOCATION` | `us` | Vertex region (multi-region avoids "model not available") |
| `XFARM_BEARER` | — (required) | shared bearer; from Secret Manager in prod |
| `TWEETS_MODEL` | `gemini-3-flash-preview` | text model |
| `MAX_DRAFTS_PER_CALL` | `10` | hard cap on drafts per request |

## Deploy

See `06-cloud-run-proxy-build.md` §5 (`gcloud run deploy --source .`).
