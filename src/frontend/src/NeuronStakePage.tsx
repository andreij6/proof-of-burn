import { Principal } from "@icp-sdk/core/principal";
import { Icon, Eyebrow, MoreInfo, Chip, LiveDot } from "./ui";
import Staking from "./Staking";
import { VouchersBody } from "./Vouchers";

// ==========================================
// Neuron Stake — the single staking home (nav: Stake 4 Tickets). Staking
// AUTO-ISSUES a Voucher NFT for every stake, so this page combines the
// staking UI (stake form, term pools, dissolves) with the voucher sections
// (your vouchers, your listings, the marketplace) below it. The old separate
// #/vouchers page redirects here.
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
  onGoExchange: () => void;
  onActivity: () => void;
}

export default function NeuronStakePage({
  actor, identity, principal, host, rootKey, ledgerCanisterId,
  isLocal, boostersEnabled, isAdmin, treasuryCanFront, onSignIn, onActivity, onGoExchange,
}: NeuronStakePageProps) {
  return (
    <>
      <div className="idea-board-container" style={{ paddingBottom: 0 }}>
        {/* ── Page header ── */}
        <div className="col" style={{ gap: 6 }}>
          <span className="row" style={{ gap: 10, width: '100%', flexWrap: 'wrap' }}>
            <Icon name="zap" size={22} stroke="var(--burn-ink)" />
            <h4 style={{ margin: 0 }}>Neuron Stake</h4>
            <Chip tone="pending"><LiveDot size={6} /> daily tickets</Chip>
            <MoreInfo
              title="How staking & vouchers work"
              style={{
                marginLeft: 'auto', textDecoration: 'none', fontSize: 12.5, fontWeight: 600,
                border: '1px solid var(--burn)', borderRadius: 999, padding: '6px 14px',
                background: 'color-mix(in srgb, var(--burn) 10%, var(--surface))',
              }}
            >
              <div className="card col" style={{ gap: 8, borderColor: 'var(--burn)', background: 'color-mix(in srgb, var(--burn) 12%, var(--surface))' }}>
                <Eyebrow accent>The gist</Eyebrow>
                <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
                  <b>Your ICP stays yours.</b> Staking mints free daily lottery
                  tickets and issues a <b>Voucher NFT</b> for the position — the
                  voucher IS your stake, and it's tradeable.
                </p>
              </div>
              <div className="col" style={{ gap: 6 }}>
                <Eyebrow accent>Earning tickets</Eyebrow>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                  <li><b>5 / 10 / 20 tickets a day per ICP</b> for 6-month / 1-year / 2-year terms — tiers add up.</li>
                  <li><b>Scales with your stake:</b> 500 ICP for 2 years is 10,000 tickets every day.</li>
                  <li><b>Tickets follow the voucher</b> — whoever holds it earns; a voucher <b>listed for sale pauses</b> its tickets until delisted.</li>
                </ul>
              </div>
              <div className="col" style={{ gap: 6 }}>
                <Eyebrow accent>Three ways out</Eyebrow>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                  <li><b>Wait for the dissolve</b> — redeem the voucher and your full principal returns after the term. 100%, never gated.</li>
                  <li><b>Instant exit</b> — the house buys the voucher back on the spot for 85% of principal (an optional express-exit fee).</li>
                  <li><b>Sell it</b> — list at any ask on the marketplace; the buyer takes over the stake and its tickets.</li>
                </ul>
              </div>
              <div className="col" style={{ gap: 6 }}>
                <Eyebrow accent>Why stake</Eyebrow>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                  <li><b>The platform key:</b> game competitions, LP rewards, and every other ticket source require an active stake (any amount).</li>
                </ul>
              </div>
            </MoreInfo>
          </span>
          <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>
            Every stake is issued as a <b>Voucher NFT</b> below — sell it, redeem
            it, or take an instant exit, right on this page.
          </span>
        </div>
      </div>

      <VouchersBody
        actor={actor}
        identity={identity}
        principal={principal}
        host={host}
        rootKey={rootKey}
        ledgerCanisterId={ledgerCanisterId}
        onSignIn={onSignIn}
        section="mine"
        onGoExchange={onGoExchange}
      />

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
