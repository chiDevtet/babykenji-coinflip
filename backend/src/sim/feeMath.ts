import { FeeBreakdown, FeeConfig } from './types';

export const BPS_DENOMINATOR = 10_000n;
export const DEFAULT_PLAYER_WIN_PAYOUT_BPS = 17_800n;
export const SOL_FEE_CONFIG: FeeConfig = { asset: 'SOL', totalFeeBps: 1000n, teamBps: 500n, devBps: 300n, burnBps: 0n, holderRewardsBps: 200n, playerWinPayoutBps: DEFAULT_PLAYER_WIN_PAYOUT_BPS };
export const TOKEN_FEE_CONFIG: FeeConfig = { asset: 'BABY_KENJI', totalFeeBps: 1000n, teamBps: 500n, devBps: 166n, burnBps: 167n, holderRewardsBps: 167n, playerWinPayoutBps: DEFAULT_PLAYER_WIN_PAYOUT_BPS };

export function mulDivFloor(amount: bigint, numeratorBps: bigint, denominatorBps: bigint): bigint {
  if (amount < 0n || numeratorBps < 0n || denominatorBps <= 0n) throw new Error('invalid mulDivFloor inputs');
  return (amount * numeratorBps) / denominatorBps;
}

export function computeTotalFee(amount: bigint, totalFeeBps: bigint): bigint {
  return mulDivFloor(amount, totalFeeBps, BPS_DENOMINATOR);
}

export function validatePayoutConfig(totalFeeBps: bigint, playerWinPayoutBps: bigint): void {
  if (playerWinPayoutBps <= 0n) throw new Error('playerWinPayoutBps must be positive');
  if (playerWinPayoutBps + totalFeeBps > 20_000n) throw new Error('playerWinPayoutBps plus fee exceeds 20000');
}

export function computePlayerWinPayout(amount: bigint, playerWinPayoutBps: bigint): bigint {
  validatePayoutConfig(0n, playerWinPayoutBps);
  return mulDivFloor(amount, playerWinPayoutBps, BPS_DENOMINATOR);
}

export function computeTheoreticalVaultEdgeBps(totalFeeBps: bigint, playerWinPayoutBps: bigint): bigint {
  return BPS_DENOMINATOR - totalFeeBps - playerWinPayoutBps / 2n;
}

export function computeFeeSplit(amount: bigint, config: FeeConfig): FeeBreakdown {
  const total = computeTotalFee(amount, config.totalFeeBps);
  const team = mulDivFloor(amount, config.teamBps, BPS_DENOMINATOR);
  const dev = mulDivFloor(amount, config.devBps, BPS_DENOMINATOR);
  const burn = mulDivFloor(amount, config.burnBps, BPS_DENOMINATOR);
  const assigned = team + dev + burn;
  if (assigned > total) throw new Error('fee split exceeds total fee');
  const holderRewards = total - assigned; // all rounding remainder intentionally goes to holders
  const breakdown = { total, team, dev, burn, holderRewards };
  assertFeeBreakdownValid(amount, breakdown, config);
  return breakdown;
}

export function computeTotalWinLiability(amount: bigint, config: FeeConfig): bigint {
  validatePayoutConfig(config.totalFeeBps, config.playerWinPayoutBps);
  return computePlayerWinPayout(amount, config.playerWinPayoutBps) + computeTotalFee(amount, config.totalFeeBps);
}

export function assertFeeBreakdownValid(amount: bigint, breakdown: FeeBreakdown, config: FeeConfig): void {
  if (amount < 0n) throw new Error('amount cannot be negative');
  const expectedTotal = computeTotalFee(amount, config.totalFeeBps);
  const sum = breakdown.team + breakdown.dev + breakdown.burn + breakdown.holderRewards;
  if (breakdown.total !== expectedTotal) throw new Error(`fee total mismatch: ${breakdown.total} !== ${expectedTotal}`);
  if (sum !== breakdown.total) throw new Error(`fee split does not sum exactly: ${sum} !== ${breakdown.total}`);
  for (const [k, v] of Object.entries(breakdown)) if (v < 0n) throw new Error(`${k} fee is negative`);
  if (sum > breakdown.total) throw new Error('fee split exceeds total fee');
  if (config.asset === 'SOL' && breakdown.burn !== 0n) throw new Error('SOL burn must be zero');
}

export function formatUnits(value: bigint, decimals: number): string {
  const sign = value < 0n ? '-' : '';
  const abs = value < 0n ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${sign}${whole.toString()}${frac ? `.${frac}` : ''}`;
}
