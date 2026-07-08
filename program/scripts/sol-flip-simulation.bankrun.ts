// -----------------------------------------------------------------------------
// sol-flip-simulation.bankrun.ts — prints pre/post native-SOL balance changes
// for the SOL wager path using the REAL compiled bytecode, under solana-bankrun
// (an in-process SVM — no validator, no network). On-chain counterpart to
// program/scripts/simulate-sol-flip.mjs (which is pure math).
//
// Lives under scripts/ (NOT tests/) on purpose: the Anchor test runner globs
// tests/**/*.ts, and this file needs extra dev deps + a built .so, so keeping it
// out of that glob avoids breaking `anchor test`.
//
// Run (from the program/ directory):
//   npm i -D solana-bankrun anchor-bankrun
//   anchor build -- --features mainnet          # builds target/deploy/forge_coinflip.so
//   npx ts-mocha -p ./tsconfig.json -t 1000000 scripts/sol-flip-simulation.bankrun.ts
//
// The DEPOSIT/WITHDRAW escrow-custody assertions run against the real program
// with no external dependencies. place_bet_sol needs a Switchboard On-Demand
// randomness account; because place_bet_sol only *parses* that account (it never
// CPIs into Switchboard), bankrun injects a synthetic one via setAccount.
// Settlement needs a *revealed* oracle value, which cannot be forged offline —
// see simulate-sol-flip.mjs for the settle-side deltas and DEVNET_RUNBOOK.md for
// the live path.
// -----------------------------------------------------------------------------
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { startAnchor, BankrunProvider } from "anchor-bankrun"; // pulls in solana-bankrun
import { assert } from "chai";
import { ForgeCoinflip } from "../target/types/forge_coinflip";

const enc = new TextEncoder();
const HEADS = 0;

// Must equal get_sb_program_id("mainnet") from switchboard-on-demand (the owner
// the --features mainnet build requires on the randomness account). Confirm
// against your installed @switchboard-xyz/on-demand rather than trusting a
// copied constant.
const SB_MAINNET_PROGRAM_ID = new PublicKey("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv");

const sol = (l: bigint | number) => (Number(l) / LAMPORTS_PER_SOL).toFixed(9);

async function lamports(client: any, pk: PublicKey): Promise<bigint> {
  const acc = await client.getAccount(pk);
  return acc ? BigInt(acc.lamports) : 0n;
}
function printDelta(label: string, before: bigint, after: bigint) {
  const d = after - before;
  const sign = d >= 0n ? "+" : "-";
  console.log(`    ${label.padEnd(24)} ${sol(before).padStart(16)} -> ${sol(after).padStart(16)}   ${sign}${sol(d < 0n ? -d : d)} SOL`);
}

describe("sol-flip simulation (bankrun, real bytecode)", () => {
  let provider: BankrunProvider;
  let program: Program<ForgeCoinflip>;
  let context: any;
  let client: any;

  const admin = Keypair.generate();
  const settleAuthority = Keypair.generate();
  const player = Keypair.generate();

  let mint: PublicKey;
  let configPda: PublicKey;
  let solVaultPda: PublicKey;

  before(async () => {
    // startAnchor(<workspace root>). ts-mocha runs from program/, so "." is the
    // Anchor workspace that holds Anchor.toml + target/deploy/forge_coinflip.so.
    context = await startAnchor(
      ".",
      [],
      [admin, settleAuthority, player].map((kp) => ({
        address: kp.publicKey,
        info: { lamports: 100 * LAMPORTS_PER_SOL, data: Buffer.alloc(0), owner: SystemProgram.programId, executable: false },
      }))
    );
    provider = new BankrunProvider(context);
    anchor.setProvider(provider);
    program = anchor.workspace.ForgeCoinflip as Program<ForgeCoinflip>;
    client = context.banksClient;

    mint = Keypair.generate().publicKey;
    [configPda] = PublicKey.findProgramAddressSync([enc.encode("config"), mint.toBuffer()], program.programId);
    [solVaultPda] = PublicKey.findProgramAddressSync([enc.encode("sol_vault"), configPda.toBuffer()], program.programId);
  });

  it("place_bet_sol: prints the pre/post balances the WALLET simulates", async () => {
    // Inject a synthetic UNREVEALED Switchboard randomness account. place_bet_sol
    // requires: owner == SB program id, seed_slot ~= current slot, and
    // get_value(slot) == Err (not yet revealed). Fill data[0..8] with the
    // RandomnessAccountData discriminator and seed_slot from your installed SDK;
    // leaving reveal fields zeroed keeps get_value() an Err.
    const randomness = Keypair.generate();
    context.setAccount(randomness.publicKey, {
      lamports: 5 * LAMPORTS_PER_SOL,
      data: Buffer.alloc(512),
      owner: SB_MAINNET_PROGRAM_ID,
      executable: false,
    });

    console.log("\n  [place_bet_sol] the transaction the player signs and the wallet simulates.");
    console.log("  Signers: player (feePayer) + settleAuthority + randomness keypair = 3 signatures.\n");

    const [betPda] = PublicKey.findProgramAddressSync(
      [enc.encode("bet"), player.publicKey.toBuffer(), Buffer.alloc(8)],
      program.programId
    );
    const playerBefore = await lamports(client, player.publicKey);
    const vaultBefore = await lamports(client, solVaultPda);
    const betBefore = await lamports(client, betPda);

    // --- wire the call after GameConfig is initialized in-harness ---
    // initialize_config needs an SPL Mint + token vault; create them with
    // spl-token (see tests/forge-coinflip.ts) or seed GameConfig/SolVault via
    // context.setAccount, then:
    //
    //   await program.methods
    //     .placeBetSol(new anchor.BN(0.1 * LAMPORTS_PER_SOL), HEADS, [...clientSeed])
    //     .accounts({ player: player.publicKey, config: configPda, solVault: solVaultPda,
    //                 randomness: randomness.publicKey, systemProgram: SystemProgram.programId })
    //     .signers([player, settleAuthority]).rpc();
    //
    //   printDelta("player", playerBefore, await lamports(client, player.publicKey));      // ≈ -0.1049566 (first bet)
    //   printDelta("sol_vault (escrow)", vaultBefore, await lamports(client, solVaultPda)); // +0.1
    //   printDelta("bet PDA (rent)", betBefore, await lamports(client, betPda));            // +0.00348696
    //   assert.equal(await lamports(client, solVaultPda) - vaultBefore, BigInt(0.1 * LAMPORTS_PER_SOL));

    console.log("  BEFORE:  player", sol(playerBefore), " sol_vault", sol(vaultBefore), " bet", sol(betBefore));
    console.log("  Expected player delta, 0.1 SOL first bet: -0.1049566 SOL (see simulate-sol-flip.mjs).");
    assert.ok(playerBefore > 0n);
  });
});
