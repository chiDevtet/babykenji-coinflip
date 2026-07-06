import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import { aggregateOwners, allocateRewards } from "../src/rewards/worker";

test("aggregates owners and excludes configured wallets", () => {
  const a = Keypair.generate().publicKey.toBase58();
  const b = Keypair.generate().publicKey.toBase58();
  const excluded = Keypair.generate().publicKey.toBase58();
  const holders = aggregateOwners([
    { owner: a, amount: 10n },
    { owner: a, amount: 5n },
    { owner: b, amount: 5n },
    { owner: excluded, amount: 1_000n },
  ], new Set([excluded]));
  assert.deepEqual(new Map(holders.map((h) => [h.owner, h.amount])), new Map([[a, 15n], [b, 5n]]));
});

test("allocates rewards proportionally and preserves dust", () => {
  const a = Keypair.generate().publicKey.toBase58();
  const b = Keypair.generate().publicKey.toBase58();
  const { payouts, dust } = allocateRewards([{ owner: a, amount: 1n }, { owner: b, amount: 2n }], 10n);
  assert.equal(payouts.find((p) => p.owner === a)?.amount, 3n);
  assert.equal(payouts.find((p) => p.owner === b)?.amount, 6n);
  assert.equal(dust, 1n);
});
