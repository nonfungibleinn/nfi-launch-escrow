use anchor_lang::prelude::*;
use crate::errors::EscrowError;
use crate::state::*;

/// One per deployment, created only by the program's upgrade authority (review 1, finding 2: without a known NFI key
/// anyone could init an escrow for any candy machine and squat its address). Holds NFI's authority and the treasury;
/// every escrow reads both from here at init, never from arguments.
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
    pub system_program: Program<'info, System>,
}

pub fn init_config(ctx: Context<InitConfig>, nfi_authority: Pubkey, treasury: Pubkey) -> Result<()> {
    require!(nfi_authority != Pubkey::default() && treasury != Pubkey::default(), EscrowError::BadConfig);
    let c = &mut ctx.accounts.config;
    c.authority = ctx.accounts.authority.key();
    c.pending_authority = None;
    c.nfi_authority = nfi_authority;
    c.treasury = treasury;
    c.bump = ctx.bumps.config;
    Ok(())
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ EscrowError::NotAuthority)]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
}

/// New NFI signer or treasury for escrows created from now on; existing escrows keep what they were born with.
pub fn update_config(ctx: Context<AdminConfig>, nfi_authority: Pubkey, treasury: Pubkey) -> Result<()> {
    require!(nfi_authority != Pubkey::default() && treasury != Pubkey::default(), EscrowError::BadConfig);
    let c = &mut ctx.accounts.config;
    c.nfi_authority = nfi_authority;
    c.treasury = treasury;
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
