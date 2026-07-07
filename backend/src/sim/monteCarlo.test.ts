import assert from 'node:assert/strict';
import test from 'node:test';
import { computeFeeSplit, computePlayerWinPayout, computeTheoreticalVaultEdgeBps, computeTotalFee, computeTotalWinLiability, SOL_FEE_CONFIG, TOKEN_FEE_CONFIG } from './feeMath';
import { MonteCarloSimulator, defaultOptions } from './monteCarlo';

test('SOL 100-unit fee split equals 5/3/2 where units allow', () => {
  assert.deepEqual(computeFeeSplit(100n, SOL_FEE_CONFIG), { total: 10n, team: 5n, dev: 3n, burn: 0n, holderRewards: 2n });
});

test('Token fee split equals 5/1.66/1.67/1.67 using bps', () => {
  assert.deepEqual(computeFeeSplit(10_000n, TOKEN_FEE_CONFIG), { total: 1000n, team: 500n, dev: 166n, burn: 167n, holderRewards: 167n });
});

test('payout and liability are 1.78x and 1.88x', () => {
  assert.equal(computePlayerWinPayout(10_000n, 17_800n), 17_800n);
  assert.equal(computeTotalWinLiability(10_000n, SOL_FEE_CONFIG), 18_800n);
});

test('theoretical vault edge scenarios', () => {
  assert.equal(computeTheoreticalVaultEdgeBps(1000n, 19000n), -500n);
  assert.equal(computeTheoreticalVaultEdgeBps(1000n, 18000n), 0n);
  assert.equal(computeTheoreticalVaultEdgeBps(1000n, 17800n), 100n);
});

test('fee split sums exactly and remainder goes to holder rewards', () => {
  const b = computeFeeSplit(111n, SOL_FEE_CONFIG);
  assert.equal(b.team + b.dev + b.burn + b.holderRewards, b.total);
  assert.equal(b.holderRewards, 3n);
});

test('zero-fee tiny bet is rejected', () => {
  const sim = new MonteCarloSimulator(defaultOptions({ asset: 'sol', minSolBet: 1n, maxSolBet: 9n }));
  assert.equal(sim.place(0, 1n, 'SOL').status, 'rejected');
});

test('refund returns full wager and charges no fees', () => {
  const sim = new MonteCarloSimulator(defaultOptions({ asset: 'sol', solBankroll: 100_000n, minSolBet: 100n, maxSolBet: 100n }));
  const before = sim.sol.houseVaultBalance;
  const bet = sim.place(0, 100n, 'SOL');
  sim.refund(bet);
  assert.equal(sim.sol.houseVaultBalance, before);
  assert.equal(sim.sol.totalFees, 0n);
  assert.equal(sim.sol.totalRefunded, 100n);
});

test('losing SOL bet routes fees and keeps 90%', () => {
  const sim = new MonteCarloSimulator(defaultOptions({ forcedStreak: 'losses', forcedStreakLength: 10, solBankroll: 100_000n, minSolBet: 100n, maxSolBet: 100n }));
  const before = sim.sol.houseVaultBalance;
  const bet = sim.place(0, 100n, 'SOL'); sim.settle(bet, 0);
  assert.equal(sim.sol.houseVaultBalance, before + 90n);
  assert.equal(sim.sol.teamFees, 5n); assert.equal(sim.sol.devFees, 3n); assert.equal(sim.sol.holderRewardsFees, 2n);
});

test('winning SOL bet pays player and routes fees', () => {
  const sim = new MonteCarloSimulator(defaultOptions({ forcedStreak: 'wins', forcedStreakLength: 10, solBankroll: 100_000n, minSolBet: 100n, maxSolBet: 100n }));
  const before = sim.sol.houseVaultBalance;
  const bet = sim.place(0, 100n, 'SOL'); sim.settle(bet, 0);
  assert.equal(sim.sol.houseVaultBalance, before - 88n);
  assert.equal(sim.sol.totalPlayerPayouts, 178n); assert.equal(sim.sol.totalFees, 10n);
});

test('losing token bet routes fees and burns', () => {
  const sim = new MonteCarloSimulator(defaultOptions({ forcedStreak: 'losses', forcedStreakLength: 10, tokenBankroll: 100_000n, minTokenBet: 10_000n, maxTokenBet: 10_000n }));
  const bet = sim.place(0, 10_000n, 'BABY_KENJI'); sim.settle(bet, 0);
  assert.equal(sim.token.burnFees, 167n); assert.equal(sim.token.totalFees, 1000n);
});

test('winning token bet pays player, routes fees, and burns', () => {
  const sim = new MonteCarloSimulator(defaultOptions({ forcedStreak: 'wins', forcedStreakLength: 10, tokenBankroll: 100_000n, minTokenBet: 10_000n, maxTokenBet: 10_000n }));
  const bet = sim.place(0, 10_000n, 'BABY_KENJI'); sim.settle(bet, 0);
  assert.equal(sim.token.totalPlayerPayouts, 17_800n); assert.equal(sim.token.burnFees, 167n);
});

test('outstanding liability increases and releases on settlement/refund', () => {
  const sim = new MonteCarloSimulator(defaultOptions({ solBankroll: 100_000n, minSolBet: 100n, maxSolBet: 100n }));
  const b1 = sim.place(0, 100n, 'SOL'); assert.equal(sim.sol.outstandingLiability, 188n); sim.settle(b1, 0); assert.equal(sim.sol.outstandingLiability, 0n);
  const b2 = sim.place(1, 100n, 'SOL'); assert.equal(sim.sol.outstandingLiability, 188n); sim.refund(b2); assert.equal(sim.sol.outstandingLiability, 0n);
});

test('duplicate settlement and refund throw', () => {
  const sim = new MonteCarloSimulator(defaultOptions({ solBankroll: 100_000n, minSolBet: 100n, maxSolBet: 100n }));
  const b = sim.place(0, 100n, 'SOL'); sim.settle(b, 0);
  assert.throws(() => sim.settle(b, 0)); assert.throws(() => sim.refund(b));
});

test('admin withdrawable excludes liability', () => {
  const sim = new MonteCarloSimulator(defaultOptions({ solBankroll: 100_000n, minSolBet: 100n, maxSolBet: 100n }));
  sim.place(0, 100n, 'SOL');
  assert.equal(sim.withdrawable('SOL'), 99_912n);
});

test('forced 100-win streak does not violate invariants when bankroll is sufficient', () => {
  const res = new MonteCarloSimulator(defaultOptions({ asset: 'sol', iterations: 100, concurrency: 1, solBankroll: 1_000_000n, minSolBet: 100n, maxSolBet: 100n, forcedStreak: 'wins', forcedStreakLength: 100, refundRate: 0n })).run();
  assert.equal(res.passed, true);
});

test('forced win streak rejects bets when bankroll is insufficient', () => {
  const res = new MonteCarloSimulator(defaultOptions({ asset: 'sol', iterations: 100, concurrency: 1, solBankroll: 100n, minSolBet: 100n, maxSolBet: 100n, forcedStreak: 'wins', forcedStreakLength: 100, refundRate: 0n })).run();
  assert.ok(res.sol.rejectedBets > 0n);
});

test('rounding fuzz passes for many random amounts', () => {
  for (let i = 1n; i < 10_000n; i++) {
    const s = computeFeeSplit(i, SOL_FEE_CONFIG); assert.equal(s.team + s.dev + s.burn + s.holderRewards, computeTotalFee(i, 1000n));
    const t = computeFeeSplit(i, TOKEN_FEE_CONFIG); assert.equal(t.team + t.dev + t.burn + t.holderRewards, computeTotalFee(i, 1000n));
  }
});

test('mixed-asset scenario completes without invariant violation', () => {
  const res = new MonteCarloSimulator(defaultOptions({ scenario: 'mixed-asset-chaos', asset: 'mixed', iterations: 1_000, concurrency: 20, refundRate: 100n })).run();
  assert.equal(res.passed, true);
});

test('SOL burns never happen in SOL-only scenario', () => {
  const res = new MonteCarloSimulator(defaultOptions({ asset: 'sol', iterations: 500, concurrency: 10, forcedStreak: 'losses', forcedStreakLength: 500 })).run();
  assert.equal(res.sol.burnFees, 0n);
});

test('token burns only happen for token flips', () => {
  const res = new MonteCarloSimulator(defaultOptions({ asset: 'token', iterations: 500, concurrency: 10, forcedStreak: 'losses', forcedStreakLength: 500 })).run();
  assert.ok(res.token.burnFees > 0n);
  assert.equal(res.sol.burnFees, 0n);
});

test('max loss streak verifies fee routing and house profit', () => {
  const res = new MonteCarloSimulator(defaultOptions({ asset: 'sol', iterations: 100, concurrency: 1, minSolBet: 100n, maxSolBet: 100n, forcedStreak: 'losses', forcedStreakLength: 100, refundRate: 0n })).run();
  assert.equal(res.passed, true);
  assert.ok(res.sol.totalHouseProfit > 0n);
});

test('admin withdrawal pressure scenario keeps ending liability zero', () => {
  const res = new MonteCarloSimulator(defaultOptions({ scenario: 'admin-withdrawal-pressure', iterations: 500, concurrency: 100, settlementDelayMax: 50 })).run();
  assert.equal(res.passed, true);
  assert.equal(res.sol.outstandingLiability + res.token.outstandingLiability, 0n);
});

test('total win liability equals payout plus fee for token wagers', () => {
  const amount = 123_456_789n;
  assert.equal(computeTotalWinLiability(amount, TOKEN_FEE_CONFIG), computePlayerWinPayout(amount, TOKEN_FEE_CONFIG.playerWinPayoutBps) + computeTotalFee(amount, 1000n));
});
