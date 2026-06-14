import { useEffect, useState, useCallback } from 'react';
import { Principal } from '@icp-sdk/core/principal';
import { Icon, Eyebrow, Chip, Btn, MoreInfo, formatPrincipal } from './ui';

interface FaucetProps {
  actor: any;
  principal: Principal | null;
  isLocal: boolean;
  onSignIn: () => void;
  /** Jump to the voting page so a dev can earn the "recent burn-vote" gate. */
  onGoVote: () => void;
}

// Mirror of the backend `FaucetStatus` record (bindings are `any` via the
// generated actor; we read the fields we render).
interface FaucetStatus {
  enabled: boolean;
  gate: any; // FaucetGate variant — {__kind__}
  registered: boolean;
  has_pool_neuron: boolean;
  voted_in_window: boolean;
  canister_claims_used: number;
  next_eligible_at: bigint;
  grant_usd_e8s: bigint;
  lifetime_cap: number;
  claim_window_ns: bigint;
  vote_window_ns: bigint;
  treasury_floor_e8s: bigint;
  est_grant_icp_e8s: bigint;
}

const E8S = 100_000_000;

function gateKind(gate: any): string {
  return gate?.__kind__ ?? String(gate);
}

/** Human-readable, actionable label for the blocking gate. */
function gateLabel(gate: any, claimWindowNs: bigint, voteWindowNs: bigint): string {
  const k = gateKind(gate);
  const days = (ns: bigint) => Math.round(Number(ns) / 86_400 / 1e9);
  switch (k) {
    case 'Eligible': return 'Eligible — you can claim now.';
    case 'FaucetDisabled': return 'The faucet is currently closed.';
    case 'CanisterNotRegistered': return 'Register your canister first (it must call register_faucet_canister on itself).';
    case 'NoPoolNeuron': return 'You need an active pool neuron (a Verified Follower) to claim.';
    case 'NotVotedInWindow': return `You must have burn-voted in the last ${days(voteWindowNs)} days.`;
    case 'ClaimedThisWeek': return `Already claimed this period (one claim per ${days(claimWindowNs)} days, per dev and per canister).`;
    case 'CanisterLifetimeReached': return 'This canister has reached its lifetime grant cap.';
    case 'TreasuryLow': return 'The treasury is at its floor — the faucet is paused until it recovers.';
    default: return k;
  }
}

function fmtUsd(e8s: bigint): string {
  return `$${(Number(e8s) / E8S).toFixed(2)}`;
}

function fmtIcp(e8s: bigint): string {
  if (!e8s || e8s === 0n) return '—';
  return `${(Number(e8s) / E8S).toFixed(4)} ICP`;
}

function fmtWhen(ns: bigint): string {
  if (!ns || ns === 0n) return 'now';
  const ms = Number(ns) / 1e6;
  if (!isFinite(ms) || ms <= Date.now()) return 'now';
  return new Date(ms).toLocaleString();
}

export default function Faucet({ actor, principal, isLocal, onSignIn, onGoVote }: FaucetProps) {
  const signedIn = !!principal && !principal.isAnonymous();
  const [canisterInput, setCanisterInput] = useState('');
  const [status, setStatus] = useState<FaucetStatus | null>(null);
  const [stats, setStats] = useState<{ total_claims: bigint; total_granted_icp_e8s: bigint } | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<'' | 'claim'>('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const parseCanister = useCallback((): Principal | null => {
    const t = canisterInput.trim();
    if (!t) return null;
    try { return Principal.fromText(t); } catch { return null; }
  }, [canisterInput]);

  const refresh = useCallback(async () => {
    if (!actor) return;
    setLoading(true);
    try {
      const cid = parseCanister();
      // Wrapper-layer binding: an `opt principal` ARG is `Principal | null`,
      // NOT the raw-declarations `[]`/`[x]` array. Passing an array throws and
      // leaves `status` null → the page falsely renders "faucet is closed".
      const [st, ss] = await Promise.all([
        actor.get_faucet_status(cid),
        actor.get_faucet_stats().catch(() => null),
      ]);
      setStatus(st as FaucetStatus);
      if (ss) setStats(ss);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [actor, parseCanister]);

  useEffect(() => { refresh(); }, [actor]); // initial + on actor change

  const claim = async () => {
    setError(null); setNotice(null);
    const cid = parseCanister();
    if (!cid) { setError('Enter a valid canister id.'); return; }
    setBusy('claim');
    try {
      const res = await actor.claim_faucet_cycles(cid);
      if (res?.__kind__ === 'Err') throw new Error(res.Err);
      setNotice(`Granted ${fmtUsd(status?.grant_usd_e8s ?? 0n)} of cycles to ${cid.toText()}.`);
      await refresh();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy('');
    }
  };

  const card: React.CSSProperties = {
    border: '1px solid var(--border)', borderRadius: 14, padding: 18,
    background: 'var(--surface)',
  };
  const eligible = gateKind(status?.gate) === 'Eligible';

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '24px 16px', display: 'grid', gap: 18 }}>
      <div>
        <Eyebrow accent>Cycles Faucet</Eyebrow>
        <h1 style={{ margin: '6px 0 4px', fontSize: 26 }}>Top up a canister you're building</h1>
        <p style={{ color: 'var(--fg-2)', margin: 0 }}>
          Engaged pool members can claim a small weekly cycles grant for a
          canister they control — paid from the protocol treasury.
        </p>
      </div>

      {!status?.enabled && (
        <div style={{ ...card, borderColor: 'var(--border-hi)' }}>
          <strong>The faucet is currently closed.</strong>
          <p style={{ color: 'var(--fg-2)', margin: '6px 0 0' }}>
            This feature ships dark and is enabled by the protocol owner.
          </p>
        </div>
      )}

      {status?.enabled && (
        <>
          <div style={card}>
            <Eyebrow>Grant</Eyebrow>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 4 }}>
              <span style={{ fontSize: 28, fontWeight: 700 }}>{fmtUsd(status.grant_usd_e8s)}</span>
              <span style={{ color: 'var(--fg-2)' }}>
                ≈ {fmtIcp(status.est_grant_icp_e8s)} of cycles, per claim
              </span>
            </div>
            <p style={{ color: 'var(--fg-2)', margin: '8px 0 0', fontSize: 13 }}>
              One claim per {Math.round(Number(status.claim_window_ns) / 86_400 / 1e9)} days, per developer and
              per canister. A canister can claim at most {status.lifetime_cap} times, ever.
            </p>
            <MoreInfo label="How the grant is priced" title="Pricing & delivery">
              The grant is fixed in USD and priced to ICP at claim time via the
              XRC oracle. The ICP is then converted to cycles by the IC's Cycles
              Minting Canister at its live XDR rate and minted straight into your
              canister, so the actual cycles delivered depend on the CMC rate.
            </MoreInfo>
          </div>

          <div style={card}>
            <Eyebrow>Your canister</Eyebrow>
            <p style={{ color: 'var(--fg-2)', margin: '4px 0 10px', fontSize: 13 }}>
              Registration is proof-of-control: your canister must call
              <code> register_faucet_canister()</code> on itself once. Then enter
              its id below to check eligibility and claim.
            </p>
            <input
              value={canisterInput}
              onChange={e => setCanisterInput(e.target.value)}
              onBlur={refresh}
              placeholder="aaaaa-aa"
              spellCheck={false}
              style={{
                width: '100%', padding: '10px 12px', borderRadius: 10,
                border: '1px solid var(--border-hi)', fontFamily: 'monospace', fontSize: 14,
              }}
            />

            <div style={{ display: 'grid', gap: 6, marginTop: 14 }}>
              <GateRow ok={status.registered} label="Canister registered" />
              <GateRow ok={status.has_pool_neuron} label="Active pool neuron" />
              <GateRow ok={status.voted_in_window} label={`Burn-voted in the last ${Math.round(Number(status.vote_window_ns) / 86_400 / 1e9)} days`} />
            </div>

            {status.registered && (
              <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Chip tone={status.canister_claims_used >= status.lifetime_cap ? 'danger' : 'muted'}>
                  {status.canister_claims_used} / {status.lifetime_cap} lifetime claims used
                </Chip>
                {!eligible && status.next_eligible_at > 0n && (
                  <Chip tone="muted">Next eligible: {fmtWhen(status.next_eligible_at)}</Chip>
                )}
              </div>
            )}

            <div style={{ marginTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {!signedIn ? (
                <Btn variant="primary" onClick={onSignIn}>Sign in to claim</Btn>
              ) : (
                <Btn
                  variant="primary"
                  disabled={!eligible || busy === 'claim'}
                  onClick={claim}
                  title={eligible ? 'Claim a cycles grant' : gateLabel(status.gate, status.claim_window_ns, status.vote_window_ns)}
                >
                  {busy === 'claim' ? 'Claiming…' : `Claim ${fmtUsd(status.grant_usd_e8s)} of cycles`}
                </Btn>
              )}
              {!status.voted_in_window && (
                <Btn variant="ghost" onClick={onGoVote}>Burn-vote to qualify</Btn>
              )}
              <Btn variant="ghost" onClick={refresh} disabled={loading}>
                <Icon name="refresh" size={14} /> Refresh
              </Btn>
            </div>

            {!eligible && (
              <p style={{ marginTop: 10, color: 'var(--fg-2)', fontSize: 13 }}>
                {gateLabel(status.gate, status.claim_window_ns, status.vote_window_ns)}
              </p>
            )}
            {error && <p style={{ marginTop: 10, color: 'var(--burn)', fontSize: 13 }}>{error}</p>}
            {notice && <p style={{ marginTop: 10, color: 'var(--fg-2)', fontSize: 13 }}>{notice}</p>}
          </div>

          {stats && (
            <div style={{ ...card, display: 'flex', gap: 24, flexWrap: 'wrap' }}>
              <Stat label="Grants all-time" value={String(stats.total_claims)} />
              <Stat label="ICP granted all-time" value={fmtIcp(stats.total_granted_icp_e8s)} />
            </div>
          )}

          {isLocal && (
            <p style={{ color: 'var(--fg-3)', fontSize: 12 }}>
              Local replica note (PB-148): end-to-end claims may not complete
              locally even with correct code — this is a known local-only ledger
              quirk and does not affect mainnet.
            </p>
          )}
        </>
      )}

      <p style={{ color: 'var(--fg-3)', fontSize: 12 }}>
        Signed in as {signedIn ? formatPrincipal(principal) : 'anonymous'}.
      </p>
    </div>
  );
}

function GateRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
      <Icon name={ok ? 'check' : 'x'} size={15} stroke={ok ? 'var(--sprout)' : 'var(--fg-3)'} />
      <span style={{ color: ok ? 'var(--fg)' : 'var(--fg-3)' }}>{label}</span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 20, fontWeight: 700 }}>{value}</div>
      <div style={{ color: 'var(--fg-2)', fontSize: 12 }}>{label}</div>
    </div>
  );
}
