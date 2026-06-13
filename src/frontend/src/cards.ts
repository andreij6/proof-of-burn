// Playing-card helpers for the poker table. Cards are u8 0..51, encoded
// rank*4 + suit (rank 0=2 … 12=A; suit 0♠ 1♥ 2♦ 3♣). Mirrors the canister.

const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const SUITS = ["♠", "♥", "♦", "♣"];

export function cardRank(c: number): string {
  return RANKS[Math.floor(c / 4)] ?? "?";
}
export function cardSuit(c: number): string {
  return SUITS[c % 4] ?? "?";
}
export function cardLabel(c: number): string {
  if (c < 0 || c >= 52) return "?";
  return cardRank(c) + cardSuit(c);
}
/** Hearts (1) and diamonds (2) render red; spades/clubs dark. */
export function cardIsRed(c: number): boolean {
  return c % 4 === 1 || c % 4 === 2;
}
export function fmtChips(n: number | bigint): string {
  return Number(n).toLocaleString();
}
/** 1 VP = 1,000 chips. */
export function chipsToVp(chips: number | bigint): string {
  return (Number(chips) / 1000).toFixed(2);
}
