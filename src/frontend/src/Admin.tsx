import { useState } from 'react';
import type { Config, FeatureFlag } from "./bindings/backend";
import { createActor as createLedgerActor } from "./bindings/ledger";
import { Icon, Eyebrow, Btn, LiveDot, fmtICP } from "./ui";

// ==========================================
// Admin console — every protocol dial in one place (admins only), plus the
// authoritative "How it works" reference for each money-moving feature.
// Controls formerly lived on the dashboard; they belong here.
// ==========================================

interface AdminProps {
  actor: any;
  config: Config | null;
  featureFlags: FeatureFlag[];
  identity: any;
  host: string;
  rootKey?: Uint8Array;
  ledgerCanisterId: string;
  /** Re-fetch config + flags after a successful change. */
  onChanged: () => void;
  openTreasury: () => void;
}

function Section({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="col" style={{
      gap: 0, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface)',
    }}>
      <button
        onClick={() => setOpen(o => !o)}
        className="row"
        style={{
          gap: 10, padding: '12px 14px', background: 'transparent', border: 'none',
          cursor: 'pointer', width: '100%', textAlign: 'left', color: 'var(--fg)',
        }}
      >
        <Icon name={icon} size={14} stroke="var(--burn)" />
        <b style={{ fontSize: 13.5, flex: 1 }}>{title}</b>
        <Icon name={open ? 'chevDown' : 'chevRight'} size={14} stroke="var(--fg-3)" />
      </button>
      {open && (
        <div className="col" style={{ gap: 8, padding: '0 14px 14px 38px', fontSize: 12.5, color: 'var(--fg-2)' }}>
          {children}
        </div>
      )}
    </div>
  );
}

const Li = ({ children }: { children: React.ReactNode }) => (
  <span className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
    <span style={{ color: 'var(--burn)', lineHeight: '19px' }}>·</span>
    <span style={{ flex: 1 }}>{children}</span>
  </span>
);

export default function Admin({ actor, config, featureFlags, identity, host, rootKey, ledgerCanisterId, onChanged, openTreasury }: AdminProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [thresholdInput, setThresholdInput] = useState('');
  const [ticketsInput, setTicketsInput] = useState('');
  const [poolFeeInput, setPoolFeeInput] = useState('');
  const [sweetenInput, setSweetenInput] = useState('');

  const run = async (label: string, fn: () => Promise<string | null>) => {
    if (!actor || busy) return;
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
      onChanged();
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setBusy(null);
    }
  };

  const setThreshold = () => run('threshold', async () => {
    const icp = parseFloat(thresholdInput);
    if (isNaN(icp) || icp < 1) { setError("Threshold must be at least 1 ICP."); return null; }
    const res = await actor.admin_set_default_threshold(BigInt(Math.round(icp * 100_000_000)));
    if (res.__kind__ === "Err") { setError(res.Err); return null; }
    setThresholdInput('');
    return `Threshold set to ${icp} ICP — all open proposals re-thresholded.`;
  });

  const toggleFlag = (key: string, enabled: boolean) => run(`flag-${key}`, async () => {
    const res = await actor.admin_set_feature_flag(key, !enabled);
    if (res.__kind__ === "Err") { setError(res.Err); return null; }
    return `${key} ${!enabled ? 'enabled' : 'disabled'}.`;
  });

  const setTickets = () => run('tickets', async () => {
    const n = parseInt(ticketsInput, 10);
    if (isNaN(n) || n < 1) { setError("Base grant must be at least 1 ticket."); return null; }
    const res = await actor.admin_set_lottery_config(BigInt(n));
    if (res.__kind__ === "Err") { setError(res.Err); return null; }
    setTicketsInput('');
    return `Base ticket grant set to ${n}/day (tiers pay ${n}/${n * 2}/${n * 4}).`;
  });

  const setPoolFee = () => run('poolfee', async () => {
    const icp = parseFloat(poolFeeInput);
    if (isNaN(icp) || icp <= 0) { setError("Fee must be above 0 ICP."); return null; }
    const res = await actor.admin_set_pool_fee(BigInt(Math.round(icp * 100_000_000)));
    if (res.__kind__ === "Err") { setError(res.Err); return null; }
    setPoolFeeInput('');
    return `Pool initiation fee set to ${icp} ICP.`;
  });

  const sweetenPot = () => run('sweeten', async () => {
    const icp = parseFloat(sweetenInput);
    if (isNaN(icp) || icp <= 0) { setError("Enter an ICP amount above 0."); return null; }
    const amount = BigInt(Math.round(icp * 100_000_000));
    const pot = await actor.get_lottery_pot_address();
    const ledger = createLedgerActor(ledgerCanisterId, {
      agentOptions: { host, identity, rootKey },
    });
    const xfer = await ledger.icrc1_transfer({
      to: { owner: pot.owner, subaccount: pot.subaccount },
      amount,
    });
    if (xfer.__kind__ === "Err") {
      setError(`Transfer failed: ${JSON.stringify(xfer.Err, (_k, v) => typeof v === "bigint" ? v.toString() : v)}`);
      return null;
    }
    setSweetenInput('');
    return `Pot sweetened with ${icp} ICP from your wallet — it's in the next jackpots.`;
  });

  const card: React.CSSProperties = {
    border: '1px dashed var(--burn)', borderRadius: 10,
    background: 'var(--burn-950)', padding: 14,
  };

  const base = config ? Number(config.lottery_tickets_per_day) : 5;

  return (
    <div className="dashboard-container">
      {/* ── Header ── */}
      <div className="col" style={{ gap: 6 }}>
        <span className="row" style={{ gap: 8 }}>
          <Icon name="key" size={16} stroke="var(--burn)" />
          <Eyebrow accent>Admin console</Eyebrow>
        </span>
        <b style={{ fontSize: 17 }}>Every protocol dial. One page. No redeploys.</b>
        <span style={{ fontSize: 12.5, color: 'var(--fg-2)', maxWidth: 660 }}>
          Tune thresholds and fees, flip feature kill switches, manage the treasury — changes take
          effect instantly on-chain. Below the controls: the authoritative reference for how every
          feature moves money.
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
        {/* ── Voting threshold ── */}
        <div className="col" style={{ ...card, gap: 10, flex: '1 1 280px', minWidth: 260 }}>
          <span className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
            <Eyebrow>Voting threshold</Eyebrow>
            <span className="mono" style={{ fontSize: 12, color: 'var(--fg-2)' }}>
              {config ? fmtICP(config.default_threshold) : '…'} ICP
            </span>
          </span>
          <div className="row" style={{ gap: 8 }}>
            <input
              type="number" min="1" step="0.5" placeholder="New threshold (ICP)"
              className="burn-input" style={{ fontFamily: 'var(--font-mono)', flex: 1 }}
              value={thresholdInput} onChange={(e) => setThresholdInput(e.target.value)}
            />
            <Btn variant="primary" sm onClick={setThreshold} disabled={busy !== null || !thresholdInput}>
              {busy === 'threshold' ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="check" size={13} stroke="var(--char-950)" />} Set
            </Btn>
          </div>
          <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
            Applies to new proposals and re-thresholds every open one. Min 1 ICP.
          </span>
        </div>

        {/* ── Lottery base grant ── */}
        <div className="col" style={{ ...card, gap: 10, flex: '1 1 280px', minWidth: 260 }}>
          <span className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
            <Eyebrow>Lottery ticket grant</Eyebrow>
            <span className="mono" style={{ fontSize: 12, color: 'var(--fg-2)' }}>
              {base}/{base * 2}/{base * 4} per day
            </span>
          </span>
          <div className="row" style={{ gap: 8 }}>
            <input
              type="number" min="1" step="1" placeholder="Base (6-month tier)"
              className="burn-input" style={{ fontFamily: 'var(--font-mono)', flex: 1 }}
              value={ticketsInput} onChange={(e) => setTicketsInput(e.target.value)}
            />
            <Btn variant="primary" sm onClick={setTickets} disabled={busy !== null || !ticketsInput}>
              {busy === 'tickets' ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="check" size={13} stroke="var(--char-950)" />} Set
            </Btn>
          </div>
          <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
            Base = the 6-month tier. 1-year and 2-year stakers earn 2× and 4× the base.
          </span>
        </div>

        {/* ── Pool fee + treasury ── */}
        <div className="col" style={{ ...card, gap: 10, flex: '1 1 280px', minWidth: 260 }}>
          <span className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
            <Eyebrow>Pool initiation fee</Eyebrow>
            <span className="mono" style={{ fontSize: 12, color: 'var(--fg-2)' }}>
              {config ? fmtICP(config.pool_initiation_fee_e8s) : '…'} ICP
            </span>
          </span>
          <div className="row" style={{ gap: 8 }}>
            <input
              type="number" min="0" step="1" placeholder="New fee (ICP)"
              className="burn-input" style={{ fontFamily: 'var(--font-mono)', flex: 1 }}
              value={poolFeeInput} onChange={(e) => setPoolFeeInput(e.target.value)}
            />
            <Btn variant="primary" sm onClick={setPoolFee} disabled={busy !== null || !poolFeeInput}>
              {busy === 'poolfee' ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="check" size={13} stroke="var(--char-950)" />} Set
            </Btn>
          </div>
          <Btn variant="secondary" sm onClick={openTreasury} style={{ alignSelf: 'flex-start' }}>
            <Icon name="wallet" size={13} stroke="var(--burn)" /> Treasury wallet
          </Btn>
        </div>
      </div>

      {/* ── Feature flags ── */}
      <div className="col" style={{ ...card, gap: 10 }}>
        <span className="row" style={{ gap: 8 }}>
          <Icon name="zap" size={13} stroke="var(--burn)" />
          <Eyebrow>Feature kill switches</Eyebrow>
        </span>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          {featureFlags.map(f => (
            <div key={f.key} className="row" style={{
              gap: 10, padding: '8px 12px', border: '1px solid var(--border)',
              borderRadius: 8, background: 'var(--surface)',
            }}>
              <span className="mono" style={{ fontSize: 12.5 }}>{f.key}</span>
              <Btn
                variant={f.enabled ? 'primary' : 'secondary'} sm
                onClick={() => toggleFlag(f.key, f.enabled)}
                disabled={busy === `flag-${f.key}`}
              >
                {busy === `flag-${f.key}`
                  ? <LiveDot size={7} color={f.enabled ? 'var(--char-950)' : 'var(--fg)'} />
                  : <Icon name={f.enabled ? 'check' : 'x'} size={12} stroke={f.enabled ? 'var(--char-950)' : 'currentColor'} />}
                {f.enabled ? ' On' : ' Off'}
              </Btn>
            </div>
          ))}
        </div>
        <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
          Off = the page disappears for everyone and the canister rejects the feature's methods. Instant, reversible.
        </span>
      </div>

      {/* ── Sweeten the lottery pot (admin-only — users never see this) ── */}
      <div className="col" style={{ ...card, gap: 10 }}>
        <span className="row" style={{ gap: 8 }}>
          <Icon name="spark" size={13} stroke="var(--burn)" />
          <Eyebrow>Sweeten the lottery pot</Eyebrow>
        </span>
        <div className="row" style={{ gap: 8 }}>
          <div style={{ flex: 1, position: 'relative', maxWidth: 240 }}>
            <input
              type="number" min="0" step="1" placeholder="Amount to add"
              className="burn-input" style={{ fontFamily: 'var(--font-mono)' }}
              value={sweetenInput} onChange={(e) => setSweetenInput(e.target.value)}
            />
            <span className="mono" style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 13, color: 'var(--fg-3)', pointerEvents: 'none' }}>ICP</span>
          </div>
          <Btn variant="primary" sm onClick={sweetenPot} disabled={busy !== null || !sweetenInput}>
            {busy === 'sweeten' ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="spark" size={13} stroke="var(--char-950)" />} Add to pot
          </Btn>
        </div>
        <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
          Transfers ICP from YOUR wallet straight into the prize pot. Players just see a bigger
          jackpot — this control exists only here. (Admins hold no tickets, so you can never win
          your own deposit back.)
        </span>
      </div>

      {/* ── How it works ── */}
      <div className="col" style={{ gap: 6 }}>
        <Eyebrow accent>How each feature works</Eyebrow>
        <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
          The exact money flows, verbatim from the canister logic.
        </span>
      </div>

      <Section icon="flame" title="Burn voting — conviction with skin in the game">
        <Li>Users register a neuron, follow the community leader, then commit ICP to a tracked NNS proposal with an adopt or reject stance. Minimum 1 ICP; one commitment per proposal (top-ups allowed); 0.005 ICP protocol fee to the treasury at commit time.</Li>
        <Li>Committed ICP sits in a per-user escrow subaccount until the proposal's deadline (commits close 1 hour before).</Li>
        <Li>At cutoff, if total commitments meet the threshold, the side with more committed ICP decides the NNS vote (ties go to the first stance cast). Staked voting power joins this balance of power but never counts toward the threshold.</Li>
        <Li><b>Vote succeeds → the escrow burns:</b> 50% to the treasury, 25% to backend cycles, 25% to frontend cycles. Burns are recorded per user and power the leaderboard stats.</Li>
        <Li><b>Threshold unmet or the NNS vote fails → full refund.</b> A failed NNS call can never burn funds (F-102 invariant).</Li>
        <Li>Every transfer is journaled with per-leg block indices; the 5-minute sweep retries any failed leg without ever double-spending.</Li>
      </Section>

      <Section icon="target" title="Neuron pool — earn 25% of every burn">
        <Li>Neuron owners pay a one-time initiation fee (current: {config ? fmtICP(config.pool_initiation_fee_e8s) : '…'} ICP, split 50% treasury / 25% backend cycles / 25% frontend cycles) to register their neuron in the pool.</Li>
        <Li>When a proposal settles as burned, 25% of the burned total is split equally among the owners of the top 25 pool neurons by voting power, paid from the treasury.</Li>
        <Li>Each payout lands in the recipient's wallet and their payout history. Deactivating keeps the registration — reactivating never re-charges the fee.</Li>
      </Section>

      <Section icon="zap" title="Lossless staking — three terms, one principal, zero loss">
        <Li>Three pooled NNS neurons, one per term: 6 months, 1 year, 2 years. Your ICP joins the term's neuron; your principal is never spent.</Li>
        <Li>Platform voting power = stake × term multiplier (1× / 2× / 4×) — proportional to how long you lock. It sways the adopt/reject decision on every tracked proposal, free, vote by vote.</Li>
        <Li>Unstake any time: the tier's neuron splits, the split dissolves for the full term, then the FULL amount lands back in your wallet automatically — the treasury fronts the stake-transfer fee and reimburses every cycle fee (0.0003 ICP) with the disbursement. Zero-loss means zero: commit X, get X back.</Li>
        <Li>Neuron maturity harvests once it crosses ~1.05 ICP and is split <b>50% lottery prize pot / 50% treasury</b> — all three neurons feed the same pot.</Li>
        <Li>Staking is also the lottery's eligibility gate (below).</Li>
      </Section>

      <Section icon="spark" title="Lossless lottery — Powerball odds, funded by yield">
        <Li>Stakers only — and eligibility is live: daily grant = base ({base}) × term multiplier across staked tiers ({base}/{base * 2}/{base * 4} per day for 6mo/1y/2y), claimed automatically on login. Fully unstake and any tickets already held void immediately; the same happens on promotion to admin.</Li>
        <Li>Drawings 3× a week on the American Powerball cadence (Mon/Wed/Sat nights US Eastern). Each ticket has the real jackpot odds: 1 in 292,201,338 per drawing, from on-chain randomness (raw_rand).</Li>
        <Li>Tickets accumulate round over round until someone hits. The winner takes 80% of the prize pot; 20% seeds the next round; all tickets reset.</Li>
        <Li>The pot is funded purely by staking yield — players never pay in, so nobody can lose money. A hit with a dust pot rolls over instead of wasting the win.</Li>
        <Li>Prize payouts are journaled and retried until the transfer lands; a win can never be paid twice or lost.</Li>
      </Section>

      <Section icon="bulb" title="Community R&D — ideas and projects">
        <Li>Posting an idea costs 1 ICP (anti-spam, 100% to treasury). Ideas die after 30 days without an upvote.</Li>
        <Li>Upvotes carry value in ICP, ckBTC or ckETH (~$1 minimums, admin-tunable): 75% to the treasury, 25% straight to the idea's poster.</Li>
        <Li>Projects are admin-curated funding goals; contributions go 100% to the treasury, which pays for execution.</Li>
      </Section>

      <Section icon="coins" title="Payout history — every satoshi accounted for">
        <Li>Every transfer the canister makes to a user is recorded: lottery jackpots, unstake disbursements, idea upvote shares, commitment refunds, pool rewards.</Li>
        <Li>Each record carries the token, amount, timestamp and source id — the user-facing mirror of the append-only audit log.</Li>
      </Section>

      <Section icon="wallet" title="Treasury & cycles — how the lights stay on">
        <Li>Treasury inflows: 50% of burns, 50% of staking yield, idea fees and 75% upvote shares, project funding, pool initiation fees.</Li>
        <Li>Cycles: 25% of each burn tops up each canister via the CMC. If the backend dips below 5T cycles, the sweep auto-converts treasury ICP into cycles (two-phase, idempotent).</Li>
        <Li>Admins can withdraw treasury ICP via the Treasury wallet above; every movement hits the audit log.</Li>
      </Section>
    </div>
  );
}
