import { useState } from 'react';
import { Icon, Eyebrow, MoreInfo } from './ui';
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
type StakeTier = variant { TwoWeeks; SixMonths; OneYear; TwoYears };
type Result = variant { Ok; Err : text };
type BalanceResult = variant { Ok : nat64; Err : text };
type LedgerAccount = record { owner : principal; subaccount : opt blob };

service : {
  // Staking (calls are keyed to the CALLER's principal)
  get_stake_deposit_address : () -> (LedgerAccount) query;
  stake : (nat64, StakeTier) -> (Result);           // amount in e8s
  redeem_stake_bond : (nat64) -> (BalanceResult);   // the exit (bond id)
  get_my_stake : () -> (UserStakeInfo) query;

  // Lottery state
  get_lottery_info : () -> (LotteryInfo) query;
  get_my_ticket_breakdown : () -> (vec TicketSourceRow) query;
  list_recent_winners : () -> (vec LotteryDraw) query;
}`;

const IDL_SNIPPET = `// Minimal agent-js IDL for the lottery integration (paste as idlFactory).
import { IDL } from '@dfinity/candid';

export const idlFactory = ({ IDL }) => {
  const StakeTier = IDL.Variant({ TwoWeeks: IDL.Null, SixMonths: IDL.Null, OneYear: IDL.Null, TwoYears: IDL.Null });
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
    redeem_stake_bond: IDL.Func([IDL.Nat64], [BalanceResult], []),
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

// 3. Register the stake (6-month tier → 5 tickets/day per ICP;
//    TwoWeeks = 1, OneYear = 10, TwoYears = 20).
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

const UNSTAKE_SNIPPET = `// Exits are BOND-NATIVE: staking auto-issued a Stake Bond — the bond IS
// the stake, and redeeming it is the ONLY way out (never flag-gated).
const m = await cycleBurn.get_bond_market();
const bond = m.my_bonds[0];

// 100% after the tier's dissolve — pays the owner automatically:
const out = await cycleBurn.redeem_stake_bond(bond.id);
if ('Err' in out) throw new Error(out.Err);

// or instant 85% (refuses with BUYBACK_UNAVAILABLE when the fund is short):
// await cycleBurn.buyback_bond(bond.id);
// or list it at your price: await cycleBurn.list_bond(bond.id, askE8s);`;

const VOUCHER_CANDID_SNIPPET = `// Stake Bonds — an NFT claim on a staked position. Tickets follow the
// bond's CURRENT owner; buying one makes the buyer a staker. (The API keeps
type BondClass = variant { Backed; Promo };
type BondView = record {
  id : nat64; class : BondClass; tier : StakeTier; amount_e8s : nat64;
  owner : principal; minted_at : nat64; expires_at : opt nat64;
  listed_price_e8s : opt nat64;
};

service additions : {
  wrap_stake_bond : (nat64, StakeTier) -> (variant { Ok : nat64; Err : text });
  unwrap_stake_bond : (nat64) -> (variant { Ok; Err : text });
  list_bond : (nat64, nat64) -> (variant { Ok; Err : text });      // (id, ask e8s)
  cancel_bond_listing : (nat64) -> (variant { Ok; Err : text });
  get_bond_sale_account : (nat64) -> (LedgerAccount) query;        // buyer escrow
  buy_bond : (nat64) -> (variant { Ok; Err : text });
  buyback_bond : (nat64) -> (variant { Ok : nat64; Err : text });  // Ok = e8s paid
  redeem_stake_bond : (nat64) -> (BalanceResult);                  // burn -> dissolve -> 100%
  transfer_bond : (nat64, principal) -> (variant { Ok; Err : text }); // send to another wallet
  claim_golden_ticket : (opt principal) -> (variant { Ok : nat64; Err : text });
  get_bond_market : () -> (BondMarketInfo) query;
}`;

const VOUCHER_FLOW_SNIPPET = `// Instant exit (house buyback): 85% now instead of 100% after dissolve.
// The 15% discount is an express-exit FEE — principal is never at risk on
// the classic path (redeem_stake_bond → 100% after the dissolve).
const id = (await cycleBurn.wrap_stake_bond(100_000_000n, { SixMonths: null })).Ok;

const market = await cycleBurn.get_bond_market();
const quote = 100_000_000n * BigInt(10_000 - market.buyback_discount_bps) / 10_000n;
if (market.buyback_fund_e8s >= quote) {           // balance-gated: refuses when
  const paid = await cycleBurn.buyback_bond(id); // the fund can't cover it
}

// Marketplace (asks in ICP only): escrow the EXACT ask, then settle.
await cycleBurn.list_bond(id, 90_000_000n);      // seller lists at 0.9 ICP
const escrow = await cycleBurn.get_bond_sale_account(id);
await ledger.icrc1_transfer({ to: escrow, amount: 90_000_000n, fee: [], memo: [], from_subaccount: [], created_at_time: [] });
await cycleBurn.buy_bond(id);                    // buyer becomes the staker

// Golden Ticket claim (promo class — tickets ONLY, 1/day for 60 days):
// null → mints to the caller; a principal → mints to that wallet and works
// ANONYMOUSLY (paste-a-wallet flow on /#/claim). Golden Tickets can never
// redeem ICP, never sell, never buy back — they only earn tickets.
await cycleBurn.claim_golden_ticket(null);`;

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

      {/* ── The gist — the whole page in one card ── */}
      <div className="card col" style={{ gap: 8, borderColor: 'var(--burn)', background: 'color-mix(in srgb, var(--burn) 12%, var(--surface))' }}>
        <Eyebrow accent>The gist</Eyebrow>
        <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
          <b>Add a lottery your users can't lose to your dapp</b> — a handful of calls
          against our backend canister, no token, no bridge, no custody code.
        </p>
        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
          <li><b>Stake:</b> <span className="mono">get_stake_deposit_address</span> → exact-amount ICP transfer → <span className="mono">stake</span>. Staking mints a <b>Stake Bond NFT</b> (the bond IS the stake) and free tickets land daily, server-side.</li>
          <li><b>Read:</b> <span className="mono">get_lottery_info</span> drives your whole UI — pot, countdown, the caller's tickets and eligibility.</li>
          <li><b>Exit (bond-native, never gated):</b> <span className="mono">redeem_stake_bond</span> pays 100% after the tier's dissolve — or take the instant 85% buyback, or sell the bond at your price.</li>
          <li><b>Caller-keyed:</b> every call runs with your <i>user's</i> identity — their principal owns the stake, the tickets, and any jackpot; your app never touches the money path.</li>
        </ul>
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
          two update calls (<span className="mono">stake</span>, <span className="mono">redeem_stake_bond</span>) go through consensus.
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
          <span className="mono">TwoWeeks</span> (1 ticket/ICP/day), <span className="mono">SixMonths</span> (5),{' '}
          <span className="mono">OneYear</span> (10), <span className="mono">TwoYears</span> (20). Minimum first stake per tier: 1 ICP.
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

      {/* ── Exit ── */}
      <div className="col" style={{ ...card, gap: 10 }}>
        {h('04', 'Exit — always open, and bond-native')}
        <CodeBlock code={UNSTAKE_SNIPPET} />
      </div>

      {/* ── Stake Bonds ── */}
      <div className="col" style={{ ...card, gap: 10 }}>
        {h('05', 'Stake Bonds — exit liquidity your app can offer')}
        <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
          A Stake Bond is the stake as a transferable NFT: sell it on the ICP
          marketplace, take the instant house buyback at <b>85% of principal</b>{' '}
          (the 15% discount is an express-exit fee, balance-gated by the buyback
          fund), or redeem for 100% after the dissolve. Holders can also{' '}
          <b>transfer_bond</b> it to another wallet's principal (the ticket
          stream follows). A bond <b>listed for sale earns no tickets until
          delisted</b>. Same identity rule as
          everything else: <b>every call is keyed to the caller's principal</b>{' '}
          — integrate with your user's identity, never a proxy.
        </span>
        <CodeBlock code={VOUCHER_CANDID_SNIPPET} />
        <CodeBlock code={VOUCHER_FLOW_SNIPPET} />
        <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
          Golden Tickets (the promo class) are tickets-only: 1 ticket/day for 60
          days, soulbound, never redeemable — both money paths reject them at
          the endpoint level. Bond actions (wrap/list/buyback) currently require
          signing in with Internet Identity on our app; the promo claim's
          paste-a-principal path is the exception (works anonymously).
        </span>
      </div>

      {/* ── Rules ── */}
      <div className="col" style={{ ...card, gap: 8 }}>
        {h('06', 'Rules your UI should reflect')}
        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12.5, lineHeight: 1.55, color: 'var(--fg-1)' }}>
          <li><b>Tickets need a position, not a visit:</b> staked ICP (a Stake Bond) or a custodied LP position both qualify, and tickets land automatically every day, server-side — your users never need to visit anyone's app to earn.</li>
          <li><b>Exits never void tickets</b> — already-earned tickets ride until the next drawing; the daily grant simply stops once the last position is gone.</li>
          <li><b>The transfer must land before <span className="mono">stake()</span></b> — send exactly the amount you pass to <span className="mono">stake</span>; the treasury covers ledger fees.</li>
          <li><b>Drawings pay winners directly</b> — 65% to the winner, 30% seeds the next pot, 5% burns to cycles. Your app never touches prize money.</li>
          <li><b>Questions?</b> Find us on OpenChat or X (links in the footer of the landing page).</li>
        </ul>
      </div>
    </div>
  );
}
