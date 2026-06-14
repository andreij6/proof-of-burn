import { useEffect, useRef, useState } from 'react';
import type { CourseCard } from './bindings/backend';
import { Icon, Btn, LiveDot } from './ui';
import MiniGolf from './arcade/MiniGolf';
import { courseFromData, type HoleDef, type CharacterLook } from './arcade/engine';
import { decodeCourseData } from './arcade/courseData';

// ==========================================
// Course Play (PB-306 frontend wiring) — loads a chosen course's blob, decodes
// it, and runs it in the existing MiniGolf engine while driving the signed
// play-session pipeline:
//   start_play_session(token_id)  on mount
//   record_hole_event(sid, hole)  per hole sunk (in order)
//   complete_round(sid)           when hole 9 is sunk
// Ticket calls NEVER block gameplay; a backend reject (TOO_FAST / OUT_OF_ORDER)
// just marks the round un-scoreable and the round keeps playing for fun.
// ==========================================

interface CoursePlayProps {
  actor: any;
  card: CourseCard;
  character: CharacterLook | null;
  onExit: () => void;
  onGoParticipate: () => void;
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

export default function CoursePlay({ actor, card, character, onExit, onGoParticipate }: CoursePlayProps) {
  const [holes, setHoles] = useState<HoleDef[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [submitNote, setSubmitNote] = useState<string | undefined>(undefined);

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
        const data = decodeCourseData(blob);
        setHoles(courseFromData(data));
      } catch (err: any) {
        if (!cancelled) setLoadErr(err?.message || String(err));
      }
    })();

    // Start the scored session in parallel. A failure just means the round is
    // unscored — the game still plays.
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
        <LiveDot size={10} color="var(--burn)" style={{ margin: '0 auto 12px' }} />
        Loading {card.name || 'course'}…
      </div>
    );
  }

  return (
    <MiniGolf
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
  );
}
