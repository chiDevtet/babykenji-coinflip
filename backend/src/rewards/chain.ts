import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { HolderBalance } from "./worker";

/**
 * Chain access for the rewards distributor.
 *
 * Deliberately self-contained: src/config.ts force-loads the settle-authority
 * keypair at import time, and this worker must run (and dry-run) WITHOUT the
 * settle key ever being present. It therefore reads its own minimal env:
 *   RPC_URL          required — general reads + sending
 *   HELIUS_RPC_URL   optional — used for the holder scan (getProgramAccounts
 *                    over all token accounts of the mint), which most public
 *                    RPCs reject. Falls back to RPC_URL.
 *   PROGRAM_ID       required — the live coin-flip program
 *   TOKEN_MINT       required — the $BABYK mint
 */
function required(name: string): string {
  const v = process.env[name];
  if (!v || v.startsWith("REPLACE_WITH") || v.startsWith("<")) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export interface RewardsChainEnv {
  connection: Connection;
  scanConnection: Connection;
  programId: PublicKey;
  tokenMint: PublicKey;
}

export function loadChainEnv(): RewardsChainEnv {
  const rpcUrl = required("RPC_URL");
  const scanUrl = process.env.HELIUS_RPC_URL && !process.env.HELIUS_RPC_URL.startsWith("REPLACE_WITH")
    ? process.env.HELIUS_RPC_URL
    : rpcUrl;
  return {
    connection: new Connection(rpcUrl, "confirmed"),
    scanConnection: scanUrl === rpcUrl ? new Connection(rpcUrl, "confirmed") : new Connection(scanUrl, "confirmed"),
    programId: new PublicKey(required("PROGRAM_ID")),
    tokenMint: new PublicKey(required("TOKEN_MINT")),
  };
}

// --- GameConfig ---------------------------------------------------------------
// Full sequential decoder over the exact Rust field order (mirrors
// frontend/src/lib/anchorIx.ts fetchConfigView and the GameConfig struct in
// program/programs/forge-coinflip/src/lib.rs). The distributor discovers the
// fee/rewards accounts from chain state instead of env so there is a single
// source of truth for where fees accumulate.
export interface RewardsGameConfig {
  admin: PublicKey;
  tokenMint: PublicKey;
  treasuryVault: PublicKey;
  solTeamWallet: PublicKey;
  solDevBuybackWallet: PublicKey;
  solHolderRewardsWallet: PublicKey;
  tokenTeamFeeAccount: PublicKey;
  tokenDevFeeAccount: PublicKey;
  tokenHolderRewardsAccount: PublicKey;
  configPda: PublicKey;
  solVault: PublicKey;
}

export async function fetchRewardsGameConfig(env: RewardsChainEnv): Promise<RewardsGameConfig> {
  const configPda = PublicKey.findProgramAddressSync(
    [Buffer.from("config", "utf-8"), env.tokenMint.toBuffer()],
    env.programId
  )[0];
  const info = await env.connection.getAccountInfo(configPda);
  if (!info) throw new Error(`GameConfig not found at ${configPda.toBase58()} — wrong PROGRAM_ID/TOKEN_MINT?`);
  const d = info.data;
  let off = 8;
  const pk = () => new PublicKey(d.subarray(off, (off += 32)));
  const admin = pk();
  pk(); // pending_admin
  pk(); // settle_authority
  pk(); // randomness_authority
  const tokenMint = pk();
  const treasuryVault = pk();
  const solTeamWallet = pk();
  const solDevBuybackWallet = pk();
  const solHolderRewardsWallet = pk();
  const tokenTeamFeeAccount = pk();
  const tokenDevFeeAccount = pk();
  const tokenHolderRewardsAccount = pk();
  // Remaining fields (seed hash, economics, counters, sol_vault, …) are not
  // needed here except sol_vault, which sits at a fixed offset after the
  // economics block: 8 (disc) + 12*32 (pubkeys) + 32 (seed) + 8 (epoch)
  // + 3*2 (bps) + 8 (min_bet) + 8 (max_bet) + 2 (cap) + 16 (liability)
  // + 1 (paused) + 8 (total_bets) + 16 (wagered) + 16 (paid) = 513.
  const solVault = new PublicKey(d.subarray(513, 545));
  if (!tokenMint.equals(env.tokenMint)) throw new Error("on-chain config mint does not match TOKEN_MINT");
  return {
    admin, tokenMint, treasuryVault, solTeamWallet, solDevBuybackWallet,
    solHolderRewardsWallet, tokenTeamFeeAccount, tokenDevFeeAccount,
    tokenHolderRewardsAccount, configPda, solVault,
  };
}

// --- balances -------------------------------------------------------------------
export async function fetchTokenAccountAmount(conn: Connection, tokenAccount: PublicKey): Promise<bigint> {
  const bal = await conn.getTokenAccountBalance(tokenAccount);
  return BigInt(bal.value.amount);
}

/** Owner pubkey (authority) of an SPL token account — the keypair that must sign transfers out of it. */
export async function fetchTokenAccountOwner(conn: Connection, tokenAccount: PublicKey): Promise<PublicKey> {
  const info = await conn.getAccountInfo(tokenAccount);
  if (!info) throw new Error(`token account ${tokenAccount.toBase58()} not found`);
  return new PublicKey(info.data.subarray(32, 64));
}

export async function fetchMintSupply(conn: Connection, mint: PublicKey): Promise<bigint> {
  const s = await conn.getTokenSupply(mint);
  return BigInt(s.value.amount);
}

// --- holder scan ------------------------------------------------------------------
// All token accounts of the mint, sliced to (owner, amount) to keep the
// response small. Aggregation to owner level + exclusions happens in the
// planner via aggregateOwners.
const TOKEN_ACCOUNT_SIZE = 165;
const OWNER_OFFSET = 32;
const AMOUNT_OFFSET = 64;

export async function scanHolders(env: RewardsChainEnv): Promise<HolderBalance[]> {
  const accounts = await env.scanConnection.getProgramAccounts(TOKEN_PROGRAM_ID, {
    commitment: "confirmed",
    filters: [
      { dataSize: TOKEN_ACCOUNT_SIZE },
      { memcmp: { offset: 0, bytes: env.tokenMint.toBase58() } },
    ],
    dataSlice: { offset: OWNER_OFFSET, length: 40 }, // owner(32) + amount(8)
  });
  return accounts.map(({ account }) => ({
    owner: new PublicKey(account.data.subarray(0, 32)).toBase58(),
    amount: account.data.readBigUInt64LE(32),
  }));
}

/** Spendable lamports of a plain system wallet: balance minus the rent-exempt
 *  floor for a 0-data account minus a fee buffer (the wallet is also the fee
 *  payer for its own distribution transactions). */
export async function fetchSpendableLamports(conn: Connection, wallet: PublicKey, feeBufferLamports: bigint): Promise<bigint> {
  const balance = BigInt(await conn.getBalance(wallet));
  const rentFloor = BigInt(await conn.getMinimumBalanceForRentExemption(0));
  const reserve = rentFloor + feeBufferLamports;
  return balance > reserve ? balance - reserve : 0n;
}
