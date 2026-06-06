// pob-parts.jsx — Proof of Burn composite parts. Depends on pob-kit.jsx.
const { useState, useContext } = React;
const { PobCtx, Icon, Eyebrow, Chip, Btn, Bar, HeatBar, Gate, Reveal, LiveDot, useCountUp } = window;

// ── shared data ───────────────────────────────────────────────
const FEED = [
  { id: 'ROAD-138402', cat: 'Network economics', deadline: '2d 14h', pct: 64, committed: 318, req: 500,
    status: 'open', mine: 'pending', title: 'Reduce node-provider rewards by 12% to slow inflation' },
  { id: 'ROAD-138388', cat: 'Governance', deadline: '5d 02h', pct: 100, committed: 500, req: 500,
    status: 'met', mine: 'met', title: 'Adopt SNS-3 treasury allocation framework' },
  { id: 'ROAD-138376', cat: 'Node provider', deadline: '14h', pct: 28, committed: 141, req: 500,
    status: 'open', title: 'Onboard eu-central-2 datacenter to the subnet' },
];

const TIER_META = [
  ['Tier 0', 'Anonymous visitor', 'Minimum to understand + start', 'lands on the page'],
  ['Tier 1', 'Authenticated', 'Signed in via Internet Identity', 'signs in'],
  ['Tier 2', 'Verified follower', 'On-chain follow confirmed', 'follows the neuron'],
  ['Tier 3', 'Active participant', 'Has committed to burn', 'commits on ≥1 proposal'],
];

// ── app header ────────────────────────────────────────────────
function Header({ tier }) {
  return <Reveal style={{ flexShrink: 0 }}>
    <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
      <div className="row" style={{ gap: 10 }}>
        <span style={{ width: 32, height: 32, display: 'grid', placeItems: 'center', flexShrink: 0,
          border: '1px solid var(--burn)', borderRadius: 8, background: 'var(--burn-950)' }}>
          <Icon name="flame" size={17} stroke="var(--burn)" /></span>
        <b style={{ fontFamily: 'var(--font-display)', fontSize: 18, letterSpacing: '-0.02em', color: 'var(--fg)' }}>Proof of Burn</b>
      </div>
      {tier === 0
        ? <Btn variant="primary" sm><Icon name="key" size={14} stroke="var(--char-950)" /> Sign in</Btn>
        : <span className="row" style={{ gap: 8, height: 30, padding: '0 10px', borderRadius: 6, flexShrink: 0,
            border: '1px solid var(--border-hi)', background: 'var(--surface)', whiteSpace: 'nowrap' }}>
            <Icon name="wallet" size={14} stroke="var(--fg-2)" />
            <span className="mono" style={{ fontSize: 12.5, color: 'var(--fg)' }}>7xk2…q9f</span>
            <LiveDot color="var(--sprout)" size={6} />
          </span>}
    </div>
  </Reveal>;
}

// ── personal dashboard strip (tier 3) ─────────────────────────
function DashStrip() {
  const { motion } = useContext(PobCtx);
  const on = motion !== 'off';
  const committed = useCountUp(44.5, { enabled: on, decimals: 1 });
  const burned = useCountUp(12.4, { enabled: on, decimals: 1 });
  const joined = useCountUp(5, { enabled: on, decimals: 0 });
  const stats = [
    ['Committed', committed + ' ICP', 'coins'],
    ['Burned to date', burned + ' ICP', 'flame'],
    ['Proposals joined', joined, 'checkCircle'],
  ];
  return <Reveal delay={40} style={{ flexShrink: 0 }}>
    <div className="row" style={{ border: '1px solid var(--burn)', borderRadius: 10, background: 'var(--burn-950)',
      padding: '14px 6px' }}>
      {stats.map(([k, v, ic], i) =>
        <div key={i} className="col" style={{ gap: 4, flex: 1, alignItems: 'center', textAlign: 'center',
          borderLeft: i ? '1px solid color-mix(in srgb, var(--burn) 28%, transparent)' : 'none' }}>
          <span className="row" style={{ gap: 6, alignItems: 'center' }}>
            <Icon name={ic} size={15} stroke="var(--burn)" />
            <span className="mono" style={{ fontSize: 20, fontWeight: 500, color: 'var(--fg)', letterSpacing: '-0.01em' }}>{v}</span>
          </span>
          <Eyebrow>{k}</Eyebrow>
        </div>)}
    </div>
  </Reveal>;
}

// ── neuron hero ───────────────────────────────────────────────
function NeuronBlock({ tier }) {
  const following = tier >= 2;
  return <Reveal delay={70} style={{ flexShrink: 0 }}>
    <div className="col" style={{ gap: 13, border: '1px solid var(--border)', borderRadius: 10,
      background: 'var(--surface)', padding: 16 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div className="col" style={{ gap: 7, minWidth: 0 }}>
          <Eyebrow>Follow this neuron</Eyebrow>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <span className="mono" style={{ fontSize: 18, color: 'var(--fg)', letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>Neuron 4.821.667</span>
            <button title="Copy neuron ID" style={{ display: 'grid', placeItems: 'center', width: 24, height: 24,
              borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', color: 'var(--fg-3)', cursor: 'pointer' }}>
              <Icon name="copy" size={12} /></button>
          </div>
        </div>
        {following
          ? <Chip tone="ok" style={{ height: 24 }}><Icon name="check" size={12} /> Following</Chip>
          : <Chip tone="muted" style={{ height: 24 }}><LiveDot color="var(--fg-3)" on={false} /> Not following</Chip>}
      </div>
      {/* voting-weight meta line */}
      <div className="col" style={{ gap: 6 }}>
        <div style={{ height: 6, borderRadius: 999, background: 'var(--char-800)', overflow: 'hidden' }}>
          <div style={{ width: '72%', height: '100%', background: 'var(--border-hi)', borderRadius: 999 }} /></div>
        <div className="row" style={{ justifyContent: 'space-between', gap: 10 }}>
          <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)', whiteSpace: 'nowrap' }}>VP 4,821,667 · 1,204 votes</span>
          <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)', whiteSpace: 'nowrap', flexShrink: 0 }}>8y dissolve</span>
        </div>
      </div>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', paddingTop: 2,
        borderTop: '1px solid var(--border)', marginTop: 1 }}>
        <a href="#" style={{ textDecoration: 'none', flexShrink: 0 }}>
          <span className="row" style={{ gap: 6, color: 'var(--fg-2)', fontSize: 13, whiteSpace: 'nowrap' }}>
            <Icon name="external" size={13} /> Open in NNS</span></a>
        {!following
          ? (tier === 0
              ? <span className="row" style={{ gap: 6, color: 'var(--burn)', fontSize: 12.5, whiteSpace: 'nowrap' }}>
                  <Icon name="arrowUp" size={13} stroke="var(--burn)" /> Sign in to follow</span>
              : <Btn variant="primary" sm><Icon name="check" size={13} stroke="var(--char-950)" /> Follow neuron</Btn>)
          : <span className="row" style={{ gap: 6, color: 'var(--sprout)', fontSize: 12.5 }}>
              <Icon name="checkCircle" size={13} stroke="var(--sprout)" /> Verified on-chain</span>}
      </div>
    </div>
  </Reveal>;
}

// ── AI proposal-review panel ──────────────────────────────────
function AIPanel({ open, onToggle }) {
  return <div style={{ border: '1px solid var(--burn)', borderRadius: 8, background: 'var(--burn-950)', overflow: 'hidden' }}>
    <button onClick={onToggle} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: 10, padding: '9px 12px', background: 'transparent', border: 'none', cursor: 'pointer' }}>
      <span className="row" style={{ gap: 7, color: 'var(--burn)', fontSize: 13 }}>
        <Icon name="spark" size={14} stroke="var(--burn)" /> AI review</span>
      <span className="row" style={{ gap: 9 }}>
        <Chip tone="burn" style={{ height: 20, fontSize: 11 }}>Impact 7.4</Chip>
        <Icon name={open ? 'chevDown' : 'chevRight'} size={15} stroke="var(--fg-3)" />
      </span>
    </button>
    {open && <div className="col" style={{ gap: 9, padding: '0 12px 12px' }}>
      <p style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--fg-1)', margin: 0 }}>
        Cuts emission ~12% with negligible decentralization risk. Node-provider churn is the main downside —
        three small operators fall below break-even at current cycle prices.</p>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', paddingTop: 8,
        borderTop: '1px solid color-mix(in srgb, var(--burn) 25%, transparent)' }}>
        <span className="row" style={{ gap: 6, fontSize: 11.5, color: 'var(--fg-2)', cursor: 'pointer',
          textDecoration: 'underline dotted', textUnderlineOffset: 3 }}>
          <Icon name="info" size={12} stroke="var(--fg-3)" /> System prompt + tools used</span>
        <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>paid · 0.05 ICP</span>
      </div>
    </div>}
  </div>;
}

// ── proposal row (adapts per tier) ────────────────────────────
function ProposalRow({ tier, p, idx }) {
  const { ai, motion } = useContext(PobCtx);
  const showBurn = tier >= 1;
  const canCommit = tier >= 2;
  const [aiOpen, setAiOpen] = useState(ai === 'expanded' && idx === 0);
  React.useEffect(() => { setAiOpen(ai === 'expanded' && idx === 0); }, [ai, idx]);

  const statusChip = {
    open: <Chip tone="muted"><LiveDot on={motion !== 'off'} /> Open</Chip>,
    met: <Chip tone="ok"><Icon name="check" size={11} /> Threshold met</Chip>,
  }[p.status];

  const mineBadge = tier >= 3 && p.mine && ({
    pending: <Chip tone="dashed">You · pending</Chip>,
    met: <Chip tone="burn"><Icon name="flame" size={11} stroke="var(--burn)" /> You · burning soon</Chip>,
  }[p.mine]);

  const committedLabel = `${p.committed} ICP committed`;
  const reqLabel = p.status === 'met' ? `${p.pct}% · met` : `${p.pct}% of ${p.req} ICP`;

  return <Reveal delay={120 + idx * 70} style={{ flexShrink: 0 }}>
    <div className="col" style={{ gap: 12, border: `1px solid ${p.status === 'met' ? 'var(--sprout)' : 'var(--border)'}`,
      borderRadius: 8, background: 'var(--surface)', padding: 14 }}>
      {/* header line */}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div className="col" style={{ gap: 7, minWidth: 0, flex: 1 }}>
          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Chip tone="muted" style={{ height: 20, fontSize: 11 }}>{p.cat}</Chip>
            <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)', whiteSpace: 'nowrap' }}>{p.id}</span>
          </div>
          <span style={{ fontSize: 14, lineHeight: 1.35, color: 'var(--fg)', fontWeight: 500, textWrap: 'pretty' }}>{p.title}</span>
        </div>
        <div className="col" style={{ alignItems: 'flex-end', gap: 7, flexShrink: 0 }}>
          <Chip tone="muted" style={{ height: 22 }}><Icon name="clock" size={11} /> {p.deadline}</Chip>
          {tier >= 1 && statusChip}
        </div>
      </div>

      {/* burn progress — gated for anon */}
      {showBurn
        ? <HeatBar pct={p.pct} committed={committedLabel} req={reqLabel} met={p.status === 'met'} animate />
        : <Gate hint="Sign in to unlock" height={44}>
            <HeatBar pct={48} committed="●●● ICP committed" req="●● of ●●● ICP" />
          </Gate>}

      {/* action zone */}
      {tier >= 1 && <div style={{ borderTop: '1px solid var(--border)' }} />}

      {tier === 1 &&
        <Gate hint="Follow neuron to unlock" next height={42}>
          <div className="row" style={{ gap: 8 }}>
            <span className="row" style={{ flex: 1, justifyContent: 'space-between', height: 32, padding: '0 10px',
              borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--fg-3)', fontSize: 13 }}>
              <span style={{ whiteSpace: 'nowrap' }}>Amount to burn</span><span className="mono">ICP</span></span>
            <Btn variant="primary" sm>Commit</Btn>
            <Btn variant="ghost" sm><Icon name="spark" size={13} /> AI</Btn>
          </div>
        </Gate>}

      {canCommit && <div className="col" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 8 }}>
          <span className="row" style={{ flex: 1, justifyContent: 'space-between', height: 34, padding: '0 11px',
            borderRadius: 6, border: '1px solid var(--border-hi)', background: 'var(--bg)' }}>
            <span style={{ fontSize: 13, color: 'var(--fg-3)', whiteSpace: 'nowrap' }}>Amount to burn</span>
            <span className="mono" style={{ fontSize: 13, color: 'var(--fg-3)' }}>ICP</span></span>
          <Btn variant="primary" sm><Icon name="flame" size={13} stroke="var(--char-950)" /> Commit</Btn>
          <Btn variant="secondary" sm><Icon name="spark" size={13} /> AI review</Btn>
        </div>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
          <span className="row" style={{ gap: 6, fontSize: 12, color: 'var(--fg-2)', whiteSpace: 'nowrap', flexShrink: 0 }}>
            <Icon name="coins" size={12} stroke="var(--fg-3)" /> Holdings <span className="mono" style={{ color: 'var(--fg)' }}>38.0 ICP</span>
            <span style={{ color: 'var(--fg-3)' }}>· cap enforced</span></span>
          {mineBadge}
        </div>
      </div>}

      {/* AI review panel */}
      {canCommit && ai !== 'hidden' && <AIPanel open={aiOpen} onToggle={() => setAiOpen(o => !o)} />}

      {/* no-burn safety note for verified users */}
      {canCommit && <span className="row" style={{ gap: 6, fontSize: 11.5, color: 'var(--fg-3)' }}>
        <Icon name="undo" size={12} stroke="var(--fg-3)" /> No burn if threshold misses — committed ICP is returned.</span>}
    </div>
  </Reveal>;
}

// ── vote history (gated for anon) ─────────────────────────────
function VoteHistory({ tier }) {
  const rows = [
    ['Increase replica memory ceiling to 8 GiB', 'yes', '12.4'],
    ['Deprecate legacy ledger archive canister', 'against', '6.0'],
    ['Fund developer-grant round 7 (40k ICP)', 'yes', '20.1'],
  ];
  const body = <div className="col" style={{ gap: 0 }}>
    {rows.map(([t, v, burned], i) =>
      <div key={i} className="row" style={{ justifyContent: 'space-between', gap: 12, padding: '10px 0',
        borderBottom: i < rows.length - 1 ? '1px solid var(--border)' : 'none' }}>
        <span style={{ fontSize: 12.5, color: 'var(--fg-1)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
          whiteSpace: 'nowrap' }}>{t}</span>
        <div className="row" style={{ gap: 9, flexShrink: 0 }}>
          <Chip tone={v === 'against' ? 'muted' : 'ok'} style={{ height: 20, fontSize: 11 }}>{v}</Chip>
          <span className="mono" style={{ fontSize: 11.5, color: 'var(--burn)', width: 78, textAlign: 'right' }}>{burned} burned</span>
        </div>
      </div>)}
  </div>;
  return <Reveal delay={300} style={{ flexShrink: 0 }}>
    <div className="col" style={{ gap: 11 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className="row" style={{ gap: 8 }}><Icon name="list" size={15} stroke="var(--fg-2)" />
          <b style={{ fontSize: 14, color: 'var(--fg)' }}>Vote history</b></span>
        <Eyebrow>neuron votes · outcome · burned</Eyebrow>
      </div>
      {tier >= 1 ? body : <Gate hint="Sign in to unlock" height={120}>{body}</Gate>}
    </div>
  </Reveal>;
}

Object.assign(window, { FEED, TIER_META, Header, DashStrip, NeuronBlock, AIPanel, ProposalRow, VoteHistory });
