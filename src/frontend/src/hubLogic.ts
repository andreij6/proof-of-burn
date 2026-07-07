// Pure countdown formatting (the sidebar's next-draw chip). The Dashboard
// hub this file once served was removed 2026-07; countdownShort survived it.

/** "2d 4h" / "3h 12m" / "45m" until a nanosecond timestamp; null if past/unset. */
export function countdownShort(atNs: bigint, nowMs: number): string | null {
  if (atNs <= 0n) return null;
  const ms = Number(atNs / 1_000_000n) - nowMs;
  if (ms <= 0) return null;
  const m = Math.floor(ms / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${Math.max(1, m)}m`;
}
