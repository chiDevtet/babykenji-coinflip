# Backend Setup

The backend is an Express API/crank service. It settles/refunds bets by reading Bet PDAs, submitting Switchboard reveal instructions, and sending program settlement/refund instructions. It also stores a MongoDB mirror and contains holder rewards primitives.

## Prerequisites

```bash
node --version
npm --version
cd backend && npm ci
```

## Environment variables

| Name | Required? | Devnet placeholder | Mainnet placeholder | Secret? | Used by | Security note |
|---|---|---|---|---|---|---|
| `NODE_ENV` | Optional | `development` | `production` | No | runtime | Use production in deployed service. |
| `PORT` | Optional | `8787` | `8787` | No | HTTP server | Restrict ingress to expected routes. |
| `MONGODB_URI` | Optional but required for nonlocal | `mongodb://127.0.0.1:27017/forge_coinflip` | `<MONGODB_URI>` | Yes if password | DB | Use TLS/backups/least privilege. |
| `RPC_URL` | Yes | `https://api.devnet.solana.com` | `<RPC_URL>` | Maybe | Solana connection | Backend RPC keys should not be public. |
| `HELIUS_RPC_URL` | Optional | `<HELIUS_RPC_URL>` | `<HELIUS_RPC_URL>` | Maybe | optional ops | Not used by current `config.ts`; supported as deployment convention only. |
| `HELIUS_API_KEY` | Optional | `<HELIUS_API_KEY>` | `<HELIUS_API_KEY>` | Yes | optional ops | Not used by current code unless future holder scanner uses it. |
| `PROGRAM_ID` | Yes | `<PROGRAM_ID>` | `<PROGRAM_ID>` | No | PDA derivation/ix builders | Must match deployed program. |
| `TOKEN_MINT` | Yes | `<BABY_KENJI_MINT>` | `<BABY_KENJI_MINT>` | No | PDA derivation/ATAs | Must match on-chain config. |
| `BABY_KENJI_MINT` | Alias/documentation | `<BABY_KENJI_MINT>` | `<BABY_KENJI_MINT>` | No | ops/docs | Current code reads `TOKEN_MINT`. Keep aliases consistent. |
| `SWITCHBOARD_PROGRAM_ID` | Yes | `<SWITCHBOARD_PROGRAM_ID>` | `<SWITCHBOARD_PROGRAM_ID>` | No | config validation/docs | Current backend loads Switchboard via SDK; still keep consistent. |
| `SWITCHBOARD_QUEUE` | Yes | `<SWITCHBOARD_QUEUE>` | `<SWITCHBOARD_QUEUE>` | No | frontend/backend randomness | Must match cluster. |
| `SETTLE_AUTHORITY_KEYPAIR_PATH` | Yes | `./keys/settle-authority.json` | `/run/secrets/settle-authority.json` | Yes | tx signer | Hot key; fund with limited SOL only. |
| `ADMIN_API_TOKEN` | Strongly required before exposing admin routes | `<ADMIN_API_TOKEN>` | `<ADMIN_API_TOKEN>` | Yes | admin protection | Current `/admin/rotate-seed` comment mentions bearer auth but enforcement is not wired; do not expose admin routes. |
| `CORS_ORIGINS` | Optional | `http://localhost:5173` | `https://<APP_DOMAIN>` | No | CORS | Comma-separated exact origins. |
| `TOTAL_FEE_BPS` | Optional | `1000` | `1000` | No | validation/display | Must match on-chain config. |
| `SOL_PLAYER_WIN_PAYOUT_BPS` | Optional | `17800` | `17800` | No | validation/display | Must satisfy plus fee <= 20000. |
| `TOKEN_PLAYER_WIN_PAYOUT_BPS` | Optional | `17800` | `17800` | No | validation/display | Must satisfy plus fee <= 20000. |
| `SOL_TEAM_WALLET` | Future/ops | `<TEAM_SOL_WALLET>` | `<TEAM_SOL_WALLET>` | No | fee docs/scripts | Current program does not route fees to it. |
| `SOL_DEV_BUYBACK_WALLET` | Future/ops | `<DEV_BUYBACK_SOL_WALLET>` | `<DEV_BUYBACK_SOL_WALLET>` | No | fee docs/scripts | Current program does not route fees to it. |
| `SOL_HOLDER_REWARDS_WALLET` | Future/ops | `<HOLDER_REWARDS_SOL_WALLET>` | `<HOLDER_REWARDS_SOL_WALLET>` | No/yes if signer | rewards | Current program does not route fees to it. |
| `TOKEN_TEAM_FEE_ACCOUNT` | Future/ops | `<TOKEN_TEAM_FEE_ACCOUNT>` | `<TOKEN_TEAM_FEE_ACCOUNT>` | No | fee docs/scripts | Must be Baby Kenji token account. |
| `TOKEN_DEV_FEE_ACCOUNT` | Future/ops | `<TOKEN_DEV_FEE_ACCOUNT>` | `<TOKEN_DEV_FEE_ACCOUNT>` | No | fee docs/scripts | Must be Baby Kenji token account. |
| `TOKEN_HOLDER_REWARDS_ACCOUNT` | Future/ops | `<TOKEN_HOLDER_REWARDS_ACCOUNT>` | `<TOKEN_HOLDER_REWARDS_ACCOUNT>` | No | rewards | Must be Baby Kenji token account. |
| `HOLDER_REWARDS_DISTRIBUTION_ENABLED` | Optional | `false` | `false` until worker complete | No | rewards ops | Worker currently creates DB cycles/payout rows; sender implementation is incomplete. |
| `HOLDER_REWARDS_AUTHORITY_KEYPAIR_PATH` | Required when sending rewards | `./keys/rewards-authority.json` | `/run/secrets/rewards-authority.json` | Yes | rewards | Needs SOL for SPL transfers/ATA creation. |
| `HOLDER_REWARDS_EXCLUDED_WALLETS` | Required for rewards | `<ADMIN_WALLET>,<TOKEN_TREASURY_VAULT>` | approved CSV | No | rewards | Exclude vaults/team/CEX/burn/system accounts. |
| `HOLDER_REWARDS_BATCH_SIZE` | Optional | `50` | `50` | No | rewards | Tune to tx limits. |
| `HOLDER_REWARDS_INTERVAL_MS` | Optional | `3600000` | approved cadence | No | rewards | No daemon loop exists yet. |

## Run locally

```bash
cd backend
cp .env.example .env
npm ci
npm run dev
curl http://localhost:8787/health
```

The health response includes `settleAuthority`; fund that pubkey with small SOL for transaction fees.

## Production build/run

```bash
cd backend
npm ci
npm run build
NODE_ENV=production npm start
```

PM2 example:

```bash
pm2 start dist/index.js --name baby-kenji-backend --time
pm2 logs baby-kenji-backend
pm2 restart baby-kenji-backend
```

Systemd example:

```ini
[Service]
WorkingDirectory=/srv/babylenji-coinflip/backend
EnvironmentFile=/srv/babylenji-coinflip/backend/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
User=babykenji
```

## Tests and simulator

```bash
cd backend
npm run typecheck
npm test
npm run test:monte-carlo
npm run monte-carlo:stress
```

## Settlement/crank process

The settlement surface is `POST /api/bets/settle` with `{ "player": "<PLAYER>", "nonce": 0 }`. The backend fetches the Bet PDA, reads the committed randomness account, builds a Switchboard reveal ix, then settles through `settle_bet` or `settle_bet_sol`. The client does not provide `won`, payout, fee recipients, or result bit.

## Holder rewards worker status

`backend/src/rewards/worker.ts` implements deterministic holder aggregation, pro-rata allocation, Mongo `RewardCycle` creation, Mongo `RewardPayout` creation, sent marking, and failed-payout retry state. It does **not** currently scan on-chain Baby Kenji holders, does **not** send SOL/SPL transfers, and does **not** run a production daemon. Treat holder rewards as primitives only until sender/scanner/idempotent transaction execution is implemented and tested.

## Security operations

- Keep `SETTLE_AUTHORITY_KEYPAIR_PATH` outside the repo with `0600` permissions.
- Do not reuse deployer/admin keypairs as backend hot keys.
- Rotate the settle key by updating on-chain config `settle_authority`, then replacing the secret file and restarting backend.
- Never expose admin endpoints until bearer-token enforcement is implemented and tested.
