import * as fs from "fs";
import * as dotenv from "dotenv";
import { Keypair, PublicKey } from "@solana/web3.js";

dotenv.config();

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.startsWith("REPLACE_WITH")) {
    throw new Error(`Missing required env var: ${name} (see .env.example)`);
  }
  return v;
}

/** Load a solana-keygen JSON keypair file. The secret is never logged. */
function loadKeypair(path: string): Keypair {
  if (!fs.existsSync(path)) {
    throw new Error(`Settle-authority keypair not found at ${path}. Generate one with:\n  solana-keygen new -o ${path}`);
  }
  const raw = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function parseBps(name: string, fallback: number): number {
  const raw = process.env[name] ?? String(fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
function validatePayoutBps(totalFeeBps: number, payoutBps: number, name: string): void {
  if (payoutBps + totalFeeBps > 20000) throw new Error(`${name} plus total fee bps exceeds 20000`);
  if (totalFeeBps === 1000 && payoutBps > 19000) throw new Error(`${name} is above 19000 with 10% fees`);
}
const settleAuthority = loadKeypair(required("SETTLE_AUTHORITY_KEYPAIR_PATH"));
const totalFeeBps = parseBps("TOTAL_FEE_BPS", 1000);
const solPlayerWinPayoutBps = parseBps("SOL_PLAYER_WIN_PAYOUT_BPS", 17800);
const tokenPlayerWinPayoutBps = parseBps("TOKEN_PLAYER_WIN_PAYOUT_BPS", 17800);
validatePayoutBps(totalFeeBps, solPlayerWinPayoutBps, "SOL_PLAYER_WIN_PAYOUT_BPS");
validatePayoutBps(totalFeeBps, tokenPlayerWinPayoutBps, "TOKEN_PLAYER_WIN_PAYOUT_BPS");

export const config = {
  rpcUrl: required("RPC_URL"),
  programId: new PublicKey(required("PROGRAM_ID")),
  tokenMint: new PublicKey(required("TOKEN_MINT")),
  switchboardProgramId: new PublicKey(required("SWITCHBOARD_PROGRAM_ID")),
  switchboardQueue: new PublicKey(required("SWITCHBOARD_QUEUE")),
  settleAuthority,
  totalFeeBps,
  solPlayerWinPayoutBps,
  tokenPlayerWinPayoutBps,
  mongoUri: process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/forge_coinflip",
  port: parseInt(process.env.PORT || "8787", 10),
  corsOrigins: (process.env.CORS_ORIGINS || "http://localhost:5173").split(",").map((s) => s.trim()),
};

// Public pubkey is safe to log; the secret key is not.
export const settleAuthorityPubkey = settleAuthority.publicKey;
