# Fee Distribution and Payout Economics

Default production economics:
- Total external fee: 10% (`total_fee_bps = 1000`)
- Player win payout: 1.78x (`player_win_payout_bps = 17800`)
- SOL fees: 5% team, 3% dev/buyback, 2% holder rewards
- Baby Kenji fees: 5% team, 1.66% dev, 1.67% burn, 1.67% holder rewards

The old model derived the player payout from fees as `20_000 - total_fee_bps`, producing 1.9x at a 10% fee. That is wrong when fees are external vault outflows. A 1 SOL win would cost the vault 1.9 SOL payout plus 0.1 SOL fees, while the vault only received 1 SOL.

Correct vault edge formula at 50/50 odds:

```text
vault_edge_bps = 10_000 - total_fee_bps - player_win_payout_bps / 2
```

With 10% fees, 1.8x is break-even and 1.78x leaves an expected +1% vault bankroll cushion. Open bets snapshot payout economics, so later admin config changes only affect new bets. Refunds charge no fees.
