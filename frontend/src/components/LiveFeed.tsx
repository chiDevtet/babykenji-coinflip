import { useEffect, useRef, useState } from "react";
import { getRecentBets } from "../lib/api";
import { type Asset } from "../lib/constants";

// Real-time global feed of settled flips. Live mode polls GET /api/bets/recent
// every few seconds (paused when the tab is hidden); demo mode never touches the
// network and instead renders believable simulated rows plus the user's own demo
// flips. A future upgrade could replace polling with SSE/WebSocket once the
// backend exposes a stream — none exists today, so polling is the no-infra choice.

const POLL_MS = 4000; // live polling cadence
const SYNTH_MS = 7000; // demo: add a simulated row this often
const CLOCK_MS = 5000; // refresh "12s ago" labels
const CAP = 50; // max rows kept / shown

/** One row in the feed. Mirrors the public fields returned by GET /api/bets/recent. */
export interface FeedFlip {
  player: string;
  nonce: number;
  choice: number; // 0 heads, 1 tails
  asset: Asset; // "token" | "sol"
  amount: string; // base units
  payout: string; // base units
  won: boolean;
  settleTx: string | null;
  createdAt: string; // ISO timestamp
}

interface Props {
  demo: boolean;
  tokenSymbol: string;
  tokenDecimals: number;
  ownFlips: FeedFlip[];
}

const flipKey = (f: { player: string; nonce: number }) => `${f.player}:${f.nonce}`;

/** Merge incoming rows into existing: dedupe by player:nonce, newest-first, cap. */
function mergeRows(prev: FeedFlip[], incoming: FeedFlip[]): FeedFlip[] {
  if (incoming.length === 0) return prev;
  const have = new Set(prev.map(flipKey));
  const fresh = incoming.filter((f) => !have.has(flipKey(f)));
  if (fresh.length === 0) return prev;
  const merged = [...fresh, ...prev];
  // ISO 8601 sorts correctly as plain strings, so this yields strict newest-first.
  merged.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return merged.slice(0, CAP);
}

function fmtBase(base: bigint, decimals: number): string {
  const d = 10n ** BigInt(decimals);
  const whole = base / d;
  const frac = (base % d).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function fmtAmount(raw: string, decimals: number): string {
  try {
    return fmtBase(BigInt(raw), decimals);
  } catch {
    return "0";
  }
}

function truncAddr(a: string): string {
  return a && a.length > 8 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

function relTime(iso: string, now: number): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ---- Demo data (only used when demo === true; never hits the network) ----
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function randB58(len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += B58[Math.floor(Math.random() * B58.length)];
  return s;
}
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
const SOL_UI = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2];
const TOKEN_UI = [1, 5, 10, 25, 50, 100, 250];
function toBase(ui: number, decimals: number): bigint {
  return BigInt(Math.round(ui * 10 ** decimals));
}

/** One believable simulated flip, `agoSec` seconds in the past. */
function synthRow(tokenDecimals: number, id: number, agoSec: number): FeedFlip {
  const isSol = Math.random() < 0.4;
  const asset: Asset = isSol ? "sol" : "token";
  const decimals = isSol ? 9 : tokenDecimals;
  const amount = isSol ? toBase(pick(SOL_UI), 9) : toBase(pick(TOKEN_UI), tokenDecimals);
  const won = Math.random() < 0.5;
  const payout = won ? (amount * 178n) / 100n : 0n; // 1.78x default payout with a 1% vault reserve edge
  return {
    player: randB58(44),
    nonce: id,
    choice: Math.random() < 0.5 ? 0 : 1,
    asset,
    amount: amount.toString(),
    payout: payout.toString(),
    won,
    settleTx: randB58(88),
    createdAt: new Date(Date.now() - agoSec * 1000).toISOString(),
  };
}

function seedRows(tokenDecimals: number, startId: number, count: number): FeedFlip[] {
  const rows: FeedFlip[] = [];
  let ago = 4 + Math.floor(Math.random() * 6); // newest ~4–10s ago
  for (let i = 0; i < count; i++) {
    rows.push(synthRow(tokenDecimals, startId + i, ago));
    ago += 6 + Math.floor(Math.random() * 50); // staggered older entries
  }
  return rows;
}

export default function LiveFeed({ demo, tokenSymbol, tokenDecimals, ownFlips }: Props) {
  const [rows, setRows] = useState<FeedFlip[]>([]);
  const [now, setNow] = useState<number>(() => Date.now());
  const [loaded, setLoaded] = useState<boolean>(false);

  // Latest values for the demo generators without re-running their effects.
  const decimalsRef = useRef(tokenDecimals);
  decimalsRef.current = tokenDecimals;
  const ownFlipsRef = useRef(ownFlips);
  ownFlipsRef.current = ownFlips;
  const nextIdRef = useRef(1);

  // Relative-time clock — advances "12s ago" labels, paused while tab is hidden.
  useEffect(() => {
    const tick = () => {
      if (!document.hidden) setNow(Date.now());
    };
    const id = window.setInterval(tick, CLOCK_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  // LIVE: poll the backend (paused when hidden, immediate refresh on regaining focus).
  useEffect(() => {
    if (demo) return;
    setRows([]);
    setLoaded(false);
    let cancelled = false;
    let inFlight = false;
    let controller: AbortController | null = null;

    const poll = async () => {
      if (cancelled || inFlight || document.hidden) return;
      inFlight = true;
      controller = new AbortController();
      try {
        const bets = await getRecentBets(CAP, controller.signal);
        if (!cancelled) setRows((prev) => mergeRows(prev, bets as FeedFlip[]));
      } catch {
        // swallow — keep the last good rows, never surface a broken state
      } finally {
        inFlight = false;
        if (!cancelled) setLoaded(true);
      }
    };

    poll();
    const id = window.setInterval(poll, POLL_MS);
    const onVisible = () => {
      if (!document.hidden) poll();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      clearInterval(id);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [demo]);

  // DEMO: seed believable rows (plus any own flips so far), then add one periodically.
  useEffect(() => {
    if (!demo) return;
    const seeded = mergeRows(
      seedRows(decimalsRef.current, nextIdRef.current, 8),
      [...ownFlipsRef.current].reverse()
    );
    nextIdRef.current += 8;
    setRows(seeded);
    setLoaded(true);
    let cancelled = false;
    const id = window.setInterval(() => {
      if (cancelled || document.hidden) return;
      const row = synthRow(decimalsRef.current, nextIdRef.current++, 0);
      setRows((prev) => mergeRows(prev, [row]));
    }, SYNTH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [demo]);

  // Prepend the user's own demo flips as they happen.
  useEffect(() => {
    if (!demo || ownFlips.length === 0) return;
    setRows((prev) => mergeRows(prev, [...ownFlips].reverse()));
  }, [ownFlips, demo]);

  const showEmpty = loaded && rows.length === 0;

  return (
    <div className="panel live-feed">
      <div className="feed-header">
        <span className="live-dot" aria-hidden="true" />
        <span className="feed-title">Live Flips</span>
      </div>

      {!loaded ? (
        <div className="feed-empty muted">Loading recent flips…</div>
      ) : showEmpty ? (
        <div className="feed-empty">No flips yet — be the first.</div>
      ) : (
        <div className="flip-list" role="list">
          {rows.map((f) => (
            <FlipRow
              key={flipKey(f)}
              flip={f}
              now={now}
              tokenSymbol={tokenSymbol}
              tokenDecimals={tokenDecimals}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FlipRow({
  flip,
  now,
  tokenSymbol,
  tokenDecimals,
}: {
  flip: FeedFlip;
  now: number;
  tokenSymbol: string;
  tokenDecimals: number;
}) {
  const isSol = flip.asset === "sol";
  const decimals = isSol ? 9 : tokenDecimals;
  const symbol = isSol ? "SOL" : tokenSymbol;
  const isHeads = flip.choice === 0;
  const wager = fmtAmount(flip.amount, decimals);
  const payout = fmtAmount(flip.payout, decimals);
  const href = flip.settleTx ? `https://solscan.io/tx/${flip.settleTx}` : undefined;

  const inner = (
    <>
      <img
        className="flip-coin"
        src={isHeads ? "/coin-heads.png" : "/coin-tails.png"}
        alt=""
        draggable={false}
      />
      <div className="flip-main">
        <div className="flip-top">
          <span className="flip-addr mono">{truncAddr(flip.player)}</span>
          {flip.won ? (
            <span className="flip-result win mono">
              +{payout} {symbol}
            </span>
          ) : (
            <span className="flip-result lose">Loss</span>
          )}
        </div>
        <div className="flip-sub">
          <span className="flip-choice">{isHeads ? "Heads" : "Tails"}</span>
          <span className="flip-sep">·</span>
          <span className="flip-asset">
            <span className={`asset-dot ${isSol ? "sol" : "token"}`} />
            <span className="mono">
              {wager} {symbol}
            </span>
          </span>
          <span className="flip-sep">·</span>
          <span className="flip-time">{relTime(flip.createdAt, now)}</span>
        </div>
      </div>
      {href && (
        <span className="flip-link" aria-hidden="true">
          ↗
        </span>
      )}
    </>
  );

  return href ? (
    <a className="flip-row" href={href} target="_blank" rel="noopener noreferrer" role="listitem">
      {inner}
    </a>
  ) : (
    <div className="flip-row" role="listitem">
      {inner}
    </div>
  );
}
