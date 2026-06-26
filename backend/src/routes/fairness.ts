import { Router } from "express";
import { verify, commitHash } from "../fairness";
import { getActiveCommit, getRevealedSeed, getSeedForEpoch } from "../seedManager";
import { fetchConfig } from "../solana";

export const fairnessRouter = Router();

/** Current commitment. Cross-checks the DB active epoch against the on-chain hash. */
fairnessRouter.get("/commitment", async (_req, res) => {
  try {
    const active = await getActiveCommit();
    const onchain = await fetchConfig();
    res.json({
      legacy: true,
      warning: "Server-seed fairness is legacy and is not authoritative for new verified-randomness bets.",
      epoch: active.epoch,
      commitHashHex: active.commitHashHex,
      onchainSeedHashHex: onchain?.currentSeedHashHex ?? null,
      onchainSeedEpoch: onchain ? Number(onchain.seedEpoch) : null,
      inSync: onchain ? onchain.currentSeedHashHex === active.commitHashHex : null,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** Reveal a past epoch's server seed (only once it has been rotated out). */
fairnessRouter.get("/reveal/:epoch", async (req, res) => {
  const epoch = Number(req.params.epoch);
  if (!Number.isInteger(epoch) || epoch < 0) return res.status(400).json({ error: "invalid epoch" });
  const revealed = await getRevealedSeed(epoch);
  if (!revealed) return res.status(404).json({ error: "unknown epoch" });
  res.json({ legacy: true, warning: "Historical server-seed reveal only; not used for new bets.", ...revealed });
});

/**
 * Verify a bet. Accepts either an explicit serverSeedHex (e.g. a seed the user
 * already revealed) or an epoch whose seed has been revealed server-side.
 */
fairnessRouter.post("/verify", async (req, res) => {
  try {
    const { serverSeedHex, epoch, player, clientSeedHex, nonce, choice } = req.body ?? {};
    if (!player || !clientSeedHex || nonce === undefined || choice === undefined) {
      return res.status(400).json({ error: "player, clientSeedHex, nonce, choice are required" });
    }

    let seedHex = serverSeedHex as string | undefined;
    let committedHashHex: string;

    if (seedHex) {
      committedHashHex = commitHash(seedHex);
    } else {
      if (epoch === undefined) return res.status(400).json({ error: "provide serverSeedHex or a revealed epoch" });
      const seed = await getSeedForEpoch(Number(epoch));
      if (!seed.revealed) return res.status(409).json({ error: "epoch not yet revealed" });
      seedHex = seed.serverSeedHex;
      committedHashHex = seed.commitHashHex;
    }

    const result = verify(seedHex, committedHashHex, String(player), String(clientSeedHex), Number(nonce), Number(choice));
    res.json({ legacy: true, warning: "Historical verifier only; settled outcomes come from chain state for new bets.", ...result });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});
