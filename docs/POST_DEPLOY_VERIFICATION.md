# Post-deploy Verification

Run after every devnet/mainnet deploy.

```bash
solana program show <PROGRAM_ID> --url <RPC_URL>
solana account <GAME_CONFIG_PDA> --url <RPC_URL>
spl-token account-info <TOKEN_TREASURY_VAULT> --url <RPC_URL>
solana account <SOL_VAULT_PDA> --url <RPC_URL>
curl <BACKEND_BASE_URL>/health
```

Checklist:

- [ ] Deployed program id equals `<PROGRAM_ID>` in Anchor/backend/frontend.
- [ ] Program data upgrade authority equals approved cold/multisig authority.
- [ ] `GameConfig.admin` equals `<ADMIN_WALLET>`.
- [ ] `GameConfig.settle_authority` equals backend settle pubkey.
- [ ] `GameConfig.token_mint` equals `<BABY_KENJI_MINT>`.
- [ ] `GameConfig.treasury_vault` equals derived vault PDA.
- [ ] `GameConfig.sol_vault` equals derived SOL vault PDA.
- [ ] Switchboard owner matches build feature: devnet for default, mainnet for `mainnet` feature.
- [ ] Switchboard queue equals approved `<SWITCHBOARD_QUEUE>`.
- [ ] Fee bps, payout bps, min/max bets, payout cap, and pause status are expected.
- [ ] SOL vault has rent reserve plus bankroll.
- [ ] Token vault has Baby Kenji bankroll and correct mint.
- [ ] Fee recipient wallets/accounts are correct, funded where required, and not placeholders.
- [ ] Backend health is green and settle authority is funded.
- [ ] Frontend displays live mode, not preview/demo mode.
- [ ] Execute a small SOL flip and verify place, reveal, settle, payout/refund behavior.
- [ ] Execute a small Baby Kenji flip and verify token transfer/payout behavior.
- [ ] Verify Mongo mirror row for each settled bet.
- [ ] Verify recent bets endpoint and frontend feed.
- [ ] Verify logs contain no private keys, seeds, Mongo passwords, or admin tokens.
- [ ] Verify admin withdrawable balance respects outstanding liabilities.
- [ ] Verify fee amounts emitted/mirrored, and that settlement transferred the team/dev/holder fee splits to their accounts and burned the token burn share (both happen on-chain in `settle_bet` / `settle_bet_sol`).
