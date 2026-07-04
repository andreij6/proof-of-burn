import { Principal } from '@icp-sdk/core/principal';
import { Btn, Eyebrow, Icon, MoreInfo } from './ui';
import DropZone from './arcade/DropZone';

// ==========================================
// Drop Zone — dedicated page (nav: below Luck-Proof).
// The page owns the standard header; the game lives in arcade/DropZone.tsx.
// ==========================================

interface DropZonePageProps {
  actor: any;
  principal: Principal | null;
  onSignIn: () => void;
  /** Navigate to staking — the daily competition's gate CTA. */
  onGoParticipate: () => void;
  isLocal?: boolean;
}

export default function DropZonePage({ actor, principal, onSignIn, onGoParticipate, isLocal = false }: DropZonePageProps) {
  const signedIn = !!principal && !principal.isAnonymous();

  return (
    <div className="dashboard-container">
      {/* ── Header ── */}
      <div className="col" style={{ gap: 6 }}>
        <span className="row" style={{ gap: 8 }}>
          <Icon name="parachute" size={16} stroke="var(--burn-ink)" />
          <Eyebrow accent>Play &amp; compete</Eyebrow>
        </span>
        <b style={{ fontSize: 17 }}>Jump. Steer. Stick the landing.</b>
        <span style={{ fontSize: 12.5, color: 'var(--fg-2)', maxWidth: 660 }}>
          A battle-royale-style target drop in hand-drawn ink: bail out of the plane
          at the right moment and land as close to the bullseye as you can — alive.{' '}
          <MoreInfo title="How Drop Zone works">
            <p>
              A plane crosses the 2 km map diagonally at 1 000 m. Press{' '}
              <span className="mono">J</span> to jump — timing is everything. In
              freefall the arrows steer; holding <span className="mono">SHIFT</span>{' '}
              tucks into a dive (much faster fall, much weaker steering — the classic
              battle-royale trade). <span className="mono">SPACE</span> toggles the
              chute: pop it for a slow sink with a long glide, cut it to freefall
              again, redeploy whenever — unlimited canopies, exactly like cutting a
              chute in Warzone. All that matters is landing under a canopy whose last
              deploy was above <b>80 m</b>; anything else is a crash, and crashes
              don't rank.
            </p>
            <p>
              <b>Practice</b> deals a fresh random target every jump and records
              nothing. The <b>daily drop</b> is one attempt per UTC day for
              no-loss-lottery stakers: every player gets the SAME scenario — plane
              path, target, terrain — so the board is a pure skill race, ranked by
              distance to the bullseye, ties broken by jump-to-touchdown time.
            </p>
            <p>
              The minimap (top right) tracks the plane, you, and the target ×. Watch
              the altimeter on the right edge — the tick is the 80 m deploy floor.
            </p>
          </MoreInfo>
        </span>
      </div>

      {/* ── The game ── */}
      {signedIn ? (
        <DropZone actor={actor} onGoParticipate={onGoParticipate} isLocal={isLocal} />
      ) : (
        <div className="card col" style={{ gap: 10, alignItems: 'flex-start' }}>
          <b style={{ fontSize: 14 }}>Sign in to play</b>
          <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
            Practice jumps are free for every signed-in player. Stakers can enter the
            daily drop.
          </span>
          <Btn variant="primary" onClick={onSignIn}>
            <Icon name="zap" size={13} stroke="var(--char-950)" /> Sign in to play
          </Btn>
        </div>
      )}
    </div>
  );
}
