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
  feeTeamRecipient: PublicKey;
  feeDevRecipient: PublicKey;
  feeHolderRewardsRecipient: PublicKey;
  payout: bigint;
  playerWinPayoutBps: number;
  playerWinPayout: bigint;
  totalFeeAmount: bigint;
  teamFeeAmount: bigint;
  devFeeAmount: bigint;
  burnFeeAmount: bigint;
  holderRewardsFeeAmount: bigint;
  totalWinLiability: bigint;
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
    feeTeamRecipient: new PublicKey(data.subarray(80, 112)),
    feeDevRecipient: new PublicKey(data.subarray(112, 144)),
    feeHolderRewardsRecipient: new PublicKey(data.subarray(144, 176)),
    payout: data.readBigUInt64LE(178),
    playerWinPayoutBps: data.readUInt16LE(176),
    playerWinPayout: data.readBigUInt64LE(178),
    totalFeeAmount: data.readBigUInt64LE(186),
    teamFeeAmount: data.readBigUInt64LE(194),
    devFeeAmount: data.readBigUInt64LE(202),
    burnFeeAmount: data.readBigUInt64LE(210),
    holderRewardsFeeAmount: data.readBigUInt64LE(218),
    totalWinLiability: data.readBigUInt64LE(226),
    choice: data.readUInt8(234),
    asset: data.readUInt8(235),
    clientSeedHex: data.subarray(236, 268).toString("hex"),
    nonce: data.readBigUInt64LE(268),
    seedHashHex: data.subarray(276, 308).toString("hex"),
    seedEpoch: data.readBigUInt64LE(308),
    placedSlot: data.readBigUInt64LE(316),
    commitSlot: data.readBigUInt64LE(324),
    settlementDeadlineSlot: data.readBigUInt64LE(332),
    randomnessAccount: new PublicKey(data.subarray(340, 372)),
    bump: data.readUInt8(372),
  };
}

export interface DecodedConfig {
  admin: PublicKey;
  settleAuthority: PublicKey;
  tokenMint: PublicKey;
  treasuryVault: PublicKey;
  solTeamWallet: PublicKey;
  solDevBuybackWallet: PublicKey;
  solHolderRewardsWallet: PublicKey;
  tokenTeamFeeAccount: PublicKey;
  tokenDevFeeAccount: PublicKey;
  tokenHolderRewardsAccount: PublicKey;
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
    solTeamWallet: new PublicKey(data.subarray(200, 232)),
    solDevBuybackWallet: new PublicKey(data.subarray(232, 264)),
    solHolderRewardsWallet: new PublicKey(data.subarray(264, 296)),
    tokenTeamFeeAccount: new PublicKey(data.subarray(296, 328)),
    tokenDevFeeAccount: new PublicKey(data.subarray(328, 360)),
    tokenHolderRewardsAccount: new PublicKey(data.subarray(360, 392)),
    currentSeedHashHex: data.subarray(392, 424).toString("hex"),
    seedEpoch: data.readBigUInt64LE(424),
    feeBps: data.readUInt16LE(432),
    outstandingLiability: readU128LE(data, 452),
    paused: data.readUInt8(468) === 1,
    solVault: new PublicKey(data.subarray(509, 541)),
    solMinBet: data.readBigUInt64LE(541),
    solMaxBet: data.readBigUInt64LE(549),
    outstandingLiabilitySol: readU128LE(data, 557),
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
export function buildSettleIx(bet: DecodedBet): TransactionInstruction {
  const player = bet.player;
  const nonce = bet.nonce;
  const randomnessAccount = bet.randomnessAccount;
  const cfg = configPda();
  const keys = [
    { pubkey: config.settleAuthority.publicKey, isSigner: true, isWritable: false },
    { pubkey: cfg, isSigner: false, isWritable: true },
    { pubkey: betPda(player, nonce), isSigner: false, isWritable: true },
    { pubkey: player, isSigner: false, isWritable: true },
    { pubkey: vaultPda(cfg), isSigner: false, isWritable: true },
    { pubkey: getAssociatedTokenAddressSync(TOKEN_MINT, player), isSigner: false, isWritable: true },
    { pubkey: bet.feeTeamRecipient, isSigner: false, isWritable: true },
    { pubkey: bet.feeDevRecipient, isSigner: false, isWritable: true },
    { pubkey: bet.feeHolderRewardsRecipient, isSigner: false, isWritable: true },
    { pubkey: TOKEN_MINT, isSigner: false, isWritable: true },
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

export function buildSettleSolIx(bet: DecodedBet): TransactionInstruction {
  const player = bet.player;
  const nonce = bet.nonce;
  const randomnessAccount = bet.randomnessAccount;
  const cfg = configPda();
  const keys = [
    { pubkey: config.settleAuthority.publicKey, isSigner: true, isWritable: false },
    { pubkey: cfg, isSigner: false, isWritable: true },
    { pubkey: betPda(player, nonce), isSigner: false, isWritable: true },
    { pubkey: player, isSigner: false, isWritable: true },
    { pubkey: solVaultPda(cfg), isSigner: false, isWritable: true },
    { pubkey: bet.feeTeamRecipient, isSigner: false, isWritable: true },
    { pubkey: bet.feeDevRecipient, isSigner: false, isWritable: true },
    { pubkey: bet.feeHolderRewardsRecipient, isSigner: false, isWritable: true },
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
    commitment: "finalized",
    skipPreflight: false,
  });
}
