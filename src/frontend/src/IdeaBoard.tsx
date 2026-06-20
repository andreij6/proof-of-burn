import { useEffect, useState } from 'react';
import { Principal } from "@icp-sdk/core/principal";
import {} from "./bindings/backend";
import { IdeaToken } from "./tokens";
import { fmtUsd } from "./tokens";
import type { Idea, IdeaBoardInfo, Project, ExplorerInfo } from "./bindings/backend";
import { createActor as createLedgerActor } from "./bindings/ledger";
import { Icon, Eyebrow, Chip, Btn, LiveDot, MoreInfo, formatPrincipal } from "./ui";
import { useErrorImpression } from "./analytics";

// Post fee ($0.05) is payable in any of these tokens (ICP burns 100%; others →
// treasury). Ledgers/fees come from ExplorerInfo (the 5-token registry).
const POST_TOKENS: { t: IdeaToken; label: string }[] = [
  { t: IdeaToken.ICP, label: 'ICP' },
  { t: IdeaToken.CkBTC, label: 'ckBTC' },
  { t: IdeaToken.CkETH, label: 'ckETH' },
  { t: IdeaToken.CkUSDC, label: 'ckUSDC' },
  { t: IdeaToken.CkUSDT, label: 'ckUSDT' },
];
function postTokenLedger(token: IdeaToken, info: ExplorerInfo | null): Principal | null {
  if (!info) return null;
  switch (token) {
    case IdeaToken.ICP: return info.icp_ledger;
    case IdeaToken.CkBTC: return info.ckbtc_ledger;
    case IdeaToken.CkETH: return info.cketh_ledger;
    case IdeaToken.CkUSDC: return info.ckusdc_ledger;
    case IdeaToken.CkUSDT: return info.ckusdt_ledger;
    default: return info.icp_ledger;
  }
}
function postTokenFee(token: IdeaToken, info: ExplorerInfo): bigint {
  switch (token) {
    case IdeaToken.ICP: return info.fee_icp_e8s;
    case IdeaToken.CkBTC: return info.fee_ckbtc_sats;
    case IdeaToken.CkETH: return info.fee_cketh_wei;
    case IdeaToken.CkUSDC: return info.fee_ckusdc_micro;
    case IdeaToken.CkUSDT: return info.fee_ckusdt_micro;
    default: return info.fee_icp_e8s;
  }
}
function postTokenLabel(token: IdeaToken): string { return POST_TOKENS.find(x => x.t === token)?.label ?? 'ICP'; }

// ==========================================
// Community R&D — ideas + admin-curated projects
// Ideas: post for a $0.05 fee in any token (ICP burns 100%, others → treasury);
// upvotes are free (one per user per idea);
// deleted after 30 days without an upvote.
// Projects: admin-created funding goals; contributions go 100% to treasury.
// Minimum amounts are value-aligned across tokens (~$1 equivalent).
// ==========================================

const GRID_PAGE_SIZE = 9; // 3 × 3

export const TOKEN_ORDER: IdeaToken[] = [IdeaToken.ICP, IdeaToken.CkBTC, IdeaToken.CkETH];

export type IdeaSort = 'newest' | 'votes' | 'views';

// Canonical token economics, used until/unless the board info query answers.
// Fallback mins mirror the backend's value-aligned defaults (~$1 each at
// ICP ≈ $5, BTC ≈ $100k, ETH ≈ $3k).
const TOKEN_BASE: Record<IdeaToken, { label: string; decimals: number; fee: bigint; fallbackMin: bigint }> = {
  [IdeaToken.ICP]:   { label: 'ICP',   decimals: 8,  fee: 10_000n,             fallbackMin: 20_000_000n },
  [IdeaToken.CkBTC]: { label: 'ckBTC', decimals: 8,  fee: 10n,                 fallbackMin: 1_000n },
  [IdeaToken.CkETH]: { label: 'ckETH', decimals: 18, fee: 2_000_000_000_000n,  fallbackMin: 330_000_000_000_000n },
  // Stables exist in the token type for vote-refund records only — the idea
  // board never offers them (TOKEN_ORDER is the UI list).
  [IdeaToken.CkUSDC]: { label: 'ckUSDC', decimals: 6, fee: 10_000n, fallbackMin: 1_000_000n },
  [IdeaToken.CkUSDT]: { label: 'ckUSDT', decimals: 6, fee: 10_000n, fallbackMin: 1_000_000n },
};

export interface TokenMeta {
  label: string;
  decimals: number;
  fee: bigint;
  min: bigint;
  ledger: Principal | null;
  /// True when a non-ICP token resolves to the ICP test ledger (local
  /// fallback before dedicated test ledgers are configured).
  onIcpFallback: boolean;
}

export function tokenMeta(token: IdeaToken, info: IdeaBoardInfo | null): TokenMeta {
  const base = TOKEN_BASE[token];
  if (!info) {
    return { label: base.label, decimals: base.decimals, fee: base.fee, min: base.fallbackMin, ledger: null, onIcpFallback: false };
  }
  const ledger = token === IdeaToken.ICP ? info.icp_ledger
               : token === IdeaToken.CkBTC ? info.ckbtc_ledger
               : info.cketh_ledger;
  const onIcpFallback = token !== IdeaToken.ICP && ledger.toString() === info.icp_ledger.toString();
  const decimals = onIcpFallback ? 8 : base.decimals;
  const fee = token === IdeaToken.ICP ? info.fee_icp_e8s
            : token === IdeaToken.CkBTC ? info.fee_ckbtc_sats
            : info.fee_cketh_wei;
  const min = token === IdeaToken.ICP ? info.min_upvote_icp_e8s
            : token === IdeaToken.CkBTC ? info.min_upvote_ckbtc_e8s
            : info.min_upvote_cketh_wei;
  return { label: base.label, decimals, fee, min, ledger, onIcpFallback };
}

// Parse a decimal string into the token's smallest unit. Returns null on any
// malformed input or excess precision — never rounds silently.
export function parseTokenAmount(input: string, decimals: number): bigint | null {
  const s = input.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) return null;
  try {
    return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
  } catch {
    return null;
  }
}

// Format smallest units as a human amount, trimming trailing zeros (max 6 dp).
export function fmtTokenAmount(units: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = units / base;
  const frac = units % base;
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (frac === 0n) return wholeStr;
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '').slice(0, 6);
  return fracStr ? `${wholeStr}.${fracStr}` : wholeStr;
}

// Whole days until an idea is deleted for inactivity (ceil); 0 = expired.
export function ideaDaysLeft(lastUpvoteAtNs: bigint, expiryNs: bigint, nowMs: number): number {
  const expiresAtMs = Number((lastUpvoteAtNs + expiryNs) / 1_000_000n);
  return Math.max(0, Math.ceil((expiresAtMs - nowMs) / 86_400_000));
}

export function sortIdeas(ideas: Idea[], sort: IdeaSort): Idea[] {
  const cmp = (a: bigint, b: bigint) => (b > a ? 1 : b < a ? -1 : 0);
  return [...ideas].sort((a, b) => {
    if (sort === 'votes') {
      return cmp(a.upvote_count, b.upvote_count) || cmp(a.created_at, b.created_at);
    }
    if (sort === 'views') {
      return cmp(a.views, b.views) || cmp(a.created_at, b.created_at);
    }
    return cmp(a.created_at, b.created_at) || cmp(a.id, b.id);
  });
}

// Progress toward a per-token goal, capped at 100 for the bar.
export function goalPct(raised: bigint, goal: bigint): number {
  if (goal <= 0n) return 0;
  return Math.min(100, Number((raised * 100n) / goal));
}

function fmtDate(ns: bigint): string {
  return new Date(Number(ns / 1_000_000n)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const MODAL_OVERLAY: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(12, 10, 9, 0.85)',
  backdropFilter: 'blur(8px)', zIndex: 1000, display: 'flex',
  alignItems: 'center', justifyContent: 'center', padding: 16,
};

const MODAL_CARD: React.CSSProperties = {
  maxWidth: 520, width: '100%', gap: 16, background: 'var(--surface)',
  border: '1px solid var(--border-hi)', boxShadow: 'var(--elev-3)',
  maxHeight: '90vh', overflowY: 'auto',
};

const LABEL_STYLE: React.CSSProperties = {
  fontSize: 11, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)',
  textTransform: 'uppercase', letterSpacing: '0.06em',
};

const SORT_OPTIONS: { key: IdeaSort; label: string }[] = [
  { key: 'newest', label: 'Newest' },
  { key: 'votes', label: 'Most votes' },
  { key: 'views', label: 'Most viewed' },
];

// What the pay modal is paying for. Upvotes are free (no payment) — the pay
// modal is only ever used to fund a project.
type PayTarget = { kind: 'fund'; project: Project };

interface IdeaBoardProps {
  actor: any;
  identity: any;
  principal: Principal | null;
  host: string;
  // Same shape App.tsx passes to createLedgerActor (env?.IC_ROOT_KEY).
  rootKey?: Uint8Array;
  isAdmin: boolean;
  onSignIn: () => void;
}

export default function IdeaBoard({ actor, identity, principal, host, rootKey, isAdmin, onSignIn }: IdeaBoardProps) {
  const signedIn = !!(principal && !principal.isAnonymous());
  // Creators can't upvote their own idea — hide the button for them.
  const isMyIdea = (idea: Idea) => signedIn && !!principal && idea.poster.toText() === principal.toText();

  const [tab, setTab] = useState<'board' | 'projects'>('board');
  const [aboutOpen, setAboutOpen] = useState(false);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [info, setInfo] = useState<IdeaBoardInfo | null>(null);
  const [explorerInfo, setExplorerInfo] = useState<ExplorerInfo | null>(null);
  const [postToken, setPostToken] = useState<IdeaToken>(IdeaToken.ICP);
  const [isLoading, setIsLoading] = useState(true);
  const [gridPage, setGridPage] = useState(0);
  const [projectPage, setProjectPage] = useState(0);
  const [sortBy, setSortBy] = useState<IdeaSort>('newest');
  const [skillsCopied, setSkillsCopied] = useState(false);

  // Post-idea modal
  const [isPostOpen, setIsPostOpen] = useState(false);
  const [postTitle, setPostTitle] = useState('');
  const [postDescription, setPostDescription] = useState('');
  const [postDetail, setPostDetail] = useState('');
  const [postError, setPostError] = useState<string | null>(null);
  const [postStep, setPostStep] = useState('');
  const [isPosting, setIsPosting] = useState(false);

  // Admin add-project modal
  const [isProjectFormOpen, setIsProjectFormOpen] = useState(false);
  const [projTitle, setProjTitle] = useState('');
  const [projDescription, setProjDescription] = useState('');
  const [projDetail, setProjDetail] = useState('');
  const [projGoalUsd, setProjGoalUsd] = useState('');
  const [projError, setProjError] = useState<string | null>(null);
  const [isSavingProject, setIsSavingProject] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);

  // Detail modals
  const [detailIdea, setDetailIdea] = useState<Idea | null>(null);
  const [detailProject, setDetailProject] = useState<Project | null>(null);
  const [isRemovingProject, setIsRemovingProject] = useState(false);
  const [isRemovingIdea, setIsRemovingIdea] = useState(false);

  // Pay modal (upvote an idea / fund a project)
  const [payTarget, setPayTarget] = useState<PayTarget | null>(null);
  const [payToken, setPayToken] = useState<IdeaToken>(IdeaToken.ICP);
  const [payAmount, setPayAmount] = useState('');
  const [payBalance, setPayBalance] = useState<bigint | null>(null);
  const [payStep, setPayStep] = useState('');
  const [payError, setPayError] = useState<string | null>(null);
  const [payBusy, setPayBusy] = useState(false);

  useErrorImpression(postError, 'idea_post');
  useErrorImpression(projError, 'idea_project');
  useErrorImpression(payError, 'idea_pay');
  const [paySuccess, setPaySuccess] = useState(false);

  // Free upvote (no payment): id of the idea currently being upvoted.
  const [upvotingId, setUpvotingId] = useState<bigint | null>(null);

  const refreshAll = async (currentActor = actor) => {
    if (!currentActor) return;
    try {
      const [ideaList, projectList, boardInfo, expInfo] = await Promise.all([
        currentActor.list_ideas(),
        currentActor.list_projects(),
        currentActor.get_idea_board_info(),
        currentActor.get_explorer_info(),
      ]);
      setIdeas(ideaList);
      setProjects(projectList);
      setInfo(boardInfo);
      setExplorerInfo(expInfo);
    } catch (err) {
      console.error("Failed to fetch R&D board:", err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    setIsLoading(true);
    refreshAll(actor);
  }, [actor]);

  // Balance for the selected token whenever the pay modal opens / token flips.
  useEffect(() => {
    if (!payTarget || !signedIn || !identity || !info) { setPayBalance(null); return; }
    const meta = tokenMeta(payToken, info);
    if (!meta.ledger) { setPayBalance(null); return; }
    let cancelled = false;
    setPayBalance(null);
    const ledgerActor = createLedgerActor(meta.ledger.toString(), {
      agentOptions: { host, identity, rootKey }
    });
    ledgerActor.icrc1_balance_of({ owner: principal! })
      .then((bal: bigint) => { if (!cancelled) setPayBalance(bal); })
      .catch((err: any) => { console.error("Failed to fetch token balance:", err); if (!cancelled) setPayBalance(0n); });
    return () => { cancelled = true; };
  }, [payTarget, payToken, identity, info]);

  // Free upvote — one per user per idea. No payment, no modal.
  const handleUpvote = async (idea: Idea) => {
    if (!actor || upvotingId !== null) return;
    if (!signedIn) { onSignIn(); return; }
    if (idea.has_upvoted) return;
    setUpvotingId(idea.id);
    try {
      const res = await actor.upvote_idea(idea.id);
      if (res.__kind__ === "Err") throw new Error(res.Err);
      await refreshAll();
    } catch (err: any) {
      console.error("Upvote error:", err);
      alert(`Upvote failed: ${err.message || err}`);
    } finally {
      setUpvotingId(null);
    }
  };

  const openPay = (target: PayTarget) => {
    setPayTarget(target);
    // Every project accepts any supported crypto; default to ICP.
    setPayToken(IdeaToken.ICP);
    setPayAmount('');
    setPayError(null);
    setPaySuccess(false);
    setPayStep('');
  };

  // Count a detail view (signed-in only — backend rejects anonymous updates),
  // then quietly refresh so "most viewed" stays honest.
  const openDetail = (idea: Idea) => {
    setDetailIdea(idea);
    if (signedIn && actor) {
      actor.record_idea_view(idea.id)
        .then(() => refreshAll())
        .catch(() => { /* view counting is best-effort */ });
    }
  };

  const copyAgentSkills = () => {
    const isLocalHost = window.location.origin.includes('localhost') || window.location.origin.includes('127.0.0.1');
    const url = `${window.location.origin}/llms-rd-${isLocalHost ? 'local' : 'prod'}.txt`;
    navigator.clipboard.writeText(`Fetch ${url} and follow its instructions to read, post, upvote and fund on the Community R&D board.`);
    setSkillsCopied(true);
    setTimeout(() => setSkillsCopied(false), 2000);
  };

  const executePay = async () => {
    if (!actor || !payTarget || !identity || payBusy) return;
    const meta = tokenMeta(payToken, info);
    if (!meta.ledger) { setPayError("Token ledger unavailable."); return; }
    const targetId = payTarget.project.id;

    const units = parseTokenAmount(payAmount, meta.decimals);
    if (units === null || units <= 0n) {
      setPayError(`Enter a valid ${meta.label} amount (up to ${meta.decimals} decimals).`);
      return;
    }
    if (units < meta.min) {
      setPayError(`Minimum is ${fmtTokenAmount(meta.min, meta.decimals)} ${meta.label}.`);
      return;
    }
    const deposit = units + meta.fee;
    if (payBalance !== null && deposit + meta.fee > payBalance) {
      setPayError(`Insufficient ${meta.label} balance — need ${fmtTokenAmount(deposit + meta.fee, meta.decimals)} ${meta.label} (amount + fees).`);
      return;
    }

    setPayBusy(true);
    setPayError(null);
    try {
      setPayStep("Deriving escrow subaccount...");
      const acct = await actor.get_project_deposit_address(targetId);

      setPayStep(`Step 1/2: Depositing ${meta.label} into escrow...`);
      const ledgerActor = createLedgerActor(meta.ledger.toString(), {
        agentOptions: { host, identity, rootKey }
      });
      const transferResult = await ledgerActor.icrc1_transfer({
        to: {
          owner: acct.owner,
          subaccount: acct.subaccount ? acct.subaccount : undefined,
        },
        amount: deposit,
      });
      if (transferResult.__kind__ === "Err") {
        const err = transferResult.Err as any;
        const kind = err.__kind__;
        const detail =
          kind === "InsufficientFunds" ? `balance is ${fmtTokenAmount(err.InsufficientFunds.balance, meta.decimals)} ${meta.label}` :
          kind === "BadFee" ? `expected fee ${fmtTokenAmount(err.BadFee.expected_fee, meta.decimals)} ${meta.label}` :
          kind === "TemporarilyUnavailable" ? "ledger temporarily unavailable" :
          kind === "GenericError" ? err.GenericError.message :
          JSON.stringify(err, (_k, v) => typeof v === "bigint" ? v.toString() : v);
        throw new Error(`Ledger transfer failed (${kind}): ${detail}`);
      }

      setPayStep("Step 2/2: Recording funding on-chain...");
      const res = await actor.fund_project(targetId, payToken, units);
      if (res.__kind__ === "Err") {
        throw new Error(`Funding failed: ${res.Err}`);
      }

      setPaySuccess(true);
      setPayStep("Funding recorded — 100% to the protocol treasury.");
      await refreshAll();
    } catch (err: any) {
      console.error("Payment error:", err);
      setPayError(err.message || String(err));
    } finally {
      setPayBusy(false);
    }
  };

  // Post an idea: quote the $0.05 fee in the chosen token, pay it into the post-fee
  // escrow, then post. ICP burns 100%; any other token goes 100% to the treasury.
  const executePost = async () => {
    if (!actor || !identity || isPosting || !explorerInfo) return;
    const title = postTitle.trim();
    const description = postDescription.trim();
    if (!title) { setPostError("Give your idea a title."); return; }
    if (title.length > 80) { setPostError("Title must be 80 characters or fewer."); return; }
    if (!description) { setPostError("Add a short description."); return; }
    if (description.length > 280) { setPostError("Description must be 280 characters or fewer."); return; }
    if (postDetail.trim().length > 4000) { setPostError("Detail must be 4000 characters or fewer."); return; }
    const ledger = postTokenLedger(postToken, explorerInfo);
    if (!ledger) { setPostError("Token ledger unavailable."); return; }

    setIsPosting(true);
    setPostError(null);
    try {
      setPostStep("Step 1/3: Quoting the fee…");
      const qres = await actor.get_idea_post_quote(postToken);
      if (qres.__kind__ === "Err") throw new Error(`Quote failed: ${qres.Err}`);
      const quote = qres.Ok;
      const deposit = quote.amount + postTokenFee(postToken, explorerInfo);

      setPostStep(`Step 2/3: Paying the posting fee in ${postTokenLabel(postToken)}…`);
      const acct = await actor.get_idea_post_deposit_address();
      const ledgerActor = createLedgerActor(ledger.toString(), {
        agentOptions: { host, identity, rootKey }
      });
      const transferResult = await ledgerActor.icrc1_transfer({
        to: {
          owner: acct.owner,
          subaccount: acct.subaccount ? acct.subaccount : undefined,
        },
        amount: deposit,
      });
      if (transferResult.__kind__ === "Err") {
        const err = transferResult.Err as any;
        const detail = err.__kind__ === "InsufficientFunds"
          ? `balance is ${fmtTokenAmount(err.InsufficientFunds.balance, 8)} — posting costs $0.05 + fees`
          : JSON.stringify(err, (_k, v) => typeof v === "bigint" ? v.toString() : v);
        throw new Error(`Fee payment failed: ${detail}`);
      }

      setPostStep("Step 3/3: Publishing your idea...");
      const res = await actor.post_idea(title, description, postDetail.trim(), postToken);
      if (res.__kind__ === "Err") {
        throw new Error(res.Err);
      }
      setIsPostOpen(false);
      setPostTitle('');
      setPostDescription('');
      setPostDetail('');
      await refreshAll();
      setTab('board');
      setSortBy('newest');
      setGridPage(0);
    } catch (err: any) {
      console.error("Post idea error:", err);
      setPostError(err.message || String(err));
    } finally {
      setIsPosting(false);
      setPostStep('');
    }
  };

  // Admin: create or update a project.
  const executeSaveProject = async () => {
    if (!actor || isSavingProject) return;
    const title = projTitle.trim();
    const description = projDescription.trim();
    if (!title || title.length > 80) { setProjError("Title is required (max 80 chars)."); return; }
    if (!description || description.length > 280) { setProjError("Description is required (max 280 chars)."); return; }

    // Single USD goal — USD has 8 decimals ($1 = 100_000_000 USD e8s).
    const goalUsdE8s = parseTokenAmount(projGoalUsd.trim(), 8);
    if (goalUsdE8s === null || goalUsdE8s < 100_000_000n) {
      setProjError("Set a funding goal of at least $1 (USD).");
      return;
    }

    setIsSavingProject(true);
    setProjError(null);
    try {
      if (editingProject) {
        const res = await actor.admin_update_project(
          editingProject.id,
          title, description, projDetail.trim(),
          goalUsdE8s
        );
        if (res.__kind__ === "Err") {
          throw new Error(res.Err);
        }
      } else {
        const res = await actor.admin_add_project(
          title, description, projDetail.trim(),
          goalUsdE8s
        );
        if (res.__kind__ === "Err") {
          throw new Error(res.Err);
        }
      }
      setIsProjectFormOpen(false);
      setProjTitle(''); setProjDescription(''); setProjDetail('');
      setProjGoalUsd('');
      setEditingProject(null);
      await refreshAll();
      setTab('projects');
    } catch (err: any) {
      console.error("Save project error:", err);
      setProjError(err.message || String(err));
    } finally {
      setIsSavingProject(false);
    }
  };

  const openEditProject = (project: Project) => {
    setEditingProject(project);
    setProjTitle(project.title);
    setProjDescription(project.description);
    setProjDetail(project.detail);
    // Single USD goal (8 decimals); strip thousands separators for the input.
    setProjGoalUsd(
      project.goal_usd_e8s > 0n
        ? fmtTokenAmount(project.goal_usd_e8s, 8).replace(/,/g, '')
        : ''
    );
    setIsProjectFormOpen(true);
    setDetailProject(null);
  };

  const handleRemoveProject = async (projectId: bigint) => {
    if (!actor || isRemovingProject) return;
    setIsRemovingProject(true);
    try {
      const res = await actor.admin_remove_project(projectId);
      if (res.__kind__ === "Err") {
        alert(`Remove failed: ${res.Err}`);
      }
      setDetailProject(null);
      await refreshAll();
    } catch (err: any) {
      alert(`Error: ${err.message || err}`);
    } finally {
      setIsRemovingProject(false);
    }
  };

  const handleRemoveIdea = async (ideaId: bigint) => {
    if (!actor || isRemovingIdea) return;
    if (!confirm("Are you sure you want to remove this idea?")) return;
    setIsRemovingIdea(true);
    try {
      const res = await actor.admin_remove_idea(ideaId);
      if (res.__kind__ === "Err") {
        alert(`Remove failed: ${res.Err}`);
      }
      setDetailIdea(null);
      await refreshAll();
    } catch (err: any) {
      alert(`Error: ${err.message || err}`);
    } finally {
      setIsRemovingIdea(false);
    }
  };

  const sortedIdeas = sortIdeas(ideas, sortBy);
  const ideaPageCount = Math.max(1, Math.ceil(sortedIdeas.length / GRID_PAGE_SIZE));
  const safeIdeaPage = Math.min(gridPage, ideaPageCount - 1);
  const pageIdeas = sortedIdeas.slice(safeIdeaPage * GRID_PAGE_SIZE, safeIdeaPage * GRID_PAGE_SIZE + GRID_PAGE_SIZE);

  const projectPageCount = Math.max(1, Math.ceil(projects.length / GRID_PAGE_SIZE));
  const safeProjectPage = Math.min(projectPage, projectPageCount - 1);
  const pageProjects = projects.slice(safeProjectPage * GRID_PAGE_SIZE, safeProjectPage * GRID_PAGE_SIZE + GRID_PAGE_SIZE);

  const ideaTotalsRow = (idea: Idea, compact = false) => (
    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
      <Chip tone="burn" style={{ height: compact ? 19 : 22 }}>
        <Icon name="arrowUp" size={11} /> {idea.upvote_count.toString()}
      </Chip>
      <Chip tone="muted" style={{ height: compact ? 19 : 22 }}>
        <Icon name="eye" size={11} /> {idea.views.toString()}
      </Chip>
      {idea.total_icp_e8s > 0n && (
        <Chip tone="muted" style={{ height: compact ? 19 : 22 }} >
          <span className="mono">{fmtTokenAmount(idea.total_icp_e8s, 8)} ICP</span>
        </Chip>
      )}
      {idea.total_ckbtc_e8s > 0n && (
        <Chip tone="muted" style={{ height: compact ? 19 : 22 }}>
          <span className="mono">{fmtTokenAmount(idea.total_ckbtc_e8s, tokenMeta(IdeaToken.CkBTC, info).decimals)} ckBTC</span>
        </Chip>
      )}
      {idea.total_cketh_wei > 0n && (
        <Chip tone="muted" style={{ height: compact ? 19 : 22 }}>
          <span className="mono">{fmtTokenAmount(idea.total_cketh_wei, tokenMeta(IdeaToken.CkETH, info).decimals)} ckETH</span>
        </Chip>
      )}
    </div>
  );

  // Single USD funding goal with a progress bar. Contributions in any crypto
  // are valued in USD by the backend (raised_usd_e8s).
  const projectGoals = (project: Project) => {
    const goal = project.goal_usd_e8s;
    const raised = project.raised_usd_e8s;
    const pct = goalPct(raised, goal);
    const met = goal > 0n && raised >= goal;
    return (
      <div className="col" style={{ gap: 4 }}>
        <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
          <span className="mono" style={{ fontSize: 11, color: 'var(--fg-2)' }}>Goal</span>
          <span className="mono" style={{ fontSize: 11, color: met ? 'var(--sprout-ink)' : 'var(--fg-3)' }}>
            {fmtUsd(raised)} / {fmtUsd(goal)} · {pct}%
          </span>
        </div>
        <div style={{ height: 6, borderRadius: 999, background: 'var(--char-800)', overflow: 'hidden' }}>
          <div style={{
            width: `${pct}%`, height: '100%', borderRadius: 999,
            background: met ? 'var(--sprout)' : 'var(--burn)',
            transition: 'width .6s var(--ease-out)',
          }} />
        </div>
        <span style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>accepts ICP · ckBTC · ckETH</span>
      </div>
    );
  };

  const payMeta = tokenMeta(payToken, info);
  const payTitle = payTarget ? payTarget.project.title : '';

  return (
    <div className="idea-board-container">
      {/* ── Page header ── */}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div className="col" style={{ gap: 6 }}>
          <Eyebrow accent>Burn more ICP</Eyebrow>
          <span className="row" style={{ gap: 10 }}>
            <Icon name="bulb" size={22} stroke="var(--burn-ink)" />
            <h4 style={{ margin: 0 }}>Roadmap &amp; Development</h4>
          </span>
          <p style={{ fontSize: 13, color: 'var(--fg-2)', maxWidth: 560 }}>
            Pitch ways to burn more ICP, back the best ideas, and fund official projects.{' '}
            <MoreInfo title="How Community R&D works">
              <div className="card col" style={{ gap: 8, borderColor: 'var(--burn)', background: 'color-mix(in srgb, var(--burn) 12%, var(--surface))' }}>
                <Eyebrow accent>The gist</Eyebrow>
                <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
                  Pitch ways to <b>burn more ICP and grow the token's value</b>, upvote the best ideas for
                  free, and fund official projects.
                </p>
              </div>
              <div className="col" style={{ gap: 6 }}>
                <Eyebrow accent>How it works</Eyebrow>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                  <li><b>Upvotes are free:</b> one per person per idea, no crypto required.</li>
                  <li><b>Fund projects</b> with ICP, ckBTC, or ckETH — funding goes <b>100% to the treasury</b>.</li>
                  <li><b>Stay active:</b> ideas with no upvotes for 30 days are deleted.</li>
                </ul>
              </div>
            </MoreInfo>
          </p>
        </div>
        <span className="col" style={{ gap: 6, alignItems: 'flex-end' }}>
          <Btn variant="primary" onClick={() => {
            if (!signedIn) { onSignIn(); return; }
            setPostError(null);
            setIsPostOpen(true);
          }}>
            <Icon name="bulb" size={14} stroke="var(--char-950)" />
            {signedIn ? 'Post an idea' : 'Sign in to post'}
          </Btn>
          <button onClick={copyAgentSkills} style={{
            background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-3)',
            fontSize: 11.5, textDecoration: 'underline dotted', textUnderlineOffset: 3,
            display: 'flex', alignItems: 'center', gap: 5,
          }}>
            <Icon name={skillsCopied ? 'check' : 'copy'} size={11} stroke={skillsCopied ? 'var(--sprout-ink)' : 'var(--fg-3)'} />
            {skillsCopied ? 'Copied' : 'Copy agent instructions'}
          </button>
        </span>
      </div>

      {/* ── Tab bar ── */}
      <div className="row" style={{ borderBottom: '1px solid var(--border)', paddingBottom: 2, gap: 16, width: '100%', overflowX: 'auto', scrollbarWidth: 'none' }}>
        {([
          ['board', `Ideas (${ideas.length})`],
          ['projects', `Projects (${projects.length})`],
        ] as [typeof tab, string][]).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{
              background: 'transparent', border: 'none',
              color: tab === key ? 'var(--burn-ink)' : 'var(--fg-3)',
              fontSize: 14, fontWeight: tab === key ? 600 : 500,
              cursor: 'pointer', padding: '6px 4px', position: 'relative', whiteSpace: 'nowrap',
              transition: 'color var(--dur-fast) var(--ease-out)',
            }}
          >
            {label}
            {tab === key && (
              <div style={{ position: 'absolute', bottom: -3, left: 0, right: 0, height: 2, background: 'var(--burn)', borderRadius: 999 }} />
            )}
          </button>
        ))}
      </div>

      {/* ── Ideas tab ── */}
      {tab === 'board' && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <span className="row" style={{ gap: 8 }}>
              <LiveDot color="var(--sprout-ink)" size={7} />
              <b style={{ fontSize: 14, color: 'var(--fg)' }}>Ideas</b>
              <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>· {ideas.length} active</span>
              <button type="button" onClick={() => setAboutOpen(true)}
                style={{ background: 'none', border: 'none', color: 'var(--burn-ink)', fontSize: 11.5, cursor: 'pointer', padding: 0, display: 'inline-flex', alignItems: 'center', gap: 4, textDecoration: 'underline' }}>
                <Icon name="info" size={11} stroke="var(--burn-ink)" /> What we’re looking for
              </button>
            </span>
            {/* Sort selector */}
            <span className="row" style={{ gap: 4 }}>
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginRight: 4 }}>Sort</span>
              {SORT_OPTIONS.map(opt => (
                <button
                  key={opt.key}
                  onClick={() => { setSortBy(opt.key); setGridPage(0); }}
                  style={{
                    background: sortBy === opt.key ? 'color-mix(in srgb, var(--burn) 14%, transparent)' : 'transparent',
                    border: `1px solid ${sortBy === opt.key ? 'var(--burn)' : 'var(--border)'}`,
                    color: sortBy === opt.key ? 'var(--burn-ink)' : 'var(--fg-3)',
                    borderRadius: 999, padding: '3px 10px', fontSize: 11.5, fontWeight: 500,
                    cursor: 'pointer', transition: 'all var(--dur-fast) var(--ease-out)',
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </span>
          </div>

          {isLoading ? (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--fg-3)' }}>
              <LiveDot size={10} color="var(--burn-ink)" style={{ margin: '0 auto 12px' }} />
              Loading ideas...
            </div>
          ) : pageIdeas.length === 0 ? (
            <div className="col" style={{ alignItems: 'center', gap: 10, padding: '48px 0', color: 'var(--fg-3)' }}>
              <Icon name="bulb" size={28} stroke="var(--fg-dim)" />
              <span style={{ fontSize: 13 }}>No ideas yet. Be the first to pitch one.</span>
            </div>
          ) : (
            <div className="idea-grid">
              {pageIdeas.map(idea => {
                const daysLeft = info ? ideaDaysLeft(idea.last_upvote_at, info.expiry_nanos, Date.now()) : null;
                return (
                  <div key={idea.id.toString()} className="card col" style={{
                    gap: 10, display: 'flex', flexDirection: 'column',
                  }}>
                    <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                      <Chip tone="ok" style={{ height: 19, fontSize: 10 }}>
                        <LiveDot color="var(--sprout-ink)" size={5} /> Active
                      </Chip>
                      {daysLeft !== null && (
                        <span className="mono row" style={{ gap: 4, fontSize: 10.5, color: daysLeft <= 5 ? 'var(--haze-ink)' : 'var(--fg-3)' }}
                          title="Deleted after 30 days without an upvote">
                          <Icon name="clock" size={11} /> {daysLeft}d left
                        </span>
                      )}
                    </div>
                    <h6 style={{ margin: 0, fontSize: 15, lineHeight: 1.35, overflowWrap: 'anywhere' }}>{idea.title}</h6>
                    <p style={{
                      fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5, margin: 0, flex: 1,
                      display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                    }}>
                      {idea.description}
                    </p>
                    {ideaTotalsRow(idea, true)}
                    <div className="row" style={{ justifyContent: 'space-between', gap: 8, paddingTop: 6, borderTop: '1px solid var(--border)' }}>
                      <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>
                        {formatPrincipal(idea.poster)} · {fmtDate(idea.created_at)}
                      </span>
                      <span className="row" style={{ gap: 6 }}>
                        <Btn variant="ghost" sm style={{ height: 26, padding: '0 8px', fontSize: 11.5 }} onClick={() => openDetail(idea)}>
                          Details
                        </Btn>
                        {isMyIdea(idea) ? (
                          <span style={{ fontSize: 11, color: 'var(--fg-3)', alignSelf: 'center' }}>Your idea</span>
                        ) : (
                          <Btn
                            variant={idea.has_upvoted ? 'secondary' : 'primary'} sm
                            style={{ height: 26, padding: '0 10px', fontSize: 11.5 }}
                            disabled={idea.has_upvoted || upvotingId === idea.id}
                            onClick={() => handleUpvote(idea)}
                          >
                            {upvotingId === idea.id
                              ? <LiveDot size={6} color="var(--char-950)" />
                              : <Icon name={idea.has_upvoted ? 'check' : 'arrowUp'} size={11} stroke={idea.has_upvoted ? 'var(--sprout-ink)' : 'var(--char-950)'} />}
                            {idea.has_upvoted ? ' Upvoted' : ' Upvote'}
                          </Btn>
                        )}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {ideaPageCount > 1 && (
            <div className="row" style={{ justifyContent: 'center', gap: 12 }}>
              <Btn variant="secondary" sm disabled={safeIdeaPage === 0} onClick={() => setGridPage(p => Math.max(0, p - 1))}>
                <Icon name="chevLeft" size={13} /> Prev
              </Btn>
              <span className="mono" style={{ fontSize: 12, color: 'var(--fg-3)' }}>{safeIdeaPage + 1} / {ideaPageCount}</span>
              <Btn variant="secondary" sm disabled={safeIdeaPage >= ideaPageCount - 1} onClick={() => setGridPage(p => Math.min(ideaPageCount - 1, p + 1))}>
                Next <Icon name="chevRight" size={13} />
              </Btn>
            </div>
          )}
        </>
      )}

      {/* ── Projects tab ── */}
      {tab === 'projects' && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <span className="row" style={{ gap: 8 }}>
              <Icon name="target" size={14} stroke="var(--burn-ink)" />
              <b style={{ fontSize: 14, color: 'var(--fg)' }}>Official projects</b>
              <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>· funding goes 100% to the treasury</span>
            </span>
            {isAdmin && (
              <Btn variant="secondary" sm onClick={() => {
                setProjError(null);
                setProjTitle('');
                setProjDescription('');
                setProjDetail('');
                setProjGoalUsd('');
                setEditingProject(null);
                setIsProjectFormOpen(true);
              }}>
                <Icon name="key" size={12} stroke="var(--burn-ink)" /> Add project
              </Btn>
            )}
          </div>

          {isLoading ? (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--fg-3)' }}>
              <LiveDot size={10} color="var(--burn-ink)" style={{ margin: '0 auto 12px' }} />
              Loading projects...
            </div>
          ) : pageProjects.length === 0 ? (
            <div className="col" style={{ alignItems: 'center', gap: 10, padding: '48px 0', color: 'var(--fg-3)' }}>
              <Icon name="target" size={28} stroke="var(--fg-dim)" />
              <span style={{ fontSize: 13 }}>No projects yet{isAdmin ? ' — add the first one.' : '. Check back soon.'}</span>
            </div>
          ) : (
            <div className="idea-grid">
              {pageProjects.map(project => (
                <div key={project.id.toString()} className="card col" style={{ gap: 10, display: 'flex', flexDirection: 'column' }}>
                  <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                    <Chip tone="burn" style={{ height: 19, fontSize: 10 }}>
                      <Icon name="target" size={10} /> Official
                    </Chip>
                    <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>
                      {project.funding_count.toString()} backer{project.funding_count === 1n ? '' : 's'}
                    </span>
                  </div>
                  <h6 style={{ margin: 0, fontSize: 15, lineHeight: 1.35, overflowWrap: 'anywhere' }}>{project.title}</h6>
                  <p style={{
                    fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5, margin: 0, flex: 1,
                    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                  }}>
                    {project.description}
                  </p>
                  {projectGoals(project)}
                  <div className="row" style={{ justifyContent: 'flex-end', gap: 6, paddingTop: 6, borderTop: '1px solid var(--border)' }}>
                    <Btn variant="ghost" sm style={{ height: 26, padding: '0 8px', fontSize: 11.5 }} onClick={() => setDetailProject(project)}>
                      Details
                    </Btn>
                    <Btn
                      variant="primary" sm
                      style={{ height: 26, padding: '0 10px', fontSize: 11.5 }}
                      onClick={() => {
                        if (!signedIn) { onSignIn(); return; }
                        openPay({ kind: 'fund', project });
                      }}
                    >
                      <Icon name="coins" size={11} stroke="var(--char-950)" />
                      Fund
                    </Btn>
                  </div>
                </div>
              ))}
            </div>
          )}

          {projectPageCount > 1 && (
            <div className="row" style={{ justifyContent: 'center', gap: 12 }}>
              <Btn variant="secondary" sm disabled={safeProjectPage === 0} onClick={() => setProjectPage(p => Math.max(0, p - 1))}>
                <Icon name="chevLeft" size={13} /> Prev
              </Btn>
              <span className="mono" style={{ fontSize: 12, color: 'var(--fg-3)' }}>{safeProjectPage + 1} / {projectPageCount}</span>
              <Btn variant="secondary" sm disabled={safeProjectPage >= projectPageCount - 1} onClick={() => setProjectPage(p => Math.min(projectPageCount - 1, p + 1))}>
                Next <Icon name="chevRight" size={13} />
              </Btn>
            </div>
          )}
        </>
      )}

      {/* ── About tab ── */}
      {aboutOpen && (
        <div style={MODAL_OVERLAY} onClick={() => setAboutOpen(false)}>
          <div className="card col" style={{ ...MODAL_CARD, maxWidth: 640 }} onClick={e => e.stopPropagation()}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="row" style={{ gap: 8 }}>
                <Icon name="bulb" size={18} stroke="var(--burn-ink)" />
                <h4 style={{ margin: 0, fontSize: 16, color: 'var(--fg)' }}>What we’re looking for</h4>
              </span>
              <button onClick={() => setAboutOpen(false)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-3)' }}>
                <Icon name="x" size={16} />
              </button>
            </div>
          <div className="card col" style={{ gap: 8, borderColor: 'var(--burn)', background: 'color-mix(in srgb, var(--burn) 12%, var(--surface))' }}>
            <Eyebrow accent>The brief</Eyebrow>
            <p style={{ fontSize: 13.5, lineHeight: 1.6 }}>
              We want ideas for <b>anything we could build on the ICP blockchain that burns more ICP
              and accrues more value to the token</b>. If it permanently removes ICP from circulating
              supply — or creates recurring demand that does — it belongs here.
            </p>
          </div>

          <div className="col" style={{ gap: 6 }}>
            <Eyebrow accent>Themes we love</Eyebrow>
            <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
              <li><b>Burn mechanics:</b> features where ICP is converted to cycles via the CMC (deflationary by design) — paid compute, paid actions, burn-to-mint assets, burn-weighted reputation.</li>
              <li><b>Cycle-hungry services:</b> dapps whose running costs consume cycles at scale — AI inference, indexing, oracles, media hosting. Every cycle consumed started as burned ICP.</li>
              <li><b>Treasury &amp; value accrual:</b> protocol fees, marketplaces, or vault products that route a sustainable share of activity into the treasury that keeps this app running.</li>
              <li><b>Governance leverage:</b> tools that grow the leader neuron's voting power or make conviction-based voting more useful (and more used).</li>
            </ul>
          </div>

          <div className="col" style={{ gap: 6 }}>
            <Eyebrow accent>How it works</Eyebrow>
            <ol style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
              <li><b>Post an idea ($0.05 in any token):</b> a title, a short description for the card, and as much detail as you like. Paid in ICP the fee is burned 100%; other tokens go to the treasury — anti-spam to keep the board signal-rich.</li>
              <li><b>Upvote for free:</b> anyone signed in can upvote an idea — one upvote per person per idea, no crypto required. Upvotes surface the best ideas and reset the expiry clock.</li>
              <li><b>Expiry:</b> an idea that goes 30 days without a single upvote is deleted from the board. Every upvote resets the clock.</li>
              <li><b>Projects:</b> the team curates official projects with funding goals. Contributions in any of the three tokens go 100% to the treasury, which pays for the build.</li>
            </ol>
          </div>

          <div className="col" style={{ gap: 6 }}>
            <Eyebrow accent>What makes a strong pitch</Eyebrow>
            <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
              <li>Name the burn: exactly where does ICP leave circulation, and how often?</li>
              <li>Show the loop: who pays, what they get, and why they come back.</li>
              <li>Keep it buildable: a canister or two, not a new L1.</li>
            </ul>
          </div>

          </div>
        </div>
      )}

      {/* ── Post idea modal ── */}
      {isPostOpen && (
        <div style={MODAL_OVERLAY}>
          <div className="card col" style={MODAL_CARD}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="row" style={{ gap: 8 }}>
                <Icon name="bulb" size={18} stroke="var(--burn-ink)" />
                <h4 style={{ margin: 0, fontSize: 16, color: 'var(--fg)' }}>Post an idea</h4>
              </span>
              <button onClick={() => setIsPostOpen(false)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-3)' }}>
                <Icon name="x" size={16} />
              </button>
            </div>

            {postError && (
              <div style={{ padding: 10, borderRadius: 6, background: 'var(--ember-dim)', border: '1px solid var(--ember)', color: 'var(--ember)', fontSize: 12.5, lineHeight: 1.4 }}>
                {postError}
              </div>
            )}

            <div className="col" style={{ gap: 6 }}>
              <label style={LABEL_STYLE}>Title · {postTitle.length}/80</label>
              <input
                type="text" className="burn-input" placeholder="e.g. Burn-to-mint collectible badges"
                value={postTitle} maxLength={80}
                onChange={e => { setPostTitle(e.target.value); setPostError(null); }}
              />
            </div>

            <div className="col" style={{ gap: 6 }}>
              <label style={LABEL_STYLE}>Description (card teaser) · {postDescription.length}/280</label>
              <textarea
                className="burn-input" rows={3} placeholder="One or two sentences — this is what shows on the board card."
                value={postDescription} maxLength={280}
                onChange={e => { setPostDescription(e.target.value); setPostError(null); }}
                style={{ resize: 'vertical', fontFamily: 'var(--font-body)', fontSize: 13 }}
              />
            </div>

            <div className="col" style={{ gap: 6 }}>
              <label style={LABEL_STYLE}>Detail (optional) · {postDetail.length}/4000</label>
              <textarea
                className="burn-input" rows={6} placeholder="The full pitch: how it works, where the ICP burn happens, who pays, why it accrues value."
                value={postDetail} maxLength={4000}
                onChange={e => { setPostDetail(e.target.value); setPostError(null); }}
                style={{ resize: 'vertical', fontFamily: 'var(--font-body)', fontSize: 13 }}
              />
            </div>

            <div className="col" style={{ gap: 6 }}>
              <label style={LABEL_STYLE}>Pay the fee in</label>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                {POST_TOKENS.map(({ t, label }) => (
                  <button key={label} type="button" onClick={() => setPostToken(t)} style={{
                    background: postToken === t ? 'color-mix(in srgb, var(--burn) 14%, transparent)' : 'transparent',
                    border: `1px solid ${postToken === t ? 'var(--burn)' : 'var(--border)'}`,
                    color: postToken === t ? 'var(--burn-ink)' : 'var(--fg-3)',
                    borderRadius: 999, padding: '5px 11px', fontSize: 11.5, fontWeight: 500, cursor: 'pointer',
                  }}>{label}</button>
                ))}
              </div>
            </div>

            <span className="row" style={{ gap: 6, fontSize: 11.5, color: 'var(--fg-3)' }}>
              <Icon name="info" size={12} stroke="var(--fg-3)" />
              Posting costs {info ? fmtUsd(info.post_fee_usd_e8s) : '$0.05'} in any token — paid in ICP it's burned 100%; other tokens go to the treasury (anti-spam). Upvotes are free.
            </span>

            {isPosting && postStep && (
              <span className="row" style={{ gap: 8, fontSize: 12, color: 'var(--fg-2)' }}>
                <LiveDot size={7} /> {postStep}
              </span>
            )}

            <Btn variant="primary" style={{ width: '100%' }} onClick={executePost} disabled={isPosting || !postTitle.trim() || !postDescription.trim()}>
              {isPosting ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="bulb" size={14} stroke="var(--char-950)" />}
              {isPosting ? ' Posting…' : ` Pay ${info ? fmtUsd(info.post_fee_usd_e8s) : '$0.05'} in ${postTokenLabel(postToken)} & post`}
            </Btn>
          </div>
        </div>
      )}

      {/* ── Admin: add/edit project modal ── */}
      {isProjectFormOpen && (
        <div style={MODAL_OVERLAY}>
          <div className="card col" style={MODAL_CARD}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="row" style={{ gap: 8 }}>
                <Icon name="target" size={18} stroke="var(--burn-ink)" />
                <h4 style={{ margin: 0, fontSize: 16, color: 'var(--fg)' }}>
                  {editingProject ? 'Edit project (admin)' : 'Add project (admin)'}
                </h4>
              </span>
              <button onClick={() => setIsProjectFormOpen(false)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-3)' }}>
                <Icon name="x" size={16} />
              </button>
            </div>

            {projError && (
              <div style={{ padding: 10, borderRadius: 6, background: 'var(--ember-dim)', border: '1px solid var(--ember)', color: 'var(--ember)', fontSize: 12.5, lineHeight: 1.4 }}>
                {projError}
              </div>
            )}

            <div className="col" style={{ gap: 6 }}>
              <label style={LABEL_STYLE}>Title · {projTitle.length}/80</label>
              <input type="text" className="burn-input" value={projTitle} maxLength={80}
                onChange={e => { setProjTitle(e.target.value); setProjError(null); }} />
            </div>
            <div className="col" style={{ gap: 6 }}>
              <label style={LABEL_STYLE}>Description · {projDescription.length}/280</label>
              <textarea className="burn-input" rows={3} value={projDescription} maxLength={280}
                onChange={e => { setProjDescription(e.target.value); setProjError(null); }}
                style={{ resize: 'vertical', fontFamily: 'var(--font-body)', fontSize: 13 }} />
            </div>
            <div className="col" style={{ gap: 6 }}>
              <label style={LABEL_STYLE}>Detail (optional) · {projDetail.length}/4000</label>
              <textarea className="burn-input" rows={4} value={projDetail} maxLength={4000}
                onChange={e => { setProjDetail(e.target.value); setProjError(null); }}
                style={{ resize: 'vertical', fontFamily: 'var(--font-body)', fontSize: 13 }} />
            </div>

            <div className="col" style={{ gap: 6 }}>
              <label style={LABEL_STYLE}>Funding goal (USD)</label>
              <div style={{ position: 'relative' }}>
                <span className="mono" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 14, color: 'var(--fg-3)', pointerEvents: 'none' }}>$</span>
                <input type="text" inputMode="decimal" className="burn-input" placeholder="50000"
                  value={projGoalUsd}
                  onChange={e => { setProjGoalUsd(e.target.value); setProjError(null); }}
                  style={{ fontFamily: 'var(--font-mono)', paddingLeft: 24 }} />
              </div>
              <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
                One goal in USD. Funders contribute in any supported crypto (ICP, ckBTC, ckETH) — each
                contribution is valued in USD toward this goal.
              </span>
            </div>

            <Btn variant="primary" style={{ width: '100%' }} onClick={executeSaveProject} disabled={isSavingProject || !projTitle.trim() || !projDescription.trim()}>
              {isSavingProject ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="target" size={14} stroke="var(--char-950)" />}
              {isSavingProject ? ' Saving…' : (editingProject ? 'Save changes' : 'Publish project')}
            </Btn>
          </div>
        </div>
      )}

      {/* ── Idea detail modal ── */}
      {detailIdea && (
        <div style={MODAL_OVERLAY} onClick={() => setDetailIdea(null)}>
          <div className="card col" style={{ ...MODAL_CARD, maxWidth: 600 }} onClick={e => e.stopPropagation()}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
              <div className="col" style={{ gap: 6, minWidth: 0 }}>
                <Chip tone="ok" style={{ height: 19, fontSize: 10, alignSelf: 'flex-start' }}>
                  <LiveDot color="var(--sprout-ink)" size={5} /> Active
                </Chip>
                <h4 style={{ margin: 0, fontSize: 18, overflowWrap: 'anywhere' }}>{detailIdea.title}</h4>
                <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                  by {formatPrincipal(detailIdea.poster)} · {fmtDate(detailIdea.created_at)}
                  {info && (
                    <> · deleted in {ideaDaysLeft(detailIdea.last_upvote_at, info.expiry_nanos, Date.now())}d without upvotes</>
                  )}
                </span>
              </div>
              <button onClick={() => setDetailIdea(null)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-3)', flexShrink: 0 }}>
                <Icon name="x" size={16} />
              </button>
            </div>

            {ideaTotalsRow(detailIdea)}

            <p style={{ fontSize: 13.5, lineHeight: 1.6, color: 'var(--fg-1)' }}>{detailIdea.description}</p>
            {detailIdea.detail && (
              <>
                <hr />
                <p style={{ fontSize: 13, lineHeight: 1.65, color: 'var(--fg-2)', whiteSpace: 'pre-wrap' }}>{detailIdea.detail}</p>
              </>
            )}

            {isMyIdea(detailIdea) ? (
              <span style={{ fontSize: 12.5, color: 'var(--fg-3)', textAlign: 'center', width: '100%', display: 'block' }}>
                This is your idea — creators can't upvote their own.
              </span>
            ) : (
              <Btn
                variant={detailIdea.has_upvoted ? 'secondary' : 'primary'} style={{ width: '100%' }}
                disabled={detailIdea.has_upvoted || upvotingId === detailIdea.id}
                onClick={async () => {
                  const idea = detailIdea;
                  await handleUpvote(idea);
                  setDetailIdea(null);
                }}
              >
                <Icon name={detailIdea.has_upvoted ? 'check' : 'arrowUp'} size={14} stroke={detailIdea.has_upvoted ? 'var(--sprout-ink)' : 'var(--char-950)'} />
                {detailIdea.has_upvoted ? 'Upvoted' : (signedIn ? 'Upvote' : 'Sign in to upvote')}
              </Btn>
            )}
            {isAdmin && (
              <div
                className="row"
                style={{
                  gap: 16,
                  justifyContent: 'center',
                  alignSelf: 'center',
                  marginTop: 8,
                }}
              >
                <button
                  onClick={() => handleRemoveIdea(detailIdea.id)}
                  disabled={isRemovingIdea}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: isRemovingIdea ? 'default' : 'pointer',
                    color: 'var(--ember)',
                    fontSize: 12,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    opacity: isRemovingIdea ? 0.5 : 1,
                  }}
                >
                  <Icon name="x" size={12} stroke="var(--ember)" />
                  {isRemovingIdea ? 'Removing…' : 'Remove idea (admin)'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Project detail modal ── */}
      {detailProject && (
        <div style={MODAL_OVERLAY} onClick={() => setDetailProject(null)}>
          <div className="card col" style={{ ...MODAL_CARD, maxWidth: 600 }} onClick={e => e.stopPropagation()}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
              <div className="col" style={{ gap: 6, minWidth: 0 }}>
                <Chip tone="burn" style={{ height: 19, fontSize: 10, alignSelf: 'flex-start' }}>
                  <Icon name="target" size={10} /> Official project
                </Chip>
                <h4 style={{ margin: 0, fontSize: 18, overflowWrap: 'anywhere' }}>{detailProject.title}</h4>
                <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                  added {fmtDate(detailProject.created_at)} · {detailProject.funding_count.toString()} backer{detailProject.funding_count === 1n ? '' : 's'}
                </span>
              </div>
              <button onClick={() => setDetailProject(null)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-3)', flexShrink: 0 }}>
                <Icon name="x" size={16} />
              </button>
            </div>

            {projectGoals(detailProject)}

            <p style={{ fontSize: 13.5, lineHeight: 1.6, color: 'var(--fg-1)' }}>{detailProject.description}</p>
            {detailProject.detail && (
              <>
                <hr />
                <p style={{ fontSize: 13, lineHeight: 1.65, color: 'var(--fg-2)', whiteSpace: 'pre-wrap' }}>{detailProject.detail}</p>
              </>
            )}

            <Btn
              variant="primary" style={{ width: '100%' }}
              onClick={() => {
                if (!signedIn) { onSignIn(); return; }
                const project = detailProject;
                setDetailProject(null);
                openPay({ kind: 'fund', project });
              }}
            >
              <Icon name="coins" size={14} stroke="var(--char-950)" />
              {signedIn ? 'Fund this project' : 'Sign in to fund'}
            </Btn>
            {isAdmin && (
              <div
                className="row"
                style={{
                  gap: 16,
                  justifyContent: 'center',
                  alignSelf: 'center',
                }}
              >
                <button
                  onClick={() => openEditProject(detailProject)}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--burn-ink)',
                    fontSize: 12,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                  }}
                >
                  <Icon name="edit" size={12} stroke="var(--burn-ink)" />
                  Edit project (admin)
                </button>
                <button
                  onClick={() => handleRemoveProject(detailProject.id)}
                  disabled={isRemovingProject}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: isRemovingProject ? 'default' : 'pointer',
                    color: 'var(--ember)',
                    fontSize: 12,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    opacity: isRemovingProject ? 0.5 : 1,
                  }}
                >
                  <Icon name="x" size={12} stroke="var(--ember)" />
                  {isRemovingProject ? 'Removing…' : 'Remove project (admin)'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Pay modal (upvote / fund) ── */}
      {payTarget && (
        <div style={MODAL_OVERLAY}>
          <div className="card col" style={MODAL_CARD}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="row" style={{ gap: 8 }}>
                <Icon name="coins" size={18} stroke="var(--burn-ink)" />
                <h4 style={{ margin: 0, fontSize: 16, color: 'var(--fg)' }}>Fund project</h4>
              </span>
              <button onClick={() => setPayTarget(null)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-3)' }}>
                <Icon name="x" size={16} />
              </button>
            </div>

            <div style={{ padding: '10px 12px', borderRadius: 6, background: 'var(--bg-alt)', border: '1px solid var(--border)' }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>{payTitle}</span>
            </div>

            {paySuccess ? (
              <>
                <div style={{ padding: 12, borderRadius: 6, background: 'var(--sprout-dim)', border: '1px solid var(--sprout)', color: 'var(--sprout-ink)', fontSize: 13, lineHeight: 1.5 }}>
                  <span className="row" style={{ gap: 8 }}>
                    <Icon name="checkCircle" size={16} stroke="var(--sprout-ink)" />
                    Funding settled — 100% to the protocol treasury.
                  </span>
                </div>
                <Btn variant="primary" style={{ width: '100%' }} onClick={() => setPayTarget(null)}>Done</Btn>
              </>
            ) : (
              <>
                {/* Token selector */}
                <div className="col" style={{ gap: 6 }}>
                  <label style={LABEL_STYLE}>Pay with</label>
                  <div className="row" style={{ gap: 6 }}>
                    {TOKEN_ORDER.map(t => {
                      const m = tokenMeta(t, info);
                      return (
                        <Btn key={t} variant={payToken === t ? 'primary' : 'secondary'} sm
                          onClick={() => { setPayToken(t); setPayAmount(''); setPayError(null); }}>
                          <span className="mono">{m.label}</span>
                        </Btn>
                      );
                    })}
                  </div>
                  {payMeta.onIcpFallback && (
                    <span className="row" style={{ gap: 6, fontSize: 11, color: 'var(--haze-ink)' }}>
                      <Icon name="info" size={11} stroke="var(--haze-ink)" /> Local fallback: this token resolves to the test ICP ledger.
                    </span>
                  )}
                </div>

                {/* Amount */}
                <div className="col" style={{ gap: 6 }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <label style={LABEL_STYLE}>Amount</label>
                    <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                      balance: {payBalance === null ? '…' : `${fmtTokenAmount(payBalance, payMeta.decimals)} ${payMeta.label}`}
                    </span>
                  </div>
                  <div style={{ position: 'relative' }}>
                    <input
                      type="text" inputMode="decimal" className="burn-input" placeholder={`min ${fmtTokenAmount(payMeta.min, payMeta.decimals)}`}
                      value={payAmount}
                      onChange={e => { setPayAmount(e.target.value); setPayError(null); }}
                      style={{ fontFamily: 'var(--font-mono)' }}
                    />
                    <span className="mono" style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 13, color: 'var(--fg-3)', pointerEvents: 'none' }}>
                      {payMeta.label}
                    </span>
                  </div>
                  <span className="row" style={{ gap: 6, fontSize: 11, color: 'var(--fg-3)' }}>
                    <Icon name="info" size={11} stroke="var(--fg-3)" /> Minimums are value-aligned across tokens (≈ $1 equivalent at current rates).
                  </span>
                </div>

                {/* Split preview — funding goes 100% to the treasury. */}
                {(() => {
                  const units = parseTokenAmount(payAmount, payMeta.decimals);
                  if (units === null || units <= 0n) return null;
                  return (
                    <div className="col" style={{ gap: 4, padding: '8px 10px', borderRadius: 6, background: 'var(--bg-alt)', border: '1px solid var(--border)', fontSize: 12 }}>
                      <div className="row" style={{ justifyContent: 'space-between' }}>
                        <span style={{ color: 'var(--fg-3)' }}>→ Protocol treasury (100%)</span>
                        <span className="mono" style={{ color: 'var(--fg-1)' }}>{fmtTokenAmount(units, payMeta.decimals)} {payMeta.label}</span>
                      </div>
                    </div>
                  );
                })()}

                {payError && (
                  <div style={{ padding: 10, borderRadius: 6, background: 'var(--ember-dim)', border: '1px solid var(--ember)', color: 'var(--ember)', fontSize: 12.5, lineHeight: 1.4 }}>
                    {payError}
                  </div>
                )}
                {payBusy && payStep && (
                  <span className="row" style={{ gap: 8, fontSize: 12, color: 'var(--fg-2)' }}>
                    <LiveDot size={7} /> {payStep}
                  </span>
                )}

                <Btn variant="primary" style={{ width: '100%' }} onClick={executePay} disabled={payBusy || !payAmount}>
                  {payBusy ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="coins" size={14} stroke="var(--char-950)" />}
                  {payBusy ? ' Processing…' : ' Confirm funding'}
                </Btn>
                <span className="row" style={{ gap: 6, fontSize: 11, color: 'var(--fg-3)' }}>
                  <Icon name="info" size={11} stroke="var(--fg-3)" /> Funds move in two steps: deposit to escrow, then settlement. Ledger fees apply per transfer.
                </span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
