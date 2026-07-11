/**
 * Change the DEV payout wallet in every live off-chain location, safely.
 *
 * The dev fee has two destinations (FEE_DISTRIBUTION.md):
 *   - SOL flips  : 3%    -> SOL_DEV_BUYBACK_WALLET   (a wallet address)
 *   - token flips: 1.66% -> TOKEN_DEV_FEE_ACCOUNT    (a Baby Kenji SPL token
 *                                                     account, normally the
 *                                                     wallet's ATA)
 *
 * Given the NEW dev wallet (owner) address, this script updates
 * SOL_DEV_BUYBACK_WALLET to that address and TOKEN_DEV_FEE_ACCOUNT to the
 * wallet's associated token account for the configured mint (override with
 * --token-account), in BOTH live env files:
 *   - <repo>/.env
 *   - <repo>/backend/.env
 * plus the legacy DEV_FEE_WALLET key when a file still carries it.
 * (.env.example files and docs hold placeholders, not live config — untouched.)
 *
 * DRY RUN BY DEFAULT: it prints current wallet, new wallet, and every location
 * that would change, and modifies NOTHING until re-run with --execute. On
 * execute it backs each file up next to itself and logs before/after values.
 *
 * IMPORTANT — on-chain GameConfig: fees are actually routed by the wallet
 * addresses stored in the on-chain GameConfig, which are set once in
 * initialize_config and CANNOT be changed afterwards (the program's
 * UpdateParams carries no fee-wallet fields). This script READS and REPORTS
 * the on-chain values so you can see any divergence, but changing them
 * requires a program upgrade. Until then, settled bets keep paying the
 * on-chain dev wallet, and every bet snapshots its recipients at place time.
 *
 * This script never restarts services — restart pm2 yourself (reminder printed).
 *
 * Usage (run where deps resolve, e.g. backend/):
 *   cd backend
 *   npx ts-node ../scripts/changeDevPayoutWallet.ts <NEW_DEV_WALLET>                 # dry run
 *   npx ts-node ../scripts/changeDevPayoutWallet.ts <NEW_DEV_WALLET> --execute      # apply
 *   npx ts-node ../scripts/changeDevPayoutWallet.ts <NEW_DEV_WALLET> \
 *       --token-account <TOKEN_ACCOUNT> --execute                                   # explicit ATA
 *   NEW_DEV_WALLET=<addr> npx ts-node ../scripts/changeDevPayoutWallet.ts           # env-var form
 */
import * as fs from "fs";
import * as path from "path";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";

// Repo root, derived from this script's own path (scripts/ is one level down).
// process.argv[1] works under both CommonJS ts-node and native ESM type-stripping,
// unlike __dirname / import.meta which each only exist in one module system.
const REPO_ROOT = path.resolve(path.dirname(process.argv[1] ?? "."), "..");
const ENV_FILES = [path.join(REPO_ROOT, ".env"), path.join(REPO_ROOT, "backend", ".env")];

/** Env keys that hold the dev payout destination. */
const SOL_KEY = "SOL_DEV_BUYBACK_WALLET";
const TOKEN_KEY = "TOKEN_DEV_FEE_ACCOUNT";
const LEGACY_KEY = "DEV_FEE_WALLET"; // older scripts' name; updated only when present

// Addresses that must never be a fee recipient (same guard as init-config.ts).
const DANGEROUS = new Set([
  "11111111111111111111111111111111", // System Program
  "So11111111111111111111111111111111111111112", // wrapped SOL mint
]);

// pm2 app names from backend/ecosystem.config.example.js.
const PM2_SERVICES = ["baby-kenji-backend", "baby-kenji-rewards-distributor"];

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
function fail(msg: string): never {
  console.error(`\nERROR: ${msg}`);
  process.exit(1);
}

function parseArgs(argv: string[]): { newWallet: string; execute: boolean; tokenAccount: string | null } {
  let newWallet: string | undefined = process.env.NEW_DEV_WALLET;
  let execute = false;
  let tokenAccount: string | null = null;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--execute") execute = true;
    else if (a === "--token-account") {
      tokenAccount = argv[++i];
      if (!tokenAccount) fail("--token-account requires an address");
    } else if (a.startsWith("--")) fail(`unknown flag: ${a}`);
    else if (!newWallet) newWallet = a;
    else fail(`unexpected extra argument: ${a}`);
  }
  if (!newWallet) {
    fail(
      "missing the new dev wallet address.\n" +
        "  usage: npx ts-node ../scripts/changeDevPayoutWallet.ts <NEW_DEV_WALLET> [--token-account <ADDR>] [--execute]\n" +
        "     or: NEW_DEV_WALLET=<addr> npx ts-node ../scripts/changeDevPayoutWallet.ts [--execute]"
    );
  }
  return { newWallet, execute, tokenAccount };
}

/** Strict pubkey parse with the repo's placeholder/dangerous-address guards. */
function parsePubkey(label: string, value: string): PublicKey {
  if (!value || value.startsWith("REPLACE_WITH") || value.includes("placeholder")) {
    fail(`${label} looks like a placeholder: "${value}"`);
  }
  let pk: PublicKey;
  try {
    pk = new PublicKey(value);
  } catch {
    return fail(`${label} is not a valid Solana public key: "${value}"`);
  }
  if (DANGEROUS.has(pk.toBase58())) fail(`${label} is a dangerous placeholder/system address: ${pk.toBase58()}`);
  return pk;
}

interface EnvFileState {
  file: string;
  exists: boolean;
  content: string;
  /** key -> current value for every dev key present in the file */
  values: Map<string, string>;
}

function readEnvFile(file: string): EnvFileState {
  if (!fs.existsSync(file)) return { file, exists: false, content: "", values: new Map() };
  const content = fs.readFileSync(file, "utf8");
  const values = new Map<string, string>();
  for (const key of [SOL_KEY, TOKEN_KEY, LEGACY_KEY]) {
    const m = content.match(new RegExp(`^${key}=(.*)$`, "m"));
    if (m) values.set(key, m[1].trim());
  }
  return { file, exists: true, content, values };
}

/** Best-effort lookup across process.env then the parsed env files. */
function findConfigValue(name: string, envFiles: EnvFileState[]): string | null {
  const fromProc = process.env[name];
  if (fromProc && !fromProc.startsWith("REPLACE_WITH")) return fromProc;
  for (const f of envFiles) {
    if (!f.exists) continue;
    const m = f.content.match(new RegExp(`^${name}=(.*)$`, "m"));
    const v = m?.[1]?.trim();
    if (v && !v.startsWith("REPLACE_WITH")) return v;
  }
  return null;
}

/** GameConfig pubkey fields in declaration order (lib.rs GameConfig). */
const CONFIG_PUBKEY_ORDER = [
  "admin",
  "pending_admin",
  "settle_authority",
  "randomness_authority",
  "token_mint",
  "treasury_vault",
  "sol_team_wallet",
  "sol_dev_buyback_wallet",
  "sol_holder_rewards_wallet",
  "token_team_fee_account",
  "token_dev_fee_account",
  "token_holder_rewards_account",
] as const;

interface OnchainDevConfig {
  configPda: string;
  solDevBuybackWallet: string;
  tokenDevFeeAccount: string;
}

async function readOnchainConfig(connection: Connection, programId: PublicKey, mint: PublicKey): Promise<OnchainDevConfig | null> {
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config"), mint.toBuffer()], programId);
  const info = await connection.getAccountInfo(configPda);
  if (!info) return null;
  const out: Record<string, string> = {};
  let off = 8; // skip anchor discriminator
  for (const name of CONFIG_PUBKEY_ORDER) {
    out[name] = new PublicKey(info.data.subarray(off, off + 32)).toBase58();
    off += 32;
  }
  return {
    configPda: configPda.toBase58(),
    solDevBuybackWallet: out.sol_dev_buyback_wallet,
    tokenDevFeeAccount: out.token_dev_fee_account,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const { newWallet, execute, tokenAccount } = parseArgs(process.argv);

  console.log("=== Baby Kenji Flip — dev payout wallet change ===");
  console.log(execute ? "MODE              : EXECUTE (changes will be written)" : "MODE              : DRY RUN (nothing will be written)");

  // 1) Validate the new owner wallet before doing anything else.
  const newOwner = parsePubkey("new dev wallet", newWallet);
  const onCurve = PublicKey.isOnCurve(newOwner.toBytes());
  console.log(`New dev wallet    : ${newOwner.toBase58()} (valid pubkey${onCurve ? ", on-curve" : ", OFF-CURVE — fine for a multisig/PDA vault, double-check it"})`);

  // 2) Load the live env files and the chain coordinates.
  const envFiles = ENV_FILES.map(readEnvFile);
  const rpcUrl = findConfigValue("RPC_URL", envFiles);
  const programIdStr = findConfigValue("PROGRAM_ID", envFiles);
  const mintStr = findConfigValue("TOKEN_MINT", envFiles) ?? findConfigValue("BABY_KENJI_MINT", envFiles);

  // 3) Resolve the new token dev fee account (explicit or the owner's ATA).
  let newTokenAccount: PublicKey | null = null;
  if (tokenAccount) {
    newTokenAccount = parsePubkey("--token-account", tokenAccount);
    console.log(`New token account : ${newTokenAccount.toBase58()} (provided via --token-account)`);
  } else if (mintStr) {
    const mint = parsePubkey("TOKEN_MINT", mintStr);
    newTokenAccount = getAssociatedTokenAddressSync(mint, newOwner, true);
    console.log(`New token account : ${newTokenAccount.toBase58()} (derived: ATA of the new wallet for mint ${mint.toBase58()})`);
  } else {
    console.log(`New token account : UNKNOWN — no TOKEN_MINT found in env, and no --token-account given.`);
    console.log(`                    ${TOKEN_KEY} will be SKIPPED. Pass --token-account to update it.`);
  }
  if (newOwner && newTokenAccount && newOwner.equals(newTokenAccount)) {
    fail("new token account equals the owner wallet — a token fee recipient must be an SPL token account, not the wallet itself");
  }

  // 4) On-chain state (read-only, best effort — env edits still work without RPC).
  console.log("\n--- on-chain state (informational) ---");
  let chain: OnchainDevConfig | null = null;
  if (rpcUrl && programIdStr && mintStr) {
    const connection = new Connection(rpcUrl, "confirmed");
    try {
      chain = await readOnchainConfig(connection, parsePubkey("PROGRAM_ID", programIdStr), parsePubkey("TOKEN_MINT", mintStr));
      if (chain) {
        console.log(`GameConfig PDA    : ${chain.configPda}`);
        console.log(`  sol_dev_buyback_wallet = ${chain.solDevBuybackWallet}`);
        console.log(`  token_dev_fee_account  = ${chain.tokenDevFeeAccount}`);
      } else {
        console.log("GameConfig not found on-chain (program not initialized on this cluster?)");
      }
      // Sanity-check the new token account if it should exist already.
      if (newTokenAccount) {
        try {
          const acct = await getAccount(connection, newTokenAccount);
          const mintOk = mintStr ? acct.mint.toBase58() === new PublicKey(mintStr).toBase58() : true;
          console.log(`New token account : exists on-chain, mint ${mintOk ? "matches" : "MISMATCH — wrong mint!"} (owner ${acct.owner.toBase58()})`);
          if (!mintOk) fail(`the new token account is not a ${mintStr} token account`);
        } catch {
          console.log("New token account : DOES NOT EXIST on-chain yet.");
          console.log(`                    Create it before fees can ever flow there, e.g.:`);
          console.log(`                    spl-token create-account ${mintStr ?? "<TOKEN_MINT>"} --owner ${newOwner.toBase58()} --fee-payer <FUNDER>`);
        }
      }
    } catch (e: any) {
      console.log(`(could not read chain state: ${e?.message ?? e})`);
    }
  } else {
    console.log("(skipped — RPC_URL / PROGRAM_ID / TOKEN_MINT not resolvable from env or env files)");
  }

  // 5) Build the update plan across the live env files.
  interface Change {
    file: string;
    key: string;
    from: string;
    to: string;
  }
  const changes: Change[] = [];
  const newFor = (key: string): string | null =>
    key === SOL_KEY || key === LEGACY_KEY ? newOwner.toBase58() : newTokenAccount ? newTokenAccount.toBase58() : null;

  console.log("\n--- current values + plan ---");
  for (const f of envFiles) {
    if (!f.exists) {
      console.log(`[missing] ${f.file} — file not found on this machine, nothing to update here`);
      continue;
    }
    console.log(`[env]     ${f.file}`);
    for (const key of [SOL_KEY, TOKEN_KEY, LEGACY_KEY]) {
      const cur = f.values.get(key);
      if (cur === undefined) {
        if (key !== LEGACY_KEY) console.log(`  ${key} : not present in this file (set elsewhere? pm2 env block?) — skipped`);
        continue;
      }
      const next = newFor(key);
      if (next === null) {
        console.log(`  ${key} = ${cur}  ->  SKIPPED (no new token account resolved)`);
      } else if (cur === next) {
        console.log(`  ${key} = ${cur}  (already the new value)`);
      } else {
        console.log(`  ${key} = ${cur}  ->  ${next}`);
        changes.push({ file: f.file, key, from: cur, to: next });
      }
    }
  }

  console.log("\n--- NOT updated by this script ---");
  console.log("  * On-chain GameConfig: the program has NO instruction to change fee wallets after");
  console.log("    initialize_config (UpdateParams has no wallet fields). Settlement keeps paying the");
  console.log("    on-chain dev wallet shown above until the program is upgraded to allow updating it;");
  console.log("    each bet also snapshots its fee recipients at place time.");
  console.log("  * .env.example templates and docs — placeholders, not live config.");
  console.log("  * MongoDB — the dev wallet is not stored there (AppConfig only holds distribution rules).");

  if (changes.length === 0) {
    console.log("\nNothing to change in the env files. Done.");
    return;
  }

  if (!execute) {
    console.log(`\n[DRY RUN] ${changes.length} value(s) across ${new Set(changes.map((c) => c.file)).size} file(s) would be updated.`);
    console.log("Nothing was written. Re-run with --execute to apply.");
    return;
  }

  // 6) Apply: back up, rewrite, verify, log before/after.
  console.log("\n--- applying changes ---");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const byFile = new Map<string, Change[]>();
  for (const c of changes) {
    const list = byFile.get(c.file) ?? [];
    list.push(c);
    byFile.set(c.file, list);
  }
  for (const [file, list] of byFile) {
    const backup = `${file}.bak-${stamp}`;
    fs.copyFileSync(file, backup);
    console.log(`backup written    : ${backup}`);
    let content = fs.readFileSync(file, "utf8");
    for (const c of list) {
      content = content.replace(new RegExp(`^${c.key}=.*$`, "gm"), `${c.key}=${c.to}`);
    }
    fs.writeFileSync(file, content);
    // Verify by re-reading.
    const after = readEnvFile(file);
    for (const c of list) {
      const now = after.values.get(c.key);
      const okFlag = now === c.to ? "ok" : "VERIFY FAILED";
      console.log(`${file}\n  ${c.key}: ${c.from}  ->  ${now}   [${okFlag}]`);
      if (now !== c.to) fail(`post-write verification failed for ${c.key} in ${file} (restore from ${backup})`);
    }
  }

  // 7) Operator reminders — this script never touches pm2.
  console.log("\n=== done — manual follow-ups ===");
  console.log("This script did NOT restart anything. Restart the services yourself so they pick up the env:");
  for (const svc of PM2_SERVICES) console.log(`  pm2 restart ${svc}`);
  console.log("\nVerify afterwards:");
  console.log("  cd backend && npx ts-node ../scripts/verify-fee-accounts.ts   # checks the accounts exist on-chain");
  console.log("\nAnd remember the on-chain caveat above: actual fee routing follows the on-chain GameConfig,");
  console.log("which this script cannot change — plan a program upgrade to move the on-chain recipient.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
