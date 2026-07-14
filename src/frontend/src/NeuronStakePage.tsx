import { useState } from "react";
import { Principal } from "@icp-sdk/core/principal";
import { Icon, Eyebrow, Chip, LiveDot, usePageHelp } from "./ui";
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
  onActivity: () => void;
  onGoExchange: () => void;
  onGoLiquidity: () => void;
}

export default function NeuronStakePage({
  actor, identity, principal, host, rootKey, ledgerCanisterId,
  isLocal, boostersEnabled, isAdmin, treasuryCanFront, onActivity, onGoExchange, onGoLiquidity,
}: NeuronStakePageProps) {
  // Stake-page tabs (owner 2026-07-14): New = stake form + term pools;
  // Current = dissolving unstakes + the bonds you hold.
  const [tab, setTab] = useState<'new' | 'current'>('new');
  usePageHelp(() => (
    <>
      <div className="col" style={{ gap: 6 }}>
        <Eyebrow accent>The gist</Eyebrow>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>
          <b>Your ICP stays yours.</b> Staking mints free daily lottery
          tickets and issues a <b>Bond NFT</b> for the position — the
          bond IS your stake, and it's tradeable.
        </p>
      </div>
      <div className="col" style={{ gap: 6 }}>
        <Eyebrow accent>Earning tickets</Eyebrow>
        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
          <li><b>1 / 5 / 10 / 20 tickets a day per ICP</b> for 2-week / 6-month / 1-year / 2-year terms — tiers add up.</li>
          <li><b>Scales with your stake:</b> 500 ICP for 2 years is 10,000 tickets every day.</li>
          <li><b>Tickets follow the bond</b> — whoever holds it earns; a bond <b>listed for sale pauses</b> its tickets until delisted.</li>
        </ul>
      </div>
      <div className="col" style={{ gap: 6 }}>
        <Eyebrow accent>Three ways out</Eyebrow>
        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
          <li><b>Wait for the dissolve</b> — redeem the bond and your full principal returns after the term. 100%, never gated.</li>
          <li><b>Instant exit</b> — the house buys the bond back on the spot for 85% of principal (an optional express-exit fee).</li>
          <li><b>Sell it</b> — list at any ask on the marketplace; the buyer takes over the stake and its tickets.</li>
        </ul>
      </div>
      <div className="col" style={{ gap: 6 }}>
        <Eyebrow accent>Why stake</Eyebrow>
        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
          <li><b>The platform key:</b> staking ICP here (or an LP position on the Liquidity Provider pages) unlocks game competitions and every ticket source.</li>
        </ul>
      </div>
    </>
  ), []);
  return (
    <>
      <div className="idea-board-container" style={{ paddingBottom: 0 }}>
        {/* ── Page header ── */}
        <div className="col" style={{ gap: 6 }}>
          <span className="row" style={{ gap: 10, width: '100%', flexWrap: 'wrap' }}>
            <Icon name="zap" size={22} stroke="var(--burn-ink)" />
            <h4 style={{ margin: 0 }}>Stake</h4>
            <Chip tone="pending"><LiveDot size={6} /> daily tickets</Chip>
          </span>
          <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>
            Every stake is issued as a <b>Bond NFT</b> — open the <b>Current</b> tab
            to sell it, redeem it, or take an instant exit.
          </span>
        </div>
      </div>

      {/* ── Tabs (wallet-tab idiom): New stake vs what you already hold ── */}
      <div className="idea-board-container" style={{ paddingTop: 0, paddingBottom: 0 }}>
        <div className="row" style={{ gap: 6 }}>
          {([['new', 'New', 'zap'], ['current', 'Current', 'star']] as const).map(([key, label, icon]) => {
            const active = tab === key;
            return (
              <button
                key={key}
                onClick={() => setTab(key)}
                style={{
                  flex: 1, padding: '7px 4px', borderRadius: 7, cursor: 'pointer', fontSize: 12,
                  fontWeight: active ? 700 : 500, fontFamily: 'inherit',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  border: `1px solid ${active ? 'var(--burn)' : 'var(--border)'}`,
                  background: active ? 'color-mix(in srgb, var(--burn) 14%, transparent)' : 'transparent',
                  color: active ? 'var(--burn-ink)' : 'var(--fg-2)',
                }}
              >
                <Icon name={icon} size={12} stroke="currentColor" /> {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── New: create a stake + the term pools ── */}
      {tab === 'new' && (
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
          onActivity={onActivity}
          view="new"
        />
      )}

      {/* ── Current: dissolving unstakes + the bonds you hold ── */}
      {tab === 'current' && (
        <>
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
            onActivity={onActivity}
            view="current"
          />
          <VouchersBody
            actor={actor}
            identity={identity}
            principal={principal}
            host={host}
            rootKey={rootKey}
            ledgerCanisterId={ledgerCanisterId}
            section="mine"
            onGoExchange={onGoExchange}
            onGoLiquidity={onGoLiquidity}
          />
        </>
      )}
    </>
  );
}
