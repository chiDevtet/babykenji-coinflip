import { PublicKey, TransactionInstruction, SystemProgram, Connection } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { sha256 } from "@noble/hashes/sha256";
import { PROGRAM_ID, TOKEN_MINT } from "./constants";

const enc = (s: string) => new TextEncoder().encode(s);

function ixDisc(name: string): Uint8Array {
  return sha256(enc(`global:${name}`)).slice(0, 8);
}

// --- PDAs (mirror the program seeds) ---
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
function nonceLe(nonce: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, nonce, true);
  return b;
}
export function betPda(player: PublicKey, nonce: bigint): PublicKey {
  return PublicKey.findProgramAddressSync(
    [enc("bet"), player.toBuffer(), nonceLe(nonce)],
    PROGRAM_ID
  )[0];
}


// --- Decoders ---
// PlayerState: disc(8) player(32) config(32) nonce(u64 @72) bump(@80)
export async function fetchPlayerNonce(connection: Connection, player: PublicKey): Promise<bigint> {
  const info = await connection.getAccountInfo(playerStatePda(configPda(), player));
  if (!info) return 0n; // not initialized yet => first bet uses nonce 0
  return new DataView(info.data.buffer, info.data.byteOffset).getBigUint64(72, true);
}

export interface ConfigView {
  feeBps: number;
  minBet: bigint;
  maxBet: bigint;
  paused: boolean;
  seedEpoch: bigint;
  currentSeedHashHex: string;
  solMinBet: bigint;
  solMaxBet: bigint;
}

// GameConfig offsets: feeBps u16 @176, min_bet u64 @178, max_bet u64 @186,
// current_seed_hash[32] @136, seed_epoch u64 @168, paused @212,
// sol_min_bet u64 @285, sol_max_bet u64 @293
export async function fetchConfigView(connection: Connection): Promise<ConfigView | null> {
  const info = await connection.getAccountInfo(configPda());
  if (!info) return null;
  const dv = new DataView(info.data.buffer, info.data.byteOffset);
  const hashBytes = info.data.subarray(200, 232);
  const hex = Array.from(hashBytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  return {
    feeBps: dv.getUint16(240, true),
    minBet: dv.getBigUint64(242, true),
    maxBet: dv.getBigUint64(250, true),
    seedEpoch: dv.getBigUint64(232, true),
    currentSeedHashHex: hex,
    paused: info.data[276] === 1,
    solMinBet: dv.getBigUint64(349, true),
    solMaxBet: dv.getBigUint64(357, true),
  };
}

// --- place_bet instruction (account order matches the Rust PlaceBet context) ---
export function buildPlaceBetIx(
  player: PublicKey,
  amount: bigint,
  choice: number,
  clientSeed: Uint8Array, // 32 bytes
  nonce: bigint,
  randomnessAccount: PublicKey
): TransactionInstruction {
  if (clientSeed.length !== 32) throw new Error("clientSeed must be 32 bytes");
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

  const data = new Uint8Array(8 + 8 + 1 + 32);
  data.set(ixDisc("place_bet"), 0);
  new DataView(data.buffer).setBigUint64(8, amount, true);
  data[16] = choice;
  data.set(clientSeed, 17);

  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: Buffer.from(data) });
}

// --- place_bet_sol instruction (account order matches the Rust PlaceBetSol context) ---
export function buildPlaceBetSolIx(
  player: PublicKey,
  amount: bigint,
  choice: number,
  clientSeed: Uint8Array, // 32 bytes
  nonce: bigint,
  randomnessAccount: PublicKey
): TransactionInstruction {
  if (clientSeed.length !== 32) throw new Error("clientSeed must be 32 bytes");
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

  const data = new Uint8Array(8 + 8 + 1 + 32);
  data.set(ixDisc("place_bet_sol"), 0);
  new DataView(data.buffer).setBigUint64(8, amount, true);
  data[16] = choice;
  data.set(clientSeed, 17);

  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: Buffer.from(data) });
}
