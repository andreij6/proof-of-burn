// pob-app.jsx — canvas assembly + tweaks. Depends on design-canvas, tweaks-panel, pob-*.
const { DesignCanvas, DCSection, DCArtboard } = window;
const { useTweaks, TweaksPanel, TweakSection, TweakRadio, TweakColor } = window;
const { PobCtx, HEATS, Icon, Eyebrow, Chip, TierFrame, TIER_META } = window;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "heat": ["#FF6A1F", "#E04E0A", "#FFB080", "#FFE4D2", "#2A1409"],
  "gating": "Blur",
  "ai": "Collapsed",
  "motion": "Expressive"
}/*EDITMODE-END*/;

// caption above each frame
function Cap({ i, theme }) {
  const [tag, name, sub, trig] = TIER_META[i];
  return <div data-theme={theme === 'light' ? 'light' : undefined}
    className="col" style={{ gap: 3, marginBottom: 14, paddingLeft: 2 }}>
    <div className="row" style={{ gap: 9, alignItems: 'baseline' }}>
      <Eyebrow accent>{tag}</Eyebrow>
      <b style={{ fontFamily: 'var(--font-display)', fontSize: 16, letterSpacing: '-0.02em', color: 'var(--fg)' }}>{name}</b>
    </div>
    <span className="row" style={{ gap: 6, fontSize: 12, color: 'var(--fg-3)' }}>
      <Icon name="key" size={12} stroke="var(--fg-3)" /> unlocks when user {trig}</span>
  </div>;
}

// a labelled, themed frame inside an artboard
function Board({ tier, mobile, theme }) {
  return <div style={{ padding: mobile ? 18 : 24, background: 'transparent', height: '100%' }}>
    <Cap i={tier} theme={theme} />
    <TierFrame tier={tier} mobile={mobile} theme={theme} />
  </div>;
}

// desktop heights per tier (measured frame + caption/padding + AI-expand headroom)
const DH = [1110, 1320, 1720, 1840];
const DH_L = DH;
const MH = [1010, 1140, 1450, 1660];

function Intro() {
  const ladder = TIER_META.map(([tag, name, , trig], i) => ({ tag, name, trig, i }));
  return <div style={{ width: 620, minHeight: 620, background: 'var(--bg)', padding: 30,
    display: 'flex', flexDirection: 'column', gap: 20 }}>
    <div className="row" style={{ gap: 11 }}>
      <span style={{ width: 38, height: 38, display: 'grid', placeItems: 'center', flexShrink: 0,
        border: '1px solid var(--burn)', borderRadius: 9, background: 'var(--burn-950)' }}>
        <Icon name="flame" size={20} stroke="var(--burn)" /></span>
      <div className="col" style={{ gap: 2 }}>
        <b style={{ fontFamily: 'var(--font-display)', fontSize: 24, letterSpacing: '-0.02em', color: 'var(--fg)' }}>Proof of Burn</b>
        <Eyebrow>hi-fi · incentive layer</Eyebrow>
      </div>
    </div>
    <p style={{ fontSize: 15, lineHeight: 1.55, color: 'var(--fg-1)', margin: 0 }}>
      One page that <b style={{ color: 'var(--fg)' }}>expands in place</b> as a visitor clears auth and on-chain
      eligibility gates. Do nothing → see the minimum. Verify and commit → see everything. Gated regions stay
      visible but blurred, with an unlock hint — so the value is legible before you earn it.</p>
    <div style={{ borderTop: '1px solid var(--border)' }} />
    <div className="col" style={{ gap: 0 }}>
      <Eyebrow style={{ marginBottom: 12 }}>The four tiers</Eyebrow>
      {ladder.map(({ tag, name, trig, i }) =>
        <div key={i} className="row" style={{ gap: 13, alignItems: 'center', padding: '11px 0',
          borderBottom: i < 3 ? '1px solid var(--border)' : 'none' }}>
          <span className="mono" style={{ width: 26, height: 26, flexShrink: 0, display: 'grid', placeItems: 'center',
            borderRadius: 6, border: `1px solid ${i === 0 ? 'var(--border-hi)' : 'var(--burn)'}`,
            background: i === 0 ? 'transparent' : 'var(--burn-950)',
            color: i === 0 ? 'var(--fg-2)' : 'var(--burn)', fontSize: 12 }}>{i}</span>
          <div className="col" style={{ gap: 1, flex: 1 }}>
            <b style={{ fontSize: 14, color: 'var(--fg)' }}>{name}</b>
            <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>unlocks when user {trig}</span>
          </div>
          {i < 3 && <Icon name="arrowUp" size={15} stroke="var(--burn)" style={{ transform: 'rotate(90deg)' }} />}
        </div>)}
    </div>
    <div style={{ borderTop: '1px solid var(--border)' }} />
    <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
      <Chip tone="muted"><Icon name="lock" size={11} /> gated</Chip>
      <Chip tone="burn"><Icon name="spark" size={11} stroke="var(--burn)" /> unlocks next</Chip>
      <Chip tone="ok"><Icon name="check" size={11} /> threshold met</Chip>
      <span className="row" style={{ gap: 7, fontSize: 12, color: 'var(--fg-3)', marginLeft: 'auto' }}>
        <span style={{ width: 22, height: 6, borderRadius: 999, background: 'var(--burn)' }} /> burn progress</span>
    </div>
  </div>;
}

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  React.useEffect(() => {
    const p = Array.isArray(t.heat) ? t.heat : HEATS.Amber;
    const r = document.documentElement.style;
    r.setProperty('--burn', p[0]); r.setProperty('--burn-700', p[1]);
    r.setProperty('--burn-300', p[2]); r.setProperty('--burn-100', p[3]); r.setProperty('--burn-950', p[4]);
  }, [t.heat]);

  const ctx = { gating: (t.gating || 'Blur').toLowerCase(), ai: (t.ai || 'Collapsed').toLowerCase(),
    motion: (t.motion || 'Expressive').toLowerCase() };

  const tiers = [0, 1, 2, 3];

  return <PobCtx.Provider value={ctx}>
    <DesignCanvas>
      <DCSection id="intro" title="Proof of Burn — hi-fi" subtitle="Progressive disclosure across 4 eligibility tiers · Incentive Layer">
        <DCArtboard id="readme" label="Read me" width={620} height={680} style={{ background: 'var(--char-950)' }}>
          <Intro />
        </DCArtboard>
      </DCSection>

      <DCSection id="desk-dark" title="A · Four-tier progression — desktop · dark"
        subtitle="The page expanding in place. Gated regions stay visible but blurred.">
        {tiers.map(n =>
          <DCArtboard key={n} id={'dd-' + n} label={TIER_META[n][0] + ' · ' + TIER_META[n][1]}
            width={648} height={DH[n]} style={{ background: 'var(--char-950)' }}>
            <Board tier={n} theme="dark" />
          </DCArtboard>)}
      </DCSection>

      <DCSection id="desk-light" title="B · Four-tier progression — desktop · light"
        subtitle="Same page, light theme via the design system's data-theme override.">
        {tiers.map(n =>
          <DCArtboard key={n} id={'dl-' + n} label={TIER_META[n][0] + ' · ' + TIER_META[n][1]}
            width={648} height={DH_L[n]} style={{ background: 'var(--char-50)' }}>
            <Board tier={n} theme="light" />
          </DCArtboard>)}
      </DCSection>

      <DCSection id="mob-dark" title="C · Four-tier progression — mobile · dark"
        subtitle="Narrow viewport: one column, two proposals, actions wrap.">
        {tiers.map(n =>
          <DCArtboard key={n} id={'md-' + n} label={TIER_META[n][0]}
            width={400} height={MH[n]} style={{ background: 'var(--char-950)' }}>
            <Board tier={n} mobile theme="dark" />
          </DCArtboard>)}
      </DCSection>

      <DCSection id="mob-light" title="D · Four-tier progression — mobile · light"
        subtitle="Mobile, light theme.">
        {tiers.map(n =>
          <DCArtboard key={n} id={'ml-' + n} label={TIER_META[n][0]}
            width={400} height={MH[n]} style={{ background: 'var(--char-50)' }}>
            <Board tier={n} mobile theme="light" />
          </DCArtboard>)}
      </DCSection>
    </DesignCanvas>

    <TweaksPanel title="Tweaks">
      <TweakSection label="Burn accent" />
      <TweakColor label="Heat" value={t.heat}
        options={[HEATS.Amber, HEATS.Ember, HEATS.Citrine]}
        onChange={(v) => setTweak('heat', v)} />
      <TweakSection label="Gated regions" />
      <TweakRadio label="Style" value={t.gating}
        options={['Blur', 'Skeleton', 'Faded']}
        onChange={(v) => setTweak('gating', v)} />
      <TweakSection label="AI review" />
      <TweakRadio label="Panel" value={t.ai}
        options={['Collapsed', 'Expanded', 'Hidden']}
        onChange={(v) => setTweak('ai', v)} />
      <TweakSection label="Motion" />
      <TweakRadio label="Reveal" value={t.motion}
        options={['Expressive', 'Subtle', 'Off']}
        onChange={(v) => setTweak('motion', v)} />
    </TweaksPanel>
  </PobCtx.Provider>;
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
