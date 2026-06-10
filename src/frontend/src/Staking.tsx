import { useEffect, useState } from 'react';
import { Principal } from "@icp-sdk/core/principal";
import { StakeTier, StakingBootstrap, UnstakeStatus, YieldStatus } from "./bindings/backend";
import type { StakingPoolInfo, TierPoolInfo, UserStakeInfo, PendingUnstake, YieldDistribution } from "./bindings/backend";
import { createActor as createLedgerActor } from "./bindings/ledger";
import { Icon, Eyebrow, Chip, Btn, LiveDot, fmtICP } from "./ui";

// ==========================================
// Lossless Voting — pooled staking across three fixed-term NNS neurons
// (6 months / 1 year / 2 years), all controlled by the canister. Stakers keep
// their principal, vote on tracked proposals for free with weight = stake ×
// term multiplier (1× / 2× / 4×), and qualify for the lossless lottery
// (5 / 10 / 20 daily tickets per tier). Unstaking splits the tier's neuron
// and dissolves it for the tier's full term. All three neurons' yield is
// harvested into one inbox and split 50% lottery prize pot / 50% treasury.
// ==========================================

const E8S = 100_000_000n;
const ICP_FEE = 10_000n;

interface StakingProps {
  actor: any;
  identity: any;
  principal: Principal | null;
  host: string;
  rootKey?: Uint8Array;
  ledgerCanisterId: string;
  isLocal: boolean;
  onSignIn: () => void;
  /** Called after stake/unstake so the app shell can refresh balances. */
  onActivity: () => void;
}

const TIER_ORDER: StakeTier[] = [StakeTier.SixMonths, StakeTier.OneYear, StakeTier.TwoYears];

const TIER_META: Record<StakeTier, { label: string; short: string; mult: number; tickets: string }> = {
  [StakeTier.SixMonths]: { label: '6 months', short: '6 mo', mult: 1, tickets: '5' },
  [StakeTier.OneYear]: { label: '1 year', short: '1 yr', mult: 2, tickets: '10' },
  [StakeTier.TwoYears]: { label: '2 years', short: '2 yr', mult: 4, tickets: '20' },
};

function parseIcp(text: string): bigint | null {
  const v = parseFloat(text);
  if (isNaN(v) || v <= 0) return null;
  return BigInt(Math.round(v * 100_000_000));
}

/** "~12 days" / "~3 hours" / "any moment" from a nanosecond ETA. */
function etaLabel(etaNs: bigint): string {
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
  actor, identity, principal, host, rootKey, ledgerCanisterId, isLocal, onSignIn, onActivity,
}: StakingProps) {
  const signedIn = !!(principal && !principal.isAnonymous());

  const [pool, setPool] = useState<StakingPoolInfo | null>(null);
  const [myStake, setMyStake] = useState<UserStakeInfo | null>(null);
  const [unstakes, setUnstakes] = useState<PendingUnstake[]>([]);
  const [yields, setYields] = useState<YieldDistribution[]>([]);

  const [tier, setTier] = useState<StakeTier>(StakeTier.SixMonths);
  const [stakeInput, setStakeInput] = useState('');
  const [unstakeInput, setUnstakeInput] = useState('');
  const [maturityInput, setMaturityInput] = useState('');
  const [maturityTier, setMaturityTier] = useState<StakeTier>(StakeTier.SixMonths);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = async () => {
    if (!actor) return;
    try {
      const [poolInfo, mine, pending, dists] = await Promise.all([
        actor.get_staking_pool_info(),
        signedIn ? actor.get_my_stake() : Promise.resolve(null),
        signedIn ? actor.list_my_pending_unstakes() : Promise.resolve([]),
        actor.list_yield_distributions(),
      ]);
      setPool(poolInfo);
      setMyStake(mine ?? null);
      setUnstakes(pending);
      setYields(dists);
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
  const minUnstakeE8s = pool?.min_unstake_e8s ?? (E8S + ICP_FEE);
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
    setNotice(`Staked ${fmtICP(amount)} ICP for ${termLabel} — ${TIER_META[tier].mult}× voting power and ${TIER_META[tier].tickets} lottery tickets/day are live.`);
    await refresh();
    onActivity();
  });

  const handleUnstake = () => run('unstake', async () => {
    const amount = parseIcp(unstakeInput);
    if (!amount || amount < minUnstakeE8s) {
      setError(`Minimum unstake is ${fmtICP(minUnstakeE8s)} ICP (the split neuron must hold ≥ 1 ICP).`);
      return;
    }
    if (selMine && amount > selMine.amount_e8s) {
      setError(`Amount exceeds your ${termLabel} stake.`);
      return;
    }
    const res = await actor.unstake(amount, tier);
    if (res.__kind__ === "Err") {
      setError(
        res.Err === 'POOL_FLOOR'
          ? "The pool neuron must keep at least 1 ICP — try a smaller amount (the last share exits when others stake)."
          : res.Err === 'NO_STAKE'
            ? `You have no stake in the ${termLabel} tier.`
            : `Unstake failed: ${res.Err}`
      );
      return;
    }
    setUnstakeInput('');
    setNotice(`Unstake started — your full ICP lands in your wallet after the ${termLabel} term. The treasury picks up the fees.`);
    await refresh();
    onActivity();
  });

  const handleDevSweep = () => run('sweep', async () => {
    const res = await actor.dev_run_staking_sweep();
    if (res.__kind__ === "Err") setError(res.Err);
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

  const card: React.CSSProperties = {
    border: '1px solid var(--border)', borderRadius: 10,
    background: 'var(--surface)', padding: 16,
  };

  const tierTab = (t: StakeTier) => (
    <button
      key={t}
      onClick={() => setTier(t)}
      style={{
        flex: 1, padding: '7px 4px', borderRadius: 7, cursor: 'pointer', fontSize: 12,
        fontWeight: tier === t ? 700 : 500, fontFamily: 'inherit',
        border: `1px solid ${tier === t ? 'var(--burn)' : 'var(--border)'}`,
        background: tier === t ? 'var(--burn-950)' : 'transparent',
        color: tier === t ? 'var(--burn)' : 'var(--fg-2)',
      }}
    >
      {TIER_META[t].short} · {TIER_META[t].mult}×
    </button>
  );

  return (
    <div className="dashboard-container">
      {/* ── Header ── */}
      <div className="col" style={{ gap: 6 }}>
        <span className="row" style={{ gap: 8 }}>
          <Icon name="zap" size={16} stroke="var(--burn)" />
          <Eyebrow accent>Lossless voting</Eyebrow>
        </span>
        <b style={{ fontSize: 17 }}>Stake ICP. Keep it. Vote for free. Win the lottery.</b>
        <span style={{ fontSize: 12.5, color: 'var(--fg-2)', maxWidth: 680 }}>
          Pick a term — 6 months, 1 year or 2 years. Your ICP joins that term's pooled NNS neuron,
          your platform voting power is stake × term (1× / 2× / 4×), and staking qualifies you for
          the lossless lottery (5 / 10 / 20 free tickets a day). The neurons' yield funds the
          protocol — 50% lottery prize pool, 50% treasury — and you can unstake any time: your ICP
          returns to your wallet after the term's dissolve.
        </span>
      </div>

      {(error || notice) && (
        <div className="row" style={{
          gap: 8, padding: '10px 12px', borderRadius: 8, fontSize: 12.5,
          border: `1px solid ${error ? 'var(--ember)' : 'var(--sprout)'}`,
          color: error ? 'var(--ember)' : 'var(--sprout)',
          background: 'var(--surface)',
        }}>
          <Icon name={error ? "x" : "checkCircle"} size={13} stroke="currentColor" />
          {error || notice}
        </div>
      )}

      <div className="row" style={{ gap: 14, alignItems: 'stretch', flexWrap: 'wrap' }}>
        {/* ── Your stake (with tier selector) ── */}
        <div className="col" style={{ ...card, gap: 12, flex: '1 1 320px', minWidth: 300 }}>
          <span className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
            <Eyebrow>Your stake</Eyebrow>
            {myStake && myStake.total_weight_e8s > 0n && (
              <Chip tone="ok">{fmtICP(myStake.total_weight_e8s)} voting power</Chip>
            )}
          </span>

          {!signedIn ? (
            <div className="col" style={{ gap: 10, alignItems: 'flex-start' }}>
              <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
                Sign in to stake, unlock free voting power and lottery tickets.
              </span>
              <Btn variant="primary" sm onClick={onSignIn}>
                <Icon name="key" size={13} stroke="var(--char-950)" /> Sign in
              </Btn>
            </div>
          ) : (
            <>
              <div className="row" style={{ gap: 6 }}>
                {TIER_ORDER.map(tierTab)}
              </div>

              <div className="row" style={{ gap: 10, alignItems: 'baseline' }}>
                <b className="mono" style={{ fontSize: 24 }}>{fmtICP(selMine?.amount_e8s ?? 0n)}</b>
                <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>
                  ICP in {termLabel} · weight {fmtICP(selMine?.weight_e8s ?? 0n)}
                </span>
              </div>

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

                <div style={{ borderTop: '1px solid var(--border)' }} />

                <div className="row" style={{ gap: 8 }}>
                  <div style={{ flex: 1, position: 'relative' }}>
                    <input
                      type="number" min="0" step="0.1" placeholder={`Unstake (min ${fmtICP(minUnstakeE8s)})`}
                      className="burn-input" style={{ fontFamily: 'var(--font-mono)' }}
                      value={unstakeInput} onChange={(e) => setUnstakeInput(e.target.value)}
                    />
                    <span className="mono" style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 13, color: 'var(--fg-3)', pointerEvents: 'none' }}>ICP</span>
                  </div>
                  <Btn variant="secondary" sm onClick={handleUnstake} disabled={busy !== null || !unstakeInput || !selMine}>
                    {busy === 'unstake' ? <LiveDot size={7} /> : <Icon name="undo" size={13} />}
                    {busy === 'unstake' ? " Splitting…" : " Unstake"}
                  </Btn>
                </div>
                <span className="row" style={{ gap: 6, fontSize: 11.5, color: 'var(--fg-3)' }}>
                  <Icon name="clock" size={12} stroke="var(--fg-3)" />
                  Splits the {termLabel} neuron and dissolves for the full term (~{Math.round(termDays)} days),
                  then your full ICP arrives automatically — the treasury reimburses every fee.
                </span>
              </div>
            </>
          )}
        </div>

        {/* ── Tier pools ── */}
        <div className="col" style={{ ...card, gap: 10, flex: '1 1 300px', minWidth: 280 }}>
          <Eyebrow>Term pools · one neuron each</Eyebrow>
          <div className="col" style={{ gap: 8 }}>
            {TIER_ORDER.map(t => {
              const tp = tierPool(t);
              return (
                <div key={t} className="col" style={{
                  gap: 5, padding: '8px 10px', borderRadius: 8,
                  border: `1px solid ${t === tier ? 'var(--border-hi)' : 'var(--border)'}`,
                }}>
                  <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                    <span className="row" style={{ gap: 7, fontSize: 12.5, fontWeight: 600 }}>
                      {TIER_META[t].label}
                      <Chip tone="muted" style={{ height: 17, fontSize: 10 }}>
                        {TIER_META[t].mult}× power · {TIER_META[t].tickets} tickets/day
                      </Chip>
                    </span>
                    {tp && bootstrapChip(tp.bootstrap)}
                  </div>
                  <div className="row" style={{ justifyContent: 'space-between', fontSize: 11.5, color: 'var(--fg-3)' }}>
                    <span className="mono">{tp ? fmtICP(tp.total_staked_e8s) : '…'} ICP staked · {tp ? tp.staker_count.toString() : '…'} stakers</span>
                    <span className="mono" style={{ fontSize: 10.5 }}>{tp?.neuron_id != null ? `#${tp.neuron_id}` : 'no neuron'}</span>
                  </div>
                </div>
              );
            })}
          </div>
          <span className="row" style={{ gap: 6, fontSize: 11.5, color: 'var(--fg-3)' }}>
            <Icon name="info" size={12} stroke="var(--fg-3)" />
            Each canister-controlled neuron follows the community leader on every topic so no
            voting reward is missed.
          </span>
        </div>

        {/* ── Yield ── */}
        <div className="col" style={{ ...card, gap: 10, flex: '1 1 260px', minWidth: 250 }}>
          <Eyebrow>Yield · 50% lottery / 50% treasury</Eyebrow>
          <div className="col" style={{ gap: 7, fontSize: 12.5 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--fg-3)' }}>Harvested (lifetime)</span>
              <span className="mono">{pool ? fmtICP(pool.total_yield_e8s) : "…"} ICP</span>
            </div>
            {TIER_ORDER.map(t => {
              const tp = tierPool(t);
              if (!tp || tp.total_yield_e8s === 0n) return null;
              return (
                <div key={t} className="row" style={{ justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--fg-3)' }}>· from {TIER_META[t].label}</span>
                  <span className="mono">{fmtICP(tp.total_yield_e8s)} ICP</span>
                </div>
              );
            })}
          </div>
          {pool && pool.pools.some(tp => tp.pending_maturity.length > 0) && (
            <>
              <div style={{ borderTop: '1px solid var(--border)' }} />
              <div className="col" style={{ gap: 5 }}>
                <Eyebrow>Incoming maturity</Eyebrow>
                {pool.pools.flatMap(tp => tp.pending_maturity.map((m, i) => (
                  <div key={`${tp.tier}-${i}`} className="row" style={{ justifyContent: 'space-between', fontSize: 12 }}>
                    <span className="mono">{fmtICP(m.amount_e8s)} ICP</span>
                    <span style={{ color: 'var(--fg-3)' }}>{TIER_META[tp.tier].short} · mints {etaLabel(m.expected_at)}</span>
                  </div>
                )))}
              </div>
            </>
          )}
          <span className="row" style={{ gap: 6, fontSize: 11.5, color: 'var(--fg-3)' }}>
            <Icon name="coins" size={12} stroke="var(--fg-3)" />
            All three neurons feed one yield inbox: half grows the single lottery prize pot, half
            funds the treasury. Maturity harvests at ~1.05 ICP; the NNS mints it ~7 days later.
          </span>
        </div>
      </div>

      {/* ── Pending unstakes ── */}
      {signedIn && unstakes.length > 0 && (
        <div className="col" style={{ ...card, gap: 10 }}>
          <Eyebrow>Your unstakes</Eyebrow>
          <div className="col" style={{ gap: 8 }}>
            {[...unstakes].sort((a, b) => Number(b.created_at - a.created_at)).map(u => (
              <div key={u.id.toString()} className="row" style={{
                justifyContent: 'space-between', gap: 10, flexWrap: 'wrap',
                padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8,
              }}>
                <span className="row" style={{ gap: 10 }}>
                  <span className="mono" style={{ fontSize: 13 }}>{fmtICP(u.amount_e8s)} ICP</span>
                  <Chip tone="muted" style={{ height: 18, fontSize: 10.5 }}>{TIER_META[u.tier].short}</Chip>
                  {u.status === UnstakeStatus.Disbursed ? (
                    <Chip tone="ok"><Icon name="checkCircle" size={11} /> In your wallet</Chip>
                  ) : u.status === UnstakeStatus.Dissolving ? (
                    <Chip tone="pending"><Icon name="clock" size={11} /> Dissolving · {etaLabel(u.dissolve_eta)}</Chip>
                  ) : (
                    <Chip tone="muted"><LiveDot size={6} /> Starting dissolve…</Chip>
                  )}
                </span>
                {isLocal && u.status !== UnstakeStatus.Disbursed && (
                  <Btn variant="ghost" sm onClick={() => handleDevFastForward(u.id)} disabled={busy !== null}>
                    {busy === `ff-${u.id}` ? <LiveDot size={7} /> : <Icon name="zap" size={12} />} Fast-forward (dev)
                  </Btn>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

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
                <span className="mono" style={{ color: 'var(--fg-3)', fontSize: 11.5 }}>
                  {fmtICP(d.lottery_amount_e8s)} lottery pot · {fmtICP(d.treasury_amount_e8s)} treasury
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Local dev tools ── */}
      {isLocal && signedIn && (
        <div className="col" style={{
          gap: 10, border: '1px dashed var(--burn)', borderRadius: 10,
          background: 'var(--burn-950)', padding: 14,
        }}>
          <span className="row" style={{ gap: 8 }}>
            <Icon name="zap" size={13} stroke="var(--burn)" />
            <Eyebrow>Local dev · staking simulator</Eyebrow>
          </span>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <Btn variant="secondary" sm onClick={handleDevSweep} disabled={busy !== null}>
              {busy === 'sweep' ? <LiveDot size={7} /> : <Icon name="refresh" size={13} />} Run sweep now
            </Btn>
            <div className="row" style={{ gap: 8 }}>
              <input
                type="number" min="0" step="0.5" placeholder="Mock maturity (ICP)"
                className="burn-input" style={{ fontFamily: 'var(--font-mono)', width: 170 }}
                value={maturityInput} onChange={(e) => setMaturityInput(e.target.value)}
              />
              <select
                className="burn-input" style={{ fontFamily: 'var(--font-mono)', width: 100 }}
                value={maturityTier} onChange={(e) => setMaturityTier(e.target.value as StakeTier)}
              >
                {TIER_ORDER.map(t => <option key={t} value={t}>{TIER_META[t].short}</option>)}
              </select>
              <Btn variant="secondary" sm onClick={handleDevMaturity} disabled={busy !== null || !maturityInput}>
                {busy === 'maturity' ? <LiveDot size={7} /> : <Icon name="coins" size={13} />} Add maturity
              </Btn>
            </div>
          </div>
          <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
            Add mock maturity ≥ 1.05 ICP to a tier's neuron, then run the sweep twice: first
            harvests into the shared yield inbox, second splits it 50% lottery pot / 50% treasury.
          </span>
        </div>
      )}
    </div>
  );
}
