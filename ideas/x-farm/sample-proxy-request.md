# X-Farm — sample proxy request/response

A live call to the **production** Cloud Run proxy (`/v1/tweets`), captured 2026-06-19.
Persona: **AI Visionary**. 5 drafts. `gemini-3.5-flash`, grounded (Google Search +
URL context) + schema-typed in one call.

- **Endpoint:** `POST https://xfarm-proxy-1032507435523.us-central1.run.app/v1/tweets`
- **Headers:** `Authorization: Bearer <xfarm-bearer>` · `Content-Type: application/json`
- **Result:** `HTTP 200` in ~37s (cold-ish grounded call).

## Request

```json
{
  "drafts_per_day": 5,
  "persona": "An AI-focused Internet Computer enthusiast, fluent in the latest AI trends and how they intersect with ICP. Loves imagining on-chain AI use cases — autonomous agents, on-chain inference, verifiable models, data sovereignty — that only the Internet Computer can enable. Forward-looking, technical, and imaginative.",
  "history": [],
  "caller_id": "sample-ai-visionary"
}
```

```bash
curl -s -X POST "$URL/v1/tweets" \
  -H "Authorization: Bearer $BEARER" \
  -H "Content-Type: application/json" \
  --data @request.json
```

## Response (`200`)

```json
{
  "drafts": [
    {
      "text": "DFINITY just unveiled its Cloud Engine architecture, turning dapps into self-evolving AIware. Imagine software that rebuilds and extends itself in real-time entirely on-chain. The era of autonomous, self-writing code is officially here on the Internet Computer.",
      "cited_url": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEJ9Sfes-QzAplMTdaR4tBy1wbEdTlI4V5gWYhgvYV5rmxwlWNtzL0_VR-iC1cLSeCr_NMMDAXW5-jyZEJusAQUXF3goaKfIGQ3HzotWgl9mmqP5vFAgcAMQVT4ZGo6_aAHNv9kK1INqbDMWeLyG7UWOSWhKsmhTNOCQuL3ZQ=="
    },
    {
      "text": "When centralized AI models face regulatory shutdowns, where do builders go? The recent Anthropic restrictions sparked a massive capital rotation into decentralized AI. ICP is the ultimate destination for censorship-resistant, sovereign AI infrastructure.",
      "cited_url": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEJ9Sfes-QzAplMTdaR4tBy1wbEdTlI4V5gWYhgvYV5rmxwlWNtzL0_VR-iC1cLSeCr_NMMDAXW5-jyZEJusAQUXF3goaKfIGQ3HzotWgl9mmqP5vFAgcAMQVT4ZGo6_aAHNv9kK1INqbDMWeLyG7UWOSWhKsmhTNOCQuL3ZQ=="
    },
    {
      "text": "Running AI models needs serious data transfer. A new analysis shows hosting on the Internet Computer can be up to 300x cheaper for outbound data transfer (egress) compared to AWS. Decentralized compute isn't just more secure—it's incredibly cost-effective.",
      "cited_url": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEJ9Sfes-QzAplMTdaR4tBy1wbEdTlI4V5gWYhgvYV5rmxwlWNtzL0_VR-iC1cLSeCr_NMMDAXW5-jyZEJusAQUXF3goaKfIGQ3HzotWgl9mmqP5vFAgcAMQVT4ZGo6_aAHNv9kK1INqbDMWeLyG7UWOSWhKsmhTNOCQuL3ZQ=="
    },
    {
      "text": "Project Caffeine AI is turning the \"self-writing internet\" into reality on ICP. Non-programmers can describe an app in natural language, and the AI generates and deploys the code directly into an on-chain canister. True software democracy.",
      "cited_url": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQGgy4rxJwUbFOKgk6c0F64ge7WgPYlMFK4MciZurQHRUWFXb_n_3S2zXFbeJ77QOzbrNDM24RvYrsa5evrJXeU4yVnSoYrGEZ1-IUwY5ffa8U9W8aZ5ekxcaJV5_HH5PyGN5KYbEvS-N4uYd02FA4s9H6w0UKUxN_gZTSP5-ZrbNz1ho3f42W2Uh2IL1gw6JA0="
    },
    {
      "text": "With nearly 980,000 canisters deployed and billions of transactions processed, the Internet Computer's reverse gas model is proving its scale. Developers are building complex, data-heavy AI and Web3 apps without forcing users to pay high gas fees.",
      "cited_url": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQGgy4rxJwUbFOKgk6c0F64ge7WgPYlMFK4MciZurQHRUWFXb_n_3S2zXFbeJ77QOzbrNDM24RvYrsa5evrJXeU4yVnSoYrGEZ1-IUwY5ffa8U9W8aZ5ekxcaJV5_HH5PyGN5KYbEvS-N4uYd02FA4s9H6w0UKUxN_gZTSP5-ZrbNz1ho3f42W2Uh2IL1gw6JA0="
    }
  ]
}
```

## Notes

- Each `cited_url` is a Google grounding redirect (resolves to the real source on
  click) — in JSON mode the SDK exposes the source there, not in `grounding_metadata`.
- The drafts pulled in fresh, real ICP news (Cloud Engine, Caffeine AI, ~980k
  canisters, 300× egress) — confirms Google Search grounding is live.
- The Farmer canister calls this exact endpoint with `caller_id = "farmer-<id>"`; the
  proxy enforces a per-caller daily cap on top of the on-chain 1/day throttle.
