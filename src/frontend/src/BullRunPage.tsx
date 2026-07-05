import { Principal } from '@icp-sdk/core/principal';
import { Btn, Eyebrow, Icon, MoreInfo } from './ui';
import BullRun from './arcade/BullRun';

// ==========================================
// Bull Run — dedicated page (nav: Play to Earn).
// The page owns the standard header; the game lives in arcade/BullRun.tsx.
// ==========================================

interface BullRunPageProps {
  actor: any;
  principal: Principal | null;
  onSignIn: () => void;
  /** Navigate to staking — the daily competition's gate CTA. */
  onGoParticipate: () => void;
  isLocal?: boolean;
}

export default function BullRunPage({ actor, principal, onSignIn, onGoParticipate, isLocal = false }: BullRunPageProps) {
  const signedIn = !!principal && !principal.isAnonymous();

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
          with runners in white and red scattering out of your way.{' '}
          <MoreInfo title="How Bull Run works">
            <p>
              Three lanes down a whitewashed street that never ends.{' '}
              <span className="mono">←/→</span> cut across, <span className="mono">↑/SPACE</span>{' '}
              jumps the barriers and barrel stacks — <b>carts are too tall to jump</b>,
              you have to go around. Every stumble halves your speed;{' '}
              <b>the tenth hit ends the run</b>. Coins line the cobbles, some floating
              in arcs you can only catch mid-jump.
            </p>
            <p>
              It gets harder the deeper you charge: the bull keeps accelerating,
              obstacles pack tighter, and the crowd thickens until the runners
              genuinely block your view of what's waiting behind them.
            </p>
            <p>
              <b>Practice</b> deals a fresh random street every run and records
              nothing. The <b>daily run</b> is one attempt per UTC day for
              no-loss-lottery stakers: every player charges the SAME street — same
              obstacles, same crowd, same coin lines — ranked by coins collected,
              ties broken by run time.
            </p>
          </MoreInfo>
        </span>
      </div>

      {/* ── The game ── */}
      {signedIn ? (
        <BullRun actor={actor} onGoParticipate={onGoParticipate} isLocal={isLocal} />
      ) : (
        <div className="card col" style={{ gap: 10, alignItems: 'flex-start' }}>
          <b style={{ fontSize: 14 }}>Sign in to play</b>
          <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
            Practice runs are free for every signed-in player. Stakers can enter the
            daily run.
          </span>
          <Btn variant="primary" onClick={onSignIn}>
            <Icon name="zap" size={13} stroke="var(--char-950)" /> Sign in to play
          </Btn>
        </div>
      )}
    </div>
  );
}
