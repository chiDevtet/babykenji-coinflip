# Migration Notes

## Breaking account layout changes

`GameConfig` now includes/admin-tracks fields such as `pending_admin`, `randomness_authority`, SOL vault and SOL bet limits/liability, separate SOL/token payout bps, and additional accounting. `Bet` now stores payout bps, fee component amounts, total fee, total liability, asset discriminator, Switchboard randomness account, commit slot, and settlement deadline.

## Compatibility

Existing deployed `GameConfig` and `Bet` accounts created by older layouts are **not safely compatible** with the current decoders/instruction logic. No account `realloc` instruction or formal migration instruction is implemented in the program.

Existing deployed configs/bets must not be upgraded in place without a dedicated migration. Use a fresh deployment/re-initialization or implement a formal migration instruction.

## Devnet migration

1. Pause old deployment if possible.
2. Let open bets settle/refund on old program where possible.
3. Deploy fresh program id or reinitialize fresh accounts for the current mint.
4. Initialize new `GameConfig`.
5. Fund new token/SOL vaults.
6. Point backend/frontend env to new program/config.
7. Run full devnet smoke tests.

## Mainnet migration if anything is already deployed

1. Do not upgrade in place until account compatibility is audited.
2. Snapshot old config, vaults, open bets, liabilities, and balances.
3. Pause old config if instruction exists and works for old layout.
4. Settle or refund all open bets under old code before switching traffic.
5. Deploy fresh program/config or implement audited migration/realloc instructions.
6. Move bankroll only after liabilities are zero or explicitly reserved.
7. Publish migration announcement and verification txs.

## Open bets

Old open bets may not be settleable/refundable by the new code if the layout differs. They should be settled/refunded before upgrade, or handled by a dedicated migration/remediation plan. This is a breaking change.
