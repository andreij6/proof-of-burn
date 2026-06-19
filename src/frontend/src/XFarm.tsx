import { useEffect, useState, useCallback, useMemo } from 'react';
import { Principal } from "@icp-sdk/core/principal";
import { FarmerStatus } from "./bindings/backend";
import type { Farmer, FarmerTier, XFarmQuote, XFarmDraft, XFarmInfo } from "./bindings/backend";
import { createActor as createLedgerActor } from "./bindings/ledger";
import { Icon, Eyebrow, Chip, Btn, LiveDot, MoreInfo, Skeleton, fmtICP, formatPrincipal, usePageDevControls } from "./ui";

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
function pillStyle(active: boolean): React.CSSProperties {
  return {
    background: active ? 'color-mix(in srgb, var(--burn) 14%, transparent)' : 'transparent',
    border: `1px solid ${active ? 'var(--burn)' : 'var(--border)'}`,
    color: active ? 'var(--burn-ink)' : 'var(--fg-3)',
    borderRadius: 999, padding: '5px 10px', fontSize: 11.5, fontWeight: 500,
    cursor: 'pointer', transition: 'all var(--dur-fast) var(--ease-out)',
  };
}

const PERSONA_PRESETS: { id: string; label: string; description: string; text: string }[] = [
  {
    id: 'ai',
    label: 'AI Visionary',
    description: 'Latest AI trends through an ICP lens — dreams up on-chain AI use cases.',
    text: 'An AI-focused Internet Computer enthusiast, fluent in the latest AI trends and how they intersect with ICP. Loves imagining on-chain AI use cases — autonomous agents, on-chain inference, verifiable models, data sovereignty — that only the Internet Computer can enable. Forward-looking, technical, and imaginative.',
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

type WizardStep = 'persona' | 'tier' | 'pay';

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
  const [quote, setQuote] = useState<XFarmQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [payStep, setPayStep] = useState('');
  const [paySuccess, setPaySuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const personaText = personaPreset === 'custom' ? customPersona.trim()
    : (PERSONA_PRESETS.find(p => p.id === personaPreset)?.text ?? '');

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
      actor.get_xfarm_quote(tierId)
        .then((res: any) => {
          if (cancelled) return;
          if (res.__kind__ === 'Ok') { setQuote(res.Ok); setError(null); }
          else setError(`Quote failed: ${res.Err}`);
        })
        .catch((err: any) => { if (!cancelled) setError(err.message || String(err)); })
        .finally(() => { if (!cancelled) setQuoting(false); });
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [wizardOpen, step, tierId, signedIn, actor]);

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
      const res = await actor.create_farmer(tierId, persona);
      if (res.__kind__ === "Err") throw new Error(res.Err);
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
      {/* Post mock data: seed a Farmer + 5 drafts in one click so the multi-farm UI has content. */}
      <Btn variant="ghost" onClick={async () => {
        try {
          const r = await actor.dev_seed_farmer(tierId, personaText || PERSONA_PRESETS[0].text);
          if (r.__kind__ === 'Ok') {
            await actor.dev_seed_drafts(r.Ok.id, 5);
            await refresh();
          } else alert(r.Err);
        } catch (e: any) { alert(e.message || String(e)); }
      }}>Post mock data</Btn>
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
                the ICP into cycles, and tops it up. When you open a farm and tap <b>Generate today's
                drafts</b>, it calls a Gemini proxy to draft pro-ICP tweets (at most once a day); you review
                and post them on X. The cycle budget is a deliberate 7-day burn — honest proof-of-burn on a
                schedule. Create as many farms as you want; each is its own canister and its own burn.
              </p>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <Eyebrow accent>Tiers</Eyebrow>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                <li><b>Sprout</b> 1 draft/day · <b>Grow</b> 5/day · <b>Bloom</b> 10/day (7 days each).</li>
                <li>USD-priced via the XRC oracle, paid in ICP. 90% → your Farmer's cycles, 10% → treasury.</li>
                <li>Drafts are generated on demand — only when you ask, at most once per day per farm.</li>
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
                <Eyebrow accent>Start a Farmer · step {step === 'persona' ? 1 : step === 'tier' ? 2 : 3} of 3</Eyebrow>

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
                              {t.drafts_per_day} draft{t.drafts_per_day === 1 ? '' : 's'}/day{t.includes_image ? ' + 1 image/day' : ''} · {t.duration_days} days
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    <p style={{ fontSize: 11.5, color: 'var(--fg-3)', margin: 0 }}>
                      USD-priced via the XRC oracle, paid in ICP. Admin can edit tiers.
                    </p>
                    <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
                      <Btn variant="ghost" onClick={() => setStep('persona')}>Back</Btn>
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
                        <span style={{ fontSize: 12.5, maxWidth: 320, textAlign: 'right' }}>{personaText}</span>
                      </div>
                      <div className="row" style={{ justifyContent: 'space-between' }}>
                        <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>Tier</span>
                        <span style={{ fontSize: 12.5 }}>{tiers.find(t => t.id === tierId)?.name} — {tiers.find(t => t.id === tierId)?.drafts_per_day} drafts/day · {tiers.find(t => t.id === tierId)?.duration_days}d</span>
                      </div>
                      {quote ? (
                        <>
                          <div className="row" style={{ justifyContent: 'space-between' }}>
                            <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>Price (≈ ${(Number(quote.usd_e8s) / 100_000_000).toFixed(2)} via XRC)</span>
                            <span style={{ fontSize: 13, fontWeight: 600 }}>{fmtICP(quote.price_e8s)} ICP</span>
                          </div>
                          <div className="row" style={{ justifyContent: 'space-between' }}>
                            <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>└ 90% burned to your Farmer's cycles</span>
                            <span style={{ fontSize: 12 }}>{fmtICP(quote.price_e8s * 9n / 10n)} ICP</span>
                          </div>
                          <div className="row" style={{ justifyContent: 'space-between' }}>
                            <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>└ 10% to the treasury</span>
                            <span style={{ fontSize: 12 }}>{fmtICP(quote.price_e8s / 10n)} ICP</span>
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
                      ICP is burned to fund your Farmer's 7-day cycle budget. Drafts are generated on demand,
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
                      <Btn variant="ghost" onClick={() => setStep('tier')} disabled={busy}>Back</Btn>
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

  // Renew (pay again to extend lifespan).
  const [renewOpen, setRenewOpen] = useState(false);
  const [renewQuote, setRenewQuote] = useState<XFarmQuote | null>(null);
  const [renewBusy, setRenewBusy] = useState(false);
  const [renewErr, setRenewErr] = useState<string | null>(null);
  const [renewStep, setRenewStep] = useState('');

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

  // ON-DEMAND generation: this is the only thing that asks the Farmer to draft
  // tweets. The backend throttles to at most once per day per Farmer, so tapping
  // again the same day just returns the already-generated drafts.
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

  // RENEW: pay again to extend this farm. Quote the farm's existing tier, deposit
  // price+fees into escrow, then call renew_farmer (10% treasury, 90% → more cycles,
  // backend re-arms the burn timer).
  const openRenew = useCallback(async () => {
    setRenewOpen(true); setRenewErr(null); setRenewQuote(null); setRenewStep('');
    try {
      const res = await actor.get_xfarm_quote(farmer.tier_id);
      if (res.__kind__ === 'Ok') setRenewQuote(res.Ok);
      else setRenewErr(`Quote failed: ${res.Err}`);
    } catch (e: any) { setRenewErr(e.message || String(e)); }
  }, [actor, farmer.tier_id]);

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
      const res = await actor.renew_farmer(farmer.id);
      if (res.__kind__ === 'Err') throw new Error(res.Err);
      setRenewOpen(false);
      onChanged();
      loadStatus();
    } catch (e: any) {
      setRenewErr(e.message || String(e));
    } finally {
      setRenewBusy(false);
    }
  }, [actor, farmer.id, renewQuote, renewBusy, identity, host, rootKey, ledgerCanisterId, onChanged, loadStatus]);

  const shareDraftOnX = (d: XFarmDraft) => {
    const url = d.cited_url || '';
    const q = url
      ? `?text=${encodeURIComponent(d.text)}&url=${encodeURIComponent(url)}`
      : `?text=${encodeURIComponent(d.text)}`;
    window.open(`https://twitter.com/intent/tweet${q}`, '_blank', 'noopener,noreferrer');
  };

  const cyclesRemaining = statusTuple ? Number(statusTuple[1]) : null;
  const daysLeft = statusTuple ? Number(statusTuple[1]) / 1_000_000_000_000 / 86_400 : null;
  const nextGen = statusTuple ? Number(statusTuple[2]) : null;
  const nextGenPassed = nextGen !== null && nextGen <= Date.now() * 1_000_000;

  const nowMs = Date.now();
  const today = drafts.filter(d => Number(d.created_at) / 1_000_000 >= nowMs - 24 * 3_600_000);
  const archive = drafts.filter(d => Number(d.created_at) / 1_000_000 < nowMs - 24 * 3_600_000);
  const active = farmer.status === FarmerStatus.Active;

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
            <Btn variant="ghost" onClick={openRenew} disabled={renewBusy || renewOpen}>Renew</Btn>
            <Btn variant="primary" onClick={generate} disabled={loadingDrafts}>
              {loadingDrafts ? 'Generating…' : generatedToday ? "Refresh today's drafts" : "Generate today's drafts"}
            </Btn>
          </span>
        )}
      </div>

      {/* Renew (pay again to extend lifespan) */}
      {renewOpen && (
        <div className="card col" style={{ gap: 8, padding: 12, background: 'var(--surface-2)', borderColor: 'var(--burn)' }}>
          <span style={LABEL_STYLE}>Renew this farm</span>
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--fg-2)' }}>
            Pay again to extend <b>{tier ? tier.name : 'this farm'}</b> by another {tier?.duration_days ?? 7} days.
          </p>
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
      <div className="row" style={{ gap: 16, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--fg-2)' }}>
        <span>persona: <span style={{ color: 'var(--fg-1)' }}>{farmer.persona.length > 60 ? farmer.persona.slice(0, 60) + '…' : farmer.persona}</span></span>
        <span>canister: <code style={{ fontSize: 11.5 }}>{farmer.canister_id ? formatPrincipal(farmer.canister_id) : 'local mock'}</code></span>
        {cyclesRemaining !== null && <span>cycles: <b>{(cyclesRemaining / 1_000_000_000_000).toFixed(2)}T</b></span>}
        {daysLeft !== null && <span>budget left: <b>~{Math.max(0, daysLeft).toFixed(1)}d of {tier?.duration_days ?? 7}d</b></span>}
        <span>burned: <b>{(Number(farmer.burned_cycles) / 1_000_000_000_000).toFixed(2)}T cycles</b></span>
      </div>

      {/* On-demand generation hint + today's drafts */}
      <div className="col" style={{ gap: 8 }}>
        <span style={LABEL_STYLE}>Today's drafts ({today.length})</span>
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

function DraftRow({ d, onShare }: {
  d: XFarmDraft; onShare: (d: XFarmDraft) => void;
}) {
  return (
    <div className="card col" style={{ gap: 8, padding: 10, background: 'var(--surface-2)' }}>
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--fg-1)', whiteSpace: 'pre-wrap' }}>
        {d.text}
      </p>
      {d.cited_url && (
        <a href={d.cited_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11.5, color: 'var(--burn)' }}>
          {d.cited_url}
        </a>
      )}
      <div className="row" style={{ gap: 8 }}>
        <button onClick={() => onShare(d)} style={pillStyle(true)}>✕ Share on X</button>
      </div>
    </div>
  );
}
