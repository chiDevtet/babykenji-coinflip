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

const settleAuthority = loadKeypair(required("SETTLE_AUTHORITY_KEYPAIR_PATH"));

export const config = {
  rpcUrl: required("RPC_URL"),
  programId: new PublicKey(required("PROGRAM_ID")),
  tokenMint: new PublicKey(required("TOKEN_MINT")),
  settleAuthority,
  mongoUri: process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/forge_coinflip",
  port: parseInt(process.env.PORT || "8787", 10),
  corsOrigins: (process.env.CORS_ORIGINS || "http://localhost:5173").split(",").map((s) => s.trim()),
};

// Public pubkey is safe to log; the secret key is not.
export const settleAuthorityPubkey = settleAuthority.publicKey;
