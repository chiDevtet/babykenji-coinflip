import { Router } from "express";
import { PublicKey } from "@solana/web3.js";
import {
  fetchBet,
  buildSettleIx,
  buildRefundIx,
  buildSettleSolIx,
  buildRefundSolIx,
  sendIxs,
} from "../solana";
import { buildRevealIx } from "../switchboard";
import { BetModel } from "../models/Bet";
import { PlayerModel } from "../models/Player";

export const betsRouter = Router();

const ASSET_SOL = 1;

function parsePlayer(v: unknown): PublicKey {
  return new PublicKey(String(v)); // throws on invalid
}

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
    const playerPk = parsePlayer(player);
    const n = Number(nonce);
    if (!Number.isInteger(n) || n < 0) return res.status(400).json({ error: "invalid nonce" });

    // Source of truth: the on-chain bet. If it's gone, it was already settled/refunded.
    const bet = await fetchBet(playerPk, n);
    if (!bet) return res.status(404).json({ error: "bet not found (already settled or never placed)" });
    if (!bet.player.equals(playerPk)) return res.status(400).json({ error: "player mismatch" });

    // Outcome authority removed: the program reads the stored randomness account and computes win/loss on-chain.
    const isSol = bet.asset === ASSET_SOL;
    const settleIx = isSol ? buildSettleSolIx(playerPk, n, bet.randomnessAccount) : buildSettleIx(playerPk, n, bet.randomnessAccount);
    const revealIx = await buildRevealIx(bet.randomnessAccount);
    const settleTx = await sendIxs([revealIx, settleIx]);

    // Mirror to Mongo for history (never the source of truth).
    await BetModel.updateOne(
      { player: playerPk.toBase58(), nonce: n },
      {
        $set: {
          player: playerPk.toBase58(),
          nonce: n,
          amount: bet.amount.toString(),
          payout: bet.payout.toString(),
          choice: bet.choice,
          asset: isSol ? "sol" : "token",
          clientSeedHex: bet.clientSeedHex,
          seedHashHex: bet.seedHashHex,
          seedEpoch: Number(bet.seedEpoch),
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
      status: "submitted",
      asset: isSol ? "sol" : "token",
      payout: bet.payout.toString(),
      settleTx,
    });
  } catch (e: any) {
    res.status(500).json({ error: "settlement failed" });
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
const RECENT_PROJECTION = "player nonce choice asset amount payout won settleTx createdAt -_id";

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
