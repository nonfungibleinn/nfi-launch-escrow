use anchor_lang::prelude::*;
use crate::errors::EscrowError;
use crate::events::{Released, StatusChanged};
use crate::instructions::debit;
use crate::state::*;

/// Anyone, once the window has ended and the escrow is still Open: the prices go to the payout wallet and the fees
/// to the treasury, both fixed at init. Permissionless, so no party's absence can hold the creator's money.
#[derive(Accounts)]
pub struct Release<'info> {
    #[account(mut, seeds = [ESCROW_SEED, escrow.candy_machine.as_ref()], bump = escrow.bump, has_one = payout, has_one = treasury)]
    pub escrow: Account<'info, LaunchEscrow>,
    #[account(mut, seeds = [VAULT_SEED, escrow.key().as_ref()], bump = escrow.vault_bump)]
    pub vault: Account<'info, Vault>,
    /// CHECK: the payout wallet fixed at init (has_one).
    #[account(mut)]
    pub payout: UncheckedAccount<'info>,
    /// CHECK: the treasury fixed at init (has_one).
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    pub signer: Signer<'info>,
}

pub fn release(ctx: Context<Release>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let e = &mut ctx.accounts.escrow;
    require!(e.status == EscrowStatus::Open, EscrowError::NotOpen);
    require!(now >= e.window_end, EscrowError::WindowNotOver);
    let to_payout = e.price_in.checked_sub(e.price_refunded).ok_or(EscrowError::Overflow)?;
    let to_treasury = e.fee_in.checked_sub(e.fee_refunded).ok_or(EscrowError::Overflow)?;
    if to_payout > 0 { debit(&ctx.accounts.vault.to_account_info(), &ctx.accounts.payout.to_account_info(), to_payout)?; }
    if to_treasury > 0 { debit(&ctx.accounts.vault.to_account_info(), &ctx.accounts.treasury.to_account_info(), to_treasury)?; }
    e.status = EscrowStatus::Released;
    emit!(Released { escrow: e.key(), to_payout, to_treasury });
    emit!(StatusChanged { escrow: e.key(), status: EscrowStatus::Released, by: CancelledBy::Nobody });
    Ok(())
}
