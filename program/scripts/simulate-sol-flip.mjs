#!/usr/bin/env node
// -----------------------------------------------------------------------------
// simulate-sol-flip.mjs
//
// Prints the exact pre/post native-SOL balance deltas that a wallet simulator
// (Phantom / Blowfish) sees for the SOL coin-flip, WITHOUT needing a validator,
// RPC, or the SBF toolchain. It reproduces:
//
//   1. place_bet_sol  -- the transaction the PLAYER signs (create_randomness +
//                        commit_randomness + place_bet_sol, bundled by the
//                        backend /prepare route).
//   2. settle_bet_sol -- the SEPARATE transaction the BACKEND settle authority
//                        signs later. The player's wallet never simulates this,
//                        which is the crux of the "looks like a drain" problem.
//
// Rent and account sizes are computed from the on-chain Anchor structs so the
// numbers match a real validator. Cross-check against the bankrun harness in
// program/tests/sol-flip-simulation.ts, which runs the real bytecode.
//
// Usage:
//   node program/scripts/simulate-sol-flip.mjs [wagerSol] [payoutBps] [feeBps]
//   node program/scripts/simulate-sol-flip.mjs 0.1 17800 1000
// -----------------------------------------------------------------------------

const LAMPORTS_PER_SOL = 1_000_000_000;

// Solana rent model: rent-exempt minimum =
//   (ACCOUNT_STORAGE_OVERHEAD + dataLen) * lamportsPerByteYear * exemptionYears
const ACCOUNT_STORAGE_OVERHEAD = 128;
const LAMPORTS_PER_BYTE_YEAR = 3480;
const EXEMPTION_YEARS = 2;
const rentExempt = (dataLen) =>
  (ACCOUNT_STORAGE_OVERHEAD + dataLen) * LAMPORTS_PER_BYTE_YEAR * EXEMPTION_YEARS;

const LAMPORTS_PER_SIGNATURE = 5000;

// --- Anchor account sizes (8-byte discriminator + InitSpace of each struct) ---
// Bet: config(32) player(32) amount(8) fee_team(32) fee_dev(32) fee_holder(32)
//   payout_bps(2) player_win_payout(8) total_fee(8) team_fee(8) dev_fee(8)
//   burn_fee(8) holder_rewards_fee(8) total_win_liability(8) choice(1) asset(1)
//   client_seed(32) nonce(8) seed_hash(32) seed_epoch(8) placed_slot(8)
//   commit_slot(8) settlement_deadline_slot(8) randomness_account(32) bump(1)
const BET_INIT_SPACE = 365;
const PLAYER_STATE_INIT_SPACE = 32 + 32 + 8 + 1; // player, config, nonce, bump = 73
const DISCRIMINATOR = 8;

const BET_ACCOUNT_BYTES = DISCRIMINATOR + BET_INIT_SPACE; // 373
const PLAYER_STATE_BYTES = DISCRIMINATOR + PLAYER_STATE_INIT_SPACE; // 81

const BET_RENT = rentExempt(BET_ACCOUNT_BYTES);
const PLAYER_STATE_RENT = rentExempt(PLAYER_STATE_BYTES);

// --- inputs ---
const wagerSol = Number(process.argv[2] ?? 0.1);
const payoutBps = Number(process.argv[3] ?? 17800); // DEFAULT_PLAYER_WIN_PAYOUT_BPS
const feeBps = Number(process.argv[4] ?? 1000); // MAX_FEE_BPS example
const wager = Math.round(wagerSol * LAMPORTS_PER_SOL);

// mirrors compute_player_win_payout / compute_total_fee (floor mul-div by 10_000)
const payout = Math.floor((wager * payoutBps) / 10_000);
const totalFee = Math.floor((wager * feeBps) / 10_000);
// SOL fee split from place_bet_sol: team 500 bps, dev 300 bps, holder = remainder
const teamFee = Math.floor((wager * 500) / 10_000);
const devFee = Math.floor((wager * 300) / 10_000);
const holderFee = totalFee - teamFee - devFee;

const sol = (l) => (l / LAMPORTS_PER_SOL).toFixed(9).replace(/0+$/, "").replace(/\.$/, ".0");
const signed = (l) => (l >= 0 ? "+" : "-") + sol(Math.abs(l)) + " SOL";
const pad = (s, n) => String(s).padEnd(n);

function header(title) {
  console.log("\n" + "=".repeat(78));
  console.log(title);
  console.log("=".repeat(78));
}

console.log(`\nInputs: wager=${wagerSol} SOL  payout=${payoutBps}bps (${(payoutBps / 10000).toFixed(2)}x)  fee=${feeBps}bps`);
console.log(`Derived: payout=${sol(payout)} SOL  totalFee=${sol(totalFee)} SOL`);
console.log(`Rent (from on-chain struct sizes): Bet=${sol(BET_RENT)} SOL (${BET_ACCOUNT_BYTES}B)  PlayerState=${sol(PLAYER_STATE_RENT)} SOL (${PLAYER_STATE_BYTES}B)`);

// ---------------------------------------------------------------------------
// TX 1: place_bet_sol  (THE TRANSACTION THE WALLET SIMULATES)
// Signers: player (feePayer) + settle authority + randomness keypair = 3 sigs.
// The settle authority pays the Switchboard randomness account rent, NOT the
// player -- so it does not appear as a player debit.
// ---------------------------------------------------------------------------
for (const firstBet of [true, false]) {
  header(`TX 1 — place_bet_sol   (${firstBet ? "FIRST bet: PlayerState is created" : "REPEAT bet: PlayerState already exists"})`);
  const fee = 3 * LAMPORTS_PER_SIGNATURE; // player is feePayer, pays for all 3 sigs
  const playerStateRent = firstBet ? PLAYER_STATE_RENT : 0;
  const playerDelta = -(wager + BET_RENT + playerStateRent + fee);

  console.log(pad("\n  account", 26) + pad("role", 22) + "balance change");
  console.log("  " + "-".repeat(74));
  console.log(pad("  player (signer)", 26) + pad("wager + rent + fee", 22) + signed(playerDelta));
  console.log(pad("  sol_vault PDA", 26) + pad("escrow (program-owned)", 22) + signed(+wager));
  console.log(pad("  bet PDA", 26) + pad("rent (refunded@settle)", 22) + signed(+BET_RENT));
  if (firstBet) console.log(pad("  player_state PDA", 26) + pad("rent (one-time)", 22) + signed(+PLAYER_STATE_RENT));
  console.log(pad("  network fee", 26) + pad("3 signatures", 22) + signed(-fee));
  console.log("  " + "-".repeat(74));
  console.log(`  WHAT THE WALLET SHOWS THE USER:  player ${signed(playerDelta)}  (pure outflow, no return)`);
}

// ---------------------------------------------------------------------------
// TX 2: settle_bet_sol  (THE WALLET NEVER SEES THIS — backend signs it)
// ---------------------------------------------------------------------------
header("TX 2 — settle_bet_sol   (backend settle authority signs; player's wallet NEVER simulates this)");
console.log("\n  --- WIN branch ---");
{
  const playerCredit = payout + BET_RENT; // payout + bet-PDA rent refunded via close=player
  console.log(pad("  player", 26) + pad("payout + rent refund", 22) + signed(+playerCredit));
  console.log(pad("  sol_vault PDA", 26) + pad("pays payout + fees", 22) + signed(-(payout + totalFee)));
  console.log(pad("  team_sol_wallet", 26) + pad("fee (EOA)", 22) + signed(+teamFee));
  console.log(pad("  dev_buyback_wallet", 26) + pad("fee (EOA)", 22) + signed(+devFee));
  console.log(pad("  holder_rewards_wallet", 26) + pad("fee (EOA)", 22) + signed(+holderFee));
  console.log(`  NET for player across BOTH txs (win): ${signed(payout + BET_RENT - (wager + BET_RENT + 3 * LAMPORTS_PER_SIGNATURE))}`);
}
console.log("\n  --- LOSS branch ---");
{
  const playerCredit = BET_RENT; // only the bet-PDA rent comes back
  console.log(pad("  player", 26) + pad("rent refund only", 22) + signed(+playerCredit));
  console.log(pad("  sol_vault PDA", 26) + pad("keeps wager, pays fees", 22) + signed(+(wager - totalFee)));
  console.log(`  NET for player across BOTH txs (loss): ${signed(BET_RENT - (wager + BET_RENT + 3 * LAMPORTS_PER_SIGNATURE))}`);
}

header("SIMULATOR TAKEAWAY");
console.log(`
  * The signed place_bet_sol tx is a NET SOL OUTFLOW to a program-owned PDA
    (sol_vault) + Anchor rent. There is no same-transaction return, because the
    win/loss is resolved later by settle_bet_sol via commit-reveal randomness.
  * The escrow destination is a PDA the invoked program owns (good), NOT a plain
    house wallet. A drain heuristic keyed on "all SOL to an unknown EOA" should
    NOT fire on the destination; the residual risk signal is "unverified program
    + gambling + net outflow", which the verified build + registry submission and
    the Blowfish/Phantom domain allowlist address.
`);
