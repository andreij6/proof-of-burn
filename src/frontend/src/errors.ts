import { trackError } from './analytics';

// ==========================================================================
// User-facing errors — one rule everywhere (owner 2026-07-14):
//
//   1. The USER sees plain English that says what the problem is. Unknown
//      errors read "Something went wrong…" — never a code, never JSON.
//   2. The REAL error is always logged for debugging:
//        - console.error (tagged [cycle-burn:<context>])
//        - a localStorage ring buffer — run `cbErrors()` in the browser
//          console (or read localStorage 'cb_error_log') to see the last
//          100 raw errors with timestamp + context; `cbErrorsClear()` wipes.
//        - GA4 `error_shown` events (analytics.trackError).
//
// How pages use this:
//   - backend Err results:  throw backendErr(res.Err, 'bonds:buy')
//   - already-friendly text: throw new FriendlyError('Enter an ask in ICP.')
//   - catch handlers:        setErr(toFriendly(e, 'bonds:buy'))
// Local pre-submit validation messages are set directly — they're guidance,
// not errors, and don't need logging.
// ==========================================================================

const LOG_KEY = 'cb_error_log';
const LOG_MAX = 100;

export interface LoggedError { at: string; context: string; error: string }

// localStorage can be unavailable OR silently non-persistent (private mode,
// storage quota, Node's stub localStorage in tests) — probe it once and fall
// back to an in-session memory buffer so cbErrors() always works.
let memoryLog: LoggedError[] | null = null;
let storageOk: boolean | null = null;
function useLocalStorage(): boolean {
  if (storageOk === null) {
    try {
      const k = '__cb_probe__';
      localStorage.setItem(k, '1');
      storageOk = localStorage.getItem(k) === '1';
      localStorage.removeItem(k);
    } catch { storageOk = false; }
    if (!storageOk) memoryLog = [];
  }
  return storageOk;
}

export function readErrorLog(): LoggedError[] {
  if (!useLocalStorage()) return memoryLog ?? [];
  try { return JSON.parse(localStorage.getItem(LOG_KEY) ?? '[]'); } catch { return []; }
}
export function clearErrorLog(): void {
  if (!useLocalStorage()) { memoryLog = []; return; }
  try { localStorage.removeItem(LOG_KEY); } catch { /* ignore */ }
}
// Owner debugging from the browser console.
(globalThis as unknown as Record<string, unknown>).cbErrors = readErrorLog;
(globalThis as unknown as Record<string, unknown>).cbErrorsClear = clearErrorLog;

function rawMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)); }
  catch { return String(err); }
}

/** Record the REAL error (console + ring buffer + GA4); returns the raw text. */
export function logRealError(context: string, err: unknown): string {
  const raw = rawMessage(err);
  console.error(`[cycle-burn:${context}]`, err);
  try {
    const log = readErrorLog();
    log.push({ at: new Date().toISOString(), context, error: raw.slice(0, 2000) });
    if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
    if (useLocalStorage()) localStorage.setItem(LOG_KEY, JSON.stringify(log));
    else memoryLog = log;
  } catch { /* quota — console + GA4 still have it */ }
  trackError(raw, context);
  return raw;
}

export const SOMETHING_WRONG = 'Something went wrong. Please try again.';

/** An error whose message is ALREADY plain English and safe to show.
 *  Pass the raw cause so the real error still lands in the log. */
export class FriendlyError extends Error {
  constructor(friendly: string, raw?: unknown, context = 'app') {
    super(friendly);
    this.name = 'FriendlyError';
    if (raw !== undefined) logRealError(context, raw);
  }
}

/** Wrap a backend Err payload: logs the raw code, throws-ready with the
 *  plain-English translation (or "Something went wrong" when unknown). */
export function backendErr(raw: unknown, context: string): FriendlyError {
  return new FriendlyError(friendlyFromRaw(rawMessage(raw)), raw, context);
}

/** For catch handlers: FriendlyError passes through (already logged),
 *  anything else is logged raw and translated. */
export function toFriendly(err: unknown, context: string): string {
  if (err instanceof FriendlyError) return err.message;
  const raw = logRealError(context, err);
  return friendlyFromRaw(raw);
}

// ── Known-error translations ──────────────────────────────────────────────
// Substring match against the raw error, first hit wins — order specific
// needles before their prefixes (e.g. ALREADY_CLAIMED_TODAY before
// ALREADY_CLAIMED). Backend codes are UPPER_SNAKE text; ledger and agent
// errors arrive as JSON/reject strings, matched the same way.
const TRANSLATIONS: [needle: string, message: string][] = [
  // Session / auth / plumbing
  ['delegation has expired', 'Your session expired — sign in again.'],
  ['Invalid delegation', 'Your session expired — sign in again.'],
  ['Anonymous principal is not allowed', 'You need to sign in first.'],
  ['Failed to fetch', 'Network hiccup — check your connection and try again.'],
  ['NetworkError', 'Network hiccup — check your connection and try again.'],
  ['timed out', 'The network is slow right now — give it a moment and try again.'],
  ['503', 'The Internet Computer is busy right now — try again in a moment.'],
  ['Another transaction is already in progress', 'Hold on — your previous action is still finishing. Give it a few seconds and try again.'],
  ['STAKING_BUSY', 'The staking system is busy with another operation — try again in a few seconds.'],
  ['FEATURE_DISABLED', 'That feature isn\'t open right now — check back soon.'],
  ['UNAUTHORIZED', 'You don\'t have permission to do that.'],

  // Ledger (ICRC-1/2) errors
  ['InsufficientFunds', 'Not enough balance to cover that amount plus the network fee.'],
  ['InsufficientAllowance', 'The spending approval didn\'t cover that amount — try the action again from the start.'],
  ['BadFee', 'The network fee changed under us — just try again.'],
  ['TooOld', 'That request sat too long before reaching the network — try again.'],
  ['CreatedInFuture', 'Your device clock looks off — sync it and try again.'],
  ['Duplicate', 'That transfer already went through — check your balance before retrying.'],

  // Staking / exits
  ['BOND_EXIT_ONLY', 'Exits go through your Stake Bond — redeem the bond instead of unstaking directly.'],
  ['INSUFFICIENT_STAKE', 'You don\'t have that much unwrapped stake in that tier.'],
  ['EXCEEDS_STAKE', 'That\'s more than you have staked.'],
  ['NO_STAKE', 'You don\'t have a stake in that tier.'],
  ['NOT_STAKED', 'This needs an active stake — stake some ICP first.'],
  ['BELOW_MINIMUM', 'That\'s below the minimum for this action.'],
  ['WHOLE_ICP_ONLY', 'Use a whole-ICP amount (1, 2, 3…).'],
  ['POOL_FLOOR', 'The shared pool neuron has to keep at least 1 ICP — try a slightly smaller amount, or try again after more people stake.'],
  ['POOL_NOT_READY', 'The staking pool is still setting up — try again in a minute.'],
  ['REFRESH_PENDING', 'The pool is settling a previous stake — try again in a minute.'],
  ['INSUFFICIENT_DEPOSIT', 'Your transfer hasn\'t arrived yet — send the exact amount first, then retry this step.'],
  ['UNSTAKE_NOT_FOUND', 'We can\'t find that unstake — refresh and try again.'],
  ['TREASURY_CANNOT_FRONT', 'The treasury can\'t front the network fees right now — try again shortly.'],
  ['TREASURY_FEE_COVER', 'The treasury couldn\'t cover the network fee — try again shortly.'],

  // Bonds / marketplace / Golden Ticket
  ['BUYBACK_UNAVAILABLE', 'Instant exit is temporarily unavailable — the buyback fund is replenishing. Sell on the marketplace or wait out the dissolve instead.'],
  ['BUYBACK_IN_PROGRESS', 'That bond is mid-buyback — give it a moment.'],
  ['SALE_IN_PROGRESS', 'That bond is mid-sale — give it a moment and refresh.'],
  ['ALREADY_CLAIMED_TODAY', 'Today\'s tickets are already claimed — come back tomorrow.'],
  ['ALREADY_CLAIMED', 'This account already claimed its Golden Ticket (one per account).'],
  ['CAMPAIGN_CLOSED', 'The Golden Ticket campaign isn\'t open right now.'],
  ['CAMPAIGN_EXHAUSTED', 'All Golden Tickets have been claimed — the campaign is over.'],
  ['DAILY_LIMIT', 'Today\'s Golden Tickets are gone — more unlock tomorrow.'],
  ['NOT_YOUR_BOND', 'Only the bond\'s current owner can do that.'],
  ['BOND_LISTED', 'That bond is listed for sale — cancel the listing first.'],
  ['LISTED: cancel the listing first', 'That bond is listed for sale — cancel the listing first.'],
  ['PROMO_NOT_REDEEMABLE', 'Golden Tickets earn tickets only — they can\'t be redeemed.'],
  ['PROMO_NOT_LISTABLE', 'Golden Tickets earn tickets only — they can\'t be sold.'],
  ['PROMO_NOT_ALLOWED', 'Golden Tickets earn tickets only — they can\'t be sold, redeemed, transferred, or bought back.'],
  ['LP_NOT_ALLOWED', 'LP receipts are managed on the Liquidity Provider page — unstake the position there.'],
  ['ESCROW_NOT_FUNDED', 'The sale escrow hasn\'t received the full ask yet — send the exact ICP amount, then buy.'],
  ['NOT_LISTED', 'That bond isn\'t for sale.'],
  ['NOT_FOR_SALE', 'That isn\'t for sale anymore.'],
  ['LISTING_NOT_FOUND', 'That listing is gone — someone may have beaten you to it.'],
  ['INVALID_PRINCIPAL', 'That doesn\'t look like a wallet principal — paste the principal your wallet shows for you.'],

  // LP staking
  ['POOL_NOT_CONFIGURED', 'That pool isn\'t in the qualifying list.'],
  ['POSITION_NOT_TRANSFERRED', 'We don\'t see that position under the app\'s principal yet — complete the transfer on ICPSwap first, then try again.'],
  ['POSITION_ALREADY_STAKED', 'That position is already registered.'],
  ['NO_RESERVATION', 'Reserve the position here first, then transfer it on ICPSwap.'],
  ['RESERVATION_EXPIRED', 'Your reservation expired — reserve the position again, then confirm.'],
  ['RESERVED_BY_OTHER', 'That position id is reserved by another account.'],
  ['RESERVATION_LIMIT', 'You have too many open reservations — confirm or let one expire first.'],
  ['NOT_YOUR_POSITION', 'Only the account that staked this position can unstake it.'],

  // Voting / commitments
  ['COMMITMENT_CLOSED', 'This proposal is closed to new commitments.'],
  ['NOT_FOLLOWING', 'Your neuron isn\'t following the leader neuron yet — set that up first.'],
  ['Proposal not found', 'That proposal doesn\'t exist anymore — refresh the list.'],

  // Games
  ['ALREADY_PLAYED_TODAY', 'You\'ve already played today\'s round — come back tomorrow.'],
  ['ALREADY_COMPLETED', 'That run is already finished.'],
  ['RUN_EXPIRED', 'That run expired — start a fresh one.'],
  ['NOT_YOUR_RUN', 'That run belongs to another player.'],
  ['INVALID_TIME', 'That result didn\'t validate — play the run again.'],
  ['NO_COURSE', 'That course doesn\'t exist anymore.'],
  ['NO_DRAFT', 'Nothing to test yet — upload your course first.'],
  ['NOT_OWNER', 'Only the owner can do that.'],

  // NNS / infrastructure
  ['UNEXPECTED_NNS_RESPONSE', 'The NNS gave an unexpected answer — nothing was lost; try again shortly.'],
  ['No command response from NNS', 'The NNS didn\'t answer — nothing was lost; try again shortly.'],
  ['SLIPPAGE', 'The price moved while you were confirming — try again.'],
  ['EXCEEDS_GLOBAL_CAP', 'That would push past the global cap for this feature.'],
  ['INVALID_AMOUNT', 'That amount doesn\'t work here — check it and try again.'],
];

/** Plain-English translation for a raw error string; "Something went wrong"
 *  when we don't recognize it (the raw text is in the error log either way). */
export function friendlyFromRaw(raw: string): string {
  for (const [needle, message] of TRANSLATIONS) {
    if (raw.includes(needle)) return message;
  }
  return SOMETHING_WRONG;
}
