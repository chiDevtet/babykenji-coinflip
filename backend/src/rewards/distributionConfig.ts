import { PublicKey } from "@solana/web3.js";
import { AppConfigModel } from "../models/AppConfig";

/**
 * Distribution settings for the holder-rewards distributor worker. Stored in
 * MongoDB (AppConfig key "distribution") so the admin dashboard can edit them
 * without a redeploy; the worker re-reads them at the start of every run.
 *
 * Amounts are strings of base units (u64-safe). Percentages are basis points.
 */
export interface DistributionConfig {
  /** Distribute token rewards only once the accumulation ATA holds at least this many base units. */
  tokenThresholdBaseUnits: string;
  /** Distribute SOL rewards only once the accumulation wallet's spendable lamports reach this. */
  solThresholdLamports: string;
  /**
   * Portion of each distributed pot to BURN (token cycles only — SOL cannot
   * burn). Defaults to 0: the on-chain program already burns 1.67% of every
   * token wager at settlement, so no additional burn happens here unless an
   * admin raises this deliberately.
   */
  burnBps: number;
  /** Portion of each distributed pot paid to eligible holders pro-rata. */
  holderBps: number;
  /**
   * Eligibility floor as basis points of the CURRENT total mint supply: a
   * wallet only receives rewards if it holds at least supply * bps / 10_000.
   * 200 = 2% of the entire supply.
   */
  minHolderSupplyBps: number;
  /** Extra owner wallets to exclude (CEX deposit wallets, team cold storage, …). */
  excludedWallets: string[];
  /** Per-payout send attempts before a payout is left failed for manual review. */
  maxPayoutAttempts: number;
  /** Per-asset kill switches the dashboard can flip without stopping pm2. */
  enabled: { token: boolean; sol: boolean };
}

export const DISTRIBUTION_CONFIG_KEY = "distribution";

export const DISTRIBUTION_DEFAULTS: DistributionConfig = {
  tokenThresholdBaseUnits: "10000000000000", // 10,000 $BABYK at 9 decimals
  solThresholdLamports: "50000000", // 0.05 SOL
  burnBps: 0,
  holderBps: 10_000,
  minHolderSupplyBps: 200, // 2% of total supply
  excludedWallets: [],
  maxPayoutAttempts: 5,
  enabled: { token: true, sol: true },
};

export function validateDistributionConfig(cfg: DistributionConfig): void {
  const token = BigInt(cfg.tokenThresholdBaseUnits); // throws on non-integer
  const sol = BigInt(cfg.solThresholdLamports);
  if (token <= 0n || sol <= 0n) throw new Error("distribution thresholds must be positive");
  for (const [name, v] of [["burnBps", cfg.burnBps], ["holderBps", cfg.holderBps], ["minHolderSupplyBps", cfg.minHolderSupplyBps]] as const) {
    if (!Number.isInteger(v) || v < 0 || v > 10_000) throw new Error(`${name} must be an integer in 0..10000`);
  }
  if (cfg.burnBps + cfg.holderBps > 10_000) throw new Error("burnBps + holderBps must not exceed 10000");
  if (cfg.holderBps === 0 && cfg.burnBps === 0) throw new Error("burnBps and holderBps cannot both be 0");
  if (!Number.isInteger(cfg.maxPayoutAttempts) || cfg.maxPayoutAttempts < 1) throw new Error("maxPayoutAttempts must be a positive integer");
  for (const w of cfg.excludedWallets) new PublicKey(w); // throws on invalid pubkey
}

/** Load the distribution config, seeding the defaults on first use so the
 *  dashboard always has a document to edit. Unknown/missing fields fall back
 *  to defaults so old documents keep working after upgrades. */
export async function loadDistributionConfig(): Promise<DistributionConfig> {
  const doc = await AppConfigModel.findOneAndUpdate(
    { key: DISTRIBUTION_CONFIG_KEY },
    { $setOnInsert: { key: DISTRIBUTION_CONFIG_KEY, value: DISTRIBUTION_DEFAULTS } },
    { upsert: true, new: true }
  ).lean();
  const value = (doc?.value ?? {}) as Partial<DistributionConfig>;
  const cfg: DistributionConfig = {
    ...DISTRIBUTION_DEFAULTS,
    ...value,
    enabled: { ...DISTRIBUTION_DEFAULTS.enabled, ...(value.enabled ?? {}) },
    excludedWallets: value.excludedWallets ?? DISTRIBUTION_DEFAULTS.excludedWallets,
  };
  validateDistributionConfig(cfg);
  return cfg;
}
