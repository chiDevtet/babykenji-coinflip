import { BACKEND_URL } from "./constants";

export interface Commitment {
  epoch: number;
  commitHashHex: string;
  onchainSeedHashHex: string | null;
  inSync: boolean | null;
}

export interface SettleResult {
  won: boolean;
  resultBit: number;
  resultLabel: "heads" | "tails";
  payout: string;
  settleTx: string;
}

export async function getCommitment(): Promise<Commitment> {
  const r = await fetch(`${BACKEND_URL}/api/fairness/commitment`);
  if (!r.ok) throw new Error("failed to load fairness commitment");
  return r.json();
}

export async function settleBet(player: string, nonce: number): Promise<SettleResult> {
  const r = await fetch(`${BACKEND_URL}/api/bets/settle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ player, nonce }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "settlement failed");
  return data as SettleResult;
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
