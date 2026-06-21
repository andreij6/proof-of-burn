import { useEffect, useState } from 'react';
import { Principal } from "@icp-sdk/core/principal";
import { TxDirection } from "./bindings/backend";
import { IdeaToken } from "./tokens";
import type { TransactionRecord } from "./bindings/backend";
import { fmtTokenAmount } from "./IdeaBoard";
import { createActor as createLedgerActor } from "./bindings/ledger";
import type { Identity } from "@icp-sdk/core/agent";
import { ExplorerToken, type Backend } from "./bindings/backend";
import { Icon, Eyebrow, Chip, Btn, fmtICP, formatPrincipal } from "./ui";
import { useErrorImpression } from "./analytics";
import { makeCkbtcMinter, makeApprover, CKBTC_MINTER_ID } from "./minters";

// ==========================================
// Profile — sectioned like the Admin console: Overview (identity + social +
// account summary), Activity (the full receipt trail), and Agent Space (the
// machine half of Cycle Burn: skills, quickstart, endpoint cheat-sheet).
// ==========================================

interface PayoutsProps {
  actor: any;
  principal: Principal | null;
  identity: unknown;
  host: string;
  rootKey?: Uint8Array;
  ledgerCanisterId: string;
  isLocal: boolean;
  backendCanisterId: string;
  /** 'wallet' when the nav wallet button routed here (App remounts on change). */
  initialSection: ProfileSection;
  onSignIn: () => void;
}

type ProfileSection = 'overview' | 'wallet' | 'activity' | 'agents';

const SECTIONS: { key: ProfileSection; label: string; icon: string }[] = [
  { key: 'overview', label: 'Overview', icon: 'key' },
  { key: 'wallet', label: 'Wallet', icon: 'wallet' },
  { key: 'activity', label: 'Activity', icon: 'coins' },
  { key: 'agents', label: 'Agent Space', icon: 'spark' },
];

const WALLET_TOKENS_META: { token: ExplorerToken; label: string; decimals: number }[] = [
  { token: ExplorerToken.ICP, label: 'ICP', decimals: 8 },
  { token: ExplorerToken.CkBTC, label: 'ckBTC', decimals: 8 },
  { token: ExplorerToken.CkETH, label: 'ckETH', decimals: 18 },
  { token: ExplorerToken.CkUSDC, label: 'ckUSDC', decimals: 6 },
  { token: ExplorerToken.CkUSDT, label: 'ckUSDT', decimals: 6 },
];

function fmtUnits(amount: bigint, decimals: number): string {
  const d = BigInt(10) ** BigInt(decimals);
  const whole = amount / d;
  const frac = amount % d;
  const fracStr = frac === 0n ? '' : `.${(frac + d).toString().slice(1).replace(/0+$/, '')}`;
  return `${whole.toLocaleString()}${fracStr}`;
}

function parseUnits(text: string, decimals: number): bigint | null {
  const m = text.trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const frac = (m[2] ?? '').slice(0, decimals).padEnd(decimals, '0');
  try { return BigInt(m[1]) * BigInt(10) ** BigInt(decimals) + BigInt(frac || '0'); } catch { return null; }
}

const TX_META: Record<string, { label: string; icon: string; blurb: string }> = {
  // In — payouts the site made to you.
  LotteryWin: { label: 'Lottery jackpot', icon: 'target', blurb: '65% of the prize pool' },
  UnstakeDisbursement: { label: 'Unstake disbursement', icon: 'zap', blurb: 'Dissolved stake returned to your wallet' },
  IdeaUpvoteShare: { label: 'Idea upvote share', icon: 'bulb', blurb: 'Legacy — upvoting is now free, no poster share' },
  CommitmentRefund: { label: 'Commitment refund', icon: 'undo', blurb: 'Escrow returned — threshold unmet' },
  PoolReward: { label: 'Neuron Syndicate reward', icon: 'arrowUp', blurb: '25% of a settled burn, split equally among the top 100 Neuron Syndicate neurons' },
  EarlyAdopterYield: { label: 'Early Adopter yield', icon: 'spark', blurb: 'Legacy — Perm-tier stakes earn lottery tickets only, no ICP yield' },
  // Out — what you put in.
  deposit: { label: 'Burn commitment', icon: 'flame', blurb: 'Escrowed behind a proposal stance' },
  add_commitment: { label: 'Commitment top-up', icon: 'flame', blurb: 'Added to an open commitment' },
  idea_post: { label: 'Idea post fee', icon: 'bulb', blurb: '1 ICP anti-spam fee to the treasury' },
  idea_upvote: { label: 'Idea upvote', icon: 'bulb', blurb: 'Legacy — upvoting is now free' },
  project_fund: { label: 'Project funding', icon: 'coins', blurb: '100% to the treasury build fund' },
  pool_register: { label: 'Pool initiation fee', icon: 'target', blurb: 'One-time neuron pool entry' },
  stake: { label: 'Stake lockup', icon: 'zap', blurb: 'Locked, not spent — returns in full on unstake' },
};

const TOKEN_DECIMALS: Record<string, { label: string; decimals: number }> = {
  [IdeaToken.ICP]: { label: 'ICP', decimals: 8 },
  [IdeaToken.CkBTC]: { label: 'ckBTC', decimals: 8 },
  [IdeaToken.CkETH]: { label: 'ckETH', decimals: 18 },
  [IdeaToken.CkUSDC]: { label: 'ckUSDC', decimals: 6 },
  [IdeaToken.CkUSDT]: { label: 'ckUSDT', decimals: 6 },
};

function payoutDate(atNs: bigint): string {
  return new Date(Number(atNs / 1_000_000n)).toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

// Agent-relevant endpoints — the cheat-sheet an agent (or its author) needs
// before reading the full skills. Queries are free; updates need a signed
// (non-anonymous) principal — any self-generated key works, no Internet
// Identity required.
const AGENT_ENDPOINTS: { method: string; kind: 'query' | 'update'; note: string }[] = [
  { method: 'list_active_proposals()', kind: 'query', note: 'Open NNS proposals with pots, thresholds and deadlines' },
  { method: 'get_global_stats()', kind: 'query', note: 'Burned total, TVL, votes cast — the public scoreboard' },
  { method: 'get_stake_deposit_address()', kind: 'query', note: 'Fund this, then stake(amount, tier) — whole ICP only' },
  { method: 'stake(amount_e8s, tier)', kind: 'update', note: 'Join a term pool: earns daily lottery tickets' },
  { method: 'claim_daily_tickets()', kind: 'update', note: 'Once per UTC day — ideal cron target for agents' },
  { method: 'get_lottery_info()', kind: 'update', note: 'Pot, next drawing, your tickets, live odds' },
  { method: 'list_ideas() / upvote_idea(…)', kind: 'update', note: 'Read and back Community R&D ideas (ICP/ckBTC/ckETH)' },
  { method: 'get_my_payouts()', kind: 'query', note: 'Everything the protocol ever paid your principal' },
];

export default function Payouts({ actor, principal, identity, host, rootKey, ledgerCanisterId, isLocal, backendCanisterId, initialSection, onSignIn }: PayoutsProps) {
  const signedIn = !!(principal && !principal.isAnonymous());
  const [section, setSection] = useState<ProfileSection>(initialSection);
  const [txs, setTxs] = useState<TransactionRecord[]>([]);
  const [loaded, setLoaded] = useState(false);

  // X / Twitter handle (used for proposal-sharing social features).
  const [handleInput, setHandleInput] = useState('');
  const [savedHandle, setSavedHandle] = useState<string | null>(null);
  const [handleBusy, setHandleBusy] = useState(false);
  const [handleNote, setHandleNote] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      if (!actor || !signedIn) { setTxs([]); setLoaded(false); setSavedHandle(null); return; }
      try {
        const [mineFirst, h] = await Promise.all([
          actor.get_my_transactions(),
          actor.get_my_twitter_handle(),
        ]);
        setSavedHandle(h ?? null);
        setHandleInput(h ?? '');
        let mine = mineFirst;
        // Local dev: seed a varied mock history on first visit so the page
        // is never empty while testing (no-op on mainnet and once seeded).
        if (isLocal && mine.length === 0) {
          const res = await actor.dev_seed_payouts();
          if (res.__kind__ === "Ok") mine = await actor.get_my_transactions();
        }
        setTxs(mine);
        setLoaded(true);
      } catch (err) {
        console.error("Failed to fetch transactions:", err);
      }
    })();
  }, [actor, principal, signedIn, isLocal]);

  // ── Agent skills: every flow in Cycle Burn ships as a copy-paste skill ──
  const [copiedSkill, setCopiedSkill] = useState<string | null>(null);
  const isLocalHost = typeof window !== 'undefined' &&
    (window.location.origin.includes('localhost') || window.location.origin.includes('127.0.0.1'));
  const env = isLocalHost ? 'local' : 'prod';
  const SKILLS: { key: string; name: string; file: string; blurb: string; instruction: string }[] = [
    {
      key: 'voting',
      name: 'Voting & burning',
      file: `llms-${env}.txt`,
      blurb: 'Read live NNS proposals, commit ICP behind a stance, track refunds and burns.',
      instruction: 'read proposals, commit ICP behind adopt/reject stances, and track settlements on Cycle Burn',
    },
    {
      key: 'rd',
      name: 'Community R&D board',
      file: `llms-rd-${env}.txt`,
      blurb: 'Post ideas ($0.05 in ICP/ckBTC/ckETH), upvote for free, defend ideas from expiry, fund official projects.',
      instruction: 'read, post, upvote and fund on the Cycle Burn Community R&D board',
    },
    {
      key: 'lottery',
      name: 'Lossless Lottery',
      file: `llms-lottery-${env}.txt`,
      blurb: 'Claim daily tickets on a schedule and track drawings and winnings.',
      instruction: 'claim daily Cycle Burn lottery tickets (cron-friendly) and track drawings',
    },
    {
      key: 'early_adopters',
      name: 'Perm neuron validation',
      file: 'llms-early_adopters-validate.txt',
      blurb: 'Independently audit the Perm neuron (permanent stake) program against its source code and tests.',
      instruction: 'independently verify, from source code and tests, that the Cycle Burn Perm neuron program works exactly as advertised',
    },
  ];
  const copySkill = (s: typeof SKILLS[number]) => {
    const url = `${window.location.origin}/${s.file}`;
    navigator.clipboard.writeText(`Fetch ${url} and follow its instructions to ${s.instruction}.`);
    setCopiedSkill(s.key);
    setTimeout(() => setCopiedSkill(null), 2000);
  };

  // One-paste onboarding for an agent: who we are, where, and the house rules.
  const [quickstartCopied, setQuickstartCopied] = useState(false);
  const quickstart = [
    `You are connecting to Cycle Burn, an ICP governance dapp.`,
    `Backend canister: ${backendCanisterId} (${isLocal ? 'local replica' : 'IC mainnet'}). Candid: ${window?.location?.origin ?? ''}/llms-${env}.txt lists the flows.`,
    `Authentication: any self-generated principal works (no Internet Identity needed). Generate a key, sign your calls; queries are free and anonymous.`,
    `House rules: staking and unstaking are whole-ICP only; voting is burn-only and open to any signed-in caller (following the community leader is encouraged but not required); staking earns daily lottery tickets (claimable once per UTC day via claim_daily_tickets).`,
    `Start by fetching the skill files on this origin (llms-${env}.txt, llms-rd-${env}.txt, llms-lottery-${env}.txt) and follow their instructions.`,
  ].join('\n');
  const copyQuickstart = () => {
    navigator.clipboard.writeText(quickstart);
    setQuickstartCopied(true);
    setTimeout(() => setQuickstartCopied(false), 2000);
  };

  const saveHandle = async () => {
    if (!actor || handleBusy) return;
    setHandleBusy(true);
    setHandleNote(null);
    try {
      const res = await actor.set_twitter_handle(handleInput);
      if (res.__kind__ === "Err") {
        throw new Error(res.Err === 'INVALID_HANDLE'
          ? 'Handles are 1–15 characters: letters, numbers and underscores.'
          : res.Err);
      }
      const cleaned = handleInput.trim().replace(/^@/, '');
      setSavedHandle(cleaned || null);
      setHandleInput(cleaned);
      setHandleNote(cleaned ? `Saved — you're @${cleaned}.` : 'Handle removed.');
    } catch (err: any) {
      setHandleNote(err.message || String(err));
    } finally {
      setHandleBusy(false);
    }
  };

  const card: React.CSSProperties = {
    border: '1px solid var(--border)', borderRadius: 10,
    background: 'var(--surface)', padding: 16,
  };

  // ── Overview summary numbers (ICP-denominated rows only, to stay honest) ──
  const icpIn = txs.filter(t => t.direction === TxDirection.In && t.token === IdeaToken.ICP)
    .reduce((s, t) => s + t.amount, 0n);
  const icpOut = txs.filter(t => t.direction === TxDirection.Out && t.token === IdeaToken.ICP)
    .reduce((s, t) => s + t.amount, 0n);
  const lastIn = txs.find(t => t.direction === TxDirection.In);

  return (
    <div className="dashboard-container">
      {/* ── Header ── */}
      <div className="col" style={{ gap: 6 }}>
        <span className="row" style={{ gap: 8 }}>
          <Icon name="wallet" size={16} stroke="var(--burn-ink)" />
          <Eyebrow accent>Profile</Eyebrow>
        </span>
        <b style={{ fontSize: 17 }}>Your account — and your agents'.</b>
      </div>

      {/* ── Section nav ── */}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {SECTIONS.map(s => (
          <Btn key={s.key} variant={section === s.key ? 'primary' : 'ghost'} sm onClick={() => setSection(s.key)}>
            <Icon name={s.icon} size={13} stroke={section === s.key ? 'var(--char-950)' : 'currentColor'} />
            {s.label}
          </Btn>
        ))}
      </div>

      {/* ════ OVERVIEW ════ */}
      {section === 'overview' && (
        !signedIn ? (
          <div className="col" style={{ ...card, gap: 10, alignItems: 'flex-start' }}>
            <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
              Sign in to see your identity, social link and account summary. (The Agent Space
              works without signing in — skills are public.)
            </span>
            <Btn variant="primary" sm onClick={onSignIn}>
              <Icon name="key" size={13} stroke="var(--char-950)" /> Sign in
            </Btn>
          </div>
        ) : (
          <>
            {/* Identity */}
            <div className="col" style={{ ...card, gap: 10 }}>
              <Eyebrow>Identity</Eyebrow>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <Chip tone="muted"><Icon name="key" size={11} /> {formatPrincipal(principal)}</Chip>
                <button
                  onClick={() => principal && navigator.clipboard.writeText(principal.toString())}
                  style={{
                    background: 'transparent', border: 'none', color: 'var(--fg-3)',
                    cursor: 'pointer', fontSize: 11.5, padding: 0,
                    display: 'flex', alignItems: 'center', gap: 4,
                  }}
                >
                  <Icon name="copy" size={11} stroke="var(--fg-3)" /> copy principal
                </button>
              </div>
              <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
                Your principal is your account everywhere in Cycle Burn — deposits, stakes, votes and
                payouts all key on it. Payouts land in your wallet automatically; nothing to claim.
              </span>
            </div>

            {/* Summary */}
            <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'stretch' }}>
              <div className="col" style={{ ...card, gap: 4, flex: '1 1 160px' }}>
                <span style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--fg-3)' }}>Received (ICP)</span>
                <b className="mono" style={{ fontSize: 17, color: 'var(--sprout-ink)' }}>{loaded ? fmtICP(icpIn) : '…'}</b>
              </div>
              <div className="col" style={{ ...card, gap: 4, flex: '1 1 160px' }}>
                <span style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--fg-3)' }}>Put in (ICP)</span>
                <b className="mono" style={{ fontSize: 17 }}>{loaded ? fmtICP(icpOut) : '…'}</b>
              </div>
              <div className="col" style={{ ...card, gap: 4, flex: '1 1 200px' }}>
                <span style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--fg-3)' }}>Latest payout</span>
                <b className="mono" style={{ fontSize: 14 }}>
                  {loaded ? (lastIn ? `${fmtTokenAmount(lastIn.amount, TOKEN_DECIMALS[lastIn.token].decimals)} ${TOKEN_DECIMALS[lastIn.token].label}` : '—') : '…'}
                </b>
                {lastIn && <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>{(TX_META[lastIn.kind] ?? { label: lastIn.kind }).label}</span>}
              </div>
            </div>

            {/* Social */}
            <div className="col" style={{ ...card, gap: 10 }}>
              <Eyebrow>Social — X / Twitter</Eyebrow>
              <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
                Add your X handle to tie your shares to your account. The <b>Share</b> button on any
                proposal opens a pre-filled post (with your stance, if you've voted) linking straight
                back to that proposal here.
              </span>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <div style={{ position: 'relative', maxWidth: 240, flex: 1, minWidth: 180 }}>
                  <span className="mono" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 13, color: 'var(--fg-3)', pointerEvents: 'none' }}>@</span>
                  <input
                    type="text" className="burn-input" placeholder="yourhandle" maxLength={16}
                    value={handleInput} style={{ paddingLeft: 26, fontFamily: 'var(--font-mono)' }}
                    onChange={e => { setHandleInput(e.target.value); setHandleNote(null); }}
                  />
                </div>
                <Btn variant="primary" sm onClick={saveHandle} disabled={handleBusy || (handleInput.trim().replace(/^@/, '') === (savedHandle ?? ''))}>
                  {handleBusy ? 'Saving…' : 'Save'}
                </Btn>
                {savedHandle && (
                  <Btn variant="ghost" sm disabled={handleBusy} onClick={() => { setHandleInput(''); }}>
                    Clear
                  </Btn>
                )}
              </div>
              {savedHandle && !handleNote && (
                <span className="row" style={{ gap: 6, fontSize: 12, color: 'var(--fg-3)' }}>
                  <Icon name="checkCircle" size={12} stroke="var(--sprout-ink)" />
                  Linked as <a href={`https://x.com/${savedHandle}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--burn-ink)' }}>@{savedHandle}</a>
                </span>
              )}
              {handleNote && (
                <span style={{ fontSize: 12, color: handleNote.startsWith('Saved') || handleNote === 'Handle removed.' ? 'var(--sprout-ink)' : 'var(--ember)' }}>
                  {handleNote}
                </span>
              )}
            </div>
          </>
        )
      )}

      {/* ════ WALLET ════ */}
      {section === 'wallet' && (
        !signedIn ? (
          <div className="col" style={{ ...card, gap: 10, alignItems: 'flex-start' }}>
            <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>Sign in to use your wallet.</span>
            <Btn variant="primary" sm onClick={onSignIn}>
              <Icon name="key" size={13} stroke="var(--char-950)" /> Sign in
            </Btn>
          </div>
        ) : (
          <WalletSection
            actor={actor}
            principal={principal!}
            identity={identity}
            host={host}
            rootKey={rootKey}
            ledgerCanisterId={ledgerCanisterId}
            isLocal={isLocal}
          />
        )
      )}

      {/* ════ ACTIVITY ════ */}
      {section === 'activity' && (
        <div className="col" style={{ ...card, gap: 10 }}>
          <Eyebrow>Transaction history</Eyebrow>
          <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
            Commitments, fees, stakes and upvotes on one side — jackpots, disbursements, shares and
            refunds on the other. Newest first.
          </span>
          {!signedIn ? (
            <div className="col" style={{ gap: 10, alignItems: 'flex-start' }}>
              <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
                Sign in to see your transaction history.
              </span>
              <Btn variant="primary" sm onClick={onSignIn}>
                <Icon name="key" size={13} stroke="var(--char-950)" /> Sign in
              </Btn>
            </div>
          ) : txs.length === 0 ? (
            <span style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>
              {loaded
                ? "Nothing yet — commit to a proposal, stake, or post an idea and every movement shows up here."
                : "Loading…"}
            </span>
          ) : (
            <div className="col" style={{ gap: 0 }}>
              {txs.map((tx, i) => {
                const meta = TX_META[tx.kind] ?? { label: tx.kind, icon: 'coins', blurb: '' };
                const tok = TOKEN_DECIMALS[tx.token];
                const incoming = tx.direction === TxDirection.In;
                return (
                  <div key={`${tx.kind}-${String(tx.timestamp)}-${i}`} className="row" style={{
                    gap: 10, padding: '10px 0', fontSize: 12.5, flexWrap: 'wrap',
                    borderTop: '1px solid var(--border)', justifyContent: 'space-between',
                  }}>
                    <span className="row" style={{ gap: 10 }}>
                      <Icon name={meta.icon} size={14} stroke={incoming ? 'var(--sprout-ink)' : 'var(--burn-ink)'} />
                      <span className="col" style={{ gap: 2 }}>
                        <b>{meta.label}</b>
                        <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
                          {meta.blurb ? `${meta.blurb} · ` : ''}{payoutDate(tx.timestamp)}
                        </span>
                      </span>
                    </span>
                    <Chip tone={incoming ? 'ok' : 'muted'}>
                      {incoming ? '+' : '−'}{fmtTokenAmount(tx.amount, tok.decimals)} {tok.label}
                    </Chip>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ════ AGENT SPACE ════ */}
      {section === 'agents' && (
        <>
          <div className="col" style={{ gap: 6 }}>
            <span style={{ fontSize: 12.5, color: 'var(--fg-2)', maxWidth: 680 }}>
              Cycle Burn is built agent-first: every flow has a machine-readable skill, queries are
              open, and any self-generated principal can transact — no Internet Identity required.
              Point an agent here and it can vote, stake, claim tickets and back ideas on your
              schedule.
            </span>
          </div>

          {/* Quickstart */}
          <div className="col" style={{ ...card, gap: 10, border: '1px dashed var(--burn)', background: 'color-mix(in srgb, var(--burn) 12%, var(--surface))' }}>
            <span className="row" style={{ gap: 8, justifyContent: 'space-between', alignItems: 'center' }}>
              <Eyebrow>Agent quickstart — one paste connects an agent</Eyebrow>
              <Btn variant="secondary" sm onClick={copyQuickstart}>
                <Icon name={quickstartCopied ? 'check' : 'copy'} size={12}
                  stroke={quickstartCopied ? 'var(--sprout-ink)' : 'currentColor'} />
                {quickstartCopied ? 'Copied' : 'Copy'}
              </Btn>
            </span>
            <pre className="mono" style={{
              margin: 0, padding: '10px 12px', fontSize: 11, lineHeight: 1.55,
              whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', borderRadius: 8,
              background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--fg-2)',
            }}>{quickstart}</pre>
          </div>

          {/* Skills */}
          <div className="col" style={{ ...card, gap: 10 }}>
            <Eyebrow>Skills — copy one, hand it to your agent</Eyebrow>
            <div className="col" style={{ gap: 0 }}>
              {SKILLS.map((s, i) => (
                <div key={s.key} className="row" style={{
                  gap: 10, padding: '10px 2px', alignItems: 'flex-start',
                  borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                }}>
                  <div className="col" style={{ gap: 2, flex: 1, minWidth: 0 }}>
                    <span className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                      <b style={{ fontSize: 13 }}>{s.name}</b>
                      <a className="mono" href={`/${s.file}`} target="_blank" rel="noreferrer"
                        style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>/{s.file}</a>
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>{s.blurb}</span>
                  </div>
                  <Btn variant="secondary" sm onClick={() => copySkill(s)} style={{ flexShrink: 0 }}>
                    <Icon name={copiedSkill === s.key ? 'check' : 'copy'} size={12}
                      stroke={copiedSkill === s.key ? 'var(--sprout-ink)' : 'currentColor'} />
                    {copiedSkill === s.key ? 'Copied' : 'Copy'}
                  </Btn>
                </div>
              ))}
            </div>
          </div>

          {/* Endpoint cheat-sheet */}
          <div className="col" style={{ ...card, gap: 10 }}>
            <Eyebrow>Endpoint cheat-sheet</Eyebrow>
            <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>
              Backend canister <b className="mono">{backendCanisterId}</b>
              {isLocal ? ' (local replica)' : ' (IC mainnet)'} — the calls an agent reaches for
              first. Full candid signatures live in the skill files.
            </span>
            <div className="col" style={{ gap: 0 }}>
              {AGENT_ENDPOINTS.map((e, i) => (
                <div key={e.method} className="row" style={{
                  gap: 10, padding: '7px 2px', fontSize: 12, flexWrap: 'wrap', alignItems: 'center',
                  borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                }}>
                  <Chip tone={e.kind === 'query' ? 'muted' : 'burn'} style={{ height: 17, fontSize: 9.5, flexShrink: 0 }}>{e.kind}</Chip>
                  <span className="mono" style={{ fontSize: 11.5, minWidth: 240 }}>{e.method}</span>
                  <span style={{ color: 'var(--fg-3)', flex: 1, minWidth: 180 }}>{e.note}</span>
                </div>
              ))}
            </div>
            <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
              Queries are free and work anonymously. Updates need any signed principal — burn voting
              additionally requires an NNS neuron that follows the community leader (the one human
              ceremony agents can't shortcut, by design).
            </span>
          </div>
        </>
      )}
    </div>
  );
}

// ==========================================
// Wallet — the user's token accounts plus native BTC/ETH on/off-ramps.
// ck-token balances live on the user's own principal across the five
// ledgers; native ramps talk to DFINITY's minters (mainnet only).
// ==========================================
function WalletSection({ actor, principal, identity, host, rootKey, ledgerCanisterId, isLocal }: {
  actor: Backend;
  principal: Principal;
  identity: unknown;
  host: string;
  rootKey?: Uint8Array;
  ledgerCanisterId: string;
  isLocal: boolean;
}) {
  const card: React.CSSProperties = {
    border: '1px solid var(--border)', borderRadius: 10,
    background: 'var(--surface)', padding: 16,
  };
  const inputStyle: React.CSSProperties = { fontFamily: 'var(--font-mono)', flex: 1 };
  const agentOpts = { host, identity: identity as Identity, rootKey };

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useErrorImpression(error, 'payouts');
  const [balances, setBalances] = useState<Record<string, bigint | null>>({});
  const [ledgers, setLedgers] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  // ICP deposits go to the ledger ACCOUNT ID (what exchanges ask for), not
  // the raw principal — fetched from the backend, which derives it.
  const [accountId, setAccountId] = useState<string | null>(null);

  // ── withdraw (on-IC transfer to any principal) ──
  const [wToken, setWToken] = useState<ExplorerToken>(ExplorerToken.ICP);
  const [wAmount, setWAmount] = useState('');
  const [wDest, setWDest] = useState('');

  // ── native BTC ramp ──
  const [btcAddress, setBtcAddress] = useState<string | null>(null);
  const [nAmount, setNAmount] = useState('');
  const [nDest, setNDest] = useState('');

  const copyText = (key: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };

  const run = async (label: string, fn: () => Promise<string | null>) => {
    if (busy) return;
    setBusy(label); setError(null); setNotice(null);
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const loadLedgers = async (): Promise<Record<string, string>> => {
    if (Object.keys(ledgers).length > 0) return ledgers;
    const info = await actor.get_explorer_info();
    const map: Record<string, string> = {
      ICP: ledgerCanisterId,
      CkBTC: info.ckbtc_ledger.toText(),
      CkETH: info.cketh_ledger.toText(),
      CkUSDC: info.ckusdc_ledger.toText(),
      CkUSDT: info.ckusdt_ledger.toText(),
    };
    setLedgers(map);
    return map;
  };

  const refreshBalances = async () => {
    try {
      const map = await loadLedgers();
      const next: Record<string, bigint | null> = {};
      await Promise.all(WALLET_TOKENS_META.map(async ({ token }) => {
        try {
          const l = createLedgerActor(map[token], { agentOptions: agentOpts });
          next[token] = await l.icrc1_balance_of({ owner: principal, subaccount: undefined });
        } catch { next[token] = null; }
      }));
      setBalances(next);
    } catch { /* transient */ }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      await refreshBalances();
      try {
        const id = await actor.get_account_id();
        if (!cancelled) setAccountId(id);
      } catch { /* transient */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor, principal]);

  const withdrawIc = () => run('w-ic', async () => {
    const meta = WALLET_TOKENS_META.find(t => t.token === wToken)!;
    const amount = parseUnits(wAmount, meta.decimals);
    if (!amount || amount <= 0n) { setError(`Enter a valid ${meta.label} amount.`); return null; }
    let dest: Principal;
    try { dest = Principal.fromText(wDest.trim()); }
    catch { setError('Destination is not a valid principal.'); return null; }
    const map = await loadLedgers();
    const l = createLedgerActor(map[wToken], { agentOptions: agentOpts });
    const res = await l.icrc1_transfer({ to: { owner: dest, subaccount: undefined }, amount });
    if (res.__kind__ === 'Err') {
      throw new Error(JSON.stringify(res.Err, (_k, v) => typeof v === 'bigint' ? v.toString() : v));
    }
    setWAmount('');
    await refreshBalances();
    return `${fmtUnits(amount, meta.decimals)} ${meta.label} sent to ${formatPrincipal(dest)}.`;
  });

  // ── native: BTC ──
  const getBtcAddress = () => run('btc-addr', async () => {
    const minter = makeCkbtcMinter(agentOpts);
    const addr: string = await minter.get_btc_address({ owner: [principal], subaccount: [] });
    setBtcAddress(addr);
    return null;
  });

  const checkBtcDeposit = () => run('btc-check', async () => {
    const minter = makeCkbtcMinter(agentOpts);
    try {
      const res = await minter.update_balance({ owner: [principal], subaccount: [] });
      if ('Ok' in res) {
        const minted = (res.Ok as Record<string, unknown>[]).filter(u => 'Minted' in u);
        await refreshBalances();
        return minted.length > 0
          ? `Minted ckBTC from ${minted.length} confirmed deposit(s) — balance updated.`
          : 'Deposits seen but still confirming — check again after more Bitcoin confirmations.';
      }
      const err = res.Err;
      if ('NoNewUtxos' in err) return 'No new BTC found yet — Bitcoin deposits need confirmations (typically ~1 hour).';
      throw new Error(JSON.stringify(err, (_k, v) => typeof v === 'bigint' ? v.toString() : v));
    } catch (e) {
      if (String(e).includes('NoNewUtxos')) return 'No new BTC found yet.';
      throw e;
    }
  });

  // ── native: BTC withdrawal (the only native off-ramp; ETH/USDC/USDT leave
  //    as their ck twins via the on-IC withdraw above) ──
  const withdrawBtc = () => run('n-withdraw', async () => {
    const map = await loadLedgers();
    const amount = parseUnits(nAmount, 8);
    if (!amount || amount <= 0n) { setError('Enter a valid BTC amount.'); return null; }
    const approver = makeApprover(map.CkBTC, agentOpts);
    await approver.icrc2_approve({
      from_subaccount: [], spender: { owner: Principal.fromText(CKBTC_MINTER_ID), subaccount: [] },
      amount: amount + 1000n, expected_allowance: [], expires_at: [], fee: [], memo: [], created_at_time: [],
    });
    const minter = makeCkbtcMinter(agentOpts);
    const res = await minter.retrieve_btc_with_approval({ address: nDest.trim(), amount, from_subaccount: [] });
    if ('Err' in res) throw new Error(JSON.stringify(res.Err, (_k, v) => typeof v === 'bigint' ? v.toString() : v));
    await refreshBalances();
    return `BTC withdrawal queued (block ${res.Ok.block_index}) — the minter batches retrievals to Bitcoin.`;
  });

  return (
    <>
      {(error || notice) && (
        <div className="row" style={{
          gap: 8, padding: '10px 12px', borderRadius: 8, fontSize: 12.5,
          border: `1px solid ${error ? 'var(--ember)' : 'var(--sprout)'}`,
          color: error ? 'var(--ember)' : 'var(--sprout-ink)', background: 'var(--surface)',
        }}>
          <Icon name={error ? 'x' : 'checkCircle'} size={13} stroke="currentColor" />
          <span style={{ overflowWrap: 'anywhere' }}>{error || notice}</span>
        </div>
      )}

      {/* Balances */}
      <div className="col" style={{ ...card, gap: 10 }}>
        <span className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
          <Eyebrow>Balances</Eyebrow>
          <Btn variant="ghost" sm onClick={refreshBalances} disabled={busy !== null}><Icon name="undo" size={12} /> Refresh</Btn>
        </span>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          {WALLET_TOKENS_META.map(({ token, label, decimals }) => (
            <div key={token} className="col" style={{ gap: 2, padding: '8px 14px', border: '1px solid var(--border)', borderRadius: 8, minWidth: 120 }}>
              <span style={{ fontSize: 10.5, color: 'var(--fg-3)', textTransform: 'uppercase' }}>{label}</span>
              <b className="mono" style={{ fontSize: 14 }}>
                {balances[token] !== undefined && balances[token] !== null ? fmtUnits(balances[token]!, decimals) : '…'}
              </b>
            </div>
          ))}
        </div>
      </div>

      {/* Deposit — first, above withdrawals */}
      <div className="col" style={{ ...card, gap: 12 }}>
        <Eyebrow>Deposit</Eyebrow>

        {/* ICP → account ID (what exchanges and wallets ask for) */}
        <div className="col" style={{ gap: 6 }}>
          <b style={{ fontSize: 13 }}>ICP — send to your account ID</b>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="mono" style={{ fontSize: 12, overflowWrap: 'anywhere', padding: '8px 10px', background: 'var(--bg-alt)', border: '1px solid var(--border)', borderRadius: 6, flex: '1 1 280px' }}>
              {accountId ?? '…'}
            </span>
            <button onClick={() => accountId && copyText('aid', accountId)}
              style={{ background: 'transparent', border: 'none', color: copied === 'aid' ? 'var(--sprout-ink)' : 'var(--fg-3)', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5 }}>
              <Icon name={copied === 'aid' ? 'check' : 'copy'} size={11} stroke="currentColor" /> {copied === 'aid' ? 'copied' : 'copy'}
            </button>
          </div>
        </div>

        {/* ck tokens → principal */}
        <div className="col" style={{ gap: 6, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <b style={{ fontSize: 13 }}>ckBTC / ckETH / ckUSDC / ckUSDT — send to your principal</b>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="mono" style={{ fontSize: 12, overflowWrap: 'anywhere', padding: '8px 10px', background: 'var(--bg-alt)', border: '1px solid var(--border)', borderRadius: 6, flex: '1 1 280px' }}>
              {principal.toString()}
            </span>
            <button onClick={() => copyText('pid', principal.toString())}
              style={{ background: 'transparent', border: 'none', color: copied === 'pid' ? 'var(--sprout-ink)' : 'var(--fg-3)', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5 }}>
              <Icon name={copied === 'pid' ? 'check' : 'copy'} size={11} stroke="currentColor" /> {copied === 'pid' ? 'copied' : 'copy'}
            </button>
          </div>
        </div>

        {/* Native BTC → ckBTC (mainnet only) */}
        {!isLocal && (
          <div className="col" style={{ gap: 8, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <b style={{ fontSize: 13 }}>Bitcoin — deposit real BTC, receive ckBTC</b>
            {btcAddress ? (
              <span className="mono" style={{ fontSize: 12, overflowWrap: 'anywhere', padding: '8px 10px', background: 'var(--bg-alt)', border: '1px solid var(--border)', borderRadius: 6 }}>
                {btcAddress}
              </span>
            ) : (
              <Btn variant="secondary" sm onClick={getBtcAddress} disabled={busy !== null} style={{ alignSelf: 'flex-start' }}>
                {busy === 'btc-addr' ? '…' : 'Get my BTC deposit address'}
              </Btn>
            )}
            {btcAddress && (
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <Btn variant="secondary" sm onClick={checkBtcDeposit} disabled={busy !== null}>
                  {busy === 'btc-check' ? 'Checking…' : 'I sent BTC — check for deposit'}
                </Btn>
                <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>Bitcoin needs ~1h of confirmations before minting.</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Withdraw */}
      <div className="col" style={{ ...card, gap: 12 }}>
        <Eyebrow>Withdraw</Eyebrow>
        <div className="col" style={{ gap: 8 }}>
          <b style={{ fontSize: 13 }}>To any Internet Computer principal</b>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {WALLET_TOKENS_META.map(({ token, label }) => (
              <Btn key={token} variant={wToken === token ? 'primary' : 'ghost'} sm onClick={() => setWToken(token)}>{label}</Btn>
            ))}
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <input type="text" placeholder="Amount" className="burn-input" style={{ ...inputStyle, maxWidth: 180 }}
              value={wAmount} onChange={e => setWAmount(e.target.value)} />
            <input type="text" placeholder="Destination principal" className="burn-input" style={{ ...inputStyle, minWidth: 260 }}
              value={wDest} onChange={e => setWDest(e.target.value)} />
            <Btn variant="primary" sm onClick={withdrawIc} disabled={busy !== null || !wAmount || !wDest}>
              {busy === 'w-ic' ? '…' : 'Withdraw'}
            </Btn>
          </div>
        </div>

        {/* Native BTC off-ramp (mainnet only) */}
        {!isLocal && (
          <div className="col" style={{ gap: 8, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <b style={{ fontSize: 13 }}>To a native Bitcoin address</b>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <input type="text" placeholder="Amount (BTC)" className="burn-input" style={{ ...inputStyle, maxWidth: 180 }}
                value={nAmount} onChange={e => setNAmount(e.target.value)} />
              <input type="text" placeholder="Bitcoin address" className="burn-input" style={{ ...inputStyle, minWidth: 260 }}
                value={nDest} onChange={e => setNDest(e.target.value)} />
              <Btn variant="primary" sm onClick={withdrawBtc} disabled={busy !== null || !nAmount || !nDest}>
                {busy === 'n-withdraw' ? '…' : 'Withdraw BTC'}
              </Btn>
            </div>
            <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
              Spends your ckBTC; the minter batches retrievals to Bitcoin. The flow asks the ledger
              for an approval first — two transactions total.
            </span>
          </div>
        )}
      </div>
    </>
  );
}
