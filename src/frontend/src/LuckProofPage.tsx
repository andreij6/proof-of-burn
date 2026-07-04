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
            <p>
              Every hand offers a wager: risk some dollars for a stated chance at a
              profit. Taking it is worth <span className="mono">P·reward − (1−P)·risk</span> in
              expected value (EV); declining is worth exactly $0. You have 3 seconds —
              if the clock runs out, you decline.
            </p>
            <p>
              Two tracks chart in realtime as you play. The <b>skill track</b> credits
              each decision's EV the moment you make it — good decisions score even
              when the cards go against you. The <b>luck track</b> is your actual
              cash, rolled fairly per hand. Only the skill track ever ranks: that
              separation — judging decisions, not outcomes — is the core discipline
              of long-term poker profitability (the "Sklansky dollars" idea).
            </p>
            <p>
              <b>Practice</b> is endless, free for any signed-in user, and records
              nothing. The <b>daily competition</b> is one attempt per UTC day, 250
              decisions, for no-loss-lottery stakers: every player faces the SAME
              deal (derived from the day itself), ranked by EV earned, then accuracy,
              then speed. Each day pays <b>two winners</b> — the highest EV (skill)
              and the highest actual cash (luck) — <b>lottery tickets equal to that
              day's player count</b>, each. Any run on the board can be replayed
              decision-by-decision — the deal is recomputed on-chain, so anyone can
              verify everyone played identical scenarios.
            </p>
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
