// Pure crash-game math, mirroring the canister so the client renders the same
// curve and can verify any round's crash point itself (plans/crash/01, 03 C14).
// Settlement is ALWAYS the canister's truth — these are for display + verify.

const DOMAIN = "caldera-crash-v1";

/** m(t) = e^(0.06·t) in ×100 fixed point, floored, never below 1.00× — the
 * exact curve the canister settles manual cashouts against. */
export function multiplierX100(elapsedMs: number): number {
  if (elapsedMs <= 0) return 100;
  const t = elapsedMs / 1000;
  return Math.max(100, Math.floor(Math.exp(0.06 * t) * 100));
}

/** Display string for an x100 multiplier: 234 -> "2.34". */
export function fmtX(x100: number): string {
  return (x100 / 100).toFixed(2);
}

/** The bustabit-classic crash point from the 64-bit seed word `u` (×100).
 * 1/101 instant-bust at 1.00×; else floor((100·2^52 − h)/(2^52 − h)), cap 100×. */
export function crashPointX100FromU(u: bigint): number {
  if (u % 101n === 0n) return 100;
  const e = 1n << 52n;
  const hb = u & (e - 1n);
  let x = (100n * e - hb) / (e - hb);
  if (x < 100n) x = 100n;
  if (x > 5000n) x = 5000n; // 50.00× cap (max multiplier 5000)
  return Number(x);
}

/** First 8 bytes of a hash, big-endian, as the u64 seed word. */
export function uFromHashBytes(bytes: Uint8Array): bigint {
  let u = 0n;
  for (let i = 0; i < 8; i++) u = (u << 8n) | BigInt(bytes[i]);
  return u;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Client-side verify (C14): sha256(seed ‖ domain) → u → crash point ×100.
 * Uses Web Crypto; mirrors `crash_point_x100` on the canister. */
export async function recomputeCrashX100(seedHex: string): Promise<number> {
  const seed = hexToBytes(seedHex);
  const dom = new TextEncoder().encode(DOMAIN);
  const buf = new Uint8Array(seed.length + dom.length);
  buf.set(seed, 0);
  buf.set(dom, seed.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buf as unknown as BufferSource));
  return crashPointX100FromU(uFromHashBytes(digest));
}

/** sha256 forward-walk: hash `seedHex` `times` times; hex result. Lets the UI
 * confirm a reveal chains back to the published genesis terminal. */
export async function hashForwardHex(seedHex: string, times: number): Promise<string> {
  let bytes = hexToBytes(seedHex);
  for (let i = 0; i < times; i++) {
    bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource));
  }
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Per-round payout cap (VP) — mirrors CASINO_PAYOUT_CAP_VP on the canister. */
export const PAYOUT_CAP_VP = 10_000;

/** The multiplier a bet is actually settled at: the lesser of the chosen target
 * and the multiplier where wager × multiplier hits the 10,000-VP payout cap.
 * A 5,000-VP bet auto-cashes at 2.00×. Mirrors `effective_target_x100`. */
export function effectiveTargetX100(wagerChips: number, targetX100: number): number {
  const capChips = PAYOUT_CAP_VP * 1000; // VP → chips
  const capTarget = Math.max(100, Math.floor((capChips * 100) / Math.max(1, wagerChips)));
  return Math.min(targetX100, capTarget);
}

export type ChipTone = "gold" | "sprout" | "ember";
/** History-bar chip tone: 50× moon (the cap) = gold, ≥2× = sprout, else ember. */
export function historyChipTone(x100: number): ChipTone {
  if (x100 >= 5000) return "gold";
  if (x100 >= 200) return "sprout";
  return "ember";
}

export type BetPhase = "intermission" | "betting" | "running" | "crashed";
export interface MyBet {
  outcome: string; // "pending" | "won" | "lost"
  manual_x100: number;
  target_x100: number;
}

/** Bet-panel state machine: what the big button shows and does, given the
 * round phase and the caller's bet. PLACE BET during betting; CASH OUT while
 * riding; disabled otherwise. */
export function betButton(
  phase: BetPhase,
  myBet: MyBet | null,
  liveX100: number,
): { label: string; enabled: boolean; action: "place" | "cashout" | "none" } {
  if (phase === "betting") {
    return myBet
      ? { label: "BET PLACED", enabled: false, action: "none" }
      : { label: "PLACE BET", enabled: true, action: "place" };
  }
  if (phase === "running") {
    const riding = !!myBet && myBet.outcome === "pending" && myBet.manual_x100 === 0;
    return riding
      ? { label: `CASH OUT @ ${fmtX(liveX100)}×`, enabled: true, action: "cashout" }
      : { label: myBet ? "RIDING…" : "WATCHING", enabled: false, action: "none" };
  }
  return { label: "WAITING…", enabled: false, action: "none" };
}
