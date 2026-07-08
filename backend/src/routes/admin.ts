import { Router, Request, Response, NextFunction } from "express";
import { randomBytes } from "crypto";
import nacl from "tweetnacl";
import { PublicKey, Transaction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { config } from "../config";
import {
  buildUpdateConfigIx,
  configPda,
  connection,
  decodeConfig,
  DecodedConfig,
  UpdateConfigParams,
} from "../solana";
import { AdminWalletModel } from "../models/AdminWallet";
import { AuditLogModel } from "../models/AuditLog";
import { BetModel } from "../models/Bet";
import { RewardPayoutModel } from "../models/RewardPayout";
import { RewardCycleModel } from "../models/RewardCycle";
import {
  DISTRIBUTION_CONFIG_KEY,
  DistributionConfig,
  loadDistributionConfig,
  validateDistributionConfig,
} from "../rewards/distributionConfig";
import { AppConfigModel } from "../models/AppConfig";

export const adminRouter = Router();

/**
 * Admin dashboard API.
 *
 * Auth: wallet-signature login against a MongoDB allowlist.
 *   1. POST /auth/challenge { wallet }      -> { message } (single-use nonce, 5 min)
 *   2. wallet signs the message bytes (ed25519 via the wallet adapter)
 *   3. POST /auth/verify { wallet, signatureHex } -> { token, role }
 *   4. every other route requires "Authorization: Bearer <token>"
 *
 * The super admin comes from ADMIN_SUPER_WALLET (seeded into Mongo at boot) and
 * is the only role that can grant/revoke other admins; it can never be revoked
 * through this API. Sessions are in-memory (they simply re-login after a
 * backend restart). No private key is ever handled here: on-chain changes are
 * built + simulated server-side and SIGNED BY THE CONNECTED ADMIN WALLET in
 * the browser.
 */

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

interface Challenge { nonce: string; issuedAt: string; expires: number; }
interface Session { wallet: string; role: "super" | "admin"; expires: number; }

const challenges = new Map<string, Challenge>(); // wallet -> challenge
const sessions = new Map<string, Session>(); // token -> session

function challengeMessage(wallet: string, c: Challenge): string {
  // Human-readable so wallets render it clearly; exact bytes are verified.
  return `Baby Kenji Flip admin login\nwallet: ${wallet}\nnonce: ${c.nonce}\nissued: ${c.issuedAt}`;
}

async function ensureSuperAdmin(): Promise<void> {
  if (!config.adminSuperWallet) return;
  await AdminWalletModel.updateOne(
    { wallet: config.adminSuperWallet.toBase58() },
    { $set: { role: "super", revoked: false }, $setOnInsert: { label: "super admin (env)", addedBy: "env:ADMIN_SUPER_WALLET" } },
    { upsert: true }
  );
}
// Seed on module load; harmless if Mongo connects a moment later (retried on login).
ensureSuperAdmin().catch(() => undefined);

function parseWallet(v: unknown): PublicKey {
  return new PublicKey(String(v)); // throws on invalid
}

adminRouter.post("/auth/challenge", async (req, res) => {
  try {
    if (!config.adminSuperWallet) return res.status(403).json({ error: "admin dashboard is not enabled (ADMIN_SUPER_WALLET unset)" });
    const wallet = parseWallet(req.body?.wallet).toBase58();
    const c: Challenge = { nonce: randomBytes(16).toString("hex"), issuedAt: new Date().toISOString(), expires: Date.now() + CHALLENGE_TTL_MS };
    challenges.set(wallet, c);
    res.json({ message: challengeMessage(wallet, c) });
  } catch {
    res.status(400).json({ error: "invalid wallet" });
  }
});

adminRouter.post("/auth/verify", async (req, res) => {
  try {
    if (!config.adminSuperWallet) return res.status(403).json({ error: "admin dashboard is not enabled" });
    await ensureSuperAdmin();
    const walletPk = parseWallet(req.body?.wallet);
    const wallet = walletPk.toBase58();
    const signatureHex = String(req.body?.signatureHex ?? "");
    if (!/^[0-9a-fA-F]{128}$/.test(signatureHex)) return res.status(400).json({ error: "signatureHex must be 64 bytes of hex" });

    const c = challenges.get(wallet);
    if (!c || c.expires < Date.now()) return res.status(400).json({ error: "challenge expired — request a new one" });
    challenges.delete(wallet); // single use

    const message = new TextEncoder().encode(challengeMessage(wallet, c));
    const ok = nacl.sign.detached.verify(message, Buffer.from(signatureHex, "hex"), walletPk.toBytes());
    if (!ok) return res.status(401).json({ error: "signature verification failed" });

    const entry: any = await AdminWalletModel.findOne({ wallet, revoked: false }).lean();
    if (!entry) return res.status(403).json({ error: "wallet is not on the admin allowlist" });

    const token = randomBytes(32).toString("hex");
    sessions.set(token, { wallet, role: entry.role, expires: Date.now() + SESSION_TTL_MS });
    res.json({ token, role: entry.role, expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "login failed" });
  }
});

interface AdminRequest extends Request { admin?: Session; }

function requireAdmin(req: AdminRequest, res: Response, next: NextFunction) {
  const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const session = token ? sessions.get(token) : undefined;
  if (!session || session.expires < Date.now()) {
    if (session) sessions.delete(token);
    return res.status(401).json({ error: "not authenticated" });
  }
  req.admin = session;
  next();
}

function requireSuper(req: AdminRequest, res: Response, next: NextFunction) {
  if (req.admin?.role !== "super") return res.status(403).json({ error: "super admin only" });
  next();
}

async function audit(actor: string, action: string, target: string | null, before: unknown, after: unknown, signature: string | null = null, status = "applied") {
  await AuditLogModel.create({ actor, action, target, before, after, signature, status });
}

// ---------------------------------------------------------------------------
// Read: overview + stats
// ---------------------------------------------------------------------------
const SOL_VAULT_ACCOUNT_SPACE = 8 + 1;

async function fetchConfigStrict(): Promise<DecodedConfig> {
  const info = await connection.getAccountInfo(configPda());
  if (!info) throw new Error("on-chain GameConfig not found");
  return decodeConfig(info.data);
}

adminRouter.get("/overview", requireAdmin, async (_req, res) => {
  try {
    const cfg = await fetchConfigStrict();
    const [tokenVault, solVaultLamports, rentMin, tokenPot, solPotLamports, supply, distribution] = await Promise.all([
      connection.getTokenAccountBalance(cfg.treasuryVault).then((b) => b.value.amount).catch(() => "0"),
      connection.getBalance(cfg.solVault),
      connection.getMinimumBalanceForRentExemption(SOL_VAULT_ACCOUNT_SPACE),
      connection.getTokenAccountBalance(cfg.tokenHolderRewardsAccount).then((b) => b.value.amount).catch(() => "0"),
      connection.getBalance(cfg.solHolderRewardsWallet),
      connection.getTokenSupply(config.tokenMint).then((s) => s.value.amount),
      loadDistributionConfig(),
    ]);
    const solVaultSpendable = BigInt(solVaultLamports) > BigInt(rentMin) ? BigInt(solVaultLamports) - BigInt(rentMin) : 0n;
    res.json({
      onchain: {
        programId: config.programId.toBase58(),
        configPda: configPda().toBase58(),
        admin: cfg.admin.toBase58(),
        pendingAdmin: cfg.pendingAdmin.toBase58(),
        settleAuthority: cfg.settleAuthority.toBase58(),
        paused: cfg.paused,
        feeBps: cfg.feeBps,
        solPlayerWinPayoutBps: cfg.solPlayerWinPayoutBps,
        tokenPlayerWinPayoutBps: cfg.tokenPlayerWinPayoutBps,
        minBet: cfg.minBet.toString(),
        maxBet: cfg.maxBet.toString(),
        solMinBet: cfg.solMinBet.toString(),
        solMaxBet: cfg.solMaxBet.toString(),
        maxPayoutBpsOfTreasury: cfg.maxPayoutBpsOfTreasury,
        outstandingLiability: cfg.outstandingLiability.toString(),
        outstandingLiabilitySol: cfg.outstandingLiabilitySol.toString(),
        totalBets: cfg.totalBets.toString(),
        totalWagered: cfg.totalWagered.toString(),
        totalPaidOut: cfg.totalPaidOut.toString(),
      },
      vaults: {
        tokenVault: tokenVault,
        tokenVaultAccount: cfg.treasuryVault.toBase58(),
        solVaultLamports: String(solVaultLamports),
        solVaultSpendable: solVaultSpendable.toString(),
        solVaultAccount: cfg.solVault.toBase58(),
      },
      pots: {
        token: { account: cfg.tokenHolderRewardsAccount.toBase58(), balance: tokenPot, threshold: distribution.tokenThresholdBaseUnits },
        sol: { wallet: cfg.solHolderRewardsWallet.toBase58(), balance: String(solPotLamports), threshold: distribution.solThresholdLamports },
      },
      distribution,
      mintSupply: supply,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "overview failed" });
  }
});

interface AssetStats {
  bets: number;
  wins: number;
  losses: number;
  wagered: string;
  paidOut: string;
  fees: string;
  burned: string;
  holderRewardsFees: string;
  /** Vault-perspective net: wagered - paidOut - fees (fees always leave the vault at settle). */
  houseNet: string;
}

function emptyStats(): AssetStats {
  return { bets: 0, wins: 0, losses: 0, wagered: "0", paidOut: "0", fees: "0", burned: "0", holderRewardsFees: "0", houseNet: "0" };
}

// Sums the settled-bet mirror per asset over a window. Amounts are stored as
// strings (u64-safe), so sums run in JS BigInt rather than Mongo aggregation.
async function statsSince(since: Date | null): Promise<Record<"token" | "sol", AssetStats>> {
  const filter: any = { status: "settled" };
  if (since) filter.createdAt = { $gte: since };
  const docs: any[] = await BetModel.find(filter)
    .select("asset amount payout totalFeeAmount burnFeeAmount holderRewardsFeeAmount won -_id")
    .lean();
  const out: Record<"token" | "sol", AssetStats> = { token: emptyStats(), sol: emptyStats() };
  const acc = { token: { wagered: 0n, paidOut: 0n, fees: 0n, burned: 0n, holders: 0n }, sol: { wagered: 0n, paidOut: 0n, fees: 0n, burned: 0n, holders: 0n } };
  for (const d of docs) {
    const asset: "token" | "sol" = d.asset === "sol" ? "sol" : "token";
    out[asset].bets++;
    if (d.won) out[asset].wins++; else out[asset].losses++;
    acc[asset].wagered += BigInt(d.amount ?? "0");
    acc[asset].paidOut += BigInt(d.payout ?? "0");
    acc[asset].fees += BigInt(d.totalFeeAmount ?? "0");
    acc[asset].burned += BigInt(d.burnFeeAmount ?? "0");
    acc[asset].holders += BigInt(d.holderRewardsFeeAmount ?? "0");
  }
  for (const asset of ["token", "sol"] as const) {
    out[asset].wagered = acc[asset].wagered.toString();
    out[asset].paidOut = acc[asset].paidOut.toString();
    out[asset].fees = acc[asset].fees.toString();
    out[asset].burned = acc[asset].burned.toString();
    out[asset].holderRewardsFees = acc[asset].holders.toString();
    out[asset].houseNet = (acc[asset].wagered - acc[asset].paidOut - acc[asset].fees).toString();
  }
  return out;
}

adminRouter.get("/stats", requireAdmin, async (_req, res) => {
  try {
    const now = Date.now();
    const [h24, d7, d30, lifetime] = await Promise.all([
      statsSince(new Date(now - 24 * 3600_000)),
      statsSince(new Date(now - 7 * 24 * 3600_000)),
      statsSince(new Date(now - 30 * 24 * 3600_000)),
      statsSince(null),
    ]);
    // What the distributor has actually paid to holders so far, per asset.
    const sent: any[] = await RewardPayoutModel.find({ status: "sent" }).select("asset amount -_id").lean();
    const holderPaid = { token: 0n, sol: 0n };
    for (const p of sent) holderPaid[p.asset === "sol" ? "sol" : "token"] += BigInt(p.amount ?? "0");
    const cycles = await RewardCycleModel.countDocuments({ status: "completed" });
    res.json({
      windows: { "24h": h24, "7d": d7, "30d": d30, lifetime },
      distributor: { paidToHolders: { token: holderPaid.token.toString(), sol: holderPaid.sol.toString() }, completedCycles: cycles },
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "stats failed" });
  }
});

// ---------------------------------------------------------------------------
// Write: distribution config (off-chain, Mongo) + audit
// ---------------------------------------------------------------------------
adminRouter.get("/config/distribution", requireAdmin, async (_req, res) => {
  try {
    res.json(await loadDistributionConfig());
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "failed to load config" });
  }
});

adminRouter.put("/config/distribution", requireAdmin, async (req: AdminRequest, res) => {
  try {
    const before = await loadDistributionConfig();
    const next: DistributionConfig = {
      ...before,
      ...req.body,
      enabled: { ...before.enabled, ...(req.body?.enabled ?? {}) },
    };
    validateDistributionConfig(next);
    await AppConfigModel.updateOne(
      { key: DISTRIBUTION_CONFIG_KEY },
      { $set: { value: next, updatedBy: req.admin!.wallet } },
      { upsert: true }
    );
    await audit(req.admin!.wallet, "distribution.update", DISTRIBUTION_CONFIG_KEY, before, next);
    res.json(next);
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "invalid distribution config" });
  }
});

// ---------------------------------------------------------------------------
// Write: on-chain economics via update_config (built + simulated here, signed
// by the connected admin wallet in the browser — never by a server key)
// ---------------------------------------------------------------------------
function parseUpdateParams(body: any, current: DecodedConfig): { params: UpdateConfigParams; changes: Record<string, { old: string; new: string }> } {
  const params: UpdateConfigParams = {};
  const changes: Record<string, { old: string; new: string }> = {};
  const u16 = (name: keyof UpdateConfigParams, oldVal: number, min: number, max: number) => {
    const raw = body?.[name];
    if (raw === undefined || raw === null || raw === "") return;
    const v = Number(raw);
    if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${String(name)} must be an integer in ${min}..${max}`);
    if (v !== oldVal) {
      (params as any)[name] = v;
      changes[String(name)] = { old: String(oldVal), new: String(v) };
    }
  };
  const u64 = (name: keyof UpdateConfigParams, oldVal: bigint) => {
    const raw = body?.[name];
    if (raw === undefined || raw === null || raw === "") return;
    const v = BigInt(String(raw));
    if (v <= 0n) throw new Error(`${String(name)} must be positive`);
    if (v !== oldVal) {
      (params as any)[name] = v;
      changes[String(name)] = { old: oldVal.toString(), new: v.toString() };
    }
  };

  // Mirror the program's own limits so a doomed transaction is rejected here
  // with a readable message instead of a simulation error.
  u16("feeBps", current.feeBps, 1, 1000);
  u16("solPlayerWinPayoutBps", current.solPlayerWinPayoutBps, 10_000, 20_000);
  u16("tokenPlayerWinPayoutBps", current.tokenPlayerWinPayoutBps, 10_000, 20_000);
  u16("maxPayoutBpsOfTreasury", current.maxPayoutBpsOfTreasury, 1, 2_500);
  u64("minBet", current.minBet);
  u64("maxBet", current.maxBet);
  u64("solMinBet", current.solMinBet);
  u64("solMaxBet", current.solMaxBet);
  if (body?.paused !== undefined && body.paused !== null && Boolean(body.paused) !== current.paused) {
    params.paused = Boolean(body.paused);
    changes.paused = { old: String(current.paused), new: String(params.paused) };
  }

  const feeBps = params.feeBps ?? current.feeBps;
  for (const payout of [params.solPlayerWinPayoutBps ?? current.solPlayerWinPayoutBps, params.tokenPlayerWinPayoutBps ?? current.tokenPlayerWinPayoutBps]) {
    if (payout + feeBps > 20_000) throw new Error("payout bps + fee bps must not exceed 20000");
  }
  const minBet = params.minBet ?? current.minBet;
  const maxBet = params.maxBet ?? current.maxBet;
  if (minBet > maxBet) throw new Error("minBet must be <= maxBet");
  const solMin = params.solMinBet ?? current.solMinBet;
  const solMax = params.solMaxBet ?? current.solMaxBet;
  if (solMin > solMax) throw new Error("solMinBet must be <= solMaxBet");

  return { params, changes };
}

adminRouter.post("/onchain/build-update-config", requireAdmin, async (req: AdminRequest, res) => {
  try {
    const current = await fetchConfigStrict();
    const { params, changes } = parseUpdateParams(req.body, current);
    if (Object.keys(changes).length === 0) return res.status(400).json({ error: "no changes requested" });

    const ix = buildUpdateConfigIx(current.admin, params);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");

    // Simulate before returning anything for signature.
    const msg = new TransactionMessage({ payerKey: current.admin, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message();
    const sim = await connection.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true, commitment: "processed" });
    if (sim.value.err) {
      return res.status(400).json({ error: `simulation failed: ${JSON.stringify(sim.value.err)}`, logs: sim.value.logs ?? [] });
    }

    const tx = new Transaction();
    tx.feePayer = current.admin;
    tx.recentBlockhash = blockhash;
    tx.add(ix);
    res.json({
      transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
      blockhash,
      lastValidBlockHeight,
      onchainAdmin: current.admin.toBase58(),
      changes,
      simulation: { unitsConsumed: sim.value.unitsConsumed ?? null, logs: sim.value.logs ?? [] },
    });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "build failed" });
  }
});

/** Called by the dashboard after the admin wallet signed and sent the
 *  transaction, so the change lands in the audit log with its signature. */
adminRouter.post("/onchain/record", requireAdmin, async (req: AdminRequest, res) => {
  try {
    const signature = String(req.body?.signature ?? "");
    const changes = req.body?.changes ?? null;
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) return res.status(400).json({ error: "invalid signature" });
    let status = "submitted-unverified";
    try {
      const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (tx) status = tx.meta?.err ? "failed" : "applied";
    } catch {
      /* RPC lag — keep submitted-unverified */
    }
    await audit(req.admin!.wallet, "onchain.update_config", configPda().toBase58(), null, changes, signature, status);
    res.json({ recorded: true, status });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "record failed" });
  }
});

// ---------------------------------------------------------------------------
// Admin allowlist management (super admin only)
// ---------------------------------------------------------------------------
adminRouter.get("/admins", requireAdmin, async (_req, res) => {
  const rows = await AdminWalletModel.find().select("wallet role label addedBy revoked createdAt -_id").sort({ createdAt: 1 }).lean();
  res.json({ admins: rows });
});

adminRouter.post("/admins", requireAdmin, requireSuper, async (req: AdminRequest, res) => {
  try {
    const wallet = parseWallet(req.body?.wallet).toBase58();
    const label = typeof req.body?.label === "string" ? req.body.label.slice(0, 64) : null;
    if (wallet === config.adminSuperWallet?.toBase58()) return res.status(400).json({ error: "that wallet is already the super admin" });
    await AdminWalletModel.updateOne(
      { wallet },
      { $set: { role: "admin", revoked: false, label, addedBy: req.admin!.wallet } },
      { upsert: true }
    );
    await audit(req.admin!.wallet, "admins.grant", wallet, null, { role: "admin", label });
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: "invalid wallet" });
  }
});

adminRouter.delete("/admins/:wallet", requireAdmin, requireSuper, async (req: AdminRequest, res) => {
  try {
    const wallet = parseWallet(req.params.wallet).toBase58();
    if (wallet === config.adminSuperWallet?.toBase58()) return res.status(400).json({ error: "the super admin cannot be revoked" });
    const r = await AdminWalletModel.updateOne({ wallet, role: { $ne: "super" } }, { $set: { revoked: true } });
    if (r.matchedCount === 0) return res.status(404).json({ error: "not an admin" });
    // Kill any live sessions for the revoked wallet immediately.
    for (const [token, s] of sessions) if (s.wallet === wallet) sessions.delete(token);
    await audit(req.admin!.wallet, "admins.revoke", wallet, { revoked: false }, { revoked: true });
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: "invalid wallet" });
  }
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------
adminRouter.get("/audit", requireAdmin, async (req, res) => {
  const raw = Number(req.query.limit);
  const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 500) : 100;
  const rows = await AuditLogModel.find().sort({ createdAt: -1 }).limit(limit).select("-_id -__v").lean();
  res.json({ entries: rows });
});
