import { useEffect, useState } from 'react';
import { Principal } from "@icp-sdk/core/principal";
import { ExplorerToken, VoteDir } from "./bindings/backend";
import type { ExplorerInfo, Thread, Comment } from "./bindings/backend";
import { createActor as createLedgerActor } from "./bindings/ledger";
import { Icon, Btn, LiveDot } from "./ui";
import { useErrorImpression } from "./analytics";

// ==========================================
// Proposal Discussions — forum threads on a proposal.
// "Start a conversation" ($1) + "See open threads (N)"; up/down vote + comment
// ($0.25). Fees route by token server-side (ICP burns, non-ICP → treasury).
// Threads are deleted when the proposal settles.
// ==========================================

const TOKENS: { t: ExplorerToken; label: string; decimals: number }[] = [
  { t: ExplorerToken.ICP, label: 'ICP', decimals: 8 },
  { t: ExplorerToken.CkBTC, label: 'ckBTC', decimals: 8 },
  { t: ExplorerToken.CkETH, label: 'ckETH', decimals: 18 },
  { t: ExplorerToken.CkUSDC, label: 'ckUSDC', decimals: 6 },
  { t: ExplorerToken.CkUSDT, label: 'ckUSDT', decimals: 6 },
];

function tokenLedger(token: ExplorerToken, info: ExplorerInfo | null): Principal | null {
  if (!info) return null;
  switch (token) {
    case ExplorerToken.ICP: return info.icp_ledger;
    case ExplorerToken.CkBTC: return info.ckbtc_ledger;
    case ExplorerToken.CkETH: return info.cketh_ledger;
    case ExplorerToken.CkUSDC: return info.ckusdc_ledger;
    case ExplorerToken.CkUSDT: return info.ckusdt_ledger;
  }
}
function tokenFee(token: ExplorerToken, info: ExplorerInfo | null): bigint {
  const fb: Record<ExplorerToken, bigint> = {
    [ExplorerToken.ICP]: 10_000n, [ExplorerToken.CkBTC]: 10n, [ExplorerToken.CkETH]: 2_000_000_000_000n,
    [ExplorerToken.CkUSDC]: 10_000n, [ExplorerToken.CkUSDT]: 10_000n,
  };
  if (!info) return fb[token];
  switch (token) {
    case ExplorerToken.ICP: return info.fee_icp_e8s;
    case ExplorerToken.CkBTC: return info.fee_ckbtc_sats;
    case ExplorerToken.CkETH: return info.fee_cketh_wei;
    case ExplorerToken.CkUSDC: return info.fee_ckusdc_micro;
    case ExplorerToken.CkUSDT: return info.fee_ckusdt_micro;
  }
}
function tlabel(t: ExplorerToken): string { return TOKENS.find(x => x.t === t)!.label; }
function score(up: bigint, down: bigint): bigint { return up - down; }

const OVERLAY: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(12,10,9,0.85)', backdropFilter: 'blur(8px)',
  zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
};
const CARD: React.CSSProperties = {
  maxWidth: 640, width: '100%', gap: 14, background: 'var(--surface)',
  border: '1px solid var(--border-hi)', boxShadow: 'var(--elev-3)', maxHeight: '88vh', overflowY: 'auto',
};
const LABEL: React.CSSProperties = {
  fontSize: 11, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.06em',
};

interface Props {
  actor: any;
  identity: any;
  principal: Principal | null;
  host: string;
  rootKey?: Uint8Array;
  explorerInfo: ExplorerInfo | null;
  isAdmin: boolean;
  proposalId: bigint;
  proposalTitle: string;
  proposalUrl: string;
  onSignIn: () => void;
  /** Hide the inline trigger button — caller drives opening via openNonce. */
  hideButton?: boolean;
  /** Bump to open the modal (e.g. from a parent page). */
  openNonce?: number;
  /** When opening, jump straight to this thread's detail. */
  openThreadId?: bigint | null;
  /** Fired after any mutating action (start/comment/vote/remove) so a parent can refresh. */
  onActivity?: () => void;
}

export default function Discussions({
  actor, identity, principal, host, rootKey, explorerInfo, isAdmin, proposalId, proposalTitle, proposalUrl, onSignIn,
  hideButton, openNonce, openThreadId, onActivity,
}: Props) {
  const signedIn = !!(principal && !principal.isAnonymous());
  const [count, setCount] = useState<bigint>(0n);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'list' | 'compose' | 'detail'>('list');
  const [threads, setThreads] = useState<Thread[]>([]);
  const [active, setActive] = useState<Thread | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useErrorImpression(error, 'discussions');

  // compose
  const [token, setToken] = useState<ExplorerToken>(ExplorerToken.ICP);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [commentBody, setCommentBody] = useState('');
  const [replyTo, setReplyTo] = useState<bigint | null>(null);

  useEffect(() => {
    if (!actor) return;
    actor.get_thread_count(proposalId).then(setCount).catch(() => {});
  }, [actor, proposalId]);

  // Parent-driven open (full Discussions page): bump openNonce to open; jump to a
  // specific thread when openThreadId is set.
  useEffect(() => {
    if (!openNonce || !actor) return;
    (async () => {
      setOpen(true); setError(null); setView('list');
      try {
        await refreshList();
        if (openThreadId !== null && openThreadId !== undefined) {
          const t = await actor.get_thread(openThreadId);
          if (t) { setActive(t); setComments(await actor.list_comments(openThreadId)); setView('detail'); }
        }
      } catch (e: any) { setError(e.message || String(e)); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openNonce]);

  const refreshList = async () => {
    const t = await actor.list_threads(proposalId);
    setThreads(t);
    setCount(BigInt(t.length));
    onActivity?.();
  };
  const refreshDetail = async (id: bigint) => {
    const [t, cs] = await Promise.all([actor.get_thread(id), actor.list_comments(id)]);
    setActive(t ?? null);
    setComments(cs);
    onActivity?.();
  };

  const openModal = async () => {
    setOpen(true); setView('list'); setError(null);
    try { await refreshList(); } catch (e: any) { setError(e.message || String(e)); }
  };

  // Pay a USD fee in `token` into the discussion escrow, then run `finalize`.
  const payAndCall = async (
    kind: 'thread' | 'comment',
    finalize: () => Promise<any>,
  ) => {
    if (!actor || !identity || !explorerInfo) return;
    setError(null);
    const ledger = tokenLedger(token, explorerInfo);
    if (!ledger) { setError('Token ledger unavailable.'); return; }
    setBusy(kind);
    try {
      const quoteRes = kind === 'thread'
        ? await actor.get_thread_quote(token)
        : await actor.get_comment_quote(token);
      if (quoteRes.__kind__ === 'Err') throw new Error(quoteRes.Err);
      const quote = quoteRes.Ok;
      const fee = tokenFee(token, explorerInfo);
      const deposit = quote.amount + fee;
      const acct = await actor.get_discussion_deposit_address();
      const ledgerActor = createLedgerActor(ledger.toString(), { agentOptions: { host, identity, rootKey } });
      const xfer = await ledgerActor.icrc1_transfer({
        to: { owner: acct.owner, subaccount: acct.subaccount ? acct.subaccount : undefined },
        amount: deposit,
      });
      if (xfer.__kind__ === 'Err') {
        throw new Error(`Payment failed: ${JSON.stringify(xfer.Err, (_k, v) => typeof v === 'bigint' ? v.toString() : v)}`);
      }
      const res = await finalize();
      if (res && res.__kind__ === 'Err') throw new Error(res.Err);
      return res;
    } catch (e: any) {
      setError(e.message || String(e));
      throw e;
    } finally {
      setBusy(null);
    }
  };

  const doStartThread = async () => {
    if (!title.trim() || !body.trim()) { setError('Add a title and your take.'); return; }
    try {
      await payAndCall('thread', () => actor.start_thread(proposalId, title.trim(), body.trim(), token));
      setTitle(''); setBody('');
      await refreshList();
      setView('list');
    } catch { /* error shown */ }
  };

  const doAddComment = async () => {
    if (!active || !commentBody.trim()) return;
    try {
      await payAndCall('comment', () => actor.add_comment(active.id, replyTo, commentBody.trim(), token));
      setCommentBody(''); setReplyTo(null);
      await refreshDetail(active.id);
    } catch { /* error shown */ }
  };

  const voteThread = async (id: bigint, dir: VoteDir) => {
    if (!signedIn) { onSignIn(); return; }
    try { const r = await actor.vote_thread(id, dir); if (r.__kind__ === 'Err') throw new Error(r.Err);
      if (view === 'detail') await refreshDetail(id); else await refreshList();
    } catch (e: any) { setError(e.message || String(e)); }
  };
  const voteComment = async (id: bigint, dir: VoteDir) => {
    if (!signedIn) { onSignIn(); return; }
    try { const r = await actor.vote_comment(id, dir); if (r.__kind__ === 'Err') throw new Error(r.Err);
      if (active) await refreshDetail(active.id);
    } catch (e: any) { setError(e.message || String(e)); }
  };

  const removeThread = async (id: bigint) => {
    try { const r = await actor.admin_remove_thread(id); if (r.__kind__ === 'Err') throw new Error(r.Err);
      await refreshList(); setView('list');
    } catch (e: any) { setError(e.message || String(e)); }
  };

  const shareThread = (t: Thread) => {
    const text = `💬 Discussion on NNS proposal #${proposalId} "${proposalTitle}": "${t.title}" — ${t.upvote_count} ▲. Join in 👇`;
    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(proposalUrl)}`, '_blank', 'noopener');
  };

  const openDetail = async (t: Thread) => { setView('detail'); setError(null); await refreshDetail(t.id); };

  const Vote = ({ up, down, mine, onUp, onDown }: { up: bigint; down: bigint; mine?: VoteDir; onUp: () => void; onDown: () => void }) => (
    <span className="col" style={{ alignItems: 'center', gap: 1, minWidth: 34 }}>
      <button onClick={onUp} title="Upvote" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: mine === VoteDir.Up ? 'var(--sprout-ink)' : 'var(--fg-3)' }}>
        <Icon name="arrowUp" size={15} stroke="currentColor" />
      </button>
      {(() => { const s = score(up, down); return (
        <b className="mono" style={{ fontSize: 12, color: s < 0n ? 'var(--ember)' : s > 0n ? 'var(--sprout-ink)' : 'var(--fg-2)' }}>{s.toString()}</b>
      ); })()}
      <button onClick={onDown} title="Downvote" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, transform: 'rotate(180deg)', color: mine === VoteDir.Down ? 'var(--ember)' : 'var(--fg-3)' }}>
        <Icon name="arrowUp" size={15} stroke="currentColor" />
      </button>
    </span>
  );

  const feeRow = (label: string) => (
    <div className="col" style={{ gap: 8 }}>
      <label style={LABEL}>{label} · pay with</label>
      <span className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
        {TOKENS.map(({ t, label: l }) => (
          <button key={l} onClick={() => setToken(t)} style={{
            background: token === t ? 'color-mix(in srgb, var(--burn) 14%, transparent)' : 'transparent',
            border: `1px solid ${token === t ? 'var(--burn)' : 'var(--border)'}`,
            color: token === t ? 'var(--burn-ink)' : 'var(--fg-3)',
            borderRadius: 999, padding: '5px 10px', fontSize: 11.5, fontWeight: 500, cursor: 'pointer',
          }}>{l}</button>
        ))}
      </span>
    </div>
  );

  return (
    <>
      {!hideButton && (
        <button onClick={() => signedIn || count > 0n ? openModal() : onSignIn()} title="Discuss this proposal" style={{
          background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-3)',
          display: 'inline-flex', alignItems: 'center', gap: 4, padding: 0, fontSize: 11,
        }}>
          <Icon name="list" size={12} /> {count > 0n ? `Discuss (${count})` : 'Start a conversation'}
        </button>
      )}

      {open && (
        <div style={OVERLAY} onClick={() => !busy && setOpen(false)}>
          <div className="card col" style={CARD} onClick={e => e.stopPropagation()}>
            {/* header */}
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="row" style={{ gap: 8, minWidth: 0 }}>
                {view !== 'list' && (
                  <Btn variant="ghost" sm onClick={() => { setView('list'); setError(null); }}><Icon name="chevLeft" size={13} /> Back</Btn>
                )}
                <b style={{ fontSize: 14, overflowWrap: 'anywhere' }}>Discussion · #{proposalId.toString()}</b>
              </span>
              <Btn variant="ghost" sm onClick={() => !busy && setOpen(false)}><Icon name="x" size={14} /></Btn>
            </div>

            {error && <span style={{ fontSize: 12, color: 'var(--ember)' }}>{error}</span>}

            {view === 'list' && (
              <div className="col" style={{ gap: 12 }}>
                <Btn variant="primary" onClick={() => signedIn ? (setView('compose'), setError(null)) : onSignIn()}>
                  <Icon name="flame" size={13} stroke="var(--char-950)" /> {signedIn ? 'Start a conversation ($1)' : 'Sign in to start a conversation'}
                </Btn>
                {threads.length === 0 ? (
                  <div style={{ padding: '16px 0', color: 'var(--fg-3)', fontSize: 13, textAlign: 'center' }}>No conversations yet — start one.</div>
                ) : threads.map(t => (
                  <div key={t.id.toString()} className="row card" style={{ gap: 10, alignItems: 'flex-start', padding: 12 }}>
                    <Vote up={t.upvote_count} down={t.downvote_count} mine={t.my_vote} onUp={() => voteThread(t.id, VoteDir.Up)} onDown={() => voteThread(t.id, VoteDir.Down)} />
                    <div className="col" style={{ gap: 4, flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => openDetail(t)}>
                      <b style={{ fontSize: 13.5, overflowWrap: 'anywhere' }}>{t.title}</b>
                      <span style={{ fontSize: 12, color: 'var(--fg-2)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{t.body}</span>
                      <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>{t.comment_count.toString()} comments</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {view === 'compose' && (
              <div className="col" style={{ gap: 12 }}>
                <div className="col" style={{ gap: 6 }}>
                  <label style={LABEL}>Title · {title.length}/100</label>
                  <input className="burn-input" maxLength={100} value={title} onChange={e => { setTitle(e.target.value); setError(null); }} placeholder="A short headline for your take" />
                </div>
                <div className="col" style={{ gap: 6 }}>
                  <label style={LABEL}>Your take · {body.length}/1000</label>
                  <textarea className="burn-input" rows={5} maxLength={1000} value={body} onChange={e => { setBody(e.target.value); setError(null); }} placeholder="Why is this proposal good or bad for the IC?" />
                </div>
                {feeRow('$1 to start')}
                <Btn variant="primary" disabled={busy !== null} onClick={doStartThread}>
                  {busy === 'thread' ? <LiveDot size={7} /> : <Icon name="flame" size={14} stroke="var(--char-950)" />} Pay $1 in {tlabel(token)} &amp; post
                </Btn>
              </div>
            )}

            {view === 'detail' && active && (
              <div className="col" style={{ gap: 12 }}>
                <div className="row card" style={{ gap: 10, alignItems: 'flex-start', padding: 12 }}>
                  <Vote up={active.upvote_count} down={active.downvote_count} mine={active.my_vote} onUp={() => voteThread(active.id, VoteDir.Up)} onDown={() => voteThread(active.id, VoteDir.Down)} />
                  <div className="col" style={{ gap: 6, flex: 1, minWidth: 0 }}>
                    <b style={{ fontSize: 15, overflowWrap: 'anywhere' }}>{active.title}</b>
                    <span style={{ fontSize: 13, color: 'var(--fg-1)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{active.body}</span>
                    <span className="row" style={{ gap: 10, marginTop: 2 }}>
                      <button onClick={() => shareThread(active)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--burn-ink)', fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 4, padding: 0 }}>
                        <Icon name="share" size={12} stroke="var(--burn-ink)" /> Share on X
                      </button>
                      {isAdmin && (
                        <button onClick={() => removeThread(active.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ember)', fontSize: 11.5, padding: 0 }}>Remove</button>
                      )}
                    </span>
                  </div>
                </div>

                {/* comment composer */}
                {signedIn ? (
                  <div className="col" style={{ gap: 6 }}>
                    {replyTo !== null && <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>Replying… <button onClick={() => setReplyTo(null)} style={{ background: 'none', border: 'none', color: 'var(--burn-ink)', cursor: 'pointer' }}>cancel</button></span>}
                    <textarea className="burn-input" rows={2} maxLength={1000} value={commentBody} onChange={e => setCommentBody(e.target.value)} placeholder="Add a comment ($0.25)…" />
                    {feeRow('$0.25 to comment')}
                    <Btn variant="secondary" sm disabled={busy !== null || !commentBody.trim()} onClick={doAddComment}>
                      {busy === 'comment' ? <LiveDot size={7} /> : <Icon name="flame" size={12} />} Pay $0.25 in {tlabel(token)} &amp; comment
                    </Btn>
                  </div>
                ) : (
                  <Btn variant="secondary" sm onClick={onSignIn}>Sign in to comment</Btn>
                )}

                {/* comments (top-level + one-level replies) */}
                {comments.filter(c => c.parent_id === undefined).map(c => (
                  <div key={c.id.toString()} className="col" style={{ gap: 6 }}>
                    <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                      <Vote up={c.upvote_count} down={c.downvote_count} mine={c.my_vote} onUp={() => voteComment(c.id, VoteDir.Up)} onDown={() => voteComment(c.id, VoteDir.Down)} />
                      <div className="col" style={{ gap: 2, flex: 1, minWidth: 0 }}>
                        <span style={{ fontSize: 12.5, color: 'var(--fg-1)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{c.body}</span>
                        {signedIn && <button onClick={() => { setReplyTo(c.id); }} style={{ background: 'none', border: 'none', color: 'var(--burn-ink)', cursor: 'pointer', fontSize: 11, padding: 0, textAlign: 'left' }}>Reply</button>}
                      </div>
                    </div>
                    {comments.filter(r => r.parent_id !== undefined && r.parent_id === c.id).map(r => (
                      <div key={r.id.toString()} className="row" style={{ gap: 8, alignItems: 'flex-start', marginLeft: 28 }}>
                        <Vote up={r.upvote_count} down={r.downvote_count} mine={r.my_vote} onUp={() => voteComment(r.id, VoteDir.Up)} onDown={() => voteComment(r.id, VoteDir.Down)} />
                        <span style={{ fontSize: 12.5, color: 'var(--fg-1)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', flex: 1 }}>{r.body}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
