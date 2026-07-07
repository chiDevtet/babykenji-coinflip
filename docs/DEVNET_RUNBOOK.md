# Devnet Runbook

1. Install toolchain: `anchor --version`, `solana --version`, `cargo --version`, `node --version`, `npm --version`.
2. Create wallet: `solana-keygen new -o ./keys/deployer.json`; set `ANCHOR_PROVIDER_WALLET`.
3. Airdrop SOL: `solana airdrop 5 <DEPLOYER_PUBKEY> --url devnet`.
4. Create/select Baby Kenji devnet mint: `spl-token create-token --url devnet` or use `<BABY_KENJI_MINT>`.
5. Create token accounts: `spl-token create-account <BABY_KENJI_MINT> --url devnet` for admin/player/team/dev/rewards placeholders.
6. Configure Switchboard devnet queue: set `<SWITCHBOARD_QUEUE>` and `<SWITCHBOARD_PROGRAM_ID>` from approved devnet Switchboard On-Demand docs/examples.
7. Build: `cd program && anchor build`.
8. Test: `cd program && anchor test`.
9. Deploy: `cd program && anchor deploy --provider.cluster devnet`.
10. Initialize config using `initialize_config`; verify with `npx ts-node scripts/verify-config.ts` after env is set.
11. Fund token vault through `deposit_treasury`; admin token account must hold Baby Kenji.
12. Fund SOL vault through `deposit_sol_treasury`; admin wallet needs SOL.
13. Start MongoDB: `mongod --dbpath <LOCAL_DB_PATH>` or use Docker.
14. Start backend: `cd backend && cp .env.example .env && npm ci && npm run dev`.
15. Health check: `curl http://localhost:8787/health` should return `ok: true`.
16. Start frontend: `cd frontend && cp .env.example .env && npm ci && npm run dev`.
17. Place small SOL flip from browser wallet; expected: wallet signs create/commit randomness and `place_bet_sol`.
18. Settle SOL flip: frontend calls backend; expected backend returns `settleTx`.
19. Place Baby Kenji flip; player ATA must contain tokens.
20. Settle token flip; verify player token account gets win payout if won.
21. Verify fee accounting: Bet event and backend mirror show fee amounts. **Known limitation:** current program does not transfer fees externally or burn tokens.
22. Verify holder rewards accumulation: only DB/rewards primitives exist today; no on-chain fee accumulation to rewards account is wired.
23. Run Monte Carlo: `cd backend && npm run test:monte-carlo && npm run monte-carlo:stress`.
24. Run backend/frontend tests: `cd backend && npm run typecheck && npm test`; `cd frontend && npm run typecheck && npm test`.
25. Run real Switchboard devnet integration before mainnet: complete multiple place/reveal/settle flows against devnet queue and record tx signatures.

## Troubleshooting

- `InvalidRandomnessOwner`: program feature/cluster and Switchboard owner mismatch.
- `RandomnessExpired`: commit instruction too old; recreate randomness and place again quickly.
- `InsufficientTreasury`: vault cannot cover payout plus fee liability; deposit bankroll or reduce max bet.
- Frontend preview mode: `VITE_PROGRAM_ID` or `VITE_TOKEN_MINT` missing/placeholder.
- Backend fatal on startup: required env missing or settle keypair file absent.
