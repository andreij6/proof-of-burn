// pob-page.jsx — frame chrome + full page assembly. Depends on pob-kit + pob-parts.
const { Icon, Eyebrow, Reveal, Header, DashStrip, NeuronBlock, ProposalRow, VoteHistory, FEED } = window;

const Dots = () => <div className="row" style={{ gap: 6 }}>
  {[0, 1, 2].map(i => <span key={i} style={{ width: 9, height: 9, borderRadius: 999,
    background: 'var(--char-700)', opacity: 0.7 }} />)}</div>;

// ── desktop browser chrome ────────────────────────────────────
function Browser({ children, w = 600 }) {
  return <div style={{ width: w, border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden',
    background: 'var(--bg)', boxShadow: 'var(--elev-3)' }}>
    <div className="row" style={{ height: 42, alignItems: 'center', gap: 12, padding: '0 14px',
      borderBottom: '1px solid var(--border)', background: 'var(--bg-alt)' }}>
      <Dots />
      <div className="row" style={{ flex: 1, justifyContent: 'center' }}>
        <span className="row" style={{ gap: 7, height: 26, padding: '0 14px', borderRadius: 6,
          background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <Icon name="lock" size={11} stroke="var(--fg-3)" />
          <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-2)' }}>proofofburn.icp</span></span>
      </div>
      <Icon name="refresh" size={14} stroke="var(--fg-3)" />
    </div>
    <div className="col" style={{ padding: 22, gap: 18 }}>{children}</div>
  </div>;
}

// ── mobile phone frame ────────────────────────────────────────
function Phone({ children, w = 360 }) {
  return <div style={{ width: w, border: '1px solid var(--char-700)', borderRadius: 40, padding: 9,
    background: '#000', boxShadow: 'var(--elev-3)' }}>
    <div style={{ borderRadius: 32, overflow: 'hidden', background: 'var(--bg)' }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', padding: '11px 24px 7px' }}>
        <span className="mono" style={{ fontSize: 12.5, color: 'var(--fg)', fontWeight: 500 }}>9:41</span>
        <div className="row" style={{ gap: 6, alignItems: 'center', color: 'var(--fg)' }}>
          <svg width="17" height="11" viewBox="0 0 17 11" fill="currentColor"><rect x="0" y="7" width="3" height="4" rx="1"/><rect x="4.5" y="4.5" width="3" height="6.5" rx="1"/><rect x="9" y="2" width="3" height="9" rx="1"/><rect x="13.5" y="0" width="3" height="11" rx="1" opacity="0.4"/></svg>
          <svg width="16" height="11" viewBox="0 0 16 11" fill="currentColor"><path d="M8 2.5c2 0 3.8.8 5.2 2L14.6 3C12.8 1.3 10.5.4 8 .4S3.2 1.3 1.4 3l1.4 1.5C4.2 3.3 6 2.5 8 2.5z"/><path d="M8 6c1 0 2 .4 2.7 1.1L8 10l-2.7-2.9C6 6.4 7 6 8 6z"/></svg>
          <svg width="26" height="12" viewBox="0 0 26 12" fill="none"><rect x="0.5" y="0.5" width="22" height="11" rx="3" stroke="currentColor" opacity="0.5"/><rect x="2" y="2" width="17" height="8" rx="1.5" fill="currentColor"/><rect x="24" y="3.5" width="1.5" height="5" rx="0.75" fill="currentColor" opacity="0.5"/></svg>
        </div>
      </div>
      <div className="col" style={{ padding: '8px 15px 20px', gap: 15 }}>{children}</div>
    </div>
  </div>;
}

// ── full page at a given tier ─────────────────────────────────
function PageView({ tier, mobile }) {
  const feed = FEED.slice(0, mobile ? 2 : 3);
  return <>
    <Header tier={tier} />
    {tier >= 3 && <DashStrip />}
    <NeuronBlock tier={tier} />
    <Reveal delay={100} style={{ flexShrink: 0 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
        <span className="row" style={{ gap: 8, whiteSpace: 'nowrap', flexShrink: 0 }}><Icon name="list" size={15} stroke="var(--fg-2)" />
          <b style={{ fontSize: 14, color: 'var(--fg)' }}>Active proposals</b>
          <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>· {feed.length}</span></span>
        {!mobile && <Eyebrow style={{ whiteSpace: 'nowrap' }}>title · category · deadline</Eyebrow>}
      </div>
    </Reveal>
    <div className="col" style={{ gap: 12 }}>
      {feed.map((p, i) => <ProposalRow key={p.id} tier={tier} p={p} idx={i} />)}
    </div>
    <VoteHistory tier={tier} />
  </>;
}

// frame wrapper that applies a theme + renders a page
function TierFrame({ tier, mobile, theme }) {
  const Chrome = mobile ? Phone : Browser;
  return <div data-theme={theme === 'light' ? 'light' : undefined} style={{ display: 'inline-block' }}>
    <Chrome><PageView tier={tier} mobile={mobile} /></Chrome>
  </div>;
}

Object.assign(window, { Browser, Phone, PageView, TierFrame });
