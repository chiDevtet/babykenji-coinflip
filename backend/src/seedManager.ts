import { SeedModel } from "./models/Seed";
import { generateServerSeed, commitHash } from "./fairness";

/**
 * Owns the lifecycle of fairness epochs.
 *
 * The ACTIVE epoch's commitHash must equal the on-chain GameConfig.current_seed_hash.
 * When you first initialize the on-chain config, call `ensureActiveSeed()` and use
 * the printed commit hash as the `seed_hash` init param. When you rotate, call
 * `rotate()` here AND send an on-chain `rotate_seed(newCommitHash)` (the bets route
 * exposes a combined admin endpoint).
 */

export async function ensureActiveSeed() {
  let active = await SeedModel.findOne({ active: true });
  if (!active) {
    const serverSeedHex = generateServerSeed();
    active = await SeedModel.create({
      epoch: 0,
      serverSeedHex,
      commitHashHex: commitHash(serverSeedHex),
      active: true,
      revealed: false,
    });
    console.log(
      `[seed] created epoch 0. Put this commit hash on-chain as the init seed_hash:\n        ${active.commitHashHex}`
    );
  }
  return active;
}

export async function getActiveSeed() {
  const active = await SeedModel.findOne({ active: true });
  if (!active) throw new Error("No active fairness seed; call ensureActiveSeed() on boot");
  return active;
}

export async function getSeedForEpoch(epoch: number) {
  const seed = await SeedModel.findOne({ epoch });
  if (!seed) throw new Error(`Unknown seed epoch ${epoch}`);
  return seed;
}

export async function getActiveCommit() {
  const active = await getActiveSeed();
  return { epoch: active.epoch, commitHashHex: active.commitHashHex };
}

/** Reveal a seed for verification — only returns it once the epoch is rotated out. */
export async function getRevealedSeed(epoch: number) {
  const seed = await SeedModel.findOne({ epoch });
  if (!seed) return null;
  if (!seed.revealed) return { epoch, revealed: false as const, commitHashHex: seed.commitHashHex };
  return {
    epoch,
    revealed: true as const,
    serverSeedHex: seed.serverSeedHex,
    commitHashHex: seed.commitHashHex,
  };
}

/**
 * Rotate to a fresh epoch: reveal the previous server seed, activate a new one.
 * Returns the new commit hash to be written on-chain via rotate_seed.
 */
export async function rotate() {
  const previous = await getActiveSeed();
  previous.active = false;
  previous.revealed = true;
  previous.rotatedAt = new Date();
  await previous.save();

  const serverSeedHex = generateServerSeed();
  const next = await SeedModel.create({
    epoch: previous.epoch + 1,
    serverSeedHex,
    commitHashHex: commitHash(serverSeedHex),
    active: true,
    revealed: false,
  });

  return {
    revealedEpoch: previous.epoch,
    revealedServerSeedHex: previous.serverSeedHex,
    newEpoch: next.epoch,
    newCommitHashHex: next.commitHashHex,
  };
}
