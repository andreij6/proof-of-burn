---
type: note
title: "ANSEM LP Reward — research: SOL RPC canister + wallet proof + $ANSEM pools"
tags: [ideas, ansem-lp-reward, research]
timestamp: 2026-07-04T00:00:00Z
---

# Research notes (2026-07-04)

## ICP ↔ Solana: the SOL RPC canister (Chain Fusion)

- **Canister**: `tghme-zyaaa-aaaar-qarca-cai`, runs on the fiduciary subnet,
  controlled by the NNS. Source: dfinity/sol-rpc-canister (reproducible
  builds).
- **Model**: HTTPS-outcall JSON-RPC fanout. Default = 3 distinct providers
  queried in parallel, responses must be EQUAL; consensus strategy
  configurable (e.g. 3-of-5). Providers: Alchemy, Ankr, Chainstack, dRPC,
  Helius, PublicNode. **Paid in cycles attached per request** — no API keys.
- **Typed methods**: `getAccountInfo`, `getBalance`, `getBlock`,
  `getRecentPrioritizationFees`, `getSignaturesForAddress`,
  `getSignatureStatuses`, `getSlot`, **`getTokenAccountBalance`**,
  `getTransaction`, `sendTransaction` — plus generic **`jsonRequest`** for
  anything else and `RpcSources::Custom` for own providers.
- **Rust client**: `sol_rpc_client` + `sol_rpc_types` crates
  (`SolRpcClient::builder_for_ic()`).
- Threshold Ed25519 (canister-owned Solana keys) exists but is NOT needed
  here — this feature only READS Solana and verifies a user-side signature.

## The two verification problems

1. **Wallet ownership** — no chain call at all. Phantom/Solflare expose
   `signMessage` (Ed25519 over arbitrary bytes). The canister verifies with
   `ed25519-dalek` (compiles to wasm). Challenge must bind:
   `"Cycle Burn LP verification\nprincipal: <caller>\nround: <n>\nnonce: <hex>\nexpires: <ts>"`
   → replay-proof, phishing-resistant (human-readable, domain-prefixed).
   The wallet pubkey IS the Solana address (base58 of the 32-byte key).
2. **LP position** — key insight: `getTokenAccountsByOwner` is NOT among the
   typed methods, but it isn't needed. The **associated token account (ATA)
   is deterministically derivable in-canister**: PDA of
   `[owner, TOKEN_PROGRAM_ID, lp_mint]` under the ATA program (sha256 +
   off-curve check; `solana-pubkey`-style derivation, pure Rust, wasm-safe).
   Then one typed `getTokenAccountBalance(ata, commitment=finalized)` per
   pool gives the LP balance with provider consensus. Fallback for exotic
   token accounts (non-ATA) or CLMM positions: `jsonRequest`.

## $ANSEM on Solana — AMBIGUOUS (owner must resolve)

- GeckoTerminal shows at least TWO "ANSEM" tokens with Raydium ANSEM/SOL
  pools: "Official Ansem Coin" (pool `C5WrNH…vX2b`, ~$2.5k liquidity) and
  "SoylanaManletCaptainZ" (pool `7xGQkp…w2kw`, ~$25k liquidity).
- **No ANSEM/USDC pool found** in research — it may not exist yet.
- Pool addresses ≠ LP mint addresses: the LP mint must be read from the
  pool account (one-time, at admin-config time, off-chain is fine).
- Raydium legacy AMM/CPMM → SPL LP tokens (ATA check works). Raydium CLMM →
  position NFTs (ATA check does NOT work). Program of the canonical pool
  must be confirmed.

Sources: [SOL RPC canister README](https://github.com/dfinity/sol-rpc-canister),
[ICP Solana integration docs](https://docs.internetcomputer.org/building-apps/chain-fusion/solana/overview),
[ICP Reaches the Shores of Solana](https://medium.com/dfinity/icp-reaches-the-shores-of-solana-0f373a886dce),
[GeckoTerminal ANSEM/SOL (official)](https://www.geckoterminal.com/solana/pools/C5WrNHiWv9SqZVmeNemc4BzquMfZ2b8PYnFDBUWAvX2b),
[GeckoTerminal ANSEM/SOL (SoylanaManletCaptainZ)](https://www.geckoterminal.com/solana/pools/7xGQkpvqrqCNKwangJaj6h8KFqMu3RC9PRGYkAXhw2kw).
