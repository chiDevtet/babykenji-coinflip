# Operator Runbook

## Start/restart backend

```bash
cd backend && npm run build && NODE_ENV=production npm start
pm2 restart baby-kenji-backend
journalctl -u baby-kenji-backend -f
```

## Holder rewards

Preview/create-cycle primitives exist in `backend/src/rewards/worker.ts`; production scanning/sending is incomplete.

```bash
# After env and holders input implementation are ready:
npx ts-node scripts/preview-holder-rewards-cycle.ts
npx ts-node scripts/run-holder-rewards-cycle.ts
```

Manual cycle procedure once sender exists:

1. Snapshot eligible holders.
2. Confirm excluded wallets.
3. Preview payouts and dust.
4. Create idempotent cycle.
5. Send batches.
6. Mark signatures sent.
7. Retry failed payouts.
8. Reconcile source account and Mongo.

## Settlement/refunds

- Normal settlement: frontend calls `POST /api/bets/settle`.
- Manual settlement: `curl -X POST <BACKEND>/api/bets/settle -H 'content-type: application/json' -d '{"player":"<PLAYER>","nonce":0}'`.
- Refund expired: `curl -X POST <BACKEND>/api/bets/refund -H 'content-type: application/json' -d '{"player":"<PLAYER>","nonce":0}'`.

## Admin operations

Use Anchor/admin scripts or a reviewed transaction builder for:

- Pause/unpause: `update_config({ paused: true/false })`.
- Update fee config: `update_config({ fee_bps })`.
- Update payout bps: `update_config({ sol_player_win_payout_bps, token_player_win_payout_bps })`.
- Update min/max bets.
- Deposit token bankroll: `deposit_treasury`.
- Withdraw token bankroll: `withdraw_treasury` after liability check.
- Deposit SOL bankroll: `deposit_sol_treasury`.
- Withdraw SOL bankroll: `withdraw_sol_treasury` after rent/liability check.
- Propose/accept/cancel admin transfer.

## Emergency pause checklist

1. Submit `update_config({ paused: true })` from admin.
2. Verify frontend disables flips.
3. Verify new place-bet txs fail with `GamePaused`.
4. Keep settlement/refund operational for open bets if safe.
5. Announce incident and preserve logs.

## Incident response

| Incident | Immediate action | Follow-up |
|---|---|---|
| Backend down | Restart service; verify Mongo/RPC; keep frontend status updated. | Add monitoring and root-cause. |
| RPC down | Switch backend `RPC_URL`; redeploy frontend if `VITE_RPC_URL` impacted. | Review RPC failover/quotas. |
| Switchboard unavailable | Pause if new randomness cannot be committed/revealed. | Resume after devnet/mainnet queue health verified. |
| Settlement failures | Inspect backend logs and failed tx simulation; retry after cause fixed. | Refund expired bets if settlement impossible. |
| Holder rewards failure | Stop rewards process; do not retry blindly; use idempotency keys. | Reconcile Mongo/source accounts. |
| Suspected key compromise | Pause; rotate settle authority/admin as applicable; move funds if needed. | Postmortem and secret rotation. |
| Frontend misconfiguration | Disable deployment/rollback; verify env and build artifact. | Add preflight env validation. |
| Dependency vulnerability disclosure | Assess exploitability; patch or formally accept; redeploy. | Update security triage docs. |
