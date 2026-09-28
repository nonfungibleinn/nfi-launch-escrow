use anchor_lang::prelude::*;
use crate::mplcore::{hand_collection, MplCore};
use crate::errors::EscrowError;
use crate::events::{CollectionReturned, FeeReleased, Released, StatusChanged};
use crate::instructions::debit;
use crate::state::*;

/// Anyone, once the window has ended and the escrow is still Open: the prices go to the payout wallet fixed at init.
/// Permissionless, so no party's absence can hold the creator's money. The fee is its own leg (release_fee), so a
/// treasury that cannot take a credit can never hold the creator's share (review 2, finding 3).
#[derive(Accounts)]
pub struct Release<'info> {
    #[account(mut, seeds = [ESCROW_SEED, escrow.candy_machine.as_ref()], bump = escrow.bump, has_one = payout)]
    pub escrow: Account<'info, LaunchEscrow>,
    #[account(mut, seeds = [VAULT_SEED, escrow.key().as_ref()], bump = escrow.vault_bump)]
    pub vault: Account<'info, Vault>,
    /// CHECK: the payout wallet fixed at init (has_one).
    #[account(mut)]
    pub payout: UncheckedAccount<'info>,
    pub signer: Signer<'info>,
}

pub fn release(ctx: Context<Release>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let e = &mut ctx.accounts.escrow;
    require!(e.status == EscrowStatus::Open, EscrowError::NotOpen);
    require!(now >= e.window_end, EscrowError::WindowNotOver);
    let to_payout = e.price_in.checked_sub(e.price_refunded).ok_or(EscrowError::Overflow)?;
    if to_payout > 0 { debit(&ctx.accounts.vault.to_account_info(), &ctx.accounts.payout.to_account_info(), to_payout)?; }
    e.status = EscrowStatus::Released;
    emit!(Released { escrow: e.key(), to_payout });
    emit!(StatusChanged { escrow: e.key(), status: EscrowStatus::Released, by: CancelledBy::Nobody });
    Ok(())
}

/// Anyone, after the release: the fees go to the treasury fixed at init. Once.
#[derive(Accounts)]
pub struct ReleaseFee<'info> {
    #[account(mut, seeds = [ESCROW_SEED, escrow.candy_machine.as_ref()], bump = escrow.bump, has_one = treasury)]
    pub escrow: Account<'info, LaunchEscrow>,
    #[account(mut, seeds = [VAULT_SEED, escrow.key().as_ref()], bump = escrow.vault_bump)]
    pub vault: Account<'info, Vault>,
    /// CHECK: the treasury fixed at init (has_one).
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    pub signer: Signer<'info>,
}

pub fn release_fee(ctx: Context<ReleaseFee>) -> Result<()> {
    let e = &mut ctx.accounts.escrow;
    require!(e.status == EscrowStatus::Released, EscrowError::NotReleased);
    require!(!e.fee_released, EscrowError::AlreadyReleased);
    let to_treasury = e.fee_in.checked_sub(e.fee_refunded).ok_or(EscrowError::Overflow)?;
    if to_treasury > 0 { debit(&ctx.accounts.vault.to_account_info(), &ctx.accounts.treasury.to_account_info(), to_treasury)?; }
    e.fee_released = true;
    emit!(FeeReleased { escrow: e.key(), to_treasury });
    Ok(())
}

/// Anyone, once the escrow is final: the collection's update authority goes back to the creator fixed at init
/// (permissionless, so a lost creator key never leaves a collection in escrow: review 3, finding 5). On the cancelled
/// path the collection stays under the escrow for as long as a receipt is unclaimed, so a burn can never be blocked
/// while a refund is still owed; that is the price of refunds that never expire.
#[derive(Accounts)]
pub struct ReturnCollection<'info> {
    #[account(mut, seeds = [ESCROW_SEED, escrow.candy_machine.as_ref()], bump = escrow.bump, has_one = creator @ EscrowError::NotCreator, has_one = collection @ EscrowError::WrongCollection)]
    pub escrow: Account<'info, LaunchEscrow>,
    /// CHECK: the escrow's collection (has_one); MPL Core validates the update.
    #[account(mut)]
    pub collection: UncheckedAccount<'info>,
    /// CHECK: the creator fixed at init (has_one); receives the update authority.
    pub creator: UncheckedAccount<'info>,
    /// Pays the network fee; anyone.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub mpl_core_program: Program<'info, MplCore>,
    pub system_program: Program<'info, System>,
}

pub fn return_collection(ctx: Context<ReturnCollection>) -> Result<()> {
    let e = &ctx.accounts.escrow;
    let final_ = e.status == EscrowStatus::Released || (e.status == EscrowStatus::Cancelled && e.receipts_open == 0);
    require!(final_, EscrowError::NotFinal);
    require!(!e.collection_returned, EscrowError::AlreadyReleased);
    let seeds = e.signer_seeds();
    let seed_refs: Vec<&[u8]> = seeds.iter().map(|s| s.as_slice()).collect();
    hand_collection(&ctx.accounts.collection.to_account_info(), &ctx.accounts.payer.to_account_info(), &e.to_account_info(), &ctx.accounts.creator.to_account_info(), &ctx.accounts.system_program.to_account_info(), &ctx.accounts.mpl_core_program.to_account_info(), &[&seed_refs])?;
    let e = &mut ctx.accounts.escrow;
    e.collection_returned = true;
    emit!(CollectionReturned { escrow: e.key(), collection: e.collection, to: e.creator });
    Ok(())
}
