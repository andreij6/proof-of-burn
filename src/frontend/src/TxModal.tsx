import React, { useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon, LiveDot, Btn, Eyebrow } from './ui';

// ==========================================================================
// TxModal — a reusable staged-transaction modal.
//
// Every multi-step money action (deposit → finalize, escrow → settle, …)
// should drive one of these so the user always sees WHAT is happening at each
// stage, that their funds are safe, and — on failure — a plain-English reason.
//
// Two pieces:
//   • useTxFlow()  — a tiny controller hook that holds the state + drives it
//                    (start / next / setStage / succeed / fail / reset).
//   • <TxModal />  — renders the controller's state as an ordered stage list
//                    with per-stage status + terminal success/error panels.
//
// It is page-agnostic: it takes no actor, no principal, no domain types. The
// caller runs the transaction and reports progress; the modal only renders.
//
// Pairs with errors.ts: on failure the caller passes the already-friendly text
// (toFriendly(e, ctx) / a FriendlyError message) to `fail` — never a raw code.
// ==========================================================================

export type TxStageStatus = 'pending' | 'active' | 'done' | 'error';

/** One named step in a transaction. `status` is derived by the controller. */
export interface TxStage {
  label: string;
  status: TxStageStatus;
}

/** The lifecycle of an in-flight transaction the modal renders. `idle` means
 *  the modal is closed. */
export type TxState =
  | { kind: 'idle' }
  | { kind: 'running'; title: string; detail?: string; stages: TxStage[]; current: number }
  | { kind: 'success'; title: string; detail?: string; stages: TxStage[] }
  | { kind: 'error'; title: string; detail?: string; message: string; stages: TxStage[] };

/** The controller returned by useTxFlow — a tiny, ergonomic driver. */
export interface TxFlow {
  state: TxState;
  /** True while a stage is running (dismiss is locked, aria-busy is set). */
  isActive: boolean;
  /** True when the modal should render (anything but idle). */
  isOpen: boolean;
  /** Begin a flow. Pass the ordered stage labels; the first becomes active. */
  start: (stageLabels: string[], opts?: { title?: string; detail?: string }) => void;
  /** Mark the current active stage done and activate the next one. Optionally
   *  update the detail line (e.g. "Step 2/2: finalizing…"). */
  next: (detail?: string) => void;
  /** Jump to an explicit stage index (earlier stages become done, it becomes
   *  active, later stages stay pending). Optionally update the detail line. */
  setStage: (index: number, detail?: string) => void;
  /** Update the detail line without changing stages. */
  setDetail: (detail?: string) => void;
  /** Terminal success: all stages done, show the success panel. */
  succeed: (message?: string, opts?: { title?: string }) => void;
  /** Terminal failure: mark the active stage errored, show the friendly
   *  message. Pass text already run through errors.ts (toFriendly / a
   *  FriendlyError message) — NOT a raw code. */
  fail: (friendlyMessage: string, opts?: { title?: string }) => void;
  /** Close the modal / return to idle. */
  reset: () => void;
}

const DEFAULT_TITLE = 'Processing your transaction';
const DEFAULT_SUCCESS = 'Your transaction is confirmed.';

function stagesFor(labels: string[], activeIndex: number, terminal?: 'done' | 'error'): TxStage[] {
  return labels.map((label, i) => {
    let status: TxStageStatus;
    if (i < activeIndex) status = 'done';
    else if (i > activeIndex) status = 'pending';
    else status = terminal ?? 'active'; // the current stage
    return { label, status };
  });
}

/** Controller hook. Hold one per money action:
 *    const tx = useTxFlow();
 *  then drive it from your handler and render <TxModal flow={tx} />. */
export function useTxFlow(): TxFlow {
  // Labels + active index are the source of truth; stages are derived so the
  // API stays "advance the pointer" simple.
  const [state, setState] = useState<TxState>({ kind: 'idle' });
  const [labels, setLabels] = useState<string[]>([]);
  const [title, setTitle] = useState(DEFAULT_TITLE);

  const start = useCallback((stageLabels: string[], opts?: { title?: string; detail?: string }) => {
    const t = opts?.title ?? DEFAULT_TITLE;
    setLabels(stageLabels);
    setTitle(t);
    setState({ kind: 'running', title: t, detail: opts?.detail, stages: stagesFor(stageLabels, 0), current: 0 });
  }, []);

  const setStage = useCallback((index: number, detail?: string) => {
    setState((s) => {
      if (s.kind !== 'running') return s;
      const i = Math.max(0, Math.min(index, labels.length - 1));
      return { ...s, current: i, detail: detail ?? s.detail, stages: stagesFor(labels, i) };
    });
  }, [labels]);

  const next = useCallback((detail?: string) => {
    setState((s) => {
      if (s.kind !== 'running') return s;
      const i = Math.min(s.current + 1, labels.length - 1);
      return { ...s, current: i, detail: detail ?? s.detail, stages: stagesFor(labels, i) };
    });
  }, [labels]);

  const setDetail = useCallback((detail?: string) => {
    setState((s) => (s.kind === 'running' ? { ...s, detail } : s));
  }, []);

  const succeed = useCallback((message?: string, opts?: { title?: string }) => {
    setState((s) => ({
      kind: 'success',
      title: opts?.title ?? (s.kind !== 'idle' ? title : DEFAULT_TITLE),
      detail: message ?? DEFAULT_SUCCESS,
      stages: labels.map((label) => ({ label, status: 'done' as const })),
    }));
  }, [labels, title]);

  const fail = useCallback((friendlyMessage: string, opts?: { title?: string }) => {
    setState((s) => {
      const current = s.kind === 'running' ? s.current : Math.max(labels.length - 1, 0);
      return {
        kind: 'error',
        title: opts?.title ?? title,
        message: friendlyMessage,
        stages: stagesFor(labels, current, 'error'),
      };
    });
  }, [labels, title]);

  const reset = useCallback(() => {
    setState({ kind: 'idle' });
    setLabels([]);
  }, []);

  const isActive = state.kind === 'running';
  const isOpen = state.kind !== 'idle';

  return useMemo(
    () => ({ state, isActive, isOpen, start, next, setStage, setDetail, succeed, fail, reset }),
    [state, isActive, isOpen, start, next, setStage, setDetail, succeed, fail, reset],
  );
}

// ── Per-stage status indicator ────────────────────────────────────────────
function StageIcon({ status }: { status: TxStageStatus }) {
  const box: React.CSSProperties = {
    width: 20, height: 20, borderRadius: 999, flexShrink: 0,
    display: 'grid', placeItems: 'center',
  };
  if (status === 'done') {
    return (
      <span style={{ ...box, background: 'color-mix(in srgb, var(--sprout) 20%, transparent)' }}>
        <Icon name="check" size={12} stroke="var(--sprout-ink)" sw={2.4} />
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span style={{ ...box, background: 'color-mix(in srgb, var(--ember) 18%, transparent)' }}>
        <Icon name="x" size={12} stroke="var(--ember)" sw={2.4} />
      </span>
    );
  }
  if (status === 'active') {
    return (
      <span style={{ ...box, border: '1px solid var(--burn)' }}>
        <LiveDot size={7} color="var(--burn-ink)" />
      </span>
    );
  }
  // pending
  return (
    <span style={{ ...box, border: '1px dashed var(--border-hi)' }}>
      <span style={{ width: 5, height: 5, borderRadius: 999, background: 'var(--fg-3)', opacity: 0.5 }} />
    </span>
  );
}

function StageRow({ stage }: { stage: TxStage }) {
  const active = stage.status === 'active';
  const muted = stage.status === 'pending';
  return (
    <div className="row" style={{ gap: 10, alignItems: 'center' }}>
      <StageIcon status={stage.status} />
      <span style={{
        fontSize: 13,
        fontWeight: active ? 600 : 500,
        color: muted ? 'var(--fg-3)' : stage.status === 'error' ? 'var(--ember)' : 'var(--fg)',
        lineHeight: 1.4,
      }}>
        {stage.label}
      </span>
    </div>
  );
}

/** The staged-transaction modal. Renders nothing while the flow is idle.
 *
 *  <TxModal flow={tx} />                     // dismiss = tx.reset()
 *  <TxModal flow={tx} onClose={handleDone} /> // custom dismiss/success action
 */
export function TxModal({ flow, onClose }: { flow: TxFlow; onClose?: () => void }) {
  const { state, isActive } = flow;
  if (state.kind === 'idle') return null;

  const dismiss = onClose ?? flow.reset;
  const stages = state.stages;
  const titleId = 'txmodal-title';

  return createPortal(
    <div
      onClick={isActive ? undefined : dismiss}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(12, 10, 9, 0.78)', backdropFilter: 'blur(6px)',
        display: 'grid', placeItems: 'center', padding: 16,
      }}
    >
      <div
        className="col"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={isActive}
        onClick={(e) => e.stopPropagation()}
        style={{
          gap: 16, maxWidth: 440, width: '100%', maxHeight: '90vh', overflowY: 'auto',
          background: 'var(--surface)', border: '1px solid var(--border-hi)',
          borderRadius: 14, padding: 20, boxShadow: 'var(--elev-3)',
        }}
      >
        {/* Header */}
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div className="col" style={{ gap: 4 }}>
            <Eyebrow accent>
              {state.kind === 'success' ? 'Complete' : state.kind === 'error' ? 'Stopped' : 'In progress'}
            </Eyebrow>
            <b id={titleId} style={{ fontSize: 15, color: 'var(--fg)', lineHeight: 1.35 }}>{state.title}</b>
          </div>
          {/* Dismiss is DISABLED while a stage is active — no closing mid-tx. */}
          {!isActive && (
            <button
              onClick={dismiss}
              aria-label="Close"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg-2)', padding: 2, display: 'flex' }}
            >
              <Icon name="x" size={16} />
            </button>
          )}
        </div>

        {/* Stage list */}
        <div className="col" style={{ gap: 12 }}>
          {stages.map((s, i) => <StageRow key={i} stage={s} />)}
        </div>

        {/* Running: live detail + reassurance */}
        {state.kind === 'running' && (
          <div className="col" style={{ gap: 6, padding: '10px 12px', borderRadius: 8, background: 'var(--bg-alt)', border: '1px solid var(--border)' }} role="status">
            {state.detail && <span style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>{state.detail}</span>}
            <span style={{ fontSize: 11.5, color: 'var(--fg-3)', lineHeight: 1.45 }}>
              Your funds are safe — this takes a few seconds. Please don't close the tab.
            </span>
          </div>
        )}

        {/* Terminal: success */}
        {state.kind === 'success' && (
          <div className="col" style={{ gap: 12 }}>
            <div className="row" style={{ gap: 10, alignItems: 'center', padding: '10px 12px', borderRadius: 8, background: 'color-mix(in srgb, var(--sprout) 12%, transparent)', border: '1px solid var(--sprout)' }} role="status">
              <Icon name="checkCircle" size={20} stroke="var(--sprout-ink)" />
              <span style={{ fontSize: 12.5, color: 'var(--fg)', lineHeight: 1.5 }}>{state.detail}</span>
            </div>
            <Btn variant="primary" onClick={dismiss} style={{ alignSelf: 'flex-end' }}>Done</Btn>
          </div>
        )}

        {/* Terminal: error — plain-English message, never a raw code */}
        {state.kind === 'error' && (
          <div className="col" style={{ gap: 12 }}>
            <div className="col" style={{ gap: 6, padding: '10px 12px', borderRadius: 8, background: 'color-mix(in srgb, var(--ember) 10%, transparent)', border: '1px solid var(--ember)' }} role="alert">
              <span className="row" style={{ gap: 8, alignItems: 'center' }}>
                <Icon name="info" size={15} stroke="var(--ember)" />
                <b style={{ fontSize: 13, color: 'var(--ember)' }}>That didn't go through</b>
              </span>
              <span style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>{state.message}</span>
              {state.detail && <span style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>{state.detail}</span>}
              <span style={{ fontSize: 11.5, color: 'var(--fg-3)', lineHeight: 1.45 }}>
                Nothing is lost when a step fails — any payment already in escrow stays reclaimable.
              </span>
            </div>
            <Btn variant="secondary" onClick={dismiss} style={{ alignSelf: 'flex-end' }}>Close</Btn>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export default TxModal;
