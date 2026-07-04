---
type: idea
title: "X-Farm — Premium Images via Nano Banana (Gemini 3.1 Flash Image)"
tags: [ideas, x-farm]
timestamp: 2026-06-19T13:23:02-04:00
---

# X-Farm — Premium Images via Nano Banana (Gemini 3.1 Flash Image)

> **Status: SCOPED, NOT BUILT.** Research + design extension. Date: 2026-06-19.
> Adds an **image add-on for premium Farmers** so pro-ICP tweets can ship with a
> generated image. Companion to [06-cloud-run-proxy-build.md](06-cloud-run-proxy-build.md)
> (the proxy that does the generation).

---

## 1. The model: Nano Banana 2 = `gemini-3.1-flash-image`

"Nano Banana" is Google's brand for Gemini's **native image generation**. Three
variants exist; **Nano Banana 2 is the right pick** for x-farm:

| Model | id | Status (2026-06) | Per-image (1K) | Verdict |
|---|---|---|---|---|
| Nano Banana (orig) | `gemini-2.5-flash-image` | 2.5 family retiring (text 2.5 died 2026-06-17) | ~$0.039 | Risky lifecycle; skip. |
| **Nano Banana 2** ✅ | **`gemini-3.1-flash-image`** | **GA on Vertex AI 2026-05-28; supported ≥ 2027-05-28** | **~$0.067** | **Chosen.** GA, supported ~1yr, cheapest of the quality options. |
| Nano Banana Pro | `gemini-3-pro-image-preview` | Preview | ~$0.134 | 2× the cost; only for 4K/text-critical final assets. |

**Per-image cost by resolution (Nano Banana 2, standard tier):**

| Resolution | ~Cost/image | Use |
|---|---|---|
| 512 (~0.25 MP) | **~$0.045** | Tweet in-feed display — recommended (X renders small) |
| 1K (~1 MP) | ~$0.067 | Sharper if the user opens the image |
| 2K (~4 MP) | ~$0.101 | Overkill for a tweet |
| 4K (Preview) | ~$0.15 | Don't. |

Sources: [Gemini 3.1 Flash Image (Cloud)](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-1-flash-image),
[Gemini API image models](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-image),
[Nano Banana 2 guide](https://www.aifreeapi.com/en/posts/gemini-flash-image-api-guide),
[model comparison](https://blog.laozhang.ai/en/posts/gemini-image-model-comparison).

### Why it slots in with ~zero new infra
- **Same SDK + same auth as the text proxy.** `gemini-3.1-flash-image` is called
  with the same `google-genai` `Client(vertexai=True, …)` (keyless Vertex ADC) we
  already use for `gemini-3-flash-preview`. The `aiplatform.user` role we grant the
  runtime SA covers it. **No new API key, no new auth.** Just a second
  `generate_content` call with `response_modalities=["IMAGE", "TEXT"]`.
- **Same Cloud Run service.** Add an `include_image` flag to `POST /v1/tweets`
  (or a `POST /v1/image` companion endpoint) on the existing proxy.
- **Grounding available** — Nano Banana 2 supports Google Search (Web + Image
  Search) grounding, so the image can be grounded on the same fresh ICP news as the
  tweet text.
- **SynthID watermark** is embedded in every generated image — a free, built-in
  **D8 disclosure signal** (the image is provably AI-generated).

The only genuinely new piece of infrastructure is a **Cloud Storage bucket** to
host the generated images (see §3).

---

## 2. The economics — this is the crux (R0)

Images are an **off-chain USD cost paid by the proxy operator**, exactly like the
text Gemini bill — and R0 says the **10% treasury cut must cover it**. Text Gemini
is ~$0.05/farmer-week (negligible). **Images are ~1000× the text cost per unit**, so
the image policy is set by the R0 math, not by the 7-day cycle burn.

**The invariant:** `10% × base_price (USD) ≥ weekly Gemini bill` (text + images).

### What fits (Bloom = 2 ICP base ≈ $4.80, 10% ≈ $0.48/week of treasury headroom)

| Image policy | Images/week | Weekly image bill | Total Gemini (text+img) | Fits Bloom 10% ($0.48)? |
|---|---|---|---|---|
| **1 image/day, 512px** ✅ | 7 | ~$0.32 | ~$0.37 | ✅ yes, with margin |
| 1 image/day, 1K | 7 | ~$0.47 | ~$0.52 | ⚠️ just over — bump base to ~2.5 ICP |
| 1 image per draft, 512px (Bloom 10/day) | 70 | ~$3.15 | ~$3.20 | ❌ no — needs ~13 ICP base to cover via 10% |
| 1 image per draft, 1K (Bloom 10/day) | 70 | ~$4.69 | ~$4.74 | ❌ no — needs ~20 ICP base; absurd |

**Conclusion: image-per-draft is economically unviable** (it would blow past
Bloom's entire 7-day budget and require a ~$50 base price to cover via the 10%
treasury). **1 image/day is the ceiling** and fits cleanly:

- **At 512px, 1 image/day fits within Bloom's existing 10% treasury margin** — no
  base-price change required. This is the recommended premium default.
- **At 1K, bump the image-premium base to ~2.5 ICP** (10% ≈ $0.60 > $0.52 bill) or
  ship 512px only.
- A dedicated **"Harvest" tier above Bloom** (e.g. 10 drafts/day + 1 image/day, 1K,
  ~2.5–3 ICP) is the clean product framing — "premium farmers get a daily image."

### Critical separation: images do NOT touch the 7-day burn
The **90% cycle budget and the deliberate-compute-burn schedule (finding #7) are
unchanged** by images. Images are purely an **off-chain USD cost** that raises the
R0 bar (the 10% treasury must cover a bigger Gemini bill). The on-chain burn — the
point of the feature — is identical. So adding images is **an R0/economics decision,
not a burn-mechanism decision**.

---

## 3. How images get to the user (the canister never holds image bytes)

Generated images come back from Gemini as **`inline_data` base64** (a 1K PNG is
~1–2 MB). The Farmer canister's non-replicated HTTPS outcall is sized for a small
JSON response (~16 KB cap, 02 §D) — **the image cannot come back through the
canister.** (You *could* raise `max_response_bytes`, but pushing 1–2 MB through the
canister is wasteful in cycles + bloats stable state.) So:

```
Farmer tick → POST /v1/tweets {persona, n, history, include_image:true}
  proxy:
    1. text call (gemini-3-flash-preview) → drafts + grounding     [as today]
    2. image call (gemini-3.1-flash-image) for the top/selected draft
       → decode base64 → upload to Cloud Storage bucket → public/signed URL
    3. return JSON {drafts:[{text, cited_url, image_url}], grounding}
  canister stores image_url (a string) in the Draft; never the bytes
frontend: renders image_url directly from Cloud Storage; "download/copy image"
          affordance so the user attaches it manually when posting to X
```

- **New infra: one Cloud Storage bucket** + `roles/storage.objectAdmin` on the
  runtime SA (so the proxy can upload). ~3 `gcloud` lines (see §5). Objects are
  cheap (~$0.020/GB/month) — a 1K PNG (~1 MB) × 7/farmer/week is trivial.
- **Lifecycle:** set a bucket lifecycle rule to **delete image objects after N
  days** (e.g. 30, matching the bounded draft history) so we don't accrue storage
  forever. Bounded by design.
- **Access:** public-read bucket (simplest; these are promotional images meant to
  be posted) OR signed URLs if we want them ephemeral/private. Public-read is fine
  for the MVP and matches "user posts this on X anyway."
- **X posting:** the `twitter.com/intent/tweet` URL is **text-only** — the user
  attaches the image manually in X after downloading/copying it from the dashboard
  (D3 generate-don't-auto-post still holds; we still don't touch the X API).

---

## 4. Proxy code addition (extends 06)

```python
# added to proxy/main.py
from google.cloud import storage
import base64, time

storage_client = storage.Client()
_bucket = storage_client.bucket(os.environ["IMAGE_BUCKET"])  # e.g. "xfarm-images"

def _gen_image(prompt: str) -> str | None:
    resp = client.models.generate_content(
        model="gemini-3.1-flash-image",
        contents=prompt,
        config=types.GenerateContentConfig(
            response_modalities=["IMAGE", "TEXT"],
            image_config=types.ImageConfig(image_size="512", aspect_ratio="1:1"),
        ),
    )
    for part in resp.candidates[0].content.parts:
        if part.inline_data:
            blob = _bucket.blob(f"{int(time.time())}-{os.urandom(4).hex()}.png")
            blob.upload_from_string(base64.b64decode(part.inline_data.data),
                                    content_type="image/png")
            return blob.public_url  # or signed URL
    return None

# in the /v1/tweets handler, after building drafts:
if body.get("include_image") and drafts:
    drafts[0]["image_url"] = _gen_image(image_prompt_for(drafts[0], persona, grounding))
```

The **image prompt** must be guardrailed (R10): no real-person likenesses, no fake
screenshots/charts/quotes, brand-safe pro-ICP visual, disclosure-aware. The persona
is still **untrusted data** — the image prompt is synthesized by the proxy from the
*generated draft text* (trusted-ish, schema-constrained) + a fixed system template,
not from raw user persona text, to limit injection into the image model.

---

## 5. Console-only / gcloud additions (extends 06 §5)

**Nothing new is console-only** — the bucket + IAM are scriptable. Claude Code adds:

```bash
# Cloud Storage bucket for generated images (public-read, 30-day lifecycle)
gcloud storage buckets create gs://xfarm-images --project=proof-of-burn-proxy --location=us
gcloud storage buckets update gs://xfarm-images --default-object-acl=publicRead
# auto-delete objects after 30 days (bounded storage)
echo '{"rule":[{"action":{"type":"Delete"},"condition":{"age":30}}]}' | \
  gcloud storage buckets update gs://xfarm-images --lifecycle-file=-

# let the runtime SA upload images
gcloud projects add-iam-policy-binding proof-of-burn-proxy \
  --member=serviceAccount:xfarm-runtime@proof-of-burn-proxy.iam.gserviceaccount.com \
  --role=roles/storage.objectAdmin

# deploy with the bucket name + the extra model enabled (aiplatform.user already grants it)
gcloud run deploy xfarm-proxy --source . --region=us-central1 \
  --service-account=xfarm-runtime@proof-of-burn-proxy.iam.gserviceaccount.com \
  --set-env-vars="GOOGLE_CLOUD_PROJECT=proof-of-burn-proxy,GOOGLE_CLOUD_LOCATION=us,IMAGE_BUCKET=xfarm-images" \
  --set-secrets="XFARM_BEARER=xfarm-bearer:latest" \
  --min-instances=1 --max-instances=10 --concurrency=80 --timeout=300 \
  --cpu=2 --memory=1Gi --cpu-boost --no-allow-unauthenticated
```

Enable the Vertex AI image model is covered by `aiplatform.user` (already granted in
06). No console visit beyond the 3 steps already in 06 §4.

---

## 6. New / amended risks

- **R0 (amended) — image USD cost.** 1 image/day at 512px (~$0.32/week) fits inside
  Bloom's existing 10% treasury margin; 1K needs a ~2.5 ICP image-tier base. **Hard
  rule: never image-per-draft** (would need a ~$50 base to cover via 10%). The
  10%-covers-Gemini invariant must be re-checked whenever tier prices or image
  policy change. Monitor the image-vs-text bill split.
- **R10 (new) — AI-generated pro-ICP image liability (MED; amplifies R2).** A
  generated image is **visual propaganda** — more persuasive than text and easier to
  mislead with (fake charts, fake screenshots, depictions of real people, fake
  "milestones"). This sharpens R2 (astroturfing / paid token promotion).
  - **Mitigate:** (1) **SynthID watermark** is automatic (free disclosure). (2)
    **D8 disclosure tag** extended to images ("image drafted by my ICP x-Farm
    canister"). (3) **Image-prompt guardrails in the proxy**: no real-person
    likenesses, no fake screenshots/charts/quotes, no misleading figures; brand-safe
    abstract/visual prompts. (4) The image prompt is built from the *generated draft
    text + a fixed template*, not raw user persona (limits injection into the image
    model). (5) The user is the publisher and sees the image before posting (human
    review gate, same as text). (6) Consider **disabling likenesses of identifiable
    people** at the model safety-settings level.
- **R3 (amended) — prompt injection into the image model.** Same untrusted-data
  framing as text; the proxy synthesizes the image prompt from schema-constrained
  draft text, not from raw persona, which is a stronger boundary than the text path.

---

## 7. What ships (premium image add-on, MVP)

- An **`include_image`** flag on `POST /v1/tweets` (or a new premium tier
  "Harvest"): 10 drafts/day + **1 image/day at 512px**, base ~2–2.5 ICP.
- Proxy: text call (as today) + image call → upload to Cloud Storage → return
  `image_url` in the draft JSON. Canister stores the URL only.
- `Draft` gains `image_url: Option<String>` (02 data model).
- Frontend: thumbnail + download/copy-image in the dashboard; user attaches manually
  to the X post. D8 disclosure tag shown on the image card.
- Cloud Storage bucket with a 30-day lifecycle (bounded storage), public-read.
- Ship behind the same `x_farm` flag; gate images on the premium tier only.

**Cost sanity (Bloom + 1 image/day @ 512px):** Gemini ~$0.37/week vs. 10% treasury
~$0.48/week → covered with margin; 90% cycle burn + 7-day depletion unchanged.