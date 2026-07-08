import { describe, it, expect } from "vitest";
import { computeMaxWager, isHouseFunded } from "../lib/wager";

// Ground-truth on-chain GameConfig (raw base units, 9-decimal assets).
const FEE_BPS = 1000;
const PAYOUT_BPS = 17800;
const MAX_PAYOUT_BPS = 800;
const TOKEN_MIN = 1_000_000n; // 0.001 $BABYK
const TOKEN_MAX = 1_000_000_000n; // 1.0 $BABYK (the misconfigured launch value)
const SOL_MIN = 1_000_000n; // 0.001 SOL
const SOL_MAX = 100_000_000n; // 0.1 SOL

// Corrected token max_bet applied via update_config (scripts/update-wager-limits.ts):
// a 10,000,000 $BABYK backstop that leaves the 8% treasury cap as the governing limit.
const TOKEN_MAX_FIXED = 10_000_000_000_000_000n;

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

  it("token: the 1.0 $BABYK launch max_bet pins MAX at 1 regardless of vault size (the live bug)", () => {
    // Live mainnet vault at the time of the fix: 3,386,226.83 $BABYK. The 8%
    // treasury cap allows ~159k, but max_bet = 1e9 (1.0 token) always wins.
    const liveVault = 3_386_226_831_782_106n;
    const max = computeMaxWager({ ...base, configMaxBet: TOKEN_MAX, vaultBalance: liveVault });
    expect(max).toBe(TOKEN_MAX); // exactly 1.0 $BABYK
  });

  it("token: after raising max_bet, the 8% treasury cap governs and scales with the vault", () => {
    // Same live vault, corrected backstop → cap = vault * 800 / (17800 - 800).
    const liveVault = 3_386_226_831_782_106n;
    const max = computeMaxWager({ ...base, configMaxBet: TOKEN_MAX_FIXED, vaultBalance: liveVault });
    expect(max).toBe((liveVault * 800n) / 17_000n); // ≈159,351 $BABYK
    expect(max).toBeLessThan(TOKEN_MAX_FIXED);

    // Scaling: double the vault → double the MAX (treasury cap, not the backstop).
    const max2 = computeMaxWager({ ...base, configMaxBet: TOKEN_MAX_FIXED, vaultBalance: liveVault * 2n });
    expect(max2).toBe((liveVault * 2n * 800n) / 17_000n);
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
