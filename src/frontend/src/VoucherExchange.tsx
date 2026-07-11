import { Principal } from '@icp-sdk/core/principal';
import { Chip, Eyebrow, Icon, LiveDot, MoreInfo } from './ui';
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
  onSignIn: () => void;
}

export default function VoucherExchange(props: VoucherExchangeProps) {
  return (
    <div className="idea-board-container">
      {/* ── Header (lottery-page pattern) ── */}
      <div className="col" style={{ gap: 6 }}>
        <span className="row" style={{ gap: 10, width: '100%', flexWrap: 'wrap' }}>
          <Icon name="scale" size={22} stroke="var(--burn-ink)" />
          <h4 style={{ margin: 0 }}>Voucher Exchange</h4>
          <Chip tone="pending"><LiveDot size={6} /> best deals first</Chip>
          <MoreInfo
            title="How the Voucher Exchange works"
            style={{
              marginLeft: 'auto', textDecoration: 'none', fontSize: 12.5, fontWeight: 600,
              border: '1px solid var(--burn)', borderRadius: 999, padding: '6px 14px',
              background: 'color-mix(in srgb, var(--burn) 10%, var(--surface))',
            }}
          >
            <div className="card col" style={{ gap: 8, borderColor: 'var(--burn)', background: 'color-mix(in srgb, var(--burn) 12%, var(--surface))' }}>
              <Eyebrow accent>The gist</Eyebrow>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
                <b>Buy staked ICP at market price.</b> Every voucher is real staked
                principal earning daily lottery tickets — sellers set the ask, and
                the best deals float to the top.
              </p>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <Eyebrow accent>Buying</Eyebrow>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                <li><b>Value vs Asking:</b> Value is the voucher's staked principal; Asking is the seller's price. Below-value asks are marked as deals.</li>
                <li><b>Tickets follow the voucher</b> — you earn its daily tickets from the next grant after buying.</li>
                <li><b>Redeem anytime:</b> wait out the dissolve for 100%, take the instant 85% exit, or re-list it here.</li>
              </ul>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <Eyebrow accent>Selling</Eyebrow>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                <li><b>List from your vouchers</b> on the Stake page — you set the ask in ICP.</li>
                <li><b>Listed vouchers pause ticket earning</b> until sold or delisted.</li>
                <li>A small marketplace fee comes out of the sale.</li>
              </ul>
            </div>
          </MoreInfo>
        </span>
      </div>

      <VouchersBody {...props} section="exchange" />
    </div>
  );
}
