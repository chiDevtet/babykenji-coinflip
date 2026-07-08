# Baby Kenji Coin Flip

Solana/Anchor coin flip game with Switchboard On-Demand randomness, SOL wagers, Baby Kenji SPL-token wagers, backend settlement/crank services, frontend dApp, holder rewards primitives, fee distribution modeling, and Monte Carlo simulation.

## Launch-readiness status

**Not safe for mainnet today.** The repository contains the core on-chain and app components, but production launch remains blocked until the gates in [`docs/MAINNET_RELEASE_CHECKLIST.md`](docs/MAINNET_RELEASE_CHECKLIST.md) are completed and independently verified.

Known blockers include missing toolchains in some environments, required Anchor/Solana build/test passes, real Switchboard devnet integration, dependency audit resolution/acceptance, breaking on-chain account layout changes for `GameConfig` and `Bet`, no account-realloc migration, and incomplete on-chain external fee transfer/burn plumbing.

## Deployment and operations docs

Read these in order for a new deployment:

1. [`docs/WALLET_AND_ACCOUNT_MATRIX.md`](docs/WALLET_AND_ACCOUNT_MATRIX.md) — every wallet, PDA, token account, hot key, cold key, and funding requirement.
2. [`docs/ENVIRONMENT_VARIABLES.md`](docs/ENVIRONMENT_VARIABLES.md) — master env-var reference for program scripts, backend, frontend, rewards, and validation.
3. [`docs/DEPLOY_ONCHAIN.md`](docs/DEPLOY_ONCHAIN.md) — Anchor deploy, feature-gated Switchboard owner builds, config init, bankroll deposits, and tests.
4. [`docs/DEVNET_RUNBOOK.md`](docs/DEVNET_RUNBOOK.md) — end-to-end devnet runbook from wallets through test flips.
5. [`docs/BACKEND_SETUP.md`](docs/BACKEND_SETUP.md) — API/crank service, MongoDB, CORS, settlement, rewards worker primitives, PM2/systemd.
6. [`docs/FRONTEND_SETUP.md`](docs/FRONTEND_SETUP.md) — Vite dApp setup, public env vars, static hosting, wallet adapter notes.
7. [`docs/POST_DEPLOY_VERIFICATION.md`](docs/POST_DEPLOY_VERIFICATION.md) — post-deploy checks and smoke flips.
8. [`docs/OPERATOR_RUNBOOK.md`](docs/OPERATOR_RUNBOOK.md) — ongoing operations, pause/unpause, retries, incidents, key rotation.
9. [`docs/MIGRATION_NOTES.md`](docs/MIGRATION_NOTES.md) — breaking account layout changes and migration constraints.
10. [`docs/MAINNET_RELEASE_CHECKLIST.md`](docs/MAINNET_RELEASE_CHECKLIST.md) — hard mainnet gates.
11. [`docs/ROLLOUT_RUNBOOK.md`](docs/ROLLOUT_RUNBOOK.md) — wager-limit fix, holder-rewards distributor, and admin dashboard rollout + manual test checklist.

Related existing references:

- [`FEE_DISTRIBUTION.md`](FEE_DISTRIBUTION.md)
- [`HOLDER_REWARDS.md`](HOLDER_REWARDS.md)
- [`MONTE_CARLO.md`](MONTE_CARLO.md)
- [`SECURITY_REMEDIATION.md`](SECURITY_REMEDIATION.md)
- [`SECURITY_DEPENDENCY_TRIAGE.md`](SECURITY_DEPENDENCY_TRIAGE.md)
- [`TOOLCHAIN.md`](TOOLCHAIN.md)

## Useful commands

```bash
cd backend && npm run typecheck && npm test
cd frontend && npm run typecheck && npm test
cd program/programs/forge-coinflip && cargo check && cargo check --features mainnet
cd program && anchor build && anchor test
```
