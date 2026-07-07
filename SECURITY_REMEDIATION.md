# Security Remediation Notes

The payout model now uses configurable player win payout bps instead of deriving payouts from external fee bps. Defaults are 1.78x for both SOL and Baby Kenji flips with a 10% external fee.

Security answers:
1. Backend cannot change payout bps for an already-open bet; the bet account/simulator bet snapshots payout bps and amounts.
2. Admin config updates affect new bets only.
3. Players cannot force the old 1.9x production path; code paths no longer derive payout as `20_000 - fee_bps`.
4. Cranks cannot alter payout bps during settlement; settlement uses the bet snapshot.
5. Settlement must not recompute payout from current config.
6. Payout bps plus fee bps is validated not to exceed 20000.
7. Default config has theoretical +1% vault edge.
8. Admin cannot configure negative-EV economics above the validated max.
9. Liability reserves player payout plus total fees.
10. Refunds charge no fees.
11. Fee splits sum exactly in simulator tests.
12. Burn happens only for Baby Kenji token settlements in the simulator.
13. SOL burn remains impossible.
14. Monte Carlo defaults converge around +1% over large runs.
15. The 1.9x comparison clearly reports -5% theoretical vault edge.

Account-size migration note: adding payout/fee snapshot fields changes Anchor account layouts for `GameConfig` and `Bet`. Existing deployed accounts would require a planned migration/re-initialization before mainnet use.
