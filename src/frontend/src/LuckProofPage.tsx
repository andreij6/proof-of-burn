import { Principal } from '@icp-sdk/core/principal';
import { Btn, Eyebrow, Icon, MoreInfo } from './ui';
import LuckProof from './arcade/LuckProof';

// ==========================================
// Luck-Proof (Sklansky Trainer) — dedicated page (nav: below Lottery).
// The page owns the standard header (eyebrow / title / description); the
// game itself lives in arcade/LuckProof.tsx and is reused unchanged.
// ==========================================

interface LuckProofPageProps {
  actor: any;
  principal: Principal | null;
  onSignIn: () => void;
  /** Navigate to staking — the daily competition's gate CTA. */
  onGoParticipate: () => void;
}

export default function LuckProofPage({ actor, principal, onSignIn, onGoParticipate }: LuckProofPageProps) {
  const signedIn = !!principal && !principal.isAnonymous();

  return (
    <div className="dashboard-container">
      {/* ── Header ── */}
      <div className="col" style={{ gap: 6 }}>
        <span className="row" style={{ gap: 8 }}>
          <Icon name="pokerchip" size={16} stroke="var(--burn-ink)" />
          <Eyebrow accent>Play &amp; compete</Eyebrow>
        </span>
        <b style={{ fontSize: 17 }}>Your results are luck. Your decisions are skill.</b>
        <span style={{ fontSize: 12.5, color: 'var(--fg-2)', maxWidth: 660 }}>
          A poker-brain trainer with no cards: take or decline wagers on a 3-second
          clock, scored purely on the expected value of your decisions.{' '}
          <MoreInfo title="How Luck-Proof works">
            <div className="card col" style={{ gap: 8, borderColor: 'var(--burn)', background: 'color-mix(in srgb, var(--burn) 12%, var(--surface))' }}>
              <Eyebrow accent>The gist</Eyebrow>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
                <b>Your results are luck. Your decisions are skill.</b>{' '}Every hand is a river call at stated pot odds; only the expected value of your decisions is scored — the cards can't save you or sink you.
              </p>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <Eyebrow accent>Playing a hand</Eyebrow>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                <li><b>Call or fold in 3 seconds:</b> the pot offers a reward at stated odds; calling is worth <span className="mono">P·reward − (1−P)·risk</span>, folding is always exactly $0.</li>
                <li><b>The clock folds for you</b> — hesitation is a decision too.</li>
                <li><b>Two live tracks:</b> the skill track credits each decision's EV instantly; the luck track is your actual cash. Only skill ranks.</li>
              </ul>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <Eyebrow accent>Practice vs the daily</Eyebrow>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                <li><b>Practice:</b> 50-hand sessions, restart anytime, nothing recorded.</li>
                <li><b>Daily competition:</b> 250 decisions, one attempt per UTC day, stakers-only — everyone faces the SAME deal, ranked EV → accuracy → speed.</li>
                <li><b>Two daily winners:</b> highest EV and highest actual cash each take lottery tickets equal to the day's player count.</li>
              </ul>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <Eyebrow accent>Trust</Eyebrow>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                <li><b>Replays are public:</b> tap any board row (after you've competed) to see every decision against the shared deal, recomputed on-chain.</li>
                <li><b>Scores can't be forged:</b> your decisions are the only client input; the EV is rescored server-side.</li>
              </ul>
            </div>
          </MoreInfo>
        </span>
      </div>

      {/* ── The game ── */}
      {signedIn ? (
        <LuckProof actor={actor} onGoParticipate={onGoParticipate} />
      ) : (
        <div className="card col" style={{ gap: 10, alignItems: 'flex-start' }}>
          <b style={{ fontSize: 14 }}>Sign in to play</b>
          <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
            Practice is free for every signed-in player. Stakers can enter the daily
            250-decision competition.
          </span>
          <Btn variant="primary" onClick={onSignIn}>
            <Icon name="zap" size={13} stroke="var(--char-950)" /> Sign in to play
          </Btn>
        </div>
      )}
    </div>
  );
}
