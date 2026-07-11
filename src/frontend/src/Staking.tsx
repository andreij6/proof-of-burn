import { useEffect, useState } from 'react';
import { Principal } from "@icp-sdk/core/principal";
import { StakeTier, StakingBootstrap, UnstakeStatus, YieldStatus } from "./bindings/backend";
import type { StakingPoolInfo, TierPoolInfo, UserStakeInfo, PendingUnstake, YieldDistribution, EarlyAdopterInfo } from "./bindings/backend";
import { createActor as createLedgerActor } from "./bindings/ledger";
import { Icon, Eyebrow, Chip, Btn, LiveDot, Skeleton, MoreInfo, fmtICP, usePageDevControls } from "./ui";
import { useErrorImpression } from "./analytics";

// ==========================================
// Lossless Staking — pooled staking across three fixed-term NNS neurons
// (6 months / 1 year / 2 years), all controlled by the canister. Stakers keep
// their principal and qualify for the lossless lottery, earning 5 / 10 / 20
// daily tickets per ICP per tier (term multiplier 1× / 2× / 4×). Staking does
// NOT grant voting power — voting is burn-only. Unstaking splits the tier's
// neuron and dissolves it for the tier's full term. A fourth, PERMANENT
// "Booster" neuron (2-year dissolve, never unstakeable) earns 40 tickets/ICP/day.
// Every neuron's yield is harvested into one inbox and split 70% lottery / 30%
// treasury.
// ==========================================

const E8S = 100_000_000n;

interface StakingProps {
  actor: any;
  identity: any;
  principal: Principal | null;
  host: string;
  rootKey?: Uint8Array;
  ledgerCanisterId: string;
  isLocal: boolean;
  /** Whether the permanent Booster neuron is enabled (adds a 4th tier tab). */
  boostersEnabled: boolean;
  /** The permanent Booster neuron is admin-only — non-admins never see it. */
  isAdmin: boolean;
  /** Treasury can front the ledger fee unstaking needs; false hides/blocks it. */
  treasuryCanFront: boolean;
  onSignIn: () => void;
  /** Called after stake/unstake so the app shell can refresh balances. */
  onActivity: () => void;
}

const TIER_ORDER: StakeTier[] = [StakeTier.SixMonths, StakeTier.OneYear, StakeTier.TwoYears];

export const TIER_META: Record<StakeTier, { label: string; short: string; mult: number; tickets: string }> = {
  [StakeTier.SixMonths]: { label: '6 months', short: '6 mo', mult: 1, tickets: '5' },
  [StakeTier.OneYear]: { label: '1 year', short: '1 yr', mult: 2, tickets: '10' },
  [StakeTier.TwoYears]: { label: '2 years', short: '2 yr', mult: 4, tickets: '20' },
};

/** Whole-ICP only: staking and unstaking reject fractional amounts. */
function parseIcp(text: string): bigint | null {
  const v = parseFloat(text);
  if (isNaN(v) || v <= 0 || !Number.isInteger(v)) return null;
  return BigInt(v) * 100_000_000n;
}

/** "~12 days" / "~3 hours" / "any moment" from a nanosecond ETA. */
export function etaLabel(etaNs: bigint): string {
  const ms = Number(etaNs / 1_000_000n) - Date.now();
  if (ms <= 0) return "any moment";
  const hours = ms / 3_600_000;
  if (hours < 1) return `~${Math.max(1, Math.round(ms / 60_000))} min`;
  if (hours < 48) return `~${Math.round(hours)} hours`;
  const days = hours / 24;
  if (days < 60) return `~${Math.round(days)} days`;
  return `~${Math.round(days / 30.44)} months`;
}

function bootstrapChip(b: StakingBootstrap) {
  switch (b) {
    case StakingBootstrap.Ready:
      return <Chip tone="ok"><Icon name="checkCircle" size={11} /> Neuron ready</Chip>;
    case StakingBootstrap.NotStarted:
      return <Chip tone="muted">No neuron yet</Chip>;
    default:
      return <Chip tone="pending"><LiveDot size={6} /> Configuring…</Chip>;
  }
}

export default function Staking({
  actor, identity, principal, host, rootKey, ledgerCanisterId, isLocal, boostersEnabled, isAdmin, treasuryCanFront, onSignIn, onActivity,
}: StakingProps) {
  const signedIn = !!(principal && !principal.isAnonymous());
  void treasuryCanFront; // unstake UI removed — exits are voucher-native now

  const [pool, setPool] = useState<StakingPoolInfo | null>(null);
  const [myStake, setMyStake] = useState<UserStakeInfo | null>(null);
  const [unstakes, setUnstakes] = useState<PendingUnstake[]>([]);
  const [yields, setYields] = useState<YieldDistribution[]>([]);
  // Permanent Booster neuron (the former Early Adopters program).
  const [eaInfo, setEaInfo] = useState<EarlyAdopterInfo | null>(null);
  const [boosterSel, setBoosterSel] = useState(false);
  const [boosterAck, setBoosterAck] = useState(false);

  const [tier, setTier] = useState<StakeTier>(StakeTier.SixMonths);
  const [stakeInput, setStakeInput] = useState('');
  const [maturityInput, setMaturityInput] = useState('');
  const [maturityTier, setMaturityTier] = useState<StakeTier>(StakeTier.SixMonths);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useErrorImpression(error, 'staking');

  const refresh = async () => {
    if (!actor) return;
    try {
      const [poolInfo, mine, pending, dists, ea] = await Promise.all([
        actor.get_staking_pool_info(),
        signedIn ? actor.get_my_stake() : Promise.resolve(null),
        signedIn ? actor.list_my_pending_unstakes() : Promise.resolve([]),
        actor.list_yield_distributions(),
        boostersEnabled && isAdmin ? actor.get_early_adopter_info().catch(() => null) : Promise.resolve(null),
      ]);
      setPool(poolInfo);
      setMyStake(mine ?? null);
      setUnstakes(pending);
      setYields(dists);
      setEaInfo(ea ?? null);
    } catch (err) {
      console.error("Failed to fetch staking state:", err);
    }
  };

  useEffect(() => { refresh(); }, [actor, principal]);

  const tierPool = (t: StakeTier): TierPoolInfo | undefined => pool?.pools.find(p => p.tier === t);
  const myTier = (t: StakeTier) => myStake?.tiers.find(s => s.tier === t);

  const selPool = tierPool(tier);
  const selMine = myTier(tier);
  const firstStake = !selPool?.neuron_id;
  const minStakeE8s = firstStake ? E8S : (pool?.min_stake_e8s ?? E8S);
  const termDays = selPool ? Number(selPool.dissolve_delay_secs) / 86_400 : 183;
  const termLabel = TIER_META[tier].label;

  const run = async (label: string, fn: () => Promise<void>) => {
    if (!actor || busy) return;
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setBusy(null);
    }
  };

  const handleStake = () => run('stake', async () => {
    const amount = parseIcp(stakeInput);
    if (!amount || amount < minStakeE8s) {
      setError(`Minimum ${firstStake ? 'first ' : ''}stake is ${fmtICP(minStakeE8s)} ICP${firstStake ? ` (creates the ${termLabel} pool neuron)` : ''}.`);
      return;
    }
    // Zero-loss: deposit exactly the stake amount — the treasury covers
    // every transfer fee in the cycle.
    const ledger = createLedgerActor(ledgerCanisterId, {
      agentOptions: { host, identity, rootKey },
    });
    const depositAccount = await actor.get_stake_deposit_address();
    const xfer = await ledger.icrc1_transfer({
      to: { owner: depositAccount.owner, subaccount: depositAccount.subaccount },
      amount,
    });
    if (xfer.__kind__ === "Err") {
      setError(`Deposit transfer failed: ${JSON.stringify(xfer.Err, (_k, v) => typeof v === "bigint" ? v.toString() : v)}`);
      return;
    }
    const res = await actor.stake(amount, tier);
    if (res.__kind__ === "Err") {
      setError(`Stake failed: ${res.Err}`);
      return;
    }
    setStakeInput('');
    setNotice(`Staked ${fmtICP(amount)} ICP for ${termLabel} — ${TIER_META[tier].tickets} lottery tickets per ICP per day are live.`);
    await refresh();
    onActivity();
  });

  // Booster stake: a permanent 2-year neuron — deposit, then early_adopter_stake.
  // No unstake exists; the reward is 40 lottery tickets/day per ICP.
  const handleBoosterStake = () => run('booster', async () => {
    if (!eaInfo) return;
    const amount = parseIcp(stakeInput);
    if (!amount || amount < eaInfo.min_stake_e8s) {
      setError(`Minimum Perm stake is ${fmtICP(eaInfo.min_stake_e8s)} ICP.`);
      return;
    }
    if (!boosterAck) {
      setError("Tick the box: a Perm stake is permanent and can never be unstaked.");
      return;
    }
    const ledger = createLedgerActor(ledgerCanisterId, {
      agentOptions: { host, identity, rootKey },
    });
    const depositAccount = await actor.get_early_adopter_deposit_address();
    const xfer = await ledger.icrc1_transfer({
      to: { owner: depositAccount.owner, subaccount: depositAccount.subaccount },
      amount: amount + eaInfo.fee_e8s,
    });
    if (xfer.__kind__ === "Err") {
      setError(`Deposit transfer failed: ${JSON.stringify(xfer.Err, (_k, v) => typeof v === "bigint" ? v.toString() : v)}`);
      return;
    }
    const res = await actor.early_adopter_stake(amount);
    if (res.__kind__ === "Err") { setError(`Stake failed: ${res.Err}`); return; }
    setStakeInput('');
    setBoosterAck(false);
    setNotice(`Staked ${fmtICP(amount)} ICP into the Perm neuron — permanent, now earning 40 lottery tickets per ICP per day.`);
    await refresh();
    onActivity();
  });

  // Legacy plain stakes (pre-voucher, or a sub-ICP remainder) → wrap the whole
  // whole-ICP part into a voucher so everything is voucher-managed. Exits are
  // now voucher-native (redeem/sell/buyback on the voucher below).
  const handleConvert = (t: StakeTier, amountE8s: bigint) => run(`convert-${t}`, async () => {
    const whole = (amountE8s / E8S) * E8S;
    if (whole < E8S) { setError('Nothing to convert — under 1 ICP folds into your next stake.'); return; }
    const res = await actor.wrap_stake_voucher(whole, t);
    if (res.__kind__ === 'Err') { setError(`Convert failed: ${res.Err}`); return; }
    setNotice(`Converted ${fmtICP(whole)} ICP of ${TIER_META[t].label} stake into a voucher — manage it below.`);
    await refresh();
    onActivity();
  });

  const handleDevSweep = () => run('sweep', async () => {
    const res = await actor.dev_run_staking_sweep();
    if (res.__kind__ === "Err") setError(res.Err);
    await refresh();
    onActivity();
  });

  // Restake dialog: pick which tier pool to merge a dissolving neuron into.
  const [restakeTarget, setRestakeTarget] = useState<bigint | null>(null); // unstake id
  const handleRestake = (id: bigint, t: StakeTier) => run(`merge-${id}`, async () => {
    const res = await actor.merge_unstake(id, t);
    if (res.__kind__ === "Err") { setError(res.Err); setRestakeTarget(null); return; }
    setRestakeTarget(null);
    setNotice(`Restaked into the ${TIER_META[t].label} pool — your stake there is earning lottery tickets again (0.0001 ICP merge fee).`);
    await refresh();
    onActivity();
  });

  const handleDevFastForward = (id: bigint) => run(`ff-${id}`, async () => {
    const res = await actor.dev_fast_forward_dissolve(id);
    if (res.__kind__ === "Err") { setError(res.Err); return; }
    const sweep = await actor.dev_run_staking_sweep();
    if (sweep.__kind__ === "Err") setError(sweep.Err);
    await refresh();
    onActivity();
  });

  const handleDevMaturity = () => run('maturity', async () => {
    const amount = parseIcp(maturityInput);
    if (!amount) { setError("Enter a maturity amount."); return; }
    const res = await actor.dev_add_mock_maturity(amount, maturityTier);
    if (res.__kind__ === "Err") { setError(res.Err); return; }
    setMaturityInput('');
    await refresh();
  });

  // Surface the staking simulator in App's Dashboard & Controls panel.
  usePageDevControls(isLocal && signedIn, () => (
    <div className="col" style={{ gap: 8 }}>
      <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-2)' }}>Staking simulator</span>
      <div className="col" style={{ gap: 8 }}>
        <Btn variant="secondary" sm onClick={handleDevSweep} disabled={busy !== null} style={{ alignSelf: 'flex-start' }}>
          {busy === 'sweep' ? <LiveDot size={7} /> : <Icon name="refresh" size={13} />} Run sweep now
        </Btn>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <input
            type="number" min="0" step="0.5" placeholder="Mock maturity (ICP)"
            className="burn-input" style={{ fontFamily: 'var(--font-mono)', width: 150 }}
            value={maturityInput} onChange={(e) => setMaturityInput(e.target.value)}
          />
          <select
            className="burn-input" style={{ fontFamily: 'var(--font-mono)', width: 92 }}
            value={maturityTier} onChange={(e) => setMaturityTier(e.target.value as StakeTier)}
          >
            {TIER_ORDER.map(t => <option key={t} value={t}>{TIER_META[t].short}</option>)}
          </select>
          <Btn variant="secondary" sm onClick={handleDevMaturity} disabled={busy !== null || !maturityInput}>
            {busy === 'maturity' ? <LiveDot size={7} /> : <Icon name="coins" size={13} />} Add maturity
          </Btn>
        </div>
      </div>
      <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>
        Add mock maturity ≥ 1.05 ICP to a tier's neuron, then run the sweep twice: first
        harvests into the shared yield inbox, second distributes it to the lottery pot + treasury.
      </span>
    </div>
  ), [busy, maturityInput, maturityTier]);

  const card: React.CSSProperties = {
    border: '1px solid var(--border)', borderRadius: 10,
    background: 'var(--surface)', padding: 16,
  };

  const tierTab = (t: StakeTier) => {
    const active = !boosterSel && tier === t;
    return (
    <button
      key={t}
      onClick={() => { setTier(t); setBoosterSel(false); }}
      style={{
        flex: 1, padding: '7px 4px', borderRadius: 7, cursor: 'pointer', fontSize: 12,
        fontWeight: active ? 700 : 500, fontFamily: 'inherit',
        border: `1px solid ${active ? 'var(--burn)' : 'var(--border)'}`,
        background: active ? 'color-mix(in srgb, var(--burn) 14%, transparent)' : 'transparent',
        color: active ? 'var(--burn-ink)' : 'var(--fg-2)',
      }}
    >
      {TIER_META[t].short}
    </button>
    );
  };

  // The permanent Booster neuron, shown as a 4th tab (2-year, never unstakeable).
  const boosterTab = (
    <button
      key="booster"
      onClick={() => { setBoosterSel(true); setError(null); }}
      style={{
        flex: 1, padding: '7px 4px', borderRadius: 7, cursor: 'pointer', fontSize: 12,
        fontWeight: boosterSel ? 700 : 500, fontFamily: 'inherit',
        border: `1px solid ${boosterSel ? 'var(--burn)' : 'var(--border)'}`,
        background: boosterSel ? 'color-mix(in srgb, var(--burn) 14%, transparent)' : 'transparent',
        color: boosterSel ? 'var(--burn-ink)' : 'var(--fg-2)',
      }}
    >
      ★ Perm
    </button>
  );

  return (
    <div className="idea-board-container">
      {(error || notice) && (
        <div className="row" style={{
          gap: 8, padding: '10px 12px', borderRadius: 8, fontSize: 12.5,
          border: `1px solid ${error ? 'var(--ember)' : 'var(--sprout)'}`,
          color: error ? 'var(--ember)' : 'var(--sprout-ink)',
          background: 'var(--surface)',
        }}>
          <Icon name={error ? "x" : "checkCircle"} size={13} stroke="currentColor" />
          {error || notice}
        </div>
      )}

      {/* ── Pending unstakes ── */}
      {signedIn && unstakes.filter(u => u.status !== UnstakeStatus.Merged).length > 0 && (
        <div className="col" style={{ ...card, gap: 10 }}>
          <Eyebrow>Your unstakes</Eyebrow>
          <div className="col" style={{ gap: 8 }}>
            {/* Restaked (merged) neurons are empty husks — hidden from the list. */}
            {[...unstakes].filter(u => u.status !== UnstakeStatus.Merged).sort((a, b) => Number(b.created_at - a.created_at)).map(u => (
              <div key={u.id.toString()} className="col" style={{
                gap: 10, padding: '14px 16px', borderRadius: 10,
                border: '1px solid var(--border)',
              }}>
                <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                  <span className="row" style={{ gap: 10, alignItems: 'center' }}>
                    <b className="mono" style={{ fontSize: 16 }}>{fmtICP(u.amount_e8s)} ICP</b>
                    <Chip tone="muted" style={{ height: 18, fontSize: 10.5 }}>{TIER_META[u.tier].short}</Chip>
                  </span>
                  {u.status === UnstakeStatus.Disbursed ? (
                    <Chip tone="ok"><Icon name="checkCircle" size={11} /> In your wallet</Chip>
                  ) : u.status === UnstakeStatus.Merged ? (
                    <Chip tone="ok"><Icon name="undo" size={11} /> Restaked · {u.merged_into !== undefined && u.merged_into !== null ? TIER_META[u.merged_into].short : 'pool'}</Chip>
                  ) : u.status === UnstakeStatus.Dissolving ? (
                    <Chip tone="pending"><Icon name="clock" size={11} /> Dissolving · {etaLabel(u.dissolve_eta)}</Chip>
                  ) : (
                    <Chip tone="muted"><LiveDot size={6} /> Starting dissolve…</Chip>
                  )}
                </div>
                <div className="row" style={{ justifyContent: 'space-between', gap: 8, fontSize: 12.5, minWidth: 0 }}>
                  <span style={{ color: 'var(--fg-3)', flexShrink: 0 }}>Dissolving neuron</span>
                  {isLocal ? (
                    <span className="mono" style={{ overflowWrap: 'anywhere', textAlign: 'right' }}>#{u.split_neuron_id.toString()}</span>
                  ) : (
                    <a
                      className="mono"
                      href={`https://dashboard.internetcomputer.org/neuron/${u.split_neuron_id.toString()}`}
                      target="_blank" rel="noreferrer"
                      style={{ color: 'var(--sprout-ink)', overflowWrap: 'anywhere', textAlign: 'right', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                      title="View the dissolving neuron on the NNS dashboard"
                    >
                      #{u.split_neuron_id.toString()} <Icon name="external" size={11} stroke="var(--sprout-ink)" />
                    </a>
                  )}
                </div>
                {(u.status === UnstakeStatus.Dissolving || u.status === UnstakeStatus.SplitDone) && (
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <Btn variant="secondary" sm onClick={() => setRestakeTarget(u.id)} disabled={busy !== null}>
                      <Icon name="undo" size={12} stroke="var(--burn-ink)" /> Restake
                    </Btn>
                    {isLocal && (
                      <Btn variant="ghost" sm onClick={() => handleDevFastForward(u.id)} disabled={busy !== null}>
                        {busy === `ff-${u.id}` ? <LiveDot size={7} /> : <Icon name="zap" size={12} />} Fast-forward (dev)
                      </Btn>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          <span className="row" style={{ gap: 8, fontSize: 11.5, color: 'var(--fg-3)', alignItems: 'center', flexWrap: 'wrap' }}>
            <span>Your ICP lands in your wallet automatically when the dissolve completes — exactly what you unstaked.</span>
            <MoreInfo label="What happens while a neuron dissolves" title="What happens while a neuron dissolves">
              <div className="card col" style={{ gap: 8, borderColor: 'var(--burn)', background: 'color-mix(in srgb, var(--burn) 12%, var(--surface))' }}>
                <Eyebrow accent>The gist</Eyebrow>
                <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
                  You get back <b>exactly what you unstaked</b> — the treasury reimburses every ledger
                  fee, and the ICP is disbursed automatically when the dissolve completes.
                </p>
              </div>
              <div className="col" style={{ gap: 6 }}>
                <Eyebrow accent>While it dissolves</Eyebrow>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                  <li><b>Own neuron per unstake:</b> dissolves for the tier's full term — follow it live with the neuron link.</li>
                  <li><b>Auto-disbursed on completion</b> to your wallet (shown under Profile as an "Unstake disbursement").</li>
                  <li><b>Fees reimbursed</b> by the treasury — you receive exactly what you unstaked.</li>
                </ul>
              </div>
              <div className="col" style={{ gap: 6 }}>
                <Eyebrow accent>Changed your mind?</Eyebrow>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                  <li><b>Restake any time:</b> drop the dissolving neuron into any term pool and it earns lottery tickets again immediately.</li>
                  <li><b>Stale explorer balances</b> may show for a few hours after a restake (merges never delete the source) — the live stake is already in the pool neuron.</li>
                </ul>
              </div>
            </MoreInfo>
          </span>
        </div>
      )}

      {/* ── Restake dialog: choose the destination tier pool ── */}
      {restakeTarget !== null && (() => {
        const u = unstakes.find(x => x.id === restakeTarget);
        if (!u) return null;
        return (
          <div style={{
            position: 'fixed', inset: 0, zIndex: 300, display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            background: 'color-mix(in srgb, var(--char-950) 70%, transparent)',
          }} onClick={() => busy === null && setRestakeTarget(null)}>
            <div className="col" style={{
              gap: 14, width: 'min(440px, calc(100vw - 32px))', padding: '20px 22px',
              borderRadius: 12, background: 'var(--surface)', border: '1px solid var(--border-hi)',
            }} onClick={e => e.stopPropagation()}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <Eyebrow accent>Restake {fmtICP(u.amount_e8s)} ICP</Eyebrow>
                <button onClick={() => setRestakeTarget(null)} disabled={busy !== null} style={{
                  background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-3)', padding: 2,
                }}><Icon name="x" size={15} /></button>
              </div>
              <span style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
                The dissolve stops and neuron <b className="mono">#{u.split_neuron_id.toString()}</b> merges
                into the term pool you pick — your stake there earns lottery tickets
                again immediately. A 0.0001 ICP merge fee applies.
              </span>
              <div className="col" style={{ gap: 8 }}>
                {TIER_ORDER.map(t => (
                  <Btn key={t} variant="secondary" onClick={() => handleRestake(u.id, t)}
                    disabled={busy !== null}
                    style={{ justifyContent: 'space-between', width: '100%', height: 44 }}>
                    <span className="row" style={{ gap: 8 }}>
                      {busy === `merge-${u.id}` ? <LiveDot size={8} /> : <Icon name="zap" size={13} stroke="var(--burn-ink)" />}
                      <b>{TIER_META[t].label}</b>
                    </span>
                    <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
                      {TIER_META[t].tickets} tickets / ICP / day
                    </span>
                  </Btn>
                ))}
              </div>
            </div>
          </div>
        );
      })()}

      
      <div className="row" style={{ gap: 14, alignItems: 'stretch', flexWrap: 'wrap' }}>
        {/* ── Your stake (with tier selector) — 50/50 with Term pools ── */}
        <div className="col" style={{ ...card, gap: 12, flex: '1 1 0', minWidth: 320 }}>
          <span className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
            <Eyebrow>Your stake</Eyebrow>
            {myStake && myStake.total_staked_e8s > 0n && (
              <Chip tone="ok">{fmtICP(myStake.total_staked_e8s)} ICP staked</Chip>
            )}
          </span>

          {!signedIn ? (
            <div className="col" style={{ gap: 10, alignItems: 'flex-start' }}>
              <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
                Sign in to stake and earn daily lottery tickets.
              </span>
              <Btn variant="primary" sm onClick={onSignIn}>
                <Icon name="key" size={13} stroke="var(--char-950)" /> Sign in
              </Btn>
            </div>
          ) : (
            <>
              <div className="row" style={{ gap: 6 }}>
                {TIER_ORDER.map(tierTab)}
                {boostersEnabled && isAdmin && boosterTab}
              </div>

              {boosterSel && isAdmin ? (
                <>
                  <div className="row" style={{ gap: 10, alignItems: 'baseline' }}>
                    <b className="mono" style={{ fontSize: 24 }}>{fmtICP(eaInfo?.my_staked_e8s ?? 0n)}</b>
                    <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>ICP boosting (permanent)</span>
                  </div>

                  {/* What makes the Booster neuron special */}
                  <div className="col" style={{ gap: 6, border: '1px solid var(--burn)', borderRadius: 8, padding: '10px 12px', background: 'color-mix(in srgb, var(--burn) 12%, var(--surface))' }}>
                    <span className="row" style={{ gap: 6, alignItems: 'center', fontSize: 12.5, color: 'var(--fg)' }}>
                      <Icon name="spark" size={13} stroke="var(--burn-ink)" /> <b>The 2-year Perm neuron</b>
                    </span>
                    <span style={{ fontSize: 11.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
                      Same 2-year neuron as the term tier, with two differences: it is{' '}
                      <b>permanent — never unstakeable, by anyone</b> — and it earns the highest ticket
                      rate, <b>40 lottery tickets/day per ICP</b> (vs 5/10/20). Like every neuron here,
                      its yield funds the lottery and the protocol — you're never paid ICP from it.
                    </span>
                  </div>

                  <div className="col" style={{ gap: 8 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <div style={{ flex: 1, position: 'relative' }}>
                        <input
                          type="number" min="0" step="1" placeholder={`Stake (min ${fmtICP(eaInfo?.min_stake_e8s ?? 100_000_000n)})`}
                          className="burn-input" style={{ fontFamily: 'var(--font-mono)' }}
                          value={stakeInput} onChange={(e) => setStakeInput(e.target.value)}
                        />
                        <span className="mono" style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 13, color: 'var(--fg-3)', pointerEvents: 'none' }}>ICP</span>
                      </div>
                      <Btn variant="primary" sm onClick={handleBoosterStake} disabled={busy !== null || !stakeInput || !boosterAck}>
                        {busy === 'booster' ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="spark" size={13} stroke="var(--char-950)" />}
                        {busy === 'booster' ? " Staking…" : " Stake forever"}
                      </Btn>
                    </div>
                    <label className="row" style={{ gap: 8, fontSize: 11.5, color: 'var(--fg-2)', cursor: 'pointer', alignItems: 'flex-start' }}>
                      <input type="checkbox" checked={boosterAck} style={{ marginTop: 2 }}
                        onChange={(e) => { setBoosterAck(e.target.checked); setError(null); }} />
                      <span style={{ flex: 1 }}>
                        I understand this stake is <b>permanent and irreversible</b> — it can never be
                        unstaked, and my only return is the daily lottery-ticket boost.
                      </span>
                    </label>
                  </div>
                </>
              ) : (
              <>
              {signedIn && myStake === null ? (
                <div className="row" style={{ gap: 10, alignItems: 'baseline' }} aria-busy="true" aria-label="Loading your stake">
                  <Skeleton width={110} height={24} />
                </div>
              ) : (
              <div className="row" style={{ gap: 10, alignItems: 'baseline' }}>
                <b className="mono" style={{ fontSize: 24 }}>{fmtICP(selMine?.amount_e8s ?? 0n)}</b>
                <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>
                  ICP in {termLabel}
                </span>
              </div>
              )}

              <div className="col" style={{ gap: 8 }}>
                <div className="row" style={{ gap: 8 }}>
                  <div style={{ flex: 1, position: 'relative' }}>
                    <input
                      type="number" min="0" step="0.1" placeholder={`Stake (min ${fmtICP(minStakeE8s)})`}
                      className="burn-input" style={{ fontFamily: 'var(--font-mono)' }}
                      value={stakeInput} onChange={(e) => setStakeInput(e.target.value)}
                    />
                    <span className="mono" style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 13, color: 'var(--fg-3)', pointerEvents: 'none' }}>ICP</span>
                  </div>
                  <Btn variant="primary" sm onClick={handleStake} disabled={busy !== null || !stakeInput}>
                    {busy === 'stake' ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="flame" size={13} stroke="var(--char-950)" />}
                    {busy === 'stake' ? " Staking…" : " Stake"}
                  </Btn>
                </div>
                <span className="row" style={{ gap: 6, fontSize: 11.5, color: 'var(--fg-3)' }}>
                  <Icon name="info" size={12} stroke="var(--fg-3)" />
                  Zero-loss: the treasury pays every transfer fee — what you stake is exactly what comes back. {firstStake ? `The first ${termLabel} stake creates that tier's neuron (min 1 ICP).` : ""}
                </span>

                {/* Legacy plain stake in this tier (pre-voucher) → convert. */}
                {selMine && selMine.amount_e8s >= E8S && (
                  <>
                    <div style={{ borderTop: '1px solid var(--border)' }} />
                    <div className="col" style={{ gap: 6, border: '1px solid var(--haze)', borderRadius: 8, padding: '10px 12px', background: 'color-mix(in srgb, var(--haze) 8%, var(--surface))' }}>
                      <span style={{ fontSize: 11.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
                        You have <b>{fmtICP(selMine.amount_e8s)} ICP</b> of legacy {termLabel} stake not yet in a voucher.
                        Exits are voucher-native now — convert it to manage it below (sell, redeem, or instant exit).
                      </span>
                      <Btn variant="secondary" sm onClick={() => handleConvert(tier, selMine.amount_e8s)} disabled={busy !== null} style={{ alignSelf: 'flex-start' }}>
                        {busy === `convert-${tier}` ? <LiveDot size={7} /> : <Icon name="star" size={12} stroke="var(--burn-ink)" />} Convert to voucher
                      </Btn>
                    </div>
                  </>
                )}
                <span className="row" style={{ gap: 6, fontSize: 11.5, color: 'var(--fg-3)' }}>
                  <Icon name="star" size={12} stroke="var(--fg-3)" />
                  Every stake arrives as a Voucher NFT below — redeem it for 100% after the {Math.round(termDays)}-day
                  dissolve, sell it, or take an instant exit. No separate unstake needed.
                </span>
              </div>
              </>
              )}
            </>
          )}
        </div>

        {/* ── Term pools — one public NNS neuron per term ── */}
        <div className="col" style={{ ...card, gap: 12, flex: '1 1 0', minWidth: 320 }}>
        <span className="row" style={{ gap: 8, justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <Eyebrow>Term pools</Eyebrow>
        </span>
        {pool === null ? (
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }} aria-busy="true" aria-label="Loading term pools">
            {[0, 1, 2].map((i) => <Skeleton key={i} width={220} height={96} radius={10} style={{ flex: '1 1 220px' }} />)}
          </div>
        ) : (
        <div className="row" style={{ gap: 12, alignItems: 'stretch', flexWrap: 'wrap' }}>
          {TIER_ORDER.map(t => {
            const tp = tierPool(t);
            const ready = tp?.bootstrap === StakingBootstrap.Ready;
            const sel = t === tier && !boosterSel;
            return (
              <div key={t}
                role="button" tabIndex={0}
                onClick={() => { setTier(t); setBoosterSel(false); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { setTier(t); setBoosterSel(false); } }}
                className="col" style={{
                gap: 10, padding: '14px 16px', borderRadius: 10, cursor: 'pointer',
                flex: '1 1 240px', minWidth: 0,
                border: `1px solid ${sel ? 'var(--burn)' : 'var(--border)'}`,
                background: sel ? 'color-mix(in srgb, var(--burn) 14%, transparent)' : 'transparent',
              }}>
                <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                  <b style={{ fontSize: 14.5, whiteSpace: 'nowrap' }}>{TIER_META[t].label}</b>
                  {tp ? bootstrapChip(tp.bootstrap) : <Chip tone="muted">…</Chip>}
                </div>
                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <Chip tone="gold" style={{ height: 18, fontSize: 10.5 }}>{TIER_META[t].tickets} tickets / ICP / day</Chip>
                </div>
                <div className="col" style={{ gap: 7, fontSize: 12.5, minWidth: 0 }}>
                  <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ color: 'var(--fg-3)' }}>Staked</span>
                    <span className="mono">{tp ? fmtICP(tp.total_staked_e8s) : '…'} ICP</span>
                  </div>
                  <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ color: 'var(--fg-3)' }}>Stakers</span>
                    <span className="mono">{tp ? tp.staker_count.toString() : '…'}</span>
                  </div>
                  <div className="row" style={{ justifyContent: 'space-between', gap: 8, minWidth: 0 }}>
                    <span style={{ color: 'var(--fg-3)', flexShrink: 0 }}>Neuron</span>
                    {tp?.neuron_id != null ? (
                      isLocal ? (
                        <span className="mono" style={{ overflowWrap: 'anywhere', textAlign: 'right' }}>
                          #{tp.neuron_id.toString()}
                        </span>
                      ) : (
                        <a
                          className="mono"
                          href={`https://dashboard.internetcomputer.org/neuron/${tp.neuron_id.toString()}`}
                          target="_blank" rel="noreferrer"
                          style={{ color: 'var(--sprout-ink)', overflowWrap: 'anywhere', textAlign: 'right', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                          title="View this neuron on the NNS dashboard"
                        >
                          #{tp.neuron_id.toString()} <Icon name="external" size={11} stroke="var(--sprout-ink)" />
                        </a>
                      )
                    ) : (
                      <span style={{ color: 'var(--fg-3)' }}>created on first stake</span>
                    )}
                  </div>
                </div>
                {ready && (
                  <span className="row" style={{ gap: 6, fontSize: 11, color: 'var(--sprout-ink)' }}>
                    <Icon name="eye" size={12} stroke="var(--sprout-ink)" />
                    Public on the NNS — audit it any time.
                  </span>
                )}
              </div>
            );
          })}

          </div>
        )}

      {/* The permanent Booster neuron — same layout, special terms. */}
          {boostersEnabled && isAdmin && (
            <div
              role="button" tabIndex={0}
              onClick={() => { setBoosterSel(true); setError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { setBoosterSel(true); setError(null); } }}
              className="col" style={{
                gap: 10, padding: '14px 16px', borderRadius: 10, cursor: 'pointer',
                flex: '1 1 240px', minWidth: 0,
                border: `1px solid ${boosterSel ? 'var(--burn)' : 'var(--border)'}`,
                background: boosterSel ? 'color-mix(in srgb, var(--burn) 14%, transparent)' : 'transparent',
              }}>
              <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <b style={{ fontSize: 14.5, whiteSpace: 'nowrap' }}>★ Perm · 2 years</b>
                {eaInfo?.follows_primary_neuron
                  ? <Chip tone="ok"><Icon name="checkCircle" size={11} /> Neuron ready</Chip>
                  : eaInfo?.neuron_id != null
                    ? <Chip tone="pending"><LiveDot size={6} /> Configuring…</Chip>
                    : <Chip tone="muted">No neuron yet</Chip>}
              </div>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <Chip tone="burn" style={{ height: 18, fontSize: 10.5 }}>permanent · no unstake</Chip>
                <Chip tone="gold" style={{ height: 18, fontSize: 10.5 }}>40 tickets / ICP / day</Chip>
              </div>
              <div className="col" style={{ gap: 7, fontSize: 12.5, minWidth: 0 }}>
                <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ color: 'var(--fg-3)' }}>Staked</span>
                  <span className="mono">{eaInfo ? fmtICP(eaInfo.total_staked_e8s) : '…'} ICP</span>
                </div>
                <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ color: 'var(--fg-3)' }}>Stakers</span>
                  <span className="mono">{eaInfo ? eaInfo.early_adopter_count.toString() : '…'}</span>
                </div>
                <div className="row" style={{ justifyContent: 'space-between', gap: 8, minWidth: 0 }}>
                  <span style={{ color: 'var(--fg-3)', flexShrink: 0 }}>Neuron</span>
                  {eaInfo?.neuron_id != null ? (
                    isLocal ? (
                      <span className="mono" style={{ overflowWrap: 'anywhere', textAlign: 'right' }}>#{eaInfo.neuron_id.toString()}</span>
                    ) : (
                      <a className="mono" href={`https://dashboard.internetcomputer.org/neuron/${eaInfo.neuron_id.toString()}`}
                        target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
                        style={{ color: 'var(--sprout-ink)', overflowWrap: 'anywhere', textAlign: 'right', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                        title="View this neuron on the NNS dashboard">
                        #{eaInfo.neuron_id.toString()} <Icon name="external" size={11} stroke="var(--sprout-ink)" />
                      </a>
                    )
                  ) : (
                    <span style={{ color: 'var(--fg-3)' }}>created on first stake</span>
                  )}
                </div>
              </div>
              <span className="row" style={{ gap: 6, fontSize: 11, color: 'var(--burn-ink)' }}>
                <Icon name="spark" size={12} stroke="var(--burn-ink)" />
                Permanent — never unstakeable. Tap to stake.
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ── Yield history ── */}
      {yields.length > 0 && (
        <div className="col" style={{ ...card, gap: 10 }}>
          <Eyebrow>Yield distributions</Eyebrow>
          <div className="col" style={{ gap: 6 }}>
            {[...yields].sort((a, b) => Number(b.id - a.id)).slice(0, 10).map(d => (
              <div key={d.id.toString()} className="row" style={{ justifyContent: 'space-between', gap: 10, fontSize: 12.5, flexWrap: 'wrap' }}>
                <span className="row" style={{ gap: 8 }}>
                  <span className="mono">{fmtICP(d.amount_e8s)} ICP</span>
                  {d.status === YieldStatus.Done
                    ? <Chip tone="ok">settled</Chip>
                    : <Chip tone="pending"><LiveDot size={6} /> in progress</Chip>}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}
