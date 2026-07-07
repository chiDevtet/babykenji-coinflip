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
  solPlayerWinPayoutBps: number;
  tokenPlayerWinPayoutBps: number;
  minBet: bigint;
  maxBet: bigint;
  maxPayoutBpsOfTreasury: number;
  paused: boolean;
  seedEpoch: bigint;
  currentSeedHashHex: string;
  solMinBet: bigint;
  solMaxBet: bigint;
  outstandingLiability: bigint;
  outstandingLiabilitySol: bigint;
  treasuryVault: PublicKey;
  solVault: PublicKey;
}

// Native-SOL vault account size: 8 (anchor discriminator) + 1 (bump). Used to
// exclude the rent-exempt reserve from the SOL treasury's spendable balance,
// matching the program's own rent handling in place_bet_sol.
const SOL_VAULT_ACCOUNT_SPACE = 8 + 1;

// Sequential reader over Anchor account data. Fields have no padding and are laid
// out in declaration order, so walking a cursor keeps the offsets self-consistent
// with the Rust `GameConfig` struct — far less error-prone than magic offsets.
class Cursor {
  private off: number;
  constructor(private readonly data: Uint8Array, private readonly dv: DataView, start: number) {
    this.off = start;
  }
  skip(n: number): this {
    this.off += n;
    return this;
  }
  u8(): number {
    return this.data[this.off++];
  }
  u16(): number {
    const v = this.dv.getUint16(this.off, true);
    this.off += 2;
    return v;
  }
  u64(): bigint {
    const v = this.dv.getBigUint64(this.off, true);
    this.off += 8;
    return v;
  }
  u128(): bigint {
    const lo = this.dv.getBigUint64(this.off, true);
    const hi = this.dv.getBigUint64(this.off + 8, true);
    this.off += 16;
    return lo + (hi << 64n);
  }
  bytes(n: number): Uint8Array {
    const b = this.data.subarray(this.off, this.off + n);
    this.off += n;
    return b;
  }
  pubkey(): PublicKey {
    return new PublicKey(this.bytes(32));
  }
}

// Decodes the on-chain GameConfig. The cursor walks the exact Rust field order:
//   admin, pending_admin, settle_authority, randomness_authority, token_mint,
//   treasury_vault, sol_team_wallet, sol_dev_buyback_wallet, sol_holder_rewards_wallet,
//   token_team_fee_account, token_dev_fee_account, token_holder_rewards_account,
//   current_seed_hash[32], seed_epoch u64, fee_bps u16, sol_player_win_payout_bps u16,
//   token_player_win_payout_bps u16, min_bet u64, max_bet u64,
//   max_payout_bps_of_treasury u16, outstanding_liability u128, paused bool,
//   total_bets u64, total_wagered u128, total_paid_out u128, sol_vault,
//   sol_min_bet u64, sol_max_bet u64, outstanding_liability_sol u128, bump u8.
export async function fetchConfigView(connection: Connection): Promise<ConfigView | null> {
  const info = await connection.getAccountInfo(configPda());
  if (!info) return null;
  const dv = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength);
  const c = new Cursor(info.data, dv, 8); // skip the 8-byte account discriminator

  c.skip(32 * 5); // admin, pending_admin, settle_authority, randomness_authority, token_mint
  const treasuryVault = c.pubkey();
  c.skip(32 * 6); // sol_team, sol_dev, sol_holder, token_team, token_dev, token_holder
  const seedHash = c.bytes(32);
  const seedEpoch = c.u64();
  const feeBps = c.u16();
  const solPlayerWinPayoutBps = c.u16();
  const tokenPlayerWinPayoutBps = c.u16();
  const minBet = c.u64();
  const maxBet = c.u64();
  const maxPayoutBpsOfTreasury = c.u16();
  const outstandingLiability = c.u128();
  const paused = c.u8() === 1;
  c.skip(8); // total_bets
  c.skip(16); // total_wagered
  c.skip(16); // total_paid_out
  const solVault = c.pubkey();
  const solMinBet = c.u64();
  const solMaxBet = c.u64();
  const outstandingLiabilitySol = c.u128();

  const hex = Array.from(seedHash).map((b) => b.toString(16).padStart(2, "0")).join("");
  return {
    feeBps,
    solPlayerWinPayoutBps,
    tokenPlayerWinPayoutBps,
    minBet,
    maxBet,
    maxPayoutBpsOfTreasury,
    seedEpoch,
    currentSeedHashHex: hex,
    paused,
    solMinBet,
    solMaxBet,
    outstandingLiability,
    outstandingLiabilitySol,
    treasuryVault,
    solVault,
  };
}

export interface VaultBalances {
  /** Spendable SPL-token treasury balance (base units). */
  tokenVault: bigint;
  /** Spendable native-SOL treasury balance (lamports, excluding the rent reserve). */
  solVaultSpendable: bigint;
}

// Live house-vault balances, used to derive the treasury-based wager ceiling.
// Reads the token vault's amount and the SOL vault's lamports minus its rent
// reserve (which the program can never pay out).
export async function fetchVaultBalances(connection: Connection, cfg: ConfigView): Promise<VaultBalances> {
  let tokenVault = 0n;
  let solVaultSpendable = 0n;
  try {
    const bal = await connection.getTokenAccountBalance(cfg.treasuryVault);
    tokenVault = BigInt(bal.value.amount);
  } catch {
    tokenVault = 0n;
  }
  try {
    const lamports = BigInt(await connection.getBalance(cfg.solVault));
    const rent = BigInt(await connection.getMinimumBalanceForRentExemption(SOL_VAULT_ACCOUNT_SPACE));
    solVaultSpendable = lamports > rent ? lamports - rent : 0n;
  } catch {
    solVaultSpendable = 0n;
  }
  return { tokenVault, solVaultSpendable };
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
