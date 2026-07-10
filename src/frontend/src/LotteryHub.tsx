import { Principal } from "@icp-sdk/core/principal";
import { Icon, Eyebrow, MoreInfo, Chip, LiveDot } from "./ui";
import Lottery from "./Lottery";

// ==========================================
// Lottery — the drawings page. Staking moved to its own "Neuron Stake" page
// (Stake to Earn nav section); the old #/lottery/staking deep link redirects
// there via pageFromHash.
// ==========================================

interface LotteryHubProps {
  actor: any;
  principal: Principal | null;
  isLocal: boolean;
  onSignIn: () => void;
  /** Stake CTAs navigate to the Neuron Stake page. */
  onGoNeuronStake: () => void;
}

export default function LotteryHub({
  actor, principal, isLocal, onSignIn, onGoNeuronStake,
}: LotteryHubProps) {
  return (
    <>
      <div className="idea-board-container" style={{ paddingBottom: 0 }}>
        {/* ── Page header (eyebrow · title · how it works) ── */}
        <div className="col" style={{ gap: 6 }}>
          <Eyebrow accent>Lossless lottery</Eyebrow>
          <span className="row" style={{ gap: 10 }}>
            <Icon name="ticket" size={22} stroke="var(--burn-ink)" />
            <h4 style={{ margin: 0 }}>Lottery</h4>
            <Chip tone="pending"><LiveDot size={6} /> 3× weekly</Chip>
          </span>
          <p style={{ fontSize: 13, color: 'var(--fg-2)', maxWidth: 600 }}>
            The no-loss lottery: tickets are free, the prize is pure staking yield,
            and your ICP is never at risk — win or lose, you keep every token.{' '}
            <MoreInfo title="How the lossless lottery works">
              <div className="card col" style={{ gap: 8, borderColor: 'var(--burn)', background: 'color-mix(in srgb, var(--burn) 12%, var(--surface))' }}>
                <Eyebrow accent>The gist</Eyebrow>
                <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
                  <b>Nobody pays in.</b> Staking earns free daily tickets, the prize pool is funded by
                  neuron yield, and your ICP always stays yours.
                </p>
              </div>
              <div className="col" style={{ gap: 6 }}>
                <Eyebrow accent>Earning &amp; odds</Eyebrow>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                  <li><b>Staking is the entry ticket:</b> lock ICP into a 6-month / 1-year / 2-year pooled neuron for free daily tickets (longer terms earn more).</li>
                  <li><b>Unstake in full any time</b> — your ICP stays yours.</li>
                  <li><b>Fixed odds</b> per draw; the winner is paid straight to their wallet and everyone's tickets reset.</li>
                </ul>
              </div>
              <div className="col" style={{ gap: 6 }}>
                <Eyebrow accent>When a drawing runs</Eyebrow>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                  <li><b>Three times a week:</b> Mon, Wed &amp; Sat nights (US Eastern).</li>
                  <li><b>Only when both thresholds are met</b> — the pot holds <b>≥ 25 ICP</b> and there are enough unique participants; otherwise it rolls over and the pot keeps growing.</li>
                </ul>
              </div>
              <div className="col" style={{ gap: 6 }}>
                <Eyebrow accent>The split</Eyebrow>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                  <li><b>65% to the winner</b>; <b>30% seeds the next drawing</b>; <b>5% burned</b> to backend-canister cycles.</li>
                  <li>The pot is fed by <b>every pooled neuron's yield harvest</b>.</li>
                </ul>
              </div>
            </MoreInfo>
          </p>
        </div>

      </div>

      <Lottery
        actor={actor}
        principal={principal}
        isLocal={isLocal}
        onSignIn={onSignIn}
        onGoStaking={onGoNeuronStake}
      />
    </>
  );
}
