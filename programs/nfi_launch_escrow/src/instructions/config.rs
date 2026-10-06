use anchor_lang::prelude::*;
use crate::errors::EscrowError;
use crate::events::ConfigChanged;
use crate::state::*;

/// A plain system wallet that can take a lamport credit: not a program, not a sysvar, not one of ours, and already
/// rent-exempt, so a credit smaller than the rent minimum can never be refused (round 4, L-036).
pub fn plain_wallet(a: &AccountInfo) -> Result<()> {
    require!(a.owner == &anchor_lang::system_program::ID && !a.executable && a.data_is_empty(), EscrowError::BadWallet);
    require!(a.lamports() >= Rent::get()?.minimum_balance(0), EscrowError::WalletUnfunded);
    Ok(())
}

/// One per deployment, created only by the program's upgrade authority (review 1, finding 2). Holds NFI's keys and the
/// treasury; every escrow reads them from here, never from arguments. Do this right after the deploy, before any change
/// to the upgrade authority: a finalised program with no config can never be used.
#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, crate::program::NfiLaunchEscrow>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ EscrowError::NotAuthority)]
    pub program_data: Account<'info, ProgramData>,
    /// CHECK: the treasury wallet, checked to be a plain, funded system account.
    pub treasury: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn init_config(ctx: Context<InitConfig>, nfi_authority: Pubkey, canceller: Pubkey) -> Result<()> {
    require!(nfi_authority != Pubkey::default() && canceller != Pubkey::default() && nfi_authority != canceller, EscrowError::BadConfig);
    plain_wallet(&ctx.accounts.treasury)?;
    let c = &mut ctx.accounts.config;
    c.authority = ctx.accounts.authority.key();
    c.pending_authority = None;
    c.nfi_authority = nfi_authority;
    c.canceller = canceller;
    c.treasury = ctx.accounts.treasury.key();
    c.bump = ctx.bumps.config;
    emit!(ConfigChanged { authority: c.authority, nfi_authority, canceller, treasury: c.treasury });
    Ok(())
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ EscrowError::NotAuthority)]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
}

/// A new hot NFI key: revokes the old one on every live escrow at once (pause, permit rotation, phase changes, inits).
pub fn set_nfi_authority(ctx: Context<AdminConfig>, nfi_authority: Pubkey) -> Result<()> {
    let c = &mut ctx.accounts.config;
    require!(nfi_authority != Pubkey::default() && nfi_authority != c.canceller, EscrowError::BadConfig);
    c.nfi_authority = nfi_authority;
    emit!(ConfigChanged { authority: c.authority, nfi_authority: c.nfi_authority, canceller: c.canceller, treasury: c.treasury });
    Ok(())
}

/// A new canceller (the cold key that may cancel any open launch).
pub fn set_canceller(ctx: Context<AdminConfig>, canceller: Pubkey) -> Result<()> {
    let c = &mut ctx.accounts.config;
    require!(canceller != Pubkey::default() && canceller != c.nfi_authority, EscrowError::BadConfig);
    c.canceller = canceller;
    emit!(ConfigChanged { authority: c.authority, nfi_authority: c.nfi_authority, canceller: c.canceller, treasury: c.treasury });
    Ok(())
}

#[derive(Accounts)]
pub struct SetTreasury<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ EscrowError::NotAuthority)]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
    /// CHECK: the new treasury wallet, checked to be a plain, funded system account.
    pub treasury: UncheckedAccount<'info>,
}

/// A new treasury, for escrows created from now on (each escrow keeps the treasury it was created with).
pub fn set_treasury(ctx: Context<SetTreasury>) -> Result<()> {
    plain_wallet(&ctx.accounts.treasury)?;
    let c = &mut ctx.accounts.config;
    c.treasury = ctx.accounts.treasury.key();
    emit!(ConfigChanged { authority: c.authority, nfi_authority: c.nfi_authority, canceller: c.canceller, treasury: c.treasury });
    Ok(())
}

pub fn propose_authority(ctx: Context<AdminConfig>, new_authority: Option<Pubkey>) -> Result<()> {
    ctx.accounts.config.pending_authority = new_authority;
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, constraint = config.pending_authority == Some(new_authority.key()) @ EscrowError::NotAuthority)]
    pub config: Account<'info, Config>,
    pub new_authority: Signer<'info>,
}

pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
    let c = &mut ctx.accounts.config;
    c.authority = ctx.accounts.new_authority.key();
    c.pending_authority = None;
    emit!(ConfigChanged { authority: c.authority, nfi_authority: c.nfi_authority, canceller: c.canceller, treasury: c.treasury });
    Ok(())
}
