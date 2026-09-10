import fs from "node:fs";
import { createHash } from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const PROGRAM_ID = new PublicKey("DFmU9mwDbHkGRZ5J2f9zi59ZyDapaEv8qHhKsx8KpwAj");
const TOKEN_MINT = new PublicKey("BABYKxGpoWQFFDBH7hf9Tdx8ZZPEguunENRwd3a1AZsf");
const CONFIG_PDA = new PublicKey("CYsh9EY6fHC5EnmqiuMZacU7WRgeDduGSnQMutqRFqKU");
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const EXECUTE = process.argv.includes("--execute");
const connection = new Connection(RPC_URL, "confirmed");

const ixDisc = (name) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

function loadAdmin() {
  const p = process.env.ADMIN_KEYPAIR_PATH;
  if (!p) return null;
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function decodeConfig(data) {
  let o = 8;
  const pk = () => new PublicKey(data.subarray(o, (o += 32)));
  const readU16 = () => { const v = data.readUInt16LE(o); o += 2; return v; };
  const readU64 = () => { const v = data.readBigUInt64LE(o); o += 8; return v; };
  const readU128 = () => {
    const lo = data.readBigUInt64LE(o);
    const hi = data.readBigUInt64LE(o + 8);
    o += 16;
    return lo + (hi << 64n);
  };
  const cfg = {};
  cfg.admin = pk();
  cfg.pendingAdmin = pk();
  cfg.settleAuthority = pk();
  cfg.randomnessAuthority = pk();
  cfg.tokenMint = pk();
  cfg.treasuryVault = pk();
  cfg.solTeamWallet = pk();
  cfg.solDevWallet = pk();
  cfg.solHolderWallet = pk();
  cfg.tokenTeamAccount = pk();
  cfg.tokenDevAccount = pk();
  cfg.tokenHolderAccount = pk();
  o += 32; // current_seed_hash
  cfg.seedEpoch = readU64();
  cfg.feeBps = readU16();
  cfg.solPayoutBps = readU16();
  cfg.tokenPayoutBps = readU16();
  cfg.minBet = readU64();
  cfg.maxBet = readU64();
  cfg.maxPayoutBps = readU16();
  cfg.tokenLiability = readU128();
  cfg.paused = data.readUInt8(o++) === 1;
  cfg.totalBets = readU64();
  cfg.totalWagered = readU128();
  cfg.totalPaidOut = readU128();
  cfg.solVault = pk();
  cfg.solMinBet = readU64();
  cfg.solMaxBet = readU64();
  cfg.solLiability = readU128();
  cfg.bump = data.readUInt8(o);
  return cfg;
}

function decodeBet(pubkey, data) {
  let o = 8;
  const pk = () => new PublicKey(data.subarray(o, (o += 32)));
  const readU64 = () => { const v = data.readBigUInt64LE(o); o += 8; return v; };
  const bet = { pubkey };
  bet.config = pk();
  bet.player = pk();
  bet.amount = readU64();
  bet.feeTeam = pk();
  bet.feeDev = pk();
  bet.feeHolder = pk();
  bet.payoutBps = data.readUInt16LE(o); o += 2;
  bet.payout = readU64();
  bet.totalFee = readU64();
  bet.teamFee = readU64();
  bet.devFee = readU64();
  bet.burnFee = readU64();
  bet.holderFee = readU64();
  bet.liability = readU64();
  bet.choice = data.readUInt8(o++);
  bet.asset = data.readUInt8(o++);
  o += 32; // client_seed
  bet.nonce = readU64();
  o += 32; // seed_hash
  bet.seedEpoch = readU64();
  bet.placedSlot = readU64();
  bet.commitSlot = readU64();
  bet.deadline = readU64();
  bet.randomness = pk();
  bet.bump = data.readUInt8(o);
  return bet;
}

async function fetchConfig() {
  const ai = await connection.getAccountInfo(CONFIG_PDA, "confirmed");
  if (!ai) throw new Error("GameConfig PDA not found");
  if (!ai.owner.equals(PROGRAM_ID)) throw new Error("GameConfig owner mismatch");
  const cfg = decodeConfig(ai.data);
  if (!cfg.tokenMint.equals(TOKEN_MINT)) throw new Error("GameConfig mint mismatch");
  return cfg;
}

async function fetchOpenBets() {
  const rows = await connection.getProgramAccounts(PROGRAM_ID, {
    commitment: "confirmed",
    filters: [{ dataSize: 373 }],
  });
  return rows.map(({ pubkey, account }) => decodeBet(pubkey, account.data));
}

function pauseIx(admin) {
  // UpdateParams field order: 7 Nones, paused=Some(true), 2 Nones.
  const data = Buffer.concat([ixDisc("update_config"), Buffer.alloc(7), Buffer.from([1, 1, 0, 0])]);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: false },
      { pubkey: CONFIG_PDA, isSigner: false, isWritable: true },
    ],
    data,
  });
}

function refundIx(admin, cfg, bet) {
  const common = [
    { pubkey: admin, isSigner: true, isWritable: false },
    { pubkey: CONFIG_PDA, isSigner: false, isWritable: true },
    { pubkey: bet.pubkey, isSigner: false, isWritable: true },
    { pubkey: bet.player, isSigner: false, isWritable: true },
  ];
  if (bet.asset === 0) {
    return new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        ...common,
        { pubkey: cfg.treasuryVault, isSigner: false, isWritable: true },
        { pubkey: getAssociatedTokenAddressSync(TOKEN_MINT, bet.player), isSigner: false, isWritable: true },
        { pubkey: bet.randomness, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: ixDisc("refund_expired_bet"),
    });
  }
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      ...common,
      { pubkey: cfg.solVault, isSigner: false, isWritable: true },
      { pubkey: bet.randomness, isSigner: false, isWritable: false },
    ],
    data: ixDisc("refund_expired_bet_sol"),
  });
}

function settleIx(admin, cfg, bet) {
  const common = [
    { pubkey: admin, isSigner: true, isWritable: false },
    { pubkey: CONFIG_PDA, isSigner: false, isWritable: true },
    { pubkey: bet.pubkey, isSigner: false, isWritable: true },
    { pubkey: bet.player, isSigner: false, isWritable: true },
  ];
  if (bet.asset === 0) {
    return new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        ...common,
        { pubkey: cfg.treasuryVault, isSigner: false, isWritable: true },
        { pubkey: getAssociatedTokenAddressSync(TOKEN_MINT, bet.player), isSigner: false, isWritable: true },
        { pubkey: bet.feeTeam, isSigner: false, isWritable: true },
        { pubkey: bet.feeDev, isSigner: false, isWritable: true },
        { pubkey: bet.feeHolder, isSigner: false, isWritable: true },
        { pubkey: TOKEN_MINT, isSigner: false, isWritable: true },
        { pubkey: bet.randomness, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: ixDisc("settle_bet"),
    });
  }
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      ...common,
      { pubkey: cfg.solVault, isSigner: false, isWritable: true },
      { pubkey: bet.feeTeam, isSigner: false, isWritable: true },
      { pubkey: bet.feeDev, isSigner: false, isWritable: true },
      { pubkey: bet.feeHolder, isSigner: false, isWritable: true },
      { pubkey: bet.randomness, isSigner: false, isWritable: false },
    ],
    data: ixDisc("settle_bet_sol"),
  });
}

function withdrawSolIx(admin, cfg, amount) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: CONFIG_PDA, isSigner: false, isWritable: true },
      { pubkey: cfg.solVault, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([ixDisc("withdraw_sol_treasury"), u64(amount)]),
  });
}

function withdrawTokenIx(admin, cfg, adminTokenAccount, amount) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: CONFIG_PDA, isSigner: false, isWritable: true },
      { pubkey: cfg.treasuryVault, isSigner: false, isWritable: true },
      { pubkey: adminTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([ixDisc("withdraw_treasury"), u64(amount)]),
  });
}

async function send(admin, label, ix) {
  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [admin], {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
    skipPreflight: false,
  });
  console.log(`${label}: ${sig}`);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ensureAssociatedTokenAccount(admin, owner, label) {
  const address = getAssociatedTokenAddressSync(TOKEN_MINT, owner);
  const verify = async () => {
    const info = await connection.getAccountInfo(address, "confirmed");
    if (!info) return false;
    if (!info.owner.equals(TOKEN_PROGRAM_ID) || info.data.length < 64) {
      throw new Error(`${label} ATA ${address.toBase58()} exists but is not a valid SPL token account`);
    }
    const mint = new PublicKey(info.data.subarray(0, 32));
    const tokenOwner = new PublicKey(info.data.subarray(32, 64));
    if (!mint.equals(TOKEN_MINT) || !tokenOwner.equals(owner)) {
      throw new Error(`${label} ATA ${address.toBase58()} has the wrong mint or owner`);
    }
    return true;
  };

  if (!(await verify())) {
    let createError;
    try {
      await send(
        admin,
        `created ${label} BABYK ATA`,
        createAssociatedTokenAccountIdempotentInstruction(
          admin.publicKey,
          address,
          owner,
          TOKEN_MINT,
        ),
      );
    } catch (err) {
      // A confirmation/read race can report failure even after the ATA landed.
      // Poll the exact account before deciding the creation really failed.
      createError = err;
      console.warn(`${label} ATA creation did not confirm cleanly; checking on-chain state...`);
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await verify()) break;
      await wait(1_000);
    }
    if (!(await verify())) {
      throw new Error(`${label} ATA ${address.toBase58()} was not created`, { cause: createError });
    }
  }

  console.log(`${label} BABYK ATA ready: ${owner.toBase58()} -> ${address.toBase58()}`);
  return address;
}

async function simulate(admin, ix) {
  const tx = new Transaction().add(ix);
  tx.feePayer = admin.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(admin);
  const wire = tx.serialize().toString("base64");
  const response = await connection._rpcRequest("simulateTransaction", [wire, {
    encoding: "base64",
    sigVerify: true,
    commitment: "confirmed",
  }]);
  if (response.error) throw new Error(`simulation RPC error: ${JSON.stringify(response.error)}`);
  return response.result;
}

async function main() {
  let cfg = await fetchConfig();
  const [tokenBal, solBal, rent, slot, bets] = await Promise.all([
    connection.getTokenAccountBalance(cfg.treasuryVault, "confirmed"),
    connection.getBalance(cfg.solVault, "confirmed"),
    connection.getMinimumBalanceForRentExemption(9, "confirmed"),
    connection.getSlot("confirmed"),
    fetchOpenBets(),
  ]);
  const tokenAvailable = BigInt(tokenBal.value.amount) - cfg.tokenLiability;
  const solAvailable = BigInt(solBal) - BigInt(rent) - cfg.solLiability;
  console.log({
    rpc: RPC_URL,
    program: PROGRAM_ID.toBase58(),
    config: CONFIG_PDA.toBase58(),
    admin: cfg.admin.toBase58(),
    paused: cfg.paused,
    tokenVault: cfg.treasuryVault.toBase58(),
    tokenBalance: tokenBal.value.uiAmountString,
    tokenLiabilityRaw: cfg.tokenLiability.toString(),
    tokenWithdrawableNowRaw: tokenAvailable.toString(),
    solVault: cfg.solVault.toBase58(),
    solBalance: solBal / 1e9,
    solLiability: Number(cfg.solLiability) / 1e9,
    solWithdrawableNow: Number(solAvailable) / 1e9,
    openBets: bets.length,
  });
  for (const b of bets) {
    console.log(`  ${b.pubkey.toBase58()} ${b.asset === 0 ? "BABYK" : "SOL"} player=${b.player.toBase58()} nonce=${b.nonce} expired=${BigInt(slot) > b.deadline}`);
  }
  if (!EXECUTE) {
    console.log("DRY RUN ONLY. Re-run with ADMIN_KEYPAIR_PATH=/absolute/path/admin.json --execute");
    return;
  }

  const admin = loadAdmin();
  if (!admin) throw new Error("ADMIN_KEYPAIR_PATH is required with --execute");
  if (!admin.publicKey.equals(cfg.admin)) {
    throw new Error(`wrong signer: ${admin.publicKey.toBase58()} != on-chain admin ${cfg.admin.toBase58()}`);
  }
  if (!cfg.settleAuthority.equals(admin.publicKey)) {
    throw new Error("admin is not the configured settle authority; unresolved ready bets cannot be settled safely by this script");
  }

  if (!cfg.paused) await send(admin, "paused", pauseIx(admin.publicKey));

  // Move only the currently unreserved SOL first. This funds any missing player
  // ATAs needed to honor old token refunds/settlements while leaving every open
  // SOL liability and the vault rent reserve untouched.
  cfg = await fetchConfig();
  const initialSolBalance = BigInt(await connection.getBalance(cfg.solVault, "confirmed"));
  const initialSolRent = BigInt(await connection.getMinimumBalanceForRentExemption(9, "confirmed"));
  const initialSolWithdrawable = initialSolBalance - initialSolRent - cfg.solLiability;
  if (initialSolWithdrawable > 0n) {
    await send(admin, `withdrew initial unreserved ${Number(initialSolWithdrawable) / 1e9} SOL`, withdrawSolIx(admin.publicKey, cfg, initialSolWithdrawable));
  }

  const openBets = await fetchOpenBets();
  const tokenPlayers = new Map();
  for (const bet of openBets) {
    if (bet.asset === 0) tokenPlayers.set(bet.player.toBase58(), bet.player);
  }
  for (const player of tokenPlayers.values()) {
    await ensureAssociatedTokenAccount(admin, player, "player");
  }

  for (const bet of openBets) {
    const now = BigInt(await connection.getSlot("confirmed"));
    if (now <= bet.deadline) throw new Error(`bet ${bet.pubkey.toBase58()} is not expired; aborting drain`);
    const refund = refundIx(admin.publicKey, cfg, bet);
    const refundSim = await simulate(admin, refund);
    if (!refundSim.value.err) {
      await send(admin, `refunded ${bet.pubkey.toBase58()}`, refund);
      continue;
    }
    const settle = settleIx(admin.publicKey, cfg, bet);
    const settleSim = await simulate(admin, settle);
    if (!settleSim.value.err) {
      await send(admin, `settled ${bet.pubkey.toBase58()}`, settle);
      continue;
    }
    console.error("refund logs:", refundSim.value.logs);
    console.error("settle logs:", settleSim.value.logs);
    throw new Error(`neither refund nor settlement simulated for ${bet.pubkey.toBase58()}; aborting before treasury withdrawals`);
  }

  cfg = await fetchConfig();
  if (cfg.tokenLiability !== 0n || cfg.solLiability !== 0n) {
    throw new Error(`liabilities remain: token=${cfg.tokenLiability} sol=${cfg.solLiability}`);
  }

  const solLamports = BigInt(await connection.getBalance(cfg.solVault, "confirmed"));
  const solRent = BigInt(await connection.getMinimumBalanceForRentExemption(9, "confirmed"));
  const withdrawSol = solLamports - solRent;
  if (withdrawSol > 0n) await send(admin, `withdrew ${Number(withdrawSol) / 1e9} SOL`, withdrawSolIx(admin.publicKey, cfg, withdrawSol));

  const adminAta = await ensureAssociatedTokenAccount(admin, admin.publicKey, "admin");
  const tokenRaw = BigInt((await connection.getTokenAccountBalance(cfg.treasuryVault, "confirmed")).value.amount);
  if (tokenRaw > 0n) await send(admin, `withdrew ${Number(tokenRaw) / 1e9} BABYK`, withdrawTokenIx(admin.publicKey, cfg, adminAta, tokenRaw));

  cfg = await fetchConfig();
  const finalToken = await connection.getTokenAccountBalance(cfg.treasuryVault, "confirmed");
  const finalSol = await connection.getBalance(cfg.solVault, "confirmed");
  console.log({ finalTokenRaw: finalToken.value.amount, finalSolLamports: finalSol, remainingOpenBets: (await fetchOpenBets()).length });
}

main().catch((err) => { console.error(err); process.exit(1); });
