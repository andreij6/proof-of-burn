import { useEffect, useState, useCallback, useMemo } from 'react';
import { Principal } from "@icp-sdk/core/principal";
import { FarmerStatus } from "./bindings/backend";
import type { Farmer, FarmerTier, XFarmQuote, XFarmDraft, XFarmInfo } from "./bindings/backend";
import { createActor as createLedgerActor } from "./bindings/ledger";
import { Icon, Eyebrow, Chip, Btn, LiveDot, MoreInfo, Skeleton, fmtICP, usePageDevControls } from "./ui";
import { useErrorImpression } from "./analytics";

// ==========================================
// X-Farm — per-user Farmer canisters that burn ICP→cycles to run Gemini drafting
// pro-ICP tweets the owner posts on X. Ships dark behind the `x_farm` flag. The
// owner pays a tier price (USD-priced via XRC, paid in ICP): 10% → treasury, 90%
// burned to the Farmer's 7-day cycle budget. A per-Farmer burn-only timer depletes
// that budget over 7 calendar days (the cycle balance IS the timer).
//
// REVISED MODEL (2026-06-19): a user may own UNLIMITED Farmers (list them all),
// and tweet generation is ON-DEMAND — drafts are requested only when the owner
// asks (the "Generate today's drafts" button), throttled server-side to at most
// once per day per Farmer. There is no autonomous generation timer.
//
// Closest precedents: Explorer (escrow pay flow + modal styles) for the pay
// dialog, LotteryHub for the page header. Spec: ideas/x-farm/01-ux-spec.md +
// ideas/x-farm/PARALLEL-WORK.md (authoritative for the revised model).
// ==========================================

const MODAL_OVERLAY: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(12, 10, 9, 0.85)',
  backdropFilter: 'blur(8px)', zIndex: 1000, display: 'flex',
  alignItems: 'center', justifyContent: 'center', padding: 16,
};
const MODAL_CARD: React.CSSProperties = {
  maxWidth: 540, width: '100%', gap: 16, background: 'var(--surface)',
  border: '1px solid var(--border-hi)', boxShadow: 'var(--elev-3)',
  maxHeight: '90vh', overflowY: 'auto',
};
const LABEL_STYLE: React.CSSProperties = {
  fontSize: 11, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)',
  textTransform: 'uppercase', letterSpacing: '0.06em',
};

const PERSONA_PRESETS: { id: string; label: string; description: string; text: string }[] = [
  {
    id: 'ai',
    label: 'AI Visionary',
    description: 'Latest AI trends through an ICP lens — dreams up on-chain AI use cases.',
    text: 'An AI-focused Internet Computer enthusiast, fluent in the latest AI trends and how they intersect with ICP. Loves imagining on-chain AI use cases — autonomous agents, on-chain inference, verifiable models, data sovereignty — that only ICP can enable. Forward-looking and imaginative.',
  },
  {
    id: 'bull',
    label: 'Price Bull',
    description: "Perma-bull on ICP's price potential and market upside.",
    text: "An ICP markets perma-bull, relentlessly optimistic about $ICP's long-term price potential. Frames fundamentals, adoption, and news as reasons the market is undervaluing the Internet Computer. Confident and momentum-driven (not financial advice).",
  },
  {
    id: 'tech',
    label: 'Tech Maximalist',
    description: "Compares other chains to ICP — champions ICP's technology.",
    text: 'An Internet Computer technology maximalist who compares other blockchains to ICP and makes the case for ICP\'s technical edge — reverse-gas, fully on-chain frontends, chain-key cryptography, web-speed finality, and true decentralization. Direct, comparison-driven, and evidence-based.',
  },
  {
    id: 'macro',
    label: 'Macro Disruptor',
    description: 'ICP as a disruptor reshaping tech, economics & sovereignty.',
    text: 'A macro and big-tech thinker who sees the Internet Computer as a structural disruptor — reshaping cloud computing, big tech, economics, and digital sovereignty. Connects ICP to broad trends like AI, data ownership, and the shift away from centralized platforms. Big-picture and thesis-driven.',
  },
  {
    id: 'funny',
    label: 'Crypto Comedian',
    description: 'Satire & jokes tying crypto, current events and sports to ICP.',
    text: 'A crypto comedian who writes jokes and satire about crypto and the Internet Computer, often tying in current events, sports, and Crypto-Twitter culture. Lighthearted, witty, and meme-aware — but still unmistakably pro-ICP.',
  },
];
const MAX_PERSONA = 300;

// Lifespan pricing: per-tier USD/day (Sprout $1 · Grow $1.50 · Bloom $2), 7–30 days,
// with 10% off the full 30-day lifespan. The final ICP price comes from the quote
// (the canister applies the same math). perDayUsd = tier.price_usd_e8s / 1e8.
const DISCOUNT_30DAY_PCT = 0.10;
const MIN_DAYS = 7;
const MAX_DAYS = 30;
function tierPerDayUsd(tier?: FarmerTier): number {
  return tier ? Number(tier.price_usd_e8s) / 100_000_000 : 0;
}
function lifespanUsd(days: number, perDayUsd: number): number {
  return days * perDayUsd * (days >= MAX_DAYS ? 1 - DISCOUNT_30DAY_PCT : 1);
}

function DaysPicker({ days, setDays, perDayUsd }: { days: number; setDays: (n: number) => void; perDayUsd: number }) {
  return (
    <div className="col" style={{ gap: 8 }}>
      <input
        type="range" min={MIN_DAYS} max={MAX_DAYS} step={1} value={days}
        onChange={(e) => setDays(Number(e.target.value))}
        style={{ width: '100%', accentColor: 'var(--burn)' }}
      />
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 13, color: 'var(--fg-2)' }}>
          <b style={{ color: 'var(--fg-1)' }}>{days}</b> days
          {days >= MAX_DAYS && <span style={{ color: 'var(--burn-ink)', fontWeight: 600 }}> · 10% off</span>}
        </span>
        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--burn-ink)' }}>
          {days >= MAX_DAYS && (
            <span style={{ fontSize: 12, color: 'var(--fg-3)', fontWeight: 400, textDecoration: 'line-through', marginRight: 6 }}>
              ${(days * perDayUsd).toFixed(2)}
            </span>
          )}
          ${lifespanUsd(days, perDayUsd).toFixed(2)}
        </span>
      </div>
      <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>
        ${perDayUsd.toFixed(2)}/day · {MIN_DAYS}–{MAX_DAYS} days · 10% off at {MAX_DAYS} days · charged in ICP at the live XRC rate.
      </span>
    </div>
  );
}

function selectCardStyle(active: boolean): React.CSSProperties {
  return {
    textAlign: 'left',
    background: active ? 'color-mix(in srgb, var(--burn) 12%, transparent)' : 'var(--surface-2)',
    border: `1px solid ${active ? 'var(--burn)' : 'var(--border)'}`,
    borderRadius: 10,
    padding: '10px 12px',
    cursor: 'pointer',
    transition: 'all var(--dur-fast) var(--ease-out)',
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    width: '100%',
  };
}

interface XFarmProps {
  actor: any;
  identity: any;
  principal: Principal | null;
  host: string;
  rootKey?: Uint8Array;
  isLocal: boolean;
  ledgerCanisterId: string;
  onSignIn: () => void;
}

type WizardStep = 'persona' | 'tier' | 'lifespan' | 'pay';

export default function XFarm({
  actor, identity, principal, host, rootKey, isLocal, ledgerCanisterId, onSignIn,
}: XFarmProps) {
  const signedIn = !!(principal && !principal.isAnonymous());

  const [info, setInfo] = useState<XFarmInfo | null>(null);
  const [tiers, setTiers] = useState<FarmerTier[]>([]);
  const [farmers, setFarmers] = useState<Farmer[]>([]);
  const [loading, setLoading] = useState(true);

  const [wizardOpen, setWizardOpen] = useState(false);
  const [step, setStep] = useState<WizardStep>('persona');
  const [personaPreset, setPersonaPreset] = useState<string>('ai');
  const [customPersona, setCustomPersona] = useState('');
  const [tierId, setTierId] = useState<number>(2);
  const [days, setDays] = useState<number>(MIN_DAYS);
  const [quote, setQuote] = useState<XFarmQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [payStep, setPayStep] = useState('');
  const [paySuccess, setPaySuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const personaText = personaPreset === 'custom' ? customPersona.trim()
    : (PERSONA_PRESETS.find(p => p.id === personaPreset)?.text ?? '');

  useErrorImpression(error, 'xfarm_create');

  const refresh = useCallback(async () => {
    if (!actor) return;
    try {
      const [inf, ts, frs] = await Promise.all([
        actor.get_xfarm_info(),
        actor.get_xfarm_tiers(),
        signedIn ? actor.list_my_farmers() : Promise.resolve([] as Farmer[]),
      ]);
      setInfo(inf);
      setTiers(ts);
      // Newest first.
      setFarmers([...(frs as Farmer[])].sort((a, b) => Number(b.created_at - a.created_at)));
    } catch (e) {
      // Feature disabled / network — leave empty.
    } finally {
      setLoading(false);
    }
  }, [actor, signedIn]);

  useEffect(() => { refresh(); }, [refresh]);

  // Quote the selected tier when the pay step opens.
  useEffect(() => {
    if (!wizardOpen || step !== 'pay' || !signedIn || !actor) { setQuote(null); return; }
    let cancelled = false;
    setQuoting(true); setQuote(null);
    const t = setTimeout(() => {
      actor.get_xfarm_quote(tierId, days)
        .then((res: any) => {
          if (cancelled) return;
          if (res.__kind__ === 'Ok') { setQuote(res.Ok); setError(null); }
          else setError(`Quote failed: ${res.Err}`);
        })
        .catch((err: any) => { if (!cancelled) setError(err.message || String(err)); })
        .finally(() => { if (!cancelled) setQuoting(false); });
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [wizardOpen, step, tierId, days, signedIn, actor]);

  // Wallet balance while the pay step is open.
  useEffect(() => {
    if (!wizardOpen || step !== 'pay' || !signedIn || !identity) { setBalance(null); return; }
    let cancelled = false;
    setBalance(null);
    const ledgerActor = createLedgerActor(ledgerCanisterId, { agentOptions: { host, identity, rootKey } });
    ledgerActor.icrc1_balance_of({ owner: principal! })
      .then((bal: bigint) => { if (!cancelled) setBalance(bal); })
      .catch(() => { if (!cancelled) setBalance(0n); });
    return () => { cancelled = true; };
  }, [wizardOpen, step, signedIn, identity, principal, host, rootKey, ledgerCanisterId]);

  const openWizard = () => {
    setError(null); setPaySuccess(false); setStep('persona'); setWizardOpen(true);
  };

  const executePay = async () => {
    if (!actor || !identity || busy) return;
    const persona = personaText;
    if (!persona || persona.length > MAX_PERSONA) { setError(`Persona must be 1..${MAX_PERSONA} chars.`); return; }
    if (!quote) { setError("Waiting for a price quote — try again in a second."); return; }
    const deposit = quote.price_e8s + quote.fee_e8s; // price + 2 fees (two outbound legs)
    if (balance !== null && deposit + quote.fee_e8s > balance) {
      setError(`Insufficient ICP balance — need ${fmtICP(deposit + quote.fee_e8s)} ICP (price + fees).`);
      return;
    }
    setBusy(true); setError(null); setPaySuccess(false);
    try {
      setPayStep("Step 1/2: Paying your tier price into escrow…");
      const acct = await actor.get_xfarm_deposit_address();
      const ledgerActor = createLedgerActor(ledgerCanisterId, { agentOptions: { host, identity, rootKey } });
      const transferResult = await ledgerActor.icrc1_transfer({
        to: { owner: acct.owner, subaccount: acct.subaccount ? acct.subaccount : undefined },
        amount: deposit,
      });
      if (transferResult.__kind__ === "Err") {
        const err = transferResult.Err as any;
        const detail = err.__kind__ === "InsufficientFunds"
          ? `balance is ${fmtICP(err.InsufficientFunds.balance)} ICP`
          : JSON.stringify(err, (_k, v) => typeof v === 'bigint' ? v.toString() : v);
        throw new Error(`Payment failed: ${detail}`);
      }
      setPayStep("Step 2/2: Deploying your Farmer canister…");
      const res = await actor.create_farmer(tierId, persona, days);
      // The backend auto-refunds the escrow deposit if create fails, so tell the user.
      if (res.__kind__ === "Err") throw new Error(`${res.Err} — your ICP deposit has been refunded.`);
      setPaySuccess(true);
      setPayStep("Your Farmer is running! Open it and tap “Generate today's drafts” when you want tweets.");
      await refresh();
    } catch (err: any) {
      console.error("create_farmer error:", err);
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  // ── Dev controls (local only) ──────────────────────────────────────────────
  usePageDevControls(isLocal && signedIn, () => (
    <div className="col" style={{ gap: 6 }}>
      <Eyebrow accent>X-Farm mock data</Eyebrow>
      {/* Post mock data: seed one Farmer per tier (+ 5 drafts each) so the multi-farm UI
          shows every tier, with a varied persona on each. */}
      <Btn variant="ghost" onClick={async () => {
        try {
          for (let i = 0; i < tiers.length; i++) {
            const t = tiers[i];
            const persona = PERSONA_PRESETS[i % PERSONA_PRESETS.length].text;
            const r = await actor.dev_seed_farmer(t.id, persona);
            if (r.__kind__ === 'Err') { alert(r.Err); break; }
            await actor.dev_seed_drafts(r.Ok.id, 5);
          }
          await refresh();
        } catch (e: any) { alert(e.message || String(e)); }
      }}>Post mock data (1 per tier)</Btn>
      <Btn variant="ghost" onClick={async () => {
        if (farmers.length === 0) { alert('No farm to seed drafts for — Post mock data first.'); return; }
        try {
          for (const f of farmers) {
            const r = await actor.dev_seed_drafts(f.id, 5);
            if (r.__kind__ === 'Err') { alert(r.Err); break; }
          }
          await refresh();
        } catch (e: any) { alert(e.message || String(e)); }
      }}>Seed drafts (5 · all farms)</Btn>
      <Btn variant="ghost" onClick={async () => {
        try { await actor.dev_clear_farmers(); await refresh(); } catch (e: any) { alert(e.message || String(e)); }
      }}>Clear mock data</Btn>
    </div>
  ), [isLocal, signedIn, actor, tierId, personaText, farmers, refresh]);

  const enabled = info?.enabled ?? false;
  const activeCount = farmers.filter(f => f.status === FarmerStatus.Active).length;

  if (loading) {
    return (
      <div className="dashboard-container" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Skeleton width={120} height={14} />
        <Skeleton width={'100%'} height={22} />
        <Skeleton width={'80%'} height={14} />
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className="dashboard-container">
        <Eyebrow accent>Coming soon</Eyebrow>
        <h4 style={{ margin: 0 }}>X-Farm</h4>
        <p style={{ fontSize: 13, color: 'var(--fg-2)', maxWidth: 600 }}>
          X-Farm isn't enabled on this canister yet. Each Farmer burns ICP into cycles to run an AI that
          drafts pro-ICP tweets you can post on X — your ICP fuels your own autonomous canister.
        </p>
      </div>
    );
  }

  return (
    <div className="dashboard-container" style={{ paddingBottom: 0 }}>
      {/* ── Header ── */}
      <div className="col" style={{ gap: 6 }}>
        <Eyebrow accent>Autonomous pro-ICP content</Eyebrow>
        <span className="row" style={{ gap: 10 }}>
          <Icon name="spark" size={22} stroke="var(--burn-ink)" />
          <h4 style={{ margin: 0 }}>X-Farm</h4>
          {activeCount > 0 && <Chip tone="ok"><LiveDot size={6} /> {activeCount} farm{activeCount === 1 ? '' : 's'} running</Chip>}
        </span>
        <p style={{ fontSize: 13, color: 'var(--fg-2)', maxWidth: 620 }}>
          Grow pro-ICP content on autopilot. Run as many farms as you like.
          {' '}<MoreInfo title="How X-Farm works">
            <div className="card col" style={{ gap: 8, borderColor: 'var(--burn)', background: 'color-mix(in srgb, var(--burn) 12%, var(--surface))' }}>
              <Eyebrow accent>The gist</Eyebrow>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
                You pay a tier price; a factory spins up a <b>per-user Farmer canister</b>, burns 90% of
                the ICP into cycles, and tops it up. When you open a farm it drafts fresh pro-ICP tweets
                via a Gemini proxy — grounded in today's ICP news, each ending with <b>$ICP</b> plus
                relevant hashtags — at most once a day, for you to review and post on X. The cycle budget
                is a deliberate burn over the lifespan you choose — honest proof-of-burn on a schedule.
                Create as many farms as you want; each is its own canister and its own burn.
              </p>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <Eyebrow accent>Tiers</Eyebrow>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                <li><b>Sprout</b> 5 drafts/day ($1/day) · <b>Grow</b> 10/day ($1.50/day) · <b>Bloom</b> 15/day ($2/day). Pick a 7–30 day lifespan; 10% off at 30 days.</li>
                <li>USD-priced via the XRC oracle, paid in ICP. 90% → your Farmer's cycles, 10% → treasury.</li>
                <li>Drafts auto-refresh once a day when you open the farm; each ends with $ICP and relevant hashtags, grounded in today's ICP news.</li>
              </ul>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <Eyebrow accent>You're the publisher</Eyebrow>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                <li>Drafts are AI-generated suggestions — you review and post; you're responsible for what you publish.</li>
                <li>We never post for you, and we never pay for reach. Admins may disable a Farmer.</li>
              </ul>
            </div>
          </MoreInfo>
        </p>
      </div>

      {/* ── CTA / dashboard ── */}
      <div className="col" style={{ marginTop: 16, gap: 14 }}>
        {!signedIn ? (
          <div className="card col" style={{ gap: 12 }}>
            <p style={{ margin: 0, fontSize: 13.5, color: 'var(--fg-2)' }}>
              Sign in to start a Farmer and grow pro-ICP content on autopilot.
            </p>
            <Btn variant="primary" onClick={onSignIn}>Sign in to start</Btn>
          </div>
        ) : (
          <>
            {/* Start-a-farm CTA — always available; a user may own unlimited farms.
                (On the LOCAL replica the final pay step is disabled instead, since
                local can't fund canister cycles — PB-148.) */}
            <div className="card row" style={{ gap: 12, justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
              <p style={{ margin: 0, fontSize: 13.5, color: 'var(--fg-2)' }}>
                {farmers.length === 0
                  ? "You don't have any farms yet — start one to grow pro-ICP content on autopilot."
                  : `You have ${farmers.length} farm${farmers.length === 1 ? '' : 's'}. Start another any time.`}
              </p>
              <Btn variant="primary" onClick={openWizard}>Start a farm</Btn>
            </div>

            {/* One card per farm. */}
            {farmers.map(f => (
              <FarmerCard key={Number(f.id)} farmer={f} tiers={tiers} actor={actor}
                identity={identity} host={host} rootKey={rootKey}
                ledgerCanisterId={ledgerCanisterId} onChanged={refresh} />
            ))}
          </>
        )}
      </div>

      {/* ── Wizard modal ── */}
      {wizardOpen && (
        <div style={MODAL_OVERLAY} onClick={() => !busy && setWizardOpen(false)}>
          <div className="card" style={MODAL_CARD} onClick={(e) => e.stopPropagation()}>
            {paySuccess ? (
              <div className="col" style={{ gap: 14 }}>
                <Eyebrow accent>All set</Eyebrow>
                <h4 style={{ margin: 0 }}>Your Farmer is running 🌱</h4>
                <p style={{ margin: 0, fontSize: 13.5, color: 'var(--fg-2)' }}>{payStep}</p>
                <Btn variant="primary" onClick={() => { setWizardOpen(false); refresh(); }}>View my farms</Btn>
              </div>
            ) : (
              <div className="col" style={{ gap: 14 }}>
                <Eyebrow accent>Start a Farmer · step {step === 'persona' ? 1 : step === 'tier' ? 2 : step === 'lifespan' ? 3 : 4} of 4</Eyebrow>

                {step === 'persona' && (
                  <div className="col" style={{ gap: 10 }}>
                    <span style={LABEL_STYLE}>Pick a voice</span>
                    <div className="col" style={{ gap: 8 }}>
                      {PERSONA_PRESETS.map(p => {
                        const active = personaPreset === p.id;
                        return (
                          <button key={p.id} style={selectCardStyle(active)} onClick={() => setPersonaPreset(p.id)}>
                            <span style={{ fontSize: 13.5, fontWeight: 600, color: active ? 'var(--burn-ink)' : 'var(--fg-1)' }}>{p.label}</span>
                            <span style={{ fontSize: 12, color: 'var(--fg-3)', lineHeight: 1.4 }}>{p.description}</span>
                          </button>
                        );
                      })}
                      <button style={selectCardStyle(personaPreset === 'custom')} onClick={() => setPersonaPreset('custom')}>
                        <span style={{ fontSize: 13.5, fontWeight: 600, color: personaPreset === 'custom' ? 'var(--burn-ink)' : 'var(--fg-1)' }}>Custom persona</span>
                        <span style={{ fontSize: 12, color: 'var(--fg-3)', lineHeight: 1.4 }}>Write your own voice in your own words.</span>
                      </button>
                    </div>
                    {personaPreset === 'custom' && (
                      <textarea
                        placeholder={`Describe the voice in ≤ ${MAX_PERSONA} chars…`}
                        maxLength={MAX_PERSONA}
                        value={customPersona}
                        onChange={(e) => setCustomPersona(e.target.value)}
                        style={{ width: '100%', minHeight: 70, resize: 'vertical', padding: 10, fontSize: 13 }}
                      />
                    )}
                    <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
                      <Btn variant="ghost" onClick={() => setWizardOpen(false)}>Cancel</Btn>
                      <Btn variant="primary" onClick={() => { if (personaText) { setError(null); setStep('tier'); } else setError('Pick or write a persona.'); }}>Next</Btn>
                    </div>
                  </div>
                )}

                {step === 'tier' && (
                  <div className="col" style={{ gap: 10 }}>
                    <span style={LABEL_STYLE}>Choose a tier</span>
                    <div className="col" style={{ gap: 8 }}>
                      {tiers.map(t => {
                        const active = tierId === t.id;
                        return (
                          <button key={t.id} style={selectCardStyle(active)} onClick={() => setTierId(t.id)}>
                            <span style={{ fontSize: 13.5, fontWeight: 600, color: active ? 'var(--burn-ink)' : 'var(--fg-1)' }}>{t.name}</span>
                            <span style={{ fontSize: 12, color: 'var(--fg-3)', lineHeight: 1.4 }}>
                              {t.drafts_per_day} draft{t.drafts_per_day === 1 ? '' : 's'}/day · ${tierPerDayUsd(t).toFixed(2)}/day{t.includes_image ? ' + 1 image/day' : ''}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    <p style={{ fontSize: 11.5, color: 'var(--fg-3)', margin: 0 }}>
                      The tier sets how many drafts you get per day. You'll pick the lifespan next.
                    </p>
                    <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
                      <Btn variant="ghost" onClick={() => setStep('persona')}>Back</Btn>
                      <Btn variant="primary" onClick={() => { setError(null); setStep('lifespan'); }}>Next</Btn>
                    </div>
                  </div>
                )}

                {step === 'lifespan' && (
                  <div className="col" style={{ gap: 10 }}>
                    <span style={LABEL_STYLE}>Choose a lifespan</span>
                    <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: 0 }}>
                      How long should this farm run? Its ICP is burned into a cycle budget that depletes
                      over the lifespan you choose.
                    </p>
                    <div className="card col" style={{ gap: 8, padding: 12, background: 'var(--surface-2)' }}>
                      <DaysPicker days={days} setDays={setDays} perDayUsd={tierPerDayUsd(tiers.find(t => t.id === tierId))} />
                    </div>
                    <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
                      <Btn variant="ghost" onClick={() => setStep('tier')}>Back</Btn>
                      <Btn variant="primary" onClick={() => { setError(null); setStep('pay'); }}>Next</Btn>
                    </div>
                  </div>
                )}

                {step === 'pay' && (
                  <div className="col" style={{ gap: 10 }}>
                    <span style={LABEL_STYLE}>Review &amp; pay</span>
                    <div className="card col" style={{ gap: 6, padding: 12, background: 'var(--surface-2)' }}>
                      <div className="row" style={{ justifyContent: 'space-between' }}>
                        <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>Persona</span>
                        <span style={{ fontSize: 12.5, maxWidth: 320, textAlign: 'right' }}>{PERSONA_PRESETS.find(p => p.id === personaPreset)?.label ?? 'Custom persona'}</span>
                      </div>
                      <div className="row" style={{ justifyContent: 'space-between' }}>
                        <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>Tier</span>
                        <span style={{ fontSize: 12.5 }}>{tiers.find(t => t.id === tierId)?.name} — {tiers.find(t => t.id === tierId)?.drafts_per_day} drafts/day</span>
                      </div>
                      <div className="row" style={{ justifyContent: 'space-between' }}>
                        <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>Lifespan</span>
                        <span style={{ fontSize: 12.5 }}>{days} days · ${lifespanUsd(days, tierPerDayUsd(tiers.find(t => t.id === tierId))).toFixed(2)}{days >= MAX_DAYS ? ' (10% off)' : ''}</span>
                      </div>
                      {quote ? (
                        <>
                          <div className="row" style={{ justifyContent: 'space-between' }}>
                            <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>Price (≈ ${(Number(quote.usd_e8s) / 100_000_000).toFixed(2)} via XRC)</span>
                            <span style={{ fontSize: 13, fontWeight: 600 }}>{fmtICP(quote.price_e8s)} ICP</span>
                          </div>
                          <div className="row" style={{ justifyContent: 'space-between' }}>
                            <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>Network fees (2 outbound legs)</span>
                            <span style={{ fontSize: 12 }}>{fmtICP(quote.fee_e8s)} ICP</span>
                          </div>
                        </>
                      ) : quoting ? (
                        <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>Quoting live ICP price…</span>
                      ) : (
                        <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>No quote yet.</span>
                      )}
                      {balance !== null && (
                        <div className="row" style={{ justifyContent: 'space-between' }}>
                          <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>Your balance</span>
                          <span style={{ fontSize: 12.5 }}>{fmtICP(balance)} ICP</span>
                        </div>
                      )}
                    </div>
                    <p style={{ fontSize: 11.5, color: 'var(--fg-3)', margin: 0 }}>
                      ICP is burned to fund your Farmer's {days}-day cycle budget. Drafts are generated on demand,
                      at most once per day. The ICP is non-refundable.
                    </p>
                    {isLocal && (
                      <div className="card" style={{ padding: 10, borderColor: 'var(--burn)', color: 'var(--fg-2)', fontSize: 12.5 }}>
                        Local replica can't fund canister cycles (CMC mint fails — PB-148), so paying is disabled here. Use <b>Post mock data</b> in the dev panel to preview farms. Real creation works on mainnet.
                      </div>
                    )}
                    {error && <div className="card" style={{ padding: 10, borderColor: 'var(--bad)', color: 'var(--bad)', fontSize: 12.5 }}>{error}</div>}
                    {payStep && !error && <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>{payStep}</span>}
                    <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
                      <Btn variant="ghost" onClick={() => setStep('lifespan')} disabled={busy}>Back</Btn>
                      <Btn variant="primary" onClick={executePay} disabled={busy || !quote || isLocal}>
                        {busy ? 'Working…' : isLocal ? 'Disabled on local' : `Pay & deploy Farmer`}
                      </Btn>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function statusLabel(s: FarmerStatus): string {
  switch (s) {
    case FarmerStatus.Active: return 'active';
    case FarmerStatus.Depleted: return 'depleted';
    case FarmerStatus.Disabled: return 'disabled';
    case FarmerStatus.Failed: return 'failed';
    default: return 'unknown';
  }
}

function statusTone(s: FarmerStatus): 'ok' | 'pending' | 'danger' {
  switch (s) {
    case FarmerStatus.Active: return 'ok';
    case FarmerStatus.Failed: return 'danger';
    case FarmerStatus.Disabled: return 'danger';
    default: return 'pending';
  }
}

// ── One Farmer card: live status + on-demand draft generation ────────────────
function FarmerCard({ farmer, tiers, actor, identity, host, rootKey, ledgerCanisterId, onChanged }: {
  farmer: Farmer;
  tiers: FarmerTier[];
  actor: any;
  identity: any;
  host: string;
  rootKey?: Uint8Array;
  ledgerCanisterId: string;
  onChanged: () => void;
}) {
  const tier = tiers.find(t => t.id === farmer.tier_id);
  const [statusTuple, setStatusTuple] = useState<[Farmer, bigint, bigint] | null>(null);
  const [drafts, setDrafts] = useState<XFarmDraft[]>([]);
  const [loadingDrafts, setLoadingDrafts] = useState(false);
  const [generatedToday, setGeneratedToday] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState<number>(Date.now()); // drives the next-round countdown

  // Renew (pay again to extend lifespan).
  const [renewOpen, setRenewOpen] = useState(false);
  const [renewQuote, setRenewQuote] = useState<XFarmQuote | null>(null);
  const [renewBusy, setRenewBusy] = useState(false);
  const [renewErr, setRenewErr] = useState<string | null>(null);
  const [renewStep, setRenewStep] = useState('');
  const [renewDays, setRenewDays] = useState<number>(MIN_DAYS);

  useErrorImpression(err, 'xfarm_generate');
  useErrorImpression(renewErr, 'xfarm_renew');

  // 30-day lookback in NANOSECONDS (Farmer.created_at / draft.created_at are ns).
  const since = useMemo(() => (BigInt(Date.now()) - BigInt(30 * 86_400_000)) * 1_000_000n, []);

  // Live status (cycles remaining + next-generation) — cheap, load on mount + after renew.
  const loadStatus = useCallback(() => {
    let cancelled = false;
    actor.get_farmer_status(farmer.id)
      .then((st: any) => { if (!cancelled && st.__kind__ === 'Ok') setStatusTuple(st.Ok); })
      .catch(() => { /* status is best-effort */ });
    return () => { cancelled = true; };
  }, [actor, farmer.id]);
  useEffect(() => loadStatus(), [loadStatus]);
  // Tick every second to drive the live "next round" countdown.
  useEffect(() => { const t = setInterval(() => setNowTick(Date.now()), 1000); return () => clearInterval(t); }, []);

  // ON-DEMAND generation: asks the Farmer to draft tweets. The backend throttles to at
  // most once per day per Farmer, so a same-day call just returns the already-generated
  // drafts (they persist); a new day auto-refreshes them.
  const generate = useCallback(async () => {
    setLoadingDrafts(true); setErr(null);
    try {
      const dr = await actor.get_farmer_drafts(farmer.id, since);
      if (dr.__kind__ === 'Ok') { setDrafts(dr.Ok); setGeneratedToday(true); }
      else setErr(dr.Err);
    } catch (e: any) {
      setErr(e.message || String(e));
    } finally {
      setLoadingDrafts(false);
    }
  }, [actor, farmer.id, since]);

  // Persist + auto-refresh: load drafts on mount (and once per day the throttle lets it
  // regenerate), so they stay visible across page loads until the next round.
  useEffect(() => { if (farmer.status === FarmerStatus.Active) generate(); }, [generate, farmer.status]);

  // RENEW: pay again to extend this farm. Quote the farm's existing tier, deposit
  // price+fees into escrow, then call renew_farmer (10% treasury, 90% → more cycles,
  // backend re-arms the burn timer).
  const openRenew = useCallback(() => {
    setRenewErr(null); setRenewStep(''); setRenewDays(MIN_DAYS); setRenewOpen(true);
  }, []);

  // Re-quote whenever the renew panel is open or the chosen lifespan changes.
  useEffect(() => {
    if (!renewOpen) { setRenewQuote(null); return; }
    let cancelled = false;
    setRenewQuote(null);
    const t = setTimeout(() => {
      actor.get_xfarm_quote(farmer.tier_id, renewDays)
        .then((res: any) => {
          if (cancelled) return;
          if (res.__kind__ === 'Ok') { setRenewQuote(res.Ok); setRenewErr(null); }
          else setRenewErr(`Quote failed: ${res.Err}`);
        })
        .catch((e: any) => { if (!cancelled) setRenewErr(e.message || String(e)); });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [renewOpen, renewDays, actor, farmer.tier_id]);

  const confirmRenew = useCallback(async () => {
    if (!renewQuote || renewBusy || !identity) return;
    const deposit = renewQuote.price_e8s + renewQuote.fee_e8s; // price + 2 fees (two outbound legs)
    setRenewBusy(true); setRenewErr(null);
    try {
      setRenewStep('Step 1/2: Paying into escrow…');
      const acct = await actor.get_xfarm_deposit_address();
      const ledgerActor = createLedgerActor(ledgerCanisterId, { agentOptions: { host, identity, rootKey } });
      const tr = await ledgerActor.icrc1_transfer({
        to: { owner: acct.owner, subaccount: acct.subaccount ? acct.subaccount : undefined },
        amount: deposit,
      });
      if (tr.__kind__ === 'Err') {
        const e2 = tr.Err as any;
        const detail = e2.__kind__ === 'InsufficientFunds'
          ? `balance is ${fmtICP(e2.InsufficientFunds.balance)} ICP`
          : JSON.stringify(e2, (_k, v) => typeof v === 'bigint' ? v.toString() : v);
        throw new Error(`Payment failed: ${detail}`);
      }
      setRenewStep('Step 2/2: Extending your Farmer…');
      const res = await actor.renew_farmer(farmer.id, renewDays);
      if (res.__kind__ === 'Err') throw new Error(res.Err);
      setRenewOpen(false);
      onChanged();
      loadStatus();
    } catch (e: any) {
      setRenewErr(e.message || String(e));
    } finally {
      setRenewBusy(false);
    }
  }, [actor, farmer.id, renewDays, renewQuote, renewBusy, identity, host, rootKey, ledgerCanisterId, onChanged, loadStatus]);

  const shareDraftOnX = (d: XFarmDraft) => {
    const url = d.cited_url || '';
    const q = url
      ? `?text=${encodeURIComponent(d.text)}&url=${encodeURIComponent(url)}`
      : `?text=${encodeURIComponent(d.text)}`;
    window.open(`https://twitter.com/intent/tweet${q}`, '_blank', 'noopener,noreferrer');
  };

  const daysLeft = statusTuple ? Number(statusTuple[1]) / 1_000_000_000_000 / 86_400 : null;
  const nextGen = statusTuple ? Number(statusTuple[2]) : null;
  const nextGenPassed = nextGen !== null && nextGen <= Date.now() * 1_000_000;
  const nextGenMs = nextGen !== null ? nextGen / 1_000_000 : null;
  const countdownMs = nextGenMs !== null ? nextGenMs - nowTick : null;

  const nowMs = Date.now();
  const today = drafts.filter(d => Number(d.created_at) / 1_000_000 >= nowMs - 24 * 3_600_000);
  const archive = drafts.filter(d => Number(d.created_at) / 1_000_000 < nowMs - 24 * 3_600_000);
  const active = farmer.status === FarmerStatus.Active;
  // Scheduled expiry (when the cycle budget should run out) so the owner knows when to renew.
  const expiresAtMs = Number(farmer.expected_depleted_at) / 1_000_000;
  const expired = expiresAtMs <= nowMs;

  return (
    <div className="card col" style={{ gap: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <span className="row" style={{ gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 18 }}>🌱</span>
          <b>{tier ? tier.name : `Farm #${Number(farmer.id)}`}</b>
          <Chip tone={statusTone(farmer.status)}>{statusLabel(farmer.status)}</Chip>
        </span>
        {active && (
          <span className="row" style={{ gap: 8 }}>
            <Btn variant="secondary" onClick={openRenew} disabled={renewBusy || renewOpen}>Renew</Btn>
            {today.length === 0 && (
              <Btn variant="primary" onClick={generate} disabled={loadingDrafts}>
                {loadingDrafts ? 'Generating…' : "Generate today's drafts"}
              </Btn>
            )}
          </span>
        )}
      </div>

      {/* Renew (pay again to extend lifespan) */}
      {renewOpen && (
        <div className="card col" style={{ gap: 8, padding: 12, background: 'var(--surface-2)', borderColor: 'var(--burn)' }}>
          <span style={LABEL_STYLE}>Renew this farm</span>
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--fg-2)' }}>
            Pay again to extend <b>{tier ? tier.name : 'this farm'}</b> by another {renewDays} days.
          </p>
          <DaysPicker days={renewDays} setDays={setRenewDays} perDayUsd={tierPerDayUsd(tier)} />
          {renewQuote ? (
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>Price (≈ ${(Number(renewQuote.usd_e8s) / 100_000_000).toFixed(2)} via XRC)</span>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{fmtICP(renewQuote.price_e8s)} ICP + {fmtICP(renewQuote.fee_e8s)} fees</span>
            </div>
          ) : !renewErr ? (
            <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>Quoting live ICP price…</span>
          ) : null}
          {renewErr && <div className="card" style={{ padding: 10, borderColor: 'var(--bad)', color: 'var(--bad)', fontSize: 12.5 }}>{renewErr}</div>}
          {renewStep && !renewErr && <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>{renewStep}</span>}
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <Btn variant="ghost" onClick={() => setRenewOpen(false)} disabled={renewBusy}>Cancel</Btn>
            <Btn variant="primary" onClick={confirmRenew} disabled={renewBusy || !renewQuote}>{renewBusy ? 'Working…' : 'Confirm renew'}</Btn>
          </div>
        </div>
      )}

      {/* Status row */}
      <div className="col" style={{ gap: 8, fontSize: 12.5, color: 'var(--fg-2)' }}>
        <span>persona: <span style={{ color: 'var(--fg-1)' }}>{farmer.persona}</span></span>
        <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
          {daysLeft !== null && <span>budget left: <b>~{Math.max(0, daysLeft).toFixed(1)} days</b></span>}
          <span>burned: <b>{(Number(farmer.burned_cycles) / 1_000_000_000_000).toFixed(2)}T cycles</b></span>
        </div>
        <span>
          {expired ? 'expired: ' : 'expires: '}
          <b style={expired ? { color: 'var(--bad)' } : undefined}>
            {expired ? `${new Date(expiresAtMs).toLocaleString()} — renew to keep it running` : new Date(expiresAtMs).toLocaleString()}
          </b>
        </span>
      </div>

      {/* Today's drafts + next-round countdown */}
      <div className="col" style={{ gap: 8 }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 6 }}>
          <span style={LABEL_STYLE}>Today's drafts ({today.length})</span>
          {active && countdownMs !== null && (
            <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
              {countdownMs > 0
                ? <>next round in <b style={{ color: 'var(--fg-1)', fontFamily: 'var(--font-mono)' }}>{fmtCountdown(countdownMs)}</b></>
                : <b style={{ color: 'var(--burn-ink)' }}>next round ready</b>}
            </span>
          )}
        </div>
        {err && <div className="card" style={{ padding: 10, borderColor: 'var(--bad)', color: 'var(--bad)', fontSize: 12.5 }}>{err}</div>}
        {!generatedToday && drafts.length === 0 && !loadingDrafts && !err && (
          <p style={{ fontSize: 12.5, color: 'var(--fg-3)', margin: 0 }}>
            {active
              ? <>Tap <b>Generate today's drafts</b> to have your Farmer draft fresh pro-ICP tweets. It runs at most once per day{nextGen !== null && !nextGenPassed ? ' — today\'s batch may already be ready' : ''}.</>
              : <>This farm is {statusLabel(farmer.status)}; no new drafts.</>}
          </p>
        )}
        {loadingDrafts && <Skeleton width={'100%'} height={48} />}
        {today.map(d => (
          <DraftRow key={Number(d.id)} d={d} onShare={shareDraftOnX} />
        ))}
      </div>

      {/* Archive */}
      {archive.length > 0 && (
        <details style={{ marginTop: 4 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--fg-3)' }}>Archive (last 30 days, {archive.length})</summary>
          <div className="col" style={{ gap: 8, marginTop: 8 }}>
            {archive.slice(0, 30).map(d => (
              <DraftRow key={Number(d.id)} d={d} onShare={shareDraftOnX} />
            ))}
          </div>
        </details>
      )}

      <div className="row" style={{ gap: 8, alignItems: 'center', fontSize: 11.5, color: 'var(--fg-3)' }}>
        <span>Drafts are AI-generated suggestions. You're responsible for what you post. Admins may disable Farmers.</span>
      </div>
    </div>
  );
}

// HH:MM:SS-style countdown to the next drafting round.
function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`;
}

const TWITTER_BLUE = '#1DA1F2';

function DraftRow({ d, onShare }: {
  d: XFarmDraft; onShare: (d: XFarmDraft) => void;
}) {
  return (
    <div className="col" style={{
      gap: 10, padding: '13px 15px', background: 'var(--surface)',
      border: '1px solid var(--border)', borderLeft: `3px solid ${TWITTER_BLUE}`, borderRadius: 10,
    }}>
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: 'var(--fg-1)', whiteSpace: 'pre-wrap' }}>
        {d.text}
      </p>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        {d.cited_url ? (
          <a href={d.cited_url} target="_blank" rel="noopener noreferrer"
             style={{ fontSize: 11, color: 'var(--fg-3)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Icon name="external" size={11} /> source
          </a>
        ) : <span />}
        <button onClick={() => onShare(d)} title="Share on X" style={{
          background: TWITTER_BLUE, color: '#fff', border: 'none', borderRadius: 8,
          padding: '7px 14px', display: 'inline-flex', alignItems: 'center', gap: 6,
          cursor: 'pointer', fontSize: 12.5, fontWeight: 600,
        }}>
          <Icon name="share" size={13} stroke="#fff" /> Share on X
        </button>
      </div>
    </div>
  );
}
