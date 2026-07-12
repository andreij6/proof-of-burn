import { Principal } from "@icp-sdk/core/principal";
import { Icon, Eyebrow, Chip, LiveDot, usePageHelp } from "./ui";
import Lottery from "./Lottery";

// ==========================================
// Lottery — the drawings page. Staking moved to its own "Neuron Stake" page
// (Stake to Earn nav section); the old #/lottery/staking deep link redirects
// there via pageFromHash.
// ==========================================

interface LotteryHubProps {
  actor: any;
  identity: any;
  principal: Principal | null;
  host: string;
  rootKey?: Uint8Array;
  ledgerCanisterId: string;
  isLocal: boolean;
  onSignIn: () => void;
  /** Stake CTAs navigate to the Neuron Stake page. */
  onGoNeuronStake: () => void;
  onGoExchange: () => void;
  onGoLiquidity: () => void;
}

export default function LotteryHub({
  actor, identity, principal, host, rootKey, ledgerCanisterId, isLocal, onSignIn, onGoNeuronStake, onGoExchange, onGoLiquidity,
}: LotteryHubProps) {
  usePageHelp(() => (
    <>
      <div className="col" style={{ gap: 6 }}>
        <Eyebrow accent>The gist</Eyebrow>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>
          Staking earns free daily tickets, the prize pool is funded by
          neuron yield, and your ICP always stays yours.
        </p>
      </div>
      <div className="col" style={{ gap: 6 }}>
        <Eyebrow accent>Earning &amp; odds</Eyebrow>
        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
          <li><b>Staking is the entry ticket:</b> lock ICP into a 6-month / 1-year / 2-year pooled neuron for free daily tickets (longer terms earn more) — or stake an LP position on the Liquidity Provider pages.</li>
          <li><b>Unstake in full any time</b> — your ICP stays yours.</li>
          <li><b>Fixed odds</b> per draw; the winner is paid straight to their wallet and everyone's tickets reset.</li>
        </ul>
      </div>
      <div className="col" style={{ gap: 6 }}>
        <Eyebrow accent>When a drawing runs</Eyebrow>
        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
          <li><b>Three times a week:</b> Mon, Wed &amp; Sat nights (US Eastern).</li>
          <li><b>Only when both thresholds are met</b> — the pot holds <b>≥ 25 ICP</b> and at least <b>25 unique players</b> hold tickets; otherwise it rolls over and the pot keeps growing.</li>
        </ul>
      </div>
      <div className="col" style={{ gap: 6 }}>
        <Eyebrow accent>The split</Eyebrow>
        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
          <li><b>65% to the winner</b>; <b>30% seeds the next drawing</b>; <b>5% burned</b> to backend-canister cycles.</li>
          <li>The pot is fed by <b>every pooled neuron's yield harvest</b>.</li>
        </ul>
      </div>
    </>
  ), []);
  return (
    <>
      <div className="idea-board-container" style={{ paddingBottom: 0 }}>
        {/* ── Page header (eyebrow · title) ── */}
        <div className="col" style={{ gap: 6 }}>
          <span className="row" style={{ gap: 10, width: '100%', flexWrap: 'wrap' }}>
            <Icon name="ticket" size={22} stroke="var(--burn-ink)" />
            <h4 style={{ margin: 0 }}>No-Loss Lottery</h4>
            <Chip tone="pending"><LiveDot size={6} /> 3× weekly</Chip>
          </span>
        </div>

      </div>

      <Lottery
        actor={actor}
        identity={identity}
        principal={principal}
        host={host}
        rootKey={rootKey}
        ledgerCanisterId={ledgerCanisterId}
        isLocal={isLocal}
        onSignIn={onSignIn}
        onGoStaking={onGoNeuronStake}
        onGoExchange={onGoExchange}
        onGoLiquidity={onGoLiquidity}
      />
    </>
  );
}
