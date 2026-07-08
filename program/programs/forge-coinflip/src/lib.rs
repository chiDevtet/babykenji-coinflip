#![allow(unexpected_cfgs, deprecated)]
use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer as system_transfer, Transfer as SystemTransfer};
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};
use switchboard_on_demand::accounts::RandomnessAccountData;
use switchboard_on_demand::get_sb_program_id;

// Live mainnet program id (the deployed GameConfig for the $BABYK mint lives
// under this program). Must stay in sync with program/Anchor.toml, backend
// PROGRAM_ID, and frontend VITE_PROGRAM_ID. Any upgrade must be built with this
// exact id or the deployed PDAs become unreachable.
declare_id!("DFmU9mwDbHkGRZ5J2f9zi59ZyDapaEv8qHhKsx8KpwAj");

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------
/// Maximum external fee expressible, in basis points (10% here). Fees are
/// reserved in addition to the player win payout, so payout bps is configured
/// independently from fee bps.
const MAX_FEE_BPS: u16 = 1_000;
const DEFAULT_PLAYER_WIN_PAYOUT_BPS: u16 = 17_800;
const MIN_PLAYER_WIN_PAYOUT_BPS: u16 = 10_000;
/// Maximum single-bet payout, expressed as a fraction of the vault balance.
/// 2_500 bps = 25% ceiling for the configurable `max_payout_bps_of_treasury`.
const MAX_PAYOUT_BPS_CEILING: u16 = 2_500;
/// After this many slots an unsettled bet can be permissionlessly refunded to
/// the player. ~400ms/slot => ~1500 slots ≈ 10 minutes. Protects players from a
/// backend that goes down and never settles.
const BET_EXPIRY_SLOTS: u64 = 1_500;
const MAX_RANDOMNESS_COMMIT_AGE_SLOTS: u64 = 2;

const CHOICE_HEADS: u8 = 0;
const CHOICE_TAILS: u8 = 1;

/// Wager asset discriminator stored on each Bet, so settle/refund can verify the
/// caller used the matching (token vs SOL) instruction.
const ASSET_TOKEN: u8 = 0;
const ASSET_SOL: u8 = 1;

#[program]
pub mod forge_coinflip {
    use super::*;

    /// One-time setup per token mint. Creates the GameConfig and the PDA-owned
    /// treasury token account (vault). `seed_hash` is sha256(server_seed) for the
    /// first fairness epoch; the backend publishes the matching hash and only
    /// reveals server_seed on rotation.
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        params: InitializeParams,
    ) -> Result<()> {
        require!(params.fee_bps <= MAX_FEE_BPS, CoinflipError::FeeTooHigh);
        require!(
            params.max_payout_bps_of_treasury > 0
                && params.max_payout_bps_of_treasury <= MAX_PAYOUT_BPS_CEILING,
            CoinflipError::InvalidPayoutCap
        );
        require!(
            params.min_bet > 0 && params.min_bet <= params.max_bet,
            CoinflipError::InvalidBetLimits
        );
        require!(
            params.sol_min_bet > 0 && params.sol_min_bet <= params.sol_max_bet,
            CoinflipError::InvalidBetLimits
        );

        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.settle_authority = params.settle_authority;
        config.pending_admin = Pubkey::default();
        config.randomness_authority = params.randomness_authority;
        config.token_mint = ctx.accounts.mint.key();
        config.treasury_vault = ctx.accounts.treasury_vault.key();
        config.sol_team_wallet = params.sol_team_wallet;
        config.sol_dev_buyback_wallet = params.sol_dev_buyback_wallet;
        config.sol_holder_rewards_wallet = params.sol_holder_rewards_wallet;
        config.token_team_fee_account = params.token_team_fee_account;
        config.token_dev_fee_account = params.token_dev_fee_account;
        config.token_holder_rewards_account = params.token_holder_rewards_account;
        config.current_seed_hash = params.seed_hash;
        config.seed_epoch = 0;
        let sol_payout_bps = if params.sol_player_win_payout_bps == 0 {
            DEFAULT_PLAYER_WIN_PAYOUT_BPS
        } else {
            params.sol_player_win_payout_bps
        };
        let token_payout_bps = if params.token_player_win_payout_bps == 0 {
            DEFAULT_PLAYER_WIN_PAYOUT_BPS
        } else {
            params.token_player_win_payout_bps
        };
        validate_payout_config(params.fee_bps, sol_payout_bps)?;
        validate_payout_config(params.fee_bps, token_payout_bps)?;
        config.fee_bps = params.fee_bps;
        config.sol_player_win_payout_bps = sol_payout_bps;
        config.token_player_win_payout_bps = token_payout_bps;
        config.min_bet = params.min_bet;
        config.max_bet = params.max_bet;
        config.max_payout_bps_of_treasury = params.max_payout_bps_of_treasury;
        config.outstanding_liability = 0;
        config.sol_vault = ctx.accounts.sol_vault.key();
        config.sol_min_bet = params.sol_min_bet;
        config.sol_max_bet = params.sol_max_bet;
        config.outstanding_liability_sol = 0;
        config.paused = false;
        config.total_bets = 0;
        config.total_wagered = 0;
        config.total_paid_out = 0;
        config.bump = ctx.bumps.config;

        ctx.accounts.sol_vault.bump = ctx.bumps.sol_vault;

        emit!(ConfigInitialized {
            config: config.key(),
            admin: config.admin,
            token_mint: config.token_mint,
            settle_authority: config.settle_authority,
            seed_hash: config.current_seed_hash,
        });
        Ok(())
    }

    /// Admin-only parameter updates. Pass `None` to leave a field unchanged.
    pub fn update_config(ctx: Context<UpdateConfig>, params: UpdateParams) -> Result<()> {
        let config = &mut ctx.accounts.config;
        if let Some(v) = params.settle_authority {
            config.settle_authority = v;
        }
        if let Some(v) = params.fee_bps {
            require!(v <= MAX_FEE_BPS, CoinflipError::FeeTooHigh);
            validate_payout_config(v, config.sol_player_win_payout_bps)?;
            validate_payout_config(v, config.token_player_win_payout_bps)?;
            config.fee_bps = v;
        }
        if let Some(v) = params.min_bet {
            config.min_bet = v;
        }
        if let Some(v) = params.max_bet {
            config.max_bet = v;
        }
        require!(
            config.min_bet > 0 && config.min_bet <= config.max_bet,
            CoinflipError::InvalidBetLimits
        );
        if let Some(v) = params.sol_min_bet {
            config.sol_min_bet = v;
        }
        if let Some(v) = params.sol_max_bet {
            config.sol_max_bet = v;
        }
        require!(
            config.sol_min_bet > 0 && config.sol_min_bet <= config.sol_max_bet,
            CoinflipError::InvalidBetLimits
        );
        if let Some(v) = params.max_payout_bps_of_treasury {
            require!(
                v > 0 && v <= MAX_PAYOUT_BPS_CEILING,
                CoinflipError::InvalidPayoutCap
            );
            config.max_payout_bps_of_treasury = v;
        }
        if let Some(v) = params.sol_player_win_payout_bps {
            validate_payout_config(config.fee_bps, v)?;
            config.sol_player_win_payout_bps = v;
        }
        if let Some(v) = params.token_player_win_payout_bps {
            validate_payout_config(config.fee_bps, v)?;
            config.token_player_win_payout_bps = v;
        }
        if let Some(v) = params.paused {
            config.paused = v;
        }
        Ok(())
    }

    pub fn propose_admin_transfer(ctx: Context<UpdateConfig>, pending_admin: Pubkey) -> Result<()> {
        ctx.accounts.config.pending_admin = pending_admin;
        emit!(AdminTransferProposed {
            config: ctx.accounts.config.key(),
            admin: ctx.accounts.config.admin,
            pending_admin
        });
        Ok(())
    }

    pub fn accept_admin_transfer(ctx: Context<AcceptAdminTransfer>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(
            config.pending_admin == ctx.accounts.pending_admin.key(),
            CoinflipError::Unauthorized
        );
        let old_admin = config.admin;
        config.admin = ctx.accounts.pending_admin.key();
        config.pending_admin = Pubkey::default();
        emit!(AdminTransferred {
            config: config.key(),
            old_admin,
            new_admin: config.admin
        });
        Ok(())
    }

    pub fn cancel_admin_transfer(ctx: Context<UpdateConfig>) -> Result<()> {
        let pending_admin = ctx.accounts.config.pending_admin;
        ctx.accounts.config.pending_admin = Pubkey::default();
        emit!(AdminTransferCancelled {
            config: ctx.accounts.config.key(),
            admin: ctx.accounts.config.admin,
            pending_admin
        });
        Ok(())
    }

    pub fn rotate_seed(ctx: Context<RotateSeed>, new_seed_hash: [u8; 32]) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.current_seed_hash = new_seed_hash;
        config.seed_epoch = config
            .seed_epoch
            .checked_add(1)
            .ok_or(CoinflipError::MathOverflow)?;
        emit!(SeedRotated {
            config: config.key(),
            seed_epoch: config.seed_epoch,
            new_seed_hash,
        });
        Ok(())
    }

    /// Admin funds the house treasury.
    pub fn deposit_treasury(ctx: Context<DepositTreasury>, amount: u64) -> Result<()> {
        require!(amount > 0, CoinflipError::ZeroAmount);
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.admin_token_account.to_account_info(),
                    to: ctx.accounts.treasury_vault.to_account_info(),
                    authority: ctx.accounts.admin.to_account_info(),
                },
            ),
            amount,
        )?;
        Ok(())
    }

    /// Admin withdraws from the treasury. Cannot withdraw funds reserved against
    /// open bets (outstanding_liability), preserving solvency for in-flight wagers.
    pub fn withdraw_treasury(ctx: Context<WithdrawTreasury>, amount: u64) -> Result<()> {
        require!(amount > 0, CoinflipError::ZeroAmount);
        let config = &ctx.accounts.config;
        let available = (ctx.accounts.treasury_vault.amount as u128)
            .checked_sub(config.outstanding_liability)
            .ok_or(CoinflipError::InsufficientTreasury)?;
        require!(
            (amount as u128) <= available,
            CoinflipError::InsufficientTreasury
        );

        let mint_key = config.token_mint;
        let signer_seeds: &[&[&[u8]]] = &[&[b"config", mint_key.as_ref(), &[config.bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.treasury_vault.to_account_info(),
                    to: ctx.accounts.admin_token_account.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;
        Ok(())
    }

    /// Player locks a wager. The wager moves into the vault immediately and a Bet
    /// PDA records the commitment context (client_seed, nonce, epoch hash). The
    /// program reserves the full potential payout against the vault so the house
    /// can always pay a win; a bet is rejected if the vault (after this deposit)
    /// cannot cover all outstanding liabilities, or if its payout would exceed the
    /// per-bet ceiling relative to the pool.
    pub fn place_bet(
        ctx: Context<PlaceBet>,
        amount: u64,
        choice: u8,
        client_seed: [u8; 32],
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, CoinflipError::GamePaused);
        require!(
            choice == CHOICE_HEADS || choice == CHOICE_TAILS,
            CoinflipError::InvalidChoice
        );
        require!(
            amount >= config.min_bet && amount <= config.max_bet,
            CoinflipError::BetOutsideLimits
        );

        let payout_bps = config.token_player_win_payout_bps;
        validate_payout_config(config.fee_bps, payout_bps)?;
        let total_fee_amount = compute_total_fee(amount, config.fee_bps)?;
        let payout = compute_player_win_payout(amount, payout_bps)?;
        let total_win_liability = compute_total_win_liability(payout, total_fee_amount)?;

        // Solvency: vault AFTER receiving this wager must cover every reserved payout.
        let vault_after = (ctx.accounts.treasury_vault.amount as u128)
            .checked_add(amount as u128)
            .ok_or(CoinflipError::MathOverflow)?;
        let new_liability = config
            .outstanding_liability
            .checked_add(total_win_liability as u128)
            .ok_or(CoinflipError::MathOverflow)?;
        require!(
            vault_after >= new_liability,
            CoinflipError::InsufficientTreasury
        );

        // Per-bet ceiling: payout <= vault_after * max_payout_bps / 10_000.
        let single_cap = vault_after
            .checked_mul(config.max_payout_bps_of_treasury as u128)
            .ok_or(CoinflipError::MathOverflow)?
            / 10_000u128;
        require!(
            (payout as u128) <= single_cap,
            CoinflipError::BetExceedsPayoutCap
        );

        // Pull the wager into the vault.
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.player_token_account.to_account_info(),
                    to: ctx.accounts.treasury_vault.to_account_info(),
                    authority: ctx.accounts.player.to_account_info(),
                },
            ),
            amount,
        )?;

        let nonce = ctx.accounts.player_state.nonce;
        let clock = Clock::get()?;

        let bet = &mut ctx.accounts.bet;
        bet.config = config.key();
        bet.player = ctx.accounts.player.key();
        bet.amount = amount;
        bet.fee_team_recipient = config.token_team_fee_account;
        bet.fee_dev_recipient = config.token_dev_fee_account;
        bet.fee_holder_rewards_recipient = config.token_holder_rewards_account;
        bet.player_win_payout_bps = payout_bps;
        bet.player_win_payout = payout;
        bet.total_fee_amount = total_fee_amount;
        bet.team_fee_amount = compute_fee_amount(amount, 500)?;
        bet.dev_fee_amount = compute_fee_amount(amount, 166)?;
        bet.burn_fee_amount = compute_fee_amount(amount, 167)?;
        bet.holder_rewards_fee_amount = total_fee_amount
            .checked_sub(bet.team_fee_amount)
            .and_then(|v| v.checked_sub(bet.dev_fee_amount))
            .and_then(|v| v.checked_sub(bet.burn_fee_amount))
            .ok_or(CoinflipError::MathOverflow)?;
        bet.total_win_liability = total_win_liability;
        bet.choice = choice;
        bet.asset = ASSET_TOKEN;
        bet.client_seed = client_seed;
        bet.nonce = nonce;
        bet.seed_hash = config.current_seed_hash;
        bet.seed_epoch = config.seed_epoch;
        bet.placed_slot = clock.slot;
        let randomness_data = validate_randomness_commit(&ctx.accounts.randomness, clock.slot)?;
        bet.commit_slot = randomness_data.seed_slot;
        bet.settlement_deadline_slot = bet
            .commit_slot
            .checked_add(BET_EXPIRY_SLOTS)
            .ok_or(CoinflipError::MathOverflow)?;
        bet.randomness_account = ctx.accounts.randomness.key();
        bet.bump = ctx.bumps.bet;

        // Mutate config + player_state after all validation.
        let config = &mut ctx.accounts.config;
        config.outstanding_liability = new_liability;
        config.total_bets = config
            .total_bets
            .checked_add(1)
            .ok_or(CoinflipError::MathOverflow)?;
        config.total_wagered = config
            .total_wagered
            .checked_add(amount as u128)
            .ok_or(CoinflipError::MathOverflow)?;

        let ps = &mut ctx.accounts.player_state;
        ps.player = ctx.accounts.player.key();
        ps.config = config.key();
        ps.nonce = nonce.checked_add(1).ok_or(CoinflipError::MathOverflow)?;

        emit!(BetPlaced {
            config: config.key(),
            player: bet.player,
            nonce,
            amount,
            player_win_payout: payout,
            team_fee_amount: bet.team_fee_amount,
            dev_fee_amount: bet.dev_fee_amount,
            burn_fee_amount: bet.burn_fee_amount,
            holder_rewards_fee_amount: bet.holder_rewards_fee_amount,
            fee_team_recipient: bet.fee_team_recipient,
            fee_dev_recipient: bet.fee_dev_recipient,
            fee_holder_rewards_recipient: bet.fee_holder_rewards_recipient,
            player_win_payout_bps: payout_bps,
            total_fee_amount,
            total_win_liability,
            choice,
            client_seed,
            seed_hash: bet.seed_hash,
            seed_epoch: bet.seed_epoch,
            placed_slot: bet.placed_slot,
            randomness_account: bet.randomness_account,
            commit_slot: bet.commit_slot,
        });
        Ok(())
    }

    /// Permissionless settlement. The program reads the exact randomness account
    /// committed into the Bet and computes the result bit on-chain; callers cannot
    /// supply or influence a win/loss boolean.
    pub fn settle_bet(ctx: Context<SettleBet>) -> Result<()> {
        require!(
            ctx.accounts.bet.asset == ASSET_TOKEN,
            CoinflipError::WrongAsset
        );
        let (result_bit, won) = verified_result(
            &ctx.accounts.bet,
            ctx.accounts.randomness.key(),
            &ctx.accounts.randomness,
        )?;
        let bet_payout = ctx.accounts.bet.player_win_payout;
        let bet_liability = ctx.accounts.bet.total_win_liability;
        let bet_amount = ctx.accounts.bet.amount;
        let bet_choice = ctx.accounts.bet.choice;
        let bet_nonce = ctx.accounts.bet.nonce;
        let randomness_account = ctx.accounts.bet.randomness_account;

        ctx.accounts.config.outstanding_liability = ctx
            .accounts
            .config
            .outstanding_liability
            .checked_sub(bet_liability as u128)
            .ok_or(CoinflipError::LiabilityUnderflow)?;

        if won {
            require!(
                ctx.accounts.treasury_vault.amount >= bet_payout,
                CoinflipError::InsufficientTreasury
            );
            let mint_key = ctx.accounts.config.token_mint;
            let signer_seeds: &[&[&[u8]]] =
                &[&[b"config", mint_key.as_ref(), &[ctx.accounts.config.bump]]];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.treasury_vault.to_account_info(),
                        to: ctx.accounts.player_token_account.to_account_info(),
                        authority: ctx.accounts.config.to_account_info(),
                    },
                    signer_seeds,
                ),
                bet_payout,
            )?;
            ctx.accounts.config.total_paid_out = ctx
                .accounts
                .config
                .total_paid_out
                .checked_add(bet_payout as u128)
                .ok_or(CoinflipError::MathOverflow)?;
        }
        let mint_key = ctx.accounts.config.token_mint;
        let signer_seeds: &[&[&[u8]]] =
            &[&[b"config", mint_key.as_ref(), &[ctx.accounts.config.bump]]];
        transfer_tokens_from_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.treasury_vault,
            &ctx.accounts.team_fee_token_account,
            &ctx.accounts.config.to_account_info(),
            signer_seeds,
            ctx.accounts.bet.team_fee_amount,
        )?;
        transfer_tokens_from_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.treasury_vault,
            &ctx.accounts.dev_fee_token_account,
            &ctx.accounts.config.to_account_info(),
            signer_seeds,
            ctx.accounts.bet.dev_fee_amount,
        )?;
        transfer_tokens_from_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.treasury_vault,
            &ctx.accounts.holder_rewards_fee_token_account,
            &ctx.accounts.config.to_account_info(),
            signer_seeds,
            ctx.accounts.bet.holder_rewards_fee_amount,
        )?;
        if ctx.accounts.bet.burn_fee_amount > 0 {
            token::burn(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Burn {
                        mint: ctx.accounts.token_mint.to_account_info(),
                        from: ctx.accounts.treasury_vault.to_account_info(),
                        authority: ctx.accounts.config.to_account_info(),
                    },
                    signer_seeds,
                ),
                ctx.accounts.bet.burn_fee_amount,
            )?;
        }
        emit!(BetSettled {
            config: ctx.accounts.config.key(),
            player: ctx.accounts.player.key(),
            nonce: bet_nonce,
            asset: ASSET_TOKEN,
            amount: bet_amount,
            player_win_payout: bet_payout,
            team_fee_amount: ctx.accounts.bet.team_fee_amount,
            dev_fee_amount: ctx.accounts.bet.dev_fee_amount,
            burn_fee_amount: ctx.accounts.bet.burn_fee_amount,
            holder_rewards_fee_amount: ctx.accounts.bet.holder_rewards_fee_amount,
            fee_team_recipient: ctx.accounts.bet.fee_team_recipient,
            fee_dev_recipient: ctx.accounts.bet.fee_dev_recipient,
            fee_holder_rewards_recipient: ctx.accounts.bet.fee_holder_rewards_recipient,
            player_win_payout_bps: ctx.accounts.bet.player_win_payout_bps,
            total_fee_amount: ctx.accounts.bet.total_fee_amount,
            total_win_liability: bet_liability,
            choice: bet_choice,
            result_bit,
            won,
            randomness_account
        });
        Ok(())
    }

    /// Permissionless cleanup: after BET_EXPIRY_SLOTS an unsettled bet can be
    /// refunded to its player (wager returned, reservation released). Anyone may
    /// call it; funds always go to bet.player.
    pub fn refund_expired_bet(ctx: Context<RefundExpiredBet>) -> Result<()> {
        let bet_payout = ctx.accounts.bet.total_win_liability;
        let bet_amount = ctx.accounts.bet.amount;
        let deadline_slot = ctx.accounts.bet.settlement_deadline_slot;
        validate_randomness_unresolved_for_refund(&ctx.accounts.bet, &ctx.accounts.randomness)?;
        require!(
            ctx.accounts.bet.asset == ASSET_TOKEN,
            CoinflipError::WrongAsset
        );

        let clock = Clock::get()?;
        require!(clock.slot > deadline_slot, CoinflipError::BetNotExpired);

        {
            let config = &mut ctx.accounts.config;
            config.outstanding_liability = config
                .outstanding_liability
                .checked_sub(bet_payout as u128)
                .ok_or(CoinflipError::LiabilityUnderflow)?;
        }

        let config = &ctx.accounts.config;
        require!(
            ctx.accounts.treasury_vault.amount >= bet_amount,
            CoinflipError::InsufficientTreasury
        );
        let mint_key = config.token_mint;
        let signer_seeds: &[&[&[u8]]] = &[&[b"config", mint_key.as_ref(), &[config.bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.treasury_vault.to_account_info(),
                    to: ctx.accounts.player_token_account.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer_seeds,
            ),
            bet_amount,
        )?;

        emit!(BetRefunded {
            config: ctx.accounts.config.key(),
            player: ctx.accounts.player.key(),
            amount: bet_amount,
        });
        Ok(())
    }

    // ------------------------------------------------------------------------
    // Native SOL wager path (parallel to the SPL token instructions above)
    // ------------------------------------------------------------------------

    /// Admin funds the native-SOL house treasury.
    pub fn deposit_sol_treasury(ctx: Context<DepositSolTreasury>, amount: u64) -> Result<()> {
        require!(amount > 0, CoinflipError::ZeroAmount);
        system_transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                SystemTransfer {
                    from: ctx.accounts.admin.to_account_info(),
                    to: ctx.accounts.sol_vault.to_account_info(),
                },
            ),
            amount,
        )?;
        Ok(())
    }

    /// Admin withdraws native SOL, never touching the rent reserve or lamports
    /// reserved against open SOL bets.
    pub fn withdraw_sol_treasury(ctx: Context<WithdrawSolTreasury>, amount: u64) -> Result<()> {
        require!(amount > 0, CoinflipError::ZeroAmount);
        let config = &ctx.accounts.config;
        let vault_ai = ctx.accounts.sol_vault.to_account_info();
        let rent_min = Rent::get()?.minimum_balance(vault_ai.data_len());
        let spendable = (vault_ai.lamports() as u128)
            .checked_sub(rent_min as u128)
            .ok_or(CoinflipError::InsufficientTreasury)?
            .checked_sub(config.outstanding_liability_sol)
            .ok_or(CoinflipError::InsufficientTreasury)?;
        require!(
            (amount as u128) <= spendable,
            CoinflipError::InsufficientTreasury
        );
        **vault_ai.try_borrow_mut_lamports()? -= amount;
        **ctx
            .accounts
            .admin
            .to_account_info()
            .try_borrow_mut_lamports()? += amount;
        Ok(())
    }

    /// SOL equivalent of place_bet: the wager moves into the SOL vault via a System
    /// transfer (player signs) and the full potential payout is reserved against
    /// the vault's spendable (rent-excluded) balance.
    pub fn place_bet_sol(
        ctx: Context<PlaceBetSol>,
        amount: u64,
        choice: u8,
        client_seed: [u8; 32],
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, CoinflipError::GamePaused);
        require!(
            choice == CHOICE_HEADS || choice == CHOICE_TAILS,
            CoinflipError::InvalidChoice
        );
        require!(
            amount >= config.sol_min_bet && amount <= config.sol_max_bet,
            CoinflipError::BetOutsideLimits
        );

        let payout_bps = config.sol_player_win_payout_bps;
        validate_payout_config(config.fee_bps, payout_bps)?;
        let total_fee_amount = compute_total_fee(amount, config.fee_bps)?;
        let payout = compute_player_win_payout(amount, payout_bps)?;
        let total_win_liability = compute_total_win_liability(payout, total_fee_amount)?;

        // Spendable balance excludes the rent reserve (which can never be paid out).
        let vault_ai = ctx.accounts.sol_vault.to_account_info();
        let rent_min = Rent::get()?.minimum_balance(vault_ai.data_len());
        let vault_spendable = (vault_ai.lamports() as u128)
            .checked_sub(rent_min as u128)
            .ok_or(CoinflipError::InsufficientTreasury)?;
        let vault_after = vault_spendable
            .checked_add(amount as u128)
            .ok_or(CoinflipError::MathOverflow)?;
        let new_liability = config
            .outstanding_liability_sol
            .checked_add(total_win_liability as u128)
            .ok_or(CoinflipError::MathOverflow)?;
        require!(
            vault_after >= new_liability,
            CoinflipError::InsufficientTreasury
        );

        let single_cap = vault_after
            .checked_mul(config.max_payout_bps_of_treasury as u128)
            .ok_or(CoinflipError::MathOverflow)?
            / 10_000u128;
        require!(
            (payout as u128) <= single_cap,
            CoinflipError::BetExceedsPayoutCap
        );

        // Pull the wager into the SOL vault (player signs the System transfer).
        system_transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                SystemTransfer {
                    from: ctx.accounts.player.to_account_info(),
                    to: ctx.accounts.sol_vault.to_account_info(),
                },
            ),
            amount,
        )?;

        let nonce = ctx.accounts.player_state.nonce;
        let clock = Clock::get()?;

        let bet = &mut ctx.accounts.bet;
        bet.config = config.key();
        bet.player = ctx.accounts.player.key();
        bet.amount = amount;
        bet.fee_team_recipient = config.sol_team_wallet;
        bet.fee_dev_recipient = config.sol_dev_buyback_wallet;
        bet.fee_holder_rewards_recipient = config.sol_holder_rewards_wallet;
        bet.player_win_payout_bps = payout_bps;
        bet.player_win_payout = payout;
        bet.total_fee_amount = total_fee_amount;
        bet.team_fee_amount = compute_fee_amount(amount, 500)?;
        bet.dev_fee_amount = compute_fee_amount(amount, 300)?;
        bet.burn_fee_amount = 0;
        bet.holder_rewards_fee_amount = total_fee_amount
            .checked_sub(bet.team_fee_amount)
            .and_then(|v| v.checked_sub(bet.dev_fee_amount))
            .ok_or(CoinflipError::MathOverflow)?;
        bet.total_win_liability = total_win_liability;
        bet.choice = choice;
        bet.asset = ASSET_SOL;
        bet.client_seed = client_seed;
        bet.nonce = nonce;
        bet.seed_hash = config.current_seed_hash;
        bet.seed_epoch = config.seed_epoch;
        bet.placed_slot = clock.slot;
        let randomness_data = validate_randomness_commit(&ctx.accounts.randomness, clock.slot)?;
        bet.commit_slot = randomness_data.seed_slot;
        bet.settlement_deadline_slot = bet
            .commit_slot
            .checked_add(BET_EXPIRY_SLOTS)
            .ok_or(CoinflipError::MathOverflow)?;
        bet.randomness_account = ctx.accounts.randomness.key();
        bet.bump = ctx.bumps.bet;

        let config = &mut ctx.accounts.config;
        config.outstanding_liability_sol = new_liability;
        config.total_bets = config
            .total_bets
            .checked_add(1)
            .ok_or(CoinflipError::MathOverflow)?;

        let ps = &mut ctx.accounts.player_state;
        ps.player = ctx.accounts.player.key();
        ps.config = config.key();
        ps.nonce = nonce.checked_add(1).ok_or(CoinflipError::MathOverflow)?;

        emit!(BetPlaced {
            config: config.key(),
            player: bet.player,
            nonce,
            amount,
            player_win_payout: payout,
            team_fee_amount: bet.team_fee_amount,
            dev_fee_amount: bet.dev_fee_amount,
            burn_fee_amount: bet.burn_fee_amount,
            holder_rewards_fee_amount: bet.holder_rewards_fee_amount,
            fee_team_recipient: bet.fee_team_recipient,
            fee_dev_recipient: bet.fee_dev_recipient,
            fee_holder_rewards_recipient: bet.fee_holder_rewards_recipient,
            player_win_payout_bps: payout_bps,
            total_fee_amount,
            total_win_liability,
            choice,
            client_seed,
            seed_hash: bet.seed_hash,
            seed_epoch: bet.seed_epoch,
            placed_slot: bet.placed_slot,
            randomness_account: bet.randomness_account,
            commit_slot: bet.commit_slot,
        });
        Ok(())
    }

    /// SOL equivalent of settle_bet.
    pub fn settle_bet_sol(ctx: Context<SettleBetSol>) -> Result<()> {
        require!(
            ctx.accounts.bet.asset == ASSET_SOL,
            CoinflipError::WrongAsset
        );
        let (result_bit, won) = verified_result(
            &ctx.accounts.bet,
            ctx.accounts.randomness.key(),
            &ctx.accounts.randomness,
        )?;
        let bet_payout = ctx.accounts.bet.player_win_payout;
        let bet_liability = ctx.accounts.bet.total_win_liability;
        let bet_amount = ctx.accounts.bet.amount;
        let bet_choice = ctx.accounts.bet.choice;
        let bet_nonce = ctx.accounts.bet.nonce;
        let randomness_account = ctx.accounts.bet.randomness_account;

        ctx.accounts.config.outstanding_liability_sol = ctx
            .accounts
            .config
            .outstanding_liability_sol
            .checked_sub(bet_liability as u128)
            .ok_or(CoinflipError::LiabilityUnderflow)?;

        if won {
            let vault_ai = ctx.accounts.sol_vault.to_account_info();
            let rent_min = Rent::get()?.minimum_balance(vault_ai.data_len());
            require!(
                vault_ai.lamports()
                    >= bet_payout
                        .checked_add(rent_min)
                        .ok_or(CoinflipError::MathOverflow)?,
                CoinflipError::InsufficientTreasury
            );
            **vault_ai.try_borrow_mut_lamports()? -= bet_payout;
            **ctx
                .accounts
                .player
                .to_account_info()
                .try_borrow_mut_lamports()? += bet_payout;
            ctx.accounts.config.total_paid_out = ctx
                .accounts
                .config
                .total_paid_out
                .checked_add(bet_payout as u128)
                .ok_or(CoinflipError::MathOverflow)?;
        }
        transfer_lamports_preserving_rent(
            &ctx.accounts.sol_vault.to_account_info(),
            &ctx.accounts.team_sol_wallet.to_account_info(),
            ctx.accounts.bet.team_fee_amount,
        )?;
        transfer_lamports_preserving_rent(
            &ctx.accounts.sol_vault.to_account_info(),
            &ctx.accounts.dev_buyback_sol_wallet.to_account_info(),
            ctx.accounts.bet.dev_fee_amount,
        )?;
        transfer_lamports_preserving_rent(
            &ctx.accounts.sol_vault.to_account_info(),
            &ctx.accounts.holder_rewards_sol_wallet.to_account_info(),
            ctx.accounts.bet.holder_rewards_fee_amount,
        )?;
        emit!(BetSettled {
            config: ctx.accounts.config.key(),
            player: ctx.accounts.player.key(),
            nonce: bet_nonce,
            asset: ASSET_SOL,
            amount: bet_amount,
            player_win_payout: bet_payout,
            team_fee_amount: ctx.accounts.bet.team_fee_amount,
            dev_fee_amount: ctx.accounts.bet.dev_fee_amount,
            burn_fee_amount: ctx.accounts.bet.burn_fee_amount,
            holder_rewards_fee_amount: ctx.accounts.bet.holder_rewards_fee_amount,
            fee_team_recipient: ctx.accounts.bet.fee_team_recipient,
            fee_dev_recipient: ctx.accounts.bet.fee_dev_recipient,
            fee_holder_rewards_recipient: ctx.accounts.bet.fee_holder_rewards_recipient,
            player_win_payout_bps: ctx.accounts.bet.player_win_payout_bps,
            total_fee_amount: ctx.accounts.bet.total_fee_amount,
            total_win_liability: bet_liability,
            choice: bet_choice,
            result_bit,
            won,
            randomness_account
        });
        Ok(())
    }

    /// SOL equivalent of refund_expired_bet.
    pub fn refund_expired_bet_sol(ctx: Context<RefundExpiredBetSol>) -> Result<()> {
        let bet_payout = ctx.accounts.bet.total_win_liability;
        let bet_amount = ctx.accounts.bet.amount;
        let deadline_slot = ctx.accounts.bet.settlement_deadline_slot;
        validate_randomness_unresolved_for_refund(&ctx.accounts.bet, &ctx.accounts.randomness)?;
        require!(
            ctx.accounts.bet.asset == ASSET_SOL,
            CoinflipError::WrongAsset
        );

        let clock = Clock::get()?;
        require!(clock.slot > deadline_slot, CoinflipError::BetNotExpired);

        {
            let config = &mut ctx.accounts.config;
            config.outstanding_liability_sol = config
                .outstanding_liability_sol
                .checked_sub(bet_payout as u128)
                .ok_or(CoinflipError::LiabilityUnderflow)?;
        }

        let vault_ai = ctx.accounts.sol_vault.to_account_info();
        let rent_min = Rent::get()?.minimum_balance(vault_ai.data_len());
        require!(
            vault_ai.lamports()
                >= bet_amount
                    .checked_add(rent_min)
                    .ok_or(CoinflipError::MathOverflow)?,
            CoinflipError::InsufficientTreasury
        );
        **vault_ai.try_borrow_mut_lamports()? -= bet_amount;
        **ctx
            .accounts
            .player
            .to_account_info()
            .try_borrow_mut_lamports()? += bet_amount;

        emit!(BetRefunded {
            config: ctx.accounts.config.key(),
            player: ctx.accounts.player.key(),
            amount: bet_amount,
        });
        Ok(())
    }
}

// ----------------------------------------------------------------------------
// Pure helpers
// ----------------------------------------------------------------------------
fn checked_mul_div_floor(amount: u64, numerator_bps: u16, denominator: u64) -> Result<u64> {
    let value = (amount as u128)
        .checked_mul(numerator_bps as u128)
        .ok_or(CoinflipError::MathOverflow)?
        / (denominator as u128);
    u64::try_from(value).map_err(|_| error!(CoinflipError::MathOverflow))
}

fn compute_fee_amount(amount: u64, fee_bps: u16) -> Result<u64> {
    checked_mul_div_floor(amount, fee_bps, 10_000)
}

fn compute_total_fee(amount: u64, total_fee_bps: u16) -> Result<u64> {
    let fee = compute_fee_amount(amount, total_fee_bps)?;
    require!(fee > 0, CoinflipError::DustWager);
    Ok(fee)
}

fn compute_player_win_payout(amount: u64, player_win_payout_bps: u16) -> Result<u64> {
    let payout = checked_mul_div_floor(amount, player_win_payout_bps, 10_000)?;
    require!(payout > 0, CoinflipError::DustWager);
    Ok(payout)
}

fn compute_total_win_liability(player_win_payout: u64, total_fee_amount: u64) -> Result<u64> {
    player_win_payout
        .checked_add(total_fee_amount)
        .ok_or(error!(CoinflipError::MathOverflow))
}

fn validate_payout_config(total_fee_bps: u16, player_win_payout_bps: u16) -> Result<()> {
    require!(
        player_win_payout_bps >= MIN_PLAYER_WIN_PAYOUT_BPS,
        CoinflipError::InvalidPlayerWinPayoutBps
    );
    require!(
        (player_win_payout_bps as u32) + (total_fee_bps as u32) <= 20_000,
        CoinflipError::InvalidPlayerWinPayoutBps
    );
    Ok(())
}

#[allow(dead_code)]
fn compute_expected_vault_edge_bps(total_fee_bps: u16, player_win_payout_bps: u16) -> Result<i32> {
    validate_payout_config(total_fee_bps, player_win_payout_bps)?;
    Ok(10_000i32 - total_fee_bps as i32 - (player_win_payout_bps as i32 / 2))
}

fn expected_switchboard_program_id() -> Pubkey {
    #[cfg(feature = "mainnet")]
    {
        get_sb_program_id("mainnet")
    }
    #[cfg(not(feature = "mainnet"))]
    {
        get_sb_program_id("devnet")
    }
}

fn parse_switchboard_randomness(randomness: &AccountInfo) -> Result<RandomnessAccountData> {
    require!(
        *randomness.owner == expected_switchboard_program_id(),
        CoinflipError::InvalidRandomnessOwner
    );
    let data = RandomnessAccountData::parse(randomness.data.borrow())
        .map_err(|_| error!(CoinflipError::InvalidRandomnessAccount))?;
    Ok(*data)
}

fn validate_randomness_commit(
    randomness: &AccountInfo,
    current_slot: u64,
) -> Result<RandomnessAccountData> {
    let randomness_data = parse_switchboard_randomness(randomness)?;
    require!(
        randomness_data.seed_slot > 0,
        CoinflipError::RandomnessNotCommitted
    );
    require!(
        randomness_data.seed_slot <= current_slot
            && current_slot.saturating_sub(randomness_data.seed_slot)
                <= MAX_RANDOMNESS_COMMIT_AGE_SLOTS,
        CoinflipError::RandomnessExpired
    );
    require!(
        randomness_data.get_value(current_slot).is_err(),
        CoinflipError::RandomnessAlreadyReady
    );
    Ok(randomness_data)
}

fn verified_result(
    bet: &Bet,
    randomness_key: Pubkey,
    randomness: &AccountInfo,
) -> Result<(u8, bool)> {
    require!(
        randomness_key == bet.randomness_account,
        CoinflipError::WrongRandomnessAccount
    );
    let clock = Clock::get()?;
    let randomness_data = parse_switchboard_randomness(randomness)?;
    require!(
        randomness_data.seed_slot == bet.commit_slot,
        CoinflipError::RandomnessSeedSlotMismatch
    );
    let random_bytes = randomness_data
        .get_value(clock.slot)
        .map_err(|_| error!(CoinflipError::RandomnessNotReady))?;
    let result_bit = random_bytes[0] & 1;
    Ok((result_bit, result_bit == bet.choice))
}

fn validate_randomness_unresolved_for_refund(bet: &Bet, randomness: &AccountInfo) -> Result<()> {
    require!(
        randomness.key() == bet.randomness_account,
        CoinflipError::WrongRandomnessAccount
    );
    let clock = Clock::get()?;
    let randomness_data = parse_switchboard_randomness(randomness)?;
    require!(
        randomness_data.seed_slot == bet.commit_slot,
        CoinflipError::RandomnessSeedSlotMismatch
    );
    require!(
        randomness_data.get_value(clock.slot).is_err(),
        CoinflipError::RandomnessAlreadyReady
    );
    Ok(())
}

fn transfer_tokens_from_vault<'info>(
    token_program: &Program<'info, Token>,
    from: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    authority: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer {
                from: from.to_account_info(),
                to: to.to_account_info(),
                authority: authority.clone(),
            },
            signer_seeds,
        ),
        amount,
    )
}

fn transfer_lamports_preserving_rent<'info>(
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let rent_min = Rent::get()?.minimum_balance(from.data_len());
    require!(
        from.lamports()
            >= amount
                .checked_add(rent_min)
                .ok_or(CoinflipError::MathOverflow)?,
        CoinflipError::InsufficientTreasury
    );
    **from.try_borrow_mut_lamports()? -= amount;
    **to.try_borrow_mut_lamports()? += amount;
    Ok(())
}

// ----------------------------------------------------------------------------
// State
// ----------------------------------------------------------------------------
#[account]
#[derive(InitSpace)]
pub struct GameConfig {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
    pub settle_authority: Pubkey,
    pub randomness_authority: Pubkey,
    pub token_mint: Pubkey,
    pub treasury_vault: Pubkey,
    pub sol_team_wallet: Pubkey,
    pub sol_dev_buyback_wallet: Pubkey,
    pub sol_holder_rewards_wallet: Pubkey,
    pub token_team_fee_account: Pubkey,
    pub token_dev_fee_account: Pubkey,
    pub token_holder_rewards_account: Pubkey,
    pub current_seed_hash: [u8; 32],
    pub seed_epoch: u64,
    pub fee_bps: u16,
    pub sol_player_win_payout_bps: u16,
    pub token_player_win_payout_bps: u16,
    pub min_bet: u64,
    pub max_bet: u64,
    pub max_payout_bps_of_treasury: u16,
    pub outstanding_liability: u128,
    pub paused: bool,
    pub total_bets: u64,
    pub total_wagered: u128,
    pub total_paid_out: u128,
    pub sol_vault: Pubkey,
    pub sol_min_bet: u64,
    pub sol_max_bet: u64,
    pub outstanding_liability_sol: u128,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct PlayerState {
    pub player: Pubkey,
    pub config: Pubkey,
    pub nonce: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Bet {
    pub config: Pubkey,
    pub player: Pubkey,
    pub amount: u64,
    pub fee_team_recipient: Pubkey,
    pub fee_dev_recipient: Pubkey,
    pub fee_holder_rewards_recipient: Pubkey,
    pub player_win_payout_bps: u16,
    pub player_win_payout: u64,
    pub total_fee_amount: u64,
    pub team_fee_amount: u64,
    pub dev_fee_amount: u64,
    pub burn_fee_amount: u64,
    pub holder_rewards_fee_amount: u64,
    pub total_win_liability: u64,
    pub choice: u8,
    pub asset: u8,
    pub client_seed: [u8; 32],
    pub nonce: u64,
    pub seed_hash: [u8; 32],
    pub seed_epoch: u64,
    pub placed_slot: u64,
    pub commit_slot: u64,
    pub settlement_deadline_slot: u64,
    pub randomness_account: Pubkey,
    pub bump: u8,
}

/// Program-owned PDA that custodies native SOL for the SOL wager path. Lamports
/// move in via System transfers; payouts are made by the program debiting this
/// account directly (it owns the account), always leaving it rent-exempt.
#[account]
#[derive(InitSpace)]
pub struct SolVault {
    pub bump: u8,
}

// ----------------------------------------------------------------------------
// Instruction params
// ----------------------------------------------------------------------------
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeParams {
    pub settle_authority: Pubkey,
    pub randomness_authority: Pubkey,
    pub sol_team_wallet: Pubkey,
    pub sol_dev_buyback_wallet: Pubkey,
    pub sol_holder_rewards_wallet: Pubkey,
    pub token_team_fee_account: Pubkey,
    pub token_dev_fee_account: Pubkey,
    pub token_holder_rewards_account: Pubkey,
    pub fee_bps: u16,
    pub sol_player_win_payout_bps: u16,
    pub token_player_win_payout_bps: u16,
    pub min_bet: u64,
    pub max_bet: u64,
    pub max_payout_bps_of_treasury: u16,
    pub seed_hash: [u8; 32],
    pub sol_min_bet: u64,
    pub sol_max_bet: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UpdateParams {
    pub settle_authority: Option<Pubkey>,
    pub fee_bps: Option<u16>,
    pub sol_player_win_payout_bps: Option<u16>,
    pub token_player_win_payout_bps: Option<u16>,
    pub min_bet: Option<u64>,
    pub max_bet: Option<u64>,
    pub max_payout_bps_of_treasury: Option<u16>,
    pub paused: Option<bool>,
    pub sol_min_bet: Option<u64>,
    pub sol_max_bet: Option<u64>,
}

// ----------------------------------------------------------------------------
// Account contexts
// ----------------------------------------------------------------------------
#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = admin,
        space = 8 + GameConfig::INIT_SPACE,
        seeds = [b"config", mint.key().as_ref()],
        bump
    )]
    pub config: Box<Account<'info, GameConfig>>,
    #[account(
        init,
        payer = admin,
        seeds = [b"vault", config.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = config
    )]
    pub treasury_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        payer = admin,
        space = 8 + SolVault::INIT_SPACE,
        seeds = [b"sol_vault", config.key().as_ref()],
        bump
    )]
    pub sol_vault: Box<Account<'info, SolVault>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, has_one = admin, seeds = [b"config", config.token_mint.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
}

#[derive(Accounts)]
pub struct RotateSeed<'info> {
    /// Permissionless crank/fee payer; outcome is computed by the program.
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"config", config.token_mint.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
}

#[derive(Accounts)]
pub struct AcceptAdminTransfer<'info> {
    pub pending_admin: Signer<'info>,
    #[account(mut, seeds = [b"config", config.token_mint.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
}

#[derive(Accounts)]
pub struct DepositTreasury<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(has_one = admin, seeds = [b"config", config.token_mint.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
    #[account(mut, constraint = treasury_vault.key() == config.treasury_vault @ CoinflipError::WrongVault)]
    pub treasury_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = admin_token_account.mint == config.token_mint @ CoinflipError::WrongMint,
        constraint = admin_token_account.owner == admin.key() @ CoinflipError::WrongOwner
    )]
    pub admin_token_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WithdrawTreasury<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, has_one = admin, seeds = [b"config", config.token_mint.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
    #[account(mut, constraint = treasury_vault.key() == config.treasury_vault @ CoinflipError::WrongVault)]
    pub treasury_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = admin_token_account.mint == config.token_mint @ CoinflipError::WrongMint,
        constraint = admin_token_account.owner == admin.key() @ CoinflipError::WrongOwner
    )]
    pub admin_token_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct PlaceBet<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(mut, seeds = [b"config", config.token_mint.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
    #[account(
        init_if_needed,
        payer = player,
        space = 8 + PlayerState::INIT_SPACE,
        seeds = [b"player", config.key().as_ref(), player.key().as_ref()],
        bump
    )]
    pub player_state: Box<Account<'info, PlayerState>>,
    #[account(
        init,
        payer = player,
        space = 8 + Bet::INIT_SPACE,
        seeds = [b"bet", player.key().as_ref(), player_state.nonce.to_le_bytes().as_ref()],
        bump
    )]
    pub bet: Box<Account<'info, Bet>>,
    #[account(mut, constraint = treasury_vault.key() == config.treasury_vault @ CoinflipError::WrongVault)]
    pub treasury_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = player_token_account.mint == config.token_mint @ CoinflipError::WrongMint,
        constraint = player_token_account.owner == player.key() @ CoinflipError::WrongOwner
    )]
    pub player_token_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: Switchboard randomness account parsed and owner-checked in the handler
    pub randomness: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleBet<'info> {
    /// Permissionless crank/fee payer; outcome is computed by the program.
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"config", config.token_mint.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
    #[account(
        mut,
        close = player,
        has_one = config @ CoinflipError::WrongConfig,
        has_one = player @ CoinflipError::WrongPlayer,
        seeds = [b"bet", bet.player.as_ref(), bet.nonce.to_le_bytes().as_ref()],
        bump = bet.bump
    )]
    pub bet: Box<Account<'info, Bet>>,
    /// CHECK: recipient of the bet's rent + payout; validated by `has_one = player` on `bet`.
    #[account(mut)]
    pub player: UncheckedAccount<'info>,
    #[account(mut, constraint = treasury_vault.key() == config.treasury_vault @ CoinflipError::WrongVault)]
    pub treasury_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = player_token_account.mint == config.token_mint @ CoinflipError::WrongMint,
        constraint = player_token_account.owner == bet.player @ CoinflipError::WrongOwner
    )]
    pub player_token_account: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = team_fee_token_account.key() == bet.fee_team_recipient @ CoinflipError::WrongFeeRecipient, constraint = team_fee_token_account.mint == config.token_mint @ CoinflipError::WrongMint)]
    pub team_fee_token_account: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = dev_fee_token_account.key() == bet.fee_dev_recipient @ CoinflipError::WrongFeeRecipient, constraint = dev_fee_token_account.mint == config.token_mint @ CoinflipError::WrongMint)]
    pub dev_fee_token_account: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = holder_rewards_fee_token_account.key() == bet.fee_holder_rewards_recipient @ CoinflipError::WrongFeeRecipient, constraint = holder_rewards_fee_token_account.mint == config.token_mint @ CoinflipError::WrongMint)]
    pub holder_rewards_fee_token_account: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = token_mint.key() == config.token_mint @ CoinflipError::WrongMint)]
    pub token_mint: Box<Account<'info, Mint>>,
    /// CHECK: Switchboard randomness account parsed and owner-checked in the handler
    pub randomness: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RefundExpiredBet<'info> {
    /// Permissionless caller (pays tx fee). Funds always go to bet.player.
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"config", config.token_mint.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
    #[account(
        mut,
        close = player,
        has_one = config @ CoinflipError::WrongConfig,
        has_one = player @ CoinflipError::WrongPlayer,
        seeds = [b"bet", bet.player.as_ref(), bet.nonce.to_le_bytes().as_ref()],
        bump = bet.bump
    )]
    pub bet: Box<Account<'info, Bet>>,
    /// CHECK: recipient of rent + refund; validated by `has_one = player` on `bet`.
    #[account(mut)]
    pub player: UncheckedAccount<'info>,
    #[account(mut, constraint = treasury_vault.key() == config.treasury_vault @ CoinflipError::WrongVault)]
    pub treasury_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = player_token_account.mint == config.token_mint @ CoinflipError::WrongMint,
        constraint = player_token_account.owner == bet.player @ CoinflipError::WrongOwner
    )]
    pub player_token_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: Switchboard randomness account parsed and owner-checked in the handler
    pub randomness: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct DepositSolTreasury<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(has_one = admin, seeds = [b"config", config.token_mint.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
    #[account(mut, seeds = [b"sol_vault", config.key().as_ref()], bump = sol_vault.bump)]
    pub sol_vault: Box<Account<'info, SolVault>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawSolTreasury<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, has_one = admin, seeds = [b"config", config.token_mint.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
    #[account(mut, seeds = [b"sol_vault", config.key().as_ref()], bump = sol_vault.bump)]
    pub sol_vault: Box<Account<'info, SolVault>>,
}

#[derive(Accounts)]
pub struct PlaceBetSol<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(mut, seeds = [b"config", config.token_mint.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
    #[account(
        init_if_needed,
        payer = player,
        space = 8 + PlayerState::INIT_SPACE,
        seeds = [b"player", config.key().as_ref(), player.key().as_ref()],
        bump
    )]
    pub player_state: Box<Account<'info, PlayerState>>,
    #[account(
        init,
        payer = player,
        space = 8 + Bet::INIT_SPACE,
        seeds = [b"bet", player.key().as_ref(), player_state.nonce.to_le_bytes().as_ref()],
        bump
    )]
    pub bet: Box<Account<'info, Bet>>,
    #[account(mut, seeds = [b"sol_vault", config.key().as_ref()], bump = sol_vault.bump)]
    pub sol_vault: Box<Account<'info, SolVault>>,
    /// CHECK: Switchboard randomness account parsed and owner-checked in the handler
    pub randomness: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleBetSol<'info> {
    /// Permissionless crank/fee payer; outcome is computed by the program.
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"config", config.token_mint.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
    #[account(
        mut,
        close = player,
        has_one = config @ CoinflipError::WrongConfig,
        has_one = player @ CoinflipError::WrongPlayer,
        seeds = [b"bet", bet.player.as_ref(), bet.nonce.to_le_bytes().as_ref()],
        bump = bet.bump
    )]
    pub bet: Box<Account<'info, Bet>>,
    /// CHECK: recipient of the bet's rent + payout; validated by `has_one = player` on `bet`.
    #[account(mut)]
    pub player: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"sol_vault", config.key().as_ref()], bump = sol_vault.bump)]
    pub sol_vault: Box<Account<'info, SolVault>>,
    /// CHECK: exact SOL team fee wallet snapshotted on the bet.
    #[account(mut, address = bet.fee_team_recipient @ CoinflipError::WrongFeeRecipient)]
    pub team_sol_wallet: UncheckedAccount<'info>,
    /// CHECK: exact SOL dev/buyback fee wallet snapshotted on the bet.
    #[account(mut, address = bet.fee_dev_recipient @ CoinflipError::WrongFeeRecipient)]
    pub dev_buyback_sol_wallet: UncheckedAccount<'info>,
    /// CHECK: exact SOL holder rewards fee wallet snapshotted on the bet.
    #[account(mut, address = bet.fee_holder_rewards_recipient @ CoinflipError::WrongFeeRecipient)]
    pub holder_rewards_sol_wallet: UncheckedAccount<'info>,
    /// CHECK: Switchboard randomness account parsed and owner-checked in the handler
    pub randomness: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct RefundExpiredBetSol<'info> {
    /// Permissionless caller (pays tx fee). Funds always go to bet.player.
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"config", config.token_mint.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, GameConfig>>,
    #[account(
        mut,
        close = player,
        has_one = config @ CoinflipError::WrongConfig,
        has_one = player @ CoinflipError::WrongPlayer,
        seeds = [b"bet", bet.player.as_ref(), bet.nonce.to_le_bytes().as_ref()],
        bump = bet.bump
    )]
    pub bet: Box<Account<'info, Bet>>,
    /// CHECK: recipient of rent + refund; validated by `has_one = player` on `bet`.
    #[account(mut)]
    pub player: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"sol_vault", config.key().as_ref()], bump = sol_vault.bump)]
    pub sol_vault: Box<Account<'info, SolVault>>,
    /// CHECK: Switchboard randomness account parsed and owner-checked in the handler
    pub randomness: AccountInfo<'info>,
}

// ----------------------------------------------------------------------------
// Events
// ----------------------------------------------------------------------------
#[event]
pub struct ConfigInitialized {
    pub config: Pubkey,
    pub admin: Pubkey,
    pub token_mint: Pubkey,
    pub settle_authority: Pubkey,
    pub seed_hash: [u8; 32],
}

#[event]
pub struct SeedRotated {
    pub config: Pubkey,
    pub seed_epoch: u64,
    pub new_seed_hash: [u8; 32],
}

#[event]
pub struct BetPlaced {
    pub config: Pubkey,
    pub player: Pubkey,
    pub nonce: u64,
    pub amount: u64,
    pub fee_team_recipient: Pubkey,
    pub fee_dev_recipient: Pubkey,
    pub fee_holder_rewards_recipient: Pubkey,
    pub player_win_payout_bps: u16,
    pub player_win_payout: u64,
    pub total_fee_amount: u64,
    pub team_fee_amount: u64,
    pub dev_fee_amount: u64,
    pub burn_fee_amount: u64,
    pub holder_rewards_fee_amount: u64,
    pub total_win_liability: u64,
    pub choice: u8,
    pub client_seed: [u8; 32],
    pub seed_hash: [u8; 32],
    pub seed_epoch: u64,
    pub placed_slot: u64,
    pub randomness_account: Pubkey,
    pub commit_slot: u64,
}

#[event]
pub struct BetSettled {
    pub config: Pubkey,
    pub player: Pubkey,
    pub nonce: u64,
    pub amount: u64,
    pub fee_team_recipient: Pubkey,
    pub fee_dev_recipient: Pubkey,
    pub fee_holder_rewards_recipient: Pubkey,
    pub player_win_payout_bps: u16,
    pub player_win_payout: u64,
    pub total_fee_amount: u64,
    pub team_fee_amount: u64,
    pub dev_fee_amount: u64,
    pub burn_fee_amount: u64,
    pub holder_rewards_fee_amount: u64,
    pub total_win_liability: u64,
    pub choice: u8,
    pub result_bit: u8,
    pub won: bool,
    pub asset: u8,
    pub randomness_account: Pubkey,
}

#[event]
pub struct BetRefunded {
    pub config: Pubkey,
    pub player: Pubkey,
    pub amount: u64,
}

#[event]
pub struct AdminTransferProposed {
    pub config: Pubkey,
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
}
#[event]
pub struct AdminTransferred {
    pub config: Pubkey,
    pub old_admin: Pubkey,
    pub new_admin: Pubkey,
}
#[event]
pub struct AdminTransferCancelled {
    pub config: Pubkey,
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
}

// ----------------------------------------------------------------------------
// Errors
// ----------------------------------------------------------------------------
#[error_code]
pub enum CoinflipError {
    #[msg("Fee basis points exceed the maximum allowed")]
    FeeTooHigh,
    #[msg("Invalid per-bet payout cap")]
    InvalidPayoutCap,
    #[msg("Invalid min/max bet limits")]
    InvalidBetLimits,
    #[msg("Amount must be non-zero")]
    ZeroAmount,
    #[msg("Choice must be 0 (heads) or 1 (tails)")]
    InvalidChoice,
    #[msg("Bet amount outside configured limits")]
    BetOutsideLimits,
    #[msg("Bet payout exceeds the per-bet cap relative to the treasury")]
    BetExceedsPayoutCap,
    #[msg("Treasury cannot cover the required payout")]
    InsufficientTreasury,
    #[msg("Outstanding liability underflow")]
    LiabilityUnderflow,
    #[msg("Game is paused")]
    GamePaused,
    #[msg("Bet has not yet expired")]
    BetNotExpired,
    #[msg("Unauthorized signer")]
    Unauthorized,
    #[msg("Wrong treasury vault account")]
    WrongVault,
    #[msg("Wrong token mint")]
    WrongMint,
    #[msg("Wrong token account owner")]
    WrongOwner,
    #[msg("Bet does not belong to this config")]
    WrongConfig,
    #[msg("Bet does not belong to this player")]
    WrongPlayer,
    #[msg("Bet asset does not match this instruction")]
    WrongAsset,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Invalid player win payout basis points")]
    InvalidPlayerWinPayoutBps,
    #[msg("Wager too small after fee/payout rounding")]
    DustWager,
    #[msg("Fee recipient does not match the bet snapshot")]
    WrongFeeRecipient,
    #[msg("Randomness account does not match the bet commitment")]
    WrongRandomnessAccount,
    #[msg("Randomness is not ready")]
    RandomnessNotReady,
    #[msg("Randomness is already ready; settle instead of refund")]
    RandomnessAlreadyReady,
    #[msg("Randomness account owner is not the Switchboard On-Demand program")]
    InvalidRandomnessOwner,
    #[msg("Invalid Switchboard randomness account data")]
    InvalidRandomnessAccount,
    #[msg("Randomness has not been committed")]
    RandomnessNotCommitted,
    #[msg("Randomness commit is stale or from a future slot")]
    RandomnessExpired,
    #[msg("Randomness seed slot does not match the stored bet commit slot")]
    RandomnessSeedSlotMismatch,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(not(feature = "mainnet"))]
    fn default_build_accepts_only_devnet_switchboard_owner() {
        assert_eq!(
            expected_switchboard_program_id(),
            get_sb_program_id("devnet")
        );
        assert_ne!(
            expected_switchboard_program_id(),
            get_sb_program_id("mainnet")
        );
    }

    #[test]
    fn default_payout_math_reserves_payout_plus_fee() {
        let fee = compute_total_fee(10_000, 1_000).unwrap();
        let payout = compute_player_win_payout(10_000, DEFAULT_PLAYER_WIN_PAYOUT_BPS).unwrap();
        assert_eq!(payout, 17_800);
        assert_eq!(compute_total_win_liability(payout, fee).unwrap(), 18_800);
        assert_eq!(compute_expected_vault_edge_bps(1_000, 17_800).unwrap(), 100);
    }

    #[test]
    fn rejects_payout_plus_fee_over_twenty_thousand_bps() {
        assert!(validate_payout_config(1_000, 19_001).is_err());
        assert!(validate_payout_config(1_000, 19_000).is_ok());
    }

    #[test]
    #[cfg(feature = "mainnet")]
    fn mainnet_build_accepts_only_mainnet_switchboard_owner() {
        assert_eq!(
            expected_switchboard_program_id(),
            get_sb_program_id("mainnet")
        );
        assert_ne!(
            expected_switchboard_program_id(),
            get_sb_program_id("devnet")
        );
    }
}
