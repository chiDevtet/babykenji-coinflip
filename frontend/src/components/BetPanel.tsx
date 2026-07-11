import { useState } from "react";
import { HEADS, TAILS, type Asset } from "../lib/constants";

interface Props {
  asset: Asset;
  onAsset: (a: Asset) => void;
  solEnabled: boolean;
  tokenSymbol: string;
  decimals: number;
  minBet: bigint;
  maxBet: bigint;
  houseFunded: boolean;
  balance: bigint;
  connected: boolean;
  paused: boolean;
  busy: boolean;
  error: string | null;
  /** Subtle non-error status (e.g. "Flip cancelled") shown in grey, not red. */
  notice: string | null;
  lastResult: { won: boolean; label: string; payout: string } | null;
  onFlip: (amountBaseUnits: bigint, choice: number) => void;
}

function toBaseUnits(ui: string, decimals: number): bigint | null {
  if (!ui || isNaN(Number(ui))) return null;
  const [whole, frac = ""] = ui.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  try {
    return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fracPadded || "0");
  } catch {
    return null;
  }
}

function fmt(base: bigint, decimals: number): string {
  const d = 10n ** BigInt(decimals);
  const whole = base / d;
  const frac = (base % d).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export default function BetPanel({
  asset,
  onAsset,
  solEnabled,
  tokenSymbol,
  decimals,
  minBet,
  maxBet,
  houseFunded,
  balance,
  connected,
  paused,
  busy,
  error,
  notice,
  lastResult,
  onFlip,
}: Props) {
  const [choice, setChoice] = useState<number>(HEADS);
  const [amount, setAmount] = useState<string>("");

  const symbol = asset === "sol" ? "SOL" : tokenSymbol;
  const base = toBaseUnits(amount, decimals);
  const tooSmall = base !== null && base < minBet;
  const tooBig = base !== null && base > maxBet;
  const insufficient = base !== null && base > balance;
  const validAmount = base !== null && base > 0n && !tooSmall && !tooBig && !insufficient;
  const canFlip = connected && !paused && houseFunded && !busy && validAmount;

  return (
    <div className="panel bet-panel">
      <div className="asset-toggle" role="tablist" aria-label="Wager asset">
        <button
          className={`asset ${asset === "token" ? "active" : ""}`}
          onClick={() => onAsset("token")}
          disabled={busy}
        >
          <span className="asset-dot token" /> {tokenSymbol}
        </button>
        <button
          className={`asset ${asset === "sol" ? "active" : ""}`}
          onClick={() => solEnabled && onAsset("sol")}
          disabled={busy || !solEnabled}
          title={solEnabled ? "" : "Enable a SOL config to flip with SOL (see README)"}
        >
          <span className="asset-dot sol" /> SOL{!solEnabled ? " · soon" : ""}
        </button>
      </div>

      <div className="choice-row">
        <button
          className={`choice ${choice === HEADS ? "active" : ""}`}
          onClick={() => setChoice(HEADS)}
          disabled={busy}
        >
          <img src="/coin-heads.png" alt="" />
          <span>Heads</span>
        </button>
        <button
          className={`choice ${choice === TAILS ? "active" : ""}`}
          onClick={() => setChoice(TAILS)}
          disabled={busy}
        >
          <img src="/coin-tails.png" alt="" />
          <span>Tails</span>
        </button>
      </div>

      <label className="amount-label">
        Wager · {symbol}
        <div className="amount-input">
          <input
            inputMode="decimal"
            placeholder="0.0"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
            disabled={busy}
          />
          <button
            className="max-btn"
            onClick={() => setAmount(fmt(balance < maxBet ? balance : maxBet, decimals))}
            disabled={busy}
          >
            MAX
          </button>
        </div>
        <div className="limits">
          {houseFunded ? (
            <>min {fmt(minBet, decimals)} · max {fmt(maxBet, decimals)} · balance {fmt(balance, decimals)} {symbol}</>
          ) : (
            <>house not funded yet · balance {fmt(balance, decimals)} {symbol}</>
          )}
        </div>
      </label>

      <button className="flip-btn" onClick={() => base && onFlip(base, choice)} disabled={!canFlip}>
        {busy ? "Flipping…" : "FLIP"}
      </button>

      <div className="status">
        {!connected && <span className="muted">Connect a wallet to play.</span>}
        {connected && !paused && !houseFunded && (
          <span className="warn">House treasury isn’t funded yet — flips are disabled until the vault is topped up.</span>
        )}
        {paused && <span className="warn">Game is paused.</span>}
        {tooSmall && <span className="warn">Below minimum bet.</span>}
        {tooBig && <span className="warn">Above maximum bet.</span>}
        {insufficient && <span className="warn">Insufficient balance.</span>}
        {error && <span className="warn">{error}</span>}
        {notice && !busy && <span className="muted">{notice}</span>}
        {lastResult && !busy && (
          <span className={lastResult.won ? "win" : "lose"}>
            {lastResult.won ? `You won! +${lastResult.payout} ${symbol}` : "You lost."} ({lastResult.label})
          </span>
        )}
      </div>
    </div>
  );
}
