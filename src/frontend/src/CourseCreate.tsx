import { useEffect, useMemo, useRef, useState } from 'react';
import type { CourseUniquenessReport, MintError } from './bindings/backend';
import { createActor as createLedgerActor } from './bindings/ledger';
import { Icon, Eyebrow, Chip, Btn, LiveDot, MoreInfo, fmtICP } from './ui';
import MiniGolf from './arcade/MiniGolf';
import CourseOverview from './arcade/CourseOverview';
import type { CharacterLook } from './arcade/engine';
import {
  parseCourseInstructions, courseFromInstructions, holeFromInstructions, type CourseInstructions,
} from './arcade/courseInstructions';
import { SHOWCASE_HOLE } from './arcade/showcaseHole';
import { difficultyBucket, courseShareUrl, courseShareIntent, type Difficulty } from './arcade/courseMarket';
import { buildCoursePrompt, friendlyCourseError } from './arcade/coursePrompt';

// ==========================================
// Create a course (AI-built course NFTs) — the wizard behind the marketplace's
// "Create a course" button. There is no in-app editor: the user copies the AI
// course-designer instructions, designs the course with their own AI agent
// (ChatGPT, Claude, …), pastes the JSON it outputs back here, test-plays it in
// the real engine, and mints it as a course NFT (PB-304 mint saga: deposit
// 0.5 ICP into the mint escrow subaccount, then mint_course_nft).
// ==========================================

export const MINT_FEE_E8S = 50_000_000n; // 0.5 ICP — backend MINT_FEE_E8S
const ICP_LEDGER_FEE_E8S = 10_000n;
const MAX_NAME_CHARS = 60; // backend MAX_COURSE_NAME_CHARS

// ── Pure helpers (unit-testable) ──

export interface HoleSummary {
  name: string;
  par: number;
  grid: string; // "20×12"
  windmills: number;
}

export interface CourseSummary {
  name: string;
  parTotal: number;
  difficulty: Difficulty;
  holes: HoleSummary[];
}

/** Derive the step-2 summary card data from a validated instructions doc. */
export function summarizeCourse(doc: CourseInstructions): CourseSummary {
  const parTotal = doc.holes.reduce((s, h) => s + h.par, 0);
  return {
    name: doc.name,
    parTotal,
    difficulty: difficultyBucket(parTotal),
    holes: doc.holes.map((h, i) => ({
      name: h.name || `Hole ${i + 1}`,
      par: h.par,
      grid: `${h.layout[0].length}×${h.layout.length}`,
      windmills: h.windmills?.length ?? 0,
    })),
  };
}

/** Friendly text for a mint_course_nft error (PB-304 MintError). */
export function mintErrMessage(err: MintError): string {
  switch (err.__kind__) {
    case 'NotAuthenticated':
      return 'Sign in to mint courses.';
    case 'InsufficientDeposit':
      return `The mint escrow needs ${fmtICP(err.InsufficientDeposit.needed)} ICP but only has ${fmtICP(err.InsufficientDeposit.found)} ICP — the deposit may still be settling, try again in a moment.`;
    case 'AlreadyMinting':
      return 'A mint is already in progress — try again in a moment.';
    case 'InvalidCourse':
      if (err.InvalidCourse.startsWith('DUPLICATE_HOLES:')) {
        const n = err.InvalidCourse.slice('DUPLICATE_HOLES:'.length);
        return `This course is too close to an existing course NFT — ${n} of its holes already exist on the marketplace. Redesign those holes with your AI and try again.`;
      }
      return `The course was rejected: ${err.InvalidCourse}`;
    case 'FeeSettlementFailed':
      return `Fee settlement failed: ${err.FeeSettlementFailed}`;
    case 'MintCallFailed':
      return `Minting failed: ${err.MintCallFailed}`;
  }
}

/** Friendly text for an ICP ledger icrc1_transfer Err (mirrors App.tsx). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function transferErrMessage(err: any): string {
  const kind = err.__kind__;
  const detail =
    kind === 'BadFee' ? `expected fee ${fmtICP(err.BadFee.expected_fee)} ICP` :
    kind === 'InsufficientFunds' ? `balance is ${fmtICP(err.InsufficientFunds.balance)} ICP — minting needs ${fmtICP(MINT_FEE_E8S + ICP_LEDGER_FEE_E8S)} ICP (fee + ledger fee)` :
    kind === 'TooOld' ? 'transaction window expired' :
    kind === 'CreatedInFuture' ? 'clock skew — try again' :
    kind === 'Duplicate' ? `duplicate of block ${err.Duplicate.duplicate_of}` :
    kind === 'TemporarilyUnavailable' ? 'ledger temporarily unavailable' :
    kind === 'GenericError' ? err.GenericError.message :
    JSON.stringify(err, (_k, v) => typeof v === 'bigint' ? v.toString() : v);
  return `Deposit failed (${kind}): ${detail}`;
}

// ── Component ──

interface CourseCreateProps {
  actor: any;
  identity: any;
  host: string;
  rootKey?: Uint8Array;
  /** ICP ledger canister id (for the mint-fee deposit). */
  ledgerCanisterId: string;
  /** Arcade golfer look, used for the test round. */
  character: CharacterLook | null;
  onExit: () => void;
  onMinted: () => void;
}

const LABEL_STYLE: React.CSSProperties = {
  fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase',
  color: 'var(--fg-3)', fontFamily: 'var(--font-mono, monospace)',
};

function StepTag({ n, done }: { n: number; done: boolean }) {
  return (
    <span className="row" style={{ gap: 8 }}>
      <Chip tone={done ? 'ok' : 'muted'} style={{ height: 20, fontSize: 10.5 }}>
        {done ? <Icon name="check" size={11} stroke="var(--sprout-ink)" /> : null} Step {n}
      </Chip>
    </span>
  );
}

export default function CourseCreate({
  actor, identity, host, rootKey, ledgerCanisterId, character, onExit, onMinted,
}: CourseCreateProps) {
  // Step 1 — copy the AI instructions.
  const [copied, setCopied] = useState(false);
  const [showPromptFallback, setShowPromptFallback] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);

  // Step 2 — the pasted/uploaded JSON.
  const [jsonText, setJsonText] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Step 3 — test play: full test round, the course-map grid (CourseOverview
  // with per-hole preview/practice), a single-hole practice round, or the
  // step-1 element-demo hole (every authorable element in one playable hole).
  const [view, setView] = useState<'wizard' | 'overview' | 'play' | 'practice' | 'demo'>('wizard');
  const [practiceIdx, setPracticeIdx] = useState(0);
  const [testPlayed, setTestPlayed] = useState(false);

  // Step 4 — mint.
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const [mintErr, setMintErr] = useState<string | null>(null);
  const [mintedId, setMintedId] = useState<bigint | null>(null);
  const [shareCopied, setShareCopied] = useState(false);

  // Parse + validate live. `doc` is null until the JSON is a valid course.
  const parsed = useMemo((): { doc: CourseInstructions | null; error: string | null } => {
    const text = jsonText.trim();
    if (!text) return { doc: null, error: null };
    try {
      return { doc: parseCourseInstructions(text), error: null };
    } catch (e) {
      return { doc: null, error: friendlyCourseError(e) };
    }
  }, [jsonText]);
  const { doc, error: parseError } = parsed;
  const summary = doc ? summarizeCourse(doc) : null;

  // Originality pre-check (free query) so a clone is caught BEFORE the fee is
  // paid. The backend enforces the same rule inside mint_course_nft.
  const [uniq, setUniq] = useState<CourseUniquenessReport | null>(null);
  useEffect(() => {
    setUniq(null);
    if (!doc) return;
    let cancelled = false;
    (async () => {
      try {
        const report = await actor.check_course_uniqueness(new TextEncoder().encode(jsonText.trim()));
        if (!cancelled) setUniq(report);
      } catch { /* advisory — the mint call still enforces it */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, actor]);
  const uniqBlocked = uniq?.would_block ?? false;

  // Prefill the mint name whenever a valid course (re)parses.
  useEffect(() => {
    if (doc) setName(doc.name.slice(0, MAX_NAME_CHARS));
  }, [doc?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(buildCoursePrompt());
      setCopied(true);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard unavailable (permissions/insecure context) — show the text.
      setShowPromptFallback(true);
    }
  };

  const onFilePicked = async (file: File | undefined) => {
    if (!file) return;
    setJsonText(await file.text());
  };

  const mint = async () => {
    if (busy || !doc || !identity) return;
    const finalName = name.trim();
    if (!finalName) { setMintErr('Give your course a name.'); return; }
    setBusy(true);
    setMintErr(null);
    try {
      setStep(`Step 1/2: Depositing ${fmtICP(MINT_FEE_E8S)} ICP mint fee…`);
      const acct = await actor.get_mint_deposit_address();
      const ledgerActor = createLedgerActor(ledgerCanisterId, {
        agentOptions: { host, identity, rootKey },
      });
      const transferResult = await ledgerActor.icrc1_transfer({
        to: {
          owner: acct.owner,
          subaccount: acct.subaccount ? acct.subaccount : undefined,
        },
        amount: MINT_FEE_E8S,
      });
      if (transferResult.__kind__ === 'Err') {
        throw new Error(transferErrMessage(transferResult.Err));
      }

      setStep('Step 2/2: Minting your course NFT…');
      // The NFT carries the user's original JSON document as its course_data blob.
      const res = await actor.mint_course_nft(new TextEncoder().encode(jsonText.trim()), finalName);
      if (res.__kind__ === 'Err') throw new Error(mintErrMessage(res.Err));
      setMintedId(res.Ok);
    } catch (e: any) {
      setMintErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  // Compiled holes for test play / the course map (null until doc is valid).
  const holes = useMemo(() => {
    if (!doc) return null;
    try { return courseFromInstructions(doc); } catch { return null; }
  }, [doc]);

  // ── Element demo: one playable hole with EVERY authorable element, so a
  //    creator can see grass/rough/sand/water/walls/posts/conveyors/windmill
  //    in action before designing with their AI. Unscored. ──
  if (view === 'demo') {
    return (
      <MiniGolf
        course={[holeFromInstructions(SHOWCASE_HOLE)]}
        character={character}
        fullAccess
        onRoundComplete={() => { /* demo — never scored */ }}
        onExit={() => setView('wizard')}
        onGoParticipate={() => setView('wizard')}
        submitNote="Element demo — rough & sand slow the ball, water costs a stroke, walkways carry it, boost pads fling it, bumpers spring it, one-way gates only open one way, a firm putt climbs the plateau's sloped rim, and the windmills, pendulum and slider get in the way."
      />
    );
  }

  // ── Course map: the same 3×3 preview grid players get, pre-mint. ──
  if (view === 'overview' && holes && doc) {
    return (
      <CourseOverview
        course={holes}
        courseName={doc.name}
        hint="Scout every hole before minting — preview with pan & zoom, practice a hole solo, or play the full course. Nothing here is scored."
        onPlayRound={() => { setTestPlayed(true); setView('play'); }}
        onPracticeHole={(idx) => { setTestPlayed(true); setPracticeIdx(idx); setView('practice'); }}
        onExit={() => setView('wizard')}
      />
    );
  }

  // ── Test play: the real engine, unscored (like the classic course). ──
  if (view === 'play' && holes) {
    return (
      <MiniGolf
        course={holes}
        character={character}
        fullAccess
        onRoundComplete={() => { /* test round — never scored */ }}
        onExit={() => setView('wizard')}
        onGoParticipate={() => setView('wizard')}
        submitNote="Test round — not scored. Head back to mint your course."
      />
    );
  }

  // ── Single-hole practice, entered from the course map. ──
  if (view === 'practice' && holes) {
    return (
      <MiniGolf
        key={`practice-${practiceIdx}`}
        course={[holes[practiceIdx]]}
        character={character}
        fullAccess
        onRoundComplete={() => { /* practice — never scored */ }}
        onExit={() => setView('overview')}
        onGoParticipate={() => setView('overview')}
        submitNote="Practice hole — not scored. Head back to the course map."
      />
    );
  }

  return (
    <div className="col" style={{ gap: 16 }}>
      {/* ── Header ── */}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div className="col" style={{ gap: 6 }}>
          <Eyebrow accent>Play &amp; earn</Eyebrow>
          <span className="row" style={{ gap: 10 }}>
            <Icon name="spark" size={22} stroke="var(--burn-ink)" />
            <h4 style={{ margin: 0 }}>Create a course</h4>
          </span>
          <p style={{ fontSize: 13, color: 'var(--fg-2)', maxWidth: 560, margin: 0 }}>
            Describe your dream course to any AI agent, upload what it builds,
            test it in the real engine — then mint it as an NFT that earns you
            lottery tickets.{' '}
            <MoreInfo title="How AI-built courses work">
              <div className="col" style={{ gap: 6 }}>
                <Eyebrow accent>The loop</Eyebrow>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                  <li><b>Copy the instructions</b> below — they teach any AI agent the exact course format.</li>
                  <li><b>Design together:</b> paste them to ChatGPT, Claude, or any agent and describe the 9 holes you want.</li>
                  <li><b>Upload the JSON</b> it outputs; we validate every hole before anything is paid.</li>
                  <li><b>Test-play</b> your course in the real engine, free and unscored.</li>
                  <li><b>Mint</b> it for {fmtICP(MINT_FEE_E8S)} ICP — the JSON itself becomes the NFT's on-chain course data, it's auto-listed on the marketplace, and you earn a lottery ticket every time a player reaches hole 2.</li>
                </ul>
              </div>
              <div className="col" style={{ gap: 6 }}>
                <Eyebrow accent>Requirements</Eyebrow>
                <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>
                  Anyone signed in can mint — it costs {fmtICP(MINT_FEE_E8S)} ICP
                  (+ {fmtICP(ICP_LEDGER_FEE_E8S)} ledger fee). Courses must be
                  original: a design whose holes copy an existing course NFT
                  (even mirrored or shifted) is rejected at mint. Creators keep a
                  permanent 10% royalty on every resale.
                </p>
              </div>
            </MoreInfo>
          </p>
        </div>
        <Btn variant="ghost" sm onClick={onExit}>
          <Icon name="chevLeft" size={12} /> Back to arcade
        </Btn>
      </div>

      {mintedId !== null ? (
        /* ── Success ── */
        <div className="card col" style={{ gap: 12, borderColor: 'var(--sprout)' }}>
          <span className="row" style={{ gap: 8, color: 'var(--ok)', fontSize: 14 }}>
            <Icon name="checkCircle" size={18} stroke="var(--ok)" />
            <b>"{name.trim()}" is minted — course NFT #{mintedId.toString()}.</b>
          </span>
          <p style={{ fontSize: 13, color: 'var(--fg-2)', margin: 0 }}>
            It's live on the marketplace already. You earn a lottery ticket every
            time a player reaches hole 2 — and a permanent 10% creator royalty if
            it ever resells.
          </p>
          {/* Share: the canonical deep link opens the course directly. */}
          <div className="col" style={{ gap: 6, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
            <span style={LABEL_STYLE}>Share your course</span>
            <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-2)', wordBreak: 'break-all' }}>
              {courseShareUrl(mintedId, window.location.origin)}
            </span>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <Btn variant="secondary" sm onClick={async () => {
                try {
                  await navigator.clipboard.writeText(courseShareUrl(mintedId, window.location.origin));
                  setShareCopied(true);
                  window.clearTimeout(copiedTimer.current);
                  copiedTimer.current = window.setTimeout(() => setShareCopied(false), 2500);
                } catch { /* the URL is shown above for manual copy */ }
              }}>
                <Icon name="copy" size={12} /> {shareCopied ? 'Copied ✓' : 'Copy link'}
              </Btn>
              <Btn
                variant="ghost"
                sm
                onClick={() => window.open(
                  courseShareIntent(name.trim(), courseShareUrl(mintedId, window.location.origin)),
                  '_blank',
                  'noopener,noreferrer',
                )}
              >
                <Icon name="external" size={12} /> Share on X
              </Btn>
            </div>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Btn variant="primary" sm onClick={onMinted}>Done</Btn>
          </div>
        </div>
      ) : (
        <>
          {/* ── Step 1: get the instructions ── */}
          <div className="card col" style={{ gap: 10 }}>
            <StepTag n={1} done={copied} />
            <b style={{ fontSize: 14 }}>Get the AI course-designer instructions</b>
            <ol style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12.5, lineHeight: 1.5, color: 'var(--fg-2)' }}>
              <li>Copy the instructions — they teach an AI agent the course format, cell by cell.</li>
              <li>Paste them to your favorite AI (ChatGPT, Claude, …) and design the course together.</li>
              <li>Come back with the JSON document it outputs.</li>
            </ol>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <Btn variant="primary" sm onClick={copyPrompt}>
                <Icon name="copy" size={12} stroke="var(--char-950)" />
                {copied ? 'Copied ✓' : 'Copy AI instructions'}
              </Btn>
              <Btn variant="ghost" sm onClick={() => setShowPromptFallback(true)}>
                <Icon name="eye" size={12} /> View
              </Btn>
              <Btn variant="secondary" sm onClick={() => setView('demo')} title="Play one hole containing every element a course can use">
                <Icon name="gamepad" size={12} /> Try every element
              </Btn>
            </div>
            <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
              Not sure what the pieces do? <b>Try every element</b> plays a demo hole
              with all of them: grass, rough, sand, water, walls, posts, springy
              bumpers, boost pads, one-way gates, moving walkways in all four
              directions, an elevated plateau with sloped sides you roll up, 3-
              and 4-arm windmills, a swinging pendulum, and a patrolling
              slider block.
            </span>
          </div>

          {/* ── Step 2: upload the course ── */}
          <div className="card col" style={{ gap: 10 }}>
            <StepTag n={2} done={!!doc} />
            <b style={{ fontSize: 14 }}>Upload your AI's course</b>
            <textarea
              className="burn-input"
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              placeholder='Paste the course JSON here — it starts with {"format": "proof-of-burn/minigolf-course@1", …'
              rows={6}
              spellCheck={false}
              style={{ resize: 'vertical', fontFamily: 'var(--font-mono, monospace)', fontSize: 11.5 }}
            />
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                style={{ display: 'none' }}
                onChange={(e) => { onFilePicked(e.target.files?.[0]); e.target.value = ''; }}
              />
              <Btn variant="secondary" sm onClick={() => fileInputRef.current?.click()}>
                <Icon name="arrowUp" size={12} /> Upload .json file
              </Btn>
              {jsonText.trim() && (
                <Btn variant="ghost" sm onClick={() => setJsonText('')}>
                  <Icon name="x" size={12} /> Clear
                </Btn>
              )}
            </div>
            {parseError && (
              <span className="row" style={{ gap: 8, fontSize: 12.5, color: 'var(--ember)' }}>
                <Icon name="x" size={13} stroke="var(--ember)" /> {parseError}
              </span>
            )}
            {summary && (
              <div className="col" style={{ gap: 8, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <Icon name="checkCircle" size={14} stroke="var(--ok)" />
                  <b style={{ fontSize: 13.5 }}>{summary.name}</b>
                  <Chip tone="muted" style={{ height: 19, fontSize: 10 }}>9 holes</Chip>
                  <Chip tone="muted" style={{ height: 19, fontSize: 10 }}>Par {summary.parTotal}</Chip>
                  <Chip tone="burn" style={{ height: 19, fontSize: 10 }}>{summary.difficulty}</Chip>
                </span>
                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  {summary.holes.map((h, i) => (
                    <span key={i} className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)', border: '1px solid var(--border)', borderRadius: 6, padding: '2px 7px' }}>
                      {h.name} · par {h.par} · {h.grid}{h.windmills > 0 ? ` · ${h.windmills}⚙` : ''}
                    </span>
                  ))}
                </div>
                {/* Originality verdict: pass / warn (< limit) / block (≥ limit). */}
                {uniq && (uniq.duplicates.length === 0 ? (
                  <span className="row" style={{ gap: 6, fontSize: 12, color: 'var(--ok)' }}>
                    <Icon name="checkCircle" size={13} stroke="var(--ok)" /> Originality check passed — no hole matches an existing course.
                  </span>
                ) : uniq.would_block ? (
                  <span className="row" style={{ gap: 6, fontSize: 12, color: 'var(--ember)', alignItems: 'flex-start' }}>
                    <Icon name="x" size={13} stroke="var(--ember)" />
                    <span>
                      Too close to an existing course: {uniq.duplicates.length} of 9 holes
                      (holes {uniq.duplicates.map((d) => d.hole_index + 1).join(', ')}) already exist
                      — mirrored or shifted copies count too. Redesign them with your AI; minting is blocked at {uniq.limit}.
                    </span>
                  </span>
                ) : (
                  <span className="row" style={{ gap: 6, fontSize: 12, color: 'var(--haze-ink)', alignItems: 'flex-start' }}>
                    <Icon name="info" size={13} stroke="var(--haze-ink)" />
                    <span>
                      Heads up: {uniq.duplicates.length === 1 ? 'hole' : 'holes'}{' '}
                      {uniq.duplicates.map((d) => d.hole_index + 1).join(', ')} match an existing course.
                      That's allowed (under {uniq.limit}), but more overlap would block the mint.
                    </span>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* ── Step 3: test play ── */}
          <div className="card col" style={{ gap: 10, opacity: doc ? 1 : 0.55 }}>
            <StepTag n={3} done={testPlayed} />
            <b style={{ fontSize: 14 }}>Test your course</b>
            <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: 0 }}>
              See the whole course at a glance on the course map — preview any hole
              with pan &amp; zoom or practice it solo — then play all 9 holes in the
              real engine. Free, unscored, as many rounds as you like.
            </p>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <Btn
                variant="secondary"
                sm
                disabled={!holes}
                onClick={() => setView('overview')}
              >
                <Icon name="gamepad" size={12} /> Course map
              </Btn>
              <Btn
                variant="secondary"
                sm
                disabled={!holes}
                onClick={() => { setTestPlayed(true); setView('play'); }}
              >
                <Icon name="flame" size={12} /> Play a test round
              </Btn>
            </div>
          </div>

          {/* ── Step 4: mint ── */}
          <div className="card col" style={{ gap: 10, opacity: doc ? 1 : 0.55 }}>
            <StepTag n={4} done={false} />
            <b style={{ fontSize: 14 }}>Mint it as an NFT</b>
            <div className="col" style={{ gap: 4 }}>
              <span style={LABEL_STYLE}>Course name</span>
              <input
                className="burn-input"
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, MAX_NAME_CHARS))}
                placeholder="Name your course"
                disabled={!doc || busy}
                maxLength={MAX_NAME_CHARS}
              />
            </div>
            <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
              Mint fee: <b className="mono" style={{ color: 'var(--fg)' }}>{fmtICP(MINT_FEE_E8S)} ICP</b>
              {' '}(+ {fmtICP(ICP_LEDGER_FEE_E8S)} ICP ledger fee on the deposit).
            </span>
            <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
              Anyone signed in can mint. Your course is auto-listed on the
              marketplace and earns you a lottery ticket each time a player
              reaches hole 2.
            </span>
            {doc && !testPlayed && (
              <span className="row" style={{ gap: 6, fontSize: 12, color: 'var(--haze-ink)' }}>
                <Icon name="info" size={13} stroke="var(--haze-ink)" />
                Tip: test-play your course first — minted courses can't be edited.
              </span>
            )}
            {busy && step && (
              <span className="row" style={{ gap: 8, fontSize: 12, color: 'var(--fg-2)' }}>
                <LiveDot size={7} /> {step}
              </span>
            )}
            {mintErr && <span style={{ fontSize: 12, color: 'var(--ember)' }}>{mintErr}</span>}
            <Btn
              variant="primary"
              sm
              disabled={!doc || busy || uniqBlocked}
              title={uniqBlocked ? 'Too many holes match an existing course — see the originality check above.' : undefined}
              style={{ alignSelf: 'flex-start' }}
              onClick={mint}
            >
              {busy ? 'Working…' : uniqBlocked ? 'Blocked — too similar to an existing course' : `Mint — ${fmtICP(MINT_FEE_E8S)} ICP`}
            </Btn>
          </div>
        </>
      )}

      {/* ── Manual-copy fallback / instructions viewer ── */}
      {showPromptFallback && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(12, 10, 9, 0.85)', backdropFilter: 'blur(8px)',
            zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
          }}
          onClick={() => setShowPromptFallback(false)}
        >
          <div
            className="card col"
            style={{ maxWidth: 640, width: '100%', gap: 12, background: 'var(--surface)', border: '1px solid var(--border-hi)', boxShadow: 'var(--elev-3)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <b>AI course-designer instructions</b>
              <Btn variant="ghost" sm onClick={() => setShowPromptFallback(false)}><Icon name="x" size={14} /></Btn>
            </div>
            <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
              Copy everything below and paste it to your AI agent.
            </span>
            <textarea
              className="burn-input"
              readOnly
              value={buildCoursePrompt()}
              rows={14}
              onFocus={(e) => e.target.select()}
              style={{ resize: 'vertical', fontFamily: 'var(--font-mono, monospace)', fontSize: 11 }}
            />
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <Btn variant="primary" sm onClick={copyPrompt}>
                <Icon name="copy" size={12} stroke="var(--char-950)" /> {copied ? 'Copied ✓' : 'Copy'}
              </Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
