# On-chain Anchor Deployment

## Current readiness answer

No: this repository is **not safe for mainnet** until the checklist gates pass. The on-chain program contains core SOL/token flip flows and Switchboard owner feature gating, but fee-recipient transfer/burn plumbing is implemented in the current code path, but launch remains gated on Anchor build/test and real Switchboard devnet smoke execution.

## Prerequisites and toolchain

```bash
anchor --version
solana --version
rustc --version
cargo --version
node --version
npm --version
solana config get
```

Install Solana CLI and AVM/Anchor if missing. Pin to the repo versions where possible; `program/Anchor.toml` declares Anchor `1.0.2`, while Cargo dependencies use Anchor crates `0.31.1`, so validate the exact compatible CLI before release.

```bash
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install 0.31.1
avm use 0.31.1
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
```

## Configure cluster and wallet

Devnet:

```bash
solana config set --url devnet
mkdir -p keys
solana-keygen new -o ./keys/deployer.json
export ANCHOR_PROVIDER_WALLET=$PWD/keys/deployer.json
export DEPLOYER_PUBKEY=$(solana-keygen pubkey ./keys/deployer.json)
solana airdrop 5 "$DEPLOYER_PUBKEY" --url devnet
```

Mainnet:

```bash
solana config set --url mainnet-beta
export ANCHOR_PROVIDER_WALLET=/secure/path/deployer-or-multisig.json
solana balance $(solana-keygen pubkey "$ANCHOR_PROVIDER_WALLET") --url mainnet-beta
```

## Program keypair and program id

```bash
cd program
anchor keys list
# If generating a fresh program id:
solana-keygen new -o target/deploy/forge_coinflip-keypair.json
anchor keys sync
```

After key sync, verify all three places match:

- `declare_id!("<PROGRAM_ID>")` in `program/programs/forge-coinflip/src/lib.rs`.
- `[programs.<cluster>] forge_coinflip = "<PROGRAM_ID>"` in `program/Anchor.toml`.
- Backend/frontend env `PROGRAM_ID` / `VITE_PROGRAM_ID`.

## Build and tests

Default/devnet build accepts the Switchboard devnet owner through `get_sb_program_id("devnet")`.

```bash
cd program/programs/forge-coinflip
cargo check
cargo clippy -- -D warnings
cd ../../
anchor build
anchor test
```

Mainnet feature build accepts the Switchboard mainnet owner. Mainnet deployment must not use a devnet queue.

```bash
solana config set --url mainnet-beta
cd program/programs/forge-coinflip
cargo check --features mainnet
cargo clippy --features mainnet -- -D warnings
cd ../../
anchor build -- --features mainnet
npx ts-node ../scripts/verify-mainnet-build.ts
```

The repo also exposes:

```bash
cd program
npm run program:build:devnet
npm run program:build:mainnet
npm run program:check:devnet
npm run program:check:mainnet
```

## Deploy

Devnet:

```bash
cd program
anchor deploy --provider.cluster devnet
solana program show <PROGRAM_ID> --url devnet
```

Mainnet:

```bash
cd program
anchor build -- --features mainnet
anchor deploy --provider.cluster mainnet-beta --provider.wallet /secure/path/deployer.json
solana program show <PROGRAM_ID> --url mainnet-beta
```

## Upgrade authority

```bash
solana program show <PROGRAM_ID>
solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority <UPGRADE_AUTHORITY_MULTISIG>
solana program show <PROGRAM_ID>
```

Mainnet upgrade authority should be multisig/cold. Do not leave it as a backend hot key.

## Initialize `GameConfig`

The Anchor instruction is `initialize_config(ctx, params)` and creates:

- `GameConfig` PDA: seeds `["config", <BABY_KENJI_MINT>]`.
- Token treasury vault: seeds `["vault", <GAME_CONFIG_PDA>]`.
- SOL vault: seeds `["sol_vault", <GAME_CONFIG_PDA>]`.

Required arguments/values:

| Field | Placeholder/default | Notes |
|---|---:|---|
| Admin wallet | `<ADMIN_WALLET>` | Signer; stored in config. |
| Baby Kenji mint | `<BABY_KENJI_MINT>` | Account passed as `mint`; config PDA seed. |
| Settle authority | `<SETTLE_AUTHORITY>` | Backend fee payer/crank pubkey. |
| Randomness authority | `<RANDOMNESS_AUTHORITY>` | Stored today; not enforced in current instruction contexts. |
| Switchboard queue | `<SWITCHBOARD_QUEUE>` | Not stored in current `GameConfig`; validate out-of-band and through frontend/backend env. |
| Token min/max bet | `<MIN_TOKEN_BET>` / `<MAX_TOKEN_BET>` | Base units. |
| SOL min/max bet | `<MIN_SOL_BET>` / `<MAX_SOL_BET>` | Lamports. |
| Total fee bps | `1000` | Program enforces max 1000. |
| SOL player win payout bps | `17800` | 1.78x gross win payout. |
| Token player win payout bps | `17800` | 1.78x gross win payout. |
| SOL fee split | `500 / 300 / 200` | Team/dev/holders calculated in Bet only. |
| Token fee split | `500 / 166 / 167 / 167` | Team/dev/burn/holders calculated in Bet only. |
| Payout cap | e.g. `2500` | Max 25% of treasury. |
| Settlement deadline | `1500` slots | Constant in program, not configurable. |
| Pause status | `false` at init | Update with `update_config`. |

Validation warnings:

- Reject payout bps + fee bps > `20_000`.
- Reject placeholders and system-program addresses for production.
- Reject wrong token mint or token accounts not owned by `<BABY_KENJI_MINT>`.
- Reject a devnet Switchboard queue or owner for mainnet.
- Verify theoretical vault edge: `10_000 - total_fee_bps - payout_bps / 2 = 100 bps` for defaults.

Existing scripts are lightweight validators/placeholders, not full transaction senders. Before production, implement or review a real `scripts/init-config.ts` that sends `initialize_config`; until then initialize with an Anchor script/test harness or CLI transaction builder.

```bash
export RPC_URL=<RPC_URL>
export PROGRAM_ID=<PROGRAM_ID>
export TOKEN_MINT=<BABY_KENJI_MINT>
export SWITCHBOARD_QUEUE=<SWITCHBOARD_QUEUE>
export SETTLE_AUTHORITY=<SETTLE_AUTHORITY>
export RANDOMNESS_AUTHORITY=<RANDOMNESS_AUTHORITY>
export TOTAL_FEE_BPS=1000
export SOL_PLAYER_WIN_PAYOUT_BPS=17800
export TOKEN_PLAYER_WIN_PAYOUT_BPS=17800
npx ts-node scripts/verify-env.ts
npx ts-node scripts/verify-config.ts
```

## Deposit bankroll

Token bankroll:

```bash
# Admin's Baby Kenji token account must hold deposit amount.
# Use the Anchor `deposit_treasury` instruction with admin, config PDA, treasury vault, admin token account.
```

SOL bankroll:

```bash
# Use Anchor `deposit_sol_treasury` with admin, config PDA, sol_vault PDA, system program.
```

## Verify deployment

```bash
solana program show <PROGRAM_ID> --url <RPC_URL>
spl-token account-info <TOKEN_TREASURY_VAULT> --url <RPC_URL>
solana account <SOL_VAULT_PDA> --url <RPC_URL>
cd backend && curl http://localhost:8787/health
```

Also run [`docs/POST_DEPLOY_VERIFICATION.md`](POST_DEPLOY_VERIFICATION.md).

## Mainnet go/no-go

Do not proceed unless every hard gate in [`MAINNET_RELEASE_CHECKLIST.md`](MAINNET_RELEASE_CHECKLIST.md) passes, including dependency audit disposition, real Switchboard devnet test, Anchor/Solana build/test, mainnet feature verification, fee routing/burn decision, migration plan, and external audit/risk acceptance.
