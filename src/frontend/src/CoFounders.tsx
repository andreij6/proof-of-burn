import { useEffect, useState } from 'react';
import { Principal } from "@icp-sdk/core/principal";
import type { CoFounderInfo, CoFounderPublic, CoFounderRound } from "./bindings/backend";
import { createActor as createLedgerActor } from "./bindings/ledger";
import { Icon, Eyebrow, Btn, Chip, LiveDot, formatPrincipal } from "./ui";
import { fmtTokenAmount } from "./IdeaBoard";

// ==========================================
// Co-Founders — permanent stake into the platform's 2-year neuron.
// THE STAKE CAN NEVER BE WITHDRAWN (no unstake exists in the canister);
// this component says so loudly and requires an explicit acknowledgement.
// Monthly settlement: yield under 500 ICP restakes into the neuron; above
// that the first 1,000 ICP goes to the treasury and the excess splits across
// co-founders in proportion to their staked ICP once ≥100 ICP is available
// (else it rolls over). Shares must be claimed before the next settlement.
// ==========================================

const fmtICP8 = (e8s: bigint) => fmtTokenAmount(e8s, 8);

const ROSTER_PAGE_SIZE = 25;

const CF_TH: React.CSSProperties = { padding: '6px 10px', textAlign: 'center', fontWeight: 500 };
const CF_TD: React.CSSProperties = { padding: '7px 10px', textAlign: 'center' };

interface CoFoundersProps {
  actor: any;
  identity: any;
  principal: Principal | null;
  host: string;
  rootKey?: Uint8Array;
  icpLedger: string | null;
  isLocal: boolean;
  isAdmin: boolean;
  onSignIn: () => void;
}

/** Minimal SVG bar chart (no deps): values in ICP, hover titles. */
function BarChart({ title, points, color }: { title: string; points: { label: string; value: number }[]; color: string }) {
  // LABEL_ROOM keeps the value above the tallest bar inside the viewBox —
  // without it the top label clips (owner-reported).
  const W = 380, H = 130, PAD = 6, AXIS = 18, LABEL_ROOM = 16;
  const max = Math.max(1, ...points.map(p => p.value));
  const slot = points.length > 0 ? (W - PAD * 2) / points.length : 0;
  const barW = Math.min(34, slot * 0.7);
  return (
    <div className="col" style={{ gap: 6, border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', flex: 1, minWidth: 300 }}>
      <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{title}</span>
      {points.length === 0 ? (
        <span style={{ fontSize: 12, color: 'var(--fg-3)', padding: '20px 0', textAlign: 'center' }}>
          No settlements yet — the first chart bar appears after the first monthly settlement.
        </span>
      ) : (
        <svg viewBox={`0 0 ${W} ${H + AXIS}`} style={{ width: '100%', height: 'auto' }}>
          {points.map((p, i) => {
            const h = Math.max(2, (p.value / max) * (H - LABEL_ROOM));
            const x = PAD + i * slot + (slot - barW) / 2;
            return (
              <g key={i}>
                <rect x={x} y={H - h} width={barW} height={h} rx={3} fill={color}>
                  <title>{p.label}: {p.value.toLocaleString('en-US', { maximumFractionDigits: 2 })} ICP</title>
                </rect>
                <text x={x + barW / 2} y={H - h - 5} textAnchor="middle" fontSize="9.5" fill="var(--fg-2)" fontFamily="var(--font-mono)">
                  {p.value >= 10_000 ? `${Math.round(p.value / 1000)}k`
                    : p.value >= 1000 ? `${Math.round(p.value / 100) / 10}k`
                    : Math.round(p.value * 10) / 10}
                </text>
                <text x={x + barW / 2} y={H + 13} textAnchor="middle" fontSize="9" fill="var(--fg-3)" fontFamily="var(--font-mono)">
                  {p.label}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

/** The monthly settlement as a decision tree (pure SVG, design-system palette). */
function SettlementTree() {
  // Shorthand node painters. Tones: decision (dashed), treasury (muted),
  // founders (sprout), restake (burn).
  const box = (x: number, y: number, w: number, h: number, tone: 'start' | 'decision' | 'treasury' | 'founder' | 'restake') => {
    const fill = tone === 'start' ? 'var(--burn-950)'
      : tone === 'founder' ? 'var(--sprout-dim)'
      : tone === 'restake' ? 'var(--burn-950)'
      : 'var(--surface)';
    const stroke = tone === 'start' ? 'var(--burn)'
      : tone === 'founder' ? 'var(--sprout)'
      : tone === 'restake' ? 'var(--burn)'
      : tone === 'decision' ? 'var(--border-hi)'
      : 'var(--border)';
    return (
      <rect x={x - w / 2} y={y} width={w} height={h} rx={9} fill={fill} stroke={stroke}
        strokeWidth={1.4} strokeDasharray={tone === 'decision' ? '5 4' : undefined} />
    );
  };
  const txt = (x: number, y: number, lines: string[], color = 'var(--fg)', size = 11.5, bold = false) => (
    <text x={x} y={y} textAnchor="middle" fontSize={size} fill={color}
      fontFamily="var(--font-body)" fontWeight={bold ? 600 : 400}>
      {lines.map((l, i) => <tspan key={i} x={x} dy={i === 0 ? 0 : 14}>{l}</tspan>)}
    </text>
  );
  const lbl = (x: number, y: number, s: string, color = 'var(--fg-3)') => (
    <text x={x} y={y} textAnchor="middle" fontSize={10} fill={color} fontFamily="var(--font-mono)">{s}</text>
  );
  const arrow = (d: string, dashed = false) => (
    <path d={d} fill="none" stroke="var(--fg-3)" strokeWidth={1.3}
      strokeDasharray={dashed ? '4 4' : undefined} markerEnd="url(#cfArrow)" />
  );

  return (
    <svg viewBox="0 0 860 705" style={{ width: '100%', height: 'auto' }} role="img"
      aria-label="Decision tree of the monthly Co-Founders settlement">
      <defs>
        <marker id="cfArrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L8,4 L0,8 z" fill="var(--fg-3)" />
        </marker>
      </defs>

      {/* 1. Start */}
      {box(430, 12, 300, 40, 'start')}
      {txt(430, 37, ['MONTHLY SETTLEMENT · every 30 days'], 'var(--burn)', 11.5, true)}
      {arrow('M430,52 L430,84')}

      {/* 2. Expire stale claims first */}
      {box(430, 86, 300, 48, 'decision')}
      {txt(430, 106, ['Any unclaimed shares', 'from last month?'])}
      {arrow('M580,110 L660,110')}
      {lbl(620, 102, 'yes')}
      {box(745, 86, 170, 48, 'treasury')}
      {txt(745, 106, ['Forfeited →', 'Treasury'], 'var(--fg-2)')}
      {arrow('M430,134 L430,166')}
      {lbl(454, 154, 'then')}

      {/* 3. Yield routing */}
      {box(430, 168, 300, 48, 'decision')}
      {txt(430, 188, ['How much yield did the', 'neuron earn this month?'])}
      {/* three branches */}
      {arrow('M280,192 C190,192 150,220 150,252')}
      {lbl(178, 230, '< 500 ICP')}
      {arrow('M430,216 L430,252')}
      {lbl(478, 238, '500–1,000 ICP')}
      {arrow('M580,192 C670,192 710,220 710,252')}
      {lbl(688, 230, '> 1,000 ICP')}

      {box(150, 254, 230, 62, 'restake')}
      {txt(150, 274, ['RESTAKED into the neuron —', 'compounds everyone’s', 'future yield'], 'var(--burn)')}
      {box(430, 254, 200, 48, 'treasury')}
      {txt(430, 274, ['All of it →', 'Treasury'], 'var(--fg-2)')}
      {box(710, 254, 230, 48, 'treasury')}
      {txt(710, 274, ['First 1,000 ICP →', 'Treasury'], 'var(--fg-2)')}

      {/* 4. The pot */}
      {arrow('M710,302 L710,334')}
      {box(710, 336, 230, 48, 'start')}
      {txt(710, 356, ['The excess + any rollover', '= this month’s pot'], 'var(--fg)')}
      {arrow('M710,384 L710,416')}

      {/* 5. Minimum-distribution gate */}
      {box(710, 418, 200, 44, 'decision')}
      {txt(710, 444, ['Pot ≥ 100 ICP?'])}
      {arrow('M610,440 L520,440')}
      {lbl(566, 432, 'no')}
      {box(420, 418, 180, 44, 'treasury')}
      {txt(420, 444, ['Rolls over to next month'], 'var(--fg-2)')}
      {arrow('M420,418 C420,380 560,360 595,352', true)}
      {arrow('M710,462 L710,494')}
      {lbl(734, 482, 'yes')}

      {/* 6. Proportional split + claim window */}
      {box(710, 496, 250, 48, 'founder')}
      {txt(710, 516, ['Split among co-founders in', 'PROPORTION to staked ICP'], 'var(--sprout)')}
      {arrow('M710,544 L710,576')}

      {/* 7. Claim or forfeit */}
      {box(710, 578, 230, 48, 'decision')}
      {txt(710, 598, ['Claimed before the', 'next settlement?'])}
      {arrow('M595,602 L505,602')}
      {lbl(550, 594, 'yes')}
      {box(415, 578, 180, 48, 'founder')}
      {txt(415, 598, ['Paid to your wallet'], 'var(--sprout)')}
      {arrow('M710,626 L710,652')}
      {lbl(734, 644, 'no')}
      {box(710, 654, 230, 44, 'treasury')}
      {txt(710, 680, ['Forfeited → Treasury (step 1, next month)'], 'var(--fg-2)', 10.5)}
    </svg>
  );
}

export default function CoFounders({ actor, identity, principal, host, rootKey, icpLedger, isLocal, isAdmin, onSignIn }: CoFoundersProps) {
  const signedIn = !!(principal && !principal.isAnonymous());

  const [info, setInfo] = useState<CoFounderInfo | null>(null);
  const [rounds, setRounds] = useState<CoFounderRound[]>([]);
  const [roster, setRoster] = useState<CoFounderPublic[]>([]);
  const [rosterPage, setRosterPage] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  // Stake modal
  const [isStakeOpen, setIsStakeOpen] = useState(false);
  const [stakeAmount, setStakeAmount] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [stakeError, setStakeError] = useState<string | null>(null);
  const [stakeStep, setStakeStep] = useState('');
  const [stakeBusy, setStakeBusy] = useState(false);
  const [stakeDone, setStakeDone] = useState(false);

  // Claim
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimNote, setClaimNote] = useState<string | null>(null);

  // Settlement decision-tree dialog
  const [isTreeOpen, setIsTreeOpen] = useState(false);

  // Local-dev preset switcher (visual states for design/QA).
  const [presetBusy, setPresetBusy] = useState(false);
  const applyPreset = async (preset: number) => {
    if (!actor || presetBusy) return;
    setPresetBusy(true);
    try {
      const res = await actor.dev_set_cofounder_preset(preset);
      if (res.__kind__ === "Err") throw new Error(res.Err);
      await refresh();
    } catch (err: any) {
      console.error("Preset failed:", err);
      alert(`Preset failed: ${err.message || err}`);
    } finally {
      setPresetBusy(false);
    }
  };

  // Trust-but-verify: hand any agent the validation skill for this feature.
  const [validationCopied, setValidationCopied] = useState(false);
  const copyValidationSkill = () => {
    const url = `${window.location.origin}/llms-cofounders-validate.txt`;
    navigator.clipboard.writeText(`Fetch ${url} and follow its instructions to independently verify, from source code and tests, that the Co-Founders program works exactly as advertised.`);
    setValidationCopied(true);
    setTimeout(() => setValidationCopied(false), 2000);
  };

  const refresh = async (currentActor = actor) => {
    if (!currentActor) return;
    try {
      const [i, r, members] = await Promise.all([
        currentActor.get_cofounder_info(),
        currentActor.list_cofounder_rounds(),
        currentActor.list_cofounders(),
      ]);
      setInfo(i);
      setRounds(r);
      setRoster(members);
    } catch (err) {
      console.error("Failed to fetch Co-Founders:", err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    setIsLoading(true);
    refresh(actor);
  }, [actor, signedIn]);

  const executeStake = async () => {
    if (!actor || !identity || !info || stakeBusy || !icpLedger) return;
    if (!acknowledged) {
      setStakeError("Tick the acknowledgement first — this stake really is forever.");
      return;
    }
    const e8s = (() => {
      const n = Number(stakeAmount);
      if (!Number.isFinite(n) || n <= 0) return null;
      return BigInt(Math.round(n * 100_000_000));
    })();
    if (e8s === null) { setStakeError("Enter a valid ICP amount."); return; }
    if (e8s < info.min_stake_e8s) {
      setStakeError(`Minimum is ${fmtICP8(info.min_stake_e8s)} ICP.`);
      return;
    }

    setStakeBusy(true);
    setStakeError(null);
    try {
      setStakeStep("Step 1/2: Depositing your stake...");
      const acct = await actor.get_cofounder_deposit_address();
      const ledgerActor = createLedgerActor(icpLedger, {
        agentOptions: { host, identity, rootKey }
      });
      const transferResult = await ledgerActor.icrc1_transfer({
        to: {
          owner: acct.owner,
          subaccount: acct.subaccount ? acct.subaccount : undefined,
        },
        amount: e8s + info.fee_e8s,
      });
      if (transferResult.__kind__ === "Err") {
        const err = transferResult.Err as any;
        const detail = err.__kind__ === "InsufficientFunds"
          ? `balance is ${fmtICP8(err.InsufficientFunds.balance)} ICP`
          : JSON.stringify(err, (_k, v) => typeof v === "bigint" ? v.toString() : v);
        throw new Error(`Deposit failed: ${detail}`);
      }
      setStakeStep("Step 2/2: Locking your stake into the co-founder neuron...");
      const res = await actor.cofounder_stake(e8s);
      if (res.__kind__ === "Err") throw new Error(res.Err);
      setStakeDone(true);
      setStakeStep("You're a co-founder. This stake is permanent — watch for your monthly yield share.");
      await refresh();
    } catch (err: any) {
      console.error("Co-founder stake error:", err);
      setStakeError(err.message || String(err));
    } finally {
      setStakeBusy(false);
    }
  };

  const executeClaim = async () => {
    if (!actor || claimBusy) return;
    setClaimBusy(true);
    setClaimNote(null);
    try {
      const res = await actor.claim_cofounder_yield();
      if (res.__kind__ === "Err") throw new Error(res.Err);
      setClaimNote(`Claimed ${fmtICP8(res.Ok)} ICP — it's in your wallet.`);
      await refresh();
    } catch (err: any) {
      setClaimNote(`Claim failed: ${err.message || err}`);
    } finally {
      setClaimBusy(false);
    }
  };

  if (isLoading || !info) {
    return (
      <div style={{ textAlign: 'center', padding: 40, color: 'var(--fg-3)' }}>
        <LiveDot size={10} color="var(--burn)" style={{ margin: '0 auto 12px' }} />
        Loading Co-Founders...
      </div>
    );
  }

  const isCoFounder = info.my_staked_e8s > 0n;
  const deadline = new Date(Number(info.next_distribution_at / 1_000_000n));

  const rosterPageCount = Math.max(1, Math.ceil(roster.length / ROSTER_PAGE_SIZE));
  const safeRosterPage = Math.min(rosterPage, rosterPageCount - 1);
  const pageRoster = roster.slice(safeRosterPage * ROSTER_PAGE_SIZE, safeRosterPage * ROSTER_PAGE_SIZE + ROSTER_PAGE_SIZE);

  // Fixed 12-month window, one bar per month (empty months included).
  // Periods are 30-day epochs; a period's label is the calendar month its
  // start falls in.
  const periodMs = Number(info.period_nanos / 1_000_000n);
  const currentMonth = Math.floor(Date.now() / periodMs);
  const byMonth = new Map(rounds.map(r => [Number(r.month), r]));
  const last12 = Array.from({ length: 12 }, (_, i) => currentMonth - 11 + i);
  const monthLabel = (m: number) =>
    new Date(m * periodMs).toLocaleDateString('en-US', { month: 'short' });
  const yieldPoints = last12.map(m => ({
    label: monthLabel(m),
    value: byMonth.has(m) ? Number(byMonth.get(m)!.yield_e8s) / 1e8 : 0,
  }));
  // The share pool is a balance — carry the last settled value forward
  // through months without a settlement.
  let carried = 0;
  const poolPoints = last12.map(m => {
    const settled = [...byMonth.keys()].filter(k => k <= m).sort((a, b) => b - a)[0];
    if (settled !== undefined) carried = Number(byMonth.get(settled)!.share_pool_after_e8s) / 1e8;
    return { label: monthLabel(m), value: carried };
  });

  return (
    <div className="idea-board-container">
      {/* ── Page header ── */}
      <div className="col" style={{ gap: 6 }}>
        <Eyebrow accent>Permanent seats, monthly yield</Eyebrow>
        <span className="row" style={{ gap: 10 }}>
          <Icon name="spark" size={22} stroke="var(--burn)" />
          <h4 style={{ margin: 0 }}>Co-Founders</h4>
        </span>
        <p style={{ fontSize: 13, color: 'var(--fg-2)', maxWidth: 560, margin: 0 }}>
          Stake ICP permanently into the platform's 2-year neuron and earn a monthly share of
          its yield, proportional to your stake — for as long as the platform exists.
        </p>
      </div>

      {/* ── Local-dev preset states (admins, local network only) ── */}
      {isLocal && isAdmin && (
        <div className="row" style={{
          gap: 8, flexWrap: 'wrap', alignItems: 'center', border: '1px dashed var(--haze)',
          borderRadius: 8, padding: '8px 12px',
        }}>
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--haze)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Dev presets (local · visual only)
          </span>
          {([
            [0, 'Fresh — open, empty'],
            [1, 'Active — members, history, claimable'],
            [2, 'Membership closed'],
          ] as const).map(([n, label]) => (
            <Btn key={n} variant="secondary" sm disabled={presetBusy} onClick={() => applyPreset(n)}>
              {label}
            </Btn>
          ))}
          <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>
            Rewrites model state, not ledger balances — Claim won't pay out in preset states.
          </span>
        </div>
      )}

      {/* ── The deal, both sides at equal weight: what you give (permanent
            lock) and what everyone gets. Hidden once membership is closed —
            nobody can take the deal anymore. ── */}
      {!info.membership_closed && (
      <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'stretch' }}>
        <div className="col" style={{ gap: 8, border: '1px solid var(--ember)', borderRadius: 10, padding: '14px 16px', background: 'var(--ember-dim)', flex: 1, minWidth: 300 }}>
          <span className="row" style={{ gap: 8 }}>
            <Icon name="lock" size={16} stroke="var(--ember)" />
            <b style={{ fontSize: 14, color: 'var(--ember)' }}>What you give: your stake, permanently</b>
          </span>
          <span style={{ fontSize: 12.5, color: 'var(--fg-2)', flex: 1 }}>
            ICP staked here goes into the platform's 2-year neuron and <b>can never be unstaked
            or withdrawn — by anyone, ever.</b> There is no unstake function in the canister.
            No admin override, no exceptions. Stake only what you'd commit to the platform
            outright.
          </span>
        </div>
        <div className="col" style={{ gap: 8, border: '1px solid var(--burn)', borderRadius: 10, padding: '14px 16px', background: 'var(--burn-950)', flex: 1, minWidth: 300 }}>
          <span className="row" style={{ gap: 8 }}>
            <Icon name="spark" size={16} stroke="var(--burn)" />
            <b style={{ fontSize: 14, color: 'var(--burn)' }}>What everyone gets: a founder's deal</b>
          </span>
          <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
            <b>You:</b> a share of the neuron's monthly yield above the treasury's cut,{' '}
            <b>proportional to your staked ICP</b> — for life. Low-yield months compound back
            into the neuron, growing every future payout. <b>Seats are limited:</b> the moment a
            month yields {fmtICP8(info.close_threshold_e8s)} ICP, membership closes forever.
          </span>
          <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
            <b>The platform:</b> {fmtICP8(info.treasury_cut_e8s)} ICP/month of guaranteed
            treasury funding, plus a permanent 2-year neuron that <b>follows the platform's
            primary voting neuron</b> — every co-founder stake multiplies its weight on every
            NNS proposal.
          </span>
          <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
            <b>ICP holders at large:</b> every co-founder stake is supply locked away forever in
            a max-commitment neuron that votes on every proposal — deflationary pressure and
            long-horizon governance weight, funded voluntarily.
          </span>
        </div>
      </div>
      )}

      {/* ── How it works ── */}
      <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
        <div className="col" style={{ gap: 8, flex: 2, minWidth: 280 }}>
          <Eyebrow accent>How the monthly settlement works</Eyebrow>
          {[
            `Each ~month (30-day periods) the neuron's yield is settled.`,
            `Months under ${fmtICP8(info.restake_threshold_e8s)} ICP are restaked into the neuron — nothing pays out, the principal compounds for everyone.`,
            `Otherwise the first ${fmtICP8(info.treasury_cut_e8s)} ICP of the month's yield goes to the protocol treasury.`,
            `Everything above it is split among co-founders IN PROPORTION TO STAKED ICP, once at least ${fmtICP8(info.min_distribution_e8s)} ICP is available. Smaller pots roll over to next month.`,
            `You must claim your share before the next monthly settlement. Unclaimed shares are forfeited to the treasury.`,
            `The first month that yields ${fmtICP8(info.close_threshold_e8s)} ICP closes membership permanently — existing co-founders keep their seats and can still top up anytime.`,
            `The co-founder neuron follows the platform's primary voting neuron (#${info.primary_neuron_id.toString()}) on all topics — it votes on every NNS proposal.`,
          ].map((t, i) => (
            <span key={i} className="row" style={{ gap: 8, fontSize: 12.5, color: 'var(--fg-2)', alignItems: 'flex-start' }}>
              <span style={{ color: 'var(--burn)' }}>·</span><span style={{ flex: 1 }}>{t}</span>
            </span>
          ))}
          <button onClick={() => setIsTreeOpen(true)} style={{
            background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--burn)',
            fontSize: 12.5, textDecoration: 'underline dotted', textUnderlineOffset: 3,
            display: 'flex', alignItems: 'center', gap: 6, padding: 0, alignSelf: 'flex-start', marginTop: 2,
          }}>
            <Icon name="eye" size={13} /> See it as a decision tree
          </button>
        </div>

        {/* ── My position / join ── */}
        <div className="col card" style={{ gap: 10, flex: 1, minWidth: 260, padding: '14px 16px' }}>
          <Eyebrow>{isCoFounder ? 'Your co-founder seat' : 'Become a co-founder'}</Eyebrow>
          {isCoFounder ? (
            <>
              <span className="row" style={{ gap: 6, alignItems: 'baseline' }}>
                <b className="mono" style={{ fontSize: 20 }}>{fmtICP8(info.my_staked_e8s)}</b>
                <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>ICP locked forever</span>
              </span>
              {info.my_claimable_e8s > 0n ? (
                <div className="col" style={{ gap: 6, border: '1px solid var(--sprout)', borderRadius: 8, padding: '10px 12px', background: 'var(--sprout-dim)' }}>
                  <span style={{ fontSize: 12.5, color: 'var(--fg)' }}>
                    <b className="mono">{fmtICP8(info.my_claimable_e8s)} ICP</b> waiting for you
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                    Claim before {deadline.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} or it goes to the treasury.
                  </span>
                  <Btn variant="primary" sm disabled={claimBusy} onClick={executeClaim}>
                    {claimBusy ? 'Claiming…' : 'Claim your share'}
                  </Btn>
                </div>
              ) : (
                <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>
                  No unclaimed share right now. Next settlement: {deadline.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}.
                </span>
              )}
              {claimNote && <span style={{ fontSize: 11.5, color: claimNote.startsWith('Claim failed') ? 'var(--ember)' : 'var(--sprout)' }}>{claimNote}</span>}
              <Btn variant="secondary" sm onClick={() => {
                setStakeAmount(''); setAcknowledged(false); setStakeError(null); setStakeDone(false); setStakeStep('');
                setIsStakeOpen(true);
              }}>
                Add more anytime (also permanent)
              </Btn>
            </>
          ) : info.membership_closed ? (
            <>
              <span className="row" style={{ gap: 6 }}>
                <Icon name="lock" size={13} stroke="var(--fg-3)" />
                <b style={{ fontSize: 13 }}>Membership closed</b>
              </span>
              <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
                A month's yield reached {fmtICP8(info.close_threshold_e8s)} ICP, so the founders'
                table is full — permanently. The {info.cofounder_count.toString()} existing
                co-founders keep their seats.
              </span>
            </>
          ) : (
            <>
              <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
                Minimum {fmtICP8(info.min_stake_e8s)} ICP. Monthly yield share proportional to your
                stake, top up anytime. <b>No exit — read the red box.</b> Seats close forever once
                monthly yield hits {fmtICP8(info.close_threshold_e8s)} ICP.
              </span>
              <Btn variant="primary" onClick={() => {
                if (!signedIn) { onSignIn(); return; }
                setStakeAmount(''); setAcknowledged(false); setStakeError(null); setStakeDone(false); setStakeStep('');
                setIsStakeOpen(true);
              }}>
                <Icon name="spark" size={13} stroke="var(--char-950)" /> {signedIn ? 'Stake forever' : 'Sign in to join'}
              </Btn>
            </>
          )}
        </div>
      </div>

      {/* ── Program stats ── */}
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        {[
          ['Membership', info.membership_closed ? 'Closed' : 'Open'],
          ['Co-founders', info.cofounder_count.toString()],
          ['Total staked', `${fmtICP8(info.total_staked_e8s)} ICP`],
          ['Share pool', `${fmtICP8(info.share_pool_e8s)} ICP`],
          ['Restaked', `${fmtICP8(info.total_restaked_e8s)} ICP`],
          ['Lifetime yield', `${fmtICP8(info.total_yield_e8s)} ICP`],
          ['Next settlement', deadline.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })],
        ].map(([k, v]) => (
          <div key={k} className="col" style={{ gap: 2, border: '1px solid var(--border)', borderRadius: 8, padding: '8px 14px', flex: 1, minWidth: 110 }}>
            <span className="mono" style={{ fontSize: 9.5, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{k}</span>
            <b className="mono" style={{ fontSize: 14 }}>{v}</b>
          </div>
        ))}
      </div>

      {/* ── Neuron status ── */}
      <span className="row" style={{ gap: 8, fontSize: 12, color: 'var(--fg-2)', flexWrap: 'wrap' }}>
        <Icon name="zap" size={13} stroke={info.follows_primary_neuron ? 'var(--sprout)' : 'var(--haze)'} />
        {info.neuron_id !== undefined && info.neuron_id !== null ? (
          <span>
            Co-founder neuron <b className="mono">#{info.neuron_id.toString()}</b>
            {info.follows_primary_neuron
              ? <> · follows primary neuron <b className="mono">#{info.primary_neuron_id.toString()}</b> — votes on every NNS proposal</>
              : ' · bootstrap in progress (follow set-up pending)'}
          </span>
        ) : (
          <span>Neuron is created at the first co-founder stake, with a 2-year dissolve delay, following primary neuron <b className="mono">#{info.primary_neuron_id.toString()}</b>.</span>
        )}
        <button onClick={copyValidationSkill} style={{
          background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-3)',
          fontSize: 11.5, textDecoration: 'underline dotted', textUnderlineOffset: 3,
          display: 'flex', alignItems: 'center', gap: 5, marginLeft: 'auto',
        }}>
          <Icon name={validationCopied ? 'check' : 'copy'} size={11} stroke={validationCopied ? 'var(--sprout)' : 'var(--fg-3)'} />
          {validationCopied ? 'Copied' : 'Copy agent validation instructions'}
        </button>
      </span>

      {/* ── Charts ── */}
      <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
        <BarChart title="Yield collected — each of the last 12 months (ICP)" points={yieldPoints} color="var(--burn)" />
        <BarChart title="ICP held in the co-founder share pool — last 12 months" points={poolPoints} color="var(--sprout)" />
      </div>

      {/* ── The co-founders (largest stake first, 25 per page) ── */}
      <div className="col" style={{ gap: 10 }}>
        <span className="row" style={{ gap: 8 }}>
          <Icon name="coins" size={14} stroke="var(--burn)" />
          <b style={{ fontSize: 14, color: 'var(--fg)' }}>The co-founders</b>
          <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
            · {roster.length} seat{roster.length === 1 ? '' : 's'} · ordered by stake · yield shares follow these percentages
          </span>
        </span>
        {roster.length === 0 ? (
          <span style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>No co-founders yet — the first seat is open.</span>
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12.5 }}>
                <thead>
                  <tr className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    <th style={CF_TH}>#</th>
                    <th style={{ ...CF_TH, textAlign: 'left' }}>Co-founder</th>
                    <th style={CF_TH}>Staked</th>
                    <th style={CF_TH}>% of pool</th>
                    <th style={CF_TH}>Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRoster.map((m, i) => {
                    const mine = signedIn && m.user.toString() === principal!.toString();
                    const pct = info.total_staked_e8s > 0n
                      ? Number((m.staked_e8s * 10_000n) / info.total_staked_e8s) / 100
                      : 0;
                    return (
                      <tr key={m.user.toString()} style={{
                        borderTop: '1px solid var(--border)',
                        background: mine ? 'var(--burn-950)' : 'transparent',
                      }}>
                        <td style={{ ...CF_TD, color: 'var(--fg-3)' }} className="mono">{safeRosterPage * ROSTER_PAGE_SIZE + i + 1}</td>
                        <td style={{ ...CF_TD, textAlign: 'left' }}>
                          <span className="row" style={{ gap: 8 }}>
                            <span className="mono">{formatPrincipal(m.user)}{mine ? ' · you' : ''}</span>
                            {m.is_admin && (
                              <Chip tone="solid" style={{ height: 18, fontSize: 9.5, letterSpacing: '0.08em' }}>FOUNDER</Chip>
                            )}
                          </span>
                        </td>
                        <td style={CF_TD} className="mono">{fmtICP8(m.staked_e8s)} ICP</td>
                        <td style={CF_TD} className="mono">{pct.toFixed(2)}%</td>
                        <td style={{ ...CF_TD, color: 'var(--fg-3)' }} className="mono">
                          {new Date(Number(m.joined_at / 1_000_000n)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {rosterPageCount > 1 && (
              <div className="row" style={{ justifyContent: 'center', gap: 12 }}>
                <Btn variant="secondary" sm disabled={safeRosterPage === 0} onClick={() => setRosterPage(p => Math.max(0, p - 1))}>
                  <Icon name="chevLeft" size={13} /> Prev
                </Btn>
                <span className="mono" style={{ fontSize: 12, color: 'var(--fg-3)' }}>{safeRosterPage + 1} / {rosterPageCount}</span>
                <Btn variant="secondary" sm disabled={safeRosterPage >= rosterPageCount - 1} onClick={() => setRosterPage(p => Math.min(rosterPageCount - 1, p + 1))}>
                  Next <Icon name="chevRight" size={13} />
                </Btn>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Settlement decision-tree dialog ── */}
      {isTreeOpen && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(12, 10, 9, 0.85)', backdropFilter: 'blur(8px)',
          zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
        }} onClick={() => setIsTreeOpen(false)}>
          <div className="card col" style={{
            maxWidth: 720, width: '100%', gap: 12, background: 'var(--surface)',
            border: '1px solid var(--border-hi)', boxShadow: 'var(--elev-3)', maxHeight: '92vh', overflowY: 'auto',
          }} onClick={e => e.stopPropagation()}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="row" style={{ gap: 8 }}>
                <Icon name="spark" size={15} stroke="var(--burn)" />
                <b>The monthly settlement, visually</b>
              </span>
              <Btn variant="ghost" sm onClick={() => setIsTreeOpen(false)}><Icon name="x" size={14} /></Btn>
            </div>
            <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>
              Where the neuron's yield goes each month, and how your share is decided.
            </span>
            <SettlementTree />
          </div>
        </div>
      )}

      {/* ── Stake modal ── */}
      {isStakeOpen && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(12, 10, 9, 0.85)', backdropFilter: 'blur(8px)',
          zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
        }} onClick={() => !stakeBusy && setIsStakeOpen(false)}>
          <div className="card col" style={{
            maxWidth: 480, width: '100%', gap: 14, background: 'var(--surface)',
            border: '1px solid var(--border-hi)', boxShadow: 'var(--elev-3)', maxHeight: '90vh', overflowY: 'auto',
          }} onClick={e => e.stopPropagation()}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="row" style={{ gap: 8 }}>
                <Icon name="spark" size={15} stroke="var(--burn)" />
                <b>Stake as a co-founder</b>
              </span>
              <Btn variant="ghost" sm onClick={() => !stakeBusy && setIsStakeOpen(false)}><Icon name="x" size={14} /></Btn>
            </div>

            {stakeDone ? (
              <div className="col" style={{ gap: 12, alignItems: 'center', padding: '12px 0' }}>
                <Icon name="checkCircle" size={32} stroke="var(--sprout)" />
                <p style={{ fontSize: 13, color: 'var(--fg-2)', textAlign: 'center', margin: 0 }}>{stakeStep}</p>
                <Btn variant="secondary" onClick={() => setIsStakeOpen(false)}>Close</Btn>
              </div>
            ) : (
              <>
                <div className="col" style={{ gap: 6, border: '1px solid var(--ember)', borderRadius: 8, padding: '10px 12px', background: 'var(--ember-dim)' }}>
                  <span style={{ fontSize: 12.5, color: 'var(--fg)' }}>
                    <b style={{ color: 'var(--ember)' }}>FINAL WARNING:</b> this ICP is locked into the
                    platform neuron <b>permanently</b>. You can never unstake, withdraw, or transfer it.
                    No exceptions, no admin override — the function does not exist.
                  </span>
                </div>
                <div className="col" style={{ gap: 6 }}>
                  <label style={{ fontSize: 11, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    Amount (min {fmtICP8(info.min_stake_e8s)} ICP)
                  </label>
                  <div style={{ position: 'relative' }}>
                    <input type="number" min="1" step="any" className="burn-input" style={{ fontFamily: 'var(--font-mono)' }}
                      placeholder="e.g. 25" value={stakeAmount}
                      onChange={e => { setStakeAmount(e.target.value); setStakeError(null); }} />
                    <span className="mono" style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 13, color: 'var(--fg-3)', pointerEvents: 'none' }}>ICP</span>
                  </div>
                </div>
                <label className="row" style={{ gap: 8, fontSize: 12.5, color: 'var(--fg)', cursor: 'pointer', alignItems: 'flex-start' }}>
                  <input type="checkbox" checked={acknowledged} style={{ marginTop: 2 }}
                    onChange={e => { setAcknowledged(e.target.checked); setStakeError(null); }} />
                  <span style={{ flex: 1 }}>
                    I understand that this stake is <b>irreversible and permanent</b> — my ICP can
                    never be withdrawn, and my only return is the monthly co-founder yield share.
                  </span>
                </label>
                {stakeStep && !stakeError && <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>{stakeStep}</span>}
                {stakeError && <span style={{ fontSize: 12, color: 'var(--ember)' }}>{stakeError}</span>}
                <Btn variant="danger" disabled={stakeBusy || !acknowledged} onClick={executeStake}>
                  {stakeBusy ? 'Working…' : 'Stake forever — no going back'}
                </Btn>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
