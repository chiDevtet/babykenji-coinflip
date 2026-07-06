import { FeeBreakdown, FeeConfig } from './types';

export const BPS_DENOMINATOR = 10_000n;
export const SOL_FEE_CONFIG: FeeConfig = { asset: 'SOL', totalFeeBps: 1000n, teamBps: 500n, devBps: 300n, burnBps: 0n, holderRewardsBps: 200n };
export const TOKEN_FEE_CONFIG: FeeConfig = { asset: 'BABY_KENJI', totalFeeBps: 1000n, teamBps: 500n, devBps: 166n, burnBps: 167n, holderRewardsBps: 167n };

export function mulDivFloor(amount: bigint, numeratorBps: bigint, denominatorBps: bigint): bigint {
  if (amount < 0n || numeratorBps < 0n || denominatorBps <= 0n) throw new Error('invalid mulDivFloor inputs');
  return (amount * numeratorBps) / denominatorBps;
}

export function computeTotalFee(amount: bigint, totalFeeBps: bigint): bigint {
  return mulDivFloor(amount, totalFeeBps, BPS_DENOMINATOR);
}

export function computePlayerWinPayout(amount: bigint, totalFeeBps: bigint): bigint {
  if (totalFeeBps > 20_000n) throw new Error('totalFeeBps exceeds gross payout bps');
  return mulDivFloor(amount, 20_000n - totalFeeBps, BPS_DENOMINATOR);
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
  return computePlayerWinPayout(amount, config.totalFeeBps) + computeTotalFee(amount, config.totalFeeBps);
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
