use anchor_lang::prelude::*;
use crate::errors::EscrowError;
use crate::state::*;

/// After a release a receipt has nothing left to do: anyone may close it and its rent goes back to the minter.
/// (On the cancelled path the refund closes it.)
#[derive(Accounts)]
pub struct CloseReceipt<'info> {
    #[account(mut, seeds = [ESCROW_SEED, escrow.candy_machine.as_ref()], bump = escrow.bump)]
    pub escrow: Account<'info, LaunchEscrow>,
    #[account(mut, close = minter, seeds = [RECEIPT_SEED, escrow.key().as_ref(), receipt.asset.as_ref()], bump = receipt.bump, has_one = escrow, has_one = minter)]
    pub receipt: Account<'info, MintReceipt>,
    /// CHECK: the receipt names the minter; rent goes here.
    #[account(mut)]
    pub minter: UncheckedAccount<'info>,
    pub signer: Signer<'info>,
}

pub fn close_receipt(ctx: Context<CloseReceipt>) -> Result<()> {
    let e = &mut ctx.accounts.escrow;
    require!(e.status == EscrowStatus::Released, EscrowError::NotFinal);
    e.receipts_open = e.receipts_open.checked_sub(1).ok_or(EscrowError::Overflow)?;
    Ok(())
}

/// The creator, once the escrow is final (Released, or Cancelled with every receipt refunded) and the vault holds
/// nothing but its rent: both accounts close and their rent returns to the creator. A cancelled escrow with an
/// unclaimed receipt stays open, by design: refunds never expire.
#[derive(Accounts)]
pub struct CloseEscrow<'info> {
    #[account(mut, close = creator, seeds = [ESCROW_SEED, escrow.candy_machine.as_ref()], bump = escrow.bump, has_one = creator @ EscrowError::NotCreator)]
    pub escrow: Account<'info, LaunchEscrow>,
    #[account(mut, close = creator, seeds = [VAULT_SEED, escrow.key().as_ref()], bump = escrow.vault_bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub creator: Signer<'info>,
}

pub fn close_escrow(ctx: Context<CloseEscrow>) -> Result<()> {
    let e = &ctx.accounts.escrow;
    require!(e.status != EscrowStatus::Open, EscrowError::NotFinal);
    require!(e.receipts_open == 0, EscrowError::ReceiptsOpen);
    let rent_min = Rent::get()?.minimum_balance(ctx.accounts.vault.to_account_info().data_len());
    require!(ctx.accounts.vault.to_account_info().lamports() <= rent_min, EscrowError::VaultNotEmpty);
    Ok(())
}
