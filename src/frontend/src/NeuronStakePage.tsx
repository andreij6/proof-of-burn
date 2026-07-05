import { Principal } from "@icp-sdk/core/principal";
import { Icon, Eyebrow, MoreInfo, Chip, LiveDot } from "./ui";
import Staking from "./Staking";

// ==========================================
// Neuron Stake — dedicated page (nav: Stake 4 Tickets). Holds what used to be
// the Lottery hub's "Stake to Earn Tickets" tab: the 6-month / 1-year /
// 2-year pooled-neuron staking that mints daily lottery tickets.
// ==========================================

interface NeuronStakePageProps {
  actor: any;
  identity: any;
  principal: Principal | null;
  host: string;
  rootKey?: Uint8Array;
  ledgerCanisterId: string;
  isLocal: boolean;
  boostersEnabled: boolean;
  isAdmin: boolean;
  treasuryCanFront: boolean;
  onSignIn: () => void;
  onActivity: () => void;
}

export default function NeuronStakePage({
  actor, identity, principal, host, rootKey, ledgerCanisterId,
  isLocal, boostersEnabled, isAdmin, treasuryCanFront, onSignIn, onActivity,
}: NeuronStakePageProps) {
  return (
    <>
      <div className="idea-board-container" style={{ paddingBottom: 0 }}>
        {/* ── Page header ── */}
        <div className="col" style={{ gap: 6 }}>
          <Eyebrow accent>Stake 4 tickets</Eyebrow>
          <span className="row" style={{ gap: 10 }}>
            <Icon name="zap" size={22} stroke="var(--burn-ink)" />
            <h4 style={{ margin: 0 }}>Neuron Stake</h4>
            <Chip tone="pending"><LiveDot size={6} /> daily tickets</Chip>
          </span>
          <p style={{ fontSize: 13, color: 'var(--fg-2)', maxWidth: 600 }}>
            Lock ICP into a pooled neuron and mint free lottery tickets every day —
            your ICP is never at risk, and staking is the key that activates every
            other reward on the platform.{' '}
            <MoreInfo title="How neuron staking works">
              <div className="card col" style={{ gap: 8, borderColor: 'var(--burn)', background: 'color-mix(in srgb, var(--burn) 12%, var(--surface))' }}>
                <Eyebrow accent>The gist</Eyebrow>
                <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
                  <b>Your ICP stays yours.</b> Staking mints free daily lottery
                  tickets, the neuron's yield feeds the prize pool, and you can
                  unstake in full whenever you like.
                </p>
              </div>
              <div className="col" style={{ gap: 6 }}>
                <Eyebrow accent>Earning tickets</Eyebrow>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                  <li><b>5 / 10 / 20 tickets a day per ICP</b> for 6-month / 1-year / 2-year terms — tiers add up.</li>
                  <li><b>Scales with your stake:</b> 500 ICP for 2 years is 10,000 tickets every day.</li>
                  <li><b>Stay staked:</b> unstake everything and your tickets void on the spot.</li>
                </ul>
              </div>
              <div className="col" style={{ gap: 6 }}>
                <Eyebrow accent>Unstaking</Eyebrow>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                  <li><b>Unstake any time</b> — the neuron dissolves over its term and your ICP returns in full.</li>
                  <li><b>Lossless by design:</b> the prize pool is funded by neuron yield, never by your principal.</li>
                </ul>
              </div>
              <div className="col" style={{ gap: 6 }}>
                <Eyebrow accent>Why stake</Eyebrow>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                  <li><b>The platform key:</b> game competitions, LP rewards, and every other ticket source require an active stake (any amount).</li>
                </ul>
              </div>
            </MoreInfo>
          </p>
        </div>
      </div>

      <Staking
        actor={actor}
        identity={identity}
        principal={principal}
        host={host}
        rootKey={rootKey}
        ledgerCanisterId={ledgerCanisterId}
        isLocal={isLocal}
        boostersEnabled={boostersEnabled}
        isAdmin={isAdmin}
        treasuryCanFront={treasuryCanFront}
        onSignIn={onSignIn}
        onActivity={onActivity}
      />
    </>
  );
}
