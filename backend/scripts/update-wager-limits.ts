/**
 * Raise the on-chain token max_bet so the treasury-derived per-bet cap
 * (max_payout_bps_of_treasury, currently 8%) becomes the limit that actually
 * governs token wagers — the same behavior SOL already exhibits.
 *
 * Background: the live GameConfig was initialized with max_bet = 1_000_000_000
 * base units, which is 1 SOL in lamports but exactly 1.0 $BABYK at 9 decimals,
 * so the UI pinned the token MAX at 1 while the vault held millions. This
 * script sends admin-signed `update_config { max_bet }` and nothing else.
 *
 * DRY-RUN by default (mirrors program/scripts/init-mainnet.ts): it decodes the
 * live config, prints the before/after wager-limit math for BOTH assets,
 * simulates the transaction, and does NOT send. Re-run with --execute to
 * actually submit.
 *
 * Run from backend/ so @solana/web3.js resolves (same pattern as the
 * "verify:env" npm script):
 *
 *   cd backend
 *   # dry run — only the admin PUBKEY is needed:
 *   RPC_URL="https://..." ADMIN_WALLET=<ADMIN_PUBKEY> \
 *     npx ts-node scripts/update-wager-limits.ts
 *
 *   # execute — the admin KEYPAIR signs:
 *   RPC_URL="https://..." ADMIN_KEYPAIR_PATH=/path/admin.json \
 *     npx ts-node scripts/update-wager-limits.ts --execute
 *
 * Env:
 *   RPC_URL                  required
 *   PROGRAM_ID               default: live mainnet program
 *   TOKEN_MINT               default: live $BABYK mint
 *   NEW_MAX_BET_BASE_UNITS   default: 10_000_000 $BABYK (1e16). Backstop only —
 *                            it binds only once the vault exceeds ~212.5M $BABYK.
 *   NEW_SOL_MAX_BET_LAMPORTS optional; unset leaves sol_max_bet unchanged
 *   ADMIN_WALLET             admin pubkey (dry run)
 *   ADMIN_KEYPAIR_PATH       admin keypair file (required for --execute)
 */
import * as fs from "fs";
import { createHash } from "crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

// ----------------------------------------------------------------------------
// Config — review before running with --execute
// ----------------------------------------------------------------------------
const EXECUTE = process.argv.includes("--execute");
const RPC_URL = required("RPC_URL");
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID ?? "DFmU9mwDbHkGRZ5J2f9zi59ZyDapaEv8qHhKsx8KpwAj");
const TOKEN_MINT = new PublicKey(process.env.TOKEN_MINT ?? "BABYKxGpoWQFFDBH7hf9Tdx8ZZPEguunENRwd3a1AZsf");
/** 10,000,000 $BABYK at 9 decimals. A non-binding backstop: with the 8% payout
 *  cap and 1.78x payout it only governs once the vault holds ~212.5M $BABYK. */
const NEW_MAX_BET = BigInt(process.env.NEW_MAX_BET_BASE_UNITS ?? "10000000000000000");
const NEW_SOL_MAX_BET = process.env.NEW_SOL_MAX_BET_LAMPORTS ? BigInt(process.env.NEW_SOL_MAX_BET_LAMPORTS) : null;
const TOKEN_DECIMALS = 9;
// ----------------------------------------------------------------------------

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.startsWith("REPLACE_WITH") || v.startsWith("<")) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function ixDisc(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

// --- PDAs (mirror the program seeds; same derivations as backend/src/solana.ts) ---
const enc = (s: string) => Buffer.from(s, "utf-8");
const configPda = PublicKey.findProgramAddressSync([enc("config"), TOKEN_MINT.toBuffer()], PROGRAM_ID)[0];

// --- GameConfig decoder ---------------------------------------------------
// Sequential cursor over the exact Rust field order, mirroring
// frontend/src/lib/anchorIx.ts (fetchConfigView). Field order:
//   admin, pending_admin, settle_authority, randomness_authority, token_mint,
//   treasury_vault, sol_team_wallet, sol_dev_buyback_wallet,
//   sol_holder_rewards_wallet, token_team_fee_account, token_dev_fee_account,
//   token_holder_rewards_account, current_seed_hash[32], seed_epoch u64,
//   fee_bps u16, sol_player_win_payout_bps u16, token_player_win_payout_bps u16,
//   min_bet u64, max_bet u64, max_payout_bps_of_treasury u16,
//   outstanding_liability u128, paused bool, total_bets u64, total_wagered u128,
//   total_paid_out u128, sol_vault, sol_min_bet u64, sol_max_bet u64,
//   outstanding_liability_sol u128, bump u8.
interface LiveConfig {
  admin: PublicKey;
  settleAuthority: PublicKey;
  tokenMint: PublicKey;
  treasuryVault: PublicKey;
  feeBps: number;
  solPlayerWinPayoutBps: number;
  tokenPlayerWinPayoutBps: number;
  minBet: bigint;
  maxBet: bigint;
  maxPayoutBpsOfTreasury: number;
  outstandingLiability: bigint;
  paused: boolean;
  solVault: PublicKey;
  solMinBet: bigint;
  solMaxBet: bigint;
  outstandingLiabilitySol: bigint;
}

function decodeConfig(data: Buffer): LiveConfig {
  let off = 8; // skip anchor discriminator
  const pk = () => new PublicKey(data.subarray(off, (off += 32)));
  const u16 = () => { const v = data.readUInt16LE(off); off += 2; return v; };
  const u64 = () => { const v = data.readBigUInt64LE(off); off += 8; return v; };
  const u128 = () => { const lo = data.readBigUInt64LE(off); const hi = data.readBigUInt64LE(off + 8); off += 16; return lo + (hi << 64n); };
  const u8 = () => data.readUInt8(off++);

  const admin = pk();
  pk(); // pending_admin
  const settleAuthority = pk();
  pk(); // randomness_authority
  const tokenMint = pk();
  const treasuryVault = pk();
  pk(); pk(); pk(); // sol team / dev / holder wallets
  pk(); pk(); pk(); // token team / dev / holder fee accounts
  off += 32; // current_seed_hash
  u64(); // seed_epoch
  const feeBps = u16();
  const solPlayerWinPayoutBps = u16();
  const tokenPlayerWinPayoutBps = u16();
  const minBet = u64();
  const maxBet = u64();
  const maxPayoutBpsOfTreasury = u16();
  const outstandingLiability = u128();
  const paused = u8() === 1;
  u64(); // total_bets
  u128(); // total_wagered
  u128(); // total_paid_out
  const solVault = pk();
  const solMinBet = u64();
  const solMaxBet = u64();
  const outstandingLiabilitySol = u128();

  return {
    admin, settleAuthority, tokenMint, treasuryVault, feeBps,
    solPlayerWinPayoutBps, tokenPlayerWinPayoutBps, minBet, maxBet,
    maxPayoutBpsOfTreasury, outstandingLiability, paused, solVault,
    solMinBet, solMaxBet, outstandingLiabilitySol,
  };
}

// --- Wager-limit math -------------------------------------------------------
// Mirrors frontend/src/lib/wager.ts (computeMaxWager) exactly, which in turn
// mirrors the program checks in place_bet / place_bet_sol.
const BPS = 10_000n;

function computeMaxWager(p: {
  configMaxBet: bigint;
  vaultBalance: bigint;
  outstandingLiability: bigint;
  payoutBps: number;
  feeBps: number;
  maxPayoutBpsOfTreasury: number;
}): { max: bigint; perBetCap: bigint; solvencyCap: bigint } {
  const payoutBps = BigInt(p.payoutBps);
  const feeBps = BigInt(p.feeBps);
  const capBps = BigInt(p.maxPayoutBpsOfTreasury);
  const vault = p.vaultBalance < 0n ? 0n : p.vaultBalance;

  const perBetCap = payoutBps <= capBps ? p.configMaxBet : (vault * capBps) / (payoutBps - capBps);

  const available = vault > p.outstandingLiability ? vault - p.outstandingLiability : 0n;
  const liabilityBps = payoutBps + feeBps;
  const solvencyCap = liabilityBps <= BPS ? p.configMaxBet : (available * BPS) / (liabilityBps - BPS);

  let max = p.configMaxBet;
  if (perBetCap < max) max = perBetCap;
  if (solvencyCap < max) max = solvencyCap;
  return { max: max < 0n ? 0n : max, perBetCap, solvencyCap };
}

// --- update_config instruction ----------------------------------------------
// Borsh-encodes UpdateParams (field order MUST match the Rust struct in
// program/programs/forge-coinflip/src/lib.rs — UpdateParams):
//   settle_authority: Option<Pubkey>, fee_bps: Option<u16>,
//   sol_player_win_payout_bps: Option<u16>, token_player_win_payout_bps: Option<u16>,
//   min_bet: Option<u64>, max_bet: Option<u64>,
//   max_payout_bps_of_treasury: Option<u16>, paused: Option<bool>,
//   sol_min_bet: Option<u64>, sol_max_bet: Option<u64>
// Every field except max_bet (and optionally sol_max_bet) is None, so nothing
// else about the live economics can change.
function buildUpdateMaxBetIx(admin: PublicKey, newMaxBet: bigint, newSolMaxBet: bigint | null): TransactionInstruction {
  const none = Buffer.from([0]);
  const someU64 = (v: bigint) => {
    const b = Buffer.alloc(9);
    b.writeUInt8(1, 0);
    b.writeBigUInt64LE(v, 1);
    return b;
  };
  const data = Buffer.concat([
    ixDisc("update_config"),
    none, // settle_authority
    none, // fee_bps
    none, // sol_player_win_payout_bps
    none, // token_player_win_payout_bps
    none, // min_bet
    someU64(newMaxBet), // max_bet
    none, // max_payout_bps_of_treasury
    none, // paused
    none, // sol_min_bet
    newSolMaxBet === null ? none : someU64(newSolMaxBet), // sol_max_bet
  ]);
  const keys = [
    { pubkey: admin, isSigner: true, isWritable: false },
    { pubkey: configPda, isSigner: false, isWritable: true },
  ];
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
}

// --- formatting ---------------------------------------------------------------
function fmt(base: bigint, decimals: number): string {
  const d = 10n ** BigInt(decimals);
  const whole = base / d;
  const frac = (base % d).toString().padStart(decimals, "0").replace(/0+$/, "");
  const wholeStr = whole.toLocaleString("en-US");
  return frac ? `${wholeStr}.${frac}` : wholeStr;
}

function describeAsset(
  label: string,
  unit: string,
  cfgMax: bigint,
  vault: bigint,
  outstanding: bigint,
  payoutBps: number,
  feeBps: number,
  capBps: number
): bigint {
  const r = computeMaxWager({
    configMaxBet: cfgMax,
    vaultBalance: vault,
    outstandingLiability: outstanding,
    payoutBps,
    feeBps,
    maxPayoutBpsOfTreasury: capBps,
  });
  console.log(`  ${label}`);
  console.log(`    vault (spendable)       : ${fmt(vault, TOKEN_DECIMALS)} ${unit}`);
  console.log(`    outstanding liability   : ${fmt(outstanding, TOKEN_DECIMALS)} ${unit}`);
  console.log(`    configured max_bet      : ${fmt(cfgMax, TOKEN_DECIMALS)} ${unit}`);
  console.log(`    per-bet ${capBps / 100}% treasury cap: ${fmt(r.perBetCap, TOKEN_DECIMALS)} ${unit}   (vault * ${capBps} / (${payoutBps} - ${capBps}))`);
  console.log(`    solvency cap            : ${fmt(r.solvencyCap, TOKEN_DECIMALS)} ${unit}`);
  console.log(`    => effective MAX wager  : ${fmt(r.max, TOKEN_DECIMALS)} ${unit}`);
  return r.max;
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");

  // Admin identity: pubkey-only for dry run, keypair for --execute.
  let adminKeypair: Keypair | null = null;
  if (process.env.ADMIN_KEYPAIR_PATH) {
    adminKeypair = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync(process.env.ADMIN_KEYPAIR_PATH, "utf-8")))
    );
  }
  if (EXECUTE && !adminKeypair) {
    throw new Error("--execute requires ADMIN_KEYPAIR_PATH (the on-chain GameConfig.admin keypair)");
  }
  const adminPubkey = adminKeypair
    ? adminKeypair.publicKey
    : new PublicKey(required("ADMIN_WALLET"));

  console.log("=== update-wager-limits — admin update_config { max_bet } ===");
  console.log("Mode        :", EXECUTE ? "EXECUTE (will send)" : "DRY RUN (nothing will be sent)");
  console.log("RPC         :", RPC_URL.replace(/api-key=[^&]+/, "api-key=***"));
  console.log("Program ID  :", PROGRAM_ID.toBase58());
  console.log("Token mint  :", TOKEN_MINT.toBase58());
  console.log("Config PDA  :", configPda.toBase58());
  console.log("Admin       :", adminPubkey.toBase58());

  const info = await connection.getAccountInfo(configPda);
  if (!info) throw new Error(`GameConfig not found at ${configPda.toBase58()} — wrong PROGRAM_ID/TOKEN_MINT?`);
  const cfg = decodeConfig(info.data);

  if (!cfg.tokenMint.equals(TOKEN_MINT)) throw new Error(`on-chain mint ${cfg.tokenMint.toBase58()} != TOKEN_MINT`);
  if (!cfg.admin.equals(adminPubkey)) {
    throw new Error(`admin mismatch: on-chain GameConfig.admin is ${cfg.admin.toBase58()}, you provided ${adminPubkey.toBase58()}`);
  }
  if (NEW_MAX_BET < cfg.minBet) throw new Error(`NEW_MAX_BET ${NEW_MAX_BET} is below min_bet ${cfg.minBet} — the program would reject it`);
  if (NEW_SOL_MAX_BET !== null && NEW_SOL_MAX_BET < cfg.solMinBet) {
    throw new Error(`NEW_SOL_MAX_BET ${NEW_SOL_MAX_BET} is below sol_min_bet ${cfg.solMinBet}`);
  }
  if (cfg.paused) console.log("NOTE: game is currently PAUSED; the limit change is still valid.");
  if (NEW_MAX_BET < cfg.maxBet) console.log("WARNING: NEW_MAX_BET LOWERS the current max_bet.");

  // Live vault balances (same reads as frontend/src/lib/anchorIx.ts fetchVaultBalances).
  const tokenVault = BigInt((await connection.getTokenAccountBalance(cfg.treasuryVault)).value.amount);
  const solVaultLamports = BigInt(await connection.getBalance(cfg.solVault));
  const solVaultRent = BigInt(await connection.getMinimumBalanceForRentExemption(8 + 1)); // SolVault: disc + bump
  const solVaultSpendable = solVaultLamports > solVaultRent ? solVaultLamports - solVaultRent : 0n;

  console.log("\nLive config:");
  console.log(`  fee_bps=${cfg.feeBps}  token payout=${cfg.tokenPlayerWinPayoutBps}bps  sol payout=${cfg.solPlayerWinPayoutBps}bps  treasury cap=${cfg.maxPayoutBpsOfTreasury}bps`);
  console.log(`  token min/max: ${fmt(cfg.minBet, TOKEN_DECIMALS)} / ${fmt(cfg.maxBet, TOKEN_DECIMALS)} $BABYK   sol min/max: ${fmt(cfg.solMinBet, 9)} / ${fmt(cfg.solMaxBet, 9)} SOL`);

  console.log("\nBEFORE — what the program/UI currently allow:");
  describeAsset("$BABYK", "$BABYK", cfg.maxBet, tokenVault, cfg.outstandingLiability, cfg.tokenPlayerWinPayoutBps, cfg.feeBps, cfg.maxPayoutBpsOfTreasury);
  describeAsset("SOL", "SOL", cfg.solMaxBet, solVaultSpendable, cfg.outstandingLiabilitySol, cfg.solPlayerWinPayoutBps, cfg.feeBps, cfg.maxPayoutBpsOfTreasury);

  console.log("\nAFTER — with the new limits:");
  describeAsset("$BABYK", "$BABYK", NEW_MAX_BET, tokenVault, cfg.outstandingLiability, cfg.tokenPlayerWinPayoutBps, cfg.feeBps, cfg.maxPayoutBpsOfTreasury);
  describeAsset("SOL", "SOL", NEW_SOL_MAX_BET ?? cfg.solMaxBet, solVaultSpendable, cfg.outstandingLiabilitySol, cfg.solPlayerWinPayoutBps, cfg.feeBps, cfg.maxPayoutBpsOfTreasury);

  // Vault size at which the new config backstop would start binding again:
  const capBps = BigInt(cfg.maxPayoutBpsOfTreasury);
  const payoutBps = BigInt(cfg.tokenPlayerWinPayoutBps);
  const bindVault = (NEW_MAX_BET * (payoutBps - capBps)) / capBps;
  console.log(`\nThe new token max_bet backstop (${fmt(NEW_MAX_BET, TOKEN_DECIMALS)} $BABYK) only binds once the vault exceeds ~${fmt(bindVault, TOKEN_DECIMALS)} $BABYK; below that the ${cfg.maxPayoutBpsOfTreasury / 100}% treasury cap governs and scales with the vault.`);

  const ix = buildUpdateMaxBetIx(adminPubkey, NEW_MAX_BET, NEW_SOL_MAX_BET);
  console.log("\nPlanned transaction: update_config {");
  console.log(`  max_bet: ${NEW_MAX_BET} (${fmt(NEW_MAX_BET, TOKEN_DECIMALS)} $BABYK)`);
  if (NEW_SOL_MAX_BET !== null) console.log(`  sol_max_bet: ${NEW_SOL_MAX_BET} (${fmt(NEW_SOL_MAX_BET, 9)} SOL)`);
  console.log("  (all other fields: unchanged)");
  console.log("}");

  // Simulate before anything else (sigVerify off, so the dry run needs no key).
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: adminPubkey, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message();
  const sim = await connection.simulateTransaction(new VersionedTransaction(msg), {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "processed",
  });
  if (sim.value.err) {
    console.error("\nSIMULATION FAILED:", JSON.stringify(sim.value.err));
    for (const l of sim.value.logs ?? []) console.error("  " + l);
    process.exit(1);
  }
  console.log(`\nSimulation OK (compute units: ${sim.value.unitsConsumed}).`);

  if (!EXECUTE) {
    console.log("\n[DRY RUN] nothing sent. Re-run with --execute (and ADMIN_KEYPAIR_PATH) to submit.");
    return;
  }

  const tx = new Transaction().add(ix);
  tx.feePayer = adminPubkey;
  const sig = await sendAndConfirmTransaction(connection, tx, [adminKeypair!], {
    commitment: "finalized",
    skipPreflight: false,
  });
  console.log("\nSent + finalized:", sig);
  console.log("Verify with: solana account", configPda.toBase58());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
