import { useEffect, useState } from 'react';
import { Principal } from '@icp-sdk/core/principal';
import { Btn, Chip, Eyebrow, Icon, LiveDot, Skeleton, MoreInfo } from './ui';

// ==========================================
// ANSEM LP — Solana liquidity providers earn lottery tickets.
//
// Prove you own a Solana wallet (Phantom/Solflare signMessage — verified
// in-canister), then once per lottery round hit "Confirm LP": the backend
// derives your associated token account for each configured $ANSEM LP mint
// and reads the LIVE balance through the NNS SOL RPC canister. Any balance
// over the floor pays 10 tickets into the CURRENT drawing. After each
// drawing the round bumps and the claim re-arms — that's the re-confirmation.
// Staking ICP is required (tickets are stakers-only platform-wide).
// ==========================================

/** The EXACT challenge string the backend verifies — any drift fails. */
export function lpChallengeMessage(principalText: string, round: bigint, nonce: bigint, expiresNs: bigint): string {
  return `Cycle Burn LP verification\nprincipal: ${principalText}\nround: ${round}\nnonce: ${nonce}\nexpires_ns: ${expiresNs}`;
}

/** Friendly copy for the claim/link error codes. */
export function friendlyLpErr(code: string): string {
  switch (code) {
    case 'NOT_STAKED': return 'Tickets are stakers-only — stake any amount of ICP to activate LP rewards.';
    case 'NO_WALLET_LINKED': return 'Link your Solana wallet first.';
    case 'ALREADY_CLAIMED_THIS_ROUND': return 'Already confirmed for this drawing — come back after it settles.';
    case 'NO_QUALIFYING_LP': return 'No qualifying $ANSEM LP found in this wallet right now.';
    case 'NO_POOLS_CONFIGURED': return 'No pools are configured yet — check back soon.';
    case 'WALLET_ALREADY_LINKED': return 'That wallet is already linked to a different account.';
    case 'CHALLENGE_EXPIRED': return 'The signature challenge expired — try again.';
    case 'SIGNATURE_INVALID': return 'The wallet signature didn\'t verify — try again.';
    default: return code;
  }
}

interface LpInfo {
  enabled: boolean;
  round: bigint;
  tickets_per_round: bigint;
  my_wallet_b58?: string | null;
  claimed_this_round: boolean;
  staked: boolean;
  pools: { name: string; lp_mint_b58: string; token_2022: boolean; min_amount: bigint }[];
}

interface AnsemLpProps {
  actor: any;
  principal: Principal | null;
  onSignIn: () => void;
  onGoParticipate: () => void;
}

export default function AnsemLp({ actor, principal, onSignIn, onGoParticipate }: AnsemLpProps) {
  const signedIn = !!principal && !principal.isAnonymous();
  const [info, setInfo] = useState<LpInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = async () => {
    if (!actor) return;
    try { setInfo(await actor.get_lp_reward_info()); } catch { /* best-effort */ }
  };
  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [actor, signedIn]);

  const wallet = () => (window as any).solana ?? (window as any).solflare;

  const linkWallet = async () => {
    if (busy) return;
    setBusy('link'); setErr(null); setNotice(null);
    try {
      const provider = wallet();
      if (!provider?.signMessage) {
        throw new Error('No Solana wallet found — install Phantom (or Solflare) and reload.');
      }
      await provider.connect();
      const pubkey: Uint8Array = provider.publicKey.toBytes();
      const round = info?.round ?? 0n;
      const nonce = BigInt(Math.floor(Math.random() * 2 ** 52));
      const expiresNs = BigInt(Date.now() + 10 * 60 * 1000) * 1_000_000n;
      const msg = lpChallengeMessage(principal!.toString(), round, nonce, expiresNs);
      const signed = await provider.signMessage(new TextEncoder().encode(msg), 'utf8');
      const signature: Uint8Array = signed.signature ?? signed; // Phantom returns {signature}
      const res = await actor.link_solana_wallet(pubkey, signature, nonce, expiresNs);
      if (res.__kind__ === 'Err') throw new Error(friendlyLpErr(res.Err));
      setNotice(`Wallet linked: ${res.Ok.slice(0, 4)}…${res.Ok.slice(-4)}`);
      await refresh();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(null); }
  };

  const unlink = async () => {
    if (busy) return;
    setBusy('unlink'); setErr(null);
    try { await actor.unlink_solana_wallet(); await refresh(); }
    catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(null); }
  };

  const claim = async () => {
    if (busy) return;
    setBusy('claim'); setErr(null); setNotice(null);
    try {
      const res = await actor.claim_lp_reward();
      if (res.__kind__ === 'Err') throw new Error(friendlyLpErr(res.Err));
      setNotice(`Confirmed! ${res.Ok.tickets} tickets added to drawing #${res.Ok.round} (pool: ${res.Ok.pool}).`);
      await refresh();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(null); }
  };

  const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;

  return (
    <div className="dashboard-container">
      {/* ── Header ── */}
      <div className="col" style={{ gap: 6 }}>
        <span className="row" style={{ gap: 8 }}>
          <Icon name="droplet" size={16} stroke="var(--burn-ink)" />
          <Eyebrow accent>Earn tickets</Eyebrow>
        </span>
        <b style={{ fontSize: 17 }}>Provide $ANSEM liquidity. Earn lottery tickets.</b>
        <span style={{ fontSize: 12.5, color: 'var(--fg-2)', maxWidth: 660 }}>
          Hold $ANSEM LP on Solana? Prove the wallet is yours and collect{' '}
          {Number(info?.tickets_per_round ?? 10n)} tickets into every drawing — re-confirmed
          each round, read live from the Solana chain.{' '}
          <MoreInfo title="How ANSEM LP rewards work">
            <div className="card col" style={{ gap: 8, borderColor: 'var(--burn)', background: 'color-mix(in srgb, var(--burn) 12%, var(--surface))' }}>
              <Eyebrow accent>The gist</Eyebrow>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
                <b>Provide $ANSEM liquidity on Solana, collect lottery tickets here.</b>{' '}Link your wallet once, then confirm each drawing — 10 tickets per round, read live from the Solana chain.
              </p>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <Eyebrow accent>Linking your wallet</Eyebrow>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                <li><b>One signature, once:</b> your Solana wallet (Phantom or Solflare) signs a challenge message — free, nothing goes on-chain.</li>
                <li><b>Verified on the Internet Computer:</b> the canister checks the signature itself; the challenge embeds your account and an expiry so it can't be replayed.</li>
                <li><b>One wallet, one account</b> — a wallet can never earn for two people.</li>
              </ul>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <Eyebrow accent>Confirming each drawing</Eyebrow>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                <li><b>Hit Confirm LP once per round:</b> the app reads your live LP balance straight from Solana — three independent RPC providers must agree.</li>
                <li><b>10 tickets land in the current drawing</b> when a qualifying balance is found.</li>
                <li><b>Re-confirm after each drawing:</b> the round advances and the button re-arms. Sold the LP? The next confirmation finds nothing.</li>
              </ul>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <Eyebrow accent>The fine print</Eyebrow>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                <li><b>Stakers-only:</b> tickets require an active ICP stake (any amount), like everywhere on the platform.</li>
                <li><b>Custodial wallets can't sign</b> — you need a wallet with message signing (Phantom, Solflare).</li>
              </ul>
            </div>
          </MoreInfo>
        </span>
      </div>

      {!signedIn ? (
        <div className="card col" style={{ gap: 10, alignItems: 'flex-start' }}>
          <b style={{ fontSize: 14 }}>Sign in to link your wallet</b>
          <Btn variant="primary" onClick={onSignIn}>
            <Icon name="key" size={13} stroke="var(--char-950)" /> Sign in
          </Btn>
        </div>
      ) : (
        <>
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

          {signedIn && info === null ? (
            <div className="row" style={{ gap: 14, flexWrap: 'wrap' }} aria-busy="true" aria-label="Loading LP status">
              {[0, 1].map((i) => <Skeleton key={i} width={260} height={120} radius={10} style={{ flex: '1 1 260px' }} />)}
            </div>
          ) : (
          <div className="row" style={{ gap: 14, alignItems: 'stretch', flexWrap: 'wrap' }}>
            {/* ── Step 1: wallet ── */}
            <div className="card col" style={{ gap: 10, flex: '1 1 260px', minWidth: 260 }}>
              <Eyebrow>1 · Your Solana wallet</Eyebrow>
              {info?.my_wallet_b58 ? (
                <>
                  <Chip tone="ok" style={{ alignSelf: 'flex-start' }}>
                    <Icon name="checkCircle" size={11} /> <span className="mono">{short(info.my_wallet_b58)}</span>
                  </Chip>
                  <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>
                    Ownership proven by signature. Linked once — no need to re-sign each round.
                  </span>
                  <Btn variant="ghost" sm onClick={unlink} disabled={busy !== null} style={{ alignSelf: 'flex-start' }}>
                    {busy === 'unlink' ? <LiveDot size={7} /> : <Icon name="x" size={11} />} Unlink
                  </Btn>
                </>
              ) : (
                <>
                  <span style={{ fontSize: 12.5, color: 'var(--fg-2)', flex: 1 }}>
                    Connect Phantom (or Solflare) and sign a one-time message — free,
                    nothing goes on-chain.
                  </span>
                  <Btn variant="primary" onClick={linkWallet} disabled={busy !== null}>
                    {busy === 'link' ? <LiveDot size={8} /> : <Icon name="key" size={13} stroke="var(--char-950)" />} Connect & sign
                  </Btn>
                </>
              )}
            </div>

            {/* ── Step 2: confirm each round ── */}
            <div className="card col" style={{ gap: 10, flex: '1 1 260px', minWidth: 260, border: '1px solid var(--burn)', background: 'color-mix(in srgb, var(--burn) 10%, var(--surface))' }}>
              <Eyebrow accent>2 · Drawing #{Number(info?.round ?? 0n)}</Eyebrow>
              {!info?.staked ? (
                <>
                  <span style={{ fontSize: 12.5, color: 'var(--fg-2)', flex: 1 }}>
                    Tickets are stakers-only. Stake any amount of ICP to activate LP
                    rewards.
                  </span>
                  <Btn variant="primary" onClick={onGoParticipate}>
                    <Icon name="zap" size={13} stroke="var(--char-950)" /> Stake ICP
                  </Btn>
                </>
              ) : info?.claimed_this_round ? (
                <>
                  <Chip tone="ok" style={{ alignSelf: 'flex-start' }}>
                    <Icon name="checkCircle" size={11} /> Confirmed for this drawing
                  </Chip>
                  <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>
                    {Number(info.tickets_per_round)} tickets are in. Re-confirm after the
                    drawing settles to earn again.
                  </span>
                </>
              ) : (
                <>
                  <span style={{ fontSize: 12.5, color: 'var(--fg-2)', flex: 1 }}>
                    Reads your live LP balance from Solana and pays{' '}
                    {Number(info?.tickets_per_round ?? 10n)} tickets into the current
                    drawing.
                  </span>
                  <Btn variant="primary" onClick={claim} disabled={busy !== null || !info?.my_wallet_b58}>
                    {busy === 'claim' ? <LiveDot size={8} /> : <Icon name="ticket" size={13} stroke="var(--char-950)" />} Confirm LP · +{Number(info?.tickets_per_round ?? 10n)} tickets
                  </Btn>
                  {!info?.my_wallet_b58 && (
                    <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>Link your wallet first (step 1).</span>
                  )}
                </>
              )}
            </div>
          </div>
          )}

          {/* ── Qualifying pools ── */}
          <div className="card col" style={{ gap: 8 }}>
            <span className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
              <b style={{ fontSize: 13.5 }}>Qualifying pools</b>
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>read live via the SOL RPC canister</span>
            </span>
            {(info?.pools?.length ?? 0) === 0 ? (
              <span style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>No pools configured yet.</span>
            ) : (
              info!.pools.map((p) => (
                <span key={p.lp_mint_b58} className="row" style={{ gap: 8, justifyContent: 'space-between', fontSize: 12.5, padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
                  <span className="row" style={{ gap: 8 }}>
                    <Icon name="droplet" size={12} stroke="var(--burn-ink)" /> {p.name}
                    {p.token_2022 && <Chip tone="muted" style={{ height: 17, fontSize: 9.5 }}>Token-2022</Chip>}
                  </span>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>LP mint {short(p.lp_mint_b58)}</span>
                </span>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
