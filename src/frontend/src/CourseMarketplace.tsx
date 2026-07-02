import { useEffect, useMemo, useRef, useState } from 'react';
import { Principal } from '@icp-sdk/core/principal';
import type { CourseCard, MarketplaceFilter, CourseRatingSummary } from './bindings/backend';
import { DifficultyFilter, ListedFilter } from './bindings/backend';
import { Icon, Eyebrow, Chip, Btn, LiveDot, MoreInfo, formatPrincipal, fmtICP, usePageDevControls } from './ui';
import { useErrorImpression } from './analytics';
import { parseTokenAmount } from './IdeaBoard';
import { makeApprover } from './minters';
import {
  difficultyBucket, mulberry32, poolOrder, pageSlice, pageCount, freshSeed,
  formatRating, toggleFavoriteId,
  courseShareUrl, DIFFICULTY_OPTIONS, LISTED_OPTIONS, GRID_PAGE_SIZE,
} from './arcade/courseMarket';

// ==========================================
// Course Marketplace (PB-305 + Phase 2/3) — the arcade mini-golf surface.
//   PB-307 buy/sell  · PB-311 favorites · PB-310 ratings
//   PB-312 local-dev panel (Dashboard & Controls).
// Browse/filter minted courses, Play any of them, list/delist/buy, favorite,
// and rate courses you've completed. Courses
// are authored by the AI course builder (users describe the course they want;
// the agent writes the NFT's build-instructions JSON) — there is no manual
// course editor.
// ==========================================

interface CourseMarketplaceProps {
  actor: any;
  principal: Principal | null;
  identity: any;
  host: string;
  rootKey?: Uint8Array;
  /** ICP ledger canister id (for buy approve). */
  ledgerCanisterId: string;
  /** Backend canister id — the spender approved for buys/bids. */
  backendCanisterId: string;
  isLocal: boolean;
  /** Launch the engine view for a chosen course. */
  onPlay: (card: CourseCard) => void;
  /** Open the spectate-only 3×3 hole grid ("View NFT") for a course. */
  onViewNft: (card: CourseCard) => void;
  /** Launch the create-a-course flow (copy AI instructions → upload → mint). */
  onCreate: () => void;
  onSignIn: () => void;
}

const ICP_E8S = 8;
const ICP_FEE_E8S = 10_000n;

export default function CourseMarketplace({
  actor, principal, identity, host, rootKey, ledgerCanisterId, backendCanisterId, isLocal,
  onPlay, onViewNft, onCreate, onSignIn,
}: CourseMarketplaceProps) {
  const signedIn = !!(principal && !principal.isAnonymous());

  const [difficulty, setDifficulty] = useState<DifficultyFilter>(DifficultyFilter.Any);
  const [listed, setListed] = useState<ListedFilter>(ListedFilter.Any);
  const [mineOnly, setMineOnly] = useState(false);
  const [onlyFavs, setOnlyFavs] = useState(false);

  const [courses, setCourses] = useState<CourseCard[]>([]);
  const [favoriteIds, setFavoriteIds] = useState<Set<bigint>>(new Set());
  const [favCards, setFavCards] = useState<CourseCard[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useErrorImpression(error, 'course_market');

  // A fresh shuffle seed per load + per filter change (PB-305 A5).
  const seedRef = useRef<number>(freshSeed());

  // Modals.
  const [manageCard, setManageCard] = useState<CourseCard | null>(null);
  const [buyCard, setBuyCard] = useState<CourseCard | null>(null);
  const [burnCard, setBurnCard] = useState<CourseCard | null>(null);

  const filter: MarketplaceFilter = useMemo(
    () => ({ difficulty, listed, mine_only: mineOnly }),
    [difficulty, listed, mineOnly],
  );

  const refresh = async () => {
    if (!actor) return;
    setLoading(true);
    setError(null);
    try {
      const pageRes = await actor.list_marketplace_courses(filter);
      setCourses(pageRes.courses);
      setTotal(Number(pageRes.total));
    } catch (err: any) {
      console.error('marketplace load failed', err);
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  // Favorites: read the id set once (signed in), and the resolved cards for the
  // quick-replay strip / Favorites filter (PB-311 B7).
  const refreshFavorites = async () => {
    if (!actor || !signedIn) { setFavoriteIds(new Set()); setFavCards([]); return; }
    try {
      const ids: bigint[] = Array.from(await actor.my_favorite_ids());
      setFavoriteIds(new Set(ids));
      const cards: CourseCard[] = ids.length ? await actor.list_my_favorite_courses() : [];
      setFavCards(cards);
    } catch { /* favorites are best-effort */ }
  };

  // Re-roll the shuffle + reset paging whenever filters change, then refetch.
  useEffect(() => {
    seedRef.current = freshSeed();
    setPage(0);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor, difficulty, listed, mineOnly]);

  useEffect(() => { refreshFavorites(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [actor, signedIn]);

  // The Favorites filter re-rolls the shuffle + resets paging like other pills.
  const setFavFilter = (on: boolean) => {
    seedRef.current = freshSeed();
    setPage(0);
    setOnlyFavs(on);
  };

  // ── Derived view model ──
  // When Favorites filter is on, the grid is the favorites cards (server-resolved,
  // already skips burned tokens), still narrowed by the other in-memory pills.
  const baseCards = useMemo(() => {
    if (!onlyFavs) return courses;
    // narrow favorites by the active difficulty/listed pills in-memory.
    return favCards.filter((c) => {
      if (difficulty !== DifficultyFilter.Any && difficultyBucket(c.par_total) !== bucketForFilter(difficulty)) return false;
      if (listed === ListedFilter.Yes && !c.listed) return false;
      if (listed === ListedFilter.No && c.listed) return false;
      return true;
    });
  }, [onlyFavs, courses, favCards, difficulty, listed]);

  const pool = useMemo(
    () => poolOrder(baseCards, undefined, seedRef.current),
    [baseCards, onlyFavs],
  );
  const pageCards = useMemo(() => pageSlice(pool, page), [pool, page]);
  const totalPages = pageCount(pool.length);

  const isEmpty = !loading && baseCards.length === 0;

  // Heart toggle: optimistic flip → reconcile to the returned boolean (PB-311 A3).
  const onToggleFavorite = async (card: CourseCard) => {
    if (!signedIn) { onSignIn(); return; }
    const tid = card.token_id;
    const optimistic = toggleFavoriteId(tid, favoriteIds);
    setFavoriteIds(optimistic);
    try {
      const res = await actor.toggle_favorite_course(tid);
      if (res.__kind__ === 'Err') {
        setFavoriteIds(favoriteIds); // rollback
        setError(`Couldn't update favorites: ${res.Err}`);
        return;
      }
      // reconcile to the authoritative new state.
      setFavoriteIds((prev) => {
        const next = new Set(prev);
        if (res.Ok) next.add(tid); else next.delete(tid);
        return next;
      });
      refreshFavorites();
    } catch (e: any) {
      setFavoriteIds(favoriteIds);
      setError(`Couldn't update favorites: ${e?.message || String(e)}`);
    }
  };

  // ── Local-dev panel (PB-312) registered into Dashboard & Controls ──
  const [devToken, setDevToken] = useState('');
  const [devPrice, setDevPrice] = useState('');
  const [devPlays, setDevPlays] = useState('');
  const [devBusy, setDevBusy] = useState<string | null>(null);
  const devTokenId = (): bigint | null => { try { const n = BigInt(devToken.trim()); return n >= 0n ? n : null; } catch { return null; } };
  const runDev = async (key: string, fn: () => Promise<{ __kind__: string; Err?: string }>) => {
    if (devBusy) return;
    setDevBusy(key); setError(null);
    try {
      const res = await fn();
      if (res.__kind__ === 'Err') setError(`Dev: ${res.Err}`);
      await refresh(); await refreshFavorites();
    } catch (e: any) { setError(`Dev: ${e?.message || String(e)}`); }
    finally { setDevBusy(null); }
  };
  const needTid = (): bigint => { const t = devTokenId(); if (t === null) { setError('Dev: enter a numeric token id.'); throw new Error('bad token id'); } return t; };

  usePageDevControls(isLocal && signedIn, () => (
    <div className="col" style={{ gap: 8 }}>
      <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-2)' }}>Course NFT · marketplace states</span>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <Btn variant="secondary" sm disabled={devBusy !== null} onClick={() => runDev('seed', () => actor.dev_seed_courses(3))}>
          {devBusy === 'seed' ? <LiveDot size={7} /> : <Icon name="flag" size={13} />} Seed 3 mock courses
        </Btn>
        <Btn variant="secondary" sm disabled={devBusy !== null} onClick={() => runDev('clear', () => actor.dev_clear_courses())}>
          {devBusy === 'clear' ? <LiveDot size={7} /> : <Icon name="x" size={13} />} Clear all (empty state)
        </Btn>
      </div>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <input className="burn-input" style={{ width: 80 }} placeholder="token id" value={devToken} onChange={(e) => setDevToken(e.target.value)} inputMode="numeric" />
        <input className="burn-input" style={{ width: 90 }} placeholder="price ICP" value={devPrice} onChange={(e) => setDevPrice(e.target.value)} inputMode="decimal" />
        <Btn variant="secondary" sm disabled={devBusy !== null} onClick={() => runDev('sale', () => { const t = needTid(); const e8s = parseTokenAmount(devPrice, ICP_E8S); return actor.dev_set_course_sale(t, e8s && e8s > 0n ? e8s : 100_000_000n); })}>For sale @ price</Btn>
        <Btn variant="secondary" sm disabled={devBusy !== null} onClick={() => runDev('unsale', () => actor.dev_set_course_sale(needTid(), null))}>Not for sale</Btn>
        <Btn variant="secondary" sm disabled={devBusy !== null} onClick={() => runDev('give', () => actor.dev_give_course(needTid()))}>Give to me</Btn>
        <Btn variant="secondary" sm disabled={devBusy !== null} onClick={() => runDev('sell', () => actor.dev_simulate_sale(needTid(), Principal.fromUint8Array(new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF, 1]))))}>Sell to someone</Btn>
      </div>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <input className="burn-input" style={{ width: 90 }} placeholder="play count" value={devPlays} onChange={(e) => setDevPlays(e.target.value)} inputMode="numeric" />
        <Btn variant="secondary" sm disabled={devBusy !== null} onClick={() => runDev('plays', () => { const t = needTid(); let n = 0n; try { n = BigInt(devPlays.trim() || '0'); } catch { /* default 0 */ } return actor.dev_set_play_count(t, n); })}>Set play count</Btn>
        <Btn variant="secondary" sm disabled={devBusy !== null} onClick={() => runDev('fav', () => actor.dev_grant_favorite(needTid()))}>Favourite this</Btn>
      </div>
      <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>
        Local only. Mutates marketplace state directly (no burns / approves / bids) so you can eyeball each card state. Re-seed tops up to the target count.
      </span>
    </div>
  ), [isLocal, signedIn, devBusy, devToken, devPrice, devPlays]);

  return (
    <div className="col" style={{ gap: 16 }}>
      {/* ── Quick-replay strip (PB-311 A5) — signed in + ≥1 favorite ── */}
      {signedIn && favCards.length > 0 && !onlyFavs && (
        <div className="card col" style={{ gap: 8 }}>
          <span className="row" style={{ gap: 6, alignItems: 'center' }}>
            <Icon name="heart" size={13} stroke="var(--burn-ink)" fill="var(--burn)" />
            <span style={{ fontSize: 10.5, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.06em', fontFamily: 'var(--font-mono)' }}>Your favorites</span>
          </span>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {favCards.slice(0, 6).map((c) => (
              <span key={c.token_id.toString()} className="row" style={{
                gap: 4, alignItems: 'center', border: '1px solid var(--border)',
                borderRadius: 999, padding: '3px 4px 3px 10px', background: 'var(--surface-2)',
              }}>
                <span style={{ fontSize: 12, maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.name || `Course #${c.token_id}`}
                </span>
                <Btn variant="ghost" sm onClick={() => onPlay(c)} style={{ padding: '2px 6px' }}>
                  <Icon name="flame" size={11} stroke="var(--burn-ink)" /> Play
                </Btn>
                <Btn variant="ghost" sm onClick={() => onToggleFavorite(c)} style={{ padding: '2px 5px' }} title="Remove from favorites">
                  <Icon name="x" size={11} />
                </Btn>
              </span>
            ))}
            {favCards.length > 6 && (
              <Btn variant="ghost" sm onClick={() => setFavFilter(true)}>See all ({favCards.length})</Btn>
            )}
          </div>
        </div>
      )}

      {/* ── Header ── */}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div className="col" style={{ gap: 6 }}>
          <Eyebrow accent>Play &amp; earn</Eyebrow>
          <span className="row" style={{ gap: 10 }}>
            <Icon name="gamepad" size={22} stroke="var(--burn-ink)" />
            <h4 style={{ margin: 0 }}>Course Marketplace</h4>
          </span>
          <p style={{ fontSize: 13, color: 'var(--fg-2)', maxWidth: 560, margin: 0 }}>
            Play any course for fun — and earn lottery tickets when you finish a round.
            Every course is an NFT built by an AI course designer, and you can own,
            buy, and sell them.{' '}
            {/* "0.5 ICP" mirrors the backend's MINT_FEE_E8S (lib.rs) — update together. */}
            <MoreInfo title="AI-built courses → play → earn → buy/sell">
              <div className="card col" style={{ gap: 8, borderColor: 'var(--burn)', background: 'color-mix(in srgb, var(--burn) 12%, var(--surface))' }}>
                <Eyebrow accent>The gist</Eyebrow>
                <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
                  Copy our course-designer instructions into <b>any AI agent</b>, describe the
                  course you want, and upload the JSON it returns. Test-play it, then mint it
                  as an NFT for 0.5 ICP. Owners earn lottery tickets from players — and a
                  creator royalty forever after selling.
                </p>
              </div>
              <div className="col" style={{ gap: 6 }}>
                <Eyebrow accent>Own &amp; earn</Eyebrow>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                  <li><b>AI-designed:</b> each NFT carries the build-instructions JSON the app compiles into its 9 holes.</li>
                  <li><b>Mint for 0.5 ICP</b> — anyone signed in can mint; your course is auto-listed on the marketplace.</li>
                  <li><b>One of a kind:</b> hole layouts are fingerprinted at mint — clones of an existing course (even mirrored or shifted) are rejected.</li>
                  <li><b>Advertise it:</b> every course has a shareable link (the Share button) that opens it directly.</li>
                  <li><b>Players earn</b> a lottery ticket for completing a round.</li>
                  <li><b>Owners earn</b> a ticket each time a player reaches hole 2.</li>
                </ul>
              </div>
              <div className="col" style={{ gap: 6 }}>
                <Eyebrow accent>Buy &amp; sell</Eyebrow>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                  <li><b>List, re-price, or delist</b> at any ICP price; buying transfers the earning rights.</li>
                  <li><b>Sale split:</b> 75% seller · 10% original creator (permanent royalty) · 15% protocol (cycles + treasury).</li>
                </ul>
              </div>
            </MoreInfo>
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {signedIn && (
            <Btn variant={mineOnly ? 'primary' : 'ghost'} sm onClick={() => setMineOnly((v) => !v)}>
              <Icon name="list" size={12} stroke={mineOnly ? 'var(--char-950)' : 'currentColor'} /> My courses
            </Btn>
          )}
          <Btn variant="primary" sm onClick={() => (signedIn ? onCreate() : onSignIn())}>
            <Icon name="spark" size={12} stroke="var(--char-950)" /> Create a course
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
        <PillGroup label="Listed">
          {LISTED_OPTIONS.map((o) => (
            <Pill key={o.label} active={listed === o.value} onClick={() => setListed(o.value)}>{o.label}</Pill>
          ))}
        </PillGroup>
        {signedIn && (
          <PillGroup label="Favorites">
            <Pill active={!onlyFavs} onClick={() => setFavFilter(false)}>All</Pill>
            <Pill active={onlyFavs} onClick={() => setFavFilter(true)}>Only favorites</Pill>
          </PillGroup>
        )}
      </div>

      {error && (
        <div className="card" style={{ borderColor: 'var(--ember)', color: 'var(--ember)', fontSize: 13 }}>
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--fg-3)' }}>
          <LiveDot size={10} color="var(--burn-ink)" style={{ margin: '0 auto 12px' }} />
          Loading courses…
        </div>
      ) : isEmpty ? (
        <div className="col" style={{ alignItems: 'center', gap: 12, padding: '48px 0', color: 'var(--fg-3)' }}>
          <Icon name="gamepad" size={28} stroke="var(--fg-dim)" />
          <span style={{ fontSize: 14 }}>
            {onlyFavs ? 'No favorites yet — tap the heart on a course to save it.' : 'No courses on the marketplace yet — be the first: create one with your favorite AI agent.'}
          </span>
        </div>
      ) : (
        <>
          {/* Random pool grid */}
          <div className="idea-grid">
            {pageCards.map((card) => (
              <CourseCardView
                key={card.token_id.toString()}
                actor={actor}
                card={card}
                principal={principal}
                isFav={favoriteIds.has(card.token_id)}
                onPlay={onPlay}
                onViewNft={onViewNft}
                onManage={setManageCard}
                onBuy={setBuyCard}
                onBurn={setBurnCard}
                onToggleFavorite={onToggleFavorite}
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
      {buyCard && (
        <BuyModal
          actor={actor}
          card={buyCard}
          identity={identity}
          host={host}
          rootKey={rootKey}
          ledgerCanisterId={ledgerCanisterId}
          backendCanisterId={backendCanisterId}
          onClose={() => setBuyCard(null)}
          onDone={() => { setBuyCard(null); refresh(); refreshFavorites(); }}
        />
      )}
      {burnCard && (
        <BurnModal
          actor={actor}
          card={burnCard}
          onClose={() => setBurnCard(null)}
          onError={(msg) => { setBurnCard(null); setError(msg); }}
          onDone={() => { setBurnCard(null); refresh(); refreshFavorites(); }}
        />
      )}
    </div>
  );
}

// Map the DifficultyFilter enum to the difficultyBucket label for in-memory favs.
function bucketForFilter(d: DifficultyFilter): string {
  switch (d) {
    case DifficultyFilter.Easy: return 'Easy';
    case DifficultyFilter.Medium: return 'Medium';
    case DifficultyFilter.Hard: return 'Hard';
    default: return '';
  }
}

// ── Course art (deterministic per token id) ──
// A stylized top-down golf-hole illustration seeded by the token id, so every
// course gets a stable, unique banner without storing any image. Decorative
// only (aria-hidden); greens/bunkers derive from theme tokens so both themes
// stay coherent.
function CourseArt({ tokenId, height }: { tokenId: bigint; height: number }) {
  const rand = mulberry32(Number(tokenId % 0xffffffffn) || 1);
  // Fairway blobs, a bunker, a pond — positions/sizes rolled from the seed.
  const blobs = Array.from({ length: 3 }, () => ({
    cx: 30 + rand() * 260,
    cy: 18 + rand() * 60,
    rx: 46 + rand() * 60,
    ry: 18 + rand() * 22,
  }));
  const bunker = { cx: 40 + rand() * 240, cy: 24 + rand() * 48, rx: 12 + rand() * 12, ry: 7 + rand() * 6 };
  const pond = { cx: 40 + rand() * 240, cy: 24 + rand() * 48, rx: 16 + rand() * 16, ry: 8 + rand() * 8 };
  const flagX = 46 + rand() * 228;
  const flagY = 30 + rand() * 34;
  const stripes = Array.from({ length: 6 }, (_, i) => i * 56 + rand() * 20);
  return (
    <svg
      aria-hidden
      viewBox="0 0 320 96"
      preserveAspectRatio="xMidYMid slice"
      style={{ display: 'block', width: '100%', height }}
    >
      <rect width="320" height="96" style={{ fill: 'color-mix(in srgb, var(--sprout) 14%, var(--surface))' }} />
      {stripes.map((x, i) => (
        <rect key={i} x={x} y="0" width="28" height="96" transform={`skewX(-12)`} style={{ fill: 'color-mix(in srgb, var(--sprout) 22%, transparent)', opacity: 0.35 }} />
      ))}
      {blobs.map((b, i) => (
        <ellipse key={i} cx={b.cx} cy={b.cy} rx={b.rx} ry={b.ry} style={{ fill: 'color-mix(in srgb, var(--sprout) 34%, var(--surface))', opacity: 0.8 }} />
      ))}
      <ellipse cx={pond.cx} cy={pond.cy} rx={pond.rx} ry={pond.ry} style={{ fill: '#4f86ad', opacity: 0.55 }} />
      <ellipse cx={bunker.cx} cy={bunker.cy} rx={bunker.rx} ry={bunker.ry} style={{ fill: 'color-mix(in srgb, var(--haze) 55%, var(--surface))', opacity: 0.9 }} />
      {/* cup + flag */}
      <ellipse cx={flagX} cy={flagY + 2} rx="4.5" ry="2.2" style={{ fill: 'rgba(0,0,0,0.45)' }} />
      <line x1={flagX} y1={flagY} x2={flagX} y2={flagY - 26} style={{ stroke: 'var(--fg-3)', strokeWidth: 1.6 }} />
      <path d={`M ${flagX} ${flagY - 26} l 14 5 l -14 5 z`} style={{ fill: 'var(--burn)' }} />
      {/* soft top fade so overlay chips stay legible in both themes */}
      <rect width="320" height="34" style={{ fill: 'var(--surface)', opacity: 0.28 }} />
    </svg>
  );
}

// ── Course card ──
function CourseCardView({ actor, card, principal, isFav, onPlay, onViewNft, onManage, onBuy, onBurn, onToggleFavorite, onSignIn }: {
  actor: any;
  card: CourseCard;
  principal: Principal | null;
  isFav: boolean;
  onPlay: (c: CourseCard) => void;
  onViewNft: (c: CourseCard) => void;
  onManage: (c: CourseCard) => void;
  onBuy: (c: CourseCard) => void;
  onBurn: (c: CourseCard) => void;
  onToggleFavorite: (c: CourseCard) => void;
  onSignIn: () => void;
}) {
  const signedIn = !!(principal && !principal.isAnonymous());
  const par = card.par_total;
  const diff = difficultyBucket(par);
  const forSale = card.for_sale && card.price_e8s > 0n;
  const ownerDiffers = card.creator && card.owner && card.creator.toString() !== card.owner.toString();

  // Shareable deep link (#/arcade/course/<id>) — owners advertise, anyone shares.
  const [linkCopied, setLinkCopied] = useState(false);
  const shareCourse = async () => {
    const url = courseShareUrl(card.token_id, window.location.origin);
    try {
      await navigator.clipboard.writeText(url);
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      window.prompt('Copy this course link:', url);
    }
  };

  // Per-card rating aggregate (cheap query, one per rendered card).
  const [rating, setRating] = useState<CourseRatingSummary | null>(null);
  useEffect(() => {
    let cancelled = false;
    actor.get_course_rating_summary(card.token_id)
      .then((s: CourseRatingSummary) => { if (!cancelled) setRating(s); })
      .catch(() => { /* aggregate is best-effort */ });
    return () => { cancelled = true; };
  }, [actor, card.token_id]);

  return (
    <div className="card col" style={{ padding: 0, overflow: 'hidden', gap: 0 }}>
      {/* ── Banner: generated course art + status overlay ── */}
      <div style={{ position: 'relative', borderBottom: '1px solid var(--border)' }}>
        <CourseArt tokenId={card.token_id} height={92} />
        <div className="row" style={{ position: 'absolute', top: 8, left: 10, right: 10, justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="row" style={{ gap: 6 }}>
            {forSale ? (
              <Chip tone="ok" style={{ height: 19, fontSize: 10 }}>For sale</Chip>
            ) : (
              <Chip tone="muted" style={{ height: 19, fontSize: 10 }}>Not for sale</Chip>
            )}
          </span>
          <button
            onClick={() => (signedIn ? onToggleFavorite(card) : onSignIn())}
            title={signedIn ? (isFav ? 'Remove from favorites' : 'Add to favorites') : 'Sign in to save favorites'}
            disabled={!signedIn}
            style={{
              background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 999,
              padding: 5, cursor: signedIn ? 'pointer' : 'not-allowed',
              opacity: signedIn ? 1 : 0.5, display: 'flex', alignItems: 'center',
            }}
          >
            <Icon name="heart" size={14} stroke={isFav ? 'var(--burn-ink)' : 'var(--fg-3)'} fill={isFav ? 'var(--burn)' : 'none'} />
          </button>
        </div>
        <span className="mono" style={{
          position: 'absolute', bottom: 8, right: 10, fontSize: 10.5, color: 'var(--fg-2)',
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 999, padding: '2px 9px',
        }}>
          9 holes · Par {par} · {diff}
        </span>
      </div>

      {/* ── Body ── */}
      <div className="col" style={{ gap: 10, padding: 14 }}>
        <div className="col" style={{ gap: 3 }}>
          <h6 style={{ margin: 0, fontSize: 16 }}>{card.name || `Course #${card.token_id}`}</h6>
          <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>
            by {formatPrincipal(card.creator ?? null)}
            {ownerDiffers && <span> · owned by {formatPrincipal(card.owner ?? null)}</span>}
          </span>
        </div>

        <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <Chip tone="muted" style={{ height: 19, fontSize: 10 }}>
            <Icon name="target" size={11} /> {card.play_count.toString()} plays
          </Chip>
          {card.tickets_distributed > 0n && (
            <Chip tone="muted" style={{ height: 19, fontSize: 10 }}>{card.tickets_distributed.toString()} tickets earned</Chip>
          )}
          {rating && rating.count > 0 && (
            <Chip tone="muted" style={{ height: 19, fontSize: 10 }}>{formatRating(rating.avg_x10, rating.count)}</Chip>
          )}
        </span>

        <span className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
          <span className="mono" style={{ fontSize: 12 }}>
            {forSale ? <b>{fmtICP(card.price_e8s)} ICP</b> : <span style={{ color: 'var(--fg-3)' }}>Not for sale</span>}
          </span>
        </span>

        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, paddingTop: 8, borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
        <Btn variant="ghost" sm onClick={() => onViewNft(card)} title="View this course's 9 holes in a 3×3 grid">
          <Icon name="eye" size={11} /> View NFT
        </Btn>
        <Btn variant="ghost" sm onClick={shareCourse} title="Copy a shareable link that opens this course directly">
          <Icon name="copy" size={11} /> {linkCopied ? 'Copied ✓' : 'Share'}
        </Btn>
        {card.is_caller_owner && (
          <Btn variant="ghost" sm onClick={() => onManage(card)}><Icon name="edit" size={11} /> Manage</Btn>
        )}
        {card.is_caller_owner && (
          <Btn variant="danger" sm onClick={() => onBurn(card)} title="Permanently destroy this course NFT">
            <Icon name="flame" size={11} stroke="var(--ember)" /> Burn
          </Btn>
        )}
        {forSale && !card.is_caller_owner && (
          <Btn variant="secondary" sm onClick={() => (signedIn ? onBuy(card) : onSignIn())}>Buy — {fmtICP(card.price_e8s)} ICP</Btn>
        )}
        <Btn variant="primary" sm onClick={() => (signedIn ? onPlay(card) : onSignIn())}>
          <Icon name="flame" size={11} stroke="var(--char-950)" /> {signedIn ? 'Play' : 'Sign in to play'}
        </Btn>
        </div>
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

  // Live sale-split preview (mirrors the backend `compute_sale_split` exactly:
  // 75% seller / 10% creator royalty / 15% protocol — the protocol leg bundles
  // the 5% cycles + 5% frontend + ~5% treasury legs, so the three displayed
  // rows always sum to the full price). When the seller IS the original creator
  // the backend coalesces the royalty into the seller payout (85% / 0% / 15%),
  // so we drop the royalty row and relabel the seller's share.
  const isCreator = !!(card.creator && card.owner && card.creator.toString() === card.owner.toString());
  const previewE8s = parseTokenAmount(priceInput, ICP_E8S);
  const hasPrice = previewE8s !== null && previewE8s > 0n;
  const price = hasPrice ? (previewE8s as bigint) : 0n;
  const sellerShare = (price * 7500n) / 10000n;
  const royalty = (price * 1000n) / 10000n;
  const protocolShare = price - sellerShare - royalty;
  const sellerReceive = isCreator ? sellerShare + royalty : sellerShare;
  const amt = (v: bigint) => hasPrice ? `${fmtICP(v)} ICP` : '—';

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

  const forSale = card.for_sale && card.price_e8s > 0n;
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
      <div className="col" style={{ gap: 6, padding: 10, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface)' }}>
        <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>On a sale, the buyer's ICP splits as:</span>
        <div className="col" style={{ gap: 4, fontSize: 12.5 }}>
          <span className="row" style={{ justifyContent: 'space-between' }}>
            <span>{isCreator ? 'You (seller + creator royalty, 85%)' : 'You — seller (75%)'}</span>
            <span className="mono" style={{ color: 'var(--fg-2)' }}>{amt(sellerReceive)}</span>
          </span>
          {!isCreator && (
            <span className="row" style={{ justifyContent: 'space-between' }}>
              <span>Original creator — royalty (10%)</span>
              <span className="mono" style={{ color: 'var(--fg-3)' }}>{amt(royalty)}</span>
            </span>
          )}
          <span className="row" style={{ justifyContent: 'space-between' }}>
            <span>Protocol — cycles + treasury (15%)</span>
            <span className="mono" style={{ color: 'var(--fg-3)' }}>{amt(protocolShare)}</span>
          </span>
        </div>
        <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>
          {hasPrice
            ? <>Buyer pays <b className="mono">{fmtICP(price)} ICP</b> · you receive <b className="mono" style={{ color: 'var(--ok)' }}>{fmtICP(sellerReceive)} ICP</b>.</>
            : 'Enter a price to see exactly how much you keep. Delist any time at no cost.'}
        </span>
      </div>
      {err && <span style={{ fontSize: 12, color: 'var(--ember)' }}>{err}</span>}
      <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
        {forSale ? (
          <Btn variant="danger" sm disabled={busy} onClick={() => submit('delist')}>Delist</Btn>
        ) : <span />}
        <div className="row" style={{ gap: 8 }}>
          <Btn variant="ghost" sm disabled={busy} onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" sm disabled={busy} onClick={() => submit('list')}>
            {busy ? 'Working…' : forSale ? 'Update price' : 'List for sale'}
          </Btn>
        </div>
      </div>
    </ModalShell>
  );
}

// ── Owner: burn_course_nft (permanent destroy) ──
function BurnModal({ actor, card, onClose, onError, onDone }: {
  actor: any;
  card: CourseCard;
  onClose: () => void;
  onError: (msg: string) => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const label = card.name || `Course #${card.token_id}`;

  const burn = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await actor.burn_course_nft(card.token_id);
      if (res.__kind__ === 'Err') throw new Error(burnErr(res.Err));
      onDone();
    } catch (e: any) {
      // Surface in the page-level error banner (consistent with buy/bid flows).
      onError(`Couldn't burn "${label}": ${e?.message || String(e)}`);
    } finally { setBusy(false); }
  };

  return (
    <ModalShell title={`Burn "${label}"`} onClose={() => !busy && onClose()}>
      <p style={{ fontSize: 13, color: 'var(--fg-2)', margin: 0 }}>
        Burn this course NFT? This permanently destroys it and removes it from the
        marketplace. This cannot be undone.
      </p>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <Btn variant="ghost" sm disabled={busy} onClick={onClose}>Cancel</Btn>
        <Btn variant="danger" sm disabled={busy} onClick={burn}>
          <Icon name="flame" size={11} stroke="var(--ember)" /> {busy ? 'Burning…' : 'Burn permanently'}
        </Btn>
      </div>
    </ModalShell>
  );
}

// Friendly text for backend burn error codes.
function burnErr(code: string): string {
  switch (code) {
    case 'NOT_OWNER': return 'You no longer own this course.';
    case 'NO_COURSE': return 'This course no longer exists.';
    case 'BURN_IN_PROGRESS': return 'A burn is already in progress — try again in a moment.';
    default: return code;
  }
}

// ── Buyer: approve + buy_course_nft (PB-307) ──
function BuyModal({ actor, card, identity, host, rootKey, ledgerCanisterId, backendCanisterId, onClose, onDone }: {
  actor: any;
  card: CourseCard;
  identity: any;
  host: string;
  rootKey?: Uint8Array;
  ledgerCanisterId: string;
  backendCanisterId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const price = card.price_e8s;
  const total = price + ICP_FEE_E8S;
  const seller = (price * 7500n) / 10000n;
  const royalty = (price * 1000n) / 10000n;
  const protocolShare = price - seller - royalty;

  const buy = async () => {
    if (busy || !identity) return;
    setBusy(true); setErr(null);
    try {
      setStep(`Step 1/2: Approving ${fmtICP(total)} ICP…`);
      const approver = makeApprover(ledgerCanisterId, { host, identity, rootKey });
      const appr = await approver.icrc2_approve({
        from_subaccount: [],
        spender: { owner: Principal.fromText(backendCanisterId), subaccount: [] },
        amount: total,
        expected_allowance: [], expires_at: [], fee: [], memo: [], created_at_time: [],
      });
      if (appr.Err !== undefined) throw new Error(`Approval failed: ${JSON.stringify(appr.Err, (_k, v) => typeof v === 'bigint' ? v.toString() : v)}`);

      setStep('Step 2/2: Settling sale…');
      const res = await actor.buy_course_nft(card.token_id);
      if (res.__kind__ === 'Err') throw new Error(saleErr(res.Err));
      setDone(true);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell title={`Buy "${card.name || `Course #${card.token_id}`}"`} onClose={() => !busy && onClose()}>
      {done ? (
        <div className="col" style={{ gap: 12 }}>
          <span className="row" style={{ gap: 8, color: 'var(--ok)', fontSize: 13 }}>
            <Icon name="checkCircle" size={16} stroke="var(--ok)" />
            You now own {card.name || `Course #${card.token_id}`} — it earns you a lottery ticket every time a player reaches hole 2.
          </span>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Btn variant="primary" sm onClick={onDone}>Done</Btn>
          </div>
        </div>
      ) : (
        <>
          <p style={{ fontSize: 13, color: 'var(--fg-2)', margin: 0 }}>
            Buy this course for <b className="mono">{fmtICP(price)} ICP</b> (+ {fmtICP(ICP_FEE_E8S)} network fee).
          </p>
          <div className="col" style={{ gap: 4, fontSize: 12, color: 'var(--fg-3)' }}>
            <span className="row" style={{ justifyContent: 'space-between' }}><span>Seller (75%)</span><span className="mono">{fmtICP(seller)} ICP</span></span>
            <span className="row" style={{ justifyContent: 'space-between' }}><span>Creator royalty (10%)</span><span className="mono">{fmtICP(royalty)} ICP</span></span>
            <span className="row" style={{ justifyContent: 'space-between' }}><span>Protocol — cycles + treasury (15%)</span><span className="mono">{fmtICP(protocolShare)} ICP</span></span>
          </div>
          <p style={{ fontSize: 11.5, color: 'var(--fg-3)', margin: 0 }}>The creator earns 10% on every resale.</p>
          {busy && step && <span className="row" style={{ gap: 8, fontSize: 12, color: 'var(--fg-2)' }}><LiveDot size={7} /> {step}</span>}
          {err && <span style={{ fontSize: 12, color: 'var(--ember)' }}>{err}</span>}
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <Btn variant="ghost" sm disabled={busy} onClick={onClose}>Cancel</Btn>
            <Btn variant="primary" sm disabled={busy} onClick={buy}>{busy ? 'Working…' : `Buy — ${fmtICP(price)} ICP`}</Btn>
          </div>
        </>
      )}
    </ModalShell>
  );
}

// Friendly text for backend sale error codes (PB-307 B5).
function saleErr(code: string): string {
  if (code.startsWith('PRICE_CHANGED')) return 'The price changed — close and re-open Buy to see the new price.';
  switch (code) {
    case 'NOT_FOR_SALE': return 'This course is no longer for sale.';
    case 'CANNOT_BUY_OWN_COURSE': return 'You already own this course.';
    case 'SALE_IN_PROGRESS': return 'Another buyer is mid-purchase — try again in a moment.';
    case 'OWNERSHIP_CHANGED': return 'The owner changed during the sale — you were refunded.';
    default: return code;
  }
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
        border: '1px solid var(--border-hi)', boxShadow: 'var(--elev-3)', maxHeight: '85vh', overflowY: 'auto',
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
      background: active ? 'color-mix(in srgb, var(--burn) 14%, transparent)' : 'transparent',
      border: `1px solid ${active ? 'var(--burn)' : 'var(--border)'}`,
      color: active ? 'var(--burn-ink)' : 'var(--fg-3)',
      borderRadius: 999, padding: '5px 11px', fontSize: 11.5, fontWeight: 500,
      cursor: 'pointer', transition: 'all var(--dur-fast) var(--ease-out)',
    }}>{children}</button>
  );
}
