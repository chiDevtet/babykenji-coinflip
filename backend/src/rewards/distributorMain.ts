/**
 * Holder-rewards distributor — standalone worker (run under pm2 or by hand).
 *
 * The on-chain program routes fees on EVERY settle: token fees land in the
 * token holder-rewards ATA and SOL fees in the SOL holder-rewards wallet
 * (see settle_bet / settle_bet_sol in program/programs/forge-coinflip/src/lib.rs).
 * This worker watches those two accumulation accounts and, whenever one
 * crosses its Mongo-configured threshold, pays the pot out pro-rata to
 * eligible $BABYK holders (holders with at least minHolderSupplyBps of the
 * total supply, minus exclusions). An optional burn share exists but defaults
 * to 0 — the program already burns 1.67% of every token wager at settlement.
 *
 * DRY-RUN BY DEFAULT: without --execute it only reads chain + config and
 * prints the full per-recipient plan. It writes nothing to Mongo and sends
 * nothing on-chain. --execute creates an idempotent RewardCycle (one
 * unfinished cycle per asset at a time; payouts keyed per owner) so a crash
 * and restart resumes exactly where it stopped and can never double-pay.
 *
 * Usage (from backend/):
 *   npm run distributor                      # dry run, both assets, one shot
 *   npm run distributor -- --asset=token     # dry run, token only
 *   npm run distributor:execute              # SEND: one shot
 *   npx ts-node src/rewards/distributorMain.ts --daemon --execute   # pm2 mode
 *
 * Env:
 *   MONGODB_URI                            config + cycle state (default local)
 *   RPC_URL                                required
 *   HELIUS_RPC_URL                         recommended — holder scan needs a
 *                                          getProgramAccounts-capable RPC
 *   PROGRAM_ID, TOKEN_MINT                 live program + mint
 *   HOLDER_REWARDS_AUTHORITY_KEYPAIR_PATH  required with --execute only: the
 *                                          accumulation wallet's keypair (owner
 *                                          of the token rewards ATA AND the SOL
 *                                          rewards wallet)
 *   HOLDER_REWARDS_INTERVAL_MS             loop interval in --daemon mode
 *                                          (default 3600000 = 1h)
 *   HOLDER_REWARDS_FEE_BUFFER_LAMPORTS     SOL kept back for tx fees
 *                                          (default 5000000 = 0.005 SOL)
 */
import * as fs from "fs";
import * as dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config(); // backend/.env works for manual runs and pm2 (cwd = backend/)
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  Asset,
  builtinExclusions,
  executeCycle,
  findUnfinishedCycle,
  fmtUnits,
  persistCycle,
  planDistribution,
  printPlan,
} from "./distributor";
import {
  RewardsChainEnv,
  fetchMintSupply,
  fetchRewardsGameConfig,
  fetchSpendableLamports,
  fetchTokenAccountAmount,
  fetchTokenAccountOwner,
  loadChainEnv,
  scanHolders,
} from "./chain";
import { loadDistributionConfig } from "./distributionConfig";

const EXECUTE = process.argv.includes("--execute");
const DAEMON = process.argv.includes("--daemon");
const assetArg = process.argv.find((a) => a.startsWith("--asset="))?.split("=")[1];
const ASSETS: Asset[] = assetArg === "token" ? ["token"] : assetArg === "sol" ? ["sol"] : ["token", "sol"];

const INTERVAL_MS = Number(process.env.HOLDER_REWARDS_INTERVAL_MS ?? 3_600_000);
const FEE_BUFFER = BigInt(process.env.HOLDER_REWARDS_FEE_BUFFER_LAMPORTS ?? "5000000");
/** Minimum payer SOL to even start an execute run (fees + ATA rents). */
const MIN_PAYER_LAMPORTS = 10_000_000n; // 0.01 SOL
const TOKEN_DECIMALS = 9;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loadAuthority(): Keypair {
  const path = process.env.HOLDER_REWARDS_AUTHORITY_KEYPAIR_PATH;
  if (!path) throw new Error("--execute requires HOLDER_REWARDS_AUTHORITY_KEYPAIR_PATH (the accumulation wallet keypair)");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf-8"))));
}

async function runOnce(): Promise<void> {
  const env = loadChainEnv();
  const cfg = await loadDistributionConfig();
  const game = await fetchRewardsGameConfig(env);

  // The one keypair that signs everything: owner of the SOL rewards wallet and
  // authority of the token rewards ATA. Verified against chain before any send.
  let authority: Keypair | null = null;
  if (EXECUTE) {
    authority = loadAuthority();
    const ataOwner = await fetchTokenAccountOwner(env.connection, game.tokenHolderRewardsAccount);
    if (!ataOwner.equals(authority.publicKey)) {
      throw new Error(`keypair ${authority.publicKey.toBase58()} is not the owner of the token rewards ATA (expected ${ataOwner.toBase58()})`);
    }
    if (!game.solHolderRewardsWallet.equals(authority.publicKey)) {
      throw new Error(`keypair ${authority.publicKey.toBase58()} is not the SOL holder-rewards wallet (expected ${game.solHolderRewardsWallet.toBase58()})`);
    }
    const payerBalance = BigInt(await env.connection.getBalance(authority.publicKey));
    if (payerBalance < MIN_PAYER_LAMPORTS) {
      throw new Error(`fee payer ${authority.publicKey.toBase58()} holds ${fmtUnits(payerBalance, 9)} SOL (< ${fmtUnits(MIN_PAYER_LAMPORTS, 9)}) — top it up before executing`);
    }
  }

  console.log(`[distributor] mode=${EXECUTE ? "EXECUTE" : "DRY RUN"} assets=${ASSETS.join(",")}`);
  console.log(`[distributor] token rewards ATA : ${game.tokenHolderRewardsAccount.toBase58()}`);
  console.log(`[distributor] sol rewards wallet: ${game.solHolderRewardsWallet.toBase58()}`);
  console.log(`[distributor] thresholds: token=${fmtUnits(BigInt(cfg.tokenThresholdBaseUnits), TOKEN_DECIMALS)} $BABYK, sol=${fmtUnits(BigInt(cfg.solThresholdLamports), 9)} SOL; burn=${cfg.burnBps}bps holders=${cfg.holderBps}bps floor=${cfg.minHolderSupplyBps}bps of supply`);

  // Holder scan + supply, shared by both assets.
  const supply = await fetchMintSupply(env.connection, env.tokenMint);
  const holders = await scanHoldersSafe(env);
  const sourceOwner = EXECUTE && authority ? authority.publicKey : await fetchTokenAccountOwner(env.connection, game.tokenHolderRewardsAccount);
  const excluded = builtinExclusions(game, sourceOwner);
  for (const w of cfg.excludedWallets) excluded.add(new PublicKey(w).toBase58());

  for (const asset of ASSETS) {
    if (!cfg.enabled[asset]) {
      console.log(`[distributor] ${asset}: disabled in config — skipping`);
      continue;
    }

    // Resume before anything else: an unfinished cycle owns the asset until done.
    const unfinished = await findUnfinishedCycle(asset);
    if (unfinished) {
      console.log(`[distributor] ${asset}: unfinished cycle ${unfinished.idempotencyKey} (status=${unfinished.status})`);
      if (EXECUTE && authority) {
        await executeCycle({ env, game, cfg, authority }, unfinished);
      } else {
        console.log(`[distributor] ${asset}: dry run — would resume this cycle's pending payouts`);
      }
      continue;
    }

    const accumulated = asset === "token"
      ? await fetchTokenAccountAmount(env.connection, game.tokenHolderRewardsAccount)
      : await fetchSpendableLamports(env.connection, game.solHolderRewardsWallet, FEE_BUFFER);
    const threshold = BigInt(asset === "token" ? cfg.tokenThresholdBaseUnits : cfg.solThresholdLamports);

    const plan = planDistribution({
      asset,
      accumulated,
      threshold,
      burnBps: cfg.burnBps,
      holderBps: cfg.holderBps,
      holders,
      excluded,
      supply,
      minHolderSupplyBps: cfg.minHolderSupplyBps,
    });
    printPlan(plan, asset === "token" ? TOKEN_DECIMALS : 9, asset === "token" ? "$BABYK" : "SOL");

    if (plan.belowThreshold || plan.payouts.length === 0) continue;
    if (!EXECUTE || !authority) {
      console.log(`[distributor] ${asset}: DRY RUN — nothing written or sent. Re-run with --execute to distribute.`);
      continue;
    }

    const snapshotSlot = await env.connection.getSlot("confirmed");
    const cycle = await persistCycle(plan, { env, game, cfg, authority }, snapshotSlot);
    await executeCycle({ env, game, cfg, authority }, cycle);
  }
}

// Holder scans hit getProgramAccounts, which public RPCs often reject — fail
// with a pointed message instead of a generic RPC error.
async function scanHoldersSafe(env: RewardsChainEnv) {
  try {
    const holders = await scanHolders(env);
    console.log(`[distributor] holder scan: ${holders.length} token account(s) for the mint`);
    return holders;
  } catch (e: any) {
    throw new Error(
      `holder scan failed (${e?.message ?? e}) — the scan needs a getProgramAccounts-capable RPC; set HELIUS_RPC_URL`
    );
  }
}

async function main() {
  mongoose.set("strictQuery", true);
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/forge_coinflip");

  if (!DAEMON) {
    await runOnce();
    await mongoose.disconnect();
    return;
  }
  console.log(`[distributor] daemon mode: every ${INTERVAL_MS}ms`);
  for (;;) {
    try {
      await runOnce();
    } catch (e: any) {
      console.error("[distributor] run failed:", e?.message ?? e);
    }
    await sleep(INTERVAL_MS);
  }
}

main().catch((e) => {
  console.error("[distributor] fatal:", e);
  process.exit(1);
});
