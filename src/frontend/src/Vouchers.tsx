import { useEffect, useState } from 'react';
import { Principal } from '@icp-sdk/core/principal';
import { StakeTier } from './bindings/backend';
import { createActor as createLedgerActor } from './bindings/ledger';
import { Btn, Chip, Eyebrow, Icon, LiveDot, Skeleton, fmtICP } from './ui';
import { TIER_META } from './Staking';

// ==========================================
// Stake Vouchers — a staked position as a transferable NFT. Staking
// AUTO-ISSUES a Backed voucher (the stake IS the voucher). Tickets follow
// whoever holds it; a voucher LISTED for sale pauses its tickets until
// delisted. Three exits: sell on the ICP marketplace, instant house buyback
// at 85% of principal (balance-gated), or redeem → dissolve → 100%. Promo
// ("Golden Ticket") vouchers are a tickets-only class (1/day, 60 days,
// soulbound). This module renders the voucher SECTIONS (VouchersBody),
// mounted inside the Neuron Stake page below the staking UI.
// ==========================================

/** Friendly copy for voucher endpoint error codes. */
export function friendlyVoucherErr(code: string): string {
  switch (code) {
    case 'FEATURE_DISABLED': return 'Stake Bonds aren\'t open yet — check back soon.';
    case 'BUYBACK_UNAVAILABLE': return 'Instant exit is temporarily unavailable — the buyback fund is replenishing. Sell on the marketplace or wait for the dissolve instead.';
    case 'CAMPAIGN_CLOSED': return 'The Golden Ticket campaign isn\'t open right now.';
    case 'CAMPAIGN_EXHAUSTED': return 'All Golden Tickets have been claimed — the campaign is over.';
    case 'DAILY_LIMIT': return 'Today\'s Golden Tickets are gone — more unlock tomorrow. Come back then!';
    case 'ALREADY_CLAIMED': return 'This account already claimed its Golden Ticket (one per account).';
    case 'INVALID_PRINCIPAL': return 'That doesn\'t look like a wallet principal — paste the principal shown in your wallet (not an account id, not a canister).';
    case 'NOT_YOUR_BOND': return 'Only the bond\'s current owner can do that.';
    case 'BOND_LISTED': return 'That bond is listed for sale — cancel the listing first.';
    case 'PROMO_NOT_ALLOWED': return 'Golden Tickets earn tickets only — they can\'t be sold, redeemed, transferred, or bought back.';
    case 'INSUFFICIENT_STAKE': return 'You don\'t have that much unwrapped stake in that tier.';
    case 'BELOW_MINIMUM': return 'The minimum bond is 1 ICP of staked principal.';
    case 'ESCROW_NOT_FUNDED': return 'The sale escrow hasn\'t received the full ask yet — send the exact ICP amount, then buy.';
    case 'NOT_LISTED': return 'That bond isn\'t for sale.';
    default: return code;
  }
}

/** What the house pays right now for a voucher: principal minus the
 *  buyback discount (e.g. 1500 bps → 85%). Floor division, like the canister. */
export function buybackQuoteE8s(amountE8s: bigint, discountBps: number): bigint {
  const keep = 10_000n - BigInt(Math.max(0, Math.min(10_000, discountBps)));
  return (amountE8s * keep) / 10_000n;
}

/** The buyback button only renders enabled when the fund covers the quote. */
export function buybackAvailable(amountE8s: bigint, discountBps: number, fundE8s: bigint): boolean {
  const quote = buybackQuoteE8s(amountE8s, discountBps);
  return quote > 0n && fundE8s >= quote;
}

/** Signed % an ask sits above (+) or below (−) the voucher's principal.
 *  -10 means "10% under principal" — a discount for the buyer. */
export function listingDeltaPct(priceE8s: bigint, amountE8s: bigint): number {
  if (amountE8s <= 0n) return 0;
  return Math.round((Number(priceE8s) / Number(amountE8s) - 1) * 1000) / 10;
}

/** Whole days a promo voucher has left; 0 once expired. */
export function promoDaysLeft(expiresAtNs: bigint, nowMs: number): number {
  const msLeft = Number(expiresAtNs / 1_000_000n) - nowMs;
  return msLeft <= 0 ? 0 : Math.ceil(msLeft / 86_400_000);
}

/** Whole-ICP amounts only (wrap mirrors staking's whole-ICP rule). */
export function parseWrapIcp(text: string): bigint | null {
  const v = parseFloat(text);
  if (isNaN(v) || v <= 0 || !Number.isInteger(v)) return null;
  return BigInt(v) * 100_000_000n;
}

/** Listing price: ICP with up to 4 decimals → e8s; null when invalid. */
export function parsePriceIcp(text: string): bigint | null {
  const t = text.trim();
  if (!/^\d+(\.\d{1,4})?$/.test(t)) return null;
  const v = Math.round(parseFloat(t) * 1e8);
  return v > 0 ? BigInt(v) : null;
}

type BondClass =
  | 'Backed' | 'Promo' | 'LpBacked'
  | { Backed: null } | { Promo: null } | { LpBacked: null };
/** The wrapper bindings decode unit variants as enum STRINGS ("Promo"), not
 *  raw candid objects ({Promo:null}) — handle both so the helpers survive
 *  either layer (the 'in'-on-string crash shipped once; never again). All
 *  three helpers are TOTAL over unknown class strings: anything that isn't
 *  recognized is treated as display-only (no money actions). */
export function isPromo(c: BondClass | { Promo?: null } | string): boolean {
  if (typeof c === 'string') return c === 'Promo';
  return typeof c === 'object' && c !== null && 'Promo' in c;
}
/** LP-custody receipt voucher — managed on the Liquidity Provider page,
 *  never sellable or redeemable here. */
export function isLpBacked(c: BondClass | { LpBacked?: null } | string): boolean {
  if (typeof c === 'string') return c === 'LpBacked';
  return typeof c === 'object' && c !== null && 'LpBacked' in c;
}
/** ONLY plain Backed vouchers get money actions (sell/redeem/buy) — promos,
 *  LP receipts, and any future/unknown class are display-only. */
export function isBacked(c: BondClass | object | string): boolean {
  if (typeof c === 'string') return c === 'Backed';
  return typeof c === 'object' && c !== null && 'Backed' in c;
}

export interface BondView {
  id: bigint;
  class: BondClass;
  tier: StakeTier;
  amount_e8s: bigint;
  owner: Principal;
  minted_at: bigint;
  expires_at: bigint | null;
  listed_price_e8s: bigint | null;
}

/** Marketplace listings ordered BEST DEAL FIRST — ascending ask/value ratio,
 *  so the biggest discount vs principal sits on top. Stable for ties (id
 *  ascending). Pure; unit-tested. */
export function sortListingsBestDeal(listings: BondView[]): BondView[] {
  return [...listings].sort((a, b) => {
    const ra = a.amount_e8s > 0n ? Number(a.listed_price_e8s ?? 0n) / Number(a.amount_e8s) : Infinity;
    const rb = b.amount_e8s > 0n ? Number(b.listed_price_e8s ?? 0n) / Number(b.amount_e8s) : Infinity;
    if (ra !== rb) return ra - rb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export interface BondMarketInfo {
  enabled: boolean;
  min_wrap_e8s: bigint;
  market_fee_bps: number;
  buyback_discount_bps: number;
  buyback_fund_e8s: bigint;
  my_bonds: BondView[];
  listings: BondView[];
  promo_open: boolean;
  promo_remaining: number;
  promo_claims_today: number;
}

interface VouchersBodyProps {
  actor: any;
  identity: any;
  principal: Principal | null;
  host: string;
  rootKey?: Uint8Array;
  ledgerCanisterId: string;
  onSignIn: () => void;
  /** Which sections render: 'mine' = the holder's vouchers (Neuron Stake
   *  page, above the stake form); 'exchange' = your listings + the
   *  best-deals grid (the Voucher Exchange page). */
  section: 'mine' | 'exchange';
  /** After a successful listing, jump to the Voucher Exchange. */
  onGoExchange?: () => void;
  /** LP-receipt vouchers are managed on the Liquidity Provider page. */
  onGoLiquidity?: () => void;
  /** Bare mode: no page container — render as a plain card column for
   *  embedding inside another page's row (the lottery page). */
  bare?: boolean;
}

const ticketsPerDay = (v: BondView) => Number(TIER_META[v.tier].tickets) * Math.max(1, Math.round(Number(v.amount_e8s) / 1e8));

export function VouchersBody({
  actor, identity, principal, host, rootKey, ledgerCanisterId, onSignIn, section, onGoExchange, onGoLiquidity, bare,
}: VouchersBodyProps) {
  const signedIn = !!principal && !principal.isAnonymous();
  const [info, setInfo] = useState<BondMarketInfo | null>(null);
  const [icpUsdE8s, setIcpUsdE8s] = useState<bigint>(0n);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Modals (owner 2026-07-10): each is a voucher id, or null when closed.
  const [redeemModal, setRedeemModal] = useState<bigint | null>(null);
  const [sellModal, setSellModal] = useState<bigint | null>(null);
  // Sell modal step: pick instant-vs-list first, then the ask form.
  const [sellStep, setSellStep] = useState<'choose' | 'list'>('choose');
  const [buyModal, setBuyModal] = useState<bigint | null>(null);
  const [priceText, setPriceText] = useState('');
  // In-modal operation lifecycle (owner 2026-07-11: money ops must NEVER look
  // frozen). While a money op runs, the open modal swaps to a processing
  // panel; it ends on an explicit success/error panel instead of silently
  // closing. Only one modal is ever open, so one shared phase suffices.
  const [opPhase, setOpPhase] = useState<OpPhase | null>(null);

  const refresh = async () => {
    if (!actor) return;
    try {
      const [i, rates] = await Promise.all([
        actor.get_bond_market(),
        actor.get_usd_rates().catch(() => [] as { token: string; rate_usd_e8s: bigint }[]),
      ]);
      setInfo(i);
      const icp = (rates ?? []).find((r: { token: string }) => r.token === 'ICP');
      setIcpUsdE8s(icp?.rate_usd_e8s ?? 0n);
    } catch { /* best-effort */ }
  };
  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [actor, signedIn]);

  const run = async (label: string, fn: () => Promise<string>) => {
    if (busy) return;
    setBusy(label); setErr(null); setNotice(null);
    try {
      setNotice(await fn());
      await refresh();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(null); }
  };

  /** Money-op runner for the modals: shows a processing panel while the
   *  update call is in flight, then an explicit success/error panel — the
   *  modal never silently closes, and never looks frozen. The page-level
   *  notice stays as a secondary echo. */
  const runOp = async (
    label: string,
    processingText: string,
    fn: () => Promise<{ title: string; detail: string; onDone?: () => void }>,
  ) => {
    if (busy) return;
    setBusy(label); setErr(null); setNotice(null);
    setOpPhase({ kind: 'processing', text: processingText });
    try {
      const success = await fn();
      setOpPhase({ kind: 'success', ...success });
      setNotice(`${success.title} — ${success.detail}`);
      await refresh();
    } catch (e: any) {
      const message = e?.message || String(e);
      setOpPhase({ kind: 'error', message });
      setErr(message);
    } finally { setBusy(null); }
  };

  const redeem = (v: BondView) => runOp(`redeem-${v.id}`, 'Starting the dissolve…', async () => {
    const res = await actor.redeem_stake_bond(v.id);
    if (res.__kind__ === 'Err') throw new Error(friendlyVoucherErr(res.Err));
    return {
      title: 'Dissolve started',
      detail: `Your ${fmtICP(v.amount_e8s)} ICP pays your wallet automatically after the ${TIER_META[v.tier].label} dissolve — nothing to claim.`,
      onDone: () => setRedeemModal(null),
    };
  });

  const list = (v: BondView) => runOp(`list-${v.id}`, 'Listing your bond on the Exchange…', async () => {
    const price = parsePriceIcp(priceText);
    if (!price) throw new Error('Enter an ask in ICP (up to 4 decimals).');
    const res = await actor.list_bond(v.id, price);
    if (res.__kind__ === 'Err') throw new Error(friendlyVoucherErr(res.Err));
    return {
      title: `Listed at ${fmtICP(price)} ICP`,
      detail: 'Your bond is on the Exchange. It won\'t earn tickets while listed — cancel anytime to resume.',
      onDone: () => { setSellModal(null); setSellStep('choose'); setPriceText(''); onGoExchange?.(); },
    };
  });

  const cancelListing = (v: BondView) => run(`cancel-${v.id}`, async () => {
    const res = await actor.cancel_bond_listing(v.id);
    if (res.__kind__ === 'Err') throw new Error(friendlyVoucherErr(res.Err));
    return `Listing for bond #${v.id} cancelled — it's earning tickets again.`;
  });

  const buyback = (v: BondView) => {
    const quote = buybackQuoteE8s(v.amount_e8s, info?.buyback_discount_bps ?? 1500);
    return runOp(`buyback-${v.id}`, `Paying you ${fmtICP(quote)} ICP from the buyback fund…`, async () => {
      const res = await actor.buyback_bond(v.id);
      if (res.__kind__ === 'Err') throw new Error(friendlyVoucherErr(res.Err));
      return {
        title: `${fmtICP(res.Ok)} ICP paid to your wallet`,
        detail: 'The sale is complete and the bond is burned. The ICP is already in your wallet.',
        onDone: () => { setSellModal(null); setSellStep('choose'); setRedeemModal(null); },
      };
    });
  };

  const buy = (v: BondView) => runOp(`buy-${v.id}`, 'Sending your payment to escrow…', async () => {
    if (v.listed_price_e8s == null) throw new Error(friendlyVoucherErr('NOT_LISTED'));
    // 1. Fund the sale escrow with EXACTLY the ask, 2. settle the purchase.
    const escrow = await actor.get_bond_sale_account(v.id);
    const ledger = createLedgerActor(ledgerCanisterId, { agentOptions: { host, identity, rootKey } });
    const xfer = await ledger.icrc1_transfer({
      to: { owner: escrow.owner, subaccount: escrow.subaccount },
      amount: v.listed_price_e8s,
    });
    if (xfer.__kind__ === 'Err') {
      throw new Error(`Payment transfer failed: ${JSON.stringify(xfer.Err, (_k, val) => typeof val === 'bigint' ? val.toString() : val)}`);
    }
    setOpPhase({ kind: 'processing', text: 'Payment escrowed — settling the purchase…' });
    const res = await actor.buy_bond(v.id);
    if (res.__kind__ === 'Err') throw new Error(friendlyVoucherErr(res.Err));
    return {
      title: `Bond #${v.id} is yours`,
      detail: `${ticketsPerDay(v)} tickets just landed for the upcoming draw, and it keeps earning daily.`,
      onDone: () => setBuyModal(null),
    };
  });

  const usd = (e8s: bigint): string => icpUsdE8s > 0n
    ? `$${((Number(e8s) / 1e8) * (Number(icpUsdE8s) / 1e8)).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
    : '';

  const discountBps = info?.buyback_discount_bps ?? 1500;
  const payPct = ((10_000 - discountBps) / 100).toFixed(0);
  const feePct = ((info?.market_fee_bps ?? 250) / 100).toFixed(1);

  const mine = info?.my_bonds ?? [];
  const myUnlisted = mine.filter((v) => v.listed_price_e8s == null);
  const myListed = mine.filter((v) => v.listed_price_e8s != null && !isPromo(v.class));
  const listings = sortListingsBestDeal(info?.listings ?? []);

  if (info && !info.enabled) return null;

  // ── A voucher card in the "Your vouchers" list (unlisted + promo). ──

  return (
    <div className={bare ? "col" : "idea-board-container"} style={bare ? { gap: 14, flex: '1 1 0', minWidth: 300 } : { paddingTop: 0, paddingBottom: 0 }}>
      {notice && (
        <div className="row" style={{ gap: 8, border: '1px solid var(--sprout)', borderRadius: 8, padding: '8px 12px', fontSize: 12.5, color: 'var(--sprout-ink)' }}>
          <Icon name="checkCircle" size={14} stroke="var(--sprout-ink)" /> {notice}
        </div>
      )}
      {err && (
        <div className="row" style={{ gap: 8, border: '1px solid var(--ember)', borderRadius: 8, padding: '8px 12px', fontSize: 12.5, color: 'var(--ember)' }}>
          <Icon name="x" size={14} stroke="var(--ember)" /> {err}
        </div>
      )}

      {(section === 'mine' || section === 'exchange') && (<>
      {/* ── Your bonds + Your listings.
           On the Exchange (with listings) these sit side-by-side in a row;
           on the Stake/Lottery pages only "Your bonds" shows, standalone. */}
      <div className={section === 'exchange' ? 'row' : undefined}
           style={section === 'exchange' ? { gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' } : undefined}>
      {(section === 'mine' || section === 'exchange') && (
      <div className="card col" style={{ gap: 10, flex: section === 'exchange' ? '1 1 320px' : undefined, minWidth: section === 'exchange' ? 300 : undefined }}>
        <span className="row" style={{ gap: 8, justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <Eyebrow>Your bonds</Eyebrow>
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>every stake arrives here as an NFT</span>
        </span>
        {!signedIn ? (
          <span style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>Sign in to see your bonds.</span>
        ) : info === null ? (
          <div className="col" style={{ gap: 8 }} aria-busy="true" aria-label="Loading your bonds">
            <Skeleton width="100%" height={16} />
            <Skeleton width="86%" height={16} />
            <Skeleton width="92%" height={16} />
          </div>
        ) : myUnlisted.length === 0 ? (
          <span style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>
            No bonds here yet — stake ICP above and your bond appears instantly, or claim a Golden Ticket when a campaign is live.
          </span>
        ) : (
          <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 300, width: '100%' }}>
            <table style={{ width: '100%', minWidth: 400, borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)', textAlign: 'left' }}>
                  <th style={{ padding: '6px 8px', fontWeight: 500 }}>Bond</th>
                  <th style={{ padding: '6px 8px', fontWeight: 500 }}>Value</th>
                  <th style={{ padding: '6px 8px', fontWeight: 500 }}>Term</th>
                  <th style={{ padding: '6px 8px', fontWeight: 500 }}>Tickets</th>
                  <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {myUnlisted.map((v) => {
                  const promo = isPromo(v.class);
                  const lp = isLpBacked(v.class);
                  // Money actions ONLY for plain Backed vouchers — promos, LP
                  // receipts, and any unknown future class are display-only.
                  const backed = isBacked(v.class);
                  return (
                    <tr key={String(v.id)} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '8px' }}>
                        <span className="row" style={{ gap: 6 }}>
                          <Icon name={promo ? 'spark' : lp ? 'stack' : 'star'} size={13} stroke={promo ? 'var(--haze-ink)' : 'var(--burn-ink)'} />
                          <b>{promo ? 'Golden Ticket' : `#${String(v.id)}`}</b>
                          {lp && <Chip tone="pending" style={{ height: 16, fontSize: 9 }}>LP</Chip>}
                        </span>
                      </td>
                      <td className="mono" style={{ padding: '8px' }}>
                        {promo ? '—' : lp ? 'LP position' : backed ? `${fmtICP(v.amount_e8s)} ICP` : '—'}
                      </td>
                      <td style={{ padding: '8px', color: 'var(--fg-2)' }}>
                        {promo
                          ? (v.expires_at != null && promoDaysLeft(v.expires_at, Date.now()) > 0
                              ? `${promoDaysLeft(v.expires_at, Date.now())}d left` : 'expired')
                          : lp ? '—' : backed ? TIER_META[v.tier].short : '—'}
                      </td>
                      <td className="mono" style={{ padding: '8px', color: 'var(--sprout-ink)' }}>
                        {promo
                          ? (v.expires_at != null && promoDaysLeft(v.expires_at, Date.now()) > 0 ? '1/day' : '0')
                          : lp ? 'via LP rewards' : backed ? `${ticketsPerDay(v)}/day` : '—'}
                      </td>
                      <td style={{ padding: '8px' }}>
                        <span className="row" style={{ gap: 6, justifyContent: 'flex-end', flexWrap: 'nowrap', whiteSpace: 'nowrap' }}>
                          {backed ? (
                            /* ONE action (owner 2026-07-11): selling lives inside
                               the redeem modal's "Sell it instead" chooser. */
                            <Btn variant="primary" sm onClick={() => { setOpPhase(null); setRedeemModal(v.id); }} disabled={busy !== null}>
                              <Icon name="coins" size={11} stroke="var(--char-950)" /> Redeem ICP
                            </Btn>
                          ) : lp ? (
                            <Btn variant="ghost" sm onClick={() => onGoLiquidity?.()}>
                              Manage on Liquidity Provider →
                            </Btn>
                          ) : (
                            <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>tickets only</span>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      )}

      {/* ── Your listings (hidden entirely when none) — beside Your bonds on the Exchange ── */}
      {section === 'exchange' && signedIn && myListed.length > 0 && (
        <div className="card col" style={{ gap: 10, flex: '1 1 320px', minWidth: 300 }}>
          <span className="row" style={{ gap: 8, justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <Eyebrow accent>Your listings</Eyebrow>
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--haze-ink)' }}>ticket earning paused while listed</span>
          </span>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
            {myListed.map((v) => {
              const delta = listingDeltaPct(v.listed_price_e8s!, v.amount_e8s);
              return (
                <div key={String(v.id)} className="col" style={{ gap: 8, padding: 12, borderRadius: 10, border: '1px solid var(--haze)', background: 'color-mix(in srgb, var(--haze) 8%, var(--surface))' }}>
                  <span className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
                    <b style={{ fontSize: 13.5 }}>{TIER_META[v.tier].short} bond</b>
                    <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>#{String(v.id)}</span>
                  </span>
                  <div className="col" style={{ gap: 3, fontSize: 12 }}>
                    <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                      <span style={{ color: 'var(--fg-3)' }}>Value</span>
                      <span className="mono">{fmtICP(v.amount_e8s)} ICP</span>
                    </div>
                    <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                      <span style={{ color: 'var(--fg-3)' }}>Asking</span>
                      <span className="mono" style={{ fontWeight: 700 }}>{fmtICP(v.listed_price_e8s!)} ICP{usd(v.listed_price_e8s!) ? ` · ${usd(v.listed_price_e8s!)}` : ''}</span>
                    </div>
                  </div>
                  <Chip tone={delta < 0 ? 'ok' : delta > 0 ? 'danger' : 'pending'} style={{ alignSelf: 'flex-start', height: 17, fontSize: 9.5 }}>
                    {delta < 0 ? `${Math.abs(delta)}% under value` : delta > 0 ? `${delta}% over value` : 'at value'}
                  </Chip>
                  <Btn variant="secondary" sm onClick={() => cancelListing(v)} disabled={busy !== null} style={{ alignSelf: 'flex-start' }}>
                    {busy === `cancel-${v.id}` ? <LiveDot size={7} /> : <Icon name="x" size={11} />} Cancel listing
                  </Btn>
                </div>
              );
            })}
          </div>
        </div>
      )}
      </div>{/* end Your-bonds / Your-listings row */}
      </>)}

      {section === 'exchange' && (<>
      {/* ── Marketplace (best deals first) ── */}
      <div className="card col" style={{ gap: 10 }}>
        <span className="row" style={{ gap: 8, justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <Eyebrow accent>Marketplace</Eyebrow>
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>
            best deals first · {feePct}% fee · buyer becomes the staker
          </span>
        </span>
        {info === null ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }} aria-busy="true" aria-label="Loading listings">
            {[0, 1, 2].map((i) => <Skeleton key={i} width="100%" height={110} radius={10} />)}
          </div>
        ) : listings.length === 0 ? (
          <span style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>
            Nothing listed right now. Bonds you list appear here for anyone to buy.
          </span>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
            {listings.map((v) => {
              const delta = listingDeltaPct(v.listed_price_e8s ?? 0n, v.amount_e8s);
              const isMine = signedIn && principal && v.owner.toString() === principal.toString();
              return (
                <div key={String(v.id)} className="col" style={{ gap: 8, padding: 12, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)' }}>
                  <span className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
                    <b style={{ fontSize: 13.5 }}>{TIER_META[v.tier].short} bond</b>
                    <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>#{String(v.id)}</span>
                  </span>
                  <div className="col" style={{ gap: 3, fontSize: 12 }}>
                    <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                      <span style={{ color: 'var(--fg-3)' }}>Value</span>
                      <span className="mono">{fmtICP(v.amount_e8s)} ICP</span>
                    </div>
                    <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                      <span style={{ color: 'var(--fg-3)' }}>Asking</span>
                      <span className="mono" style={{ fontWeight: 700 }}>{fmtICP(v.listed_price_e8s ?? 0n)} ICP{usd(v.listed_price_e8s ?? 0n) ? ` · ${usd(v.listed_price_e8s ?? 0n)}` : ''}</span>
                    </div>
                  </div>
                  <Chip tone={delta < 0 ? 'ok' : delta > 0 ? 'danger' : 'pending'} style={{ alignSelf: 'flex-start', height: 17, fontSize: 9.5 }}>
                    {delta < 0 ? `${Math.abs(delta)}% under value` : delta > 0 ? `${delta}% over value` : 'at value'}
                  </Chip>
                  <span style={{ fontSize: 11, color: 'var(--fg-2)' }}>
                    Earns {ticketsPerDay(v)} tickets/day.
                  </span>
                  {isMine ? (
                    <Btn variant="secondary" sm onClick={() => cancelListing(v)} disabled={busy !== null} style={{ alignSelf: 'flex-start' }}>
                      {busy === `cancel-${v.id}` ? <LiveDot size={7} /> : null} Cancel listing
                    </Btn>
                  ) : signedIn ? (
                    <Btn variant="primary" sm onClick={() => { setOpPhase(null); setBuyModal(v.id); }} disabled={busy !== null} style={{ alignSelf: 'flex-start' }}>
                      <Icon name="coins" size={12} stroke="var(--char-950)" /> Buy
                    </Btn>
                  ) : (
                    <Btn variant="secondary" sm onClick={onSignIn} style={{ alignSelf: 'flex-start' }}>
                      <Icon name="key" size={12} /> Sign in to buy
                    </Btn>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      </>)}

      {/* ── Redeem modal: the voucher is the claim — pick how the ICP returns ── */}
      {redeemModal != null && (() => {
        const v = mine.find((x) => x.id === redeemModal);
        if (!v) return null;
        const opt: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 10, padding: 14, background: 'var(--bg-alt)', width: '100%' };
        return (
          <ModalShell title={`Redeem ${fmtICP(v.amount_e8s)} ICP`} locked={busy !== null}
            onClose={() => { setRedeemModal(null); setOpPhase(null); }}>
            {opPhase ? (
              <OpPanel phase={opPhase}
                onDone={() => { const done = opPhase.kind === 'success' ? opPhase.onDone : undefined; setOpPhase(null); done?.(); }}
                onDismissError={() => setOpPhase(null)} />
            ) : (<>
            <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
              Your bond is the claim on this ICP — choose how it comes back to you.
            </span>
            <div className="col" style={opt}>
              <span className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                <b style={{ fontSize: 13.5 }}>Wait for the dissolve</b>
                <Chip tone="ok">100% · {fmtICP(v.amount_e8s)} ICP</Chip>
              </span>
              <span style={{ fontSize: 12, color: 'var(--fg-2)', margin: '4px 0 8px' }}>
                The full amount pays your wallet automatically after the {TIER_META[v.tier].label} dissolve. Nothing to claim.
              </span>
              <Btn variant="primary" sm onClick={() => redeem(v)} disabled={busy !== null} style={{ alignSelf: 'flex-start' }}>
                <Icon name="clock" size={12} stroke="var(--char-950)" /> Start the dissolve
              </Btn>
            </div>
            <div className="col" style={opt}>
              <span className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                <b style={{ fontSize: 13.5 }}>Sell it instead</b>
              </span>
              <span style={{ fontSize: 12, color: 'var(--fg-2)', margin: '4px 0 8px' }}>
                Cash out without the wait — sell instantly to the house or list it on the Exchange.
              </span>
              <Btn variant="secondary" sm onClick={() => { setRedeemModal(null); setSellModal(v.id); setSellStep('choose'); setPriceText(''); setOpPhase(null); }} disabled={busy !== null} style={{ alignSelf: 'flex-start' }}>
                <Icon name="coins" size={12} /> Sell options
              </Btn>
            </div>
            </>)}
          </ModalShell>
        );
      })()}

      {/* ── Sell modal ── */}
      {sellModal != null && (() => {
        const v = mine.find((x) => x.id === sellModal);
        if (!v) return null;
        const price = parsePriceIcp(priceText);
        const delta = price != null ? listingDeltaPct(price, v.amount_e8s) : null;
        return (
          <ModalShell title={`Sell your ${TIER_META[v.tier].short} bond`} locked={busy !== null}
            onClose={() => { setSellModal(null); setSellStep('choose'); setPriceText(''); setOpPhase(null); }}>
            {opPhase ? (
              <OpPanel phase={opPhase}
                onDone={() => { const done = opPhase.kind === 'success' ? opPhase.onDone : undefined; setOpPhase(null); done?.(); }}
                onDismissError={() => setOpPhase(null)} />
            ) : (<>
            <div className="col" style={{ gap: 3, fontSize: 12.5, border: '1px solid var(--border)', borderRadius: 10, padding: 12, background: 'var(--bg-alt)' }}>
              <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                <span style={{ color: 'var(--fg-3)' }}>Value (staked principal)</span>
                <span className="mono">{fmtICP(v.amount_e8s)} ICP{usd(v.amount_e8s) ? ` · ${usd(v.amount_e8s)}` : ''}</span>
              </div>
            </div>
            {sellStep === 'choose' ? (() => {
              const quote = buybackQuoteE8s(v.amount_e8s, discountBps);
              const canBuyback = buybackAvailable(v.amount_e8s, discountBps, info?.buyback_fund_e8s ?? 0n);
              const opt: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 10, padding: 14, background: 'var(--bg-alt)', width: '100%' };
              return (
                <>
                  <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>Two ways to sell:</span>
                  <div className="col" style={{ ...opt, opacity: canBuyback ? 1 : 0.6 }}>
                    <span className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                      <b style={{ fontSize: 13.5 }}>Sell instantly to the house</b>
                      <Chip tone="burn">{payPct}% · {fmtICP(quote)} ICP now</Chip>
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--fg-2)', margin: '4px 0 8px' }}>
                      {canBuyback
                        ? 'Paid to your wallet on the spot — no waiting for a buyer.'
                        : 'Currently unavailable — the buyback fund can\'t cover this sale right now. Listing on the Exchange still works.'}
                    </span>
                    <Btn variant="primary" sm onClick={() => buyback(v)} disabled={busy !== null || !canBuyback} style={{ alignSelf: 'flex-start' }}>
                      {busy === `buyback-${v.id}` ? <LiveDot size={7} /> : <Icon name="zap" size={12} stroke="var(--char-950)" />} Take {fmtICP(quote)} ICP now
                    </Btn>
                  </div>
                  <div className="col" style={opt}>
                    <span className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                      <b style={{ fontSize: 13.5 }}>List on the Bond Exchange</b>
                      <Chip tone="pending">you set the ask</Chip>
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--fg-2)', margin: '4px 0 8px' }}>
                      Name your price and let a buyer take over the position — you may beat the instant offer.
                    </span>
                    <Btn variant="secondary" sm onClick={() => setSellStep('list')} disabled={busy !== null} style={{ alignSelf: 'flex-start' }}>
                      <Icon name="coins" size={12} /> Set an asking price
                    </Btn>
                  </div>
                </>
              );
            })() : (
              <>
                <label style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>Your asking price (ICP)</label>
                <input className="burn-input" placeholder="e.g. 1.95" value={priceText} inputMode="decimal" autoFocus
                  onChange={(e) => setPriceText(e.target.value)} aria-label="Ask price in ICP" style={{ width: '100%' }} />
                {delta != null && (
                  <Chip tone={delta < 0 ? 'ok' : delta > 0 ? 'danger' : 'pending'} style={{ alignSelf: 'flex-start' }}>
                    {delta < 0 ? `${Math.abs(delta)}% under value — a deal for buyers` : delta > 0 ? `${delta}% over value` : 'at value'}
                  </Chip>
                )}
                <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
                  A {feePct}% marketplace fee is taken from the sale.{' '}
                  <b>While listed, this bond stops earning lottery tickets</b> — they resume the moment you cancel or it sells.
                </span>
                <span className="row" style={{ gap: 8 }}>
                  <Btn variant="primary" onClick={() => list(v)} disabled={busy !== null || price == null}>
                    <Icon name="check" size={13} stroke="var(--char-950)" /> List for sale
                  </Btn>
                  <Btn variant="ghost" sm onClick={() => setSellStep('choose')}>← Back</Btn>
                </span>
              </>
            )}
            </>)}
          </ModalShell>
        );
      })()}

      {/* ── Buy confirm modal ── */}
      {buyModal != null && (() => {
        const v = listings.find((x) => x.id === buyModal);
        if (!v || v.listed_price_e8s == null) return null;
        const delta = listingDeltaPct(v.listed_price_e8s, v.amount_e8s);
        return (
          <ModalShell title="Confirm purchase" locked={busy !== null}
            onClose={() => { setBuyModal(null); setOpPhase(null); }}>
            {opPhase ? (
              <OpPanel phase={opPhase}
                onDone={() => { const done = opPhase.kind === 'success' ? opPhase.onDone : undefined; setOpPhase(null); done?.(); }}
                onDismissError={() => setOpPhase(null)} />
            ) : (<>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
              <div className="col" style={{ gap: 2, flex: '1 1 130px', border: '1px solid var(--border)', borderRadius: 10, padding: 12, background: 'var(--bg-alt)' }}>
                <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>Value</span>
                <b className="mono" style={{ fontSize: 15 }}>{fmtICP(v.amount_e8s)} ICP</b>
                {usd(v.amount_e8s) && <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>{usd(v.amount_e8s)}</span>}
              </div>
              <div className="col" style={{ gap: 2, flex: '1 1 130px', border: '1px solid var(--burn)', borderRadius: 10, padding: 12, background: 'color-mix(in srgb, var(--burn) 8%, var(--surface))' }}>
                <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>Asking</span>
                <b className="mono" style={{ fontSize: 15 }}>{fmtICP(v.listed_price_e8s)} ICP</b>
                {usd(v.listed_price_e8s) && <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>{usd(v.listed_price_e8s)}</span>}
              </div>
            </div>
            <Chip tone={delta < 0 ? 'ok' : delta > 0 ? 'danger' : 'pending'} style={{ alignSelf: 'flex-start' }}>
              {delta < 0 ? `${Math.abs(delta)}% under value` : delta > 0 ? `${delta}% over value` : 'at value'}
            </Chip>
            <span style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
              You become the staker of a <b>{fmtICP(v.amount_e8s)} ICP {TIER_META[v.tier].label}</b> position — earning{' '}
              <b>{ticketsPerDay(v)} tickets/day</b> — today's tickets land the moment the purchase settles, entering the upcoming draw. Redeemable for full value after the dissolve.
            </span>
            <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
              Your {fmtICP(v.listed_price_e8s)} ICP goes to a sale escrow, then the purchase settles and the bond moves to you. An unfinished purchase is always reclaimable.
            </span>
            <Btn variant="primary" onClick={() => buy(v)} disabled={busy !== null} style={{ alignSelf: 'flex-start' }}>
              <Icon name="coins" size={13} stroke="var(--char-950)" /> Buy for {fmtICP(v.listed_price_e8s)} ICP
            </Btn>
            </>)}
          </ModalShell>
        );
      })()}
    </div>
  );
}

/** Lifecycle of an in-modal money operation. */
type OpPhase =
  | { kind: 'processing'; text: string }
  | { kind: 'success'; title: string; detail: string; onDone?: () => void }
  | { kind: 'error'; message: string };

/** The three op panels a modal swaps to while a money op runs/finishes —
 *  the user always sees WHAT is happening and that their funds are safe. */
function OpPanel({ phase, onDone, onDismissError }: {
  phase: OpPhase;
  onDone: () => void;
  onDismissError: () => void;
}) {
  if (phase.kind === 'processing') {
    return (
      <div className="col" style={{ alignItems: 'center', gap: 12, padding: '30px 8px' }} aria-busy="true" role="status">
        <LiveDot size={12} color="var(--burn-ink)" />
        <b style={{ fontSize: 14.5, textAlign: 'center' }}>{phase.text}</b>
        <span style={{ fontSize: 12, color: 'var(--fg-3)', textAlign: 'center', lineHeight: 1.5 }}>
          Your funds are safe — this takes a few seconds. Don't close the tab.
        </span>
      </div>
    );
  }
  if (phase.kind === 'success') {
    return (
      <div className="col" style={{ alignItems: 'center', gap: 10, padding: '26px 8px' }} role="status">
        <Icon name="checkCircle" size={34} stroke="var(--sprout-ink)" />
        <b style={{ fontSize: 15, textAlign: 'center' }}>{phase.title}</b>
        <span style={{ fontSize: 12.5, color: 'var(--fg-2)', textAlign: 'center', lineHeight: 1.55, maxWidth: 340 }}>
          {phase.detail}
        </span>
        <Btn variant="primary" onClick={onDone} style={{ marginTop: 4 }}>Done</Btn>
      </div>
    );
  }
  return (
    <div className="col" style={{ alignItems: 'center', gap: 10, padding: '26px 8px' }} role="alert">
      <Icon name="x" size={30} stroke="var(--ember)" />
      <b style={{ fontSize: 14.5, textAlign: 'center' }}>That didn't go through</b>
      <span style={{ fontSize: 12.5, color: 'var(--ember)', textAlign: 'center', lineHeight: 1.55, maxWidth: 340 }}>
        {phase.message}
      </span>
      <span style={{ fontSize: 11.5, color: 'var(--fg-3)', textAlign: 'center', maxWidth: 340 }}>
        Nothing is lost when an operation fails — any payment already in escrow stays reclaimable.
      </span>
      <Btn variant="secondary" onClick={onDismissError} style={{ marginTop: 4 }}>Close</Btn>
    </div>
  );
}

/** Shared modal frame — overlay + centered card, closes on backdrop click.
 *  `locked` (a money op in flight) disables BOTH the backdrop and the ✕ so a
 *  stray click can't dismiss the modal mid-operation. */
function ModalShell({ title, onClose, locked, children }: { title: string; onClose: () => void; locked?: boolean; children: React.ReactNode }) {
  return (
    <div onClick={locked ? undefined : onClose} style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 16 }}>
      <div className="col" onClick={(e) => e.stopPropagation()} style={{
        gap: 12, maxWidth: 460, width: '100%', maxHeight: '90vh', overflowY: 'auto',
        background: 'var(--surface)', border: '1px solid var(--border-hi)', borderRadius: 14, padding: 20,
      }}>
        <span className="row" style={{ justifyContent: 'space-between' }}>
          <b style={{ fontSize: 15 }}>{title}</b>
          {!locked && (
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg-2)' }} aria-label="Close">
              <Icon name="x" size={14} />
            </button>
          )}
        </span>
        {children}
      </div>
    </div>
  );
}
