import { useEffect, useState } from 'react';
import { Principal } from "@icp-sdk/core/principal";
import { TxDirection, IdeaToken } from "./bindings/backend";
import type { TransactionRecord } from "./bindings/backend";
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
  isLocal: boolean;
  onSignIn: () => void;
}

const TX_META: Record<string, { label: string; icon: string; blurb: string }> = {
  // In — payouts the site made to you.
  LotteryWin: { label: 'Lottery jackpot', icon: 'target', blurb: '80% of the prize pool' },
  UnstakeDisbursement: { label: 'Unstake disbursement', icon: 'zap', blurb: 'Dissolved stake returned to your wallet' },
  IdeaUpvoteShare: { label: 'Idea upvote share', icon: 'bulb', blurb: '25% poster share of an upvote' },
  CommitmentRefund: { label: 'Commitment refund', icon: 'undo', blurb: 'Escrow returned — threshold unmet' },
  PoolReward: { label: 'Pool reward', icon: 'arrowUp', blurb: '25% of a settled burn, shared by top pool neurons' },
  // Out — what you put in.
  deposit: { label: 'Burn commitment', icon: 'flame', blurb: 'Escrowed behind a proposal stance' },
  add_commitment: { label: 'Commitment top-up', icon: 'flame', blurb: 'Added to an open commitment' },
  idea_post: { label: 'Idea post fee', icon: 'bulb', blurb: '1 ICP anti-spam fee to the treasury' },
  idea_upvote: { label: 'Idea upvote', icon: 'bulb', blurb: '75% treasury · 25% to the poster' },
  project_fund: { label: 'Project funding', icon: 'coins', blurb: '100% to the treasury build fund' },
  pool_register: { label: 'Pool initiation fee', icon: 'target', blurb: 'One-time neuron pool entry' },
  stake: { label: 'Stake lockup', icon: 'zap', blurb: 'Locked, not spent — returns in full on unstake' },
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

export default function Payouts({ actor, principal, isLocal, onSignIn }: PayoutsProps) {
  const signedIn = !!(principal && !principal.isAnonymous());
  const [txs, setTxs] = useState<TransactionRecord[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      if (!actor || !signedIn) { setTxs([]); setLoaded(false); return; }
      try {
        let mine = await actor.get_my_transactions();
        // Local dev: seed a varied mock history on first visit so the page
        // is never empty while testing (no-op on mainnet and once seeded).
        if (isLocal && mine.length === 0) {
          const res = await actor.dev_seed_payouts();
          if (res.__kind__ === "Ok") mine = await actor.get_my_transactions();
        }
        setTxs(mine);
        setLoaded(true);
      } catch (err) {
        console.error("Failed to fetch transactions:", err);
      }
    })();
  }, [actor, principal, signedIn, isLocal]);

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
        <b style={{ fontSize: 17 }}>Your account. Every ICP in, every ICP out.</b>
        <span style={{ fontSize: 12.5, color: 'var(--fg-2)', maxWidth: 640 }}>
          Commitments, fees, stakes and upvotes on one side — jackpots, disbursements,
          shares and refunds on the other. Payouts land in your wallet automatically the
          moment they settle; this is the full receipt trail, newest first.
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
        <Eyebrow>Transaction history</Eyebrow>
        {!signedIn ? (
          <div className="col" style={{ gap: 10, alignItems: 'flex-start' }}>
            <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
              Sign in to see your profile and transaction history.
            </span>
            <Btn variant="primary" sm onClick={onSignIn}>
              <Icon name="key" size={13} stroke="var(--char-950)" /> Sign in
            </Btn>
          </div>
        ) : txs.length === 0 ? (
          <span style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>
            {loaded
              ? "Nothing yet — commit to a proposal, stake, or post an idea and every movement shows up here."
              : "Loading…"}
          </span>
        ) : (
          <div className="col" style={{ gap: 0 }}>
            {txs.map((tx, i) => {
              const meta = TX_META[tx.kind] ?? { label: tx.kind, icon: 'coins', blurb: '' };
              const tok = TOKEN_DECIMALS[tx.token];
              const incoming = tx.direction === TxDirection.In;
              return (
                <div key={`${tx.kind}-${String(tx.timestamp)}-${i}`} className="row" style={{
                  gap: 10, padding: '10px 0', fontSize: 12.5, flexWrap: 'wrap',
                  borderTop: '1px solid var(--border)', justifyContent: 'space-between',
                }}>
                  <span className="row" style={{ gap: 10 }}>
                    <Icon name={meta.icon} size={14} stroke={incoming ? 'var(--sprout)' : 'var(--burn)'} />
                    <span className="col" style={{ gap: 2 }}>
                      <b>{meta.label}</b>
                      <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
                        {meta.blurb ? `${meta.blurb} · ` : ''}{payoutDate(tx.timestamp)}
                      </span>
                    </span>
                  </span>
                  <Chip tone={incoming ? 'ok' : 'muted'}>
                    {incoming ? '+' : '−'}{fmtTokenAmount(tx.amount, tok.decimals)} {tok.label}
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
