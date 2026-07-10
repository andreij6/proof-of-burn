import { useState } from 'react';
import { Icon, Eyebrow, Chip, MoreInfo } from './ui';
// The single source of truth for the machine-readable guide — served as-is
// at /llms.txt and copied whole by the "Copy for your AI agent" button.
import llmsTxt from '../public/llms.txt?raw';

// ==========================================
// Developer docs — one page with one purpose: show another dapp's devs how
// to add the No-Loss Lottery to THEIR app by calling our backend canister
// directly. Static content, no actor needed; every code block is
// copy-paste-ready against the live mainnet interface.
// ==========================================

const BACKEND = 'k7dn6-qiaaa-aaaap-qutha-cai';
const LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';

const CANDID_SNIPPET = `// The integration surface (candid) — full .did via the canister's metadata.
type StakeTier = variant { SixMonths; OneYear; TwoYears };
type Result = variant { Ok; Err : text };
type BalanceResult = variant { Ok : nat64; Err : text };
type LedgerAccount = record { owner : principal; subaccount : opt blob };

service : {
  // Staking (calls are keyed to the CALLER's principal)
  get_stake_deposit_address : () -> (LedgerAccount) query;
  stake : (nat64, StakeTier) -> (Result);          // amount in e8s
  unstake : (nat64, StakeTier) -> (BalanceResult); // amount in e8s
  get_my_stake : () -> (UserStakeInfo) query;

  // Lottery state
  get_lottery_info : () -> (LotteryInfo) query;
  get_my_ticket_breakdown : () -> (vec TicketSourceRow) query;
  list_recent_winners : () -> (vec LotteryDraw) query;
}`;

const IDL_SNIPPET = `// Minimal agent-js IDL for the lottery integration (paste as idlFactory).
import { IDL } from '@dfinity/candid';

export const idlFactory = ({ IDL }) => {
  const StakeTier = IDL.Variant({ SixMonths: IDL.Null, OneYear: IDL.Null, TwoYears: IDL.Null });
  const Result = IDL.Variant({ Ok: IDL.Null, Err: IDL.Text });
  const BalanceResult = IDL.Variant({ Ok: IDL.Nat64, Err: IDL.Text });
  const LedgerAccount = IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) });
  const LotteryInfo = IDL.Record({
    enabled: IDL.Bool, pot_e8s: IDL.Nat64, next_draw_at: IDL.Nat64,
    min_pot_e8s: IDL.Nat64, min_unique_holders: IDL.Nat64,
    my_tickets: IDL.Nat64, my_daily_tickets: IDL.Nat64, eligible: IDL.Bool,
    total_tickets: IDL.Nat64, unique_holders: IDL.Nat64, round: IDL.Nat64,
    draws_held: IDL.Nat64, total_paid_e8s: IDL.Nat64, tickets_per_day: IDL.Nat64,
    odds_denominator: IDL.Nat64, claimed_today: IDL.Bool, admin_excluded: IDL.Bool,
    last_win_at: IDL.Opt(IDL.Nat64), last_winner: IDL.Opt(IDL.Principal),
  });
  return IDL.Service({
    get_stake_deposit_address: IDL.Func([], [LedgerAccount], ['query']),
    stake: IDL.Func([IDL.Nat64, StakeTier], [Result], []),
    unstake: IDL.Func([IDL.Nat64, StakeTier], [BalanceResult], []),
    get_lottery_info: IDL.Func([], [LotteryInfo], ['query']),
  });
};`;

const STAKE_SNIPPET = `import { HttpAgent, Actor } from '@dfinity/agent';
import { idlFactory } from './cycleBurn.idl';           // the IDL above
import { idlFactory as ledgerIdl } from './ledger.idl'; // any ICRC-1 ledger IDL

const BACKEND = '${BACKEND}';
const LEDGER  = '${LEDGER}';

// IMPORTANT: use YOUR USER's identity — stakes belong to the caller's
// principal. A backend proxy would own everything it stakes.
const agent = await HttpAgent.create({ identity: userIdentity, host: 'https://icp-api.io' });
const cycleBurn = Actor.createActor(idlFactory, { agent, canisterId: BACKEND });
const ledger = Actor.createActor(ledgerIdl, { agent, canisterId: LEDGER });

// 1. Where to deposit (a subaccount owned by the lottery canister).
const depositAccount = await cycleBurn.get_stake_deposit_address();

// 2. Transfer EXACTLY the stake amount (e8s). Fees are covered by the
//    protocol treasury — what you stake is what comes back.
const amount = 100_000_000n; // 1 ICP
await ledger.icrc1_transfer({
  to: { owner: depositAccount.owner, subaccount: depositAccount.subaccount },
  amount,
  fee: [], memo: [], from_subaccount: [], created_at_time: [],
});

// 3. Register the stake (6-month tier → 5 tickets/day per ICP).
const res = await cycleBurn.stake(amount, { SixMonths: null });
if ('Err' in res) throw new Error(res.Err);`;

const READ_SNIPPET = `// Anonymous callers get the public state (pot, countdown, totals).
// Authenticated callers ALSO get their own tickets & eligibility.
const info = await cycleBurn.get_lottery_info();

info.pot_e8s;          // current jackpot, e8s (÷ 1e8 for ICP)
info.next_draw_at;     // ns timestamp of the next drawing (0 = unscheduled)
info.my_tickets;       // caller's tickets this round
info.my_daily_tickets; // caller's daily grant (0 = not staked)
info.eligible;         // caller holds an active stake
info.min_pot_e8s;      // draw gate: pot must reach this
info.min_unique_holders; // draw gate: distinct players needed`;

const UNSTAKE_SNIPPET = `// Unstake any amount, any time — tickets void only if the LAST tier empties.
// Ok returns a pending-unstake id: the ICP pays out automatically once the
// tier's NNS neuron finishes dissolving (6mo / 1y / 2y term).
const out = await cycleBurn.unstake(100_000_000n, { SixMonths: null });
if ('Err' in out) throw new Error(out.Err);
const pendingUnstakeId = out.Ok;`;

function AgentCopyButton() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(llmsTxt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard denied */ }
  };
  return (
    <button onClick={copy} style={{
      alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 7,
      background: 'var(--burn)', border: 'none', borderRadius: 999, cursor: 'pointer',
      color: 'var(--char-950)', fontWeight: 700, fontSize: 13, padding: '10px 20px',
    }}>
      <Icon name={copied ? 'check' : 'copy'} size={13} stroke="var(--char-950)" />
      {copied ? 'Copied — paste it to your agent' : 'Copy docs for your AI agent'}
    </button>
  );
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard denied */ }
  };
  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <button
        onClick={copy}
        aria-label="Copy code"
        style={{
          position: 'absolute', top: 8, right: 8, zIndex: 1,
          background: 'var(--surface)', border: '1px solid var(--border-hi)', borderRadius: 6,
          color: copied ? 'var(--sprout-ink)' : 'var(--fg-2)', cursor: 'pointer',
          padding: '4px 10px', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 5,
        }}
      >
        <Icon name={copied ? 'check' : 'copy'} size={11} stroke="currentColor" /> {copied ? 'Copied' : 'Copy'}
      </button>
      <pre className="mono" style={{
        margin: 0, padding: '14px 16px', fontSize: 11.5, lineHeight: 1.6,
        background: 'var(--bg-alt)', border: '1px solid var(--border)', borderRadius: 10,
        overflowX: 'auto', color: 'var(--fg-1)', whiteSpace: 'pre',
      }}>{code}</pre>
    </div>
  );
}

export default function DevDocs() {
  const card: React.CSSProperties = {
    border: '1px solid var(--border)', borderRadius: 10,
    background: 'var(--surface)', padding: 16,
  };
  const h = (n: string, t: string) => (
    <span className="row" style={{ gap: 10, alignItems: 'baseline' }}>
      <span className="mono" style={{ fontSize: 13, color: 'var(--burn-ink)', fontWeight: 700 }}>{n}</span>
      <b style={{ fontSize: 15 }}>{t}</b>
    </span>
  );

  return (
    <div className="idea-board-container">
      {/* ── Header (lottery-page pattern: one row, one modal) ── */}
      <div className="col" style={{ gap: 6 }}>
        <span className="row" style={{ gap: 10, width: '100%', flexWrap: 'wrap' }}>
          <Icon name="edit" size={22} stroke="var(--burn-ink)" />
          <h4 style={{ margin: 0 }}>Developer Docs</h4>
          <Chip tone="muted"><span className="mono">mainnet</span></Chip>
          <MoreInfo
            title="Why embed the No-Loss Lottery"
            style={{
              marginLeft: 'auto', textDecoration: 'none', fontSize: 12.5, fontWeight: 600,
              border: '1px solid var(--burn)', borderRadius: 999, padding: '6px 14px',
              background: 'color-mix(in srgb, var(--burn) 10%, var(--surface))',
            }}
          >
            <div className="card col" style={{ gap: 8, borderColor: 'var(--burn)', background: 'color-mix(in srgb, var(--burn) 12%, var(--surface))' }}>
              <Eyebrow accent>The gist</Eyebrow>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
                <b>A lottery your users can't lose</b> — their ICP goes into pooled NNS
                neurons, the yield funds the jackpots, tickets are free and daily, and
                the principal always comes back. Your app gets the whole loop with four
                canister calls, no token, no bridge, no custody code.
              </p>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <Eyebrow accent>The trust model</Eyebrow>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                <li><b>Stakes are caller-keyed:</b> your user's principal owns the stake, the tickets, and any jackpot — your app is never in the money path.</li>
                <li><b>Winners are paid automatically</b> to their own wallet; nothing to claim, nothing for you to operate.</li>
                <li><b>Drawings run on-chain</b> three times a week once the pot ≥ 25 ICP and 25 unique players hold tickets.</li>
              </ul>
            </div>
          </MoreInfo>
        </span>
      </div>

      {/* ── Hand it to an agent ── */}
      <div className="col" style={{ border: '1px solid var(--burn)', borderRadius: 10, background: 'color-mix(in srgb, var(--burn) 10%, var(--surface))', padding: 16, gap: 8 }}>
        <Eyebrow accent>Building with an AI agent?</Eyebrow>
        <span style={{ fontSize: 12.5, color: 'var(--fg-1)', lineHeight: 1.5 }}>
          This entire guide fits in one prompt. Copy it below, or point your agent at{' '}
          <a href="/llms.txt" target="_blank" rel="noreferrer" className="mono" style={{ color: 'var(--burn-ink)' }}>/llms.txt</a>{' '}
          — it contains the interface, the idlFactory, all three flows, and the trust rules.
        </span>
        <AgentCopyButton />
      </div>

      {/* ── Essentials ── */}
      <div className="col" style={{ ...card, gap: 10 }}>
        <Eyebrow>Essentials</Eyebrow>
        <div className="col" style={{ gap: 6, fontSize: 12.5 }}>
          <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--fg-2)', minWidth: 130 }}>Lottery canister</span>
            <span className="mono" style={{ userSelect: 'all' }}>{BACKEND}</span>
          </span>
          <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--fg-2)', minWidth: 130 }}>ICP ledger</span>
            <span className="mono" style={{ userSelect: 'all' }}>{LEDGER}</span>
          </span>
          <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--fg-2)', minWidth: 130 }}>Units</span>
            <span>all amounts are <b>e8s</b> (1 ICP = 100,000,000)</span>
          </span>
          <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--fg-2)', minWidth: 130 }}>Identity</span>
            <span>every call is keyed to the <b>caller's principal</b> — call with your user's identity, never a proxy</span>
          </span>
        </div>
      </div>

      {/* ── Interface ── */}
      <div className="col" style={{ ...card, gap: 10 }}>
        {h('01', 'The interface')}
        <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
          Seven methods cover the whole integration. Queries are free and fast; the
          two update calls (<span className="mono">stake</span>, <span className="mono">unstake</span>) go through consensus.
        </span>
        <CodeBlock code={CANDID_SNIPPET} />
        <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
          Ready-made <span className="mono">idlFactory</span> for agent-js:
        </span>
        <CodeBlock code={IDL_SNIPPET} />
      </div>

      {/* ── Stake ── */}
      <div className="col" style={{ ...card, gap: 10 }}>
        {h('02', 'Stake — three calls, tickets start same day')}
        <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
          Deposit address → exact-amount transfer → <span className="mono">stake</span>. Tiers:{' '}
          <span className="mono">SixMonths</span> (5 tickets/ICP/day), <span className="mono">OneYear</span> (10),{' '}
          <span className="mono">TwoYears</span> (20). Minimum first stake per tier: 1 ICP.
        </span>
        <CodeBlock code={STAKE_SNIPPET} />
      </div>

      {/* ── Read ── */}
      <div className="col" style={{ ...card, gap: 10 }}>
        {h('03', 'Read the lottery — one query for your whole UI')}
        <CodeBlock code={READ_SNIPPET} />
        <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
          <span className="mono">get_my_stake()</span> returns the caller's per-tier positions;{' '}
          <span className="mono">get_my_ticket_breakdown()</span> itemizes where this round's tickets came
          from; <span className="mono">list_recent_winners()</span> feeds a winners feed.
        </span>
      </div>

      {/* ── Unstake ── */}
      <div className="col" style={{ ...card, gap: 10 }}>
        {h('04', 'Unstake — the exit is always open')}
        <CodeBlock code={UNSTAKE_SNIPPET} />
      </div>

      {/* ── Rules ── */}
      <div className="col" style={{ ...card, gap: 8 }}>
        {h('05', 'Rules your UI should reflect')}
        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12.5, lineHeight: 1.55, color: 'var(--fg-1)' }}>
          <li><b>Tickets are stakers-only</b> and land automatically every day, server-side — your users never need to visit anyone's app to earn.</li>
          <li><b>Full unstake voids tickets instantly</b> — partial unstake keeps the rest earning.</li>
          <li><b>The transfer must land before <span className="mono">stake()</span></b> — send exactly the amount you pass to <span className="mono">stake</span>; the treasury covers ledger fees.</li>
          <li><b>Drawings pay winners directly</b> — 65% to the winner, 30% seeds the next pot, 5% burns to cycles. Your app never touches prize money.</li>
          <li><b>Questions?</b> Find us on OpenChat or X (links in the footer of the landing page).</li>
        </ul>
      </div>
    </div>
  );
}
