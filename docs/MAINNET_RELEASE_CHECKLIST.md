# Mainnet Release Checklist

Every unchecked item is a hard gate.

## Tooling

- [ ] Anchor CLI installed, pinned, and compatible with repo.
- [ ] Solana CLI installed and pinned.
- [ ] Rust/Cargo versions documented.
- [ ] Node/npm versions documented.

## Build/tests

- [ ] `cd program && anchor build` passes.
- [ ] `cd program && anchor test` passes.
- [ ] `cd program/programs/forge-coinflip && cargo check` passes.
- [ ] `cd program/programs/forge-coinflip && cargo check --features mainnet` passes.
- [ ] `cd program/programs/forge-coinflip && cargo clippy --features mainnet -- -D warnings` passes.
- [ ] `cd backend && npm run typecheck && npm test` passes.
- [ ] `cd frontend && npm run typecheck && npm test` passes.
- [ ] Monte Carlo baseline/stress passes.
- [ ] Real Switchboard devnet integration passes with tx evidence.

## Security

- [ ] Dependency audit fixed or formally risk accepted.
- [ ] External audit completed or explicitly waived.
- [ ] No production demo randomness.
- [ ] No server-seed path for new bets.
- [ ] No client-controlled `won`.
- [ ] No client-controlled payout/fee recipients.
- [ ] No placeholder wallets.
- [ ] Mainnet feature build verified.
- [ ] Mainnet Switchboard owner verified.
- [ ] Mainnet Switchboard queue verified.
- [ ] Admin API token enforcement implemented/tested before exposing admin routes.
- [ ] Production fee distribution decision made: implement on-chain external transfers/burn or formally accept manual/accounting-only process.

## Wallets

- [ ] Admin is multisig or risk accepted.
- [ ] Upgrade authority is multisig/cold or risk accepted.
- [ ] Backend settle authority funded with limited SOL.
- [ ] Holder rewards authority funded if sender is implemented.
- [ ] SOL vault funded.
- [ ] Token vault funded.
- [ ] Fee recipient wallets/accounts verified.
- [ ] Token accounts have correct Baby Kenji mint.
- [ ] Excluded wallets list configured.

## Economics

- [ ] Total fee bps = `1000` or approved value.
- [ ] Player payout bps = `17800` or approved value.
- [ ] Payout bps + fee bps <= `20000`.
- [ ] Fee splits sum exactly.
- [ ] Monte Carlo realized edge matches expectation.
- [ ] Max bet sized relative to bankroll.
- [ ] Outstanding liability checks verified.

## Deployment

- [ ] Program deployed.
- [ ] Program ID matches backend/frontend.
- [ ] Config initialized.
- [ ] Config verified.
- [ ] PDAs verified.
- [ ] Backend health endpoint green.
- [ ] Frontend displays correct network/config.
- [ ] First SOL test flip completed.
- [ ] First token test flip completed.
- [ ] Settlement verified.
- [ ] Fee routing/burn verified or production is blocked.

## Operational

- [ ] Monitoring/logging enabled.
- [ ] RPC failover plan documented.
- [ ] Incident pause process documented.
- [ ] Admin route protection verified.
- [ ] Backups configured.
- [ ] Secret rotation plan documented.

## Closed Program ID Recovery Checklist

- [ ] Old closed program id `DmHi2MW2ibqqGMAgg3EtumHTaguKbydSnszAHiGUf3WA` is not used in production config.
- [ ] Fresh program id `9pJDqDv13FwjWHWJDMB947nV2dH2JbYtdqWBN7kgvzEH` is synced in `declare_id!`, `program/Anchor.toml`, backend `PROGRAM_ID`, and frontend `VITE_PROGRAM_ID`.
- [ ] New `GameConfig`, SOL vault PDA, token treasury vault, PlayerState PDAs, and Bet PDAs are initialized/funded under the fresh program id.
- [ ] `npx ts-node scripts/verify-no-old-program-id.ts` passes; the old id appears only in migration/recovery notes.
- [ ] Devnet smoke passes before any mainnet deployment attempt.
