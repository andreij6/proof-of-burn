import { useEffect, useState } from 'react';
import { Principal } from "@icp-sdk/core/principal";
import { ExplorerToken, DappStatus } from "./bindings/backend";
import type { DappListing, ExplorerInfo, ExplorerQuote } from "./bindings/backend";
import { createActor as createLedgerActor } from "./bindings/ledger";
import { Icon, Eyebrow, Chip, Btn, LiveDot, MoreInfo, formatPrincipal } from "./ui";
import { fmtTokenAmount } from "./IdeaBoard";
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

function fmtDate(ns: bigint): string {
  return new Date(Number(ns / 1_000_000n)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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
  onSignIn: () => void;
}

export default function Explorer({ actor, identity, principal, host, rootKey, isAdmin, onSignIn }: ExplorerProps) {
  const signedIn = !!(principal && !principal.isAnonymous());

  const [dapps, setDapps] = useState<DappListing[]>([]);
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

  const refreshAll = async (currentActor = actor) => {
    if (!currentActor) return;
    try {
      const [dappList, explorerInfo, mine, pending] = await Promise.all([
        currentActor.list_dapps(),
        currentActor.get_explorer_info(),
        signedIn ? currentActor.list_my_dapp_submissions() : Promise.resolve([]),
        isAdmin ? currentActor.list_pending_dapps() : Promise.resolve([]),
      ]);
      setDapps(dappList);
      setInfo(explorerInfo);
      setMyDapps(mine);
      setPendingDapps(pending);
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

  // Only offer filters for categories that actually have a live listing.
  const presentCats = allCategories.filter(c => dapps.some(d => d.categories.includes(c)));
  const filteredDapps = catFilter ? dapps.filter(d => d.categories.includes(catFilter)) : dapps;
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
        <h6 style={{ margin: 0, fontSize: 15, lineHeight: 1.35, overflowWrap: 'anywhere' }}>{d.name}</h6>
        <p style={{
          fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5, margin: 0, flex: 1,
          display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden',
        }}>
          {d.description}
        </p>
        <div className="row" style={{ justifyContent: 'space-between', gap: 8, paddingTop: 6, borderTop: '1px solid var(--border)' }}>
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>
            {adminQueue ? `${formatPrincipal(d.submitter)} · ${d.days.toString()}d paid` : fmtDate(d.created_at)}
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
                      {TOKEN_ORDER.map(t => (
                        <button key={t} onClick={() => { setSubToken(t); setSubError(null); }}
                          style={{
                            background: subToken === t ? 'color-mix(in srgb, var(--burn) 14%, transparent)' : 'transparent',
                            border: `1px solid ${subToken === t ? 'var(--burn)' : 'var(--border)'}`,
                            color: subToken === t ? 'var(--burn-ink)' : 'var(--fg-3)',
                            borderRadius: 999, padding: '5px 10px', fontSize: 11.5, fontWeight: 500,
                            cursor: 'pointer', transition: 'all var(--dur-fast) var(--ease-out)',
                          }}>
                          {TOKEN_BASE[t].label}
                        </button>
                      ))}
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
    </div>
  );
}
