import {
  Connection,
  PublicKey,
  SystemProgram,
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
  pendingAdmin: PublicKey;
  settleAuthority: PublicKey;
  randomnessAuthority: PublicKey;
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
  solPlayerWinPayoutBps: number;
  tokenPlayerWinPayoutBps: number;
  minBet: bigint;
  maxBet: bigint;
  maxPayoutBpsOfTreasury: number;
  outstandingLiability: bigint;
  paused: boolean;
  totalBets: bigint;
  totalWagered: bigint;
  totalPaidOut: bigint;
  solVault: PublicKey;
  solMinBet: bigint;
  solMaxBet: bigint;
  outstandingLiabilitySol: bigint;
}

// Sequential cursor over the exact Rust GameConfig field order (see the struct
// in program/programs/forge-coinflip/src/lib.rs). An earlier version of this
// decoder used magic offsets that predated the split into separate SOL/token
// payout-bps fields, so outstanding/paused/sol_vault were read 4 bytes off;
// walking the declaration order keeps the offsets self-consistent.
export function decodeConfig(data: Buffer): DecodedConfig {
  let off = 8; // skip anchor account discriminator
  const pk = () => new PublicKey(data.subarray(off, (off += 32)));
  const u16 = () => { const v = data.readUInt16LE(off); off += 2; return v; };
  const u64 = () => { const v = data.readBigUInt64LE(off); off += 8; return v; };
  const u128 = () => { const v = readU128LE(data, off); off += 16; return v; };
  const u8 = () => data.readUInt8(off++);
  const bytes = (n: number) => data.subarray(off, (off += n));

  const admin = pk();
  const pendingAdmin = pk();
  const settleAuthority = pk();
  const randomnessAuthority = pk();
  const tokenMint = pk();
  const treasuryVault = pk();
  const solTeamWallet = pk();
  const solDevBuybackWallet = pk();
  const solHolderRewardsWallet = pk();
  const tokenTeamFeeAccount = pk();
  const tokenDevFeeAccount = pk();
  const tokenHolderRewardsAccount = pk();
  const currentSeedHashHex = bytes(32).toString("hex");
  const seedEpoch = u64();
  const feeBps = u16();
  const solPlayerWinPayoutBps = u16();
  const tokenPlayerWinPayoutBps = u16();
  const minBet = u64();
  const maxBet = u64();
  const maxPayoutBpsOfTreasury = u16();
  const outstandingLiability = u128();
  const paused = u8() === 1;
  const totalBets = u64();
  const totalWagered = u128();
  const totalPaidOut = u128();
  const solVault = pk();
  const solMinBet = u64();
  const solMaxBet = u64();
  const outstandingLiabilitySol = u128();

  return {
    admin, pendingAdmin, settleAuthority, randomnessAuthority, tokenMint,
    treasuryVault, solTeamWallet, solDevBuybackWallet, solHolderRewardsWallet,
    tokenTeamFeeAccount, tokenDevFeeAccount, tokenHolderRewardsAccount,
    currentSeedHashHex, seedEpoch, feeBps, solPlayerWinPayoutBps,
    tokenPlayerWinPayoutBps, minBet, maxBet, maxPayoutBpsOfTreasury,
    outstandingLiability, paused, totalBets, totalWagered, totalPaidOut,
    solVault, solMinBet, solMaxBet, outstandingLiabilitySol,
  };
}

export async function fetchBet(player: PublicKey, nonce: number | bigint): Promise<DecodedBet | null> {
  const info = await connection.getAccountInfo(betPda(player, nonce));
  if (!info) return null;
  return decodeBet(info.data);
}

// PlayerState layout: disc(8) player(32) config(32) nonce(u64 @72) bump(@80). The
// next bet uses the current nonce; a missing account means the player's first bet
// (nonce 0). Mirrors the frontend's fetchPlayerNonce so PDAs line up.
export async function fetchPlayerNonce(player: PublicKey): Promise<bigint> {
  const info = await connection.getAccountInfo(playerStatePda(configPda(), player));
  if (!info) return 0n;
  return info.data.readBigUInt64LE(72);
}

function encodePlaceBetData(ix: "place_bet" | "place_bet_sol", amount: bigint, choice: number, clientSeed: Buffer): Buffer {
  if (clientSeed.length !== 32) throw new Error("clientSeed must be 32 bytes");
  const data = Buffer.alloc(8 + 8 + 1 + 32);
  ixDisc(ix).copy(data, 0);
  data.writeBigUInt64LE(amount, 8);
  data.writeUInt8(choice, 16);
  clientSeed.copy(data, 17);
  return data;
}

// place_bet_sol — account order MUST match the Rust PlaceBetSol context (same as
// the frontend builder). Built server-side so the settle authority can be the
// randomness authority; the player signs as fee payer + wager source.
export function buildPlaceBetSolIx(
  player: PublicKey,
  amount: bigint,
  choice: number,
  clientSeed: Buffer,
  nonce: number | bigint,
  randomnessAccount: PublicKey
): TransactionInstruction {
  const cfg = configPda();
  const keys = [
    { pubkey: player, isSigner: true, isWritable: true },
    { pubkey: cfg, isSigner: false, isWritable: true },
    { pubkey: playerStatePda(cfg, player), isSigner: false, isWritable: true },
    { pubkey: betPda(player, nonce), isSigner: false, isWritable: true },
    { pubkey: solVaultPda(cfg), isSigner: false, isWritable: true },
    { pubkey: randomnessAccount, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: encodePlaceBetData("place_bet_sol", amount, choice, clientSeed) });
}

// place_bet (SPL token) — account order MUST match the Rust PlaceBet context.
export function buildPlaceBetIx(
  player: PublicKey,
  amount: bigint,
  choice: number,
  clientSeed: Buffer,
  nonce: number | bigint,
  randomnessAccount: PublicKey
): TransactionInstruction {
  const cfg = configPda();
  const keys = [
    { pubkey: player, isSigner: true, isWritable: true },
    { pubkey: cfg, isSigner: false, isWritable: true },
    { pubkey: playerStatePda(cfg, player), isSigner: false, isWritable: true },
    { pubkey: betPda(player, nonce), isSigner: false, isWritable: true },
    { pubkey: vaultPda(cfg), isSigner: false, isWritable: true },
    { pubkey: getAssociatedTokenAddressSync(TOKEN_MINT, player), isSigner: false, isWritable: true },
    { pubkey: randomnessAccount, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: encodePlaceBetData("place_bet", amount, choice, clientSeed) });
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

/** Fields an admin may change via update_config. Omitted fields stay unchanged
 *  (encoded as borsh None), so a partial update can never clobber the rest. */
export interface UpdateConfigParams {
  settleAuthority?: PublicKey;
  feeBps?: number;
  solPlayerWinPayoutBps?: number;
  tokenPlayerWinPayoutBps?: number;
  minBet?: bigint;
  maxBet?: bigint;
  maxPayoutBpsOfTreasury?: number;
  paused?: boolean;
  solMinBet?: bigint;
  solMaxBet?: bigint;
}

// Borsh-encodes UpdateParams in the exact Rust field order (lib.rs UpdateParams):
// settle_authority, fee_bps, sol_player_win_payout_bps, token_player_win_payout_bps,
// min_bet, max_bet, max_payout_bps_of_treasury, paused, sol_min_bet, sol_max_bet.
// The instruction must be SIGNED BY GameConfig.admin — the backend only builds
// and simulates it; the admin wallet signs in the dashboard.
export function buildUpdateConfigIx(admin: PublicKey, params: UpdateConfigParams): TransactionInstruction {
  const none = Buffer.from([0]);
  const someU16 = (v: number) => {
    const b = Buffer.alloc(3);
    b.writeUInt8(1, 0);
    b.writeUInt16LE(v, 1);
    return b;
  };
  const someU64 = (v: bigint) => {
    const b = Buffer.alloc(9);
    b.writeUInt8(1, 0);
    b.writeBigUInt64LE(v, 1);
    return b;
  };
  const someBool = (v: boolean) => Buffer.from([1, v ? 1 : 0]);
  const somePubkey = (v: PublicKey) => Buffer.concat([Buffer.from([1]), v.toBuffer()]);

  const data = Buffer.concat([
    ixDisc("update_config"),
    params.settleAuthority !== undefined ? somePubkey(params.settleAuthority) : none,
    params.feeBps !== undefined ? someU16(params.feeBps) : none,
    params.solPlayerWinPayoutBps !== undefined ? someU16(params.solPlayerWinPayoutBps) : none,
    params.tokenPlayerWinPayoutBps !== undefined ? someU16(params.tokenPlayerWinPayoutBps) : none,
    params.minBet !== undefined ? someU64(params.minBet) : none,
    params.maxBet !== undefined ? someU64(params.maxBet) : none,
    params.maxPayoutBpsOfTreasury !== undefined ? someU16(params.maxPayoutBpsOfTreasury) : none,
    params.paused !== undefined ? someBool(params.paused) : none,
    params.solMinBet !== undefined ? someU64(params.solMinBet) : none,
    params.solMaxBet !== undefined ? someU64(params.solMaxBet) : none,
  ]);
  const keys = [
    { pubkey: admin, isSigner: true, isWritable: false },
    { pubkey: configPda(), isSigner: false, isWritable: true },
  ];
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
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
