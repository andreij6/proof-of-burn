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
            <div className="card col" style={{ gap: 8, borderColor: 'var(--burn)', background: 'color-mix(in srgb, var(--burn) 12%, var(--surface))' }}>
              <Eyebrow accent>The gist</Eyebrow>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
                <b>Jump at the right moment, steer hard, land on the bullseye — alive.</b>{' '}A plane crosses the map at 1,000 m; distance to the target ranks you, time breaks ties, and a bad canopy is a crash.
              </p>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <Eyebrow accent>The jump</Eyebrow>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                <li><b>J to jump</b> — timing is positioning; the plane crosses the 2 km map diagonally.</li>
                <li><b>Arrows steer, SHIFT dives:</b> a dive falls much faster but steers much worse — the classic battle-royale trade.</li>
                <li><b>SPACE toggles the chute:</b> pop it for a slow sink and a long glide, cut it to freefall again, redeploy freely — unlimited canopies.</li>
              </ul>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <Eyebrow accent>Landing safely</Eyebrow>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                <li><b>The 80 m floor:</b> you land safely only under a canopy whose latest deploy was above 80 m — cut-and-crater or a panic redeploy below the floor is a crash.</li>
                <li><b>Crashes never rank</b> — and in the daily, the attempt is spent.</li>
                <li><b>Watch the altimeter</b> on the right edge; the tick marks the floor.</li>
              </ul>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <Eyebrow accent>Practice vs the daily</Eyebrow>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                <li><b>Practice:</b> a fresh random target every jump, nothing recorded.</li>
                <li><b>Daily drop:</b> one attempt per UTC day, stakers-only — everyone gets the SAME scenario (plane, target, terrain), ranked distance → time.</li>
              </ul>
            </div>
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
