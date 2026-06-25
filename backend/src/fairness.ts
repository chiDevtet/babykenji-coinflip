import { createHash, createHmac, randomBytes } from "crypto";

/**
 * Provably-fair commit–reveal core.
 *
 *  1. Server generates a 32-byte `serverSeed` and publishes `commitHash` =
 *     sha256(serverSeed). This hash is what gets written on-chain
 *     (GameConfig.current_seed_hash) and shown to players BEFORE they bet, so
 *     the house is locked into a seed it cannot change after seeing the bet.
 *  2. Each bet carries a player-chosen `clientSeed` and a monotonic `nonce`.
 *  3. result bit = HMAC_SHA256(serverSeed, "<player>:<clientSeedHex>:<nonce>")[0] & 1
 *     0 => heads, 1 => tails. `won = (bit === choice)`.
 *  4. On epoch rotation the server reveals the old `serverSeed`. Anyone can then
 *     check sha256(revealedSeed) === committed hash and recompute every result.
 *
 * The result depends on BOTH the server seed (committed in advance) and the
 * client seed + nonce (chosen by the player), so neither side can steer it.
 */

export const HEADS = 0;
export const TAILS = 1;

export function generateServerSeed(): string {
  return randomBytes(32).toString("hex");
}

/** Commitment published on-chain / to clients. Revealed seed must hash to this. */
export function commitHash(serverSeedHex: string): string {
  return createHash("sha256").update(Buffer.from(serverSeedHex, "hex")).digest("hex");
}

export function deriveResultBit(
  serverSeedHex: string,
  player: string,
  clientSeedHex: string,
  nonce: number
): number {
  const msg = `${player}:${clientSeedHex}:${nonce}`;
  const mac = createHmac("sha256", Buffer.from(serverSeedHex, "hex")).update(msg).digest();
  return mac[0] & 1;
}

export interface VerifyResult {
  commitmentValid: boolean;
  resultBit: number;
  resultLabel: "heads" | "tails";
  won: boolean;
}

/** Recompute everything from a revealed seed; what a player runs to audit a bet. */
export function verify(
  serverSeedHex: string,
  committedHashHex: string,
  player: string,
  clientSeedHex: string,
  nonce: number,
  choice: number
): VerifyResult {
  const bit = deriveResultBit(serverSeedHex, player, clientSeedHex, nonce);
  return {
    commitmentValid: commitHash(serverSeedHex) === committedHashHex,
    resultBit: bit,
    resultLabel: bit === HEADS ? "heads" : "tails",
    won: bit === choice,
  };
}
