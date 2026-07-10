import { useEffect, useState } from 'react';
import { Principal } from '@icp-sdk/core/principal';
import { StakeTier } from './bindings/backend';
import type { UserStakeInfo } from './bindings/backend';
import { createActor as createLedgerActor } from './bindings/ledger';
import { Btn, Chip, Eyebrow, Icon, LiveDot, MoreInfo, fmtICP } from './ui';
import { TIER_META } from './Staking';

// ==========================================
// Stake Vouchers — a staked position, wrapped as a transferable NFT.
//
// okf/ideas/stake-vouchers: wrap any stake position into a voucher (an
// ICRC-7 NFT minted by the backend); tickets follow whoever holds it. Three
// exits, best to worst: sell it on the ICP marketplace (market sets the
// price), instant house buyback at 85% of principal (balance-gated by the
// buyback fund), or unwrap back to a plain stake and classic-unstake for
// 100% after the tier's dissolve. Promo ("Golden Ticket") vouchers are a
// separate tickets-only class: 1 ticket/day for 60 days, never redeemable,
// never buyback-eligible, soulbound.
// ==========================================

/** Friendly copy for voucher endpoint error codes. */
export function friendlyVoucherErr(code: string): string {
  switch (code) {
    case 'FEATURE_DISABLED': return 'Stake Vouchers aren\'t open yet — check back soon.';
    case 'BUYBACK_UNAVAILABLE': return 'Instant exit is temporarily unavailable — the buyback fund is replenishing. Sell on the marketplace or unwrap instead.';
    case 'CAMPAIGN_CLOSED': return 'The Golden Ticket campaign isn\'t open right now.';
    case 'CAMPAIGN_EXHAUSTED': return 'All Golden Tickets have been claimed — the campaign is over.';
    case 'DAILY_LIMIT': return 'Today\'s Golden Tickets are gone — more unlock tomorrow. Come back then!';
    case 'ALREADY_CLAIMED': return 'This account already claimed its Golden Ticket (one per account).';
    case 'INVALID_PRINCIPAL': return 'That doesn\'t look like a wallet principal — paste the principal shown in your wallet (not an account id, not a canister).';
    case 'NOT_YOUR_VOUCHER': return 'Only the voucher\'s current owner can do that.';
    case 'VOUCHER_LISTED': return 'That voucher is listed for sale — cancel the listing first.';
    case 'PROMO_NOT_ALLOWED': return 'Golden Tickets earn tickets only — they can\'t be sold, redeemed, or bought back.';
    case 'INSUFFICIENT_STAKE': return 'You don\'t have that much unwrapped stake in that tier.';
    case 'BELOW_MINIMUM': return 'The minimum voucher is 1 ICP of staked principal.';
    case 'ESCROW_NOT_FUNDED': return 'The sale escrow hasn\'t received the full ask yet — send the exact ICP amount, then buy.';
    case 'NOT_LISTED': return 'That voucher isn\'t for sale.';
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

type VoucherClass = { Backed: null } | { Promo: null };
export function isPromo(c: VoucherClass): boolean { return 'Promo' in c; }

interface VoucherView {
  id: bigint;
  class: VoucherClass;
  tier: StakeTier;
  amount_e8s: bigint;
  owner: Principal;
  minted_at: bigint;
  expires_at: bigint | null;
  listed_price_e8s: bigint | null;
}

interface VoucherMarketInfo {
  enabled: boolean;
  min_wrap_e8s: bigint;
  market_fee_bps: number;
  buyback_discount_bps: number;
  buyback_fund_e8s: bigint;
  my_vouchers: VoucherView[];
  listings: VoucherView[];
  promo_open: boolean;
  promo_remaining: number;
  promo_claims_today: number;
}

interface VouchersProps {
  actor: any;
  identity: any;
  principal: Principal | null;
  host: string;
  rootKey?: Uint8Array;
  ledgerCanisterId: string;
  onSignIn: () => void;
  onGoNeuronStake: () => void;
}

const TIER_ORDER: StakeTier[] = [StakeTier.SixMonths, StakeTier.OneYear, StakeTier.TwoYears];

export default function Vouchers({
  actor, identity, principal, host, rootKey, ledgerCanisterId, onSignIn, onGoNeuronStake,
}: VouchersProps) {
  const signedIn = !!principal && !principal.isAnonymous();
  const [info, setInfo] = useState<VoucherMarketInfo | null>(null);
  const [myStake, setMyStake] = useState<UserStakeInfo | null>(null);
  const [icpUsdE8s, setIcpUsdE8s] = useState<bigint>(0n);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Wrap form.
  const [wrapTier, setWrapTier] = useState<StakeTier>(StakeTier.SixMonths);
  const [wrapAmount, setWrapAmount] = useState('');
  // List form: which voucher id has its price input open.
  const [listId, setListId] = useState<bigint | null>(null);
  const [priceText, setPriceText] = useState('');
  // Buyback confirm step (danger-style two-tap).
  const [buybackConfirm, setBuybackConfirm] = useState<bigint | null>(null);

  const refresh = async () => {
    if (!actor) return;
    try {
      const [i, stake, rates] = await Promise.all([
        actor.get_voucher_market(),
        signedIn ? actor.get_my_stake().catch(() => null) : Promise.resolve(null),
        actor.get_usd_rates().catch(() => [] as { token: string; rate_usd_e8s: bigint }[]),
      ]);
      setInfo(i);
      setMyStake(stake);
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

  const wrap = () => run('wrap', async () => {
    const amount = parseWrapIcp(wrapAmount);
    if (!amount) throw new Error('Enter a whole-ICP amount (minimum 1 ICP).');
    if (amount < (info?.min_wrap_e8s ?? 100_000_000n)) throw new Error(friendlyVoucherErr('BELOW_MINIMUM'));
    const res = await actor.wrap_stake_voucher(amount, wrapTier);
    if (res.__kind__ === 'Err') throw new Error(friendlyVoucherErr(res.Err));
    setWrapAmount('');
    return `Voucher #${res.Ok} minted — ${fmtICP(amount)} ICP of your ${TIER_META[wrapTier].label} stake is now a transferable NFT. Tickets keep flowing to whoever holds it.`;
  });

  const unwrap = (v: VoucherView) => run(`unwrap-${v.id}`, async () => {
    const res = await actor.unwrap_stake_voucher(v.id);
    if (res.__kind__ === 'Err') throw new Error(friendlyVoucherErr(res.Err));
    return `Voucher #${v.id} unwrapped — it's a plain ${TIER_META[v.tier].label} stake again (classic unstake available on the Neuron Stake page).`;
  });

  const list = (v: VoucherView) => run(`list-${v.id}`, async () => {
    const price = parsePriceIcp(priceText);
    if (!price) throw new Error('Enter an ask in ICP (up to 4 decimals).');
    const res = await actor.list_voucher(v.id, price);
    if (res.__kind__ === 'Err') throw new Error(friendlyVoucherErr(res.Err));
    setListId(null); setPriceText('');
    return `Voucher #${v.id} listed at ${fmtICP(price)} ICP.`;
  });

  const cancelListing = (v: VoucherView) => run(`cancel-${v.id}`, async () => {
    const res = await actor.cancel_voucher_listing(v.id);
    if (res.__kind__ === 'Err') throw new Error(friendlyVoucherErr(res.Err));
    return `Listing for voucher #${v.id} cancelled.`;
  });

  const buyback = (v: VoucherView) => run(`buyback-${v.id}`, async () => {
    const res = await actor.buyback_voucher(v.id);
    if (res.__kind__ === 'Err') throw new Error(friendlyVoucherErr(res.Err));
    setBuybackConfirm(null);
    return `Instant exit complete — ${fmtICP(res.Ok)} ICP paid to your wallet. The voucher is burned.`;
  });

  const buy = (v: VoucherView) => run(`buy-${v.id}`, async () => {
    if (v.listed_price_e8s == null) throw new Error(friendlyVoucherErr('NOT_LISTED'));
    // 1. Fund the sale escrow with EXACTLY the ask, 2. settle the purchase.
    const escrow = await actor.get_voucher_sale_account(v.id);
    const ledger = createLedgerActor(ledgerCanisterId, { agentOptions: { host, identity, rootKey } });
    const xfer = await ledger.icrc1_transfer({
      to: { owner: escrow.owner, subaccount: escrow.subaccount },
      amount: v.listed_price_e8s,
    });
    if (xfer.__kind__ === 'Err') {
      throw new Error(`Payment transfer failed: ${JSON.stringify(xfer.Err, (_k, val) => typeof val === 'bigint' ? val.toString() : val)}`);
    }
    const res = await actor.buy_voucher(v.id);
    if (res.__kind__ === 'Err') throw new Error(friendlyVoucherErr(res.Err));
    return `Voucher #${v.id} is yours — ${fmtICP(v.amount_e8s)} ICP of staked principal, earning tickets from the next daily grant.`;
  });

  const usdHint = (e8s: bigint): string => icpUsdE8s > 0n
    ? ` · $${((Number(e8s) / 1e8) * (Number(icpUsdE8s) / 1e8)).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
    : '';

  const discountBps = info?.buyback_discount_bps ?? 1500;
  const payPct = ((10_000 - discountBps) / 100).toFixed(0);
  const feePct = ((info?.market_fee_bps ?? 250) / 100).toFixed(1);

  const tierStaked = (t: StakeTier): bigint =>
    myStake?.tiers.find((row) => row.tier === t)?.amount_e8s ?? 0n;

  const voucherCard = (v: VoucherView, mine: boolean) => {
    const promo = isPromo(v.class);
    const quote = buybackQuoteE8s(v.amount_e8s, discountBps);
    const canBuyback = info ? buybackAvailable(v.amount_e8s, discountBps, info.buyback_fund_e8s) : false;
    const listed = v.listed_price_e8s != null;
    return (
      <div key={String(v.id)} className="col" style={{
        gap: 8, padding: 12, borderRadius: 10,
        border: promo ? '1px solid var(--haze)' : '1px solid var(--border)',
        background: promo ? 'color-mix(in srgb, var(--haze) 10%, var(--surface))' : 'var(--surface)',
      }}>
        <span className="row" style={{ gap: 8, justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <span className="row" style={{ gap: 8 }}>
            <Icon name={promo ? 'spark' : 'star'} size={14} stroke={promo ? 'var(--haze-ink)' : 'var(--burn-ink)'} />
            <b style={{ fontSize: 13.5 }}>{promo ? 'Golden Ticket' : `${fmtICP(v.amount_e8s)} ICP · ${TIER_META[v.tier].short}`}</b>
            <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>#{String(v.id)}</span>
          </span>
          {promo ? (
            <Chip tone="pending">
              {v.expires_at != null && promoDaysLeft(v.expires_at, Date.now()) > 0
                ? `${promoDaysLeft(v.expires_at, Date.now())} days left`
                : 'expired'}
            </Chip>
          ) : listed ? (
            <Chip tone="burn">listed · {fmtICP(v.listed_price_e8s!)} ICP</Chip>
          ) : (
            <Chip tone="ok">{Number(TIER_META[v.tier].tickets) * Math.round(Number(v.amount_e8s) / 1e8)} tickets/day</Chip>
          )}
        </span>

        {promo ? (
          <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>
            1 free lottery ticket a day — tickets only. Not redeemable, not sellable;
            stake real ICP to earn 5–20 tickets per ICP per day.
          </span>
        ) : mine && (
          <>
            {listId === v.id ? (
              <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <input className="burn-input" placeholder="Ask (ICP)" value={priceText} inputMode="decimal"
                  onChange={(e) => setPriceText(e.target.value)} aria-label="Ask price in ICP" style={{ width: 120 }} />
                <Btn variant="primary" sm onClick={() => list(v)} disabled={busy !== null}>
                  {busy === `list-${v.id}` ? <LiveDot size={7} /> : <Icon name="check" size={11} stroke="var(--char-950)" />} List
                </Btn>
                <Btn variant="ghost" sm onClick={() => { setListId(null); setPriceText(''); }}>Cancel</Btn>
              </span>
            ) : (
              <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                {listed ? (
                  <Btn variant="secondary" sm onClick={() => cancelListing(v)} disabled={busy !== null}>
                    {busy === `cancel-${v.id}` ? <LiveDot size={7} /> : null} Cancel listing
                  </Btn>
                ) : (
                  <>
                    <Btn variant="secondary" sm onClick={() => { setListId(v.id); setPriceText(''); setBuybackConfirm(null); }} disabled={busy !== null}>
                      <Icon name="coins" size={12} /> Sell…
                    </Btn>
                    {buybackConfirm === v.id ? (
                      <>
                        <Btn variant="danger" sm onClick={() => buyback(v)} disabled={busy !== null || !canBuyback}>
                          {busy === `buyback-${v.id}` ? <LiveDot size={7} /> : null} Confirm: take {fmtICP(quote)} ICP now
                        </Btn>
                        <Btn variant="ghost" sm onClick={() => setBuybackConfirm(null)}>Keep it</Btn>
                      </>
                    ) : (
                      <Btn variant="secondary" sm onClick={() => setBuybackConfirm(v.id)} disabled={busy !== null || !canBuyback}
                        title={canBuyback ? undefined : 'Buyback fund is replenishing'}>
                        <Icon name="zap" size={12} /> Instant exit · {fmtICP(quote)} ICP ({payPct}%)
                      </Btn>
                    )}
                    <Btn variant="ghost" sm onClick={() => unwrap(v)} disabled={busy !== null}>
                      {busy === `unwrap-${v.id}` ? <LiveDot size={7} /> : null} Unwrap
                    </Btn>
                  </>
                )}
              </span>
            )}
            {!canBuyback && !listed && (
              <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                Instant exit temporarily unavailable — the buyback fund is replenishing.
                Sell on the marketplace or unwrap and unstake classically (100% after dissolve).
              </span>
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="idea-board-container">
      {/* ── Header (lottery-page pattern: one row, one modal) ── */}
      <div className="col" style={{ gap: 6 }}>
        <span className="row" style={{ gap: 10, width: '100%', flexWrap: 'wrap' }}>
          <Icon name="star" size={22} stroke="var(--burn-ink)" />
          <h4 style={{ margin: 0 }}>Vouchers</h4>
          <Chip tone="pending"><LiveDot size={6} /> tradeable stakes</Chip>
          <MoreInfo
            title="How Stake Vouchers work"
            style={{
              marginLeft: 'auto', textDecoration: 'none', fontSize: 12.5, fontWeight: 600,
              border: '1px solid var(--burn)', borderRadius: 999, padding: '6px 14px',
              background: 'color-mix(in srgb, var(--burn) 10%, var(--surface))',
            }}
          >
            <div className="card col" style={{ gap: 8, borderColor: 'var(--burn)', background: 'color-mix(in srgb, var(--burn) 12%, var(--surface))' }}>
              <Eyebrow accent>The gist</Eyebrow>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
                <b>Your stake, as an NFT.</b> Wrap a staked position into a voucher and
                it becomes transferable — the daily tickets follow whoever holds it,
                and you gain two extra exits on top of the classic unstake.
              </p>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <Eyebrow accent>Three ways out</Eyebrow>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                <li><b>Sell it:</b> list at any ask in ICP — the buyer pays, you're out at the market's price ({feePct}% marketplace fee).</li>
                <li><b>Instant exit:</b> the house buys it back on the spot for <b>{payPct}% of principal</b> — an optional express-exit fee, available whenever the buyback fund covers it.</li>
                <li><b>Unwrap:</b> turn it back into a plain stake and unstake classically — <b>100% of your principal</b> after the tier's dissolve, exactly as always. Never gated.</li>
              </ul>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <Eyebrow accent>Tickets follow the holder</Eyebrow>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                <li><b>Whoever holds the voucher is the staker</b> — daily tickets land server-side, and a jackpot pays their wallet automatically.</li>
                <li><b>Buying a voucher makes you a staker</b> — no prior stake needed; tickets start at the next daily grant.</li>
                <li><b>Golden Tickets</b> (promo vouchers) earn 1 ticket/day for 60 days — tickets only, never redeemable for ICP.</li>
              </ul>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <Eyebrow accent>The fine print</Eyebrow>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                <li>The instant-exit discount is a fee for skipping the dissolve wait — your principal is never at risk on the classic path.</li>
                <li>Marketplace purchases escrow the exact ask; an unfinished purchase is always reclaimable.</li>
                <li>Fees fund the treasury, the buyback fund, and cycle burns — in equal thirds.</li>
              </ul>
            </div>
          </MoreInfo>
        </span>
      </div>

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

      <div className="row" style={{ gap: 14, alignItems: 'stretch', flexWrap: 'wrap' }}>
        {/* ── Wrap a position ── */}
        <div className="card col" style={{ gap: 10, flex: '1 1 300px', minWidth: 300 }}>
          <Eyebrow accent>Wrap a stake into a voucher</Eyebrow>
          {!signedIn ? (
            <div className="col" style={{ gap: 10, alignItems: 'flex-start' }}>
              <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
                Sign in to wrap a staked position into a transferable NFT.
              </span>
              <Btn variant="primary" sm onClick={onSignIn}>
                <Icon name="key" size={13} stroke="var(--char-950)" /> Sign in
              </Btn>
            </div>
          ) : (
            <>
              <span style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
                A voucher is your stake as an NFT — same tickets, same principal, plus
                the option to sell it or take the instant exit. Minimum {fmtICP(info?.min_wrap_e8s ?? 100_000_000n)} ICP.
              </span>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                {TIER_ORDER.map((t) => (
                  <Btn key={t} variant={wrapTier === t ? 'primary' : 'secondary'} sm onClick={() => setWrapTier(t)}>
                    {TIER_META[t].short}
                  </Btn>
                ))}
              </div>
              <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                unwrapped in {TIER_META[wrapTier].label}: {fmtICP(tierStaked(wrapTier))} ICP
              </span>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <input className="burn-input" placeholder="Amount (whole ICP)" value={wrapAmount} inputMode="numeric"
                  onChange={(e) => setWrapAmount(e.target.value)} aria-label="Amount to wrap (whole ICP)" style={{ width: 160 }} />
                <Btn variant="primary" onClick={wrap} disabled={busy !== null || tierStaked(wrapTier) === 0n}>
                  {busy === 'wrap' ? <LiveDot size={8} /> : <Icon name="star" size={13} stroke="var(--char-950)" />} Wrap
                </Btn>
              </div>
              {tierStaked(wrapTier) === 0n && (
                <span className="row" style={{ gap: 6, fontSize: 12, color: 'var(--fg-3)', flexWrap: 'wrap' }}>
                  Nothing staked in this tier yet.
                  <Btn variant="ghost" sm onClick={onGoNeuronStake}>Stake ICP →</Btn>
                </span>
              )}
            </>
          )}
        </div>

        {/* ── My vouchers ── */}
        <div className="card col" style={{ gap: 10, flex: '1 1 300px', minWidth: 300 }}>
          <Eyebrow>Your vouchers</Eyebrow>
          {!signedIn ? (
            <span style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>Sign in to see your vouchers.</span>
          ) : (info?.my_vouchers?.length ?? 0) === 0 ? (
            <span style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>
              No vouchers yet — wrap a stake, buy one below, or claim a Golden Ticket
              when a campaign is live.
            </span>
          ) : (
            info!.my_vouchers.map((v) => voucherCard(v, true))
          )}
        </div>
      </div>

      {/* ── Marketplace ── */}
      <div className="card col" style={{ gap: 10 }}>
        <span className="row" style={{ gap: 8, justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <Eyebrow accent>Marketplace</Eyebrow>
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>
            asks in ICP · {feePct}% fee · buyer becomes the staker
          </span>
        </span>
        {(info?.listings?.length ?? 0) === 0 ? (
          <span style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>
            Nothing listed right now. Wrapped vouchers you list appear here for anyone to buy.
          </span>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
            {info!.listings.map((v) => {
              const delta = v.listed_price_e8s != null ? listingDeltaPct(v.listed_price_e8s, v.amount_e8s) : 0;
              const mine = signedIn && principal && v.owner.toString() === principal.toString();
              return (
                <div key={String(v.id)} className="col" style={{ gap: 8, padding: 12, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)' }}>
                  <span className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
                    <b style={{ fontSize: 13.5 }}>{fmtICP(v.amount_e8s)} ICP · {TIER_META[v.tier].short}</b>
                    <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>#{String(v.id)}</span>
                  </span>
                  <span className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <b className="mono" style={{ fontSize: 16 }}>{fmtICP(v.listed_price_e8s ?? 0n)} ICP</b>
                    <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>{usdHint(v.listed_price_e8s ?? 0n).replace(' · ', '')}</span>
                    <Chip tone={delta < 0 ? 'ok' : 'muted'} style={{ height: 17, fontSize: 9.5 }}>
                      {delta < 0 ? `${Math.abs(delta)}% under principal` : delta > 0 ? `${delta}% over principal` : 'at principal'}
                    </Chip>
                  </span>
                  <span style={{ fontSize: 11.5, color: 'var(--fg-2)' }}>
                    Earns {Number(TIER_META[v.tier].tickets) * Math.round(Number(v.amount_e8s) / 1e8)} tickets/day ·
                    redeemable for {fmtICP(v.amount_e8s)} ICP after a {TIER_META[v.tier].label} dissolve.
                  </span>
                  {mine ? (
                    <Btn variant="secondary" sm onClick={() => cancelListing(v)} disabled={busy !== null}>
                      {busy === `cancel-${v.id}` ? <LiveDot size={7} /> : null} Cancel listing
                    </Btn>
                  ) : signedIn ? (
                    <Btn variant="primary" sm onClick={() => buy(v)} disabled={busy !== null}>
                      {busy === `buy-${v.id}` ? <LiveDot size={7} /> : <Icon name="coins" size={12} stroke="var(--char-950)" />} Pay &amp; buy
                    </Btn>
                  ) : (
                    <Btn variant="secondary" sm onClick={onSignIn}>
                      <Icon name="key" size={12} /> Sign in to buy
                    </Btn>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <span style={{ fontSize: 11.5, color: 'var(--fg-3)', lineHeight: 1.5 }}>
        The instant-exit discount is an optional express-exit fee — the classic path
        (unwrap, then unstake) always returns 100% of your principal after the tier's
        dissolve. "Pay &amp; buy" escrows the exact ask first; if a purchase is
        interrupted, the escrow is always reclaimable.
      </span>
    </div>
  );
}
