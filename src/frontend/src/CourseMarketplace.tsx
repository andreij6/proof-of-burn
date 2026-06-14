import { useEffect, useMemo, useRef, useState } from 'react';
import { Principal } from '@icp-sdk/core/principal';
import type { CourseCard, MarketplaceFilter } from './bindings/backend';
import { DifficultyFilter, ListedFilter } from './bindings/backend';
import { Icon, Eyebrow, Chip, Btn, LiveDot, MoreInfo, formatPrincipal, fmtICP } from './ui';
import { parseTokenAmount } from './IdeaBoard';
import {
  difficultyBucket, themeLabel, poolOrder, pageSlice, pageCount, freshSeed,
  DIFFICULTY_OPTIONS, LISTED_OPTIONS, THEME_OPTIONS, GRID_PAGE_SIZE,
} from './arcade/courseMarket';

// ==========================================
// Course Marketplace (PB-305) — the arcade mini-golf surface + course picker.
// Browse/filter minted courses, Play any of them (hands the token_id up to the
// arcade shell which opens a play session), and (owner-only) list / re-price /
// delist. Buy is Phase 2 (PB-307) — its button opens a "coming soon" modal.
// ==========================================

interface CourseMarketplaceProps {
  actor: any;
  principal: Principal | null;
  /** Route to the editor (PB-302). */
  onCreateCourse: () => void;
  /** Launch the engine view for a chosen course. */
  onPlay: (card: CourseCard) => void;
  onSignIn: () => void;
}

const ICP_E8S = 8;

export default function CourseMarketplace({ actor, principal, onCreateCourse, onPlay, onSignIn }: CourseMarketplaceProps) {
  const signedIn = !!(principal && !principal.isAnonymous());

  const [difficulty, setDifficulty] = useState<DifficultyFilter>(DifficultyFilter.Any);
  const [theme, setTheme] = useState<number | undefined>(undefined);
  const [listed, setListed] = useState<ListedFilter>(ListedFilter.Any);
  const [mineOnly, setMineOnly] = useState(false);

  const [courses, setCourses] = useState<CourseCard[]>([]);
  const [featuredId, setFeaturedId] = useState<bigint | undefined>(undefined);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // A fresh shuffle seed per load + per filter change (PB-305 A5).
  const seedRef = useRef<number>(freshSeed());

  // Owner manage / buy modals.
  const [manageCard, setManageCard] = useState<CourseCard | null>(null);
  const [buyCard, setBuyCard] = useState<CourseCard | null>(null);

  const filter: MarketplaceFilter = useMemo(
    () => ({ difficulty, theme, listed, mine_only: mineOnly }),
    [difficulty, theme, listed, mineOnly],
  );

  const refresh = async () => {
    if (!actor) return;
    setLoading(true);
    setError(null);
    try {
      const pageRes = await actor.list_marketplace_courses(filter);
      setCourses(pageRes.courses);
      setFeaturedId(pageRes.featured_token_id ?? undefined);
      setTotal(Number(pageRes.total));
    } catch (err: any) {
      console.error('marketplace load failed', err);
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  // Re-roll the shuffle + reset paging whenever filters change, then refetch.
  useEffect(() => {
    seedRef.current = freshSeed();
    setPage(0);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor, difficulty, theme, listed, mineOnly]);

  // Featured card (resolved from the returned pool by id) + the shuffled pool.
  const featuredCard = useMemo(
    () => (featuredId === undefined ? null : courses.find((c) => c.token_id === featuredId) ?? null),
    [courses, featuredId],
  );
  const pool = useMemo(
    () => poolOrder(courses, featuredId, seedRef.current),
    [courses, featuredId],
  );
  const pageCards = useMemo(() => pageSlice(pool, page), [pool, page]);
  const totalPages = pageCount(pool.length);

  const isEmpty = !loading && courses.length === 0;

  return (
    <div className="col" style={{ gap: 16 }}>
      {/* ── Header ── */}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div className="col" style={{ gap: 6 }}>
          <Eyebrow accent>Play &amp; earn</Eyebrow>
          <span className="row" style={{ gap: 10 }}>
            <Icon name="gamepad" size={22} stroke="var(--burn)" />
            <h4 style={{ margin: 0 }}>Course Marketplace</h4>
          </span>
          <p style={{ fontSize: 13, color: 'var(--fg-2)', maxWidth: 560, margin: 0 }}>
            Play any community-built course for fun — and earn lottery tickets when you
            finish a round. Courses are NFTs you can create, own, and sell.{' '}
            <MoreInfo title="Create → mint → list → earn → sell">
              <p>Build a 9-hole course in the editor, mint it as an NFT (0.5 ICP), and it is
              auto-listed here. Players earn a lottery ticket for completing a round; you, the
              course owner, earn a ticket each time a player reaches hole 2. Lottery tickets
              convert to ICP when the round is drawn.</p>
              <p>You can list your course for sale at any price, re-price it, or delist it
              (delisted courses stop earning owner tickets and disappear from the browser, but
              you can re-list any time at no cost). Buying courses from other players is coming
              soon.</p>
            </MoreInfo>
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {signedIn && (
            <Btn variant={mineOnly ? 'primary' : 'ghost'} sm onClick={() => setMineOnly((v) => !v)}>
              <Icon name="list" size={12} stroke={mineOnly ? 'var(--char-950)' : 'currentColor'} /> My courses
            </Btn>
          )}
          <Btn variant="primary" sm onClick={() => (signedIn ? onCreateCourse() : onSignIn())}>
            <Icon name="edit" size={12} stroke="var(--char-950)" /> {signedIn ? 'Create a course' : 'Sign in to create'}
          </Btn>
        </div>
      </div>

      {/* ── Filter bar ── */}
      <div className="row" style={{ gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <PillGroup label="Difficulty">
          {DIFFICULTY_OPTIONS.map((o) => (
            <Pill key={o.label} active={difficulty === o.value} onClick={() => setDifficulty(o.value)}>{o.label}</Pill>
          ))}
        </PillGroup>
        <PillGroup label="Theme">
          {THEME_OPTIONS.map((o) => (
            <Pill key={o.label} active={theme === o.value} onClick={() => setTheme(o.value)}>{o.label}</Pill>
          ))}
        </PillGroup>
        <PillGroup label="Listed">
          {LISTED_OPTIONS.map((o) => (
            <Pill key={o.label} active={listed === o.value} onClick={() => setListed(o.value)}>{o.label}</Pill>
          ))}
        </PillGroup>
      </div>

      {error && (
        <div className="card" style={{ borderColor: 'var(--ember)', color: 'var(--ember)', fontSize: 13 }}>
          Couldn't load the marketplace: {error}
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--fg-3)' }}>
          <LiveDot size={10} color="var(--burn)" style={{ margin: '0 auto 12px' }} />
          Loading courses…
        </div>
      ) : isEmpty ? (
        <div className="col" style={{ alignItems: 'center', gap: 12, padding: '48px 0', color: 'var(--fg-3)' }}>
          <Icon name="gamepad" size={28} stroke="var(--fg-dim)" />
          <span style={{ fontSize: 14 }}>No courses minted yet — be the first to create one.</span>
          <Btn variant="primary" onClick={() => (signedIn ? onCreateCourse() : onSignIn())}>
            <Icon name="edit" size={12} stroke="var(--char-950)" /> {signedIn ? 'Create a course' : 'Sign in to create'}
          </Btn>
        </div>
      ) : (
        <>
          {/* Featured slot (PB-308 reads only; CTA disabled until then). */}
          {featuredCard ? (
            <CourseCardView
              card={featuredCard}
              featured
              principal={principal}
              onPlay={onPlay}
              onManage={setManageCard}
              onBuy={setBuyCard}
              onSignIn={onSignIn}
            />
          ) : (
            <div className="card row" style={{
              justifyContent: 'space-between', alignItems: 'center', gap: 10,
              borderStyle: 'dashed', borderColor: 'var(--border)',
            }}>
              <span className="row" style={{ gap: 8, color: 'var(--fg-3)', fontSize: 12.5 }}>
                <Icon name="spark" size={14} stroke="var(--fg-dim)" /> Feature your course at the top of the marketplace
              </span>
              <Btn variant="ghost" sm disabled style={{ cursor: 'default' }} onClick={() => {}}>Coming soon</Btn>
            </div>
          )}

          {/* Random pool grid */}
          <div className="idea-grid">
            {pageCards.map((card) => (
              <CourseCardView
                key={card.token_id.toString()}
                card={card}
                principal={principal}
                onPlay={onPlay}
                onManage={setManageCard}
                onBuy={setBuyCard}
                onSignIn={onSignIn}
              />
            ))}
          </div>

          {totalPages > 1 && (
            <div className="row" style={{ justifyContent: 'center', gap: 12, alignItems: 'center' }}>
              <Btn variant="ghost" sm disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                <Icon name="chevLeft" size={12} /> Prev
              </Btn>
              <span className="mono" style={{ fontSize: 12, color: 'var(--fg-3)' }}>Page {page + 1} / {totalPages}</span>
              <Btn variant="ghost" sm disabled={page >= totalPages - 1} onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}>
                Next <Icon name="chevRight" size={12} />
              </Btn>
            </div>
          )}
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)', textAlign: 'center' }}>
            {total} course{total === 1 ? '' : 's'} · randomly ordered each visit · {GRID_PAGE_SIZE} per page
          </span>
        </>
      )}

      {manageCard && (
        <ManageModal
          actor={actor}
          card={manageCard}
          onClose={() => setManageCard(null)}
          onDone={() => { setManageCard(null); refresh(); }}
        />
      )}
      {buyCard && <BuyComingSoonModal card={buyCard} onClose={() => setBuyCard(null)} />}
    </div>
  );
}

// ── Course card (shared by featured + pool) ──
function CourseCardView({ card, featured, principal, onPlay, onManage, onBuy, onSignIn }: {
  card: CourseCard;
  featured?: boolean;
  principal: Principal | null;
  onPlay: (c: CourseCard) => void;
  onManage: (c: CourseCard) => void;
  onBuy: (c: CourseCard) => void;
  onSignIn: () => void;
}) {
  const signedIn = !!(principal && !principal.isAnonymous());
  const par = card.par_total;
  const diff = difficultyBucket(par);
  const forSale = card.listed && card.price_e8s > 0n;
  const ownerDiffers = card.creator && card.owner && card.creator.toString() !== card.owner.toString();

  return (
    <div className="card col" style={{ gap: 10, gridColumn: featured ? '1 / -1' : undefined }}>
      <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
        {featured ? (
          <Chip tone="burn" style={{ height: 19, fontSize: 10 }}><LiveDot color="var(--burn)" size={5} /> Featured</Chip>
        ) : forSale ? (
          <Chip tone="ok" style={{ height: 19, fontSize: 10 }}>For sale</Chip>
        ) : (
          <Chip tone="muted" style={{ height: 19, fontSize: 10 }}>Not for sale</Chip>
        )}
        <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>Par {par} · {diff}</span>
      </div>

      <span className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <h6 style={{ margin: 0, fontSize: 16 }}>{card.name || `Course #${card.token_id}`}</h6>
        <Chip tone="muted" style={{ height: 18, fontSize: 9.5 }}>{themeLabel(card.theme)}</Chip>
      </span>

      <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>
        by {formatPrincipal(card.creator ?? null)}
        {ownerDiffers && <span style={{ color: 'var(--fg-dim)' }}> · owned by {formatPrincipal(card.owner ?? null)}</span>}
      </span>

      <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <Chip tone="muted" style={{ height: 19, fontSize: 10 }}>
          <Icon name="target" size={11} /> {card.play_count.toString()} plays
        </Chip>
        {card.tickets_distributed > 0n && (
          <Chip tone="muted" style={{ height: 19, fontSize: 10 }}>{card.tickets_distributed.toString()} tickets earned</Chip>
        )}
      </span>

      <span className="mono" style={{ fontSize: 12 }}>
        {forSale ? <b>{fmtICP(card.price_e8s)} ICP</b> : <span style={{ color: 'var(--fg-3)' }}>Not for sale</span>}
      </span>

      <div className="row" style={{ justifyContent: 'flex-end', gap: 8, paddingTop: 6, borderTop: '1px solid var(--border)' }}>
        {card.is_caller_owner && (
          <Btn variant="ghost" sm onClick={() => onManage(card)}><Icon name="edit" size={11} /> Manage</Btn>
        )}
        {forSale && !card.is_caller_owner && (
          <Btn variant="secondary" sm onClick={() => onBuy(card)}>Buy</Btn>
        )}
        <Btn variant="primary" sm onClick={() => (signedIn ? onPlay(card) : onSignIn())}>
          <Icon name="flame" size={11} stroke="var(--char-950)" /> {signedIn ? 'Play' : 'Sign in to play'}
        </Btn>
      </div>
    </div>
  );
}

// ── Owner: list / re-price / delist ──
function ManageModal({ actor, card, onClose, onDone }: {
  actor: any;
  card: CourseCard;
  onClose: () => void;
  onDone: () => void;
}) {
  const [priceInput, setPriceInput] = useState(card.price_e8s > 0n ? fmtICP(card.price_e8s) : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (action: 'list' | 'delist') => {
    if (busy) return;
    setErr(null);
    if (action === 'list') {
      const e8s = parseTokenAmount(priceInput, ICP_E8S);
      if (e8s === null || e8s <= 0n) { setErr('Enter a price greater than 0 ICP.'); return; }
      setBusy(true);
      try {
        const res = await actor.list_course_for_sale(card.token_id, e8s);
        if (res.__kind__ === 'Err') throw new Error(res.Err);
        onDone();
      } catch (e: any) { setErr(e?.message || String(e)); } finally { setBusy(false); }
    } else {
      setBusy(true);
      try {
        const res = await actor.delist_course(card.token_id);
        if (res.__kind__ === 'Err') throw new Error(res.Err);
        onDone();
      } catch (e: any) { setErr(e?.message || String(e)); } finally { setBusy(false); }
    }
  };

  return (
    <ModalShell title={`Manage "${card.name || `Course #${card.token_id}`}"`} onClose={() => !busy && onClose()}>
      <div className="col" style={{ gap: 6 }}>
        <label style={{ fontSize: 11, color: 'var(--fg-3)' }}>Sale price (ICP)</label>
        <input
          className="burn-input"
          value={priceInput}
          onChange={(e) => setPriceInput(e.target.value)}
          placeholder="e.g. 2.5"
          inputMode="decimal"
        />
      </div>
      <p style={{ fontSize: 11.5, color: 'var(--fg-3)', margin: 0 }}>
        Delisted courses earn no owner tickets and disappear from the browser — you can re-list
        any time at no cost.
      </p>
      {err && <span style={{ fontSize: 12, color: 'var(--ember)' }}>{err}</span>}
      <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
        {card.listed ? (
          <Btn variant="danger" sm disabled={busy} onClick={() => submit('delist')}>Delist</Btn>
        ) : <span />}
        <div className="row" style={{ gap: 8 }}>
          <Btn variant="ghost" sm disabled={busy} onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" sm disabled={busy} onClick={() => submit('list')}>
            {busy ? 'Working…' : card.listed ? 'Update price' : 'List for sale'}
          </Btn>
        </div>
      </div>
    </ModalShell>
  );
}

function BuyComingSoonModal({ card, onClose }: { card: CourseCard; onClose: () => void }) {
  return (
    <ModalShell title={`Buy "${card.name || `Course #${card.token_id}`}"`} onClose={onClose}>
      <p style={{ fontSize: 13, color: 'var(--fg-2)', margin: 0 }}>
        This course is listed for <b className="mono">{fmtICP(card.price_e8s)} ICP</b>. The secondary
        market (buying courses from other players) is coming soon.
      </p>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <Btn variant="ghost" sm onClick={onClose}>Close</Btn>
        <Btn variant="primary" sm disabled style={{ cursor: 'default' }} onClick={() => {}}>Secondary market coming soon</Btn>
      </div>
    </ModalShell>
  );
}

// ── small UI helpers ──
function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(12, 10, 9, 0.85)', backdropFilter: 'blur(8px)',
      zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }} onClick={onClose}>
      <div className="card col" style={{
        maxWidth: 440, width: '100%', gap: 14, background: 'var(--surface)',
        border: '1px solid var(--border-hi)', boxShadow: 'var(--elev-3)',
      }} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <b>{title}</b>
          <Btn variant="ghost" sm onClick={onClose}><Icon name="x" size={14} /></Btn>
        </div>
        {children}
      </div>
    </div>
  );
}

function PillGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="col" style={{ gap: 6 }}>
      <span style={{ fontSize: 10.5, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.06em', fontFamily: 'var(--font-mono)' }}>{label}</span>
      <span className="row" style={{ gap: 4, flexWrap: 'wrap' }}>{children}</span>
    </div>
  );
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      background: active ? 'var(--burn-950)' : 'transparent',
      border: `1px solid ${active ? 'var(--burn)' : 'var(--border)'}`,
      color: active ? 'var(--burn)' : 'var(--fg-3)',
      borderRadius: 999, padding: '5px 11px', fontSize: 11.5, fontWeight: 500,
      cursor: 'pointer', transition: 'all var(--dur-fast) var(--ease-out)',
    }}>{children}</button>
  );
}
