# Today Launch Runbook

## Launch mode
Safe MVP: holder rewards are `accumulate_only` by default. On-chain settlement routes SOL rewards to `SOL_HOLDER_REWARDS_WALLET` and Baby Kenji rewards to `TOKEN_HOLDER_REWARDS_ACCOUNT`; automatic holder distribution is not live and must not be marketed.

## Fresh deployment decision
Use a fresh deployment/fresh config. Existing dev/test GameConfig and Bet layouts are incompatible and must be abandoned or migrated by a dedicated migration before handling real funds.

## Commands
```bash
./scripts/install-release-toolchain.sh
cd program && anchor build
cd program && anchor test
cd program/programs/forge-coinflip && cargo check --features mainnet
cd ../../.. && npm --prefix backend run typecheck && npm --prefix backend test && npm --prefix backend run test:monte-carlo
npm --prefix frontend run typecheck && npm --prefix frontend test
npx ts-node scripts/verify-env.ts
npx ts-node scripts/verify-config.ts
npx ts-node scripts/verify-fee-accounts.ts
npx ts-node scripts/devnet-smoke-test.ts
cd program && anchor build -- --features mainnet
solana config set --url mainnet-beta
anchor deploy --provider.cluster mainnet
npx ts-node scripts/init-config.ts
npx ts-node scripts/verify-fee-accounts.ts
# fund vaults with deposit_treasury and deposit_sol_treasury via the operator script/Anchor CLI
npm --prefix backend start
npm --prefix frontend run build
# first flips: run tiny SOL flip, tiny Baby Kenji flip, settle both, then verify:
npx ts-node scripts/print-holder-rewards-balances.ts
npx ts-node scripts/verify-fee-accounts.ts
# emergency pause:
# invoke update_config with paused=true using admin key; stop backend crank immediately.
```

## GO/NO-GO
- GO only if Anchor build/test, cargo mainnet check, backend/frontend tests, npm audits or formal acceptance, and real devnet Switchboard smoke pass.
- NO-GO remaining in this environment: Anchor CLI missing, Solana CLI missing, Anchor build/test not executed, real Switchboard devnet smoke not executed.
