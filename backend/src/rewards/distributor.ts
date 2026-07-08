import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { RewardCycleModel } from "../models/RewardCycle";
import { RewardPayoutModel } from "../models/RewardPayout";
import {
  HolderBalance,
  RewardPreview,
  aggregateOwners,
  allocateRewards,
  createRewardCycle,
  markPayoutFailed,
  markPayoutSent,
} from "./worker";
import { DistributionConfig } from "./distributionConfig";
import { RewardsChainEnv, RewardsGameConfig } from "./chain";

export type Asset = "token" | "sol";

const BPS = 10_000n;

// ----------------------------------------------------------------------------
// Planning (pure — unit tested in backend/tests/distributor.test.ts)
// ----------------------------------------------------------------------------
export interface PlanParams {
  asset: Asset;
  /** Distributable balance of the accumulation account (base units / lamports). */
  accumulated: bigint;
  /** Per-asset threshold from the Mongo distribution config. */
  threshold: bigint;
  burnBps: number;
  holderBps: number;
  /** Raw token accounts (owner, amount) from the holder scan. */
  holders: HolderBalance[];
  /** Owner pubkeys that must never receive rewards. */
  excluded: Set<string>;
  /** Current total mint supply (base units). */
  supply: bigint;
  /** Eligibility floor in bps of supply (200 = must hold >= 2% of supply). */
  minHolderSupplyBps: number;
}

export interface DistributionPlan {
  asset: Asset;
  accumulated: bigint;
  threshold: bigint;
  belowThreshold: boolean;
  /** supply * minHolderSupplyBps / 10_000 — minimum holding to qualify. */
  minHolderAmount: bigint;
  eligible: HolderBalance[];
  burnAmount: bigint;
  payoutPool: bigint;
  payouts: RewardPreview[];
  /** Rounding remainder that stays in the accumulation account. */
  dust: bigint;
  /** Pot share intentionally left in the account (10_000 - burnBps - holderBps). */
  retained: bigint;
}

export function planDistribution(p: PlanParams): DistributionPlan {
  const minHolderAmount = (p.supply * BigInt(p.minHolderSupplyBps)) / BPS;
  const eligible = aggregateOwners(p.holders, p.excluded).filter((h) => h.amount >= minHolderAmount);
  const belowThreshold = p.accumulated < p.threshold;

  // SOL cannot burn; any configured burnBps is ignored for the SOL pot.
  const burnBps = p.asset === "token" ? BigInt(p.burnBps) : 0n;
  const holderBps = BigInt(p.holderBps);

  let burnAmount = 0n;
  let payoutPool = 0n;
  let payouts: RewardPreview[] = [];
  let dust = 0n;

  if (!belowThreshold && eligible.length > 0) {
    burnAmount = (p.accumulated * burnBps) / BPS;
    payoutPool = (p.accumulated * holderBps) / BPS;
    if (payoutPool > 0n) {
      const alloc = allocateRewards(eligible, payoutPool);
      payouts = alloc.payouts;
      dust = alloc.dust;
    }
  }

  return {
    asset: p.asset,
    accumulated: p.accumulated,
    threshold: p.threshold,
    belowThreshold,
    minHolderAmount,
    eligible,
    burnAmount,
    payoutPool,
    payouts,
    dust,
    retained: p.accumulated - burnAmount - payoutPool,
  };
}

/** Owners that must never receive rewards regardless of dashboard config:
 *  the program's own accounts and every fee recipient (they hold protocol
 *  funds, not player holdings). */
export function builtinExclusions(game: RewardsGameConfig, sourceOwner: PublicKey | null): Set<string> {
  const set = new Set<string>([
    game.admin.toBase58(),
    game.configPda.toBase58(), // owner/authority of the treasury vault
    game.solVault.toBase58(),
    game.solTeamWallet.toBase58(),
    game.solDevBuybackWallet.toBase58(),
    game.solHolderRewardsWallet.toBase58(),
  ]);
  if (sourceOwner) set.add(sourceOwner.toBase58());
  return set;
}

// ----------------------------------------------------------------------------
// Execution (idempotent, resumable)
// ----------------------------------------------------------------------------
export interface ExecuteContext {
  env: RewardsChainEnv;
  game: RewardsGameConfig;
  cfg: DistributionConfig;
  /** Keypair of the accumulation wallet (owner of the token rewards ATA and
   *  the SOL rewards wallet); signs transfers and pays fees. */
  authority: Keypair;
}

interface PendingPayout {
  idempotencyKey: string;
  owner: string;
  amount: bigint;
}

/** One unfinished cycle at a time per asset: while a cycle still has pending
 *  or retryable payouts, the worker resumes it instead of creating a new one,
 *  so a crash/restart can never double-pay. */
export async function findUnfinishedCycle(asset: Asset): Promise<any | null> {
  return RewardCycleModel.findOne({ asset, status: { $in: ["preview", "running"] } }).sort({ createdAt: 1 });
}

export async function pendingPayoutsForCycle(cycleId: unknown, maxAttempts: number): Promise<PendingPayout[]> {
  const rows: any[] = await RewardPayoutModel.find({
    cycle: cycleId,
    $or: [
      { status: "pending" },
      { status: "failed", attempts: { $lt: maxAttempts } },
    ],
  }).lean();
  return rows.map((r) => ({ idempotencyKey: r.idempotencyKey, owner: r.owner, amount: BigInt(r.amount) }));
}

async function sendTokenPayout(ctx: ExecuteContext, owner: PublicKey, amount: bigint): Promise<string> {
  const sourceAta = ctx.game.tokenHolderRewardsAccount;
  const destAta = getAssociatedTokenAddressSync(ctx.env.tokenMint, owner, true);
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(ctx.authority.publicKey, destAta, owner, ctx.env.tokenMint),
    createTransferInstruction(sourceAta, destAta, ctx.authority.publicKey, amount)
  );
  tx.feePayer = ctx.authority.publicKey;
  return sendAndConfirmTransaction(ctx.env.connection, tx, [ctx.authority], { commitment: "confirmed", skipPreflight: false });
}

async function sendSolPayout(ctx: ExecuteContext, owner: PublicKey, amount: bigint): Promise<string> {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: ctx.authority.publicKey, toPubkey: owner, lamports: amount })
  );
  tx.feePayer = ctx.authority.publicKey;
  return sendAndConfirmTransaction(ctx.env.connection, tx, [ctx.authority], { commitment: "confirmed", skipPreflight: false });
}

/** Burn the cycle's burn portion from the rewards ATA. Guarded by a Mongo
 *  marker on the cycle so a resume never burns twice. */
async function burnOnce(ctx: ExecuteContext, cycle: any, burnAmount: bigint): Promise<void> {
  if (burnAmount <= 0n) return;
  const fresh: any = await RewardCycleModel.findById(cycle._id).lean();
  if (fresh?.summary?.burnSignature) {
    console.log(`[distributor] burn already done for cycle ${fresh.idempotencyKey}: ${fresh.summary.burnSignature}`);
    return;
  }
  const tx = new Transaction().add(
    createBurnInstruction(ctx.game.tokenHolderRewardsAccount, ctx.env.tokenMint, ctx.authority.publicKey, burnAmount)
  );
  tx.feePayer = ctx.authority.publicKey;
  const sig = await sendAndConfirmTransaction(ctx.env.connection, tx, [ctx.authority], { commitment: "confirmed", skipPreflight: false });
  await RewardCycleModel.updateOne({ _id: cycle._id }, { $set: { "summary.burnSignature": sig, "summary.burnAmount": burnAmount.toString() } });
  console.log(`[distributor] burned ${burnAmount} base units: ${sig}`);
}

/** Create the Mongo cycle + payout rows for a plan (idempotent on snapshot slot)
 *  and return the cycle. Only called with --execute; dry runs never write. */
export async function persistCycle(plan: DistributionPlan, ctx: ExecuteContext, snapshotSlot: number): Promise<any> {
  const source = plan.asset === "token" ? ctx.game.tokenHolderRewardsAccount : ctx.game.solHolderRewardsWallet;
  const idempotencyKey = `dist:${plan.asset}:${ctx.env.tokenMint.toBase58()}:${snapshotSlot}`;
  const cycle = await createRewardCycle({
    asset: plan.asset,
    sourceWallet: source.toBase58(),
    mint: plan.asset === "token" ? ctx.env.tokenMint.toBase58() : undefined,
    totalAmount: plan.payoutPool,
    holders: plan.eligible,
    excludedWallets: [],
    idempotencyKey,
  });
  await RewardCycleModel.updateOne(
    { _id: cycle._id },
    {
      $set: {
        status: "running",
        "summary.snapshotSlot": snapshotSlot,
        "summary.accumulated": plan.accumulated.toString(),
        "summary.threshold": plan.threshold.toString(),
        "summary.burnPlanned": plan.burnAmount.toString(),
        "summary.minHolderAmount": plan.minHolderAmount.toString(),
        "summary.eligibleHolders": plan.eligible.length,
        "summary.payouts": plan.payouts.length,
        "summary.dust": plan.dust.toString(),
      },
    }
  );
  return cycle;
}

/** Send everything a cycle still owes (payouts, then burn), marking each step
 *  in Mongo as it lands. Returns true when the cycle finished completely. */
export async function executeCycle(ctx: ExecuteContext, cycle: any): Promise<boolean> {
  const asset: Asset = cycle.asset;
  const pending = await pendingPayoutsForCycle(cycle._id, ctx.cfg.maxPayoutAttempts);
  console.log(`[distributor] cycle ${cycle.idempotencyKey}: ${pending.length} payout(s) to send`);

  let failures = 0;
  for (const p of pending) {
    try {
      const owner = new PublicKey(p.owner);
      const sig = asset === "token" ? await sendTokenPayout(ctx, owner, p.amount) : await sendSolPayout(ctx, owner, p.amount);
      await markPayoutSent(p.idempotencyKey, sig);
      console.log(`[distributor]   sent ${p.amount} to ${p.owner}: ${sig}`);
    } catch (e: any) {
      failures++;
      await markPayoutFailed(p.idempotencyKey, e?.message ?? String(e));
      console.error(`[distributor]   FAILED ${p.amount} to ${p.owner}: ${e?.message ?? e}`);
    }
  }

  const stillOwed = await RewardPayoutModel.countDocuments({ cycle: cycle._id, status: { $in: ["pending", "failed"] } });
  const exhausted = await RewardPayoutModel.countDocuments({ cycle: cycle._id, status: "failed", attempts: { $gte: ctx.cfg.maxPayoutAttempts } });

  if (stillOwed - exhausted > 0) {
    console.warn(`[distributor] cycle ${cycle.idempotencyKey}: ${stillOwed - exhausted} payout(s) still retryable (${failures} failed this run) — will resume next run`);
    return false;
  }

  // All payouts either sent or permanently exhausted → burn portion, then close.
  if (asset === "token") {
    const burnPlanned = BigInt(cycle.summary?.burnPlanned ?? "0");
    await burnOnce(ctx, cycle, burnPlanned);
  }
  const finalStatus = exhausted > 0 ? "failed" : "completed";
  await RewardCycleModel.updateOne({ _id: cycle._id }, { $set: { status: finalStatus, "summary.finishedAt": new Date().toISOString() } });
  if (exhausted > 0) {
    console.error(`[distributor] cycle ${cycle.idempotencyKey} closed as FAILED: ${exhausted} payout(s) exhausted ${ctx.cfg.maxPayoutAttempts} attempts — review RewardPayout lastError and retry via retryFailedPayouts`);
  } else {
    console.log(`[distributor] cycle ${cycle.idempotencyKey} completed`);
  }
  return exhausted === 0;
}

// ----------------------------------------------------------------------------
// Reporting
// ----------------------------------------------------------------------------
export function fmtUnits(base: bigint, decimals: number): string {
  const d = 10n ** BigInt(decimals);
  const whole = base / d;
  const frac = (base % d).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole.toLocaleString("en-US")}.${frac}` : whole.toLocaleString("en-US");
}

export function printPlan(plan: DistributionPlan, decimals: number, unit: string): void {
  console.log(`\n--- ${plan.asset.toUpperCase()} distribution plan ---`);
  console.log(`  accumulated (distributable): ${fmtUnits(plan.accumulated, decimals)} ${unit}`);
  console.log(`  threshold                  : ${fmtUnits(plan.threshold, decimals)} ${unit}`);
  if (plan.belowThreshold) {
    console.log(`  => below threshold — nothing to distribute`);
    return;
  }
  // The floor is always measured in $BABYK holdings (9 decimals), even for SOL cycles.
  console.log(`  eligibility floor          : holders with >= ${fmtUnits(plan.minHolderAmount, 9)} $BABYK`);
  console.log(`  eligible holders           : ${plan.eligible.length}`);
  if (plan.eligible.length === 0) {
    console.log(`  => no eligible holders — nothing to distribute`);
    return;
  }
  console.log(`  burn                       : ${fmtUnits(plan.burnAmount, decimals)} ${unit}`);
  console.log(`  payout pool                : ${fmtUnits(plan.payoutPool, decimals)} ${unit}`);
  console.log(`  dust (stays in account)    : ${plan.dust} base units`);
  console.log(`  retained (stays in account): ${fmtUnits(plan.retained, decimals)} ${unit}`);
  for (const p of plan.payouts) {
    console.log(`    ${p.owner}  ${fmtUnits(p.amount, decimals)} ${unit}`);
  }
}
