import { PublicKey } from "@solana/web3.js";
import { RewardCycleModel } from "../models/RewardCycle";
import { RewardPayoutModel } from "../models/RewardPayout";

export interface HolderBalance { owner: string; amount: bigint; }
export interface RewardPreview { owner: string; amount: bigint; }

export function aggregateOwners(rows: HolderBalance[], excluded: Set<string>): HolderBalance[] {
  const totals = new Map<string, bigint>();
  for (const row of rows) {
    const owner = new PublicKey(row.owner).toBase58();
    if (excluded.has(owner) || row.amount <= 0n) continue;
    totals.set(owner, (totals.get(owner) ?? 0n) + row.amount);
  }
  return [...totals.entries()].map(([owner, amount]) => ({ owner, amount })).sort((a, b) => a.owner.localeCompare(b.owner));
}

export function allocateRewards(holders: HolderBalance[], total: bigint): { payouts: RewardPreview[]; dust: bigint } {
  if (total <= 0n) throw new Error("total reward amount must be positive");
  const supply = holders.reduce((acc, h) => acc + h.amount, 0n);
  if (supply <= 0n) throw new Error("no eligible holder balance");
  let distributed = 0n;
  const payouts = holders.map((h) => {
    const amount = (total * h.amount) / supply;
    distributed += amount;
    return { owner: h.owner, amount };
  }).filter((p) => p.amount > 0n);
  return { payouts, dust: total - distributed };
}

export async function createRewardCycle(params: { asset: "sol" | "token"; sourceWallet: string; mint?: string; totalAmount: bigint; holders: HolderBalance[]; excludedWallets?: string[]; idempotencyKey: string; }) {
  const excluded = new Set((params.excludedWallets ?? []).map((w) => new PublicKey(w).toBase58()));
  const holders = aggregateOwners(params.holders, excluded);
  const { payouts, dust } = allocateRewards(holders, params.totalAmount);
  const cycle = await RewardCycleModel.findOneAndUpdate(
    { idempotencyKey: params.idempotencyKey },
    { $setOnInsert: { asset: params.asset, sourceWallet: new PublicKey(params.sourceWallet).toBase58(), mint: params.mint ?? null, totalAmount: params.totalAmount.toString(), dustAmount: dust.toString(), excludedWallets: [...excluded], status: "preview", idempotencyKey: params.idempotencyKey, summary: { eligibleHolders: holders.length, payouts: payouts.length } } },
    { upsert: true, new: true }
  );
  for (const p of payouts) {
    await RewardPayoutModel.updateOne(
      { idempotencyKey: `${params.idempotencyKey}:${p.owner}` },
      { $setOnInsert: { cycle: cycle._id, owner: p.owner, amount: p.amount.toString(), asset: params.asset, destination: p.owner, status: "pending", idempotencyKey: `${params.idempotencyKey}:${p.owner}` } },
      { upsert: true }
    );
  }
  return cycle;
}

export async function markPayoutSent(idempotencyKey: string, signature: string) {
  await RewardPayoutModel.updateOne({ idempotencyKey, status: { $ne: "sent" } }, { $set: { status: "sent", signature, lastError: null }, $inc: { attempts: 1 } });
}

/** Record a failed send attempt; the distributor retries it on later runs up to
 *  the configured attempt cap. Never touches rows already marked sent. */
export async function markPayoutFailed(idempotencyKey: string, error: string) {
  await RewardPayoutModel.updateOne({ idempotencyKey, status: { $ne: "sent" } }, { $set: { status: "failed", lastError: error.slice(0, 500) }, $inc: { attempts: 1 } });
}

export async function retryFailedPayouts(cycleId: string) {
  return RewardPayoutModel.updateMany({ cycle: cycleId, status: "failed" }, { $set: { status: "pending", lastError: null } });
}
