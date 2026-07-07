export type Asset = 'SOL' | 'BABY_KENJI';
export type AssetMode = 'sol' | 'token' | 'mixed';
export type BetStatus = 'open' | 'settled' | 'refunded' | 'rejected';
export type BetChoice = 0 | 1;
export type BetSizeMode = 'uniform' | 'small' | 'large' | 'max' | 'whale' | 'mixed';
export type ForcedStreak = 'none' | 'wins' | 'losses' | 'alternating';

export interface FeeConfig {
  asset: Asset;
  totalFeeBps: bigint;
  teamBps: bigint;
  devBps: bigint;
  burnBps: bigint;
  holderRewardsBps: bigint;
  playerWinPayoutBps: bigint;
}

export interface FeeBreakdown {
  total: bigint;
  team: bigint;
  dev: bigint;
  burn: bigint;
  holderRewards: bigint;
}

export interface AssetAccounting {
  asset: Asset;
  houseVaultBalance: bigint;
  initialHouseVaultBalance: bigint;
  outstandingLiability: bigint;
  totalWagered: bigint;
  totalPlayerPayouts: bigint;
  totalFees: bigint;
  teamFees: bigint;
  devFees: bigint;
  burnFees: bigint;
  holderRewardsFees: bigint;
  totalRefunded: bigint;
  totalHouseProfit: bigint;
  maxDrawdown: bigint;
  minVaultBalance: bigint;
  maxOutstandingLiability: bigint;
  rejectedBets: bigint;
  acceptedBets: bigint;
  settledBets: bigint;
  refundedBets: bigint;
  openBets: bigint;
  wins: bigint;
  losses: bigint;
}

export interface SimBet {
  id: bigint;
  asset: Asset;
  amount: bigint;
  choice: BetChoice;
  resultBit?: BetChoice;
  won?: boolean;
  status: BetStatus;
  placedAtStep: number;
  settlementStep: number;
  refundDeadlineStep: number;
  feeBreakdown: FeeBreakdown;
  playerWinPayout: bigint;
  totalWinLiability: bigint;
  feeRecipientsSnapshot: { team: string; dev: string; holderRewards: string; burn: string };
}

export interface MonteCarloOptions {
  scenario: string;
  seed: bigint;
  iterations: number;
  asset: AssetMode;
  solBankroll: bigint;
  tokenBankroll: bigint;
  minSolBet: bigint;
  maxSolBet: bigint;
  minTokenBet: bigint;
  maxTokenBet: bigint;
  concurrency: number;
  settlementDelayMin: number;
  settlementDelayMax: number;
  refundRate: bigint; // bps
  unresolvedRate: bigint; // bps
  winRate: bigint; // bps
  betSizeMode: BetSizeMode;
  forcedStreak: ForcedStreak;
  forcedStreakLength: number;
  runs: number;
  json: boolean;
  csvOut?: string;
  solRentReserve: bigint;
  solPlayerWinPayoutBps: bigint;
  tokenPlayerWinPayoutBps: bigint;
  comparePayouts: boolean;
}

export interface InvariantViolation {
  step: number;
  betId?: string;
  asset?: Asset;
  invariant: string;
  message: string;
  state?: Record<string, string>;
}

export interface SimulationResult {
  scenario: string;
  seed: string;
  iterations: number;
  assetMode: AssetMode;
  sol: AssetAccounting;
  token: AssetAccounting;
  invariantViolations: InvariantViolation[];
  passed: boolean;
}
