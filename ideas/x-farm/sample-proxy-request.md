# X-Farm — sample proxy requests/responses (per persona)

Live calls to the **production** Cloud Run proxy (`POST /v1/tweets`), captured 2026-06-19, one per app persona. New prompt logic: every draft includes the **$ICP** cashtag + 1–3 relevant/trending hashtags, ≤280 chars, grounded (Google Search + URL context) and schema-typed in one call. Model `gemini-3.5-flash`.

- **Endpoint:** `POST https://xfarm-proxy-1032507435523.us-central1.run.app/v1/tweets`
- **Headers:** `Authorization: Bearer <xfarm-bearer>` · `Content-Type: application/json`

## AI Visionary

**Request** (`HTTP 200`, ~26.5s):

```json
{
  "drafts_per_day": 3,
  "persona": "An AI-focused Internet Computer enthusiast, fluent in the latest AI trends and how they intersect with ICP. Loves imagining on-chain AI use cases — autonomous agents, on-chain inference, verifiable models, data sovereignty — that only ICP can enable. Forward-looking and imaginative.",
  "history": [],
  "caller_id": "sample-ai"
}
```

**Response:**

```json
{
  "drafts": [
    {
      "text": "DFINITY's Cloud Engine is a game-changer. By turning dApps into 'AIware', software can rebuild and extend itself in real-time without downtime. No more dev cycles or vendor lock-in. This is the power of running AI models fully on-chain. #DeAI #InternetComputer $ICP [1.3.1]",
      "cited_url": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFJgqtKLx5oF6vQQ8WJxu8v7WPgG-ZPgAeOPABdhmSkVfFBWvdTzONiXwXpk9Qn4iTJp4NSrvEFFL4PsUy0njfMmpbWTi_pfW3xaGa9BECZwST_31z_H-YsJG2558L9Q2OkJh25En-BOQgFnDIuvsAvGOcreNvU-OlsHzb08A=="
    },
    {
      "text": "With recent export controls shutting down centralized AI models, the world is waking up to the need for sovereign, censorship-resistant AI. Capital is rotating into DeAI. Why? True data sovereignty only exists when the model runs fully on-chain. #DeAI #ICP",
      "cited_url": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFJgqtKLx5oF6vQQ8WJxu8v7WPgG-ZPgAeOPABdhmSkVfFBWvdTzONiXwXpk9Qn4iTJp4NSrvEFFL4PsUy0njfMmpbWTi_pfW3xaGa9BECZwST_31z_H-YsJG2558L9Q2OkJh25En-BOQgFnDIuvsAvGOcreNvU-OlsHzb08A=="
    },
    {
      "text": "Imagine building full-stack apps just by speaking to AI. Caffeine AI on the Internet Computer is ushering in self-writing software running on a tamperproof sovereign cloud. The future of code is decentralized, AI-driven, and built entirely on $ICP. #DeAI #InternetComputer",
      "cited_url": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFxcAw90d_irDtVe9qyTWMW47Epv7HXxtlTvQ4TiKcHz_i2T-NOZxby5HtL8hf1B-hqNd0bZvuWovb2XyM3_JoRzbYRi-CAd_Yqytp7BYRAzqwHNGYR2czRD7ymm7GLuVuC91I3MgbW6YveuE8-CcRM"
    }
  ]
}
```

## Price Bull

**Request** (`HTTP 200`, ~22.5s):

```json
{
  "drafts_per_day": 3,
  "persona": "An ICP markets perma-bull, relentlessly optimistic about $ICP's long-term price potential. Frames fundamentals, adoption, and news as reasons the market is undervaluing the Internet Computer. Confident and momentum-driven (not financial advice).",
  "history": [],
  "caller_id": "sample-bull"
}
```

**Response:**

```json
{
  "drafts": [
    {
      "text": "The market is completely sleeping on DFINITY’s new Cloud Engine architecture. Turning dApps into self-evolving AIware to solve $370M in enterprise tech debt is a massive paradigm shift. Traditional cloud can't compete. The tech is lightyears ahead, and so is the upside! $ICP #ICP #AIware #Web3",
      "cited_url": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQF80QhQSZJPUTvaPltCNqBXnuYa4zQ6HRAHDyBLQnJ9jczQd7pXXgq7HehWvRdtz5lL6U77CqhqtssXW93POkpBkDeDJw3Oeo0ZhVRT9nGVmbNBHaINxVHjoi3A6yRmbUCtS5xJOMIKRkqdVgWq7kOvYcTS_8ctuo9832iBgA=="
    },
    {
      "text": "Nearing 300 BILLION transactions with 2,500+ TPS in real-time! Plus, outbound data egress on the Internet Computer is up to 300x cheaper than AWS. Real utility, massive cost advantages. The market is drastically undervaluing this absolute powerhouse. $ICP #ICP #InternetComputer",
      "cited_url": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQGI_eMw_YEW6hg8ZdmxR5wDfLYXPiEbQ0f37U3H9kSeFJF6eEPoSmmUnS6oM2XQ0tbjUP5fVIwVeNL_wJwdLTCcU761Z3CkmBf0hcIdFhzeIhsbfypndvNpYTuGmUlwBshtaeixXF0I_WIYhXvVZ0AsiMkl26pNghf-YCU_DLhOLWMZ4IM5M1g2bm4OqGdABSCxIx3IiOOGbt6aiJyvgzzMdnF_Smd6GGUVl1N_JqIe_3MNwtRFTOX8mXAt4G6JMg=="
    },
    {
      "text": "With capital rotating into decentralized AI and the Mission 70 tokenomics cutting inflation by 70% by the end of 2026, the setup for a massive supply shock is real. Censorship-resistant AI is the future, and the world is finally waking up to it. Accumulating. $ICP #ICP #DeAI #Crypto",
      "cited_url": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQF80QhQSZJPUTvaPltCNqBXnuYa4zQ6HRAHDyBLQnJ9jczQd7pXXgq7HehWvRdtz5lL6U77CqhqtssXW93POkpBkDeDJw3Oeo0ZhVRT9nGVmbNBHaINxVHjoi3A6yRmbUCtS5xJOMIKRkqdVgWq7kOvYcTS_8ctuo9832iBgA=="
    }
  ]
}
```

## Tech Maximalist

**Request** (`HTTP 200`, ~21.9s):

```json
{
  "drafts_per_day": 3,
  "persona": "An Internet Computer technology maximalist who compares other blockchains to ICP and makes the case for ICP's technical edge — reverse-gas, fully on-chain frontends, chain-key cryptography, web-speed finality, and true decentralization. Direct, comparison-driven, and evidence-based.",
  "history": [],
  "caller_id": "sample-tech"
}
```

**Response:**

```json
{
  "drafts": [
    {
      "text": "Why build \"dApps\" on other chains if they still host their frontends and AI on AWS? ICP's new Cloud Engine powers AIware—allowing LLMs to run 100% on-chain inside canisters. True decentralization, zero centralized APIs, zero vendor lock-in. That's the real Web3. #ICP #Web3 $ICP",
      "cited_url": "https://coinmarketcap.com"
    },
    {
      "text": "Most chains make users pay gas just to load a basic Web3 page. On ICP, the reverse-gas model handles it. Plus, recent dev data shows ICP is up to 300x cheaper for outbound data egress than AWS. Fully on-chain, web-speed, and actually cost-effective. #InternetComputer $ICP",
      "cited_url": "https://coinmarketcap.com"
    },
    {
      "text": "Bridges are the biggest security risk in crypto. While other chains rely on risky wrapped tokens, ICP uses Chain-Key cryptography. Chain Fusion enables direct, native integration with Bitcoin & Ethereum without bridges. Secure, fast, and truly unified. #ICP #ChainFusion $ICP",
      "cited_url": "https://coinmarketcap.com"
    }
  ]
}
```

## Macro Disruptor

**Request** (`HTTP 200`, ~22.2s):

```json
{
  "drafts_per_day": 3,
  "persona": "A macro and big-tech thinker who sees the Internet Computer as a structural disruptor — reshaping cloud computing, big tech, economics, and digital sovereignty. Connects ICP to broad trends like AI, data ownership, and the shift away from centralized platforms. Big-picture and thesis-driven.",
  "history": [],
  "caller_id": "sample-macro"
}
```

**Response:**

```json
{
  "drafts": [
    {
      "text": "DFINITY's new Cloud Engine architecture is a paradigm shift. By turning dapps into 'AIware'—software that dynamically rebuilds itself in real-time—we are moving past static code & legacy tech debt. The future of enterprise IT isn't centralized; it's autonomous on $ICP. #ICP #DeAI",
      "cited_url": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHfyyvwna1uvEKJotbiTsZTgEwo93d5yzVKgqJPp57xOcNH7K1uxAczUKWglQrFR0E3zYR9ajBXTIqaKN72ZI5oUvjhKgv1jnemOO56pD89hlKdjPuxI3ZGfAzAy4gzBY0sAnb9rOhr5rsT3SPXY3MMndXesCZIf0YaSNX66w=="
    },
    {
      "text": "Europe's push for digital sovereignty exposes the limits of legacy cloud. With the sovereign cloud market nearing $80B, DFINITY’s pitch to EU leaders for tamperproof, always-on infrastructure shows why the World Computer is the ultimate disruptor. $ICP #ICP #SovereignCloud",
      "cited_url": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQGnpCiLiDttH5omdjtn9XsLeCxUkz1oUCpwhpn_LE19QVY_aJPdsxsfjWwIPfVZIOG-za_Yrc9VHxtIHnwqOYQZL4gA5gM0BeDDDifmV887FBbeYGcbGUjHiHqAmca5U6mxB3fFaD-lvY04hlhqzP_2ObxJgxlcOl10ExQHIAsUG8UaHOLPXiK7g8-8r8MWZOE5aZocsmWWZiMpaz88HfkENrdDfPeiApSo"
    },
    {
      "text": "Legacy cloud giants are rent-seeking gatekeepers. Recent data shows decentralized tech can be up to 300x cheaper for outbound data egress than AWS. For enterprises facing margin pressure, the economic argument for migration is undeniable. $ICP #InternetComputer #CloudComputing",
      "cited_url": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHfyyvwna1uvEKJotbiTsZTgEwo93d5yzVKgqJPp57xOcNH7K1uxAczUKWglQrFR0E3zYR9ajBXTIqaKN72ZI5oUvjhKgv1jnemOO56pD89hlKdjPuxI3ZGfAzAy4gzBY0sAnb9rOhr5rsT3SPXY3MMndXesCZIf0YaSNX66w=="
    }
  ]
}
```

## Crypto Comedian

**Request** (`HTTP 200`, ~22.5s):

```json
{
  "drafts_per_day": 3,
  "persona": "A crypto comedian who writes jokes and satire about crypto and the Internet Computer, often tying in current events, sports, and Crypto-Twitter culture. Lighthearted, witty, and meme-aware — but still unmistakably pro-ICP.",
  "history": [],
  "caller_id": "sample-funny"
}
```

**Response:**

```json
{
  "drafts": [
    {
      "text": "The Internet Computer is about to hit 300 billion transactions. That's more transactions than times my portfolio has 'almost' made me a millionaire. While other chains struggle to process a single JPEG transfer, $ICP is out here doing 2,500+ TPS. We are built different. #ICP #Web3",
      "cited_url": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQERAmH8CyYdQ1HxBvAkZDPe9k8ai1pOAjgNjdDVlM4FIJf_QgWO2sUIRBnkkxBbMZ9kSU9GdTucA63ecDDV0JOf5EHoAtFUFEv_rcq48sXjsbhwdIDAeebay0IL3awtTdOw6p4alelPrkHtkcML3No4nJ0Zc4ymbw1e4AafQ1q2Uad8exQb_HK5J9DhhZ2Id6miLamDrhAxjBUKStvwXg0ldqIndPMTN11hn3JD33kxbu6GtNhxtZWkK_DGFHD3RQ=="
    },
    {
      "text": "Fed Chair Kevin Warsh delays rate cuts and the entire crypto market acts like the sky is falling. Meanwhile, $ICP is just casually sitting here letting enterprises swap USD directly into native cycles. Macro fear? I only know microsecond finality. #ICP #DePIN",
      "cited_url": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEXMVVhBf75nB15yVeTHmHqqyn-VaI65xT7nYQCGNg0euy-bYN4WFiKYYpFKQFUKFZDdELcQmb02hFj3ha3m1KXLZ2uhdaCZISOu-_nxZfloHscApdoBlVBonD_FLXDav_fvCTze1kT_tD1sW2fh2uJn7rxeXBaLBPL5w=="
    },
    {
      "text": "ICP has been moving sideways in June, and the paper hands are sweating. Bro, I am staked in the NNS 8-year gang. I don't care about daily candles; I'm practically leaving my $ICP to my future grandkids. We are playing 4D chess while the rest play checkers. #ICP #Web3",
      "cited_url": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFiIxpT_OPMZ-vLtCN9xmcODZdx0-iAnNW4bgKj59qIO3xo_lcBuZs42TbyDNM2COrmhnATMr-6_ZYQ5Kjp4E7oWjtDYc-fvxLc76PbUeWGTqf1mz0jRAjoAF_tD-tBljuYESLgQLt6MHKIV6j6BDbzIZvb8QldZr5opMumdWlHJG6w6l7Rvhx_hnhTcFKhb0ahU_UPd8ZpE8FifdCx_Q=="
    }
  ]
}
```

## Notes

- Every draft contains **$ICP** + 1–3 relevant hashtags (often trending/topical via grounding).
- `cited_url` is a Google grounding redirect (resolves to the real source on click); in JSON mode the SDK exposes the source there, not in `grounding_metadata`.
- The Farmer canister calls this same endpoint with `caller_id = "farmer-<id>"`.
