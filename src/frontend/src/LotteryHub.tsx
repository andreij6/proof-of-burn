import { Principal } from "@icp-sdk/core/principal";
import { Icon, Eyebrow, MoreInfo, Chip, LiveDot } from "./ui";
import { useHashScreen } from "./nav";
import Lottery from "./Lottery";
import Staking from "./Staking";

// ==========================================
// Lottery hub — a Community-R&D-style tabbed page: "Drawings" (the lossless
// draws) and "Stake to Earn Tickets" (staking). Staking lives here because its
// only reward is daily lottery tickets; voting is burn-only and grants no
// voting power. The active tab lives in the hash (#/lottery, #/lottery/staking)
// so the Back button moves between tabs.
// ==========================================

interface LotteryHubProps {
  actor: any;
  identity: any;
  principal: Principal | null;
  host: string;
  rootKey?: Uint8Array;
  ledgerCanisterId: string;
  isLocal: boolean;
  /** Whether lossless staking is enabled (gates the staking tab). */
  stakingEnabled: boolean;
  /** Whether Boosters (permanent stake) is enabled (shown within staking). */
  boostersEnabled: boolean;
  onSignIn: () => void;
  /** Called after stake/unstake so the app shell can refresh balances. */
  onActivity: () => void;
}

type Tab = 'lottery' | 'staking';

export default function LotteryHub({
  actor, identity, principal, host, rootKey, ledgerCanisterId,
  isLocal, stakingEnabled, boostersEnabled, onSignIn, onActivity,
}: LotteryHubProps) {
  // Active tab lives in the hash (#/lottery, #/lottery/staking) so Back moves
  // between tabs instead of leaving the page.
  const [screen, setScreen] = useHashScreen<Tab>('/lottery', 'lottery');
  const stakeEnabled = stakingEnabled || boostersEnabled;
  // Fall back to the Drawings tab if staking is disabled.
  const tab: Tab = screen === 'staking' && stakeEnabled ? 'staking' : 'lottery';

  const tabs: [Tab, string][] = [
    ['lottery', 'Drawings'],
    ...(stakeEnabled ? ([['staking', 'Stake to Earn Tickets']] as [Tab, string][]) : []),
  ];

  return (
    <>
      <div className="dashboard-container" style={{ paddingBottom: 0 }}>
        {/* ── Page header (eyebrow · title · how it works) ── */}
        <div className="col" style={{ gap: 6 }}>
          <Eyebrow accent>Lossless lottery</Eyebrow>
          <span className="row" style={{ gap: 10 }}>
            <Icon name="target" size={22} stroke="var(--burn-ink)" />
            <h4 style={{ margin: 0 }}>Lottery</h4>
            <Chip tone="pending"><LiveDot size={6} /> 3× weekly</Chip>
          </span>
          <p style={{ fontSize: 13, color: 'var(--fg-2)', maxWidth: 600 }}>
            Earn a free ticket every day just by staking. Every draw is a chance to win, and your ICP is never at risk.{' '}
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

        {/* ── Tab bar ── */}
        <div className="row" style={{ borderBottom: '1px solid var(--border)', paddingBottom: 2, gap: 16, width: '100%', overflowX: 'auto', scrollbarWidth: 'none', marginTop: 10 }}>
          {tabs.map(([key, label]) => (
            <button
              key={key}
              onClick={() => setScreen(key)}
              style={{
                background: 'transparent', border: 'none',
                color: tab === key ? 'var(--burn-ink)' : 'var(--fg-3)',
                fontSize: 14, fontWeight: tab === key ? 600 : 500,
                cursor: 'pointer', padding: '6px 4px', position: 'relative', whiteSpace: 'nowrap',
                transition: 'color var(--dur-fast) var(--ease-out)',
              }}
            >
              {label}
              {tab === key && (
                <div style={{ position: 'absolute', bottom: -3, left: 0, right: 0, height: 2, background: 'var(--burn)', borderRadius: 999 }} />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ── Active tab ── */}
      {tab === 'lottery' ? (
        <Lottery
          actor={actor}
          principal={principal}
          isLocal={isLocal}
          onSignIn={onSignIn}
          onGoStaking={() => setScreen('staking')}
        />
      ) : (
        <Staking
          actor={actor}
          identity={identity}
          principal={principal}
          host={host}
          rootKey={rootKey}
          ledgerCanisterId={ledgerCanisterId}
          isLocal={isLocal}
          boostersEnabled={boostersEnabled}
          onSignIn={onSignIn}
          onActivity={onActivity}
        />
      )}
    </>
  );
}
