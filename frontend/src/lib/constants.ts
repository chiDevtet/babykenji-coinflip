import { PublicKey } from "@solana/web3.js";

const env = import.meta.env;

export const RPC_URL: string = env.VITE_RPC_URL || "https://api.devnet.solana.com";
export const BACKEND_URL: string = env.VITE_BACKEND_URL || "http://localhost:8787";

// System Program id — a valid, harmless stand-in so the app can still render
// (in preview mode) when the real ids aren't configured yet.
const PLACEHOLDER = "11111111111111111111111111111111";

function readPk(v: string | undefined): { key: PublicKey; ok: boolean } {
  if (!v || v.startsWith("REPLACE_WITH")) return { key: new PublicKey(PLACEHOLDER), ok: false };
  try {
    return { key: new PublicKey(v), ok: true };
  } catch {
    return { key: new PublicKey(PLACEHOLDER), ok: false };
  }
}

const _program = readPk(env.VITE_PROGRAM_ID);
const _mint = readPk(env.VITE_TOKEN_MINT);

export const PROGRAM_ID = _program.key;
export const TOKEN_MINT = _mint.key;

/** True only when BOTH the program id and token mint are real (not placeholders). */
export const CONFIGURED = _program.ok && _mint.ok;

export const HEADS = 0;
export const TAILS = 1;

/** Wager asset. SOL is native SOL (different on-chain plumbing than the SPL path). */
export type Asset = "token" | "sol";
