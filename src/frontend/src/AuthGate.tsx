import { BrandMark, Icon, LiveDot } from './ui';

// ==========================================
// Auth gate — the standalone sign-in page (#/auth).
//
// ONE job: get the visitor signed in. Every page except the landing page and
// the Golden Ticket claim page requires a signed-in principal; the App router
// bounces unauthenticated visitors here (remembering where they were headed)
// and returns them there after Internet Identity completes. Because of this
// gate, in-app pages never render signed-out and carry no sign-in UI.
//
// Landing-style full-bleed dark page (same pinned-foreground trick as
// Landing.tsx / ClaimPromo.tsx so light mode can't flip the text).
// ==========================================

const MONO = 'var(--font-mono)';
const DISPLAY = 'var(--font-display)';
const BODY = 'var(--font-body)';
const EYEBROW: React.CSSProperties = { fontFamily: MONO, fontSize: 11, fontWeight: 500, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--haze)' };

interface AuthGateProps {
  onSignIn: () => void;
  isSigningIn: boolean;
  /** Back out to the public landing page. */
  onGoLanding: () => void;
}

export default function AuthGate({ onSignIn, isSigningIn, onGoLanding }: AuthGateProps) {
  const primaryBtn: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    cursor: isSigningIn ? 'default' : 'pointer', opacity: isSigningIn ? 0.75 : 1,
    fontFamily: BODY, fontWeight: 700, borderRadius: 999, border: '1px solid transparent',
    height: 48, padding: '0 30px', fontSize: 15.5, background: 'var(--burn)', color: 'var(--char-950)',
  };

  return (
    <div style={{
      background: 'var(--char-950)', minHeight: '100vh', display: 'flex', flexDirection: 'column',
      ['--fg' as string]: '#FAF9F7',
      ['--fg-1' as string]: '#F5F4F2',
      ['--fg-2' as string]: '#A8A29E',
      ['--fg-3' as string]: '#78716C',
    } as React.CSSProperties}>
      {/* ── Nav ── */}
      <nav style={{ height: 56, borderBottom: '1px solid var(--char-800)', flexShrink: 0 }}>
        <div style={{ maxWidth: 1080, margin: '0 auto', height: '100%', padding: '0 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <BrandMark size={24} />
            <span style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 18, letterSpacing: '-.02em', color: 'var(--fg)' }}>Cycle Burn</span>
          </div>
          <button
            onClick={onGoLanding}
            style={{
              background: 'transparent', border: '1px solid var(--char-800)', borderRadius: 999,
              cursor: 'pointer', color: 'var(--fg-2)', padding: '7px 16px', fontSize: 13, fontFamily: BODY, fontWeight: 600,
            }}
          >
            ← Back to home
          </button>
        </div>
      </nav>

      {/* ── The one job ── */}
      <section style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '48px 24px',
        backgroundImage: 'repeating-linear-gradient(to bottom,transparent 0 23px,var(--char-800) 23px 24px)',
      }}>
        <div style={{
          background: 'var(--char-900)', border: '1px solid var(--char-800)', borderRadius: 14,
          padding: '44px 36px', maxWidth: 440, width: '100%', display: 'flex', flexDirection: 'column',
          alignItems: 'center', textAlign: 'center', gap: 18,
        }}>
          <div style={EYEBROW}>members only past this point</div>
          <h1 style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 'clamp(30px, 6vw, 40px)', lineHeight: 1.05, letterSpacing: '-.03em', color: 'var(--fg)', margin: 0, textWrap: 'balance' }}>
            Sign in to continue.
          </h1>
          <p style={{ fontSize: 15, lineHeight: 1.6, color: 'var(--fg-2)', margin: 0 }}>
            Your account is your wallet — tickets, stakes, and winnings all live on
            it. Sign in with Internet Identity: passwordless, takes about 30 seconds,
            and nothing to install.
          </p>
          <button onClick={onSignIn} disabled={isSigningIn} style={primaryBtn}>
            {isSigningIn
              ? <><LiveDot size={8} color="var(--char-950)" /> Opening Internet Identity…</>
              : <><Icon name="key" size={15} stroke="var(--char-950)" /> Sign in</>}
          </button>
          <span style={{ fontSize: 13, color: 'var(--fg-3)' }}>
            New here?{' '}
            <button
              onClick={onGoLanding}
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--fg-2)', fontSize: 13, textDecoration: 'underline', fontFamily: BODY }}
            >
              See how the No-Loss Lottery works
            </button>
          </span>
        </div>
      </section>
    </div>
  );
}
