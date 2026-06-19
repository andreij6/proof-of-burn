import { useEffect, useState } from 'react';
import { Principal } from "@icp-sdk/core/principal";
import { VoteDir } from "./bindings/backend";
import type { ExplorerInfo, Thread, Proposal } from "./bindings/backend";
import { Icon, Eyebrow, Btn, LiveDot, usePageDevControls } from "./ui";
import Discussions from "./Discussions";

// ==========================================
// Discussions page — every open discussion, sectioned by proposal.
// A single (hidden) Discussions modal is reparameterized per click to start a
// thread or open one to its detail.
// ==========================================

interface Props {
  actor: any;
  identity: any;
  principal: Principal | null;
  host: string;
  rootKey?: Uint8Array;
  explorerInfo: ExplorerInfo | null;
  isAdmin: boolean;
  isLocal: boolean;
  proposals: Proposal[];
  proposalUrl: (id: bigint) => string;
  onSignIn: () => void;
}

export default function DiscussionsPage({
  actor, identity, principal, host, rootKey, explorerInfo, isAdmin, isLocal, proposals, proposalUrl, onSignIn,
}: Props) {
  const signedIn = !!(principal && !principal.isAnonymous());
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<{ id: bigint; title: string; url: string; threadId: bigint | null } | null>(null);
  const [nonce, setNonce] = useState(0);
  const [devBusy, setDevBusy] = useState<string | null>(null);

  const refresh = async () => {
    try { setThreads(await actor.list_all_threads()); } catch { /* noop */ } finally { setLoading(false); }
  };
  useEffect(() => { if (actor) refresh(); /* eslint-disable-next-line */ }, [actor]);

  const propTitle = (id: bigint) => proposals.find(p => p.id === id)?.title ?? `Proposal #${id}`;

  // Group threads by proposal (preserving the score order from the backend).
  const order: bigint[] = [];
  const groups = new Map<string, Thread[]>();
  for (const t of threads) {
    const k = t.proposal_id.toString();
    if (!groups.has(k)) { groups.set(k, []); order.push(t.proposal_id); }
    groups.get(k)!.push(t);
  }

  const openModal = (proposalId: bigint, threadId: bigint | null) => {
    if (!signedIn && threadId === null) { onSignIn(); return; }
    setTarget({ id: proposalId, title: propTitle(proposalId), url: proposalUrl(proposalId), threadId });
    setNonce(n => n + 1);
  };

  const vote = async (id: bigint, dir: VoteDir) => {
    if (!signedIn) { onSignIn(); return; }
    try { const r = await actor.vote_thread(id, dir); if (r.__kind__ === 'Err') throw new Error(r.Err); await refresh(); }
    catch { /* noop */ }
  };

  // Live proposals you could start a fresh discussion on (open/met).
  const liveProposals = proposals.filter(p => p.status === 'open' || p.status === 'met');

  usePageDevControls(isLocal && signedIn, () => (
    <div className="col" style={{ gap: 8 }}>
      <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-2)' }}>Discussions · mock data</span>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <Btn variant="secondary" sm disabled={devBusy !== null} onClick={async () => {
          setDevBusy('seed');
          try {
            const targets = liveProposals.slice(0, 5);
            if (targets.length === 0) { alert('No open proposals to seed.'); return; }
            for (const p of targets) {
              const r = await actor.dev_seed_threads(p.id, 2n, 3n);
              if (r.__kind__ === 'Err') { alert(r.Err); break; }
            }
            await refresh();
          } catch (e: any) { alert(e.message || String(e)); } finally { setDevBusy(null); }
        }}>
          {devBusy === 'seed' ? <LiveDot size={7} /> : <Icon name="spark" size={13} />} Seed mock discussions
        </Btn>
        <Btn variant="secondary" sm disabled={devBusy !== null} onClick={async () => {
          setDevBusy('clear');
          try { const r = await actor.dev_clear_threads(); if (r.__kind__ === 'Err') { alert(r.Err); return; } await refresh(); }
          catch (e: any) { alert(e.message || String(e)); } finally { setDevBusy(null); }
        }}>
          {devBusy === 'clear' ? <LiveDot size={7} /> : <Icon name="x" size={13} />} Clear discussions
        </Btn>
      </div>
      <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>
        Seeds 2 threads × 3 comments on up to 5 open proposals (no fee). Clear wipes all threads/comments/votes.
      </span>
    </div>
  ), [isLocal, signedIn, devBusy, liveProposals.length]);

  return (
    <div className="idea-board-container">
      <div className="col" style={{ gap: 6 }}>
        <Eyebrow accent>Community</Eyebrow>
        <span className="row" style={{ gap: 10 }}>
          <Icon name="list" size={22} stroke="var(--burn-ink)" />
          <h4 style={{ margin: 0 }}>Discussions</h4>
        </span>
        <p style={{ fontSize: 13, color: 'var(--fg-2)', maxWidth: 640, lineHeight: 1.55 }}>
          Open conversations on live proposals — start one for $1, weigh in for $0.25,
          and up/down-vote the takes. Start a quality conversation and you earn{' '}
          <b>1 lottery ticket for every upvote it gets</b> (
          <a href="#/lottery/staking" style={{ color: 'var(--burn-ink)', textDecoration: 'underline' }}>while you're staked</a>
          ).{' '}
          <b>Fees paid in ICP are burned 100%</b>.
        </p>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--fg-3)' }}>
          <LiveDot size={10} color="var(--burn-ink)" style={{ margin: '0 auto 12px' }} /> Loading discussions…
        </div>
      ) : order.length === 0 ? (
        <div className="col" style={{ alignItems: 'center', gap: 10, padding: '48px 0', color: 'var(--fg-3)' }}>
          <Icon name="list" size={28} stroke="var(--fg-dim)" />
          <span style={{ fontSize: 13 }}>No open discussions yet. Start one from a proposal on the Voting page.</span>
        </div>
      ) : (
        order.map(pid => {
          const ts = groups.get(pid.toString())!;
          return (
            <div key={pid.toString()} className="col" style={{ gap: 10 }}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', borderBottom: '1px solid var(--border)', paddingBottom: 6 }}>
                <span className="row" style={{ gap: 8, alignItems: 'baseline', minWidth: 0 }}>
                  <a href={proposalUrl(pid)} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: 11.5, color: 'var(--burn-ink)', textDecoration: 'underline' }}>#{pid.toString()}</a>
                  <b style={{ fontSize: 14, color: 'var(--fg)', overflowWrap: 'anywhere' }}>{propTitle(pid)}</b>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>· {ts.length} thread{ts.length === 1 ? '' : 's'}</span>
                </span>
                <Btn variant="ghost" sm onClick={() => openModal(pid, null)}><Icon name="flame" size={12} /> Start a conversation</Btn>
              </div>
              {ts.map(t => (
                <div key={t.id.toString()} className="row card" style={{ gap: 10, alignItems: 'flex-start', padding: 12 }}>
                  <span className="col" style={{ alignItems: 'center', gap: 1, minWidth: 34 }}>
                    <button onClick={() => vote(t.id, VoteDir.Up)} title="Upvote" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: t.my_vote === VoteDir.Up ? 'var(--sprout-ink)' : 'var(--fg-3)' }}>
                      <Icon name="arrowUp" size={15} stroke="currentColor" />
                    </button>
                    <b className="mono" style={{ fontSize: 12 }}>{(t.upvote_count - t.downvote_count).toString()}</b>
                    <button onClick={() => vote(t.id, VoteDir.Down)} title="Downvote" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, transform: 'rotate(180deg)', color: t.my_vote === VoteDir.Down ? 'var(--ember)' : 'var(--fg-3)' }}>
                      <Icon name="arrowUp" size={15} stroke="currentColor" />
                    </button>
                  </span>
                  <div className="col" style={{ gap: 4, flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => openModal(pid, t.id)}>
                    <b style={{ fontSize: 13.5, overflowWrap: 'anywhere' }}>{t.title}</b>
                    <span style={{ fontSize: 12, color: 'var(--fg-2)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{t.body}</span>
                    <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>{t.comment_count.toString()} comments · tap to open</span>
                  </div>
                </div>
              ))}
            </div>
          );
        })
      )}

      {/* One modal, reparameterized per click. */}
      <Discussions
        actor={actor} identity={identity} principal={principal} host={host} rootKey={rootKey}
        explorerInfo={explorerInfo} isAdmin={isAdmin}
        proposalId={target?.id ?? 0n} proposalTitle={target?.title ?? ''} proposalUrl={target?.url ?? ''}
        onSignIn={onSignIn} hideButton openNonce={nonce} openThreadId={target?.threadId ?? null}
        onActivity={refresh}
      />
    </div>
  );
}
