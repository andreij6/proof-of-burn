import { useEffect, useState } from 'react';
import { Principal } from '@icp-sdk/core/principal';
import { BrandMark, Icon, LiveDot } from './ui';
import { friendlyVoucherErr } from './Vouchers';
import { FriendlyError, toFriendly } from './errors';

// ==========================================
// Golden Ticket claim — the standalone campaign page (#/claim).
//
// Landing-style full-bleed dark page, reachable signed-out; it IS the link
// shared on X/OpenChat. ONE claim path for now (owner 2026-07-10): sign in
// and claim. (The paste-a-principal path is built backend-side and can be
// re-enabled in the UI later;
// because ticket earning is server-side and jackpots pay the winner's wallet
// automatically. A Golden Ticket earns 1 lottery ticket per day for 60 days;
// tickets only — it can never redeem ICP and is never buyback-eligible.
// ==========================================

/** Validate a pasted claim destination: must parse as a principal AND be a
 *  self-authenticating USER principal (29 bytes) — rejects the anonymous
 *  principal (1 byte) and canister ids (opaque, ~10 bytes), which could never
 *  sign in anywhere to use the app. */
export function validateClaimPrincipal(text: string): { ok: true; principal: Principal } | { ok: false; err: string } {
  const t = text.trim();
  if (!t) return { ok: false, err: 'Paste your wallet principal.' };
  let p: Principal;
  try { p = Principal.fromText(t); } catch {
    return { ok: false, err: 'That doesn\'t parse as a principal — copy it exactly from your wallet.' };
  }
  if (p.isAnonymous()) return { ok: false, err: 'That\'s the anonymous principal — paste your own wallet principal.' };
  if (p.toUint8Array().length !== 29) {
    return { ok: false, err: 'That looks like a canister id, not a wallet principal — paste the principal your wallet shows for you.' };
  }
  return { ok: true, principal: p };
}

interface ClaimInfo {
  promo_open: boolean;
  promo_remaining: number;
}

interface ClaimPromoProps {
  actor: any;
  principal: Principal | null;
  onSignIn: () => void;
  /** Enter the app (points at the lottery). */
  onEnter: () => void;
}

const MONO = 'var(--font-mono)';
const DISPLAY = 'var(--font-display)';
const BODY = 'var(--font-body)';
const EYEBROW: React.CSSProperties = { fontFamily: MONO, fontSize: 11, fontWeight: 500, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--haze)' };

export default function ClaimPromo({ actor, principal, onSignIn, onEnter }: ClaimPromoProps) {
  const signedIn = !!principal && !principal.isAnonymous();
  const [info, setInfo] = useState<ClaimInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [claimed, setClaimed] = useState<{ id: bigint; to: string } | null>(null);

  const refresh = async () => {
    if (!actor) return;
    try {
      const i = await actor.get_bond_market();
      setInfo({ promo_open: i.promo_open, promo_remaining: i.promo_remaining });
    } catch { /* best-effort */ }
  };
  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [actor]);

  const claim = async (dest: Principal | null, label: string) => {
    if (busy) return;
    setBusy(label); setErr(null);
    try {
      const res = await actor.claim_golden_ticket(dest);
      if (res.__kind__ === 'Err') throw new FriendlyError(friendlyVoucherErr(res.Err), res.Err, 'claim');
      setClaimed({
        id: res.Ok,
        to: dest ? dest.toString() : (principal?.toString() ?? 'your account'),
      });
      await refresh();
    } catch (e: any) { setErr(toFriendly(e, 'claim')); }
    finally { setBusy(null); }
  };

  const claimSignedIn = () => claim(null, 'signin-claim');

  const primaryBtn: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, cursor: 'pointer',
    fontFamily: BODY, fontWeight: 700, borderRadius: 999, border: '1px solid transparent',
    height: 46, padding: '0 26px', fontSize: 15, background: 'var(--haze)', color: 'var(--char-950)',
  };

  const cardStyle: React.CSSProperties = {
    background: 'var(--char-900)', border: '1px solid var(--char-800)', borderRadius: 12,
    padding: 26, flex: '1 1 320px', minWidth: 300, display: 'flex', flexDirection: 'column', gap: 12,
  };

  const open = info?.promo_open ?? false;
  const remaining = info?.promo_remaining ?? 0;

  return (
    // Landing-style: always a dark surface, with the dark foreground vars
    // pinned so light mode can't flip the text (same trick as Landing.tsx).
    <div style={{
      background: 'var(--char-950)', minHeight: '100vh',
      ['--fg' as string]: '#FAF9F7',
      ['--fg-1' as string]: '#F5F4F2',
      ['--fg-2' as string]: '#A8A29E',
      ['--fg-3' as string]: '#78716C',
    } as React.CSSProperties}>
      {/* ── Nav ── */}
      <nav style={{ height: 56, borderBottom: '1px solid var(--char-800)' }}>
        <div style={{ maxWidth: 1080, margin: '0 auto', height: '100%', padding: '0 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <BrandMark size={24} />
            <span style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 18, letterSpacing: '-.02em', color: 'var(--fg)' }}>Cycle Burn</span>
          </div>
          <button onClick={onEnter} style={{ ...primaryBtn, height: 34, padding: '0 14px', fontSize: 13, background: 'var(--burn)' }}>
            Launch app →
          </button>
        </div>
      </nav>

      {/* ── Hero ── */}
      <section style={{ backgroundImage: 'repeating-linear-gradient(to bottom,transparent 0 23px,var(--char-800) 23px 24px)' }}>
        <div style={{ maxWidth: 860, margin: '0 auto', padding: '72px 24px 56px', textAlign: 'center' }}>
          <div style={EYEBROW}>golden ticket · no-loss lottery</div>
          <h1 style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 'clamp(40px, 8vw, 68px)', lineHeight: 1.02, letterSpacing: '-.03em', color: 'var(--fg)', margin: '16px 0 0', textWrap: 'balance' }}>
            Claim your<br />Golden Ticket.
          </h1>
          <p style={{ fontSize: 18, lineHeight: 1.55, color: 'var(--fg-2)', maxWidth: 520, margin: '20px auto 0' }}>
            60 days of free entries into the No-Loss Lottery — 1 ticket every day,
            automatically. Win, and the ICP jackpot pays straight to your wallet.
            Nothing to buy, nothing to lose, no strings.
          </p>
          {/* Scarcity, remaining-only (never a claimed-so-far count). */}
          {open && (
            <div style={{ marginTop: 22, display: 'inline-flex', alignItems: 'center', gap: 8, border: '1px solid var(--haze)', borderRadius: 999, padding: '8px 18px' }}>
              <LiveDot size={6} />
              <span style={{ fontFamily: MONO, fontSize: 13, color: 'var(--haze)', letterSpacing: '.04em' }}>
                {remaining.toLocaleString('en-US')} remaining
              </span>
            </div>
          )}
        </div>
      </section>

      <section style={{ maxWidth: 860, margin: '0 auto', padding: '0 24px 88px' }}>
        {claimed ? (
          /* ── Success ── */
          <div style={{ ...cardStyle, alignItems: 'center', textAlign: 'center', border: '1px solid var(--haze)', gap: 14 }}>
            <Icon name="spark" size={34} stroke="var(--haze)" />
            <h2 style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 32, letterSpacing: '-.02em', color: 'var(--fg)', margin: 0 }}>
              Golden Ticket #{String(claimed.id)} is yours.
            </h2>
            <p style={{ fontSize: 15, lineHeight: 1.6, color: 'var(--fg-2)', maxWidth: 460, margin: 0 }}>
              Claimed to <span style={{ fontFamily: MONO, fontSize: 13, color: 'var(--fg-1)', wordBreak: 'break-all' }}>{claimed.to}</span>.
              For the next <b style={{ color: 'var(--fg-1)' }}>60 days</b> a free ticket lands every
              day and enters every drawing — win and the ICP arrives in that wallet
              automatically. There is nothing else to do.
            </p>
            <p style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--fg-2)', maxWidth: 460, margin: 0 }}>
              Want better odds than 1 ticket a day? Staking earns <b style={{ color: 'var(--fg-1)' }}>5–20 tickets
              per ICP, every day</b> — and your ICP is never at risk.
            </p>
            <button onClick={onEnter} style={{ ...primaryBtn, background: 'var(--burn)' }}>Stake for real odds →</button>
          </div>
        ) : !info ? (
          <div style={{ ...cardStyle, alignItems: 'center' }}>
            <LiveDot size={9} color="var(--haze)" />
            <span style={{ color: 'var(--fg-2)', fontSize: 14 }}>Checking the campaign…</span>
          </div>
        ) : !open ? (
          /* ── Closed / exhausted ── */
          <div style={{ ...cardStyle, alignItems: 'center', textAlign: 'center' }}>
            <Icon name="clock" size={26} stroke="var(--fg-3)" />
            <h2 style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 26, color: 'var(--fg)', margin: 0 }}>
              {remaining === 0 ? 'All Golden Tickets are claimed.' : 'The campaign isn\'t open right now.'}
            </h2>
            <p style={{ fontSize: 14.5, lineHeight: 1.6, color: 'var(--fg-2)', maxWidth: 440, margin: 0 }}>
              {remaining === 0
                ? 'This drop is over — but the lottery never closes. Staking earns 5–20 free tickets per ICP every day, and your principal is never at risk.'
                : 'Follow us on X or OpenChat to catch the next drop — or skip the wait: staking earns 5–20 free tickets per ICP every day.'}
            </p>
            <button onClick={onEnter} style={{ ...primaryBtn, background: 'var(--burn)' }}>Explore the lottery →</button>
          </div>
        ) : (
          /* ── The two claim paths ── */
          <>
            {err && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', border: '1px solid var(--ember)', borderRadius: 10, padding: '10px 14px', marginBottom: 16, color: 'var(--ember)', fontSize: 13.5 }}>
                <Icon name="x" size={14} stroke="var(--ember)" /> {err}
              </div>
            )}
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              {/* Path A: sign in */}
              <div style={cardStyle}>
                <h3 style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 24, letterSpacing: '-.02em', color: 'var(--fg)', margin: 0 }}>
                  Sign in &amp; claim
                </h3>
                <p style={{ fontSize: 14, lineHeight: 1.55, color: 'var(--fg-2)', margin: 0, flex: 1 }}>
                  Sign in (~30 seconds) to create your account and the ticket lands on
                  it — you can watch your entries and winnings in the app.
                </p>
                {signedIn ? (
                  <button onClick={claimSignedIn} disabled={busy !== null} style={{ ...primaryBtn, opacity: busy ? 0.7 : 1 }}>
                    {busy === 'signin-claim' ? <LiveDot size={8} color="var(--char-950)" /> : <Icon name="spark" size={15} stroke="var(--char-950)" />}
                    Claim my Golden Ticket
                  </button>
                ) : (
                  <button onClick={onSignIn} style={primaryBtn}>
                    <Icon name="key" size={15} stroke="var(--char-950)" /> Sign in to claim
                  </button>
                )}
              </div>

            </div>

            {/* The honest fine print. */}
            <p style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--fg-3)', maxWidth: 640, margin: '22px auto 0', textAlign: 'center' }}>
              One Golden Ticket per account. It earns 1 lottery ticket per day for 60
              days, then expires — tickets only; it never holds or redeems ICP and
              can't be sold or transferred. Drawings run three times a week once the
              pot and player thresholds are met.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
