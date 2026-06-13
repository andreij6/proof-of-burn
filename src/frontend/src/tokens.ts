// Pure token/value helpers shared by the voting dialog and proposal cards —
// kept out of component files so fast refresh stays intact.
import { ExplorerToken } from "./bindings/backend";

// bindgen deduplicates structurally-identical candid variants: now that
// IdeaToken and ExplorerToken share the same member set, only ExplorerToken
// is emitted. Same names, same wire hashes — a rename-export restores the
// IdeaToken identifier for consumers.
export { ExplorerToken as IdeaToken } from "./bindings/backend";
import type { WalletToken } from "./App";

/// Decimals + ExplorerToken variant name per wallet token.
export const WALLET_TOKEN_META: Record<WalletToken, { decimals: number; variant: ExplorerToken }> = {
  ICP: { decimals: 8, variant: ExplorerToken.ICP },
  ckBTC: { decimals: 8, variant: ExplorerToken.CkBTC },
  ckETH: { decimals: 18, variant: ExplorerToken.CkETH },
  ckUSDC: { decimals: 6, variant: ExplorerToken.CkUSDC },
  ckUSDT: { decimals: 6, variant: ExplorerToken.CkUSDT },
};

/// Parse a human amount into smallest units without float drift (18-dec safe).
export function parseTokenUnits(text: string, decimals: number): bigint | null {
  const m = text.trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const frac = (m[2] ?? '').slice(0, decimals).padEnd(decimals, '0');
  try { return BigInt(m[1]) * BigInt(10) ** BigInt(decimals) + BigInt(frac || '0'); } catch { return null; }
}

/// USD-aware threshold progress: when a proposal carries a dollar threshold,
/// progress is the USD VALUE of the committed ICP against it; legacy
/// proposals keep raw ICP terms.
export function thresholdProgress(
  p: { total_committed_e8s: bigint; threshold_e8s: bigint; threshold_usd_e8s?: bigint },
  icpRateUsdE8s: bigint,
): { pct: number; reqSuffix: string } {
  if (p.threshold_usd_e8s !== undefined && p.threshold_usd_e8s !== null && p.threshold_usd_e8s > 0n) {
    const committedUsd = icpRateUsdE8s > 0n ? p.total_committed_e8s * icpRateUsdE8s / 100_000_000n : 0n;
    const pct = Number(committedUsd * 100n / p.threshold_usd_e8s);
    return { pct, reqSuffix: `of ${fmtUsd(p.threshold_usd_e8s)}` };
  }
  const pct = Math.floor((Number(p.total_committed_e8s) / Number(p.threshold_e8s)) * 100);
  return { pct, reqSuffix: `of ${(Number(p.threshold_e8s) / 1e8).toLocaleString()} ICP` };
}

/// "$12.34" from USD e8s.
export function fmtUsd(usdE8s: bigint): string {
  const cents = usdE8s / 1_000_000n;
  return `$${(Number(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

