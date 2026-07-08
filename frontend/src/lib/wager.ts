// Pure wager-limit math. No imports — bigint end-to-end, safe to unit test and
// safe for the browser (never do float math on base units).
//
// The on-chain program (place_bet / place_bet_sol) accepts a wager only if BOTH:
//   1. per-bet ceiling:  payout <= (vault + amount) * maxPayoutBps / 10_000
//   2. solvency:         vault + amount >= outstanding + payout + fee
// where, for the chosen asset:
//   payout = amount * playerWinPayoutBps / 10_000
//   fee    = amount * feeBps            / 10_000
// `vault` is the treasury's spendable balance (token amount, or SOL lamports
// excluding the rent reserve). With an unfunded treasury (vault = 0) both caps
// collapse to 0, so the largest acceptable wager is 0.

const BPS = 10_000n;

export interface WagerLimitParams {
  /** Configured max_bet / sol_max_bet (base units). */
  configMaxBet: bigint;
  /** Live spendable house-vault balance for this asset (base units). */
  vaultBalance: bigint;
  /** Payouts+fees already reserved against open bets for this asset (base units). */
  outstandingLiability: bigint;
  /** player_win_payout_bps for this asset (e.g. 17800 = 1.78x). */
  payoutBps: number;
  /** fee_bps (external fee reserved on top of the payout). */
  feeBps: number;
  /** max_payout_bps_of_treasury (per-bet ceiling as a fraction of the pool). */
  maxPayoutBpsOfTreasury: number;
}

/**
 * Largest wager (base units) the program will currently accept, i.e. the live
 * MAX that respects the configured max_bet AND the treasury-derived caps.
 * Returns 0 when the house cannot cover any winning payout yet.
 */
export function computeMaxWager(p: WagerLimitParams): bigint {
  const payoutBps = BigInt(p.payoutBps);
  const feeBps = BigInt(p.feeBps);
  const capBps = BigInt(p.maxPayoutBpsOfTreasury);
  const vault = p.vaultBalance < 0n ? 0n : p.vaultBalance;

  // (1) Per-bet ceiling. Rearranged from payout <= (vault+amount)*capBps/10_000:
  //     amount <= vault * capBps / (payoutBps - capBps).
  // Only binds when payoutBps > capBps (always true for a valid config, since a
  // win pays >1x while the cap is a small fraction of the pool).
  let perBetCap: bigint;
  if (payoutBps <= capBps) {
    perBetCap = p.configMaxBet;
  } else {
    perBetCap = (vault * capBps) / (payoutBps - capBps);
  }

  // (2) Solvency. Rearranged from vault+amount >= outstanding + amount*(payoutBps+feeBps)/10_000:
  //     amount <= (vault - outstanding) * 10_000 / (payoutBps + feeBps - 10_000).
  // Only binds when payoutBps+feeBps > 10_000 (house pays out more than the stake).
  const available = vault > p.outstandingLiability ? vault - p.outstandingLiability : 0n;
  const liabilityBps = payoutBps + feeBps;
  let solvencyCap: bigint;
  if (liabilityBps <= BPS) {
    solvencyCap = p.configMaxBet;
  } else {
    solvencyCap = (available * BPS) / (liabilityBps - BPS);
  }

  let max = p.configMaxBet;
  if (perBetCap < max) max = perBetCap;
  if (solvencyCap < max) max = solvencyCap;
  return max < 0n ? 0n : max;
}

/**
 * True when the house can currently cover at least the minimum bet. When false
 * the UI should surface "house not funded yet" and disable FLIP rather than show
 * a garbage or zero MAX as if it were a real limit.
 */
export function isHouseFunded(maxWager: bigint, minBet: bigint): boolean {
  return maxWager >= minBet && maxWager > 0n;
}
