import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { config, settleAuthorityPubkey } from "./config";
import { connectDb } from "./db";
import { ensureActiveSeed } from "./seedManager";
import { fairnessRouter } from "./routes/fairness";
import { betsRouter } from "./routes/bets";

async function main() {
  await connectDb();
  const seed = await ensureActiveSeed();

  const app = express();

  // The app runs behind the forgepad.fun reverse proxy, which sets
  // X-Forwarded-For. express-rate-limit refuses to key on that header unless we
  // opt in, otherwise it aborts every /api request with
  // ERR_ERL_UNEXPECTED_X_FORWARDED_FOR. Trust exactly one proxy hop so the
  // client IP is derived from the last entry in X-Forwarded-For (the proxy's
  // recorded client), not spoofable by the caller. Must be set before the
  // rate limiter is registered.
  app.set("trust proxy", 1);

  app.use(express.json({ limit: "16kb" }));
  app.use(
    cors({
      origin: config.corsOrigins,
      methods: ["GET", "POST"],
    })
  );

  // Basic abuse protection on the settlement surface.
  app.use(
    "/api/bets",
    rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false })
  );

  app.get("/health", (_req, res) =>
    res.json({
      ok: true,
      settleAuthority: settleAuthorityPubkey.toBase58(),
      activeEpoch: seed.epoch,
      commitHashHex: seed.commitHashHex,
    })
  );

  app.use("/api/fairness", fairnessRouter);
  app.use("/api/bets", betsRouter);

  app.listen(config.port, () => {
    console.log(`[server] listening on :${config.port}`);
    console.log(`[server] settle authority: ${settleAuthorityPubkey.toBase58()}`);
    console.log(`[server] fund that address with a little SOL so it can pay settlement fees.`);
  });
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
