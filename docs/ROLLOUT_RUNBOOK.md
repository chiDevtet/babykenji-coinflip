# Rollout Runbook — Wager-Limit Fix, Rewards Distributor, Admin Dashboard

Covers the three changes on branch `claude/coin-flip-fees-burns-dashboard-havd5d`:

1. **Token max-wager fix** — the live on-chain `max_bet` is `1_000_000_000` base
   units (exactly 1.0 $BABYK at 9 decimals; a lamports-scale value pasted into
   the token field at init). `backend/scripts/update-wager-limits.ts` raises it
   to a 10M-token backstop so the 8% treasury cap governs, exactly like SOL.
2. **Holder-rewards distributor** — `backend/src/rewards/distributorMain.ts`
   pays the accumulated holder-rewards pots out pro-rata to holders with ≥2% of
   supply, threshold-triggered, dry-run by default, crash-safe/idempotent.
3. **Admin dashboard** — `#/admin` in the frontend + `/api/admin` in the
   backend: wallet-signature login against a Mongo allowlist, vault/P&L/pot
   stats, distribution-config editing, on-chain `update_config` built +
   simulated server-side and signed by the admin wallet, append-only audit log.

Live deployment facts (verified on mainnet during development):

| Thing | Value |
|---|---|
| Program | `DFmU9mwDbHkGRZ5J2f9zi59ZyDapaEv8qHhKsx8KpwAj` |
| Mint (9 decimals) | `BABYKxGpoWQFFDBH7hf9Tdx8ZZPEguunENRwd3a1AZsf` |
| GameConfig PDA | `CYsh9EY6fHC5EnmqiuMZacU7WRgeDduGSnQMutqRFqKU` |
| On-chain admin | `2j2NXDChymZ3tSiRMuLp8ea8CxSMGnX3qyBokqLzggT2` |
| Token holder-rewards ATA | `D5zQXDySYBNkx4yjXFLTGiSGYidZWsFFc42jqKaq6yNx` |
| SOL holder-rewards wallet | `6a5ofbztwrrFQe77Yw6mhxyQAVFjz2ZUms7QpcEvNZwh` |
| Known LP pool to exclude | `HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC` (Meteora) |

Per-flip fee routing needs **no change**: `settle_bet`/`settle_bet_sol` already
transfer team/dev/holder fees and burn the token burn share on every settle
(verified live: the token fee ATAs hold exactly 5% / 1.66% / 1.67% of lifetime
token volume).

## New environment variables (backend/.env)

| Name | Needed for | Notes |
|---|---|---|
| `ADMIN_SUPER_WALLET` | dashboard | Public key of the ONE super admin. Unset ⇒ `/api/admin` is fully disabled. |
| `HELIUS_RPC_URL` | distributor | Holder scan uses `getProgramAccounts`; most public RPCs reject it. |
| `HOLDER_REWARDS_AUTHORITY_KEYPAIR_PATH` | distributor `--execute` only | Keypair of the accumulation wallet (`6a5o…`): owner of the token rewards ATA AND the SOL rewards wallet. Never needed for dry runs. |
| `HOLDER_REWARDS_INTERVAL_MS` | distributor daemon | Default `3600000` (1h). |
| `HOLDER_REWARDS_FEE_BUFFER_LAMPORTS` | distributor | SOL held back for tx fees; default `5000000`. |

Everything else (thresholds, burn/holder split, 2% eligibility floor, excluded
wallets, per-asset kill switches) lives in MongoDB (`appconfigs` key
`distribution`) and is edited from the dashboard, not from env.

## Deployment steps (all run by the operator)

```bash
# 0. Pull the branch and install
git fetch origin claude/coin-flip-fees-burns-dashboard-havd5d
git checkout claude/coin-flip-fees-burns-dashboard-havd5d
cd backend && npm ci && npm run typecheck && npm test
cd ../frontend && npm ci && npm run typecheck && npm test

# 1. Fix the token max wager (one admin-signed update_config)
cd ../backend
#   dry run first — prints before/after math and simulates, sends nothing:
RPC_URL=<RPC> ADMIN_WALLET=2j2NXDChymZ3tSiRMuLp8ea8CxSMGnX3qyBokqLzggT2 npm run wager:limits
#   review the output, then execute with the admin keypair:
RPC_URL=<RPC> ADMIN_KEYPAIR_PATH=/path/to/admin.json npm run wager:limits:execute
#   the game UI picks the new MAX up on next config load — no frontend deploy needed for this step.

# 2. Backend + dashboard
#   add the new env vars to backend/.env (see table above), then:
npm run build
pm2 restart baby-kenji-backend        # or first time: pm2 start dist/index.js --name baby-kenji-backend --time

# 3. Frontend (adds the #/admin route)
cd ../frontend && npm run build       # deploy dist/ the same way as today

# 4. Dashboard first login + distribution config
#   open https://<APP>/#/admin with the ADMIN_SUPER_WALLET wallet, sign in,
#   then in the Distribution tab BEFORE anything else:
#     - add the Meteora pool HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC (and any
#       CEX/other pool wallets) to the excluded list
#     - review thresholds (defaults: 10,000 $BABYK / 0.05 SOL) and the 2% floor

# 5. Distributor — observe-only first
cd ../backend
npm run distributor                    # one-shot dry run; review the printed plan
#   run it as a dry-run daemon for a day if you want more confidence:
#   (copy ecosystem.config.example.js to ecosystem.config.js, review it,
#    and REMOVE --execute from the distributor args for observe-only)
pm2 start ecosystem.config.js --only baby-kenji-rewards-distributor
#   when satisfied, put --execute back in ecosystem.config.js and:
pm2 restart baby-kenji-rewards-distributor
pm2 logs baby-kenji-rewards-distributor
```

## Manual test checklist

Wager limits
- [ ] Dry run of `npm run wager:limits` shows BEFORE token MAX = 1 and AFTER = 8% treasury cap (≈159k $BABYK at current vault), simulation OK.
- [ ] After `--execute`: game UI token MAX shows the treasury-cap value, not 1.
- [ ] A token flip at the old max (1.0) still works; a flip just under the new MAX passes simulation.
- [ ] SOL MAX unchanged (still treasury-capped ≈0.025 SOL at current vault).
- [ ] Deposit to the token vault → MAX grows proportionally (8% cap scaling).

Distributor (dry-run)
- [ ] `npm run distributor` prints both pots, thresholds, and "below threshold" while pots are small.
- [ ] Excluded wallets (LP pool!) never appear in the printed recipient list.
- [ ] Temporarily lower a threshold in the dashboard → dry run prints a pro-rata plan for holders ≥2% of supply only → restore the threshold.

Distributor (execute — first live cycle)
- [ ] Fund check: accumulation wallet holds ≥0.01 SOL for fees.
- [ ] Run one-shot `npm run distributor:execute` when a pot is above threshold.
- [ ] Every recipient in the plan received the exact printed amount (spot-check 2–3 on Solscan).
- [ ] Mongo: `rewardcycles` has one `completed` cycle; every `rewardpayouts` row is `sent` with a signature.
- [ ] Kill the process mid-cycle on a test run → restart → it resumes pending payouts only, no double-pays (idempotency).
- [ ] Accumulation account keeps only dust + retained share afterwards.

Dashboard
- [ ] `/#/admin` with a non-allowlisted wallet: sign-in rejected ("not on the admin allowlist").
- [ ] Super admin signs in; Overview matches on-chain reality (vault balances vs Solscan, fee 10%, payout 1.78×).
- [ ] P&L table sums move after a test flip settles.
- [ ] Distribution save appears in the Audit tab with old → new values.
- [ ] On-chain tab: change fee by 1 bps → Build + simulate shows the diff and CU → sign with the admin wallet → confirm → Audit shows the tx signature with status `applied` → revert the fee the same way.
- [ ] Grant a second admin; that wallet can sign in and read but gets "super admin only" on grant/revoke; revoke it and confirm its session dies.
- [ ] Backend restart: dashboard sessions expire (re-login), nothing else lost.

Reconciliation (run after a few days of traffic)
- [ ] Token fee ATAs vs Mongo mirror: `sum(teamFeeAmount)` ≈ team ATA balance delta, same for dev/holder (per-flip routing intact).
- [ ] Mint supply decrease since launch ≥ `sum(burnFeeAmount)` in the mirror (other Forgepad burns also reduce supply).
- [ ] Dashboard "paid to holders" equals the sum of `sent` payout rows and matches on-chain transfers from the accumulation accounts.
- [ ] `GameConfig.outstanding_liability(_sol)` returns to 0 when no flips are in flight.

## Known operational notes

- Three expired unsettled SOL bets (0.0564 SOL reserved) predate this work and
  can be refunded any time via `POST /api/bets/refund` with the player/nonce
  from the open Bet PDAs.
- The on-chain admin, settle authority, and randomness authority are all
  `2j2NX…` and it single-signs treasury withdrawals — the multisig/cold-storage
  recommendation from `docs/WALLET_AND_ACCOUNT_MATRIX.md` still stands.
- ~0.019 SOL remains permanently stuck in the OLD closed program
  (`DmHi2MW2ibqqGMAgg3EtumHTaguKbydSnszAHiGUf3WA`) — unrecoverable.
- The repo's `declare_id!`/`Anchor.toml`/env examples now carry the live
  program id `DFmU…`; any future program upgrade must be built from this state.
