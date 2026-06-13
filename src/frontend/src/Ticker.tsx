import { useMemo, useState, useEffect } from 'react';

// A global ESPN-style scrolling ticker, rendered just below the top bar on
// every page. Shows open votes, a rotating feature promo, and live crypto
// prices, scrolling continuously and pausing on hover.

export interface TickerProposal {
  id: bigint;
  title: string;
  deadline: bigint; // ns
  status: string;
  vote_executed_at?: bigint;
}

export interface TickerPromo {
  emoji: string;
  label: string;
  go: () => void;
}

interface TickerProps {
  proposals: TickerProposal[];
  /** keyed by token variant ("ICP" | "CkBTC" | "CkETH" | …), USD e8s per token. */
  usdRates: Record<string, bigint>;
  promos: TickerPromo[];
  onVote: (id: bigint) => void;
}

export function truncTitle(t: string): string {
  const s = t.trim();
  return s.length > 15 ? s.slice(0, 15) + '…' : s;
}

export function fmtUsd(rateE8s: bigint | undefined): string | null {
  if (!rateE8s || rateE8s <= 0n) return null;
  const usd = Number(rateE8s) / 1e8;
  if (usd >= 1000) return '$' + Math.round(usd).toLocaleString();
  return '$' + usd.toFixed(2);
}

export function closingLabel(deadlineNs: bigint, now: number): string | null {
  const ms = Number(deadlineNs / 1_000_000n) - now;
  if (ms <= 0) return null;
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'closing <1m';
  if (mins < 60) return `closing ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `closing ${hrs}h`;
  return null;
}

export default function Ticker({ proposals, usdRates, promos, onVote }: TickerProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  // One stable promo per mount (randomly selected, re-rolls if the set changes).
  const promo = useMemo(() => (promos.length ? promos[Math.floor(Math.random() * promos.length)] : null), [promos.length]);

  // Open votes: still accepting votes (deadline in the future, not executed).
  const openVotes = useMemo(
    () => proposals.filter((p) => !p.vote_executed_at && Number(p.deadline / 1_000_000n) > now).slice(0, 12),
    [proposals, now],
  );

  const crypto = useMemo(() => {
    const items: { label: string; price: string }[] = [];
    for (const [key, label] of [['ICP', 'ICP'], ['CkBTC', 'ckBTC'], ['CkETH', 'ckETH']] as const) {
      const p = fmtUsd(usdRates[key]);
      if (p) items.push({ label, price: p });
    }
    return items;
  }, [usdRates]);

  // Build the ordered run of segments: VOTES … · promo · CRYPTO …
  const segments: React.ReactNode[] = [];
  segments.push(<span key="lbl-votes" className="ticker-label">Open Votes</span>);
  if (openVotes.length === 0) {
    segments.push(<span key="no-votes" className="ticker-item ticker-dim">No open votes right now</span>);
  } else {
    for (const p of openVotes) {
      const closing = closingLabel(p.deadline, now);
      segments.push(
        <span key={`v-${p.id}`} className="ticker-item ticker-link" onClick={() => onVote(p.id)}>
          <span aria-hidden>🗳️</span> Proposal: {String(p.id)} {truncTitle(p.title)}
          {closing && <span className="ticker-flag">⚡ {closing}</span>}
        </span>,
      );
    }
  }
  if (promo) {
    segments.push(
      <span key="promo" className="ticker-item ticker-promo" onClick={promo.go}>
        <span aria-hidden>{promo.emoji}</span> {promo.label} →
      </span>,
    );
  }
  if (crypto.length) {
    segments.push(<span key="lbl-crypto" className="ticker-label ticker-label-alt">Crypto</span>);
    for (const c of crypto) {
      segments.push(
        <span key={`c-${c.label}`} className="ticker-item">
          <span aria-hidden>💹</span> {c.label} <span className="ticker-num">{c.price}</span>
        </span>,
      );
    }
  }

  // Nothing meaningful to show → render nothing (keeps the band from being empty).
  if (segments.length <= 1 && openVotes.length === 0 && !promo && !crypto.length) return null;

  // Duplicate the run so the linear translate(-50%) loops seamlessly.
  const run = (copy: number) => (
    <div className="ticker-run" aria-hidden={copy === 1 ? true : undefined}>
      {segments.map((s, i) => (
        <span className="ticker-seg" key={`${copy}-${i}`}>{s}</span>
      ))}
    </div>
  );

  return (
    <div className="ticker" role="region" aria-label="Open votes and market prices">
      <div className="ticker-track">
        {run(0)}
        {run(1)}
      </div>
    </div>
  );
}
