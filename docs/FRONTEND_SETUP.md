# Frontend Setup

The frontend is a Vite React dApp using wallet adapter, direct Anchor-style instruction builders, and Switchboard On-Demand SDK calls for per-bet randomness.

## Install and run

```bash
cd frontend
npm ci
cp .env.example .env
npm run dev
npm run typecheck
npm test
npm run build
npm run preview
```

## Vite environment variables

All `VITE_` values are public and embedded in the browser bundle. Never put private keys, API secrets, Mongo URLs, or admin tokens in frontend env.

| Name | Required? | Devnet placeholder | Mainnet placeholder | Public/private | Used by | Notes |
|---|---|---|---|---|---|---|
| `VITE_PROGRAM_ID` | Required for live mode | `<PROGRAM_ID>` | `<PROGRAM_ID>` | Public | PDA/ix builders | Must match deployed program/backend. |
| `VITE_BACKEND_URL` | Required | `http://localhost:8787` | `https://<API_DOMAIN>` | Public | API calls | Must allow CORS from app domain. |
| `VITE_RPC_URL` | Required | `https://api.devnet.solana.com` | `<PUBLIC_RPC_URL>` | Public | wallet/Switchboard | Use a public/rate-limited frontend RPC key. |
| `VITE_TOKEN_MINT` | Required for live token mode | `<BABY_KENJI_MINT>` | `<BABY_KENJI_MINT>` | Public | ATA/PDA derivation | Current code reads `VITE_TOKEN_MINT`; `VITE_BABY_KENJI_MINT` is an alias for docs only. |
| `VITE_BABY_KENJI_MINT` | Alias/documentation | `<BABY_KENJI_MINT>` | `<BABY_KENJI_MINT>` | Public | ops consistency | Keep equal to `VITE_TOKEN_MINT` if set. |
| `VITE_SWITCHBOARD_PROGRAM_ID` | Required for live flips | `<SWITCHBOARD_PROGRAM_ID>` | `<SWITCHBOARD_PROGRAM_ID>` | Public | Switchboard SDK | Must match cluster and program build feature. |
| `VITE_SWITCHBOARD_QUEUE` | Required for live flips | `<SWITCHBOARD_QUEUE>` | `<SWITCHBOARD_QUEUE>` | Public | Randomness create/commit | Do not use devnet queue in mainnet build. |
| `VITE_TOTAL_FEE_BPS` | Optional/display | `1000` | `1000` | Public | display/ops | Current UI fetches config; env is reference only. |
| `VITE_SOL_PLAYER_WIN_PAYOUT_BPS` | Optional/display | `17800` | `17800` | Public | display/ops | On-chain config is authoritative. |
| `VITE_TOKEN_PLAYER_WIN_PAYOUT_BPS` | Optional/display | `17800` | `17800` | Public | display/ops | On-chain config is authoritative. |
| `VITE_NETWORK` | Optional | `devnet` | `mainnet-beta` | Public | deployment metadata | Not currently consumed by code. |

## Production behavior

If `VITE_PROGRAM_ID` or `VITE_TOKEN_MINT` is missing/placeholder, the app enters preview/demo mode. Production deployments must fail closed operationally: verify env before build and do not ship demo mode to mainnet users.

```bash
cd frontend
VITE_PROGRAM_ID=<PROGRAM_ID> VITE_TOKEN_MINT=<BABY_KENJI_MINT> npm run build
```

## Wallet adapter notes

Users sign wager transactions in their own wallets. The backend never receives player private keys. SOL flips require SOL for wager and fees; Baby Kenji flips require a funded Baby Kenji ATA and SOL for transaction fees/rent.

## Deployment

Vercel/Netlify/static hosting:

```bash
cd frontend
npm ci
npm run build
# upload dist/ or set build command "npm run build" and output directory "dist"
```

Configure `VITE_BACKEND_URL`, `VITE_RPC_URL`, `VITE_PROGRAM_ID`, `VITE_TOKEN_MINT`, `VITE_SWITCHBOARD_PROGRAM_ID`, and `VITE_SWITCHBOARD_QUEUE` in the host dashboard.
