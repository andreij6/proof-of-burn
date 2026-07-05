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

## $ANSEM on Solana — RESOLVED (owner, 2026-07-04)

- **Canonical mint: `9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump`** — the
  `pump` suffix marks a pump.fun launch, so post-bonding liquidity lives on
  **PumpSwap** (pump.fun's own AMM), not Raydium. The Raydium "ANSEM" pools
  found earlier are OTHER tokens sharing the ticker — ignore them.
- **PumpSwap LP mechanics** (pump.fun public docs): every pool has ONE
  fungible **Token-2022 LP mint** with the pool as mint authority; the LP
  mint is a PDA of `["pool_lp_mint", pool]` under the PumpSwap program —
  derivable in-canister from the pool address alone. LPs hold plain
  (Token-2022) token balances → ATA + `getTokenAccountBalance` works.
  ATA derivation nuance: Token-2022 accounts use the TOKEN_2022 program id
  in the ATA seeds, not the classic token program.
- **Meteora does NOT use the same mechanism** (owner asked): DLMM positions
  are unique, non-transferable position program accounts — no LP token, no
  NFT; DAMM v2 positions are transferable NFTs. Both need
  jsonRequest + account decoding (~2× scope) — deferred.
- ANSEM/USDC: no such pool found; admin pool config can add one later.

Sources: [SOL RPC canister README](https://github.com/dfinity/sol-rpc-canister),
[ICP Solana integration docs](https://docs.internetcomputer.org/building-apps/chain-fusion/solana/overview),
[ICP Reaches the Shores of Solana](https://medium.com/dfinity/icp-reaches-the-shores-of-solana-0f373a886dce),
[GeckoTerminal ANSEM/SOL (official)](https://www.geckoterminal.com/solana/pools/C5WrNHiWv9SqZVmeNemc4BzquMfZ2b8PYnFDBUWAvX2b),
[GeckoTerminal ANSEM/SOL (SoylanaManletCaptainZ)](https://www.geckoterminal.com/solana/pools/7xGQkpvqrqCNKwangJaj6h8KFqMu3RC9PRGYkAXhw2kw),
[PumpSwap liquidity management (pump.fun public docs)](https://deepwiki.com/pump-fun/pump-public-docs/4.4-liquidity-management),
[Meteora DLMM user guide](https://docs.meteora.ag/user-guide/guides/how-to-use-dlmm),
[Meteora V2 vs V1](https://medium.com/@webrin/meteora-v2-vs-v1-everything-new-improved-9ead0992777a).
