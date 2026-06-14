import { Principal } from "@icp-sdk/core/principal";
import { Icon, Eyebrow, MoreInfo } from "./ui";
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
          </span>
          <p style={{ fontSize: 13, color: 'var(--fg-2)', maxWidth: 600 }}>
            Earn a free ticket every day just by staking. Every draw is a chance to win, and your ICP is never at risk.{' '}
            <MoreInfo title="How the lossless lottery works">
              <p style={{ margin: '0 0 8px' }}>
                Staking is the entry ticket: lock ICP into a 6-month, 1-year or 2-year pooled neuron and
                collect free tickets every day (longer terms earn more). Your ICP stays yours — unstake
                in full any time.
              </p>
              <p style={{ margin: 0 }}>
                The neurons' yield funds the prize pool. Each draw has fixed odds, the winner is paid
                straight to their wallet, and everyone's tickets reset for the next round.
              </p>
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
