# Security remediation status

This branch removes the `won: bool` outcome parameter from settlement instruction data. Bets now store a committed `randomness_account`, `commit_slot`, and `settlement_deadline_slot`; settlement reads the stored randomness account, rejects substitutions, computes the coin-flip bit on-chain, releases liability once, and pays only the original player on wins.

## Important launch blocker

The current provider is a program-owned `Randomness` abstraction used to wire custody, settlement, refund, and test semantics without trusting the backend settle route. It is **not** a production randomness oracle. Before mainnet or a public beta, replace `create_randomness` / `reveal_randomness` with the official Switchboard SVM randomness account verification flow (or an equivalent audited oracle integration) so no hot key can select random bytes after seeing bets.

## Settlement flow

Before: backend read MongoDB server seed, derived a result, and called `settle_bet(..., won)` or `settle_bet_sol(..., won)`. The program trusted that boolean.

After: place-bet escrows the wager and stores the exact randomness account. A crank calls settlement with that same account. The program verifies readiness, computes `random_bytes[0] & 1`, compares it to `bet.choice`, releases reserved liability, and pays only if the computed bit wins. The backend can pay fees, but it no longer submits the result.

## Remaining trust assumptions / TODOs

- Integrate official Switchboard randomness verification before launch.
- Add exhaustive adversarial Anchor tests for fake oracle accounts, readiness, duplicate close behavior, and both SOL/token paths.
- Replace the temporary frontend randomness PDA selection with the real provider account creation/selection flow.
- Move production admin to a multisig (for example Squads) and keep crank/fee-payer keys separate from admin.
- Keep legacy server-seed fairness endpoints only for historical bets; new bets must use verified randomness.
