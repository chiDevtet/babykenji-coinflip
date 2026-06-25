import { Router } from "express";
import { PublicKey } from "@solana/web3.js";
import { deriveResultBit, commitHash, HEADS } from "../fairness";
import { getSeedForEpoch, rotate } from "../seedManager";
import {
  fetchBet,
  buildSettleIx,
  buildRefundIx,
  buildSettleSolIx,
  buildRefundSolIx,
  buildRotateSeedIx,
  sendIxs,
} from "../solana";
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

    // Resolve the seed for the epoch the bet was placed under.
    const seed = await getSeedForEpoch(Number(bet.seedEpoch));
    if (commitHash(seed.serverSeedHex) !== bet.seedHashHex) {
      return res.status(409).json({ error: "seed/commitment desync for bet epoch" });
    }

    const bit = deriveResultBit(seed.serverSeedHex, playerPk.toBase58(), bet.clientSeedHex, Number(bet.nonce));
    const won = bit === bet.choice;

    const isSol = bet.asset === ASSET_SOL;
    const settleIx = isSol ? buildSettleSolIx(playerPk, n, won) : buildSettleIx(playerPk, n, won);
    const settleTx = await sendIxs([settleIx]);

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
          resultBit: bit,
          won,
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
      won,
      resultBit: bit,
      resultLabel: bit === HEADS ? "heads" : "tails",
      asset: isSol ? "sol" : "token",
      payout: bet.payout.toString(),
      settleTx,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
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
    const refundIx = bet.asset === ASSET_SOL ? buildRefundSolIx(playerPk, n) : buildRefundIx(playerPk, n);
    const tx = await sendIxs([refundIx]);
    res.json({ refundTx: tx, asset: bet.asset === ASSET_SOL ? "sol" : "token" });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Rotate the fairness seed: reveal the old server seed (in DB) and push the new
 * commitment on-chain. MUST be protected — set ADMIN_API_TOKEN and send it as a
 * bearer token. Better still, run rotation from an internal CLI rather than a
 * public route.
 */
betsRouter.post("/admin/rotate-seed", async (req, res) => {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const expected = process.env.ADMIN_API_TOKEN;
  if (!expected || token !== expected) return res.status(401).json({ error: "unauthorized" });
  try {
    const r = await rotate();
    const newHash = Buffer.from(r.newCommitHashHex, "hex");
    const tx = await sendIxs([buildRotateSeedIx(newHash)]);
    res.json({
      revealedEpoch: r.revealedEpoch,
      newEpoch: r.newEpoch,
      newCommitHashHex: r.newCommitHashHex,
      rotateTx: tx,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});
