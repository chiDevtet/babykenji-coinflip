# Monte Carlo Economic Model

The simulator now models the standalone vault economics with external fee outflows.

Defaults:
- `totalFeeBps = 1000` (10%)
- `solPlayerWinPayoutBps = 17800` (1.78x)
- `tokenPlayerWinPayoutBps = 17800` (1.78x)

The old 1.9x payout with a separate 10% external fee made the vault negative EV: on wins the vault paid 1.9x to the player and 0.1x to fee recipients after receiving only 1.0x.

The correct theoretical vault edge at 50/50 odds is:

```text
vault_edge_bps = 10_000 - total_fee_bps - player_win_payout_bps / 2
```

Examples with 10% fees:
- 19000 payout bps (1.90x): -500 bps / -5% vault edge
- 18000 payout bps (1.80x): 0 bps / break-even vault edge
- 17800 payout bps (1.78x): +100 bps / +1% vault reserve edge
- 17600 payout bps (1.76x): +200 bps / +2% vault reserve edge

Open simulated bets snapshot payout bps, player payout, total fees, fee split, and total win liability. Refunds release the liability and return the full wager with no fees. Baby Kenji burns happen only at settlement; SOL burns are impossible.

Run examples:

```bash
cd backend && npm run test:monte-carlo
cd backend && npm run monte-carlo -- --scenario baseline --iterations 100000 --seed 42
cd backend && npm run monte-carlo -- --compare-payouts --iterations 100000 --seed 42
```

Monte Carlo validates economic behavior, but it does not replace Anchor/Switchboard integration tests or an external audit.
