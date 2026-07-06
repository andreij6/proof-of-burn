import { useEffect, useRef, useState } from 'react';
import { Principal } from '@icp-sdk/core/principal';
import { Btn, Chip, Eyebrow, Icon, LiveDot, MoreInfo, fmtICP } from './ui';
import { createActor as createLedgerActor } from './bindings/ledger';
import { StakeTier } from './bindings/backend';
import { lpChallengeMessage, friendlyLpErr } from './AnsemLp';

// ==========================================
// Degen Fast Lane — the 5-minute path from "Solana wallet, zero ICP" to
// "tickets flowing": sign in (passkey, no seed phrase) → optionally connect
// Phantom (lights up Solana LP rewards later) → fund the account with ICP →
// one-tap stake of 1 ICP → done. Every step is auto-detected and skips
// itself when already satisfied, so campaign visitors land exactly where
// they left off.
// ==========================================

/** How much the quick-stake locks (6-month tier → 5 tickets/day). */
export const FAST_LANE_STAKE_E8S = 100_000_000n; // 1 ICP
/** Funding target: the stake + one ledger fee of headroom. */
export const FAST_LANE_FUND_TARGET_E8S = FAST_LANE_STAKE_E8S + 10_000n;

export type FastLaneStep = 'signin' | 'fund' | 'stake' | 'done';

/** Pure step derivation — the stepper always lands the user on the first
 *  unsatisfied step (Phantom linking is an optional side-quest, never a gate). */
export function deriveFastLaneStep(signedIn: boolean, balanceE8s: bigint, staked: boolean): FastLaneStep {
  if (!signedIn) return 'signin';
  if (staked) return 'done';
  if (balanceE8s >= FAST_LANE_FUND_TARGET_E8S) return 'stake';
  return 'fund';
}

interface FastLaneProps {
  actor: any;
  identity: any;
  principal: Principal | null;
  host: string;
  rootKey?: Uint8Array;
  ledgerCanisterId: string;
  onSignIn: () => void;
  /** After staking: continue to the lottery. */
  onGoLottery: () => void;
}

export default function FastLane({ actor, identity, principal, host, rootKey, ledgerCanisterId, onSignIn, onGoLottery }: FastLaneProps) {
  const signedIn = !!principal && !principal.isAnonymous();
  const [balance, setBalance] = useState<bigint>(0n);
  const [staked, setStaked] = useState(false);
  const [walletB58, setWalletB58] = useState<string | null>(null);
  const [lpRound, setLpRound] = useState<bigint>(0n);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = async () => {
    if (!actor || !signedIn) return;
    try {
      const info = await actor.get_lp_reward_info();
      setStaked(info.staked);
      setWalletB58(info.my_wallet_b58 ?? null);
      setLpRound(info.round);
    } catch { /* best-effort */ }
    try {
      const ledger = createLedgerActor(ledgerCanisterId, { agentOptions: { host, identity, rootKey } });
      setBalance(await ledger.icrc1_balance_of({ owner: principal! }));
    } catch { /* best-effort */ }
  };
  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [actor, signedIn]);

  const step = deriveFastLaneStep(signedIn, balance, staked);

  // While waiting on funding, poll the balance so the wizard advances the
  // moment the exchange withdrawal lands.
  useEffect(() => {
    if (step !== 'fund') {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    pollRef.current = setInterval(refresh, 10_000);
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const copyPrincipal = async () => {
    try {
      await navigator.clipboard.writeText(principal!.toString());
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard denied */ }
  };

  const connectPhantom = async () => {
    if (busy) return;
    setBusy('phantom'); setErr(null); setNotice(null);
    try {
      const provider = (window as any).solana ?? (window as any).solflare;
      if (!provider?.signMessage) throw new Error('No Solana wallet found — install Phantom and reload.');
      await provider.connect();
      const pubkey: Uint8Array = provider.publicKey.toBytes();
      const nonce = BigInt(Math.floor(Math.random() * 2 ** 52));
      const expiresNs = BigInt(Date.now() + 10 * 60 * 1000) * 1_000_000n;
      const msg = lpChallengeMessage(principal!.toString(), lpRound, nonce, expiresNs);
      const signed = await provider.signMessage(new TextEncoder().encode(msg), 'utf8');
      const res = await actor.link_solana_wallet(pubkey, signed.signature ?? signed, nonce, expiresNs);
      if (res.__kind__ === 'Err') throw new Error(friendlyLpErr(res.Err));
      setNotice('Phantom linked — Solana LP rewards are live for this account.');
      await refresh();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(null); }
  };

  const quickStake = async () => {
    if (busy) return;
    setBusy('stake'); setErr(null); setNotice(null);
    try {
      const ledger = createLedgerActor(ledgerCanisterId, { agentOptions: { host, identity, rootKey } });
      const depositAccount = await actor.get_stake_deposit_address();
      const xfer = await ledger.icrc1_transfer({
        to: { owner: depositAccount.owner, subaccount: depositAccount.subaccount },
        amount: FAST_LANE_STAKE_E8S,
      });
      if (xfer.__kind__ === 'Err') {
        throw new Error(`Deposit transfer failed: ${JSON.stringify(xfer.Err, (_k, v) => typeof v === 'bigint' ? v.toString() : v)}`);
      }
      const res = await actor.stake(FAST_LANE_STAKE_E8S, StakeTier.SixMonths);
      if (res.__kind__ === 'Err') throw new Error(`Stake failed: ${res.Err}`);
      setNotice('Staked! Tickets start flowing today.');
      await refresh();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(null); }
  };

  const stepIndex = { signin: 0, fund: 1, stake: 2, done: 3 }[step];
  const dot = (i: number, label: string) => (
    <span key={label} className="row" style={{ gap: 6, alignItems: 'center' }}>
      <span style={{
        width: 22, height: 22, borderRadius: 11, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 11, fontWeight: 700,
        background: i < stepIndex ? 'var(--sprout)' : i === stepIndex ? 'var(--burn)' : 'var(--bg-alt)',
        color: i <= stepIndex ? 'var(--char-950)' : 'var(--fg-3)',
        border: i > stepIndex ? '1px solid var(--border)' : 'none',
      }}>{i < stepIndex ? '✓' : i + 1}</span>
      <span style={{ fontSize: 11.5, color: i === stepIndex ? 'var(--fg)' : 'var(--fg-3)', fontWeight: i === stepIndex ? 600 : 400 }}>{label}</span>
    </span>
  );

  return (
    <div className="dashboard-container">
      {/* ── Header ── */}
      <div className="col" style={{ gap: 6 }}>
        <span className="row" style={{ gap: 8 }}>
          <Icon name="zap" size={16} stroke="var(--burn-ink)" />
          <Eyebrow accent>Fast lane</Eyebrow>
        </span>
        <b style={{ fontSize: 17 }}>From Solana wallet to tickets flowing — about 5 minutes.</b>
        <span style={{ fontSize: 12.5, color: 'var(--fg-2)', maxWidth: 660 }}>
          The lottery where the house burns instead of you. No seed phrase, no buy-in
          at risk: stake 1 ICP, collect free tickets every day, unstake whenever.{' '}
          <MoreInfo title="Why this is different">
            <div className="card col" style={{ gap: 8, borderColor: 'var(--burn)', background: 'color-mix(in srgb, var(--burn) 12%, var(--surface))' }}>
              <Eyebrow accent>The gist</Eyebrow>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
                <b>Lossless.</b> Nobody pays into the lottery — the prize pool is
                funded by staking yield. Your ICP stays yours, tickets are free, and
                winnings pay straight to your wallet.
              </p>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <Eyebrow accent>The path</Eyebrow>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                <li><b>Sign in with a passkey</b> (Internet Identity) — FaceID/fingerprint, no seed phrase to lose.</li>
                <li><b>Fund with 1 ICP</b> from any exchange — your deposit address is one copy button away.</li>
                <li><b>One-tap stake</b> → 5 free tickets a day, more per ICP and for longer terms.</li>
                <li><b>Optional:</b> connect Phantom to activate Solana LP rewards on this account.</li>
              </ul>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <Eyebrow accent>Exit anytime</Eyebrow>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                <li><b>Unstake in full whenever</b> — the neuron dissolves over its term and every e8 comes back.</li>
              </ul>
            </div>
          </MoreInfo>
        </span>
      </div>

      {/* ── Stepper ── */}
      <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
        {dot(0, 'Sign in')}
        {dot(1, 'Fund 1 ICP')}
        {dot(2, 'Stake')}
        {dot(3, 'Tickets flowing')}
      </div>

      {notice && (
        <div className="row" style={{ gap: 8, border: '1px solid var(--sprout)', borderRadius: 8, padding: '8px 12px', fontSize: 12.5, color: 'var(--sprout-ink)' }}>
          <Icon name="checkCircle" size={14} stroke="var(--sprout-ink)" /> {notice}
        </div>
      )}
      {err && (
        <div className="row" style={{ gap: 8, border: '1px solid var(--ember)', borderRadius: 8, padding: '8px 12px', fontSize: 12.5, color: 'var(--ember)' }}>
          <Icon name="x" size={14} stroke="var(--ember)" /> {err}
        </div>
      )}

      {/* ── The active step ── */}
      {step === 'signin' && (
        <div className="card col" style={{ gap: 10, alignItems: 'flex-start' }}>
          <b style={{ fontSize: 14 }}>1 · Sign in with a passkey</b>
          <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
            Internet Identity: FaceID or fingerprint, ~30 seconds, nothing to write
            down. It becomes your account here.
          </span>
          <Btn variant="primary" onClick={onSignIn}>
            <Icon name="key" size={13} stroke="var(--char-950)" /> Sign in / create passkey
          </Btn>
        </div>
      )}

      {step === 'fund' && (
        <div className="card col" style={{ gap: 10 }}>
          <b style={{ fontSize: 14 }}>2 · Send 1 ICP to your account</b>
          <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
            Withdraw ICP from any exchange (Coinbase, Binance, Kraken…) to this
            principal — most arrive in under a minute. This page advances by itself
            when it lands.
          </span>
          <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <span className="mono" style={{ fontSize: 10.5, background: 'var(--bg-alt)', padding: '4px 8px', borderRadius: 6, wordBreak: 'break-all', userSelect: 'all' }}>
              {principal?.toString()}
            </span>
            <Btn variant="secondary" sm onClick={copyPrincipal}>
              <Icon name={copied ? 'check' : 'copy'} size={11} /> {copied ? 'Copied' : 'Copy'}
            </Btn>
          </span>
          <span className="row" style={{ gap: 8, fontSize: 12.5, color: 'var(--fg-2)' }}>
            <LiveDot size={7} color="var(--burn-ink)" />
            Watching for the deposit… balance: <span className="mono">{fmtICP(balance)} ICP</span>
            <Btn variant="ghost" sm onClick={refresh}>check now</Btn>
          </span>
        </div>
      )}

      {step === 'stake' && (
        <div className="card col" style={{ gap: 10, alignItems: 'flex-start', border: '1px solid var(--burn)', background: 'color-mix(in srgb, var(--burn) 10%, var(--surface))' }}>
          <b style={{ fontSize: 14 }}>3 · Stake 1 ICP — one tap</b>
          <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
            Locks 1 ICP in the 6-month pooled neuron → <b>5 free tickets every
            day</b>, and it activates every other reward on the platform. Unstake
            whenever; your ICP comes back in full.
          </span>
          <Btn variant="primary" onClick={quickStake} disabled={busy !== null}>
            {busy === 'stake' ? <LiveDot size={8} /> : <Icon name="zap" size={13} stroke="var(--char-950)" />} Stake 1 ICP
          </Btn>
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>balance: {fmtICP(balance)} ICP</span>
        </div>
      )}

      {step === 'done' && (
        <div className="card col" style={{ gap: 10, alignItems: 'flex-start', border: '1px solid var(--sprout)' }}>
          <b style={{ fontSize: 14 }}>You're in — tickets are flowing 🎟</b>
          <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
            Free tickets land daily. Drawings run three times a week; winnings pay
            straight to your wallet. Boost your odds in the daily game competitions
            or with LP rewards.
          </span>
          <Btn variant="primary" onClick={onGoLottery}>
            <Icon name="ticket" size={13} stroke="var(--char-950)" /> See the lottery
          </Btn>
        </div>
      )}

      {/* ── Optional: Phantom side-quest (never blocks the lane) ── */}
      {signedIn && (
        <div className="card col" style={{ gap: 8 }}>
          <span className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
            <b style={{ fontSize: 13.5 }}>Optional: connect Phantom</b>
            {walletB58 && <Chip tone="ok"><Icon name="checkCircle" size={11} /> <span className="mono">{walletB58.slice(0, 4)}…{walletB58.slice(-4)}</span></Chip>}
          </span>
          <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
            One free signature links your Solana wallet — providing $ANSEM liquidity
            then earns bonus tickets here every drawing.
          </span>
          {!walletB58 && (
            <Btn variant="secondary" sm onClick={connectPhantom} disabled={busy !== null} style={{ alignSelf: 'flex-start' }}>
              {busy === 'phantom' ? <LiveDot size={7} /> : <Icon name="droplet" size={12} />} Connect & sign
            </Btn>
          )}
        </div>
      )}
    </div>
  );
}
