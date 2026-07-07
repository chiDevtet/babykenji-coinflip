# Environment Variables Master Reference

Variables that must match across components:

- Program ID: Anchor deploy, `PROGRAM_ID`, and `VITE_PROGRAM_ID`.
- Baby Kenji mint: on-chain config mint, `TOKEN_MINT`, `BABY_KENJI_MINT`, and `VITE_TOKEN_MINT`.
- Switchboard queue/program: on-chain feature/owner expectations, backend env, frontend env.
- Fee/payout bps: on-chain config is authoritative; backend/frontend display and validation should match.
- RPC cluster: backend and frontend must target the same cluster as the deployed program.

| Variable | Component | Devnet required | Mainnet required | Secret? | Example placeholder | Description | Validation rule |
|---|---|---:|---:|---|---|---|---|
| `ANCHOR_PROVIDER_WALLET` | program/deploy | Yes | Yes | Yes | `./keys/deployer.json` | Anchor signer wallet path. | File exists; funded; not backend key. |
| `ANCHOR_PROVIDER_URL` | program/deploy | Optional | Optional | Maybe | `<RPC_URL>` | Anchor RPC override. | Matches cluster. |
| `RPC_URL` | backend/scripts | Yes | Yes | Maybe | `<RPC_URL>` | Backend/script RPC. | URL present; expected cluster. |
| `PROGRAM_ID` | backend/scripts | Yes | Yes | No | `<PROGRAM_ID>` | Deployed program id. | Valid public key; not placeholder. |
| `VITE_PROGRAM_ID` | frontend | Yes | Yes | No | `<PROGRAM_ID>` | Public program id. | Equals `PROGRAM_ID`. |
| `TOKEN_MINT` | backend/scripts | Yes | Yes | No | `<BABY_KENJI_MINT>` | Baby Kenji SPL mint. | Valid public key; equals config mint. |
| `BABY_KENJI_MINT` | aliases/docs | Yes | Yes | No | `<BABY_KENJI_MINT>` | Human-readable alias. | Equal to `TOKEN_MINT` where used. |
| `VITE_TOKEN_MINT` | frontend | Yes | Yes | No | `<BABY_KENJI_MINT>` | Public token mint. | Equal to backend/on-chain mint. |
| `SWITCHBOARD_PROGRAM_ID` | backend/scripts | Yes | Yes | No | `<SWITCHBOARD_PROGRAM_ID>` | Switchboard On-Demand program. | Correct devnet/mainnet owner. |
| `VITE_SWITCHBOARD_PROGRAM_ID` | frontend | Yes | Yes | No | `<SWITCHBOARD_PROGRAM_ID>` | Public Switchboard program. | Matches cluster. |
| `SWITCHBOARD_QUEUE` | backend/scripts | Yes | Yes | No | `<SWITCHBOARD_QUEUE>` | Randomness queue. | Not devnet queue on mainnet. |
| `VITE_SWITCHBOARD_QUEUE` | frontend | Yes | Yes | No | `<SWITCHBOARD_QUEUE>` | Public queue. | Equals backend/approved queue. |
| `SETTLE_AUTHORITY_KEYPAIR_PATH` | backend | Yes | Yes | Yes | `./keys/settle-authority.json` | Hot key for settle/reveal/refund txs. | File exists; pubkey matches config. |
| `ADMIN_WALLET` | scripts/docs | Yes | Yes | No | `<ADMIN_WALLET>` | Config admin. | Multisig/cold for mainnet. |
| `PENDING_ADMIN_WALLET` | scripts/docs | Optional | Optional | No | `<PENDING_ADMIN_WALLET>` | Admin transfer target. | Valid public key. |
| `TOTAL_FEE_BPS` | backend/scripts/frontend display | Yes | Yes | No | `1000` | Total fee bps. | `0 < value <= 1000`. |
| `SOL_PLAYER_WIN_PAYOUT_BPS` | backend/scripts | Yes | Yes | No | `17800` | SOL win payout bps. | `+ TOTAL_FEE_BPS <= 20000`. |
| `TOKEN_PLAYER_WIN_PAYOUT_BPS` | backend/scripts | Yes | Yes | No | `17800` | Token win payout bps. | `+ TOTAL_FEE_BPS <= 20000`. |
| `SOL_TEAM_WALLET` | scripts/future fee routing | Yes | Yes | No | `<TEAM_SOL_WALLET>` | Intended SOL team recipient. | Valid public key; no placeholder. |
| `SOL_DEV_BUYBACK_WALLET` | scripts/future fee routing | Yes | Yes | No | `<DEV_BUYBACK_SOL_WALLET>` | Intended SOL dev/buyback recipient. | Valid public key. |
| `SOL_HOLDER_REWARDS_WALLET` | rewards | Yes | Yes | Maybe | `<HOLDER_REWARDS_SOL_WALLET>` | Intended SOL rewards source/receiver. | Valid public key; authority defined. |
| `TOKEN_TEAM_FEE_ACCOUNT` | scripts/future fee routing | Yes | Yes | No | `<TOKEN_TEAM_FEE_ACCOUNT>` | Intended token team account. | SPL token account with Baby Kenji mint. |
| `TOKEN_DEV_FEE_ACCOUNT` | scripts/future fee routing | Yes | Yes | No | `<TOKEN_DEV_FEE_ACCOUNT>` | Intended token dev account. | SPL token account with Baby Kenji mint. |
| `TOKEN_HOLDER_REWARDS_ACCOUNT` | rewards | Yes | Yes | No | `<TOKEN_HOLDER_REWARDS_ACCOUNT>` | Intended token rewards source/receiver. | SPL token account with Baby Kenji mint. |
| `MONGODB_URI` | backend | Optional local | Yes | Yes | `<MONGODB_URI>` | Mongo connection. | Reachable; TLS/protected in prod. |
| `PORT` | backend | Optional | Optional | No | `8787` | HTTP port. | Integer. |
| `CORS_ORIGINS` | backend | Optional | Yes | No | `https://<APP_DOMAIN>` | Allowed origins CSV. | Exact origins, no wildcard in prod. |
| `ADMIN_API_TOKEN` | backend/admin | Yes if admin routes exposed | Yes | Yes | `<ADMIN_API_TOKEN>` | Bearer token convention. | Must be enforced before exposure. |
| `VITE_BACKEND_URL` | frontend | Yes | Yes | No | `https://<API_DOMAIN>` | Backend base URL. | CORS/health OK. |
| `VITE_RPC_URL` | frontend | Yes | Yes | No | `<PUBLIC_RPC_URL>` | Browser RPC. | Public/rate limited. |
| `HOLDER_REWARDS_AUTHORITY_KEYPAIR_PATH` | rewards | If sending | If sending | Yes | `./keys/rewards-authority.json` | Rewards tx signer. | File exists; funded. |
| `HOLDER_REWARDS_EXCLUDED_WALLETS` | rewards | Yes | Yes | No | `<ADMIN_WALLET>,<TOKEN_TREASURY_VAULT>` | CSV exclusion list. | Valid public keys. |
| `HOLDER_REWARDS_BATCH_SIZE` | rewards | Optional | Optional | No | `50` | Batch size. | Positive integer. |
| `HOLDER_REWARDS_INTERVAL_MS` | rewards | Optional | Optional | No | `3600000` | Future daemon interval. | Positive integer. |
