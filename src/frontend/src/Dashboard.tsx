// Dashboard — the hub. A staggered grid of cards that routes into every part
// of the app. Hierarchy is deliberate: ① hero (state depends on how far the
// user has come), ② "needs attention" accent cards that only render when
// actionable, ③ one card per enabled feature — personalized when the user has
// used it, promo copy when they haven't, ④ protocol-wide totals.
import React, { useState, useEffect } from 'react';
import type { Principal } from "@icp-sdk/core/principal";
import { CommitmentStatus, type Backend } from "./bindings/backend";
import type {
  Proposal,
  Commitment,
  UserStakeInfo,
  GlobalStats,
  LotteryInfo,
  EarlyAdopterInfo,
  Payout,
} from "./bindings/backend";
import type { AppPage } from "./App";
import { countdownShort, attentionItems } from "./hubLogic";
import { Icon, Eyebrow, Chip, Btn, LiveDot, fmtICP } from "./ui";

// ── Card primitive ──

function HubCard({ span2, accent, onClick, eyebrow, icon, chip, children }: {
  span2?: boolean;
  accent?: boolean;
  onClick?: () => void;
  eyebrow: string;
  icon: string;
  chip?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`hub-card${span2 ? ' hub-span2' : ''}`}
      role={onClick ? 'link' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      style={{
        display: 'flex', flexDirection: 'column', gap: 10,
        padding: '16px 18px', borderRadius: 12,
        background: accent ? 'var(--burn-950)' : 'var(--surface)',
        border: `1px solid ${accent ? 'var(--burn)' : 'var(--border)'}`,
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span className="row" style={{ gap: 7, alignItems: 'center' }}>
          <Icon name={icon} size={13} stroke={accent ? 'var(--burn)' : 'var(--fg-3)'} />
          <Eyebrow>{eyebrow}</Eyebrow>
        </span>
        <span className="row" style={{ gap: 6, alignItems: 'center' }}>
          {chip}
          {onClick && <Icon name="chevRight" size={13} stroke="var(--fg-3)" />}
        </span>
      </div>
      {children}
    </div>
  );
}

function Big({ children }: { children: React.ReactNode }) {
  return <b className="mono" style={{ fontSize: 22, lineHeight: 1.15 }}>{children}</b>;
}
function Sub({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.45 }}>{children}</span>;
}
function MiniStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="col" style={{ gap: 2, minWidth: 90 }}>
      <span style={{ fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--fg-3)' }}>{label}</span>
      <b className="mono" style={{ fontSize: 16 }}>{value}</b>
    </div>
  );
}

// ── Page ──

export default function Dashboard({
  actor, principal, isAdmin, tier, holdings, proposals,
  myCommitments, myStake, globalStats, flags, go, onSignIn,
}: {
  actor: Backend | null;
  principal: Principal | null;
  isAdmin: boolean;
  tier: number;
  holdings: bigint;
  proposals: Proposal[];
  myCommitments: Commitment[];
  myStake: UserStakeInfo | null;
  globalStats: GlobalStats | null;
  flags: { staking: boolean; lottery: boolean; ideas: boolean; explorer: boolean; arcade: boolean; earlyAdopters: boolean };
  go: (p: AppPage) => void;
  onSignIn: () => void;
}) {
  const signedIn = !!principal && !principal.isAnonymous();
  const [nowMs] = useState(() => Date.now()); // stable per mount — render stays pure
  const [lottery, setLottery] = useState<LotteryInfo | null>(null);
  const [ea, setEa] = useState<EarlyAdopterInfo | null>(null);
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [ideaCount, setIdeaCount] = useState<number | null>(null);

  // One parallel fetch per mount for everything App.tsx doesn't already hold.
  useEffect(() => {
    if (!actor) return;
    let cancelled = false;
    (async () => {
      const [lot, eaInfo, pays, ideas] = await Promise.all([
        // get_lottery_info is an update method — anonymous ingress is rejected,
        // so only ask once signed in. Signed-out visitors get static promo copy.
        flags.lottery && signedIn ? actor.get_lottery_info().catch(() => null) : Promise.resolve(null),
        flags.earlyAdopters ? actor.get_early_adopter_info().catch(() => null) : Promise.resolve(null),
        signedIn ? actor.get_my_payouts().catch(() => []) : Promise.resolve([]),
        flags.ideas ? actor.list_ideas().catch(() => null) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      setLottery(lot);
      setEa(eaInfo);
      setPayouts(pays);
      setIdeaCount(ideas === null ? null : ideas.length);
    })();
    return () => { cancelled = true; };
  }, [actor, signedIn, flags.lottery, flags.earlyAdopters, flags.ideas]);

  // Usage signals — drive personalized vs promo card states.
  const votingUsed = myCommitments.length > 0;
  const stakedE8s = myStake?.total_staked_e8s ?? 0n;
  const stakingUsed = stakedE8s > 0n;
  const myTickets = lottery?.my_tickets ?? 0n;
  const eaStaked = ea?.my_staked_e8s ?? 0n;
  const newUser = signedIn && tier <= 1 && !votingUsed && !stakingUsed;

  const escrowE8s = myCommitments
    .filter(c => c.status === CommitmentStatus.Pending || c.status === CommitmentStatus.ThresholdMet)
    .reduce((s, c) => s + c.amount_e8s, 0n);

  const nowNs = BigInt(nowMs) * 1_000_000n;
  const actedIds = new Set<string>(
    myCommitments.map(c => c.proposal_id.toString()),
  );
  const attention = signedIn ? attentionItems({
    nowNs,
    lottery: lottery ? { nextDrawAt: lottery.next_draw_at, myTickets } : null,
    proposals,
    actedProposalIds: actedIds,
  }) : [];

  const openCount = proposals.filter(p => p.status === 'open').length;
  const drawCountdown = lottery ? countdownShort(lottery.next_draw_at, nowMs) : null;
  const lastPayout = payouts.length > 0 ? payouts[payouts.length - 1] : null;

  const checklist: { label: string; done: boolean; page: AppPage }[] = [
    { label: 'Sign in with Internet Identity', done: true, page: 'dashboard' },
    { label: 'Follow the leader neuron & verify', done: tier >= 2, page: 'voting' },
    { label: 'Cast your first vote — burn ICP to steer the leader', done: votingUsed, page: 'voting' },
    ...(flags.staking ? [{ label: 'Stake ICP — earn daily lottery tickets', done: stakingUsed, page: 'lottery' as AppPage }] : []),
  ];

  return (
    <div className="col" style={{ gap: 18, padding: '22px 22px 40px', maxWidth: 1060, margin: '0 auto', width: '100%' }}>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <Icon name="list" size={14} stroke="var(--burn)" />
        <Eyebrow accent>Dashboard</Eyebrow>
      </div>

      <div className="hub-grid">
        {/* ① Hero — three states by usage */}
        {!signedIn ? (
          <HubCard span2 eyebrow="Welcome" icon="flame">
            <Big>Governance with skin in the game</Big>
            <Sub>
              Burn ICP to steer NNS votes, stake losslessly for daily lottery tickets, and fund
              community R&D — every action provably shrinks ICP supply.
            </Sub>
            <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 }}>
              <Btn variant="primary" onClick={onSignIn}>Sign in with Internet Identity</Btn>
              {globalStats && (
                <span className="row" style={{ gap: 16 }}>
                  <MiniStat label="ICP burned" value={fmtICP(globalStats.total_burned_e8s)} />
                  <MiniStat label="Votes cast" value={globalStats.votes_cast.toString()} />
                </span>
              )}
            </div>
          </HubCard>
        ) : newUser ? (
          <HubCard span2 eyebrow="Get started" icon="checkCircle" chip={<Chip tone="pending">{checklist.filter(c => c.done).length}/{checklist.length}</Chip>}>
            <Big>Welcome to Caldera</Big>
            <div className="col" style={{ gap: 8, marginTop: 2 }}>
              {checklist.map((step, i) => (
                <button key={i} onClick={() => go(step.page)} style={{
                  display: 'flex', alignItems: 'center', gap: 9, background: 'transparent',
                  border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left',
                  color: step.done ? 'var(--fg-3)' : 'var(--fg-1)', fontSize: 13,
                  textDecoration: step.done ? 'line-through' : 'none',
                }}>
                  <Icon name={step.done ? 'checkCircle' : 'chevRight'} size={14}
                    stroke={step.done ? 'var(--sprout)' : 'var(--burn)'} />
                  {step.label}
                </button>
              ))}
            </div>
          </HubCard>
        ) : (
          <HubCard span2 eyebrow="Your position" icon="wallet" onClick={() => go('payouts')}
            chip={tier >= 3 ? <Chip tone="ok"><LiveDot size={5} /> active</Chip> : undefined}>
            <div className="row" style={{ gap: 20, flexWrap: 'wrap' }}>
              <MiniStat label="Wallet" value={`${fmtICP(holdings)} ICP`} />
              {flags.staking && <MiniStat label="Staked" value={`${fmtICP(stakedE8s)} ICP`} />}
              <MiniStat label="In escrow" value={`${fmtICP(escrowE8s)} ICP`} />
              {flags.lottery && lottery && !lottery.admin_excluded && (
                <MiniStat label="Tickets" value={myTickets.toString()} />
              )}
              {flags.earlyAdopters && eaStaked > 0n && (
                <MiniStat label="Perm stake" value={`${fmtICP(eaStaked)} ICP`} />
              )}
            </div>
            <Sub>Full transaction history and payouts live on your profile.</Sub>
          </HubCard>
        )}

        {/* ② Needs attention — only when actionable */}
        {attention.map(item => (
          <HubCard key={item.kind} accent eyebrow="Needs attention" icon="zap" onClick={() => go(item.page)}>
            <Big>{item.title}</Big>
            <Sub>{item.detail}</Sub>
          </HubCard>
        ))}

        {/* ③ Feature cards — personalized when used, promo when not */}
        <HubCard eyebrow="NNS Voting" icon="flame" onClick={() => go('voting')}
          chip={openCount > 0 ? <Chip tone="pending">{openCount} open</Chip> : undefined}>
          {votingUsed ? (
            <>
              <Big>{myCommitments.length} votes placed</Big>
              <Sub>{fmtICP(escrowE8s)} ICP currently committed in escrow. Open proposals await your conviction.</Sub>
            </>
          ) : (
            <>
              <Big>Steer the NNS</Big>
              <Sub>Commit ICP behind ADOPT or REJECT — meet the threshold and the leader neuron votes while every committed token burns.</Sub>
            </>
          )}
        </HubCard>

        {flags.staking && (
          <HubCard eyebrow="Staking" icon="zap" onClick={() => go('lottery')}
            chip={signedIn && !stakingUsed ? <Chip tone="muted">new to you</Chip> : undefined}>
            {stakingUsed ? (
              <>
                <Big>{fmtICP(stakedE8s)} ICP staked</Big>
                <Sub>Earning daily lottery tickets across your term pools. Zero-loss by design.</Sub>
              </>
            ) : (
              <>
                <Big>Lossless staking</Big>
                <Sub>Three fixed terms (6mo / 1y / 2y). Withdraw exactly what you put in — the yield funds the lottery and the protocol.</Sub>
              </>
            )}
          </HubCard>
        )}

        {flags.lottery && (
          <HubCard eyebrow="Lottery" icon="target" onClick={() => go('lottery')}
            chip={drawCountdown ? <Chip tone="pending"><LiveDot size={5} /> {drawCountdown}</Chip> : undefined}>
            <Big>{lottery ? `${fmtICP(lottery.pot_e8s)} ICP pot` : 'Lossless lottery'}</Big>
            <Sub>
              {lottery && lottery.admin_excluded
                ? 'Admins are excluded from play — the pot still grows from staking yield.'
                : myTickets > 0n
                  ? `You hold ${myTickets.toString()} tickets this round. Draws run three times a week.`
                  : 'Stakers collect free tickets daily — more stake, more tickets. About one winner a month.'}
            </Sub>
          </HubCard>
        )}

        {flags.ideas && (
          <HubCard eyebrow="Community R&D" icon="bulb" onClick={() => go('ideas')}
            chip={ideaCount !== null && ideaCount > 0 ? <Chip tone="muted">{ideaCount} ideas</Chip> : undefined}>
            <Big>Pitch & fund ideas</Big>
            <Sub>Post proposals for the ecosystem, upvote with ICP, ckBTC or ckETH, and crowd-fund curated projects.</Sub>
          </HubCard>
        )}

        {flags.explorer && (
          <HubCard eyebrow="Dapp Explorer" icon="compass" onClick={() => go('explorer')}>
            <Big>Discover ICP dapps</Big>
            <Sub>A curated on-chain directory — list your own dapp for $1 a day, paid in any supported token.</Sub>
          </HubCard>
        )}

        {flags.arcade && (
          <HubCard eyebrow="Arcade" icon="gamepad" onClick={() => go('arcade')}
            chip={signedIn && !votingUsed && !stakingUsed ? <Chip tone="muted">vote or stake to unlock</Chip> : undefined}>
            <Big>Mini Golf</Big>
            <Sub>Nine isometric holes, a global leaderboard, and a custom golfer. Hole 1 is free — participation unlocks the rest.</Sub>
          </HubCard>
        )}

        {flags.earlyAdopters && (
          <HubCard eyebrow="Perm" icon="spark" onClick={() => go('lottery')}
            chip={<Chip tone="ok">100 tickets/ICP/day</Chip>}>
            {eaStaked > 0n ? (
              <>
                <Big>{fmtICP(eaStaked)} ICP staked</Big>
                <Sub>Earning {(Number(eaStaked / 100_000_000n) * 100).toLocaleString()} lottery tickets/day. Permanent stake — no exit.</Sub>
              </>
            ) : (
              <>
                <Big>Max lottery boost</Big>
                <Sub>Stake ICP permanently for 100 lottery tickets/day per ICP — the highest rate. You're never paid ICP from it.</Sub>
              </>
            )}
          </HubCard>
        )}

        {signedIn && lastPayout && (
          <HubCard eyebrow="Latest payout" icon="coins" onClick={() => go('payouts')}>
            <Big>{fmtICP(lastPayout.amount)} {Object.keys(lastPayout.token)[0] === 'ICP' ? 'ICP' : Object.keys(lastPayout.token)[0]}</Big>
            <Sub>Most recent transfer the protocol sent you — every payout lands in your wallet automatically.</Sub>
          </HubCard>
        )}

        {isAdmin && (
          <HubCard eyebrow="Admin" icon="key" onClick={() => go('admin')}>
            <Big>Console</Big>
            <Sub>Feature flags, thresholds, lottery config, course editor and treasury controls.</Sub>
          </HubCard>
        )}

        {/* ④ Protocol totals — always last */}
        {globalStats && (
          <HubCard span2 eyebrow="Protocol totals" icon="eye" onClick={() => go('voting')}>
            <div className="row" style={{ gap: 20, flexWrap: 'wrap' }}>
              <MiniStat label="ICP burned" value={fmtICP(globalStats.total_burned_e8s)} />
              <MiniStat label="TVL" value={`${fmtICP(globalStats.tvl_e8s)} ICP`} />
              <MiniStat label="Pending burn" value={fmtICP(globalStats.pending_burn_e8s)} />
              <MiniStat label="NNS votes cast" value={globalStats.votes_cast.toString()} />
              <MiniStat label="Followers" value={globalStats.followers_count.toString()} />
            </div>
          </HubCard>
        )}
      </div>
    </div>
  );
}
