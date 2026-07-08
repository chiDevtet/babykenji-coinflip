import { BACKEND_URL } from "./constants";

export interface Commitment {
  epoch: number;
  commitHashHex: string;
  onchainSeedHashHex: string | null;
  inSync: boolean | null;
}

export interface SettleResult {
  won: boolean;
  resultBit: number | null;
  resultLabel: "heads" | "tails" | null;
  payout: string;
  settleTx: string;
}

/** A create+commit+place_bet transaction the backend has partially signed (settle
 *  authority + randomness keypair). The player adds their signature and submits. */
export interface PreparedFlip {
  transaction: string; // base64-encoded legacy transaction
  randomnessAccount: string;
  nonce: number;
  blockhash: string;
  lastValidBlockHeight: number;
}

export async function preparePlaceBet(params: {
  player: string;
  amount: string; // base units
  choice: number; // 0 heads, 1 tails
  clientSeedHex: string; // 32 bytes hex
  asset: "sol" | "token";
}): Promise<PreparedFlip> {
  const r = await fetch(`${BACKEND_URL}/api/bets/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "failed to prepare flip");
  return data as PreparedFlip;
}

export async function getCommitment(): Promise<Commitment> {
  const r = await fetch(`${BACKEND_URL}/api/fairness/commitment`);
  if (!r.ok) throw new Error("failed to load fairness commitment");
  return r.json();
}

export async function settleBet(player: string, nonce: number): Promise<SettleResult> {
  // The backend answers 409 { retryable: true } while its RPC node hasn't seen
  // the freshly-placed Bet PDA yet (it already polls server-side; this covers
  // longer propagation gaps). Retry a few times before surfacing an error.
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(`${BACKEND_URL}/api/bets/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ player, nonce }),
    });
    const data = await r.json();
    if (r.ok) return data as SettleResult;
    if (data?.retryable && attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
    }
    throw new Error(data.error || "settlement failed");
  }
}

export interface VerifyResult {
  commitmentValid: boolean;
  resultBit: number;
  resultLabel: "heads" | "tails";
  won: boolean;
}

export async function verifyBet(params: {
  serverSeedHex?: string;
  epoch?: number;
  player: string;
  clientSeedHex: string;
  nonce: number;
  choice: number;
}): Promise<VerifyResult> {
  const r = await fetch(`${BACKEND_URL}/api/fairness/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "verification failed");
  return data as VerifyResult;
}

/** One settled bet from the public history mirror (only data already public on-chain). */
export interface RecentBet {
  player: string;
  nonce: number;
  choice: number; // 0 heads, 1 tails
  asset: "token" | "sol";
  amount: string; // base units
  payout: string; // base units
  won: boolean;
  settleTx: string | null;
  createdAt: string; // ISO timestamp
}

/** Latest settled bets, newest first, for the Live Flips feed. Errors propagate to the caller. */
export async function getRecentBets(limit = 50, signal?: AbortSignal): Promise<RecentBet[]> {
  const r = await fetch(`${BACKEND_URL}/api/bets/recent?limit=${limit}`, { signal });
  if (!r.ok) throw new Error("failed to load recent bets");
  const data = await r.json();
  return (data.bets ?? []) as RecentBet[];
}
