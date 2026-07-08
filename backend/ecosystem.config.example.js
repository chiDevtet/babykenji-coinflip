// Sample pm2 ecosystem for the backend + rewards distributor.
// Copy to ecosystem.config.js on the server, review every line, then start it
// YOURSELF (nothing in the repo starts pm2):
//   cd backend && npm ci && npm run build
//   pm2 start ecosystem.config.js
//
// Note the distributor runs with --execute here — remove that flag to run the
// daemon in observe-only (dry-run) mode, where it logs the plan every interval
// but never sends. Both apps load backend/.env via dotenv when pm2's cwd is
// backend/; the env blocks below only need overrides. Secrets (keypair paths,
// Mongo URI) belong in backend/.env on the server, never in this file.
module.exports = {
  apps: [
    {
      name: "baby-kenji-backend",
      script: "dist/index.js",
      time: true,
      autorestart: true,
      env: {
        NODE_ENV: "production",
        // PORT, MONGODB_URI, RPC_URL, PROGRAM_ID, TOKEN_MINT,
        // SWITCHBOARD_PROGRAM_ID, SWITCHBOARD_QUEUE,
        // SETTLE_AUTHORITY_KEYPAIR_PATH, CORS_ORIGINS, ...
      },
    },
    {
      name: "baby-kenji-rewards-distributor",
      script: "dist/rewards/distributorMain.js",
      args: "--daemon --execute", // drop --execute for a dry-run daemon
      time: true,
      autorestart: true,
      // The distributor is crash-safe: an unfinished cycle resumes on restart
      // and payouts are idempotent per recipient, so restarts cannot double-pay.
      max_restarts: 20,
      restart_delay: 30000,
      env: {
        NODE_ENV: "production",
        // MONGODB_URI: "mongodb://...",
        // RPC_URL: "https://...",
        // HELIUS_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=...", // holder scan
        // PROGRAM_ID: "DFmU9mwDbHkGRZ5J2f9zi59ZyDapaEv8qHhKsx8KpwAj",
        // TOKEN_MINT: "BABYKxGpoWQFFDBH7hf9Tdx8ZZPEguunENRwd3a1AZsf",
        // HOLDER_REWARDS_AUTHORITY_KEYPAIR_PATH: "/run/secrets/rewards-authority.json",
        // HOLDER_REWARDS_INTERVAL_MS: "3600000",
      },
    },
  ],
};
