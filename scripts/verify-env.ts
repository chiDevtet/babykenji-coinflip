import { PublicKey } from "@solana/web3.js";

const PLACEHOLDER_PREFIXES = ["REPLACE_WITH", "<"];
const REQUIRED_KEYS = ["PROGRAM_ID", "TOKEN_MINT", "SWITCHBOARD_QUEUE"];
const OPTIONAL_KEYS = ["SWITCHBOARD_PROGRAM_ID", "ADMIN_WALLET", "SETTLE_AUTHORITY", "RANDOMNESS_AUTHORITY", "SOL_TEAM_WALLET", "SOL_DEV_BUYBACK_WALLET", "SOL_HOLDER_REWARDS_WALLET", "TOKEN_TEAM_FEE_ACCOUNT", "TOKEN_DEV_FEE_ACCOUNT", "TOKEN_HOLDER_REWARDS_ACCOUNT"];
const BAD_KEYS = new Set(["11111111111111111111111111111111", "So11111111111111111111111111111111111111112"]);

function env(name: string, required = true): string | undefined {
  const v = process.env[name];
  if (!v) {
    if (required) throw new Error(`Missing ${name}`);
    return undefined;
  }
  if (PLACEHOLDER_PREFIXES.some((p) => v.startsWith(p)) || v.includes("placeholder")) throw new Error(`${name} is a placeholder`);
  return v;
}
function pk(name: string, required = true): string | undefined {
  const v = env(name, required);
  if (!v) return undefined;
  const p = new PublicKey(v).toBase58();
  if (BAD_KEYS.has(p)) throw new Error(`${name} uses unsafe placeholder/system address`);
  return p;
}
function int(name: string, fallback?: number): number {
  const raw = process.env[name] ?? (fallback === undefined ? undefined : String(fallback));
  if (raw === undefined) throw new Error(`Missing ${name}`);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

function main() {
  if (process.env.RPC_URL && process.env.RPC_URL.startsWith("<")) throw new Error("RPC_URL is a placeholder");
  for (const k of REQUIRED_KEYS) pk(k);
  for (const k of OPTIONAL_KEYS) pk(k, false);
  const total = int("TOTAL_FEE_BPS", 1000);
  if (total <= 0 || total > 1000) throw new Error("TOTAL_FEE_BPS must be 1..1000");
  for (const name of ["SOL_PLAYER_WIN_PAYOUT_BPS", "TOKEN_PLAYER_WIN_PAYOUT_BPS"]) {
    const payout = int(name, 17800);
    if (payout < 10000) throw new Error(`${name} must be at least 10000`);
    if (payout + total > 20000) throw new Error(`${name} + TOTAL_FEE_BPS exceeds 20000`);
  }
  const tokenSplit = [500, 166, 167, 167].reduce((a, b) => a + b, 0);
  const solSplit = [500, 300, 200].reduce((a, b) => a + b, 0);
  if (tokenSplit !== total || solSplit !== total) throw new Error("documented fee splits must sum to TOTAL_FEE_BPS=1000");
  console.log("Environment validation passed");
}
main();
