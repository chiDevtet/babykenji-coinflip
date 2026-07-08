import { Router } from "express";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  fetchBet,
  fetchPlayerNonce,
  buildPlaceBetIx,
  buildPlaceBetSolIx,
  buildSettleIx,
  buildRefundIx,
  buildSettleSolIx,
  buildRefundSolIx,
  sendIxs,
  connection,
} from "../solana";
import { buildRevealIx, readResultBit, createCommittedRandomness } from "../switchboard";
import { config } from "../config";
import { BetModel } from "../models/Bet";
import { PlayerModel } from "../models/Player";

export const betsRouter = Router();

const ASSET_SOL = 1;

function parseClientSeed(v: unknown): Buffer {
  const hex = String(v ?? "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("clientSeedHex must be 32 bytes of hex");
  return Buffer.from(hex, "hex");
}
function parseAmount(v: unknown): bigint {
  const a = BigInt(String(v)); // throws on non-integer
  if (a <= 0n) throw new Error("amount must be positive");
  return a;
}

function parsePlayer(v: unknown): PublicKey {
  return new PublicKey(String(v)); // throws on invalid
}

const label = (bit: number | null): "heads" | "tails" | null => (bit === 0 ? "heads" : bit === 1 ? "tails" : null);

// Pull program/Switchboard logs off whatever the send path threw, so /settle can
// return the real cause instead of a generic "settlement failed".
function errLogs(e: any): string[] | undefined {
  if (Array.isArray(e?.logs)) return e.logs;
  if (typeof e?.getLogs === "function") {
    try {
      return e.getLogs();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// Read the result bit after the reveal+settle lands. The reveal writes the value in
// the same (now-confirmed) transaction and we read back at the same "confirmed"
// commitment, so a couple of short retries cover RPC lag.
async function resolveResultBit(randomness: PublicKey): Promise<number | null> {
  for (let i = 0; i < 3; i++) {
    const bit = await readResultBit(randomness);
    if (bit !== null) return bit;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

const SETTLE_SEND_ATTEMPTS = Number(process.env.SETTLE_SEND_ATTEMPTS ?? 4);
const SETTLE_SEND_DELAY_MS = Number(process.env.SETTLE_SEND_DELAY_MS ?? 1500);

// Right after place_bet confirms, a lagging RPC node can still see the randomness
// account as missing/system-owned, so the reveal preflight fails with
// AccountOwnedByWrongProgram (0xbbf) or the tx blockhash goes stale. These are
// transient — the account exists, the node just hasn't caught up — so retry.
function isTransientSettleError(e: any): boolean {
  const hay = [e?.message, ...(errLogs(e) ?? [])].join(" ");
  return /AccountOwnedByWrongProgram|0xbbf|could not find account|AccountNotFound|Blockhash not found|node is behind|BlockhashNotFound/i.test(hay);
}

// Build the reveal fresh (new oracle value + blockhash) and send reveal+settle,
// retrying only on the transient propagation errors above.
async function revealAndSettle(randomness: PublicKey, settleIx: any): Promise<string> {
  let lastErr: any;
  for (let attempt = 1; attempt <= SETTLE_SEND_ATTEMPTS; attempt++) {
    try {
      const revealIx = await buildRevealIx(randomness);
      return await sendIxs([revealIx, settleIx]);
    } catch (e: any) {
      lastErr = e;
      const transient = isTransientSettleError(e);
      console.warn(`[settle] reveal+settle attempt ${attempt}/${SETTLE_SEND_ATTEMPTS} failed (transient=${transient}): ${e?.message ?? e}`);
      if (!transient || attempt === SETTLE_SEND_ATTEMPTS) throw e;
      await new Promise((r) => setTimeout(r, SETTLE_SEND_DELAY_MS));
    }
  }
  throw lastErr;
}

/**
 * Prepare a flip: create + commit a Switchboard randomness account whose authority
 * is the settle authority, build the matching place_bet(_sol) instruction, and
 * return a transaction the settle authority + randomness keypair have already
 * signed. The frontend adds the player's signature (fee payer + wager source) and
 * submits, so create + commit + place_bet stay atomic in one slot — satisfying the
 * program's MAX_RANDOMNESS_COMMIT_AGE_SLOTS window — while leaving the randomness
 * authority with the backend so it alone can reveal at settle time.
 *
 * Server-built, so the settle authority only ever signs a create+commit+place_bet
 * transaction it constructed (it is not a fund-moving signer here — it pays only the
 * randomness account rent).
 */
betsRouter.post("/prepare", async (req, res) => {
  try {
    const { player, amount, choice, clientSeedHex, asset } = req.body ?? {};
    let playerPk: PublicKey;
    try {
      playerPk = parsePlayer(player);
    } catch {
      return res.status(400).json({ error: "invalid player pubkey" });
    }
    const c = Number(choice);
    if (c !== 0 && c !== 1) return res.status(400).json({ error: "choice must be 0 (heads) or 1 (tails)" });
    const isSol = asset === "sol";
    if (asset !== "sol" && asset !== "token") return res.status(400).json({ error: "asset must be 'sol' or 'token'" });
    let amt: bigint;
    let clientSeed: Buffer;
    try {
      amt = parseAmount(amount);
      clientSeed = parseClientSeed(clientSeedHex);
    } catch (e: any) {
      return res.status(400).json({ error: e?.message ?? "invalid request" });
    }

    const nonce = await fetchPlayerNonce(playerPk);
    const rnd = await createCommittedRandomness();
    const placeIx = isSol
      ? buildPlaceBetSolIx(playerPk, amt, c, clientSeed, nonce, rnd.keypair.publicKey)
      : buildPlaceBetIx(playerPk, amt, c, clientSeed, nonce, rnd.keypair.publicKey);

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction();
    tx.feePayer = playerPk;
    tx.recentBlockhash = blockhash;
    tx.add(rnd.createIx, rnd.commitIx, placeIx);
    // Sign the settle authority (randomness authority + create payer + commit
    // authority) and the ephemeral randomness keypair (new account). The player's
    // signature slot stays empty for the wallet to fill.
    tx.partialSign(config.settleAuthority, rnd.keypair);

    res.json({
      transaction: tx.serialize({ requireAllSignatures: false }).toString("base64"),
      randomnessAccount: rnd.keypair.publicKey.toBase58(),
      nonce: Number(nonce),
      blockhash,
      lastValidBlockHeight,
    });
  } catch (e: any) {
    const logs = errLogs(e);
    console.error("[prepare] failed:", e?.message ?? e);
    if (logs?.length) console.error("[prepare] logs:\n" + logs.join("\n"));
    res.status(500).json({ error: e?.message ?? "prepare failed", logs });
  }
});

/**
 * Settle a bet that the player already placed on-chain.
 *
 * The frontend calls this after its place_bet transaction confirms, passing only
 * { player, nonce }. Everything that determines the outcome (choice, clientSeed,
 * epoch) is read from the on-chain Bet PDA — the client's word is never trusted.
 */
betsRouter.post("/settle", async (req, res) => {
  try {
    const { player, nonce } = req.body ?? {};
    if (player === undefined || nonce === undefined) {
      return res.status(400).json({ error: "player and nonce are required" });
    }
    let playerPk: PublicKey;
    try {
      playerPk = parsePlayer(player);
    } catch {
      return res.status(400).json({ error: "invalid player pubkey" });
    }
    const n = Number(nonce);
    if (!Number.isInteger(n) || n < 0) return res.status(400).json({ error: "invalid nonce" });

    // Source of truth: the on-chain bet. The Bet PDA is closed on settle, so if it's
    // gone AND our mirror has the result, this is a client retry after a dropped
    // response — answer idempotently from the mirror. If the mirror has nothing,
    // the far more likely story is RPC propagation: the frontend confirmed
    // place_bet against ITS node and this backend's node hasn't caught up yet, so
    // poll briefly before concluding anything. Never claim "settled" without a
    // result — that used to return a payload with no payout/result fields, which
    // crashed the UI (BigInt(undefined)) and left the bet unsettled.
    let bet = await fetchBet(playerPk, n);
    if (!bet) {
      const prior: any = await BetModel.findOne({ player: playerPk.toBase58(), nonce: n }).lean();
      if (prior && prior.status === "settled") {
        return res.json({
          status: "settled",
          alreadySettled: true,
          asset: prior.asset,
          won: prior.won,
          resultBit: prior.resultBit,
          resultLabel: label(prior.resultBit),
          payout: prior.won ? (prior.playerWinPayout ?? prior.payout) : "0",
          settleTx: prior.settleTx ?? null,
        });
      }
      for (let i = 0; i < 6 && !bet; i++) {
        await new Promise((r) => setTimeout(r, 800));
        bet = await fetchBet(playerPk, n);
      }
      if (!bet) {
        return res.status(409).json({
          error: "bet not visible on-chain yet — retry in a moment",
          retryable: true,
          player: playerPk.toBase58(),
          nonce: n,
        });
      }
    }
    if (!bet.player.equals(playerPk)) return res.status(400).json({ error: "player mismatch" });

    // Outcome authority removed: the program reads the stored randomness account and
    // computes win/loss on-chain. Reveal + settle ride in one tx so the value's
    // reveal_slot equals the slot settle_bet's get_value() reads.
    const isSol = bet.asset === ASSET_SOL;
    const settleIx = isSol ? buildSettleSolIx(bet) : buildSettleIx(bet);
    const settleTx = await revealAndSettle(bet.randomnessAccount, settleIx);

    // Recompute the outcome from the now-revealed value (result_bit = value[0] & 1).
    const resultBit = await resolveResultBit(bet.randomnessAccount);
    const won = resultBit !== null && resultBit === bet.choice;
    const actualPayout = won ? bet.playerWinPayout.toString() : "0";

    // Mirror to Mongo for history (never the source of truth). resultBit/won are
    // required by the schema, so they must be derived above before this upsert.
    await BetModel.updateOne(
      { player: playerPk.toBase58(), nonce: n },
      {
        $set: {
          player: playerPk.toBase58(),
          nonce: n,
          amount: bet.amount.toString(),
          payout: actualPayout,
          playerWinPayoutBps: bet.playerWinPayoutBps,
          playerWinPayout: bet.playerWinPayout.toString(),
          totalFeeAmount: bet.totalFeeAmount.toString(),
          teamFeeAmount: bet.teamFeeAmount.toString(),
          devFeeAmount: bet.devFeeAmount.toString(),
          burnFeeAmount: bet.burnFeeAmount.toString(),
          holderRewardsFeeAmount: bet.holderRewardsFeeAmount.toString(),
          totalWinLiability: bet.totalWinLiability.toString(),
          choice: bet.choice,
          asset: isSol ? "sol" : "token",
          clientSeedHex: bet.clientSeedHex,
          seedHashHex: bet.seedHashHex,
          seedEpoch: Number(bet.seedEpoch),
          resultBit: resultBit ?? -1,
          won,
          randomnessAccount: bet.randomnessAccount.toBase58(),
          settleTx,
          status: "settled",
        },
      },
      { upsert: true }
    );
    await PlayerModel.updateOne(
      { pubkey: playerPk.toBase58() },
      { $set: { lastClientSeedHex: bet.clientSeedHex, lastSeenAt: new Date() }, $inc: { betsSettled: 1 } },
      { upsert: true }
    );

    res.json({
      status: "settled",
      asset: isSol ? "sol" : "token",
      won,
      resultBit,
      resultLabel: label(resultBit),
      payout: actualPayout,
      playerWinPayoutBps: bet.playerWinPayoutBps,
      playerWinPayout: bet.playerWinPayout.toString(),
      totalFeeAmount: bet.totalFeeAmount.toString(),
      teamFeeAmount: bet.teamFeeAmount.toString(),
      devFeeAmount: bet.devFeeAmount.toString(),
      burnFeeAmount: bet.burnFeeAmount.toString(),
      holderRewardsFeeAmount: bet.holderRewardsFeeAmount.toString(),
      totalWinLiability: bet.totalWinLiability.toString(),
      settleTx,
    });
  } catch (e: any) {
    const logs = errLogs(e);
    console.error("[settle] failed:", e?.message ?? e);
    if (logs?.length) console.error("[settle] program logs:\n" + logs.join("\n"));
    // Surface the real program/Switchboard error (public on-chain info) instead of a
    // generic message, so the frontend and operator can see what actually failed.
    res.status(500).json({ error: e?.message ?? "settlement failed", logs });
  }
});

/**
 * Public, read-only feed of the latest settled bets for the frontend "Live Flips"
 * section. Exposes ONLY data that is already public on-chain — player pubkey,
 * nonce, choice, asset, amount, payout, win/loss, settle tx, and time — and never
 * the fairness seeds/hashes. Does not touch settlement; it only reads the history
 * mirror written by /settle above.
 *
 * The frontend polls this every few seconds, so we keep a tiny (~2s) in-memory
 * cache of the newest rows and serve slices of it. That collapses bursts of polls
 * into at most one DB query per cache window, and the query itself is lean +
 * projected. (A future SSE/WebSocket push could replace polling, but none exists
 * today — polling is the no-new-infra choice.)
 */
const RECENT_DEFAULT = 50;
const RECENT_MAX = 100;
const RECENT_CACHE_MS = 2000;
// Only public-on-chain fields; "-_id" drops Mongo's internal id from the payload.
const RECENT_PROJECTION = "player nonce choice asset amount payout playerWinPayoutBps playerWinPayout totalFeeAmount teamFeeAmount devFeeAmount burnFeeAmount holderRewardsFeeAmount totalWinLiability won settleTx createdAt -_id";

interface RecentBet {
  player: string;
  nonce: number;
  choice: number;
  asset: string;
  amount: string;
  payout: string;
  won: boolean;
  settleTx: string | null;
  createdAt: Date;
}

let recentCache: { at: number; data: RecentBet[] } | null = null;

/** Newest settled bets (up to RECENT_MAX), cached briefly to absorb polling. */
async function getRecentSettled(): Promise<RecentBet[]> {
  const now = Date.now();
  if (recentCache && now - recentCache.at < RECENT_CACHE_MS) return recentCache.data;
  const docs = (await BetModel.find({ status: "settled" })
    .sort({ createdAt: -1 })
    .limit(RECENT_MAX)
    .select(RECENT_PROJECTION)
    .lean()) as unknown as RecentBet[];
  recentCache = { at: now, data: docs };
  return docs;
}

betsRouter.get("/recent", async (req, res) => {
  try {
    const raw = Number(req.query.limit);
    const limit = Number.isFinite(raw)
      ? Math.min(Math.max(Math.trunc(raw), 1), RECENT_MAX)
      : RECENT_DEFAULT;
    const all = await getRecentSettled();
    res.json({ bets: all.slice(0, limit) });
  } catch (e: any) {
    res.status(500).json({ error: "request failed" });
  }
});

/** Best-effort refund of an expired, unsettled bet (program enforces the expiry). */
betsRouter.post("/refund", async (req, res) => {
  try {
    const { player, nonce } = req.body ?? {};
    const playerPk = parsePlayer(player);
    const n = Number(nonce);
    if (!Number.isInteger(n) || n < 0) return res.status(400).json({ error: "invalid nonce" });
    const bet = await fetchBet(playerPk, n);
    if (!bet) return res.status(404).json({ error: "bet not found (already settled or never placed)" });
    const refundIx = bet.asset === ASSET_SOL ? buildRefundSolIx(playerPk, n, bet.randomnessAccount) : buildRefundIx(playerPk, n, bet.randomnessAccount);
    const tx = await sendIxs([refundIx]);
    res.json({ refundTx: tx, asset: bet.asset === ASSET_SOL ? "sol" : "token" });
  } catch (e: any) {
    res.status(500).json({ error: "request failed" });
  }
});

/**
 * Rotate the fairness seed: reveal the old server seed (in DB) and push the new
 * commitment on-chain. MUST be protected — set ADMIN_API_TOKEN and send it as a
 * bearer token. Better still, run rotation from an internal CLI rather than a
 * public route.
 */
betsRouter.post("/admin/rotate-seed", async (_req, res) => {
  res.status(410).json({ error: "legacy server seed rotation is disabled for new verified-randomness bets" });
});
