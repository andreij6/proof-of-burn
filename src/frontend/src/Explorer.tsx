import { useEffect, useState } from 'react';
// Deterministic per-(id, seed) hash used to shuffle the directory. Same seed →
// same order (stable across re-renders / filtering / pagination); a fresh seed
// each page load reshuffles. Well-distributed integer mix (xorshift-style).
function shuffleHash(id: bigint, seed: number): number {
  let h = ((Number(id % 2147483647n) >>> 0) ^ seed) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 2246822507) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
import { Principal } from "@icp-sdk/core/principal";
import { ExplorerToken, DappStatus, FeaturedStatus } from "./bindings/backend";
import type { DappListing, ExplorerInfo, ExplorerQuote, FeaturedInfo, FeaturedView } from "./bindings/backend";
import { createActor as createLedgerActor } from "./bindings/ledger";
import { Icon, Eyebrow, Chip, Btn, LiveDot, MoreInfo, formatPrincipal, usePageDevControls } from "./ui";
import { fmtTokenAmount } from "./tokens";
import { usdToTokenUnits } from "./tokens";
import { useErrorImpression } from "./analytics";

// ==========================================
// Dapp Explorer — a paid directory of ICP-ecosystem dapps.
// Admin-curated listings are permanent and unbadged; anyone else pays
// $1 (USD) per day of visibility (1–3650 days) in ICP, ckBTC, ckETH, ckUSDC
// or ckUSDT, priced live via the exchange-rate oracle. Community listings
// are hidden until an admin approves them and carry a "Community" badge.
// ==========================================

const GRID_PAGE_SIZE = 9; // 3 × 3

const TOKEN_ORDER: ExplorerToken[] = [
  ExplorerToken.ICP, ExplorerToken.CkBTC, ExplorerToken.CkETH, ExplorerToken.CkUSDC, ExplorerToken.CkUSDT,
];

const TOKEN_BASE: Record<ExplorerToken, { label: string; decimals: number; fallbackFee: bigint }> = {
  [ExplorerToken.ICP]:    { label: 'ICP',    decimals: 8,  fallbackFee: 10_000n },
  [ExplorerToken.CkBTC]:  { label: 'ckBTC',  decimals: 8,  fallbackFee: 10n },
  [ExplorerToken.CkETH]:  { label: 'ckETH',  decimals: 18, fallbackFee: 2_000_000_000_000n },
  [ExplorerToken.CkUSDC]: { label: 'ckUSDC', decimals: 6,  fallbackFee: 10_000n },
  [ExplorerToken.CkUSDT]: { label: 'ckUSDT', decimals: 6,  fallbackFee: 10_000n },
};

function tokenLedger(token: ExplorerToken, info: ExplorerInfo | null): Principal | null {
  if (!info) return null;
  switch (token) {
    case ExplorerToken.ICP: return info.icp_ledger;
    case ExplorerToken.CkBTC: return info.ckbtc_ledger;
    case ExplorerToken.CkETH: return info.cketh_ledger;
    case ExplorerToken.CkUSDC: return info.ckusdc_ledger;
    case ExplorerToken.CkUSDT: return info.ckusdt_ledger;
  }
}

function tokenFee(token: ExplorerToken, info: ExplorerInfo | null): bigint {
  if (!info) return TOKEN_BASE[token].fallbackFee;
  switch (token) {
    case ExplorerToken.ICP: return info.fee_icp_e8s;
    case ExplorerToken.CkBTC: return info.fee_ckbtc_sats;
    case ExplorerToken.CkETH: return info.fee_cketh_wei;
    case ExplorerToken.CkUSDC: return info.fee_ckusdc_micro;
    case ExplorerToken.CkUSDT: return info.fee_ckusdt_micro;
  }
}

function fmtUSD(usdE8s: bigint): string {
  return `$${(Number(usdE8s) / 100_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

// Favicon for a dapp card via DuckDuckGo's icon service (allowed in CSP img-src).
// Returns null when the URL can't be parsed; the <img> hides itself on error.
function dappFavicon(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    return host ? `https://icons.duckduckgo.com/ip3/${host}.ico` : null;
  } catch {
    return null;
  }
}

// Whole days of visibility remaining (ceil); null = permanent listing.
export function dappDaysLeft(d: DappListing, nowMs: number): number | null {
  if (d.expires_at === undefined || d.expires_at === null) return null;
  const expiresAtMs = Number(d.expires_at / 1_000_000n);
  return Math.max(0, Math.ceil((expiresAtMs - nowMs) / 86_400_000));
}

const MODAL_OVERLAY: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(12, 10, 9, 0.85)',
  backdropFilter: 'blur(8px)', zIndex: 1000, display: 'flex',
  alignItems: 'center', justifyContent: 'center', padding: 16,
};

const MODAL_CARD: React.CSSProperties = {
  maxWidth: 520, width: '100%', gap: 16, background: 'var(--surface)',
  border: '1px solid var(--border-hi)', boxShadow: 'var(--elev-3)',
  maxHeight: '90vh', overflowY: 'auto',
};

const LABEL_STYLE: React.CSSProperties = {
  fontSize: 11, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)',
  textTransform: 'uppercase', letterSpacing: '0.06em',
};

// Max categories a single listing may carry — mirrors the backend's
// MAX_DAPP_CATEGORIES so the picker can't over-select.
const MAX_CATEGORIES = 3;

// Shared pill toggle (token picker, category picker, category filter).
function pillStyle(active: boolean): React.CSSProperties {
  return {
    background: active ? 'color-mix(in srgb, var(--burn) 14%, transparent)' : 'transparent',
    border: `1px solid ${active ? 'var(--burn)' : 'var(--border)'}`,
    color: active ? 'var(--burn-ink)' : 'var(--fg-3)',
    borderRadius: 999, padding: '5px 10px', fontSize: 11.5, fontWeight: 500,
    cursor: 'pointer', transition: 'all var(--dur-fast) var(--ease-out)',
  };
}

interface ExplorerProps {
  actor: any;
  identity: any;
  principal: Principal | null;
  host: string;
  rootKey?: Uint8Array;
  isAdmin: boolean;
  isLocal?: boolean;
  onSignIn: () => void;
}

export default function Explorer({ actor, identity, principal, host, rootKey, isAdmin, isLocal = false, onSignIn }: ExplorerProps) {
  const signedIn = !!(principal && !principal.isAnonymous());

  const [dapps, setDapps] = useState<DappListing[]>([]);
  // Random directory order, fixed once per page load (re-seeds on remount).
  const [shuffleSeed] = useState(() => (Math.random() * 0xffffffff) >>> 0);
  const [myDapps, setMyDapps] = useState<DappListing[]>([]);
  const [pendingDapps, setPendingDapps] = useState<DappListing[]>([]);
  const [info, setInfo] = useState<ExplorerInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [gridPage, setGridPage] = useState(0);
  const [catFilter, setCatFilter] = useState<string | null>(null);

  // Submit-listing modal
  const [isSubmitOpen, setIsSubmitOpen] = useState(false);
  const [subName, setSubName] = useState('');
  const [subUrl, setSubUrl] = useState('');
  const [subDesc, setSubDesc] = useState('');
  const [subToken, setSubToken] = useState<ExplorerToken>(ExplorerToken.ICP);
  const [subDays, setSubDays] = useState('30');
  const [quote, setQuote] = useState<ExplorerQuote | null>(null);
  const [isQuoting, setIsQuoting] = useState(false);
  const [subBalance, setSubBalance] = useState<bigint | null>(null);
  // Per-token balance + USD rate so the picker can disable tokens the user can't
  // afford the listing cost in. Loaded when the submit modal opens.
  const [subBalances, setSubBalances] = useState<Record<string, bigint | null>>({});
  const [subRates, setSubRates] = useState<Record<string, bigint>>({});
  const [subError, setSubError] = useState<string | null>(null);
  const [subStep, setSubStep] = useState('');
  const [subBusy, setSubBusy] = useState(false);
  const [subSuccess, setSubSuccess] = useState(false);
  const [subCategories, setSubCategories] = useState<string[]>([]);
  const [subVibe, setSubVibe] = useState(false);

  // Admin add-listing modal
  const [isAdminFormOpen, setIsAdminFormOpen] = useState(false);
  const [admName, setAdmName] = useState('');
  const [admUrl, setAdmUrl] = useState('');
  const [admDesc, setAdmDesc] = useState('');
  const [admError, setAdmError] = useState<string | null>(null);
  const [admBusy, setAdmBusy] = useState(false);
  const [admCategories, setAdmCategories] = useState<string[]>([]);

  useErrorImpression(subError, 'explorer_submit');
  useErrorImpression(admError, 'explorer_admin');

  // Admin per-listing action in flight (approve/reject/remove)
  const [actionBusyId, setActionBusyId] = useState<bigint | null>(null);

  // ── Featured hero ──
  const [featured, setFeatured] = useState<FeaturedInfo | null>(null);
  const [pendingFeatured, setPendingFeatured] = useState<FeaturedView[]>([]);
  const [myFeatured, setMyFeatured] = useState<FeaturedView[]>([]);
  const [heroSlide, setHeroSlide] = useState(0);       // 0 = featured dapp, 1 = advertise
  const [heroPick, setHeroPick] = useState(0);         // which active placement to show (random per load)
  const [featBusyId, setFeatBusyId] = useState<bigint | null>(null);

  // Apply-to-feature modal
  const [isFeatOpen, setIsFeatOpen] = useState(false);
  const [featListingId, setFeatListingId] = useState<bigint | null>(null);
  const [featToken, setFeatToken] = useState<ExplorerToken>(ExplorerToken.ICP);
  const [featDays, setFeatDays] = useState('30');
  const [featQuote, setFeatQuote] = useState<ExplorerQuote | null>(null);
  const [featQuoting, setFeatQuoting] = useState(false);
  const [featBalance, setFeatBalance] = useState<bigint | null>(null);
  const [featError, setFeatError] = useState<string | null>(null);
  const [featStep, setFeatStep] = useState('');
  const [featBusy, setFeatBusy] = useState(false);
  const [featSuccess, setFeatSuccess] = useState(false);
  useErrorImpression(featError, 'explorer_feature');

  const refreshAll = async (currentActor = actor) => {
    if (!currentActor) return;
    try {
      const [dappList, explorerInfo, mine, pending, feat, featPending, featMine] = await Promise.all([
        currentActor.list_dapps(),
        currentActor.get_explorer_info(),
        signedIn ? currentActor.list_my_dapp_submissions() : Promise.resolve([]),
        isAdmin ? currentActor.list_pending_dapps() : Promise.resolve([]),
        currentActor.get_featured_dapps(),
        isAdmin ? currentActor.list_pending_featured() : Promise.resolve([]),
        signedIn ? currentActor.get_my_featured() : Promise.resolve([]),
      ]);
      setDapps(dappList);
      setInfo(explorerInfo);
      setMyDapps(mine);
      setPendingDapps(pending);
      setFeatured(feat);
      setPendingFeatured(featPending);
      setMyFeatured(featMine);
    } catch (err) {
      console.error("Failed to fetch Explorer:", err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    setIsLoading(true);
    refreshAll(actor);
  }, [actor, signedIn, isAdmin]);

  const daysNum = (() => {
    const n = Number(subDays);
    return Number.isInteger(n) ? n : NaN;
  })();
  const daysValid = info
    ? daysNum >= Number(info.min_days) && daysNum <= Number(info.max_days)
    : daysNum >= 1 && daysNum <= 3650;

  // Required listing cost (incl. ledger fee) in a token at the chosen days, or
  // null if unknown/invalid. True affordability unless we KNOW balance < cost.
  const subRequired = (t: ExplorerToken): bigint | null => {
    if (!info || !daysValid) return null;
    const rate = subRates[t as unknown as string];
    if (!rate || rate <= 0n) return null;
    const usd = (Number(info.price_per_day_usd_e8s) / 1e8) * daysNum;
    const amt = usdToTokenUnits(usd, rate, TOKEN_BASE[t].decimals);
    if (amt === null) return null;
    return amt + tokenFee(t, info);
  };
  const subAffordable = (t: ExplorerToken): boolean => {
    const bal = subBalances[t as unknown as string];
    const req = subRequired(t);
    if (bal === undefined || bal === null || req === null) return true; // still loading
    return bal >= req;
  };
  // If the selected token can't cover the cost, hop to the first one that can.
  useEffect(() => {
    if (!isSubmitOpen || subAffordable(subToken)) return;
    const alt = TOKEN_ORDER.find(t => subAffordable(t));
    if (alt && alt !== subToken) setSubToken(alt);
  }, [subBalances, subRates, subDays, isSubmitOpen, subToken]);

  // Live price quote — refetched (debounced) whenever token/days change while
  // the modal is open. The backend locks the quoted price for 15 minutes.
  useEffect(() => {
    if (!isSubmitOpen || !signedIn || !actor || !daysValid) { setQuote(null); return; }
    let cancelled = false;
    setIsQuoting(true);
    setQuote(null);
    const t = setTimeout(() => {
      actor.get_explorer_quote(subToken, BigInt(daysNum))
        .then((res: any) => {
          if (cancelled) return;
          if (res.__kind__ === "Ok") { setQuote(res.Ok); setSubError(null); }
          else setSubError(`Quote failed: ${res.Err}`);
        })
        .catch((err: any) => { if (!cancelled) setSubError(err.message || String(err)); })
        .finally(() => { if (!cancelled) setIsQuoting(false); });
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [isSubmitOpen, subToken, subDays, signedIn, actor]);

  // Wallet balance for the selected token while the modal is open.
  useEffect(() => {
    if (!isSubmitOpen || !signedIn || !identity || !info) { setSubBalance(null); return; }
    const ledger = tokenLedger(subToken, info);
    if (!ledger) { setSubBalance(null); return; }
    let cancelled = false;
    setSubBalance(null);
    const ledgerActor = createLedgerActor(ledger.toString(), {
      agentOptions: { host, identity, rootKey }
    });
    ledgerActor.icrc1_balance_of({ owner: principal! })
      .then((bal: bigint) => { if (!cancelled) setSubBalance(bal); })
      .catch(() => { if (!cancelled) setSubBalance(0n); });
    return () => { cancelled = true; };
  }, [isSubmitOpen, subToken, identity, info]);

  // On submit-modal open: load USD rates + each token's balance so the picker can
  // disable tokens the user can't cover the listing cost in.
  useEffect(() => {
    if (!isSubmitOpen || !signedIn || !info || !principal) return;
    let cancelled = false;
    (async () => {
      try {
        const rates = await actor.get_usd_rates();
        if (!cancelled) {
          const m: Record<string, bigint> = {};
          for (const r of rates) m[r.token as unknown as string] = r.rate_usd_e8s;
          setSubRates(m);
        }
      } catch { /* rates best-effort */ }
      await Promise.all(TOKEN_ORDER.map(async (t) => {
        const ledger = tokenLedger(t, info);
        if (!ledger) { if (!cancelled) setSubBalances(p => ({ ...p, [t]: 0n })); return; }
        try {
          const bal = await createLedgerActor(ledger.toString(), { agentOptions: { host, identity, rootKey } })
            .icrc1_balance_of({ owner: principal });
          if (!cancelled) setSubBalances(p => ({ ...p, [t]: bal }));
        } catch { if (!cancelled) setSubBalances(p => ({ ...p, [t]: 0n })); }
      }));
    })();
    return () => { cancelled = true; };
  }, [isSubmitOpen, signedIn, info, identity]);

  // Pick which active placement the hero shows — random, once per load (and
  // whenever the active set size changes). Mirrors the backend's "random per
  // page load" contract on the client (raw_rand is update-only).
  const activeFeatured = featured?.active ?? [];
  useEffect(() => {
    if (activeFeatured.length === 0) { setHeroPick(0); setHeroSlide(activeFeatured.length === 0 ? 1 : 0); return; }
    setHeroPick(Math.floor(Math.random() * activeFeatured.length));
    setHeroSlide(0);
  }, [activeFeatured.length]);

  // Gentle auto-advance between the two hero slides (featured ↔ advertise) so
  // both states get airtime. Only when there's an active placement to show.
  useEffect(() => {
    if (activeFeatured.length === 0) return;
    const t = setInterval(() => setHeroSlide(s => (s === 0 ? 1 : 0)), 7000);
    return () => clearInterval(t);
  }, [activeFeatured.length, heroPick]);

  // My Approved listings that aren't already featured (pending/active) — the
  // candidates the apply modal lets you promote.
  const featuredListingIds = new Set([...activeFeatured, ...myFeatured].map(v => v.featured.listing_id.toString()));
  const myApprovedListings = myDapps.filter(d => d.status === DappStatus.Approved && !featuredListingIds.has(d.id.toString()));

  const featDaysNum = (() => { const n = Number(featDays); return Number.isInteger(n) ? n : NaN; })();
  const featMinDays = featured ? Number(featured.min_days) : 7;
  const featMaxDays = featured ? Number(featured.max_days) : 90;
  const featDaysValid = featDaysNum >= featMinDays && featDaysNum <= featMaxDays;
  const featMeta = TOKEN_BASE[featToken];
  const featPricePerDay = featured ? fmtUSD(featured.price_per_day_usd_e8s) : '$10';

  // Live featured quote (debounced) while the modal is open.
  useEffect(() => {
    if (!isFeatOpen || !signedIn || !actor || !featDaysValid) { setFeatQuote(null); return; }
    let cancelled = false;
    setFeatQuoting(true);
    setFeatQuote(null);
    const t = setTimeout(() => {
      actor.get_featured_quote(featToken, BigInt(featDaysNum))
        .then((res: any) => {
          if (cancelled) return;
          if (res.__kind__ === "Ok") { setFeatQuote(res.Ok); setFeatError(null); }
          else setFeatError(`Quote failed: ${res.Err}`);
        })
        .catch((err: any) => { if (!cancelled) setFeatError(err.message || String(err)); })
        .finally(() => { if (!cancelled) setFeatQuoting(false); });
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [isFeatOpen, featToken, featDays, signedIn, actor]);

  // Wallet balance for the selected token while the featured modal is open.
  useEffect(() => {
    if (!isFeatOpen || !signedIn || !identity || !info) { setFeatBalance(null); return; }
    const ledger = tokenLedger(featToken, info);
    if (!ledger) { setFeatBalance(null); return; }
    let cancelled = false;
    setFeatBalance(null);
    const ledgerActor = createLedgerActor(ledger.toString(), { agentOptions: { host, identity, rootKey } });
    ledgerActor.icrc1_balance_of({ owner: principal! })
      .then((bal: bigint) => { if (!cancelled) setFeatBalance(bal); })
      .catch(() => { if (!cancelled) setFeatBalance(0n); });
    return () => { cancelled = true; };
  }, [isFeatOpen, featToken, identity, info]);

  const openFeature = () => {
    if (!signedIn) { onSignIn(); return; }
    setFeatListingId(myApprovedListings.length > 0 ? myApprovedListings[0].id : null);
    setFeatToken(ExplorerToken.ICP); setFeatDays('30');
    setFeatQuote(null); setFeatError(null); setFeatStep(''); setFeatSuccess(false);
    setIsFeatOpen(true);
  };

  const executeFeature = async () => {
    if (!actor || !identity || !info || featBusy) return;
    if (featListingId === null) { setFeatError("Pick one of your approved listings to feature."); return; }
    if (!featDaysValid) { setFeatError(`Days must be between ${featMinDays} and ${featMaxDays}.`); return; }
    if (!featQuote) { setFeatError("Waiting for a price quote — try again in a second."); return; }
    const ledger = tokenLedger(featToken, info);
    if (!ledger) { setFeatError("Token ledger unavailable."); return; }
    const fee = tokenFee(featToken, info);
    const deposit = featQuote.amount + fee;
    if (featBalance !== null && deposit + fee > featBalance) {
      setFeatError(`Insufficient ${featMeta.label} balance — need ${fmtTokenAmount(deposit + fee, featMeta.decimals)} ${featMeta.label} (price + fees).`);
      return;
    }
    setFeatBusy(true);
    setFeatError(null);
    try {
      setFeatStep("Step 1/2: Paying the featured premium into escrow...");
      const acct = await actor.get_featured_deposit_address();
      const ledgerActor = createLedgerActor(ledger.toString(), { agentOptions: { host, identity, rootKey } });
      const transferResult = await ledgerActor.icrc1_transfer({
        to: { owner: acct.owner, subaccount: acct.subaccount ? acct.subaccount : undefined },
        amount: deposit,
      });
      if (transferResult.__kind__ === "Err") {
        const err = transferResult.Err as any;
        const detail = err.__kind__ === "InsufficientFunds"
          ? `balance is ${fmtTokenAmount(err.InsufficientFunds.balance, featMeta.decimals)} ${featMeta.label}`
          : JSON.stringify(err, (_k, v) => typeof v === "bigint" ? v.toString() : v);
        throw new Error(`Payment failed: ${detail}`);
      }
      setFeatStep("Step 2/2: Submitting your featured application...");
      const res = await actor.apply_featured(featListingId, featToken, BigInt(featDaysNum));
      if (res.__kind__ === "Err") throw new Error(res.Err);
      setFeatSuccess(true);
      setFeatStep("Submitted! An admin reviews featured applications before they go live. If rejected, you're refunded (minus one ledger fee).");
      await refreshAll();
    } catch (err: any) {
      console.error("Apply featured error:", err);
      setFeatError(err.message || String(err));
    } finally {
      setFeatBusy(false);
    }
  };

  const featuredAction = async (id: bigint, action: 'approve' | 'reject' | 'remove') => {
    if (!actor || featBusyId !== null) return;
    setFeatBusyId(id);
    try {
      const res = action === 'approve' ? await actor.admin_approve_featured(id)
                : action === 'reject' ? await actor.admin_reject_featured(id)
                : await actor.admin_remove_featured(id);
      if (res.__kind__ === "Err") throw new Error(res.Err);
      await refreshAll();
    } catch (err: any) {
      console.error(`Featured ${action} failed:`, err);
      alert(`${action} failed: ${err.message || err}`);
    } finally {
      setFeatBusyId(null);
    }
  };

  // ── Local-dev controls: seed/clear featured states without paying ──
  const [devActive, setDevActive] = useState('2');
  const [devPending, setDevPending] = useState('1');
  const [devBusy, setDevBusy] = useState<string | null>(null);
  const devSeedFeatured = async () => {
    if (!actor || devBusy) return;
    setDevBusy('seed');
    try {
      const res = await actor.dev_seed_featured_dapps(BigInt(Number(devActive) || 0), BigInt(Number(devPending) || 0));
      if (res.__kind__ === "Err") { alert(res.Err); return; }
      await refreshAll();
    } catch (err: any) { alert(err.message || String(err)); }
    finally { setDevBusy(null); }
  };
  const devClearFeatured = async () => {
    if (!actor || devBusy) return;
    setDevBusy('clear');
    try {
      const res = await actor.dev_clear_featured_dapps();
      if (res.__kind__ === "Err") { alert(res.Err); return; }
      await refreshAll();
    } catch (err: any) { alert(err.message || String(err)); }
    finally { setDevBusy(null); }
  };
  usePageDevControls(isLocal && signedIn, () => (
    <div className="col" style={{ gap: 8 }}>
      <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-2)' }}>Explorer · featured hero</span>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ fontSize: 11, color: 'var(--fg-3)' }}>Active</label>
        <input className="burn-input" type="number" min="0" max="3" value={devActive}
          onChange={e => setDevActive(e.target.value)} style={{ width: 60 }} aria-label="active featured to seed" />
        <label style={{ fontSize: 11, color: 'var(--fg-3)' }}>Pending</label>
        <input className="burn-input" type="number" min="0" value={devPending}
          onChange={e => setDevPending(e.target.value)} style={{ width: 60 }} aria-label="pending featured to seed" />
        <Btn variant="secondary" sm onClick={devSeedFeatured} disabled={devBusy !== null}>
          {devBusy === 'seed' ? <LiveDot size={7} /> : <Icon name="spark" size={13} />} Seed featured
        </Btn>
        <Btn variant="secondary" sm onClick={devClearFeatured} disabled={devBusy !== null}>
          {devBusy === 'clear' ? <LiveDot size={7} /> : <Icon name="x" size={13} />} Clear
        </Btn>
      </div>
      <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>
        Seeds N active (live in the hero) + N pending (admin queue) placements against your approved
        listings — no payment. Clear empties the hero so you can see the "advertise" state. Cap is 3 active.
      </span>
    </div>
  ), [isLocal, signedIn, devActive, devPending, devBusy, myDapps]);

  const openSubmit = () => {
    if (!signedIn) { onSignIn(); return; }
    setSubName(''); setSubUrl(''); setSubDesc('');
    setSubToken(ExplorerToken.ICP); setSubDays('30');
    setQuote(null); setSubError(null); setSubStep('');
    setSubSuccess(false);
    setSubCategories([]); setSubVibe(false);
    setIsSubmitOpen(true);
  };

  const executeSubmit = async () => {
    if (!actor || !identity || !info || subBusy) return;
    const name = subName.trim();
    const url = subUrl.trim();
    const desc = subDesc.trim();
    if (!name) { setSubError("Give your dapp a name."); return; }
    if (name.length > 60) { setSubError("Name must be 60 characters or fewer."); return; }
    if (!url.startsWith('https://') || url.length <= 8) { setSubError("Enter a full https:// link."); return; }
    if (!desc) { setSubError("Add a short description."); return; }
    if (desc.length > 280) { setSubError("Description must be 280 characters or fewer."); return; }
    if (!daysValid) { setSubError(`Days must be between ${info.min_days} and ${info.max_days}.`); return; }
    if (!quote) { setSubError("Waiting for a price quote — try again in a second."); return; }

    const ledger = tokenLedger(subToken, info);
    if (!ledger) { setSubError("Token ledger unavailable."); return; }
    const fee = tokenFee(subToken, info);
    const deposit = quote.amount + fee;
    if (subBalance !== null && deposit + fee > subBalance) {
      const meta = TOKEN_BASE[subToken];
      setSubError(`Insufficient ${meta.label} balance — need ${fmtTokenAmount(deposit + fee, meta.decimals)} ${meta.label} (price + fees).`);
      return;
    }

    setSubBusy(true);
    setSubError(null);
    try {
      setSubStep("Step 1/2: Paying the listing fee into escrow...");
      const acct = await actor.get_explorer_deposit_address();
      const ledgerActor = createLedgerActor(ledger.toString(), {
        agentOptions: { host, identity, rootKey }
      });
      const transferResult = await ledgerActor.icrc1_transfer({
        to: {
          owner: acct.owner,
          subaccount: acct.subaccount ? acct.subaccount : undefined,
        },
        amount: deposit,
      });
      if (transferResult.__kind__ === "Err") {
        const err = transferResult.Err as any;
        const detail = err.__kind__ === "InsufficientFunds"
          ? `balance is ${fmtTokenAmount(err.InsufficientFunds.balance, TOKEN_BASE[subToken].decimals)} ${TOKEN_BASE[subToken].label}`
          : JSON.stringify(err, (_k, v) => typeof v === "bigint" ? v.toString() : v);
        throw new Error(`Payment failed: ${detail}`);
      }

      setSubStep("Step 2/2: Submitting your listing...");
      const res = await actor.submit_dapp(name, url, desc, subToken, BigInt(daysNum), subCategories, subVibe);
      if (res.__kind__ === "Err") {
        throw new Error(res.Err);
      }
      setSubSuccess(true);
      setSubStep("Submitted! Your listing is now waiting for admin approval — it will appear in the Explorer once approved.");
      await refreshAll();
    } catch (err: any) {
      console.error("Submit dapp error:", err);
      setSubError(err.message || String(err));
    } finally {
      setSubBusy(false);
    }
  };

  const executeAdminAdd = async () => {
    if (!actor || admBusy) return;
    const name = admName.trim();
    const url = admUrl.trim();
    const desc = admDesc.trim();
    if (!name || !url.startsWith('https://') || !desc) {
      setAdmError("Name, https:// link and description are all required.");
      return;
    }
    setAdmBusy(true);
    setAdmError(null);
    try {
      const res = await actor.admin_add_dapp(name, url, desc, admCategories);
      if (res.__kind__ === "Err") throw new Error(res.Err);
      setIsAdminFormOpen(false);
      await refreshAll();
    } catch (err: any) {
      setAdmError(err.message || String(err));
    } finally {
      setAdmBusy(false);
    }
  };

  const adminAction = async (id: bigint, action: 'approve' | 'reject' | 'remove') => {
    if (!actor || actionBusyId !== null) return;
    setActionBusyId(id);
    try {
      const res = action === 'approve' ? await actor.admin_approve_dapp(id)
                : action === 'reject' ? await actor.admin_reject_dapp(id)
                : await actor.admin_remove_dapp(id);
      if (res.__kind__ === "Err") throw new Error(res.Err);
      await refreshAll();
    } catch (err: any) {
      console.error(`Dapp ${action} failed:`, err);
      alert(`${action} failed: ${err.message || err}`);
    } finally {
      setActionBusyId(null);
    }
  };

  const allCategories: string[] = info?.available_categories ?? [];
  const toggleCat = (list: string[], set: (v: string[]) => void, c: string) => {
    if (list.includes(c)) set(list.filter(x => x !== c));
    else if (list.length < MAX_CATEGORIES) set([...list, c]);
  };
  const setFilter = (c: string | null) => { setCatFilter(c); setGridPage(0); };

  // Random directory order, stable for this page load (see shuffleSeed).
  const shuffledDapps = [...dapps].sort((a, b) => shuffleHash(a.id, shuffleSeed) - shuffleHash(b.id, shuffleSeed));
  // Only offer filters for categories that actually have a live listing.
  const presentCats = allCategories.filter(c => shuffledDapps.some(d => d.categories.includes(c)));
  const filteredDapps = catFilter ? shuffledDapps.filter(d => d.categories.includes(catFilter)) : shuffledDapps;
  const pageCount = Math.max(1, Math.ceil(filteredDapps.length / GRID_PAGE_SIZE));
  const safePage = Math.min(gridPage, pageCount - 1);
  const pageDapps = filteredDapps.slice(safePage * GRID_PAGE_SIZE, safePage * GRID_PAGE_SIZE + GRID_PAGE_SIZE);

  const subMeta = TOKEN_BASE[subToken];
  const pricePerDay = info ? fmtUSD(info.price_per_day_usd_e8s) : '$1';

  const dappCard = (d: DappListing, adminQueue = false) => {
    const daysLeft = dappDaysLeft(d, Date.now());
    return (
      <div key={d.id.toString()} className="card col" style={{ gap: 10, display: 'flex', flexDirection: 'column' }}>
        <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
          {d.community ? (
            <Chip tone="burn" style={{ height: 19, fontSize: 10 }}>
              <Icon name="spark" size={10} /> Community
            </Chip>
          ) : <span />}
          {adminQueue ? (
            <Chip tone="pending" style={{ height: 19, fontSize: 10 }}>
              <Icon name="clock" size={10} /> Pending
            </Chip>
          ) : daysLeft !== null && (
            <span className="mono row" style={{ gap: 4, fontSize: 10.5, color: daysLeft <= 5 ? 'var(--haze-ink)' : 'var(--fg-3)' }}
              title="Paid visibility window remaining">
              <Icon name="clock" size={11} /> {daysLeft}d left
            </span>
          )}
        </div>
        {d.is_vibe_coded && (
          <Chip tone="ok" style={{ height: 19, fontSize: 10, alignSelf: 'flex-start' }}>
            <Icon name="spark" size={10} /> Vibe coded
          </Chip>
        )}
        <div className="row" style={{ justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
          <h6 style={{ margin: 0, fontSize: 15, lineHeight: 1.35, overflowWrap: 'anywhere', flex: 1, minWidth: 0 }}>{d.name}</h6>
          {dappFavicon(d.url) && (
            <img
              src={dappFavicon(d.url)!}
              alt=""
              width={34}
              height={34}
              loading="lazy"
              onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
              style={{
                width: 34, height: 34, borderRadius: 999, objectFit: 'cover', flexShrink: 0,
                border: '1px solid var(--border)', background: 'var(--bg-alt)',
              }}
            />
          )}
        </div>
        <p style={{
          fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5, margin: 0, flex: 1,
          display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden',
        }}>
          {d.description}
        </p>
        <div className="row" style={{ justifyContent: 'space-between', gap: 8, paddingTop: 6, borderTop: '1px solid var(--border)' }}>
          <span className="mono row" style={{ gap: 3, fontSize: 10.5, color: 'var(--fg-3)', minWidth: 0, alignItems: 'center' }}>
            {adminQueue ? (
              `${formatPrincipal(d.submitter)} · ${d.days.toString()}d paid`
            ) : d.twitter ? (
              <a href={`https://x.com/${d.twitter}`} target="_blank" rel="noopener noreferrer"
                title={`@${d.twitter} on X`}
                style={{ color: 'var(--burn-ink)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 3, overflowWrap: 'anywhere' }}>
                @{d.twitter} <Icon name="external" size={10} stroke="var(--burn-ink)" />
              </a>
            ) : null}
          </span>
          <span className="row" style={{ gap: 6 }}>
            {adminQueue ? (
              <>
                <Btn variant="danger" sm style={{ height: 26, padding: '0 8px', fontSize: 11.5 }}
                  disabled={actionBusyId !== null}
                  onClick={() => adminAction(d.id, 'reject')}>
                  Reject &amp; refund
                </Btn>
                <Btn variant="primary" sm style={{ height: 26, padding: '0 10px', fontSize: 11.5 }}
                  disabled={actionBusyId !== null}
                  onClick={() => adminAction(d.id, 'approve')}>
                  <Icon name="check" size={11} stroke="var(--char-950)" /> Approve
                </Btn>
              </>
            ) : (
              <>
                {isAdmin && (
                  <Btn variant="ghost" sm style={{ height: 26, padding: '0 8px', fontSize: 11.5, color: 'var(--ember)' }}
                    disabled={actionBusyId !== null}
                    onClick={() => adminAction(d.id, 'remove')}>
                    Remove
                  </Btn>
                )}
                <a href={d.url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>
                  <Btn variant="primary" sm style={{ height: 26, padding: '0 10px', fontSize: 11.5 }}>
                    Visit <Icon name="external" size={11} stroke="var(--char-950)" />
                  </Btn>
                </a>
              </>
            )}
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className="idea-board-container">
      {/* ── Page header ── */}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div className="col" style={{ gap: 6 }}>
          <Eyebrow accent>ICP ecosystem</Eyebrow>
          <span className="row" style={{ gap: 10 }}>
            <Icon name="compass" size={22} stroke="var(--burn-ink)" />
            <h4 style={{ margin: 0 }}>Explorer</h4>
          </span>
          <p style={{ fontSize: 13, color: 'var(--fg-2)', maxWidth: 560 }}>
            Discover ICP dapps — or list your own for {pricePerDay}/day.{' '}
            <MoreInfo title="Listing on the Explorer">
              <div className="card col" style={{ gap: 8, borderColor: 'var(--burn)', background: 'color-mix(in srgb, var(--burn) 12%, var(--surface))' }}>
                <Eyebrow accent>The gist</Eyebrow>
                <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
                  Get your dapp in front of ICP users for <b>{pricePerDay}/day</b> — paid in any major
                  token, reviewed by an admin before it goes live.
                </p>
              </div>
              <div className="col" style={{ gap: 6 }}>
                <Eyebrow accent>How listing works</Eyebrow>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                  <li><b>Pick a duration:</b> 1–3650 days at {pricePerDay}/day.</li>
                  <li><b>Pay in any token:</b> ICP, ckBTC, ckETH, ckUSDC or ckUSDT, priced at live exchange rates.</li>
                  <li><b>Admin-reviewed:</b> community listings are checked before they appear.</li>
                </ul>
              </div>
            </MoreInfo>
          </p>
        </div>
        <span className="row" style={{ gap: 8 }}>
          {isAdmin && (
            <Btn variant="secondary" onClick={() => {
              setAdmName(''); setAdmUrl(''); setAdmDesc(''); setAdmError(null);
              setAdmCategories([]);
              setIsAdminFormOpen(true);
            }}>
              <Icon name="key" size={13} stroke="var(--burn-ink)" /> Add curated
            </Btn>
          )}
          <Btn variant="primary" onClick={openSubmit}>
            <Icon name="compass" size={14} stroke="var(--char-950)" />
            {signedIn ? 'List your dapp' : 'Sign in to list yours'}
          </Btn>
        </span>
      </div>

      {/* ── Featured hero: a 2-slide banner (a randomly-chosen featured dapp ↔
            an "advertise here" card). Falls back to advertise-only when nothing
            is featured. ── */}
      {!isLoading && featured && (() => {
        const hasActive = activeFeatured.length > 0;
        const heroView: FeaturedView | undefined = hasActive ? activeFeatured[Math.min(heroPick, activeFeatured.length - 1)] : undefined;
        const slide = hasActive ? heroSlide : 1;
        const slotsOpen = Number(featured.slots_open);
        const dotStyle = (on: boolean): React.CSSProperties => ({
          width: 7, height: 7, borderRadius: 999, border: 'none', padding: 0, cursor: 'pointer',
          background: on ? 'var(--burn)' : 'color-mix(in srgb, var(--burn) 30%, transparent)',
          transition: 'background var(--dur-fast) var(--ease-out)',
        });
        return (
          <div className="card" style={{
            position: 'relative', overflow: 'hidden', padding: 0,
            border: '1px solid var(--burn)',
            background: 'color-mix(in srgb, var(--burn) 8%, var(--surface))',
            boxShadow: 'var(--elev-2)',
          }}>
            <div style={{ display: 'flex', width: '200%', transform: `translateX(-${slide * 50}%)`, transition: 'transform 480ms var(--ease-out)' }}>
              {/* Slide 0 — the featured dapp */}
              <div style={{ width: '50%', flexShrink: 0, padding: '20px 22px', minHeight: 168, boxSizing: 'border-box' }}>
                {heroView ? (
                  <div className="row" style={{ gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
                    {dappFavicon(heroView.listing.url) && (
                      <img src={dappFavicon(heroView.listing.url)!} alt="" width={64} height={64} loading="lazy"
                        onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
                        style={{ width: 64, height: 64, borderRadius: 16, objectFit: 'cover', flexShrink: 0, border: '1px solid var(--border-hi)', background: 'var(--bg-alt)' }} />
                    )}
                    <div className="col" style={{ gap: 8, flex: 1, minWidth: 220 }}>
                      <span className="row" style={{ gap: 8, alignItems: 'center' }}>
                        <Chip tone="burn" style={{ height: 20, fontSize: 10 }}><Icon name="spark" size={10} /> Featured</Chip>
                        {heroView.listing.community && (
                          <span style={{ fontSize: 10, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Sponsored</span>
                        )}
                      </span>
                      <h4 style={{ margin: 0, fontSize: 20, lineHeight: 1.25, overflowWrap: 'anywhere' }}>{heroView.listing.name}</h4>
                      <p style={{ margin: 0, fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.5, maxWidth: 560,
                        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                        {heroView.listing.description}
                      </p>
                    </div>
                    <a href={heroView.listing.url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none', flexShrink: 0 }}>
                      <Btn variant="primary">Visit <Icon name="external" size={13} stroke="var(--char-950)" /></Btn>
                    </a>
                  </div>
                ) : <span />}
              </div>
              {/* Slide 1 — advertise your dapp here */}
              <div style={{ width: '50%', flexShrink: 0, padding: '20px 22px', minHeight: 168, boxSizing: 'border-box' }}>
                <div className="row" style={{ gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={{ width: 64, height: 64, borderRadius: 16, flexShrink: 0, border: '1px dashed var(--burn)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'color-mix(in srgb, var(--burn) 10%, transparent)' }}>
                    <Icon name="spark" size={28} stroke="var(--burn-ink)" />
                  </div>
                  <div className="col" style={{ gap: 8, flex: 1, minWidth: 220 }}>
                    <Eyebrow accent>Featured placement</Eyebrow>
                    <h4 style={{ margin: 0, fontSize: 20, lineHeight: 1.25 }}>Advertise your dapp here</h4>
                    <p style={{ margin: 0, fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.5, maxWidth: 560 }}>
                      Put your dapp in this hero, seen first by every visitor, for {featPricePerDay}/day.{' '}
                      {slotsOpen > 0
                        ? `${slotsOpen} of ${Number(featured.slots_total)} slots open.`
                        : `All ${Number(featured.slots_total)} slots are currently taken — apply to join the queue.`}
                    </p>
                  </div>
                  <Btn variant="primary" style={{ flexShrink: 0 }} onClick={openFeature}>
                    <Icon name="spark" size={13} stroke="var(--char-950)" />
                    {signedIn ? 'Feature your dapp' : 'Sign in to feature'}
                  </Btn>
                </div>
              </div>
            </div>
            {/* Slide controls — only when there's a featured dapp to toggle to */}
            {hasActive && (
              <div className="row" style={{ position: 'absolute', bottom: 10, left: 0, right: 0, justifyContent: 'center', gap: 7 }}>
                <button type="button" aria-label="Featured dapp" style={dotStyle(slide === 0)} onClick={() => setHeroSlide(0)} />
                <button type="button" aria-label="Advertise here" style={dotStyle(slide === 1)} onClick={() => setHeroSlide(1)} />
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Admin featured-application queue ── */}
      {isAdmin && pendingFeatured.length > 0 && (
        <div className="col" style={{ gap: 10 }}>
          <span className="row" style={{ gap: 8 }}>
            <Icon name="spark" size={14} stroke="var(--haze-ink)" />
            <b style={{ fontSize: 14, color: 'var(--fg)' }}>Featured applications</b>
            <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>· {pendingFeatured.length} pending · {Number(featured?.slots_open ?? 0)}/{Number(featured?.slots_total ?? 3)} slots open</span>
          </span>
          <div className="col" style={{ gap: 8 }}>
            {pendingFeatured.map(v => (
              <div key={v.featured.id.toString()} className="row card" style={{ justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center', padding: '10px 14px' }}>
                <span className="row" style={{ gap: 10, alignItems: 'center', minWidth: 0 }}>
                  <Chip tone="pending" style={{ height: 19, fontSize: 10 }}><Icon name="clock" size={10} /> Pending</Chip>
                  <b style={{ fontSize: 13.5, overflowWrap: 'anywhere' }}>{v.listing.name}</b>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                    {v.featured.days.toString()}d · {fmtUSD(v.featured.usd_total_e8s)} · {formatPrincipal(v.featured.applicant)}
                  </span>
                </span>
                <span className="row" style={{ gap: 6 }}>
                  <Btn variant="danger" sm style={{ height: 26, padding: '0 8px', fontSize: 11.5 }}
                    disabled={featBusyId !== null} onClick={() => featuredAction(v.featured.id, 'reject')}>
                    Reject &amp; refund
                  </Btn>
                  <Btn variant="primary" sm style={{ height: 26, padding: '0 10px', fontSize: 11.5 }}
                    disabled={featBusyId !== null || Number(featured?.slots_open ?? 0) <= 0}
                    title={Number(featured?.slots_open ?? 0) <= 0 ? 'All slots full — remove an active one first' : undefined}
                    onClick={() => featuredAction(v.featured.id, 'approve')}>
                    <Icon name="check" size={11} stroke="var(--char-950)" /> Approve
                  </Btn>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Admin: live featured placements (remove early) ── */}
      {isAdmin && activeFeatured.length > 0 && (
        <div className="col" style={{ gap: 8 }}>
          <span className="row" style={{ gap: 8 }}>
            <Icon name="spark" size={14} stroke="var(--burn-ink)" />
            <b style={{ fontSize: 14, color: 'var(--fg)' }}>Live featured</b>
            <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>· {activeFeatured.length}/{Number(featured?.slots_total ?? 3)}</span>
          </span>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {activeFeatured.map(v => (
              <span key={v.featured.id.toString()} className="row card" style={{ gap: 8, alignItems: 'center', padding: '6px 10px' }}>
                <b style={{ fontSize: 12.5 }}>{v.listing.name}</b>
                <Btn variant="ghost" sm style={{ height: 24, padding: '0 8px', fontSize: 11, color: 'var(--ember)' }}
                  disabled={featBusyId !== null} onClick={() => featuredAction(v.featured.id, 'remove')}>
                  Remove
                </Btn>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ── My featured applications (pending explainer) ── */}
      {signedIn && myFeatured.some(v => v.featured.status === FeaturedStatus.Pending) && (
        <div className="col" style={{ gap: 8, border: '1px solid var(--haze)', borderRadius: 10, padding: '12px 14px', background: 'var(--haze-dim)' }}>
          <span className="row" style={{ gap: 8 }}>
            <Icon name="clock" size={13} stroke="var(--haze-ink)" />
            <b style={{ fontSize: 13, color: 'var(--fg)' }}>Your featured applications</b>
          </span>
          {myFeatured.filter(v => v.featured.status === FeaturedStatus.Pending).map(v => (
            <span key={v.featured.id.toString()} className="row" style={{ gap: 8, fontSize: 12.5, color: 'var(--fg-2)', flexWrap: 'wrap' }}>
              <Chip tone="pending" style={{ height: 19, fontSize: 10 }}>Pending</Chip>
              <b>{v.listing.name}</b> · {v.featured.days.toString()}d featured — waiting for admin approval.
            </span>
          ))}
        </div>
      )}

      {/* ── Admin approval queue ── */}
      {isAdmin && pendingDapps.length > 0 && (
        <div className="col" style={{ gap: 10 }}>
          <span className="row" style={{ gap: 8 }}>
            <Icon name="key" size={14} stroke="var(--haze-ink)" />
            <b style={{ fontSize: 14, color: 'var(--fg)' }}>Awaiting approval</b>
            <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>· {pendingDapps.length} submission{pendingDapps.length === 1 ? '' : 's'}</span>
          </span>
          <div className="idea-grid">
            {pendingDapps.map(d => dappCard(d, true))}
          </div>
        </div>
      )}

      {/* ── My submissions (pending ones explain the approval gate) ── */}
      {signedIn && myDapps.some(d => d.status === DappStatus.Pending) && (
        <div className="col" style={{ gap: 8, border: '1px solid var(--haze)', borderRadius: 10, padding: '12px 14px', background: 'var(--haze-dim)' }}>
          <span className="row" style={{ gap: 8 }}>
            <Icon name="clock" size={13} stroke="var(--haze-ink)" />
            <b style={{ fontSize: 13, color: 'var(--fg)' }}>Your pending listings</b>
          </span>
          {myDapps.filter(d => d.status === DappStatus.Pending).map(d => (
            <span key={d.id.toString()} className="row" style={{ gap: 8, fontSize: 12.5, color: 'var(--fg-2)', flexWrap: 'wrap' }}>
              <Chip tone="pending" style={{ height: 19, fontSize: 10 }}>Pending</Chip>
              <b>{d.name}</b> · {d.days.toString()} day{d.days === 1n ? '' : 's'} paid — waiting for admin approval; it isn't public yet.
            </span>
          ))}
        </div>
      )}

      {/* ── Category filter ── */}
      {!isLoading && presentCats.length > 0 && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ ...LABEL_STYLE, marginRight: 2 }}>Filter</span>
          <button type="button" onClick={() => setFilter(null)} style={pillStyle(catFilter === null)}>All</button>
          {presentCats.map(c => (
            <button key={c} type="button" onClick={() => setFilter(c)} style={pillStyle(catFilter === c)}>{c}</button>
          ))}
        </div>
      )}

      {/* ── Directory grid ── */}
      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--fg-3)' }}>
          <LiveDot size={10} color="var(--burn-ink)" style={{ margin: '0 auto 12px' }} />
          Loading dapps...
        </div>
      ) : pageDapps.length === 0 ? (
        <div className="col" style={{ alignItems: 'center', gap: 10, padding: '48px 0', color: 'var(--fg-3)' }}>
          <Icon name="compass" size={28} stroke="var(--fg-dim)" />
          <span style={{ fontSize: 13 }}>
            {catFilter ? `No ${catFilter} dapps listed yet.` : 'No dapps listed yet. Be the first.'}
          </span>
          {catFilter && (
            <Btn variant="secondary" sm onClick={() => setFilter(null)}>Clear filter</Btn>
          )}
        </div>
      ) : (
        <div className="idea-grid">
          {pageDapps.map(d => dappCard(d))}
        </div>
      )}

      {pageCount > 1 && (
        <div className="row" style={{ justifyContent: 'center', gap: 12 }}>
          <Btn variant="secondary" sm disabled={safePage === 0} onClick={() => setGridPage(p => Math.max(0, p - 1))}>
            <Icon name="chevLeft" size={13} /> Prev
          </Btn>
          <span className="mono" style={{ fontSize: 12, color: 'var(--fg-3)' }}>{safePage + 1} / {pageCount}</span>
          <Btn variant="secondary" sm disabled={safePage >= pageCount - 1} onClick={() => setGridPage(p => Math.min(pageCount - 1, p + 1))}>
            Next <Icon name="chevRight" size={13} />
          </Btn>
        </div>
      )}

      {/* ── Submit-listing modal ── */}
      {isSubmitOpen && (
        <div style={MODAL_OVERLAY} onClick={() => !subBusy && setIsSubmitOpen(false)}>
          <div className="card col" style={MODAL_CARD} onClick={e => e.stopPropagation()}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="row" style={{ gap: 8 }}>
                <Icon name="compass" size={16} stroke="var(--burn-ink)" />
                <b>List your dapp</b>
              </span>
              <Btn variant="ghost" sm onClick={() => !subBusy && setIsSubmitOpen(false)}><Icon name="x" size={14} /></Btn>
            </div>

            {subSuccess ? (
              <div className="col" style={{ gap: 12, alignItems: 'center', padding: '16px 0' }}>
                <Icon name="checkCircle" size={32} stroke="var(--sprout-ink)" />
                <p style={{ fontSize: 13, color: 'var(--fg-2)', textAlign: 'center', margin: 0 }}>{subStep}</p>
                <Btn variant="secondary" onClick={() => setIsSubmitOpen(false)}>Close</Btn>
              </div>
            ) : (
              <>
                <div className="col" style={{ gap: 6, border: '1px solid var(--haze)', borderRadius: 8, padding: '10px 12px', background: 'var(--haze-dim)' }}>
                  <span className="row" style={{ gap: 6, fontSize: 12, color: 'var(--fg-2)' }}>
                    <Icon name="info" size={13} stroke="var(--haze-ink)" />
                    Community listings are <b>&nbsp;not public immediately&nbsp;</b> — an admin reviews
                    every submission first. If yours is rejected, the payment is refunded
                    (minus one ledger fee). Your paid days start counting at approval.
                  </span>
                </div>

                <div className="col" style={{ gap: 6 }}>
                  <label style={LABEL_STYLE}>Dapp name · {subName.length}/60</label>
                  <input type="text" className="burn-input" placeholder="e.g. My ICP Dapp"
                    value={subName} maxLength={60}
                    onChange={e => { setSubName(e.target.value); setSubError(null); }} />
                </div>
                <div className="col" style={{ gap: 6 }}>
                  <label style={LABEL_STYLE}>Link (https only)</label>
                  <input type="text" className="burn-input" placeholder="https://mydapp.icp0.io"
                    value={subUrl} maxLength={300}
                    onChange={e => { setSubUrl(e.target.value); setSubError(null); }} />
                </div>
                <div className="col" style={{ gap: 6 }}>
                  <label style={LABEL_STYLE}>Description · {subDesc.length}/280</label>
                  <textarea className="burn-input" rows={3} placeholder="What does your dapp do?"
                    value={subDesc} maxLength={280}
                    onChange={e => { setSubDesc(e.target.value); setSubError(null); }} />
                </div>

                {allCategories.length > 0 && (
                  <div className="col" style={{ gap: 6 }}>
                    <label style={LABEL_STYLE}>Categories · pick up to {MAX_CATEGORIES}</label>
                    <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      {allCategories.map(c => {
                        const on = subCategories.includes(c);
                        const full = !on && subCategories.length >= MAX_CATEGORIES;
                        return (
                          <button key={c} type="button" disabled={full}
                            onClick={() => { toggleCat(subCategories, setSubCategories, c); setSubError(null); }}
                            style={{ ...pillStyle(on), opacity: full ? 0.4 : 1, cursor: full ? 'not-allowed' : 'pointer' }}>
                            {c}
                          </button>
                        );
                      })}
                    </span>
                  </div>
                )}

                <label className="row" style={{ gap: 8, fontSize: 12.5, color: 'var(--fg-2)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={subVibe}
                    onChange={e => setSubVibe(e.target.checked)}
                    style={{ width: 15, height: 15, accentColor: 'var(--burn)', cursor: 'pointer' }} />
                  This dapp is&nbsp;<b>vibe coded</b>&nbsp;(built largely with AI) — adds a badge to your card.
                </label>

                <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                  <div className="col" style={{ gap: 6, flex: 1, minWidth: 140 }}>
                    <label style={LABEL_STYLE}>Days in the Explorer · {pricePerDay}/day</label>
                    <input type="number" className="burn-input" min={1} max={3650}
                      value={subDays} style={{ fontFamily: 'var(--font-mono)' }}
                      onChange={e => { setSubDays(e.target.value); setSubError(null); }} />
                    {!daysValid && subDays !== '' && (
                      <span style={{ fontSize: 11, color: 'var(--ember)' }}>1 to 3650 days.</span>
                    )}
                  </div>
                  <div className="col" style={{ gap: 6 }}>
                    <label style={LABEL_STYLE}>Pay with</label>
                    <span className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                      {TOKEN_ORDER.map(t => {
                        const afford = subAffordable(t);
                        return (
                        <button key={t} disabled={!afford}
                          onClick={() => { if (afford) { setSubToken(t); setSubError(null); } }}
                          title={afford ? TOKEN_BASE[t].label : `Not enough ${TOKEN_BASE[t].label} to cover the cost`}
                          style={{
                            background: subToken === t ? 'color-mix(in srgb, var(--burn) 14%, transparent)' : 'transparent',
                            border: `1px solid ${subToken === t ? 'var(--burn)' : 'var(--border)'}`,
                            color: !afford ? 'var(--fg-3)' : subToken === t ? 'var(--burn-ink)' : 'var(--fg-3)',
                            borderRadius: 999, padding: '5px 10px', fontSize: 11.5, fontWeight: 500,
                            cursor: afford ? 'pointer' : 'not-allowed', opacity: afford ? 1 : 0.4,
                            textDecoration: afford ? 'none' : 'line-through',
                            transition: 'all var(--dur-fast) var(--ease-out)',
                          }}>
                          {TOKEN_BASE[t].label}
                        </button>
                        );
                      })}
                    </span>
                  </div>
                </div>

                {/* Live quote */}
                <div className="col" style={{ gap: 4, border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', background: 'var(--surface-hi)' }}>
                  {isQuoting ? (
                    <span className="row" style={{ gap: 8, fontSize: 12.5, color: 'var(--fg-3)' }}>
                      <LiveDot size={6} /> Fetching live price...
                    </span>
                  ) : quote ? (
                    <>
                      <span className="row" style={{ gap: 6, fontSize: 13, color: 'var(--fg)' }}>
                        <b className="mono">{fmtTokenAmount(quote.amount, subMeta.decimals)} {subMeta.label}</b>
                        <span style={{ color: 'var(--fg-3)' }}>= {fmtUSD(quote.usd_total_e8s)} ({daysNum} day{daysNum === 1 ? '' : 's'} × {pricePerDay})</span>
                      </span>
                      <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>
                        1 {subMeta.label} ≈ {fmtUSD(quote.rate_usd_e8s)} · price locked for 15 minutes
                        {subBalance !== null && ` · your balance: ${fmtTokenAmount(subBalance, subMeta.decimals)} ${subMeta.label}`}
                      </span>
                    </>
                  ) : (
                    <span style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>Pick a valid number of days to get a price.</span>
                  )}
                </div>

                {subStep && !subError && <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>{subStep}</span>}
                {subError && <span style={{ fontSize: 12, color: 'var(--ember)' }}>{subError}</span>}

                <Btn variant="primary" disabled={subBusy || !quote} onClick={executeSubmit}>
                  {subBusy ? 'Working...' : quote ? `Pay ${fmtTokenAmount(quote.amount, subMeta.decimals)} ${subMeta.label} & submit` : 'Pay & submit'}
                </Btn>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Admin add-curated modal ── */}
      {isAdminFormOpen && (
        <div style={MODAL_OVERLAY} onClick={() => !admBusy && setIsAdminFormOpen(false)}>
          <div className="card col" style={MODAL_CARD} onClick={e => e.stopPropagation()}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="row" style={{ gap: 8 }}>
                <Icon name="key" size={15} stroke="var(--burn-ink)" />
                <b>Add curated listing</b>
              </span>
              <Btn variant="ghost" sm onClick={() => !admBusy && setIsAdminFormOpen(false)}><Icon name="x" size={14} /></Btn>
            </div>
            <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>
              Curated listings are free, permanent and carry no badge.
            </span>
            <div className="col" style={{ gap: 6 }}>
              <label style={LABEL_STYLE}>Name · {admName.length}/60</label>
              <input type="text" className="burn-input" value={admName} maxLength={60}
                onChange={e => { setAdmName(e.target.value); setAdmError(null); }} />
            </div>
            <div className="col" style={{ gap: 6 }}>
              <label style={LABEL_STYLE}>Link (https only)</label>
              <input type="text" className="burn-input" value={admUrl} maxLength={300}
                onChange={e => { setAdmUrl(e.target.value); setAdmError(null); }} />
            </div>
            <div className="col" style={{ gap: 6 }}>
              <label style={LABEL_STYLE}>Description · {admDesc.length}/280</label>
              <textarea className="burn-input" rows={3} value={admDesc} maxLength={280}
                onChange={e => { setAdmDesc(e.target.value); setAdmError(null); }} />
            </div>
            {allCategories.length > 0 && (
              <div className="col" style={{ gap: 6 }}>
                <label style={LABEL_STYLE}>Categories · pick up to {MAX_CATEGORIES}</label>
                <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  {allCategories.map(c => {
                    const on = admCategories.includes(c);
                    const full = !on && admCategories.length >= MAX_CATEGORIES;
                    return (
                      <button key={c} type="button" disabled={full}
                        onClick={() => { toggleCat(admCategories, setAdmCategories, c); setAdmError(null); }}
                        style={{ ...pillStyle(on), opacity: full ? 0.4 : 1, cursor: full ? 'not-allowed' : 'pointer' }}>
                        {c}
                      </button>
                    );
                  })}
                </span>
              </div>
            )}
            {admError && <span style={{ fontSize: 12, color: 'var(--ember)' }}>{admError}</span>}
            <Btn variant="primary" disabled={admBusy} onClick={executeAdminAdd}>
              {admBusy ? 'Adding...' : 'Add listing'}
            </Btn>
          </div>
        </div>
      )}

      {/* ── Apply-to-feature modal ── */}
      {isFeatOpen && (
        <div style={MODAL_OVERLAY} onClick={() => !featBusy && setIsFeatOpen(false)}>
          <div className="card col" style={MODAL_CARD} onClick={e => e.stopPropagation()}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="row" style={{ gap: 8 }}>
                <Icon name="spark" size={16} stroke="var(--burn-ink)" />
                <b>Feature your dapp</b>
              </span>
              <Btn variant="ghost" sm onClick={() => !featBusy && setIsFeatOpen(false)}><Icon name="x" size={14} /></Btn>
            </div>

            {featSuccess ? (
              <div className="col" style={{ gap: 12, alignItems: 'center', padding: '16px 0' }}>
                <Icon name="checkCircle" size={32} stroke="var(--sprout-ink)" />
                <p style={{ fontSize: 13, color: 'var(--fg-2)', textAlign: 'center', margin: 0 }}>{featStep}</p>
                <Btn variant="secondary" onClick={() => setIsFeatOpen(false)}>Close</Btn>
              </div>
            ) : myApprovedListings.length === 0 ? (
              <div className="col" style={{ gap: 12, padding: '8px 0' }}>
                <span style={{ fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55 }}>
                  Featuring promotes one of <b>your already-approved listings</b> into the hero. You don't have an
                  eligible listing yet — list your dapp first (and wait for approval), then come back to feature it.
                </span>
                <Btn variant="primary" onClick={() => { setIsFeatOpen(false); openSubmit(); }}>List your dapp</Btn>
              </div>
            ) : (
              <>
                <div className="col" style={{ gap: 6, border: '1px solid var(--haze)', borderRadius: 8, padding: '10px 12px', background: 'var(--haze-dim)' }}>
                  <span className="row" style={{ gap: 6, fontSize: 12, color: 'var(--fg-2)' }}>
                    <Icon name="info" size={13} stroke="var(--haze-ink)" />
                    Featured placements are <b>&nbsp;admin-reviewed&nbsp;</b> before they go live. Up to{' '}
                    {Number(featured?.slots_total ?? 3)} run at once, shown one at a time at the top of the Explorer.
                    Rejected applications are refunded (minus one ledger fee).
                  </span>
                </div>

                <div className="col" style={{ gap: 6 }}>
                  <label style={LABEL_STYLE}>Which listing</label>
                  <select className="burn-input" value={featListingId?.toString() ?? ''}
                    onChange={e => { setFeatListingId(BigInt(e.target.value)); setFeatError(null); }}
                    style={{ fontFamily: 'inherit' }}>
                    {myApprovedListings.map(d => (
                      <option key={d.id.toString()} value={d.id.toString()}>{d.name}</option>
                    ))}
                  </select>
                </div>

                <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                  <div className="col" style={{ gap: 6, flex: 1, minWidth: 140 }}>
                    <label style={LABEL_STYLE}>Days featured · {featPricePerDay}/day</label>
                    <input type="number" className="burn-input" min={featMinDays} max={featMaxDays}
                      value={featDays} style={{ fontFamily: 'var(--font-mono)' }}
                      onChange={e => { setFeatDays(e.target.value); setFeatError(null); }} />
                    {!featDaysValid && featDays !== '' && (
                      <span style={{ fontSize: 11, color: 'var(--ember)' }}>{featMinDays} to {featMaxDays} days.</span>
                    )}
                  </div>
                  <div className="col" style={{ gap: 6 }}>
                    <label style={LABEL_STYLE}>Pay with</label>
                    <span className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                      {TOKEN_ORDER.map(t => (
                        <button key={t} onClick={() => { setFeatToken(t); setFeatError(null); }} style={pillStyle(featToken === t)}>
                          {TOKEN_BASE[t].label}
                        </button>
                      ))}
                    </span>
                  </div>
                </div>

                <div className="col" style={{ gap: 4, border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', background: 'var(--surface-hi)' }}>
                  {featQuoting ? (
                    <span className="row" style={{ gap: 8, fontSize: 12.5, color: 'var(--fg-3)' }}>
                      <LiveDot size={6} /> Fetching live price...
                    </span>
                  ) : featQuote ? (
                    <>
                      <span className="row" style={{ gap: 6, fontSize: 13, color: 'var(--fg)' }}>
                        <b className="mono">{fmtTokenAmount(featQuote.amount, featMeta.decimals)} {featMeta.label}</b>
                        <span style={{ color: 'var(--fg-3)' }}>= {fmtUSD(featQuote.usd_total_e8s)} ({featDaysNum} day{featDaysNum === 1 ? '' : 's'} × {featPricePerDay})</span>
                      </span>
                      <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>
                        1 {featMeta.label} ≈ {fmtUSD(featQuote.rate_usd_e8s)} · price locked for 15 minutes
                        {featBalance !== null && ` · your balance: ${fmtTokenAmount(featBalance, featMeta.decimals)} ${featMeta.label}`}
                      </span>
                    </>
                  ) : (
                    <span style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>Pick a valid number of days to get a price.</span>
                  )}
                </div>

                {featStep && !featError && <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>{featStep}</span>}
                {featError && <span style={{ fontSize: 12, color: 'var(--ember)' }}>{featError}</span>}

                <Btn variant="primary" disabled={featBusy || !featQuote} onClick={executeFeature}>
                  {featBusy ? 'Working...' : featQuote ? `Pay ${fmtTokenAmount(featQuote.amount, featMeta.decimals)} ${featMeta.label} & feature` : 'Pay & feature'}
                </Btn>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
