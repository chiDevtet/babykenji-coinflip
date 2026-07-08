import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import { planDistribution } from "../src/rewards/distributor";

const owner = () => Keypair.generate().publicKey.toBase58();

// 1B supply at 9 decimals, like the live $BABYK mint.
const SUPPLY = 1_000_000_000n * 10n ** 9n;
const TWO_PCT = SUPPLY / 50n; // 20,000,000 $BABYK

const base = {
  threshold: 1_000n,
  burnBps: 0,
  holderBps: 10_000,
  excluded: new Set<string>(),
  supply: SUPPLY,
  minHolderSupplyBps: 200, // 2% of total supply
};

test("below threshold produces no payouts", () => {
  const plan = planDistribution({
    ...base,
    asset: "token",
    accumulated: 999n,
    holders: [{ owner: owner(), amount: TWO_PCT }],
  });
  assert.equal(plan.belowThreshold, true);
  assert.equal(plan.payouts.length, 0);
  assert.equal(plan.burnAmount, 0n);
});

test("eligibility floor: only holders with >= 2% of supply receive rewards", () => {
  const whale = owner();
  const smallFish = owner();
  const plan = planDistribution({
    ...base,
    asset: "token",
    accumulated: 10_000n,
    holders: [
      { owner: whale, amount: TWO_PCT },
      { owner: smallFish, amount: TWO_PCT - 1n },
    ],
  });
  assert.equal(plan.minHolderAmount, TWO_PCT);
  assert.deepEqual(plan.eligible.map((h) => h.owner), [whale].sort());
  assert.equal(plan.payouts.length, 1);
  assert.equal(plan.payouts[0].owner, whale);
  assert.equal(plan.payouts[0].amount, 10_000n);
});

test("split balances across token accounts of the same owner count toward the floor", () => {
  const w = owner();
  const plan = planDistribution({
    ...base,
    asset: "token",
    accumulated: 10_000n,
    holders: [
      { owner: w, amount: TWO_PCT / 2n },
      { owner: w, amount: TWO_PCT / 2n },
    ],
  });
  assert.equal(plan.eligible.length, 1);
  assert.equal(plan.eligible[0].amount, TWO_PCT);
});

test("excluded owners never receive rewards even above the floor", () => {
  const excludedWallet = owner();
  const keeper = owner();
  const plan = planDistribution({
    ...base,
    asset: "token",
    accumulated: 10_000n,
    excluded: new Set([excludedWallet]),
    holders: [
      { owner: excludedWallet, amount: TWO_PCT * 10n },
      { owner: keeper, amount: TWO_PCT },
    ],
  });
  assert.deepEqual(plan.payouts.map((p) => p.owner), [keeper]);
});

test("pro-rata allocation among eligible holders with dust preserved", () => {
  const a = owner();
  const b = owner();
  const plan = planDistribution({
    ...base,
    asset: "token",
    accumulated: 10n,
    threshold: 10n,
    holders: [
      { owner: a, amount: TWO_PCT },
      { owner: b, amount: TWO_PCT * 2n },
    ],
  });
  const payoutA = plan.payouts.find((p) => p.owner === a)?.amount;
  const payoutB = plan.payouts.find((p) => p.owner === b)?.amount;
  assert.equal(payoutA, 3n); // 10 * 1/3 floored
  assert.equal(payoutB, 6n); // 10 * 2/3 floored
  assert.equal(plan.dust, 1n);
});

test("token burn share is honored when configured", () => {
  const plan = planDistribution({
    ...base,
    asset: "token",
    accumulated: 10_000n,
    burnBps: 1_000,
    holderBps: 9_000,
    holders: [{ owner: owner(), amount: TWO_PCT }],
  });
  assert.equal(plan.burnAmount, 1_000n);
  assert.equal(plan.payoutPool, 9_000n);
  assert.equal(plan.retained, 0n);
});

test("sol cycles never burn even if burnBps is configured", () => {
  const plan = planDistribution({
    ...base,
    asset: "sol",
    accumulated: 10_000n,
    burnBps: 1_000,
    holderBps: 9_000,
    holders: [{ owner: owner(), amount: TWO_PCT }],
  });
  assert.equal(plan.burnAmount, 0n);
  assert.equal(plan.payoutPool, 9_000n);
  assert.equal(plan.retained, 1_000n); // un-paid share stays in the wallet
});

test("no eligible holders means nothing is planned even above threshold", () => {
  const plan = planDistribution({
    ...base,
    asset: "token",
    accumulated: 10_000n,
    holders: [{ owner: owner(), amount: TWO_PCT - 1n }],
  });
  assert.equal(plan.belowThreshold, false);
  assert.equal(plan.payouts.length, 0);
  assert.equal(plan.burnAmount, 0n);
  assert.equal(plan.retained, plan.accumulated);
});
