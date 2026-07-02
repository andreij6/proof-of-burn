import { useEffect, useRef, useState } from 'react';
import type { CourseCard, CourseRatingSummary } from './bindings/backend';
import { Icon, Btn, LiveDot } from './ui';
import { formatRating } from './arcade/courseMarket';
import MiniGolf from './arcade/MiniGolf';
import CourseOverview from './arcade/CourseOverview';
import type { HoleDef, CharacterLook } from './arcade/engine';
import { decodeCourseBlob } from './arcade/courseInstructions';

// ==========================================
// Course Play (PB-306 frontend wiring) — loads a chosen course's blob, decodes
// it, and shows the course overview (3×3 hole map with per-hole Preview /
// unscored practice) before the scored round runs in the existing MiniGolf
// engine, driving the signed play-session pipeline:
//   start_play_session(token_id)  on mount
//   record_hole_event(sid, hole)  per hole sunk (in order)
//   complete_round(sid)           when hole 9 is sunk
// Only the full round is scored — practice mounts MiniGolf with a single hole
// and never touches the session. Ticket calls NEVER block gameplay; a backend
// reject (TOO_FAST / OUT_OF_ORDER) just marks the round un-scoreable and the
// round keeps playing for fun.
// ==========================================

interface CoursePlayProps {
  actor: any;
  card: CourseCard;
  character: CharacterLook | null;
  onExit: () => void;
  onGoParticipate: () => void;
  /** Spectate-only: the "View NFT" 3×3 grid — no scored round is started, no
   *  "Play the course" CTA. Preview + unscored practice still work. */
  spectateOnly?: boolean;
}

/** Friendly copy for a complete_round `reason` code. */
function completionNote(credited: boolean, reason?: string): string {
  if (credited) return '+1 lottery ticket earned!';
  switch (reason) {
    case 'ANON':
    case 'TIER_TOO_LOW':
      return 'Sign in and follow the leader to earn a lottery ticket.';
    case 'DAILY_CAP':
      return 'Daily ticket cap reached — play for fun, no ticket this round.';
    case 'ADMIN_EXCLUDED':
      return 'Admins do not earn lottery tickets.';
    default:
      return 'Round complete — no ticket this round.';
  }
}

export default function CoursePlay({ actor, card, character, onExit, onGoParticipate, spectateOnly = false }: CoursePlayProps) {
  const [holes, setHoles] = useState<HoleDef[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [submitNote, setSubmitNote] = useState<string | undefined>(undefined);
  // Show a "rate this course" prompt once the player completes a round (PB-310).
  const [showRate, setShowRate] = useState(false);
  // Course map first; 'round' = the scored 9 holes, 'practice' = one unscored hole.
  const [view, setView] = useState<'overview' | 'round' | 'practice'>('overview');
  const [practiceIdx, setPracticeIdx] = useState(0);

  // Session id + a "scoreable" flag live in refs (never persisted — a reload
  // abandons the round by design, which is the replay surface we avoid).
  const sessionIdRef = useRef<bigint | null>(null);
  const scoreableRef = useRef<boolean>(true);

  // ── Load the course blob + start the session ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const blob: Uint8Array | null = await actor.get_course_data(card.token_id);
        if (cancelled) return;
        if (!blob) { setLoadErr('This course could not be loaded.'); return; }
        setHoles(decodeCourseBlob(blob));
      } catch (err: any) {
        if (!cancelled) setLoadErr(err?.message || String(err));
      }
    })();

    // Start the scored session in parallel. A failure just means the round is
    // unscored — the game still plays. Skipped in spectate-only mode (View NFT):
    // no scored round, no session.
    if (!spectateOnly) {
      (async () => {
        try {
          const res = await actor.start_play_session(card.token_id);
          if (cancelled) return;
          if (res.__kind__ === 'Ok') {
            sessionIdRef.current = res.Ok.session_id;
            scoreableRef.current = true;
          } else {
            scoreableRef.current = false;
            setSubmitNote('Playing for fun — couldn\'t start a scored round.');
          }
        } catch {
          scoreableRef.current = false;
        }
      })();
    }

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.token_id]);

  const handleHoleSunk = async (hole: number) => {
    const sid = sessionIdRef.current;
    if (sid === null || !scoreableRef.current) return;
    try {
      const res = await actor.record_hole_event(sid, hole);
      if (res.__kind__ === 'Err') {
        // TOO_FAST / OUT_OF_ORDER / expired — stop scoring, keep playing.
        scoreableRef.current = false;
      }
    } catch {
      scoreableRef.current = false;
    }
  };

  const handleRoundComplete = async () => {
    // A completed round unlocks rating this course (server enforces the gate).
    if (!card.is_caller_owner) setShowRate(true);
    const sid = sessionIdRef.current;
    if (sid === null || !scoreableRef.current) {
      setSubmitNote('Round complete — played for fun.');
      return;
    }
    try {
      const res = await actor.complete_round(sid);
      if (res.__kind__ === 'Ok') {
        setSubmitNote(completionNote(res.Ok.player_credited, res.Ok.reason));
      } else {
        setSubmitNote('Round complete — no ticket this round.');
      }
    } catch {
      setSubmitNote('Round complete — couldn\'t confirm your ticket.');
    }
  };

  if (loadErr) {
    return (
      <div className="col" style={{ alignItems: 'center', gap: 14, padding: '48px 0', color: 'var(--fg-3)' }}>
        <Icon name="x" size={26} stroke="var(--ember)" />
        <span style={{ fontSize: 14, color: 'var(--ember)' }}>{loadErr}</span>
        <Btn variant="secondary" onClick={onExit}>Back to marketplace</Btn>
      </div>
    );
  }

  if (!holes) {
    return (
      <div style={{ textAlign: 'center', padding: 48, color: 'var(--fg-3)' }}>
        <LiveDot size={10} color="var(--burn-ink)" style={{ margin: '0 auto 12px' }} />
        Loading {card.name || 'course'}…
      </div>
    );
  }

  if (view === 'overview') {
    return (
      <CourseOverview
        course={holes}
        courseName={card.name || `Course #${card.token_id}`}
        onPlayRound={spectateOnly ? undefined : () => setView('round')}
        onPracticeHole={(idx) => { setPracticeIdx(idx); setView('practice'); }}
        onExit={onExit}
        hint={spectateOnly
          ? 'Spectating only — preview any hole to fly over it, or practice a single hole (unscored). Start a scored round from the marketplace.'
          : undefined}
      />
    );
  }

  if (view === 'practice') {
    // One hole, never scored: no onHoleSunk, no complete_round, no rate modal.
    return (
      <MiniGolf
        key={`practice-${practiceIdx}`}
        course={[holes[practiceIdx]]}
        character={character}
        fullAccess
        onRoundComplete={() => { /* practice — never scored */ }}
        onExit={() => setView('overview')}
        onGoParticipate={() => setView('overview')}
        submitNote="Practice round — not scored."
      />
    );
  }

  return (
    <>
      <MiniGolf
        key="round"
        course={holes}
        character={character}
        // Course NFT play is not participation-gated at the engine level — the
        // ticket tier-gate is enforced server-side. Everyone plays all 9 holes.
        fullAccess
        onHoleSunk={handleHoleSunk}
        onRoundComplete={handleRoundComplete}
        onExit={onExit}
        onGoParticipate={onGoParticipate}
        submitNote={submitNote}
      />
      {showRate && (
        <CompletionRateModal actor={actor} card={card} onClose={() => setShowRate(false)} />
      )}
    </>
  );
}

// ── Post-round "rate this course" prompt (PB-310). The completion gate is
//    enforced server-side; we surface any Err gracefully (e.g. you own it). ──
function CompletionRateModal({ actor, card, onClose }: { actor: any; card: CourseCard; onClose: () => void }) {
  const [summary, setSummary] = useState<CourseRatingSummary | null>(null);
  const [stars, setStars] = useState(0);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    actor.get_course_rating_summary(card.token_id)
      .then((s: CourseRatingSummary) => {
        setSummary(s);
        if (s.my_stars !== undefined && s.my_stars !== null) setStars(s.my_stars);
      })
      .catch(() => { /* best-effort */ });
  }, [actor, card.token_id]);

  const submit = async () => {
    if (busy || stars < 1) { if (stars < 1) setErr('Pick 1–5 stars.'); return; }
    setBusy(true); setErr(null);
    try {
      const res = await actor.rate_course(card.token_id, stars, text.trim() ? text.trim() : null);
      if (res.__kind__ === 'Err') {
        const code = res.Err as string;
        throw new Error(
          code === 'MUST_COMPLETE_ROUND' ? 'Finish a full round before rating.'
          : code === 'CANNOT_RATE_OWN_COURSE' ? 'You cannot rate a course you own.'
          : code === 'TEXT_TOO_LONG' ? 'Review must be 280 characters or fewer.'
          : code,
        );
      }
      setDone(true);
    } catch (e: any) { setErr(e?.message || String(e)); } finally { setBusy(false); }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(12, 10, 9, 0.85)', backdropFilter: 'blur(8px)',
      zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }} onClick={onClose}>
      <div className="card col" style={{
        maxWidth: 420, width: '100%', gap: 14, background: 'var(--surface)',
        border: '1px solid var(--border-hi)', boxShadow: 'var(--elev-3)',
      }} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <b>Rate "{card.name || `Course #${card.token_id}`}"</b>
          <Btn variant="ghost" sm onClick={onClose}><Icon name="x" size={14} /></Btn>
        </div>
        {summary && <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>{formatRating(summary.avg_x10, summary.count)}</span>}
        {done ? (
          <>
            <span className="row" style={{ gap: 8, color: 'var(--ok)', fontSize: 13 }}>
              <Icon name="checkCircle" size={16} stroke="var(--ok)" /> Thanks — your rating was saved.
            </span>
            <div className="row" style={{ justifyContent: 'flex-end' }}><Btn variant="primary" sm onClick={onClose}>Close</Btn></div>
          </>
        ) : (
          <>
            <span style={{ fontSize: 13, color: 'var(--fg-2)' }}>Nice round! How was this course?</span>
            <div className="row" style={{ gap: 4 }}>
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} onClick={() => setStars(n)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 2 }} title={`${n} star${n === 1 ? '' : 's'}`}>
                  <Icon name="star" size={24} stroke="var(--burn-ink)" fill={n <= stars ? 'var(--burn)' : 'none'} />
                </button>
              ))}
            </div>
            <textarea
              className="burn-input"
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, 280))}
              placeholder="Optional — a short review (≤ 280 chars)"
              rows={3}
              style={{ resize: 'vertical' }}
            />
            {err && <span style={{ fontSize: 12, color: 'var(--ember)' }}>{err}</span>}
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <Btn variant="ghost" sm disabled={busy} onClick={onClose}>Skip</Btn>
              <Btn variant="primary" sm disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Submit rating'}</Btn>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
