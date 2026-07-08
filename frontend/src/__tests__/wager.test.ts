import { describe, it, expect } from "vitest";
import { computeMaxWager, isHouseFunded } from "../lib/wager";

// Ground-truth on-chain GameConfig (raw base units, 9-decimal assets).
const FEE_BPS = 1000;
const PAYOUT_BPS = 17800;
const MAX_PAYOUT_BPS = 800;
const TOKEN_MIN = 1_000_000n; // 0.001 $BABYK
const TOKEN_MAX = 1_000_000_000n; // 1.0 $BABYK
const SOL_MIN = 1_000_000n; // 0.001 SOL
const SOL_MAX = 100_000_000n; // 0.1 SOL

const base = {
  outstandingLiability: 0n,
  payoutBps: PAYOUT_BPS,
  feeBps: FEE_BPS,
  maxPayoutBpsOfTreasury: MAX_PAYOUT_BPS,
};

describe("computeMaxWager", () => {
  it("is 0 when the treasury is unfunded (both assets)", () => {
    expect(computeMaxWager({ ...base, configMaxBet: TOKEN_MAX, vaultBalance: 0n })).toBe(0n);
    expect(computeMaxWager({ ...base, configMaxBet: SOL_MAX, vaultBalance: 0n })).toBe(0n);
  });

  it("token: config max_bet binds once the vault is comfortably funded", () => {
    // 10,000 $BABYK in the vault → per-bet cap ~470 $BABYK >> config max (1.0),
    // so the configured max_bet is the binding limit.
    const max = computeMaxWager({ ...base, configMaxBet: TOKEN_MAX, vaultBalance: 10_000_000_000_000n });
    expect(max).toBe(TOKEN_MAX);
    expect(isHouseFunded(max, TOKEN_MIN)).toBe(true);
  });

  it("sol: treasury per-bet cap binds below config max when the vault is thin", () => {
    // 1 SOL spendable → cap = 1e9 * 800 / (17800-800) = 47,058,823 lamports
    // (~0.047 SOL), which is below the 0.1 SOL config max.
    const max = computeMaxWager({ ...base, configMaxBet: SOL_MAX, vaultBalance: 1_000_000_000n });
    expect(max).toBe(47_058_823n);
    expect(max).toBeLessThan(SOL_MAX);
    expect(isHouseFunded(max, SOL_MIN)).toBe(true);
  });

  it("never returns a wager the program's per-bet ceiling would reject", () => {
    const vault = 1_000_000_000n;
    const max = computeMaxWager({ ...base, configMaxBet: SOL_MAX, vaultBalance: vault });
    // Program check: payout <= (vault + amount) * maxPayoutBps / 10_000.
    const payout = (max * BigInt(PAYOUT_BPS)) / 10_000n;
    const cap = ((vault + max) * BigInt(MAX_PAYOUT_BPS)) / 10_000n;
    expect(payout).toBeLessThanOrEqual(cap);
  });

  it("house is not considered funded when the cap is below the minimum bet", () => {
    // Tiny vault → cap far below min_bet.
    const max = computeMaxWager({ ...base, configMaxBet: TOKEN_MAX, vaultBalance: 1_000n });
    expect(isHouseFunded(max, TOKEN_MIN)).toBe(false);
  });
});
