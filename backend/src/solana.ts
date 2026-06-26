import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createHash } from "crypto";
import { config } from "./config";

export const connection = new Connection(config.rpcUrl, "confirmed");
const PROGRAM_ID = config.programId;
const TOKEN_MINT = config.tokenMint;
const enc = (s: string) => Buffer.from(s, "utf-8");

// --- Anchor discriminators (default scheme: sha256("global:<ix>") / "account:<Name>") ---
function ixDisc(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}
function acctDisc(name: string): Buffer {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

// --- PDA derivations (mirror the program's seeds exactly) ---
export function configPda(): PublicKey {
  return PublicKey.findProgramAddressSync([enc("config"), TOKEN_MINT.toBuffer()], PROGRAM_ID)[0];
}
export function vaultPda(cfg: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([enc("vault"), cfg.toBuffer()], PROGRAM_ID)[0];
}
export function solVaultPda(cfg: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([enc("sol_vault"), cfg.toBuffer()], PROGRAM_ID)[0];
}
export function playerStatePda(cfg: PublicKey, player: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [enc("player"), cfg.toBuffer(), player.toBuffer()],
    PROGRAM_ID
  )[0];
}
function nonceLe(nonce: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(nonce));
  return b;
}
export function betPda(player: PublicKey, nonce: number | bigint): PublicKey {
  return PublicKey.findProgramAddressSync(
    [enc("bet"), player.toBuffer(), nonceLe(nonce)],
    PROGRAM_ID
  )[0];
}

// --- Decoders (fixed layouts: all fields are fixed-size, so offsets are constant) ---
function readU128LE(buf: Buffer, off: number): bigint {
  const lo = buf.readBigUInt64LE(off);
  const hi = buf.readBigUInt64LE(off + 8);
  return lo + (hi << 64n);
}

export interface DecodedBet {
  config: PublicKey;
  player: PublicKey;
  amount: bigint;
  payout: bigint;
  choice: number;
  asset: number; // 0 = token, 1 = sol
  clientSeedHex: string;
  nonce: bigint;
  seedHashHex: string;
  seedEpoch: bigint;
  placedSlot: bigint;
  commitSlot: bigint;
  settlementDeadlineSlot: bigint;
  randomnessAccount: PublicKey;
  bump: number;
}

export function decodeBet(data: Buffer): DecodedBet {
  if (!data.subarray(0, 8).equals(acctDisc("Bet"))) {
    throw new Error("account discriminator mismatch (not a Bet account)");
  }
  return {
    config: new PublicKey(data.subarray(8, 40)),
    player: new PublicKey(data.subarray(40, 72)),
    amount: data.readBigUInt64LE(72),
    payout: data.readBigUInt64LE(80),
    choice: data.readUInt8(88),
    asset: data.readUInt8(89),
    clientSeedHex: data.subarray(90, 122).toString("hex"),
    nonce: data.readBigUInt64LE(122),
    seedHashHex: data.subarray(130, 162).toString("hex"),
    seedEpoch: data.readBigUInt64LE(162),
    placedSlot: data.readBigUInt64LE(170),
    commitSlot: data.readBigUInt64LE(178),
    settlementDeadlineSlot: data.readBigUInt64LE(186),
    randomnessAccount: new PublicKey(data.subarray(194, 226)),
    bump: data.readUInt8(226),
  };
}

export interface DecodedConfig {
  admin: PublicKey;
  settleAuthority: PublicKey;
  tokenMint: PublicKey;
  treasuryVault: PublicKey;
  currentSeedHashHex: string;
  seedEpoch: bigint;
  feeBps: number;
  paused: boolean;
  outstandingLiability: bigint;
  solVault: PublicKey;
  solMinBet: bigint;
  solMaxBet: bigint;
  outstandingLiabilitySol: bigint;
}

export function decodeConfig(data: Buffer): DecodedConfig {
  return {
    admin: new PublicKey(data.subarray(8, 40)),
    settleAuthority: new PublicKey(data.subarray(72, 104)),
    tokenMint: new PublicKey(data.subarray(136, 168)),
    treasuryVault: new PublicKey(data.subarray(168, 200)),
    currentSeedHashHex: data.subarray(200, 232).toString("hex"),
    seedEpoch: data.readBigUInt64LE(232),
    feeBps: data.readUInt16LE(240),
    outstandingLiability: readU128LE(data, 260),
    paused: data.readUInt8(276) === 1,
    solVault: new PublicKey(data.subarray(317, 349)),
    solMinBet: data.readBigUInt64LE(349),
    solMaxBet: data.readBigUInt64LE(357),
    outstandingLiabilitySol: readU128LE(data, 365),
  };
}

export async function fetchBet(player: PublicKey, nonce: number | bigint): Promise<DecodedBet | null> {
  const info = await connection.getAccountInfo(betPda(player, nonce));
  if (!info) return null;
  return decodeBet(info.data);
}

export async function fetchConfig(): Promise<DecodedConfig | null> {
  const info = await connection.getAccountInfo(configPda());
  if (!info) return null;
  return decodeConfig(info.data);
}

// --- Instruction builders (account order MUST match the Rust contexts) ---
export function buildSettleIx(player: PublicKey, nonce: number | bigint, randomnessAccount: PublicKey): TransactionInstruction {
  const cfg = configPda();
  const keys = [
    { pubkey: config.settleAuthority.publicKey, isSigner: true, isWritable: false },
    { pubkey: cfg, isSigner: false, isWritable: true },
    { pubkey: betPda(player, nonce), isSigner: false, isWritable: true },
    { pubkey: player, isSigner: false, isWritable: true },
    { pubkey: vaultPda(cfg), isSigner: false, isWritable: true },
    { pubkey: getAssociatedTokenAddressSync(TOKEN_MINT, player), isSigner: false, isWritable: true },
    { pubkey: randomnessAccount, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  const data = ixDisc("settle_bet");
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
}

export function buildRefundIx(player: PublicKey, nonce: number | bigint, randomnessAccount: PublicKey): TransactionInstruction {
  const cfg = configPda();
  const keys = [
    { pubkey: config.settleAuthority.publicKey, isSigner: true, isWritable: false }, // caller (pays fee)
    { pubkey: cfg, isSigner: false, isWritable: true },
    { pubkey: betPda(player, nonce), isSigner: false, isWritable: true },
    { pubkey: player, isSigner: false, isWritable: true },
    { pubkey: vaultPda(cfg), isSigner: false, isWritable: true },
    { pubkey: getAssociatedTokenAddressSync(TOKEN_MINT, player), isSigner: false, isWritable: true },
    { pubkey: randomnessAccount, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: ixDisc("refund_expired_bet") });
}

export function buildSettleSolIx(player: PublicKey, nonce: number | bigint, randomnessAccount: PublicKey): TransactionInstruction {
  const cfg = configPda();
  const keys = [
    { pubkey: config.settleAuthority.publicKey, isSigner: true, isWritable: false },
    { pubkey: cfg, isSigner: false, isWritable: true },
    { pubkey: betPda(player, nonce), isSigner: false, isWritable: true },
    { pubkey: player, isSigner: false, isWritable: true },
    { pubkey: solVaultPda(cfg), isSigner: false, isWritable: true },
    { pubkey: randomnessAccount, isSigner: false, isWritable: false },
  ];
  const data = ixDisc("settle_bet_sol");
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
}

export function buildRefundSolIx(player: PublicKey, nonce: number | bigint, randomnessAccount: PublicKey): TransactionInstruction {
  const cfg = configPda();
  const keys = [
    { pubkey: config.settleAuthority.publicKey, isSigner: true, isWritable: false }, // caller (pays fee)
    { pubkey: cfg, isSigner: false, isWritable: true },
    { pubkey: betPda(player, nonce), isSigner: false, isWritable: true },
    { pubkey: player, isSigner: false, isWritable: true },
    { pubkey: solVaultPda(cfg), isSigner: false, isWritable: true },
    { pubkey: randomnessAccount, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: ixDisc("refund_expired_bet_sol") });
}

export function buildRotateSeedIx(newSeedHash: Buffer): TransactionInstruction {
  if (newSeedHash.length !== 32) throw new Error("seed hash must be 32 bytes");
  const keys = [
    { pubkey: config.settleAuthority.publicKey, isSigner: true, isWritable: false },
    { pubkey: configPda(), isSigner: false, isWritable: true },
  ];
  const data = Buffer.concat([ixDisc("rotate_seed"), newSeedHash]);
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
}

/** Sign with the settle authority (fee payer) and confirm. */
export async function sendIxs(ixs: TransactionInstruction[]): Promise<string> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = config.settleAuthority.publicKey;
  return sendAndConfirmTransaction(connection, tx, [config.settleAuthority], {
    commitment: "confirmed",
    skipPreflight: false,
  });
}
