# Transaction / Simulation Audit — why Phantom flags the flip, and what actually fixes it

Scope: how the coin-flip moves SOL, what a wallet simulator (Phantom via
Blowfish) reads as risky, and the concrete changes ranked by whether they
actually cause the warning vs. are nice-to-haves.

TL;DR — **the on-chain escrow design is already correct** (both wager paths use
program-owned PDA vaults, not a raw house wallet). The warning is driven mostly
by (1) the program being an **unverified build** and (2) the signed `place_bet`
transaction being a **net SOL outflow with no same-tx return** (the payout is a
separate backend transaction), in a **gambling** context on a **fresh domain**.
The fixes are: verify + register the build (`docs/VERIFIED_BUILD.md`), publish
the IDL, and submit the domain to Blowfish/Phantom for false-positive review.

---

## 1. Where SOL moves (traced)

### SOL wager path

| Step | Instruction | Signer | SOL movement | Code |
|---|---|---|---|---|
| Bet | `place_bet_sol` | **player** | player → `sol_vault` PDA (System transfer), amount = wager. Player also pays rent for the `bet` (and first-time `player_state`) PDAs. | `lib.rs:643` handler; System transfer `lib.rs:694-703` |
| Settle (win) | `settle_bet_sol` | backend `settle_authority` (permissionless `caller`) | `sol_vault` → player = payout; `sol_vault` → team/dev/holder EOAs = fees; `bet` PDA closed → rent back to player | payout `lib.rs:816-821`; fees `lib.rs:829-843`; `close = player` `lib.rs:1478` |
| Settle (loss) | `settle_bet_sol` | backend | `sol_vault` keeps wager; pays fees to EOAs; `bet` rent back to player | same |
| Refund (expired) | `refund_expired_bet_sol` | permissionless | `sol_vault` → player = wager; rent back to player | `lib.rs:900-905` |

Escrow: `sol_vault` is `seeds = ["sol_vault", config]`, a **program-owned PDA**
(`lib.rs:1463`, `SolVault` struct `lib.rs:1176`). Deposits are System transfers
in; payouts debit the PDA's lamports directly (the program owns it) and always
preserve the rent reserve (`transfer_lamports_preserving_rent`, `lib.rs:1075`).

### Token wager path (parallel)

`place_bet` pulls the wager into `treasury_vault` (PDA-owned SPL token account,
`token::authority = config`, `lib.rs:1241-1242`); `settle_bet` pays the player,
routes SPL fees, and burns the burn-fee via CPIs signed by the config PDA
(`lib.rs:458-517`).

### What the player actually signs (the simulated tx)

The backend `/prepare` route bundles **three** instructions into the one
transaction the wallet signs (`backend/src/routes/bets.ts:143`):
`create_randomness` + `commit_randomness` (Switchboard On-Demand) + `place_bet_sol`.
Signers: **player (feePayer)** + settle authority + ephemeral randomness keypair
= 3 signatures. The settle authority — not the player — pays the randomness
account rent (`backend/src/switchboard.ts`; `backend/src/routes/bets.ts:147`).

---

## 2. What a simulator reads as risky (findings)

### Ranked by whether they ACTUALLY cause the Phantom/Blowfish warning

| # | Finding | Real cause of the warning? | Why |
|---|---|---|---|
| F1 | **Program is an unverified build** — no source identity, no on-chain IDL. | **YES — primary.** | Blowfish/Phantom treat an unknown program that moves native SOL as opaque + higher-risk. Verifying attaches identity; publishing the IDL labels the instruction. |
| F2 | **Signed `place_bet_sol` is a net SOL outflow with no same-tx return.** | **YES — primary.** | The wallet only simulates the bet tx. The payout is a *separate* backend `settle_bet_sol` tx, so simulation shows "you send SOL, receive nothing." For an unknown program + gambling, that reads as high-risk. Inherent to commit-reveal; mitigated by verification/labeling + off-chain review, not by moving funds. |
| F3 | **Fresh dApp domain not on Blowfish's allowlist**, gambling category. | **YES — contributing.** | Blowfish scores domains. A new betting domain warns until reviewed. Off-chain submission (§5). |
| F4 | **Transaction arrives partially pre-signed** (settle authority + randomness keypair already signed) and spans 2 non-System programs (Switchboard + forge). | **Minor — contributing.** | Some simulators surface "additional signers"/complex multi-program txs. Inherent to the atomic create+commit+bet design; not worth changing. |
| F5 | Fees in `settle_bet_sol` go to **plain EOA wallets** (team/dev/holder). | **No** (not user-facing). | Only in the backend-signed settle tx, which the player's wallet never simulates. Constraints are tight (`address = bet.fee_*_recipient`, `lib.rs:1491-1498`). |
| F6 | `settle`/`refund` **close the `bet` PDA** and send lamports to `player`. | **No.** | `close = player` with `has_one = player` (`lib.rs:1478-1480`) — recipient is constrained to the bet's own player; not an arbitrary drain. |

### Account-constraint review (the "loose constraints" checklist)

Checked every account context for signer / owner / PDA-seed / recipient
constraints. Result: **tight, no gaps that would let funds leave to an
unexpected recipient.**

- Signers enforced where required: `player` on place (`lib.rs:1443`), `admin`
  with `has_one = admin` on deposit/withdraw/update (`lib.rs:1422-1436`,
  `1301`), `pending_admin` on accept (`lib.rs:1275`).
- Vaults pinned by PDA seeds + bump: `sol_vault` (`lib.rs:1463`), `treasury_vault`
  by seeds at init and by `== config.treasury_vault` on use (`lib.rs:1336`).
- Fee recipients pinned to the **snapshot on the bet**, not caller-supplied:
  SOL via `address = bet.fee_*_recipient` (`lib.rs:1491-1498`), token via
  `key() == bet.fee_*_recipient` (`lib.rs:1376-1381`).
- Randomness account owner-checked against the Switchboard program id in the
  handler and seed-slot-matched to the bet (`lib.rs:978-1008`, `1015-1024`).
- Payout/refund recipients constrained to `bet.player` (`has_one = player`).
- No instruction changes an account's authority to an arbitrary key or closes an
  account to an unexpected recipient. Admin transfer is a two-step
  propose/accept with the new admin signing (`lib.rs:186-201`).

The only asymmetry worth noting: the token `PlaceBet` context asserts
`treasury_vault.key() == config.treasury_vault` explicitly (`lib.rs:1336`),
while the SOL contexts rely on the `["sol_vault", config]` **seeds + bump** to
pin the vault (equally safe, just implicit). See the optional diff in §3.

---

## 3. Concrete changes (diffs)

### 3a. Route bets through an escrow PDA — ALREADY DONE (no diff)

The headline Part-B recommendation is already implemented. Evidence:

```rust
// program/programs/forge-coinflip/src/lib.rs:694  (place_bet_sol)
system_transfer(
    CpiContext::new(
        ctx.accounts.system_program.to_account_info(),
        SystemTransfer {
            from: ctx.accounts.player.to_account_info(),
            to: ctx.accounts.sol_vault.to_account_info(),   // <- program-owned PDA, not a wallet
        },
    ),
    amount,
)?;
```
```rust
// program/programs/forge-coinflip/src/lib.rs:1463  (PlaceBetSol accounts)
#[account(mut, seeds = [b"sol_vault", config.key().as_ref()], bump = sol_vault.bump)]
pub sol_vault: Box<Account<'info, SolVault>>,
```

No change needed. If you were told to "route through an escrow PDA instead of a
raw wallet," it's done.

### 3b. (Optional, next upgrade) Make the SOL-vault constraint explicit

Purely for auditor/reader legibility and symmetry with the token path — the
seeds already pin the account, so this is defense-in-depth, **not** a fix for the
warning. Apply it in your *next* planned upgrade (any on-chain change means a
redeploy + re-verify at the new commit). Not applied to the source here so the
current repo state keeps reproducing the deployed bytecode.

```diff
--- a/program/programs/forge-coinflip/src/lib.rs
+++ b/program/programs/forge-coinflip/src/lib.rs
@@ PlaceBetSol
-    #[account(mut, seeds = [b"sol_vault", config.key().as_ref()], bump = sol_vault.bump)]
+    #[account(
+        mut,
+        seeds = [b"sol_vault", config.key().as_ref()],
+        bump = sol_vault.bump,
+        constraint = sol_vault.key() == config.sol_vault @ CoinflipError::WrongVault
+    )]
     pub sol_vault: Box<Account<'info, SolVault>>,
```
(The same one-liner can be added to `SettleBetSol`, `RefundExpiredBetSol`,
`DepositSolTreasury`, and `WithdrawSolTreasury` for consistency.)

### 3c. Publish the IDL on-chain (biggest legibility win after verifying)

Not a source diff — a deploy action. Lets explorers/wallets show
`place_bet_sol` and labelled accounts instead of opaque bytes:

```bash
anchor idl init --provider.cluster mainnet \
  --filepath program/target/idl/forge_coinflip.json \
  DFmU9mwDbHkGRZ5J2f9zi59ZyDapaEv8qHhKsx8KpwAj
```

### 3d. Frontend: no raw house-wallet transfer (verified — no diff)

`frontend/src/lib/anchorIx.ts:231` (`buildPlaceBetSolIx`) sends the wager to
`solVaultPda(cfg)`, never to a plain wallet. There is no stray
`SystemProgram.transfer` to a house EOA in the bet path. Nothing to change.

---

## 4. Local simulation — the exact pre/post balances the wallet sees

Two harnesses are included:

- `program/scripts/simulate-sol-flip.mjs` — pure math, **runs today** (no
  validator/toolchain). Reproduces rent from the on-chain struct sizes.
- `program/scripts/sol-flip-simulation.bankrun.ts` — `solana-bankrun`, runs the
  **real bytecode** and prints balances (needs `anchor build -- --features
  mainnet` + `npm i -D solana-bankrun anchor-bankrun`; the settle side needs a
  live Switchboard oracle so it is documented, not forged). Kept under `scripts/`
  so it stays out of the `anchor test` glob.

Output of the math simulator for a **0.1 SOL** first-time bet
(`node program/scripts/simulate-sol-flip.mjs 0.1 17800 1000`):

```
TX 1 — place_bet_sol   (FIRST bet: PlayerState is created)   <-- WHAT THE WALLET SIMULATES
  player (signer)         wager + rent + fee     -0.1049566 SOL
  sol_vault PDA           escrow (program-owned) +0.1 SOL
  bet PDA                 rent (refunded@settle) +0.00348696 SOL
  player_state PDA        rent (one-time)        +0.00145464 SOL
  network fee             3 signatures           -0.000015 SOL
  WHAT THE WALLET SHOWS THE USER:  player -0.1049566 SOL  (pure outflow, no return)

TX 2 — settle_bet_sol   (backend signs; the player's wallet NEVER simulates this)
  WIN:  player +0.18148696 SOL (payout 0.178 + bet-rent refund) ; NET across both txs +0.077985 SOL
  LOSS: player +0.00348696 SOL (bet-rent refund only)           ; NET across both txs -0.100015 SOL
```

This is the crux of F2: the wallet-simulated transaction is a clean **−0.105 SOL
outflow to a program-owned PDA**; the potential **+0.178 SOL** return lives in a
transaction the wallet never sees. The destination being a program-owned PDA
(not an EOA) is why this should not trip a pure "all funds to an unknown wallet"
drain heuristic — the residual signal is the unverified-program + gambling +
one-directional-outflow combination, addressed by §5 + verification.

---

## 5. Summary — what causes the warning vs. nice-to-haves, and the off-chain step

**Actually causes the Phantom warning (do these):**
1. **Verify + register the build** (`docs/VERIFIED_BUILD.md`) — removes the
   "unknown/opaque program moving native SOL" signal. Highest leverage. *(F1)*
2. **Publish the IDL on-chain** (§3c) — labels the instruction/accounts. *(F1)*
3. **Submit the domain for false-positive review** (off-chain, below). *(F2, F3)*

**Nice-to-haves (do NOT move the needle on the warning):**
- Explicit `sol_vault == config.sol_vault` constraint for symmetry (§3b).
- Everything else in §2 is already correct (escrow PDA, tight constraints,
  constrained close/fee recipients).

**The remaining off-chain step — false-positive review:**
- **Blowfish** (powers Phantom's simulation/warnings): submit the dApp domain +
  program id via their dApp/allowlist intake ("report a false positive" /
  Blowfish dApp registration). Provide: the verified program id
  `DFmU9mwDbHkGRZ5J2f9zi59ZyDapaEv8qHhKsx8KpwAj`, the repo URL, the OtterSec
  verification link (`verify.osec.io/status/DFmU9mwDbHkGRZ5J2f9zi59ZyDapaEv8qHhKsx8KpwAj`),
  and a note that the signed `place_bet_sol` is an escrow deposit whose payout is
  a separate settle tx.
- **Phantom** developer support: request a review of the flagged domain, linking
  the same verification evidence. Phantom reads Blowfish, so clearing Blowfish
  usually clears Phantom.
- Ship the **published IDL** and verification *before* submitting — reviewers
  confirm against on-chain state, and a verified + IDL'd program is far more
  likely to be allowlisted.

Order of operations: verify build → publish IDL → confirm the "Verified" badge on
Explorer/Solscan → submit to Blowfish + Phantom with the evidence links.
