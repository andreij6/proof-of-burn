import { useEffect, useState, useCallback } from 'react';
import { Principal } from '@icp-sdk/core/principal';
import { PokerStyle } from './bindings/backend';
import type { PokerLobbyRow, PokerTableView, PokerSeatView, MyPokerAgentView, PokerHandView } from './bindings/backend';
import { Icon, Eyebrow, Chip, Btn, LiveDot, MoreInfo, formatPrincipal } from './ui';
import { cardLabel, cardIsRed, fmtChips, chipsToVp } from './cards';

interface PokerProps {
  actor: any;
  principal: Principal | null;
  onSignIn: () => void;
  onGoStaking: () => void;
}

function opt<T>(o: any): T | null {
  if (!o) return null;
  if (o.__kind__ === 'Some') return o.value as T;
  if (Array.isArray(o)) return o.length ? (o[0] as T) : null;
  return null;
}

const card: React.CSSProperties = { background: 'var(--char-925)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 };

// ── A single card face (or back) ──
function CardFace({ c, hidden, sm }: { c?: number; hidden?: boolean; sm?: boolean }) {
  const w = sm ? 26 : 34;
  const h = sm ? 36 : 48;
  const base: React.CSSProperties = {
    width: w, height: h, borderRadius: 5, display: 'inline-flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: sm ? 12 : 15,
    lineHeight: 1, fontVariantNumeric: 'tabular-nums', flex: '0 0 auto',
  };
  if (hidden || c === undefined) {
    return <span style={{ ...base, background: 'repeating-linear-gradient(45deg,#3a2b4a,#3a2b4a 4px,#2c2238 4px,#2c2238 8px)', border: '1px solid var(--border-hi)' }} />;
  }
  const red = cardIsRed(c);
  return (
    <span style={{ ...base, background: '#f4f1ea', color: red ? '#c0392b' : '#1b1b1b', border: '1px solid #0006' }}>
      {cardLabel(c)}
    </span>
  );
}

// ── The felt table with 9 seat pods around an oval ──
function TableFelt({ view, mySeat }: { view: PokerTableView; mySeat: number | null }) {
  const seats = view.seats;
  const acting = opt<number>(view.acting_seat as any);
  const board: number[] = (view.board as any).map((x: any) => Number(x));
  return (
    <div style={{ position: 'relative', width: '100%', paddingTop: '62%', minHeight: 380 }}>
      {/* felt */}
      <div style={{
        position: 'absolute', inset: '6%', borderRadius: '46% / 50%',
        background: 'radial-gradient(ellipse at center, #1d6b46 0%, #134d33 70%, #0e3b27 100%)',
        border: '6px solid #3a2418', boxShadow: 'inset 0 0 60px #0008',
      }} />
      {/* board + pot */}
      <div style={{ position: 'absolute', top: '38%', left: '50%', transform: 'translate(-50%,-50%)', textAlign: 'center', width: '70%' }}>
        <div style={{ color: '#d7ead9', fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
          Pot: {fmtChips(Number(view.pot_chips))} chips
        </div>
        <div className="row" style={{ gap: 5, justifyContent: 'center' }}>
          {[0, 1, 2, 3, 4].map((i) => (board[i] !== undefined ? <CardFace key={i} c={board[i]} /> : <span key={i} style={{ width: 34, height: 48, borderRadius: 5, border: '1px dashed #ffffff22' }} />))}
        </div>
        {view.last_result && opt<string>(view.last_result as any) && (
          <div style={{ marginTop: 8, color: '#ffe08a', fontSize: 12, fontWeight: 700 }}>{opt<string>(view.last_result as any)}</div>
        )}
      </div>
      {/* seat pods */}
      {seats.map((s: PokerSeatView, i: number) => {
        const theta = ((90 + i * (360 / seats.length)) * Math.PI) / 180;
        const x = 50 + 44 * Math.cos(theta);
        const y = 50 + 42 * Math.sin(theta);
        const isMine = mySeat === i;
        const isActing = acting === i;
        const folded = s.status === 'folded';
        const allIn = s.status === 'all-in';
        const hole = opt<number[]>(s.hole as any);
        const handLive = view.phase !== 'waiting' && view.phase !== 'done';
        return (
          <div key={i} style={{
            position: 'absolute', left: `${x}%`, top: `${y}%`, transform: 'translate(-50%,-50%)',
            width: 116, textAlign: 'center', opacity: folded ? 0.4 : 1, transition: 'opacity 0.3s',
          }}>
            {s.occupied ? (
              <div style={{
                background: isMine ? 'var(--burn-950)' : 'var(--char-950)',
                border: `1px solid ${isActing ? 'var(--burn)' : allIn ? 'var(--ember)' : isMine ? 'var(--burn)' : 'var(--border)'}`,
                borderRadius: 10, padding: '5px 6px', boxShadow: isActing ? '0 0 12px var(--burn)' : 'none',
                animation: isActing ? 'pulse 1.2s ease-in-out infinite' : 'none',
              }}>
                <div style={{ fontSize: 10, color: 'var(--fg-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {s.principal && opt<Principal>(s.principal as any) ? formatPrincipal(Principal.fromText(opt<Principal>(s.principal as any)!.toString())) : '—'}
                </div>
                <div style={{ fontSize: 9, color: 'var(--haze)', marginBottom: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.model || '—'}</div>
                <div className="row" style={{ gap: 3, justifyContent: 'center', minHeight: 36, alignItems: 'center' }}>
                  {hole && hole.length === 2 ? (
                    <><CardFace c={Number(hole[0])} sm /><CardFace c={Number(hole[1])} sm /></>
                  ) : handLive && !folded ? (
                    <><CardFace hidden sm /><CardFace hidden sm /></>
                  ) : null}
                </div>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--fg)' }}>{fmtChips(Number(s.stack_chips))}</div>
                {Number(s.committed_chips) > 0 && <Chip tone="muted" style={{ fontSize: 9, marginTop: 2 }}>bet {fmtChips(Number(s.committed_chips))}</Chip>}
                {view.button === i && <span style={{ position: 'absolute', marginLeft: 4, fontSize: 9, color: 'var(--char-950)', background: '#e8e8e8', borderRadius: 99, padding: '0 4px', fontWeight: 800 }}>D</span>}
                {allIn && <div style={{ fontSize: 9, color: 'var(--ember)', fontWeight: 700 }}>ALL-IN</div>}
              </div>
            ) : (
              <div style={{ border: '1px dashed var(--border)', borderRadius: 10, padding: '12px 6px', color: 'var(--fg-3)', fontSize: 10 }}>open seat</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export const POKER_NO_LOSS = 'Chips are voting power — your staked ICP is never at risk. We take 0% rake, forever: every chip in the pot goes to a player.';

export default function Poker({ actor, principal, onSignIn, onGoStaking }: PokerProps) {
  const signedIn = !!principal && !principal.isAnonymous();
  const [lobby, setLobby] = useState<PokerLobbyRow[]>([]);
  const [agent, setAgent] = useState<MyPokerAgentView | null>(null);
  const [table, setTable] = useState<PokerTableView | null>(null);
  const [history, setHistory] = useState<PokerHandView[]>([]);
  const [watch, setWatch] = useState<number | null>(null);
  const [extInput, setExtInput] = useState('');
  const [modelInput, setModelInput] = useState('claude-fable-5');
  const [stopInput, setStopInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);

  const mySeat = agent ? opt<number>(agent.seat as any) : null;
  const myTableId = agent ? opt<number>(agent.table_id as any) : null;
  const focusTable = myTableId ?? watch;

  const refresh = useCallback(async () => {
    if (!actor) return;
    try {
      actor.poker_poke?.().catch(() => {}); // drive the tables (local replica)
      const [lb, ag] = await Promise.all([actor.get_poker_lobby(), signedIn ? actor.get_my_poker_agent() : Promise.resolve(null)]);
      setLobby(lb);
      if (ag) setAgent(ag);
      const seatTid = ag ? opt<number>(ag.table_id) : null;
      const tid = seatTid ?? watch;
      if (tid != null) {
        const tv = seatTid != null ? await actor.get_my_table_view() : await actor.get_table_public(Number(tid));
        setTable(opt<PokerTableView>(tv) ?? (Array.isArray(tv) ? null : tv) ?? null);
        const h = await actor.get_poker_history(Number(tid), 8n);
        setHistory(h);
      } else {
        setTable(null);
      }
    } catch { /* transient */ }
  }, [actor, signedIn, watch]);

  useEffect(() => {
    refresh();
    const live = table && table.phase !== 'waiting' && table.phase !== 'idle';
    const t = setInterval(refresh, live ? 2000 : 3500);
    return () => clearInterval(t);
  }, [refresh, table?.phase]);

  // local animation clock (acting pulse / countdown feel)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, []);

  const run = async (fn: () => Promise<void>) => {
    if (!actor || busy) return;
    setBusy(true); setError(null);
    try { await fn(); await refresh(); }
    catch (e: any) { setError(String(e?.message ?? e)); }
    finally { setBusy(false); }
  };
  const okOrThrow = (res: any) => { if (res && res.__kind__ === 'Err') throw new Error(res.Err); };

  const claimHouse = () => run(async () => okOrThrow(await actor.claim_poker_agent(principal, '')));
  const claimExternal = () => run(async () => {
    const p = Principal.fromText(extInput.trim());
    okOrThrow(await actor.claim_poker_agent(p, modelInput.trim()));
  });
  const setStyle = (s: PokerStyle) => run(async () => okOrThrow(await actor.set_poker_style(s)));
  const findSeat = () => run(async () => okOrThrow(await actor.poker_find_seat()));
  const leave = () => run(async () => okOrThrow(await actor.poker_leave()));
  const setStop = () => run(async () => {
    const vp = Number(stopInput);
    okOrThrow(await actor.set_poker_stop_loss(BigInt(Math.max(0, Math.floor(vp * 100_000_000)))));
  });

  const styleLabel = (s: any) => (s && s.__kind__) ? s.__kind__ : (typeof s === 'string' ? s : 'Tag');
  const state = agent?.state ?? 'none';
  const searching = state === 'searching' || state === 'waitlisted';

  return (
    <div className="col" style={{ gap: 16 }}>
      <style>{`@keyframes pulse{0%,100%{box-shadow:0 0 6px var(--burn)}50%{box-shadow:0 0 18px var(--burn)}}`}</style>

      {/* Page header (subtitle · title · how it works) */}
      <div className="col" style={{ gap: 6 }}>
        <Eyebrow accent>Caldera Hold'em · 0% rake, forever</Eyebrow>
        <span className="row" style={{ gap: 10, alignItems: 'center' }}>
          <Icon name="zap" size={22} stroke="var(--burn)" />
          <h4 style={{ margin: 0 }}>Poker</h4>
          <Chip tone="muted">No-Limit · 25/50 · agents only</Chip>
        </span>
        <p style={{ fontSize: 13, color: 'var(--fg-2)', maxWidth: 600 }}>
          Your agent plays No-Limit Hold'em while you watch — your staked ICP is never at risk.{' '}
          <MoreInfo title="How Caldera Hold'em works">
            <p>Your <b>agent</b> plays — you spectate. Claim one agent: let the house play your chosen style, or register your own bot principal.</p>
            <p>Chips = voting power × 1,000, drawn from your staked ICP. Wins and losses move voting power between players; your staked ICP is never touched and is always unstakeable in full. We take <b>0% rake</b>.</p>
            <p>Go broke and your ICP is still yours — stake more to rebuild voting power. A stop-loss stands your agent up before that.</p>
          </MoreInfo>
        </p>
      </div>

      {!signedIn ? (
        <div style={card}><Btn variant="primary" onClick={onSignIn}>Sign in to play</Btn></div>
      ) : (
        <>
          {/* Agent Space */}
          <div style={card}>
            <Eyebrow>Agent Space</Eyebrow>
            {!agent?.claimed ? (
              <div className="col" style={{ gap: 10, marginTop: 8 }}>
                <p style={{ color: 'var(--fg-2)', fontSize: 13 }}>Claim your one agent to play. Bankroll: <b>{fmtChips(Number(agent?.chips ?? 0))}</b> chips (≈ {chipsToVp(Number(agent?.chips ?? 0))} VP).</p>
                {Number(agent?.chips ?? 0) < 500 && (
                  <Chip tone="danger">Need ≥ 500 chips (0.5 VP) to sit — <button onClick={onGoStaking} style={{ background: 'none', border: 'none', color: 'var(--burn)', cursor: 'pointer', padding: 0 }}>stake ICP →</button></Chip>
                )}
                <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <Btn variant="primary" disabled={busy} onClick={claimHouse}>Let Caldera play for me</Btn>
                  <span style={{ color: 'var(--fg-3)', fontSize: 12 }}>or register your own bot:</span>
                </div>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <label className="col" style={{ gap: 3, fontSize: 11, color: 'var(--fg-3)' }}>agent principal
                    <input value={extInput} onChange={(e) => setExtInput(e.target.value)} placeholder="aaaaa-aa…" style={{ width: 220, padding: '6px 8px', background: 'var(--char-950)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--fg)' }} /></label>
                  <label className="col" style={{ gap: 3, fontSize: 11, color: 'var(--fg-3)' }}>declared model
                    <input value={modelInput} onChange={(e) => setModelInput(e.target.value)} style={{ width: 150, padding: '6px 8px', background: 'var(--char-950)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--fg)' }} /></label>
                  <Btn variant="secondary" disabled={busy || !extInput.trim()} onClick={claimExternal}>Register bot</Btn>
                </div>
              </div>
            ) : (
              <div className="col" style={{ gap: 10, marginTop: 8 }}>
                <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  <Chip tone={agent.mode === 'house' ? 'muted' : 'ok'}>{agent.mode === 'house' ? 'house agent' : 'external bot'}</Chip>
                  <Chip tone="muted">{agent.model}</Chip>
                  <span style={{ color: 'var(--fg-2)', fontSize: 13 }}>{fmtChips(Number(agent.chips))} chips (≈ {chipsToVp(Number(agent.chips))} VP)</span>
                  <Chip tone={state === 'seated' ? 'ok' : state === 'stoplosshit' ? 'danger' : 'muted'}>{state}</Chip>
                </div>
                {/* play style */}
                <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>style:</span>
                  {[PokerStyle.Tag, PokerStyle.Lag, PokerStyle.Nit, PokerStyle.Station].map((s) => (
                    <Btn key={String(s)} sm variant={styleLabel(agent.style) === String(s) ? 'primary' : 'ghost'} disabled={busy} onClick={() => setStyle(s)}>{String(s)}</Btn>
                  ))}
                </div>
                {/* stop-loss */}
                <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <label className="col" style={{ gap: 3, fontSize: 11, color: 'var(--fg-3)' }}>stop-loss floor (VP)
                    <input value={stopInput} onChange={(e) => setStopInput(e.target.value)} placeholder={(Number(agent.stop_loss_e8s) / 1e8).toFixed(2)} inputMode="decimal" style={{ width: 110, padding: '6px 8px', background: 'var(--char-950)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--fg)' }} /></label>
                  <Btn variant="secondary" sm disabled={busy || !stopInput.trim()} onClick={setStop}>Set</Btn>
                  <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>current: {(Number(agent.stop_loss_e8s) / 1e8).toFixed(2)} VP</span>
                </div>
                {state === 'stoplosshit' && (
                  <Chip tone="danger">Your agent stopped at your floor. <button onClick={onGoStaking} style={{ background: 'none', border: 'none', color: 'var(--burn)', cursor: 'pointer', padding: 0 }}>Stake &amp; get back in →</button></Chip>
                )}
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  {state === 'idle' || state === 'stoplosshit' ? (
                    <Btn variant="primary" disabled={busy} onClick={findSeat}>Send my agent to a table</Btn>
                  ) : (
                    <Btn variant="secondary" disabled={busy} onClick={leave}>Recall agent (stand up after this hand)</Btn>
                  )}
                </div>
              </div>
            )}
            {error && <p style={{ color: 'var(--ember)', fontSize: 12, marginTop: 8 }}>{error}</p>}
          </div>

          {searching && (
            <div style={{ ...card, textAlign: 'center' }}>
              <LiveDot color="var(--burn)" /> <span style={{ color: 'var(--fg-2)' }}>Searching for a table…</span>
              {agent && opt<number>(agent.waitlist_pos as any) != null && <span style={{ color: 'var(--fg-3)', fontSize: 12 }}> (waitlist #{opt<number>(agent.waitlist_pos as any)})</span>}
            </div>
          )}
        </>
      )}

      {/* Table view (seated or watching) */}
      {focusTable != null && table ? (
        <div style={card}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <Eyebrow>Table {table.table_id} · hand #{String(table.hand_no)} · {table.phase}</Eyebrow>
            {myTableId == null && <Btn variant="ghost" sm onClick={() => { setWatch(null); setTable(null); }}>← Lobby</Btn>}
          </div>
          <TableFelt view={table} mySeat={mySeat} />
          {mySeat != null && (
            <p style={{ color: 'var(--fg-3)', fontSize: 12, textAlign: 'center', marginTop: 6 }}>Your agent is playing this seat — sit back and watch.</p>
          )}
          {/* recent hands */}
          {history.length > 0 && (
            <div className="col" style={{ gap: 3, marginTop: 10, fontSize: 12 }}>
              <Eyebrow>Recent hands</Eyebrow>
              {history.map((h) => (
                <div key={String(h.id)} className="row" style={{ justifyContent: 'space-between', color: 'var(--fg-3)', borderBottom: '1px solid var(--border)', padding: '3px 0' }}>
                  <span>#{String(h.hand_no)} · {h.winners_msg}</span>
                  <span className="row" style={{ gap: 3 }}>{(h.board as any).map((c: any, i: number) => <CardFace key={i} c={Number(c)} sm />)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        /* Lobby */
        <div style={card}>
          <Eyebrow>Lobby · 10 tables</Eyebrow>
          <div className="col" style={{ gap: 4, marginTop: 8 }}>
            <div className="row" style={{ color: 'var(--fg-3)', fontSize: 11, borderBottom: '1px solid var(--border)', padding: '2px 4px' }}>
              <span style={{ flex: '1 1 0' }}>Table</span>
              <span style={{ flex: '1 1 0', textAlign: 'center' }}>Players</span>
              <span style={{ flex: '1 1 0', textAlign: 'center' }}>Pot</span>
              <span style={{ flex: '1 1 0', textAlign: 'center' }}>Phase</span>
              <span style={{ flex: '0 0 70px', textAlign: 'right' }}></span>
            </div>
            {lobby.map((r) => {
              const taken = Number(r.seats_taken);
              const max = Number(r.max_seats);
              const full = taken >= max;
              return (
                <div key={Number(r.table_id)} className="row" style={{ alignItems: 'center', fontSize: 12, padding: '3px 4px' }}>
                  <span style={{ flex: '1 1 0' }}>Caldera {Number(r.table_id)}</span>
                  <span style={{ flex: '1 1 0', textAlign: 'center', color: full ? 'var(--ember)' : 'var(--sprout)' }}>
                    {full ? `FULL${Number(r.waitlist_len) > 0 ? ` (${Number(r.waitlist_len)} wl)` : ''}` : `${taken} / ${max}`}
                  </span>
                  <span style={{ flex: '1 1 0', textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>{fmtChips(Number(r.pot_chips))}</span>
                  <span style={{ flex: '1 1 0', textAlign: 'center', color: 'var(--fg-3)' }}>{r.phase}</span>
                  <span style={{ flex: '0 0 70px', textAlign: 'right' }}>
                    <Btn variant="ghost" sm onClick={() => setWatch(Number(r.table_id))}>Watch</Btn>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
