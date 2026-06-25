/**
 * Mainnet initialize + fund script for the Forge coin-flip program.
 *
 * DRY-RUN by default: it derives every PDA, prints the plan + the per-payout cap
 * math, and does NOT send anything. Re-run with EXECUTE=1 to actually submit.
 *
 *   cd program
 *   npm install            # ensure @coral-xyz/anchor, @solana/spl-token, ts-node are present
 *   # dry-run:
 *   RPC_URL="https://mainnet.helius-rpc.com/?api-key=KEY" ADMIN_KEYPAIR=/path/admin.json \
 *     npx ts-node scripts/init-mainnet.ts
 *   # send it:
 *   RPC_URL="..." ADMIN_KEYPAIR=/path/admin.json EXECUTE=1 \
 *     npx ts-node scripts/init-mainnet.ts
 *
 * NOTE: the keypair you pass as ADMIN_KEYPAIR becomes the PERMANENT on-chain admin
 * (treasury withdrawals + config). There is no admin-rotation instruction. Choose
 * deliberately — ideally a key you keep cold.
 */
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY, Connection } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { ForgeCoinflip } from "../target/types/forge_coinflip";
import * as fs from "fs";
import * as path from "path";

// ----------------------------------------------------------------------------
// CONFIG — review every line before running with EXECUTE=1
// ----------------------------------------------------------------------------
const RPC_URL = process.env.RPC_URL || "https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY";
const ADMIN_KEYPAIR = process.env.ADMIN_KEYPAIR || "/home/deployer/admin.json";
const EXECUTE = process.env.EXECUTE === "1";

const TOKEN_MINT = new PublicKey("BABYKxGpoWQFFDBH7hf9Tdx8ZZPEguunENRwd3a1AZsf"); // $HUSKY (9 decimals)
const SETTLE_AUTHORITY = new PublicKey("8KXqQwtrgtKxNfTWYsN34XNKXVQQR78JZfgbLorNL2n1"); // backend hot key

/**
 * Commitment that goes on-chain (GameConfig.current_seed_hash). It MUST equal
 * sha256(serverSeed bytes) of the EXACT seed your backend stores for epoch 0,
 * or settle() will 409 with "seed/commitment desync".
 *
 * STRONGLY RECOMMENDED: do NOT reuse the seed you pasted in chat (an active server
 * seed must stay secret until reveal). Instead, run the backend once, let it
 * generate epoch 0, copy the commit hash it prints, and paste it here. The value
 * below is sha256 of the seed you sent, provided only so the script is runnable.
 */
const SEED_HASH_HEX = "f48009742f8752713ee7cd03b9597a7518dde40003c6a7cf940757cc9229a6e5";

const FEE_BPS = 500;          // 2.5% edge -> pays 1.95x
const MAX_PAYOUT_BPS = 2500;  // a single payout can't exceed 15% of the backing vault

const HUSKY_MIN = 1_000n * 10n ** 9n;       // 10,000 $HUSKY
const HUSKY_MAX = 1_000_000n * 10n ** 9n;   // 10,000,000 $HUSKY
const SOL_MIN = 10_000_000n;                 // 0.01 SOL
const SOL_MAX = 1_000_000_000n;              // 1 SOL

// Optional funding in the SAME run (0 = skip; you can also fund later/separately).
const FUND_SOL_LAMPORTS = 0n;   // e.g. 5_000_000_000n = 5 SOL
const FUND_HUSKY_BASE = 0n;     // e.g. 120_000_000n * 10n ** 9n = 120,000,000 $HUSKY
// ----------------------------------------------------------------------------

const bn = (v: bigint) => new anchor.BN(v.toString());
const f9 = (v: bigint) => (Number(v) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 9 });

function capMath(label: string, stakeBase: bigint) {
  const mult = (2 * (10_000 - FEE_BPS)) / 10_000;
  const payout = Number(stakeBase) * mult;
  const needVault = payout / (MAX_PAYOUT_BPS / 10_000) - Number(stakeBase);
  console.log(
    `  ${label}: max stake ${f9(stakeBase)} -> payout ${(payout / 1e9).toLocaleString()} ` +
      `=> vault must hold >= ${(needVault / 1e9).toLocaleString(undefined, { maximumFractionDigits: 2 })} to allow it`
  );
}

async function main() {
  const seedHash = Buffer.from(SEED_HASH_HEX, "hex");
  if (seedHash.length !== 32) throw new Error("SEED_HASH_HEX must be 32 bytes (64 hex chars)");

  const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(ADMIN_KEYPAIR, "utf8"))));
  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idlPath = path.join(__dirname, "../target/idl/forge_coinflip.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const program = new anchor.Program<ForgeCoinflip>(idl, provider);

  const [config] = PublicKey.findProgramAddressSync(
    [Buffer.from("config"), TOKEN_MINT.toBuffer()],
    program.programId
  );
  const [treasuryVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), config.toBuffer()],
    program.programId
  );
  const [solVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("sol_vault"), config.toBuffer()],
    program.programId
  );
  const adminAta = getAssociatedTokenAddressSync(TOKEN_MINT, admin.publicKey);

  console.log("=== Forge coin-flip — mainnet init ===");
  console.log("RPC               :", RPC_URL.replace(/api-key=[^&]+/, "api-key=***"));
  console.log("Program ID        :", program.programId.toBase58());
  console.log("Admin (PERMANENT) :", admin.publicKey.toBase58());
  console.log("Settle authority  :", SETTLE_AUTHORITY.toBase58());
  console.log("Token mint        :", TOKEN_MINT.toBase58(), "(9 decimals)");
  console.log("Config PDA        :", config.toBase58());
  console.log("Token vault PDA   :", treasuryVault.toBase58());
  console.log("SOL vault PDA     :", solVault.toBase58());
  console.log("seed_hash         :", SEED_HASH_HEX);
  console.log("fee_bps           :", FEE_BPS, `(${(2 * (10_000 - FEE_BPS)) / 10_000}x)`);
  console.log("max_payout_bps    :", MAX_PAYOUT_BPS, `(${MAX_PAYOUT_BPS / 100}%)`);
  console.log("HUSKY min/max     :", `${f9(HUSKY_MIN)} / ${f9(HUSKY_MAX)} tokens`);
  console.log("SOL   min/max     :", `${f9(SOL_MIN)} / ${f9(SOL_MAX)} SOL`);
  console.log("\nPer-payout cap requirement (fund the vaults to at least this):");
  capMath("SOL  ", SOL_MAX);
  capMath("HUSKY", HUSKY_MAX);
  console.log(`\nPlanned funding this run: SOL ${f9(FUND_SOL_LAMPORTS)} | HUSKY ${f9(FUND_HUSKY_BASE)}`);

  const adminBal = await connection.getBalance(admin.publicKey);
  console.log(`\nAdmin SOL balance : ${(adminBal / 1e9).toFixed(4)} SOL`);

  if (!EXECUTE) {
    console.log("\n[DRY RUN] nothing sent. Re-run with EXECUTE=1 to submit.");
    return;
  }

  // 1) initialize_config (creates config + token vault + SOL vault)
  console.log("\n>> initialize_config ...");
  const sig1 = await program.methods
    .initializeConfig({
      settleAuthority: SETTLE_AUTHORITY,
      feeBps: FEE_BPS,
      minBet: bn(HUSKY_MIN),
      maxBet: bn(HUSKY_MAX),
      maxPayoutBpsOfTreasury: MAX_PAYOUT_BPS,
      seedHash: Array.from(seedHash),
      solMinBet: bn(SOL_MIN),
      solMaxBet: bn(SOL_MAX),
    })
    .accountsPartial({
      admin: admin.publicKey,
      mint: TOKEN_MINT,
      config,
      treasuryVault,
      solVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();
  console.log("   ok:", sig1);

  // 2) optional: fund the SOL vault
  if (FUND_SOL_LAMPORTS > 0n) {
    console.log(`\n>> deposit_sol_treasury ${f9(FUND_SOL_LAMPORTS)} SOL ...`);
    const sig2 = await program.methods
      .depositSolTreasury(bn(FUND_SOL_LAMPORTS))
      .accountsPartial({ admin: admin.publicKey, config, solVault, systemProgram: SystemProgram.programId })
      .rpc();
    console.log("   ok:", sig2);
  }

  // 3) optional: fund the token vault (admin must hold $HUSKY in its ATA)
  if (FUND_HUSKY_BASE > 0n) {
    console.log(`\n>> deposit_treasury ${f9(FUND_HUSKY_BASE)} $HUSKY ...`);
    const sig3 = await program.methods
      .depositTreasury(bn(FUND_HUSKY_BASE))
      .accountsPartial({
        admin: admin.publicKey,
        config,
        treasuryVault,
        adminTokenAccount: adminAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    console.log("   ok:", sig3);
  }

  console.log("\nDone. Verify with:  solana account", config.toBase58(), " (or reload the app)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
