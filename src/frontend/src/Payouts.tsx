import { useEffect, useState } from 'react';
import { Principal } from "@icp-sdk/core/principal";
import { PayoutType, IdeaToken } from "./bindings/backend";
import type { Payout } from "./bindings/backend";
import { fmtTokenAmount } from "./IdeaBoard";
import { Icon, Eyebrow, Chip, Btn, formatPrincipal } from "./ui";

// ==========================================
// Profile — your identity plus every payment the site has made to you,
// across all payout types: lottery jackpots, unstake disbursements, idea
// upvote shares, commitment refunds and pool rewards. Payouts are pushed
// straight to the wallet — there is never anything to claim.
// ==========================================

interface PayoutsProps {
  actor: any;
  principal: Principal | null;
  onSignIn: () => void;
}

const PAYOUT_META: Record<PayoutType, { label: string; icon: string; blurb: string }> = {
  [PayoutType.LotteryWin]: {
    label: 'Lottery jackpot', icon: 'target',
    blurb: '80% of the prize pool',
  },
  [PayoutType.UnstakeDisbursement]: {
    label: 'Unstake disbursement', icon: 'zap',
    blurb: 'Dissolved stake returned to your wallet',
  },
  [PayoutType.IdeaUpvoteShare]: {
    label: 'Idea upvote share', icon: 'bulb',
    blurb: '25% poster share of an upvote',
  },
  [PayoutType.CommitmentRefund]: {
    label: 'Commitment refund', icon: 'undo',
    blurb: 'Escrow returned — threshold unmet',
  },
  [PayoutType.PoolReward]: {
    label: 'Pool reward', icon: 'arrowUp',
    blurb: '25% of a settled burn, shared by top pool neurons',
  },
};

const TOKEN_DECIMALS: Record<IdeaToken, { label: string; decimals: number }> = {
  [IdeaToken.ICP]: { label: 'ICP', decimals: 8 },
  [IdeaToken.CkBTC]: { label: 'ckBTC', decimals: 8 },
  [IdeaToken.CkETH]: { label: 'ckETH', decimals: 18 },
};

function payoutDate(atNs: bigint): string {
  return new Date(Number(atNs / 1_000_000n)).toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export default function Payouts({ actor, principal, onSignIn }: PayoutsProps) {
  const signedIn = !!(principal && !principal.isAnonymous());
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      if (!actor || !signedIn) { setPayouts([]); setLoaded(false); return; }
      try {
        setPayouts(await actor.get_my_payouts());
        setLoaded(true);
      } catch (err) {
        console.error("Failed to fetch payouts:", err);
      }
    })();
  }, [actor, principal, signedIn]);

  const card: React.CSSProperties = {
    border: '1px solid var(--border)', borderRadius: 10,
    background: 'var(--surface)', padding: 16,
  };

  return (
    <div className="dashboard-container">
      {/* ── Header ── */}
      <div className="col" style={{ gap: 6 }}>
        <span className="row" style={{ gap: 8 }}>
          <Icon name="wallet" size={16} stroke="var(--burn)" />
          <Eyebrow accent>Profile</Eyebrow>
        </span>
        <b style={{ fontSize: 17 }}>Your account. Everything the site has paid you.</b>
        <span style={{ fontSize: 12.5, color: 'var(--fg-2)', maxWidth: 640 }}>
          Lottery jackpots, unstake disbursements, idea upvote shares, commitment refunds,
          pool rewards — every payout lands in your wallet automatically the moment it
          settles. Nothing to claim; this is the receipt trail, newest first.
        </span>
        {signedIn && (
          <span className="row" style={{ gap: 8, marginTop: 4 }}>
            <Chip tone="muted"><Icon name="key" size={11} /> {formatPrincipal(principal)}</Chip>
            <button
              onClick={() => principal && navigator.clipboard.writeText(principal.toString())}
              style={{
                background: 'transparent', border: 'none', color: 'var(--fg-3)',
                cursor: 'pointer', fontSize: 11.5, padding: 0,
                display: 'flex', alignItems: 'center', gap: 4,
              }}
            >
              <Icon name="copy" size={11} stroke="var(--fg-3)" /> copy principal
            </button>
          </span>
        )}
      </div>

      <div className="col" style={{ ...card, gap: 10 }}>
        <Eyebrow>Payout history</Eyebrow>
        {!signedIn ? (
          <div className="col" style={{ gap: 10, alignItems: 'flex-start' }}>
            <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
              Sign in to see your profile and payout history.
            </span>
            <Btn variant="primary" sm onClick={onSignIn}>
              <Icon name="key" size={13} stroke="var(--char-950)" /> Sign in
            </Btn>
          </div>
        ) : payouts.length === 0 ? (
          <span style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>
            {loaded
              ? "No payouts yet — stake, post ideas, or hold lottery tickets and they'll land here."
              : "Loading…"}
          </span>
        ) : (
          <div className="col" style={{ gap: 0 }}>
            {payouts.map((po) => {
              const meta = PAYOUT_META[po.payout_type];
              const tok = TOKEN_DECIMALS[po.token];
              return (
                <div key={String(po.id)} className="row" style={{
                  gap: 10, padding: '10px 0', fontSize: 12.5, flexWrap: 'wrap',
                  borderTop: '1px solid var(--border)', justifyContent: 'space-between',
                }}>
                  <span className="row" style={{ gap: 10 }}>
                    <Icon name={meta.icon} size={14} stroke="var(--burn)" />
                    <span className="col" style={{ gap: 2 }}>
                      <b>{meta.label}</b>
                      <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
                        {meta.blurb} · {payoutDate(po.created_at)}
                      </span>
                    </span>
                  </span>
                  <Chip tone="ok">
                    +{fmtTokenAmount(po.amount, tok.decimals)} {tok.label}
                  </Chip>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
