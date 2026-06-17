import { useEffect, useMemo, useRef, useState } from 'react';
import { Principal } from '@icp-sdk/core/principal';
import type { CourseCard, MarketplaceFilter, FeaturedSlot, Rating, CourseRatingSummary } from './bindings/backend';
import { DifficultyFilter, ListedFilter, ExplorerToken } from './bindings/backend';
import { Icon, Eyebrow, Chip, Btn, LiveDot, MoreInfo, formatPrincipal, fmtICP, usePageDevControls } from './ui';
import { useErrorImpression } from './analytics';
import { parseTokenAmount } from './IdeaBoard';
import { parseTokenUnits, fmtUsd } from './tokens';
import { makeApprover } from './minters';
import {
  difficultyBucket, themeLabel, poolOrder, pageSlice, pageCount, freshSeed,
  formatRating, tokenAmountUsdE8s, bidBeats, toggleFavoriteId, courseNftTokenUrl,
  DIFFICULTY_OPTIONS, LISTED_OPTIONS, THEME_OPTIONS, GRID_PAGE_SIZE,
} from './arcade/courseMarket';

// ==========================================
// Course Marketplace (PB-305 + Phase 2/3) — the arcade mini-golf surface.
//   PB-307 buy/sell  · PB-311 favorites · PB-308 featured slot · PB-310 ratings
//   PB-312 local-dev panel (Dashboard & Controls).
// Browse/filter minted courses, Play any of them, list/delist/buy, favorite,
// promote to the featured slot, and rate courses you've completed.
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
  /** Route to the editor (PB-302). */
  onCreateCourse: () => void;
  /** Launch the engine view for a chosen course. */
  onPlay: (card: CourseCard) => void;
  onSignIn: () => void;
}

const ICP_E8S = 8;
const ICP_FEE_E8S = 10_000n;

// ck-token metadata for featured bids (ICP not accepted — PB-308 A2).
const BID_TOKENS: { token: ExplorerToken; label: string; decimals: number; fallbackFee: bigint }[] = [
  { token: ExplorerToken.CkBTC, label: 'ckBTC', decimals: 8, fallbackFee: 10n },
  { token: ExplorerToken.CkETH, label: 'ckETH', decimals: 18, fallbackFee: 2_000_000_000_000n },
  { token: ExplorerToken.CkUSDC, label: 'ckUSDC', decimals: 6, fallbackFee: 10_000n },
  { token: ExplorerToken.CkUSDT, label: 'ckUSDT', decimals: 6, fallbackFee: 10_000n },
];

export default function CourseMarketplace({
  actor, principal, identity, host, rootKey, ledgerCanisterId, backendCanisterId, isLocal,
  onCreateCourse, onPlay, onSignIn,
}: CourseMarketplaceProps) {
  const signedIn = !!(principal && !principal.isAnonymous());

  const [difficulty, setDifficulty] = useState<DifficultyFilter>(DifficultyFilter.Any);
  const [theme, setTheme] = useState<number | undefined>(undefined);
  const [listed, setListed] = useState<ListedFilter>(ListedFilter.Any);
  const [mineOnly, setMineOnly] = useState(false);
  const [onlyFavs, setOnlyFavs] = useState(false);

  const [courses, setCourses] = useState<CourseCard[]>([]);
  const [featuredId, setFeaturedId] = useState<bigint | undefined>(undefined);
  const [featuredSlot, setFeaturedSlot] = useState<FeaturedSlot | null>(null);
  const [favoriteIds, setFavoriteIds] = useState<Set<bigint>>(new Set());
  const [favCards, setFavCards] = useState<CourseCard[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useErrorImpression(error, 'course_market');

  // course_nft canister id (for "View NFT ↗" per-token links). `opt principal`:
  // decoded to `Config.course_nft_canister?: Principal` — undefined ⇒ None ⇒
  // the link is hidden (no dead anchors). Fetched once.
  const [courseNftId, setCourseNftId] = useState<string | undefined>(undefined);

  // A fresh shuffle seed per load + per filter change (PB-305 A5).
  const seedRef = useRef<number>(freshSeed());

  // Modals.
  const [manageCard, setManageCard] = useState<CourseCard | null>(null);
  const [buyCard, setBuyCard] = useState<CourseCard | null>(null);
  const [bidCard, setBidCard] = useState<CourseCard | null>(null);
  const [rateCard, setRateCard] = useState<CourseCard | null>(null);
  const [burnCard, setBurnCard] = useState<CourseCard | null>(null);

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

  // Featured slot detail (the "to beat" USD figure) — independent of the page.
  const refreshFeatured = async () => {
    if (!actor) return;
    try { setFeaturedSlot((await actor.get_featured_slot()) ?? null); }
    catch { setFeaturedSlot(null); }
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
  }, [actor, difficulty, theme, listed, mineOnly]);

  useEffect(() => { refreshFeatured(); refreshFavorites(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [actor, signedIn]);

  // course_nft canister id for the per-token "View NFT ↗" links. The wrapper
  // layer decodes `opt principal` to `course_nft_canister?: Principal`; None ⇒
  // undefined ⇒ the links stay hidden.
  useEffect(() => {
    if (!actor) return;
    let cancelled = false;
    actor.get_config()
      .then((cfg: { course_nft_canister?: Principal }) => {
        if (!cancelled) setCourseNftId(cfg.course_nft_canister?.toString());
      })
      .catch(() => { /* link is best-effort; hidden if config unavailable */ });
    return () => { cancelled = true; };
  }, [actor]);

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
    // narrow favorites by the active difficulty/theme/listed pills in-memory.
    return favCards.filter((c) => {
      if (theme !== undefined && c.theme !== theme) return false;
      if (difficulty !== DifficultyFilter.Any && difficultyBucket(c.par_total) !== bucketForFilter(difficulty)) return false;
      if (listed === ListedFilter.Yes && !c.listed) return false;
      if (listed === ListedFilter.No && c.listed) return false;
      return true;
    });
  }, [onlyFavs, courses, favCards, theme, difficulty, listed]);

  const featuredCard = useMemo(
    () => (featuredId === undefined || onlyFavs ? null : baseCards.find((c) => c.token_id === featuredId) ?? null),
    [baseCards, featuredId, onlyFavs],
  );
  const pool = useMemo(
    () => poolOrder(baseCards, onlyFavs ? undefined : featuredId, seedRef.current),
    [baseCards, featuredId, onlyFavs],
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
      await refresh(); await refreshFeatured(); await refreshFavorites();
    } catch (e: any) { setError(`Dev: ${e?.message || String(e)}`); }
    finally { setDevBusy(null); }
  };
  const needTid = (): bigint => { const t = devTokenId(); if (t === null) { setError('Dev: enter a numeric token id.'); throw new Error('bad token id'); } return t; };

  usePageDevControls(isLocal && signedIn, () => (
    <div className="col" style={{ gap: 8 }}>
      <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-2)' }}>Course NFT · marketplace states</span>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <Btn variant="secondary" sm disabled={devBusy !== null} onClick={() => runDev('seed', () => actor.dev_seed_courses(12))}>
          {devBusy === 'seed' ? <LiveDot size={7} /> : <Icon name="flag" size={13} />} Seed 12 courses
        </Btn>
        <Btn variant="secondary" sm disabled={devBusy !== null} onClick={() => runDev('clear', () => actor.dev_clear_courses())}>
          {devBusy === 'clear' ? <LiveDot size={7} /> : <Icon name="x" size={13} />} Clear all (empty state)
        </Btn>
        <Btn variant="secondary" sm disabled={devBusy !== null} onClick={() => runDev('clearFeat', () => actor.dev_clear_featured())}>Clear featured</Btn>
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
        <Btn variant="secondary" sm disabled={devBusy !== null} onClick={() => runDev('feat', () => actor.dev_set_featured(needTid()))}>Feature this</Btn>
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
            Play any community-built course for fun — and earn lottery tickets when you
            finish a round. Courses are NFTs you can create, own, buy, and sell.{' '}
            <MoreInfo title="Create → mint → list → earn → buy/sell">
              <div className="card col" style={{ gap: 8, borderColor: 'var(--burn)', background: 'color-mix(in srgb, var(--burn) 12%, var(--surface))' }}>
                <Eyebrow accent>The gist</Eyebrow>
                <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
                  Build a course, <b>mint it as an NFT</b>, and earn lottery tickets from players — then
                  list it for sale and keep earning a creator royalty forever.
                </p>
              </div>
              <div className="col" style={{ gap: 6 }}>
                <Eyebrow accent>Create &amp; earn</Eyebrow>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                  <li><b>Build &amp; mint:</b> a 9-hole course in the editor, minted as an NFT (<b>0.5 ICP</b>), auto-listed here.</li>
                  <li><b>Players earn</b> a lottery ticket for completing a round.</li>
                  <li><b>You earn</b> a ticket each time a player reaches hole 2.</li>
                </ul>
              </div>
              <div className="col" style={{ gap: 6 }}>
                <Eyebrow accent>Buy &amp; sell</Eyebrow>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                  <li><b>List, re-price, or delist</b> at any ICP price; buying transfers the earning rights.</li>
                  <li><b>Sale split:</b> 75% seller · 10% original creator (permanent royalty) · 15% protocol (cycles + treasury).</li>
                  <li><b>Featured slot:</b> promote any course to the top with a ck-token bid.</li>
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
            {onlyFavs ? 'No favorites yet — tap the heart on a course to save it.' : 'No courses minted yet — be the first to create one.'}
          </span>
          {!onlyFavs && (
            <Btn variant="primary" onClick={() => (signedIn ? onCreateCourse() : onSignIn())}>
              <Icon name="edit" size={12} stroke="var(--char-950)" /> {signedIn ? 'Create a course' : 'Sign in to create'}
            </Btn>
          )}
        </div>
      ) : (
        <>
          {/* Featured slot (PB-308). */}
          {featuredCard ? (
            <CourseCardView
              actor={actor}
              card={featuredCard}
              featured
              featuredToBeat={featuredSlot?.usd_value_e8s}
              principal={principal}
              isFav={favoriteIds.has(featuredCard.token_id)}
              courseNftId={courseNftId}
              isLocal={isLocal}
              onPlay={onPlay}
              onManage={setManageCard}
              onBuy={setBuyCard}
              onBid={setBidCard}
              onRate={setRateCard}
              onBurn={setBurnCard}
              onToggleFavorite={onToggleFavorite}
              onSignIn={onSignIn}
            />
          ) : !onlyFavs && (
            <div className="card row" style={{
              justifyContent: 'space-between', alignItems: 'center', gap: 10,
              borderStyle: 'dashed', borderColor: 'var(--border)',
            }}>
              <span className="row" style={{ gap: 8, color: 'var(--fg-3)', fontSize: 12.5 }}>
                <Icon name="spark" size={14} stroke="var(--fg-3)" /> No featured course — promote any course to the top of the marketplace
              </span>
            </div>
          )}

          {/* Random pool grid */}
          <div className="idea-grid">
            {pageCards.map((card) => (
              <CourseCardView
                key={card.token_id.toString()}
                actor={actor}
                card={card}
                principal={principal}
                isFav={favoriteIds.has(card.token_id)}
                courseNftId={courseNftId}
                isLocal={isLocal}
                onPlay={onPlay}
                onManage={setManageCard}
                onBuy={setBuyCard}
                onBid={setBidCard}
                onRate={setRateCard}
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
      {bidCard && (
        <BidModal
          actor={actor}
          card={bidCard}
          identity={identity}
          host={host}
          rootKey={rootKey}
          backendCanisterId={backendCanisterId}
          toBeatUsdE8s={featuredSlot?.usd_value_e8s}
          onClose={() => setBidCard(null)}
          onDone={() => { setBidCard(null); refresh(); refreshFeatured(); }}
        />
      )}
      {rateCard && (
        <RateModal
          actor={actor}
          card={rateCard}
          onClose={() => setRateCard(null)}
          onDone={() => { setRateCard(null); refresh(); }}
        />
      )}
      {burnCard && (
        <BurnModal
          actor={actor}
          card={burnCard}
          onClose={() => setBurnCard(null)}
          onError={(msg) => { setBurnCard(null); setError(msg); }}
          onDone={() => { setBurnCard(null); refresh(); refreshFeatured(); refreshFavorites(); }}
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

// ── Course card (shared by featured + pool) ──
function CourseCardView({ actor, card, featured, featuredToBeat, principal, isFav, courseNftId, isLocal, onPlay, onManage, onBuy, onBid, onRate, onBurn, onToggleFavorite, onSignIn }: {
  actor: any;
  card: CourseCard;
  featured?: boolean;
  featuredToBeat?: bigint;
  principal: Principal | null;
  isFav: boolean;
  /** course_nft canister id; undefined ⇒ unwired ⇒ hide the "View NFT" link. */
  courseNftId?: string;
  isLocal: boolean;
  onPlay: (c: CourseCard) => void;
  onManage: (c: CourseCard) => void;
  onBuy: (c: CourseCard) => void;
  onBid: (c: CourseCard) => void;
  onRate: (c: CourseCard) => void;
  onBurn: (c: CourseCard) => void;
  onToggleFavorite: (c: CourseCard) => void;
  onSignIn: () => void;
}) {
  const signedIn = !!(principal && !principal.isAnonymous());
  const par = card.par_total;
  const diff = difficultyBucket(par);
  const forSale = card.for_sale && card.price_e8s > 0n;
  const ownerDiffers = card.creator && card.owner && card.creator.toString() !== card.owner.toString();
  const nftUrl = courseNftTokenUrl(courseNftId, card.token_id, isLocal);

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
    <div className="card col" style={{ gap: 10, gridColumn: featured ? '1 / -1' : undefined }}>
      <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
        <span className="row" style={{ gap: 6, alignItems: 'center' }}>
          {featured ? (
            <Chip tone="burn" style={{ height: 19, fontSize: 10 }}><LiveDot color="var(--burn-ink)" size={5} /> Featured</Chip>
          ) : forSale ? (
            <Chip tone="ok" style={{ height: 19, fontSize: 10 }}>For sale</Chip>
          ) : (
            <Chip tone="muted" style={{ height: 19, fontSize: 10 }}>Not for sale</Chip>
          )}
          <button
            onClick={() => (signedIn ? onToggleFavorite(card) : onSignIn())}
            title={signedIn ? (isFav ? 'Remove from favorites' : 'Add to favorites') : 'Sign in to save favorites'}
            disabled={!signedIn}
            style={{
              background: 'transparent', border: 'none', padding: 2, cursor: signedIn ? 'pointer' : 'not-allowed',
              opacity: signedIn ? 1 : 0.4, display: 'flex', alignItems: 'center',
            }}
          >
            <Icon name="heart" size={14} stroke={isFav ? 'var(--burn-ink)' : 'var(--fg-3)'} fill={isFav ? 'var(--burn)' : 'none'} />
          </button>
        </span>
        <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>Par {par} · {diff}</span>
      </div>

      <span className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <h6 style={{ margin: 0, fontSize: 16 }}>{card.name || `Course #${card.token_id}`}</h6>
        <Chip tone="muted" style={{ height: 18, fontSize: 9.5 }}>{themeLabel(card.theme)}</Chip>
      </span>

      <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>
        by {formatPrincipal(card.creator ?? null)}
        {ownerDiffers && <span style={{ color: 'var(--fg-3)' }}> · owned by {formatPrincipal(card.owner ?? null)}</span>}
      </span>

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
        {featured && featuredToBeat !== undefined && (
          <span className="mono" style={{ fontSize: 11, color: 'var(--burn-ink)' }}>Featured bid to beat: {fmtUsd(featuredToBeat)}</span>
        )}
      </span>

      <div className="row" style={{ justifyContent: 'flex-end', gap: 8, paddingTop: 6, borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
        {nftUrl && (
          <a
            href={nftUrl}
            target="_blank"
            rel="noreferrer"
            title="Open this course's NFT metadata in a new tab"
            style={{ color: 'var(--fg-3)', fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 4, textDecoration: 'none' }}
          >
            View NFT <Icon name="external" size={11} stroke="var(--fg-3)" />
          </a>
        )}
        {signedIn && (
          <Btn variant="ghost" sm onClick={() => onBid(card)} title="Promote this course to the featured slot">
            <Icon name="spark" size={11} /> Feature
          </Btn>
        )}
        {signedIn && !card.is_caller_owner && (
          <Btn variant="ghost" sm onClick={() => onRate(card)}>
            <Icon name="star" size={11} /> Rate
          </Btn>
        )}
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
      <p style={{ fontSize: 11.5, color: 'var(--fg-3)', margin: 0 }}>
        On a sale, 75% goes to you, 10% to the original creator (royalty), and 15% to the
        protocol. Delist any time at no cost.
      </p>
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

// ── Featured slot bid (PB-308) ──
function BidModal({ actor, card, identity, host, rootKey, backendCanisterId, toBeatUsdE8s, onClose, onDone }: {
  actor: any;
  card: CourseCard;
  identity: any;
  host: string;
  rootKey?: Uint8Array;
  backendCanisterId: string;
  toBeatUsdE8s?: bigint;
  onClose: () => void;
  onDone: () => void;
}) {
  const [token, setToken] = useState<ExplorerToken>(ExplorerToken.CkUSDC);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [rates, setRates] = useState<Map<ExplorerToken, bigint>>(new Map());
  const [ledgers, setLedgers] = useState<Map<ExplorerToken, Principal>>(new Map());

  const meta = BID_TOKENS.find((t) => t.token === token)!;

  useEffect(() => {
    (async () => {
      try {
        const rs = await actor.get_usd_rates();
        const m = new Map<ExplorerToken, bigint>();
        for (const r of rs) m.set(r.token as unknown as ExplorerToken, r.rate_usd_e8s);
        setRates(m);
      } catch { /* preview is best-effort */ }
      try {
        const info = await actor.get_explorer_info();
        const m = new Map<ExplorerToken, Principal>();
        m.set(ExplorerToken.CkBTC, info.ckbtc_ledger);
        m.set(ExplorerToken.CkETH, info.cketh_ledger);
        m.set(ExplorerToken.CkUSDC, info.ckusdc_ledger);
        m.set(ExplorerToken.CkUSDT, info.ckusdt_ledger);
        setLedgers(m);
      } catch { /* needed for approve; surfaced at submit */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const units = parseTokenUnits(amount, meta.decimals);
  const rate = rates.get(token);
  const bidUsd = units !== null && rate !== undefined ? tokenAmountUsdE8s(units, rate, meta.decimals) : null;
  const beats = bidUsd !== null && (toBeatUsdE8s === undefined || bidBeats(bidUsd, toBeatUsdE8s));

  const submit = async () => {
    if (busy || !identity) return;
    if (units === null || units <= 0n) { setErr('Enter an amount greater than 0.'); return; }
    const ledger = ledgers.get(token);
    if (!ledger) { setErr('Token ledger unavailable — try again in a moment.'); return; }
    setBusy(true); setErr(null);
    try {
      setStep(`Step 1/2: Approving ${amount} ${meta.label}…`);
      const approver = makeApprover(ledger.toString(), { host, identity, rootKey });
      const appr = await approver.icrc2_approve({
        from_subaccount: [],
        spender: { owner: Principal.fromText(backendCanisterId), subaccount: [] },
        amount: units + meta.fallbackFee,
        expected_allowance: [], expires_at: [], fee: [], memo: [], created_at_time: [],
      });
      if (appr.Err !== undefined) throw new Error(`Approval failed: ${JSON.stringify(appr.Err, (_k, v) => typeof v === 'bigint' ? v.toString() : v)}`);

      setStep('Step 2/2: Placing your bid…');
      const res = await actor.bid_featured_slot(card.token_id, token, units);
      if (res.__kind__ === 'Err') throw new Error(bidErr(res.Err));
      setDone(true);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell title={`Feature "${card.name || `Course #${card.token_id}`}"`} onClose={() => !busy && onClose()}>
      {done ? (
        <div className="col" style={{ gap: 12 }}>
          <span className="row" style={{ gap: 8, color: 'var(--ok)', fontSize: 13 }}>
            <Icon name="checkCircle" size={16} stroke="var(--ok)" />
            This course is now featured at the top of the marketplace.
          </span>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Btn variant="primary" sm onClick={onDone}>Done</Btn>
          </div>
        </div>
      ) : (
        <>
          <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: 0 }}>
            Pin this course to the featured slot. The highest USD bid wins.
            {toBeatUsdE8s !== undefined && (
              <> Current bid to beat: <b className="mono" style={{ color: 'var(--burn-ink)' }}>{fmtUsd(toBeatUsdE8s)}</b>.</>
            )}
          </p>
          <div className="col" style={{ gap: 6 }}>
            <label style={{ fontSize: 11, color: 'var(--fg-3)' }}>Token</label>
            <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
              {BID_TOKENS.map((t) => (
                <Pill key={t.label} active={token === t.token} onClick={() => setToken(t.token)}>{t.label}</Pill>
              ))}
            </div>
          </div>
          <div className="col" style={{ gap: 6 }}>
            <label style={{ fontSize: 11, color: 'var(--fg-3)' }}>Amount ({meta.label})</label>
            <input className="burn-input" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 50" inputMode="decimal" />
          </div>
          {bidUsd !== null && (
            <span className="mono" style={{ fontSize: 11.5, color: beats ? 'var(--ok)' : 'var(--fg-3)' }}>
              ≈ {fmtUsd(bidUsd)}{!beats && toBeatUsdE8s !== undefined ? ' — below the current bid' : ''}
            </span>
          )}
          <p style={{ fontSize: 11, color: 'var(--fg-3)', margin: 0 }}>100% goes to the treasury and is non-refundable, even if you're later outbid.</p>
          {busy && step && <span className="row" style={{ gap: 8, fontSize: 12, color: 'var(--fg-2)' }}><LiveDot size={7} /> {step}</span>}
          {err && <span style={{ fontSize: 12, color: 'var(--ember)' }}>{err}</span>}
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <Btn variant="ghost" sm disabled={busy} onClick={onClose}>Cancel</Btn>
            <Btn variant="primary" sm disabled={busy} onClick={submit}>{busy ? 'Working…' : 'Place bid'}</Btn>
          </div>
        </>
      )}
    </ModalShell>
  );
}

function bidErr(code: string): string {
  if (code.startsWith('BID_TOO_LOW')) {
    const parts = code.split(':');
    const usd = parts[1] ? fmtUsd(BigInt(parts[1])) : 'the current bid';
    return `Your bid is too low — you must beat ${usd}.`;
  }
  switch (code) {
    case 'UNSUPPORTED_TOKEN': return 'ICP is not accepted for featured bids — use a ck-token.';
    case 'NOT_LISTABLE': return 'This course cannot be featured.';
    case 'BAD_AMOUNT': return 'Enter a valid amount.';
    default: return code;
  }
}

// ── Ratings (PB-310) ──
function RateModal({ actor, card, onClose, onDone }: {
  actor: any;
  card: CourseCard;
  onClose: () => void;
  onDone: () => void;
}) {
  const [summary, setSummary] = useState<CourseRatingSummary | null>(null);
  const [reviews, setReviews] = useState<Rating[]>([]);
  const [stars, setStars] = useState(0);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const s: CourseRatingSummary = await actor.get_course_rating_summary(card.token_id);
        setSummary(s);
        if (s.my_stars !== undefined && s.my_stars !== null) setStars(s.my_stars);
      } catch { /* ignore */ }
      try { setReviews(await actor.list_course_reviews(card.token_id, 0n, 10n)); } catch { /* ignore */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    if (busy) return;
    if (stars < 1 || stars > 5) { setErr('Pick 1–5 stars.'); return; }
    if (text.length > 280) { setErr('Review must be 280 characters or fewer.'); return; }
    setBusy(true); setErr(null);
    try {
      const res = await actor.rate_course(card.token_id, stars, text.trim() ? text.trim() : null);
      if (res.__kind__ === 'Err') throw new Error(rateErr(res.Err));
      setDone(true);
      onDone();
    } catch (e: any) { setErr(e?.message || String(e)); } finally { setBusy(false); }
  };

  return (
    <ModalShell title={`Rate "${card.name || `Course #${card.token_id}`}"`} onClose={() => !busy && onClose()}>
      {summary && (
        <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>{formatRating(summary.avg_x10, summary.count)}</span>
      )}
      {done ? (
        <span className="row" style={{ gap: 8, color: 'var(--ok)', fontSize: 13 }}>
          <Icon name="checkCircle" size={16} stroke="var(--ok)" /> Thanks — your rating was saved.
        </span>
      ) : (
        <>
          <div className="row" style={{ gap: 4 }}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} onClick={() => setStars(n)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 2 }} title={`${n} star${n === 1 ? '' : 's'}`}>
                <Icon name="star" size={22} stroke="var(--burn-ink)" fill={n <= stars ? 'var(--burn)' : 'none'} />
              </button>
            ))}
          </div>
          <div className="col" style={{ gap: 4 }}>
            <textarea
              className="burn-input"
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, 280))}
              placeholder="Optional — a short review (≤ 280 chars)"
              rows={3}
              style={{ resize: 'vertical' }}
            />
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)', alignSelf: 'flex-end' }}>{text.length}/280</span>
          </div>
          <p style={{ fontSize: 11, color: 'var(--fg-3)', margin: 0 }}>You can rate a course once you've completed a full round of it.</p>
          {err && <span style={{ fontSize: 12, color: 'var(--ember)' }}>{err}</span>}
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <Btn variant="ghost" sm disabled={busy} onClick={onClose}>Cancel</Btn>
            <Btn variant="primary" sm disabled={busy} onClick={submit}>{busy ? 'Saving…' : summary?.my_stars ? 'Update rating' : 'Submit rating'}</Btn>
          </div>
        </>
      )}

      {reviews.length > 0 && (
        <div className="col" style={{ gap: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
          {reviews.map((r, i) => (
            <div key={i} className="col" style={{ gap: 2 }}>
              <span className="row" style={{ gap: 4 }}>
                {Array.from({ length: 5 }, (_, n) => (
                  <Icon key={n} name="star" size={11} stroke="var(--burn-ink)" fill={n < r.stars ? 'var(--burn)' : 'none'} />
                ))}
                <span className="mono" style={{ fontSize: 10, color: 'var(--fg-3)' }}>{formatPrincipal(r.rater)}</span>
              </span>
              {r.text && <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>{r.text}</span>}
            </div>
          ))}
        </div>
      )}
    </ModalShell>
  );
}

function rateErr(code: string): string {
  switch (code) {
    case 'MUST_COMPLETE_ROUND': return 'Finish a full round of this course before rating it.';
    case 'CANNOT_RATE_OWN_COURSE': return 'You cannot rate a course you created or own.';
    case 'BAD_STARS': return 'Pick 1–5 stars.';
    case 'TEXT_TOO_LONG': return 'Review must be 280 characters or fewer.';
    case 'NO_COURSE': return 'This course no longer exists.';
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
