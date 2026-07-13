import { Eyebrow, Icon, usePageHelp } from './ui';
import BullRun from './arcade/BullRun';

// ==========================================
// Bull Run — dedicated page (nav: Play to Earn).
// The page owns the standard header; the game lives in arcade/BullRun.tsx.
// ==========================================

interface BullRunPageProps {
  actor: any;
  /** Navigate to staking — the daily competition's gate CTA. */
  onGoParticipate: () => void;
  isLocal?: boolean;
}

// Members-only (the #/auth gate guarantees a signed-in caller).
export default function BullRunPage({ actor, onGoParticipate, isLocal = false }: BullRunPageProps) {

  usePageHelp(() => (
    <>
            <div className="card col" style={{ gap: 8, borderColor: 'var(--burn)', background: 'color-mix(in srgb, var(--burn) 12%, var(--surface))' }}>
              <Eyebrow accent>The gist</Eyebrow>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
                <b>You are the bull. The street never ends — ten hits do.</b>{' '}Charge through the crowd, hoard coins, and survive an ever-faster, ever-denser street.
              </p>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <Eyebrow accent>Running</Eyebrow>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                <li><b>←/→ cut across three lanes; ↑/SPACE jumps</b> barriers and barrel stacks.</li>
                <li><b>Carts are too tall to jump</b> — go around.</li>
                <li><b>Stumbles halve your speed</b> (a brief grace stops chain hits); the tenth hit ends the run.</li>
              </ul>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <Eyebrow accent>It gets harder</Eyebrow>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                <li><b>You accelerate with distance</b> — the street comes at you faster the deeper you charge.</li>
                <li><b>Obstacles pack tighter</b> and more of them block two lanes at once (never all three).</li>
                <li><b>The crowd thickens</b> until the runners genuinely block your view of what's behind them.</li>
              </ul>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <Eyebrow accent>Coins & the daily</Eyebrow>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                <li><b>Coins line the cobbles</b> — some float in arcs only a well-timed jump can catch.</li>
                <li><b>Daily run:</b> one attempt per UTC day, stakers-only — everyone charges the SAME street, ranked coins → time.</li>
              </ul>
            </div>
    </>
  ), []);

  return (
    <div className="dashboard-container">
      {/* ── Header ── */}
      <div className="col" style={{ gap: 6 }}>
        <span className="row" style={{ gap: 8 }}>
          <Icon name="bull" size={16} stroke="var(--burn-ink)" />
          <Eyebrow accent>Play &amp; compete</Eyebrow>
        </span>
        <b style={{ fontSize: 17 }}>Charge the endless street. Ten hits and it's over.</b>
        <span style={{ fontSize: 12.5, color: 'var(--fg-2)', maxWidth: 660 }}>
          You are the bull, horns-first through an ever-harder Spanish street packed
          with runners in white and red scattering out of your way.
        </span>
      </div>

      {/* ── The game ── */}
      <BullRun actor={actor} onGoParticipate={onGoParticipate} isLocal={isLocal} />
    </div>
  );
}
