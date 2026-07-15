import { Principal } from '@icp-sdk/core/principal';
import { Chip, Eyebrow, Icon, LiveDot, usePageHelp } from './ui';
import { VouchersBody } from './Vouchers';

// ==========================================
// Voucher Exchange — the secondary market for stake vouchers, split out of
// the Neuron Stake page (owner 2026-07-10): your listings (when any) + the
// best-deals-first grid. Buying/selling mechanics all live in VouchersBody.
// ==========================================

interface VoucherExchangeProps {
  actor: any;
  identity: any;
  principal: Principal | null;
  host: string;
  rootKey?: Uint8Array;
  ledgerCanisterId: string;
}

export default function VoucherExchange(props: VoucherExchangeProps) {
  usePageHelp(() => (
    <>
      <div className="col" style={{ gap: 6 }}>
        <Eyebrow accent>The gist</Eyebrow>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>
          <b>Buy staked ICP at market price.</b> Every bond is real staked
          principal earning daily lottery tickets — sellers set the ask, and
          the best deals float to the top.
        </p>
      </div>
      <div className="col" style={{ gap: 6 }}>
        <Eyebrow accent>Buying</Eyebrow>
        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
          <li><b>Value vs Asking:</b> Value is the bond's staked principal; Asking is the seller's price. Below-value asks are marked as deals.</li>
          <li><b>Tickets follow the bond</b> — you earn its daily tickets from the next grant after buying, <b>including its age bonus</b>: bonds earn +1% at mint growing to +25% at 10 years old, and the age travels with the NFT.</li>
          <li><b>Redeem anytime:</b> wait out the dissolve for 100%, take the instant 85% exit, or re-list it here.</li>
        </ul>
      </div>
      <div className="col" style={{ gap: 6 }}>
        <Eyebrow accent>Selling</Eyebrow>
        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
          <li><b>List from your bonds</b> right here or on the Stake page — you set the ask in ICP.</li>
          <li><b>Listed bonds pause ticket earning</b> until sold or delisted — and after a 3-day grace the age bonus slowly decays (at the same rate it grows), so price to sell rather than to sit.</li>
          <li><b>Tickets leave with the bond:</b> the tickets it earned you this round are removed from your entry when it sells or transfers.</li>
          <li>A small marketplace fee comes out of the sale.</li>
        </ul>
      </div>
    </>
  ), []);
  return (
    <div className="idea-board-container">
      {/* ── Header (lottery-page pattern) ── */}
      <div className="col" style={{ gap: 6 }}>
        <span className="row" style={{ gap: 10, width: '100%', flexWrap: 'wrap' }}>
          <Icon name="scale" size={22} stroke="var(--burn-ink)" />
          <h4 style={{ margin: 0 }}>Bond Exchange</h4>
          <Chip tone="pending"><LiveDot size={6} /> best deals first</Chip>
        </span>
      </div>

      <VouchersBody {...props} section="exchange" />
    </div>
  );
}
