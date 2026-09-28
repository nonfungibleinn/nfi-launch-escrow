use anchor_lang::prelude::*;
use crate::errors::EscrowError;
use crate::state::*;

/// A plain system wallet that can take a lamport credit: not a program, not a sysvar, not one of ours.
pub fn plain_wallet(a: &AccountInfo) -> Result<()> {
    require!(a.owner == &anchor_lang::system_program::ID && !a.executable && a.data_is_empty(), EscrowError::BadWallet);
    Ok(())
}

/// One per deployment, created only by the program's upgrade authority (review 1, finding 2). Holds NFI's authority
/// and the treasury; every escrow reads both from here at init, never from arguments. Do this right after the deploy,
/// before any change to the upgrade authority: a finalised program with no config can never be used.
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
    /// CHECK: the treasury wallet, checked to be a plain system account.
    pub treasury: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn init_config(ctx: Context<InitConfig>, nfi_authority: Pubkey) -> Result<()> {
    require!(nfi_authority != Pubkey::default(), EscrowError::BadConfig);
    plain_wallet(&ctx.accounts.treasury)?;
    let c = &mut ctx.accounts.config;
    c.authority = ctx.accounts.authority.key();
    c.pending_authority = None;
    c.nfi_authority = nfi_authority;
    c.treasury = ctx.accounts.treasury.key();
    c.bump = ctx.bumps.config;
    Ok(())
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ EscrowError::NotAuthority)]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ EscrowError::NotAuthority)]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
    /// CHECK: the new treasury wallet, checked to be a plain system account.
    pub treasury: UncheckedAccount<'info>,
}

/// A new NFI signer (revokes the old one on every live escrow at once) or a new treasury for escrows created from now on.
pub fn update_config(ctx: Context<UpdateConfig>, nfi_authority: Pubkey) -> Result<()> {
    require!(nfi_authority != Pubkey::default(), EscrowError::BadConfig);
    plain_wallet(&ctx.accounts.treasury)?;
    let c = &mut ctx.accounts.config;
    c.nfi_authority = nfi_authority;
    c.treasury = ctx.accounts.treasury.key();
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
    Ok(())
}
