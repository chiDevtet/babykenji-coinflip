# Monte Carlo Economic Simulator

This repository includes a deterministic local TypeScript Monte Carlo harness for the coin flip fee, liability, refund, burn, and bankroll model. It does **not** connect to mainnet, does not send transactions, and does not replace Anchor tests, Switchboard devnet integration tests, or an external audit.

## What it proves

- SOL and Baby Kenji flip accounting under integer-only `bigint` math.
- Total 10% fee calculation, 1.9x winning payout, and 2.0x worst-case liability for a 10% fee model.
- Fee routing for SOL: 5% team, 3% dev/buyback, 2% holder rewards.
- Fee routing for Baby Kenji: 5% team, 1.66% dev, 1.67% burn, 1.67% holder rewards.
- Rounding behavior: total fee is computed first, split floors are computed with bps, and all remainder goes to holder rewards so splits sum exactly.
- Open bet liability reservation, release on settlement, release on refund, and admin withdrawable safety.
- Refund behavior: original wager returned, no fees charged, no burn performed.
- Stress behavior across high concurrency, winning streaks, refund storms, dust attacks, whale pressure, mixed asset chaos, and rounding fuzz.

## What it does not prove

- It does not verify Anchor account constraints or Solana runtime behavior.
- It does not verify Switchboard randomness or devnet oracle integration.
- It does not validate real token account transfers, PDA signing, rent, compute units, or transaction ordering.
- It does not make the project mainnet-ready by itself.

Mainnet readiness still requires Anchor CLI and Solana CLI installation, Anchor build and tests, Switchboard devnet flow tests, backend and frontend checks, dependency risk review, and an external audit.

## Running

From `backend/`:

```bash
npm run monte-carlo -- --scenario baseline --iterations 100000 --seed 42
npm run monte-carlo -- --scenario high-concurrency --iterations 1000000 --concurrency 500 --seed 99
npm run monte-carlo -- --scenario max-win-streak --forced-streak wins --forced-streak-length 1000
npm run monte-carlo -- --scenario dust-attack --iterations 100000
npm run monte-carlo -- --scenario mixed-asset-chaos --iterations 1000000 --json
```

Convenience scripts:

```bash
npm run monte-carlo:sol
npm run monte-carlo:token
npm run monte-carlo:mixed
npm run monte-carlo:stress
npm run test:monte-carlo
```

CSV output:

```bash
npm run monte-carlo -- --scenario baseline --iterations 100000 --seed 42 --csv-out ./monte-carlo.csv
```

## CLI options

Supported options include `--seed`, `--iterations`, `--asset sol|token|mixed`, bankroll and min/max bet options, `--concurrency`, settlement delay bounds, `--refund-rate`, `--unresolved-rate`, `--win-rate`, `--bet-size-mode uniform|small|large|max|whale|mixed`, `--forced-streak none|wins|losses|alternating`, `--forced-streak-length`, `--runs`, `--json`, and `--csv-out <path>`.

Rates are basis points. The default win rate is `5000` (50%).

## Fee math relationship to on-chain math

The simulator intentionally mirrors the documented on-chain economic model with integer floor division:

- `totalFeeAmount = floor(amount * totalFeeBps / 10_000)`
- `playerWinPayout = floor(amount * (20_000 - totalFeeBps) / 10_000)`
- `totalWinLiability = playerWinPayout + totalFeeAmount`

The fee split computes the total fee first, floors team/dev/burn allocations with bps, and assigns all remaining units to holder rewards. Tiny wagers whose total fee is zero are rejected.

## Liability model

At placement the simulator transfers the wager into the vault and reserves worst-case liability. At settlement it releases liability, pays winners, routes fees, and closes the bet. At refund it releases liability, returns the original wager, charges no fees, burns nothing, and closes the bet.

Admin withdrawable balance is:

```text
max(0, houseVaultBalance - outstandingLiability - rentReserve)
```

This prevents open-bet reserves from being counted as withdrawable.

## Stress scenarios

Implemented scenarios:

1. `baseline`
2. `max-win-streak`
3. `max-loss-streak`
4. `high-concurrency`
5. `refund-storm`
6. `dust-attack`
7. `whale-pressure`
8. `mixed-asset-chaos`
9. `admin-withdrawal-pressure`
10. `rounding-fuzz`

Each report includes accepted/rejected bets, wins, losses, refunds, wagered amount, player payouts, routed fees, burns, holder rewards, ending vault, outstanding liability, max liability, min vault, drawdown, realized house edge, and invariant status.

## Interpreting realized house edge

Realized house edge is the current vault profit divided by total wagered for that asset. It can be negative during winning streaks, high refund rates, or small samples. It excludes off-chain market effects and does not model token price changes.

## Future devnet harness

`scripts/devnet-stress-harness.ts` is a documented placeholder for a future lower-volume real devnet harness. It is intentionally not wired into default scripts and must never be used for mainnet transaction sending.
