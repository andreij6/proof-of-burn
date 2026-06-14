import { useState } from 'react';
import { Principal } from "@icp-sdk/core/principal";
import { Icon, Eyebrow, Chip, Btn, MoreInfo } from "./ui";
import Lottery from "./Lottery";
import Staking from "./Staking";

// ==========================================
// Lottery hub — an Explorer/Casino-style landing page with one card per
// subpage (Lottery draws · Lossless staking). Staking lives here because its
// only reward is daily lottery tickets; voting is burn-only and grants no
// voting power. The active subpage lives in local state — opening "Lottery"
// from the nav always lands on the hub.
// ==========================================

interface LotteryHubProps {
  actor: any;
  identity: any;
  principal: Principal | null;
  host: string;
  rootKey?: Uint8Array;
  ledgerCanisterId: string;
  isLocal: boolean;
  /** Whether lossless staking is enabled (gates the Staking card/subpage). */
  stakingEnabled: boolean;
  /** Whether Boosters (permanent stake) is enabled (gates the Boosters card). */
  boostersEnabled: boolean;
  onSignIn: () => void;
  /** Called after stake/unstake so the app shell can refresh balances. */
  onActivity: () => void;
}

type Screen = 'hub' | 'lottery' | 'staking';

export default function LotteryHub({
  actor, identity, principal, host, rootKey, ledgerCanisterId,
  isLocal, stakingEnabled, boostersEnabled, onSignIn, onActivity,
}: LotteryHubProps) {
  const [screen, setScreen] = useState<Screen>('hub');

  const backBar = (
    <div className="dashboard-container" style={{ paddingBottom: 0 }}>
      <Btn variant="ghost" sm onClick={() => setScreen('hub')} style={{ alignSelf: 'flex-start' }}>
        <Icon name="undo" size={13} /> Lottery
      </Btn>
    </div>
  );

  if (screen === 'staking' && (stakingEnabled || boostersEnabled)) {
    return (
      <>
        {backBar}
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
      </>
    );
  }

  if (screen === 'lottery') {
    return (
      <>
        {backBar}
        <Lottery
          actor={actor}
          principal={principal}
          isLocal={isLocal}
          onSignIn={onSignIn}
          onGoStaking={() => setScreen('staking')}
        />
      </>
    );
  }

  // ── Hub: a landing page (Explorer/Casino-style) with one card per subpage ──
  const hubCard = (
    key: string, name: string, badge: { label: string; tone: 'ok' | 'muted' },
    blurb: string, footL: string, footR: React.ReactNode, go: () => void,
  ) => (
    <div key={key} className="card col hub-card" role="link" tabIndex={0} onClick={go}
      onKeyDown={(e) => { if (e.key === 'Enter') go(); }}
      style={{ gap: 10, display: 'flex', flexDirection: 'column', cursor: 'pointer' }}>
      <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
        <Chip tone={badge.tone} style={{ height: 19, fontSize: 10 }}><Icon name="zap" size={10} /> {badge.label}</Chip>
      </div>
      <h6 style={{ margin: 0, fontSize: 15, lineHeight: 1.35 }}>{name}</h6>
      <p style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5, margin: 0, flex: 1 }}>{blurb}</p>
      <div className="row" style={{ justifyContent: 'space-between', gap: 8, paddingTop: 6, borderTop: '1px solid var(--border)' }}>
        <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>{footL}</span>
        <span className="mono row" style={{ fontSize: 10.5, color: 'var(--fg-3)', gap: 4 }}>{footR}</span>
      </div>
    </div>
  );

  return (
    <div className="idea-board-container">
      {/* ── Page header (subtitle · title · how it works) ── */}
      <div className="col" style={{ gap: 6 }}>
        <Eyebrow accent>Lossless lottery</Eyebrow>
        <span className="row" style={{ gap: 10 }}>
          <Icon name="target" size={22} stroke="var(--burn-ink)" />
          <h4 style={{ margin: 0 }}>Lottery</h4>
        </span>
        <p style={{ fontSize: 13, color: 'var(--fg-2)', maxWidth: 600 }}>
          Stake ICP to collect free daily tickets, then watch the draws — nobody ever loses principal.{' '}
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

      {/* ── Subpage grid (whole card is clickable) ── */}
      <div className="idea-grid">
        {hubCard(
          'lottery', 'Lottery draws', { label: 'Live', tone: 'ok' },
          'Watch the lossless draws, your ticket count and win odds, and the latest winners.',
          'one winner',
          <>Open <Icon name="zap" size={11} /></>,
          () => setScreen('lottery'),
        )}
        {(stakingEnabled || boostersEnabled) && hubCard(
          'staking', 'Staking', { label: 'Earn tickets', tone: 'muted' },
          boostersEnabled
            ? 'Stake ICP for daily tickets — term pools (5/10/20 per ICP) or the permanent Perm neuron (100 per ICP). Zero loss.'
            : 'Stake ICP into a term pool to mint daily lottery tickets — 5 / 10 / 20 per ICP for 6mo / 1y / 2y. Zero loss.',
          'principal never spent',
          <>Stake <Icon name="zap" size={11} /></>,
          () => setScreen('staking'),
        )}
      </div>
    </div>
  );
}
