use anchor_lang::prelude::*;
use crate::errors::EscrowError;
use crate::state::*;

/// After a release (and the asset's reveal, if one is committed) a receipt has nothing left to do: anyone may close it and
/// its rent goes back to the minter.
/// (On the cancelled path the refund closes it.)
#[derive(Accounts)]
pub struct CloseReceipt<'info> {
    #[account(mut, seeds = [ESCROW_SEED, escrow.candy_machine.as_ref()], bump = escrow.bump)]
    pub escrow: Box<Account<'info, LaunchEscrow>>,
    #[account(mut, close = minter, seeds = [RECEIPT_SEED, escrow.key().as_ref(), receipt.asset.as_ref()], bump = receipt.bump, has_one = escrow, has_one = minter)]
    pub receipt: Account<'info, MintReceipt>,
    /// CHECK: the receipt names the minter; rent goes here.
    #[account(mut)]
    pub minter: UncheckedAccount<'info>,
    pub signer: Signer<'info>,
}

pub fn close_receipt(ctx: Context<CloseReceipt>) -> Result<()> {
    let r_revealed = ctx.accounts.receipt.revealed;
    let e = &mut ctx.accounts.escrow;
    require!(e.status == EscrowStatus::Released, EscrowError::NotFinal);
    // A receipt is the reveal's record of the asset's mint number: it stays until the asset is revealed or the
    // collection has gone back (round 4, L-013).
    require!(!e.has_reveal() || r_revealed || e.collection_returned, EscrowError::RevealPending);
    e.receipts_open = e.receipts_open.checked_sub(1).ok_or(EscrowError::Overflow)?;
    Ok(())
}

/// The creator, once the escrow is final (Released with the fee leg sent, or Cancelled with every receipt refunded), the
/// collection returned and every receipt closed: both accounts close and whatever the vault holds (its rent, plus any
/// stray lamports someone sent it) goes to the creator. A cancelled escrow with an unclaimed receipt stays open, by
/// design: refunds never expire.
#[derive(Accounts)]
pub struct CloseEscrow<'info> {
    #[account(mut, close = creator, seeds = [ESCROW_SEED, escrow.candy_machine.as_ref()], bump = escrow.bump, has_one = creator @ EscrowError::NotCreator)]
    pub escrow: Box<Account<'info, LaunchEscrow>>,
    #[account(mut, close = creator, seeds = [VAULT_SEED, escrow.key().as_ref()], bump = escrow.vault_bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub creator: Signer<'info>,
}

pub fn close_escrow(ctx: Context<CloseEscrow>) -> Result<()> {
    let e = &ctx.accounts.escrow;
    require!(e.status != EscrowStatus::Open, EscrowError::NotFinal);
    require!(e.receipts_open == 0, EscrowError::ReceiptsOpen);
    if e.status == EscrowStatus::Released { require!(e.fee_released || e.fee_in == e.fee_refunded, EscrowError::FeeNotReleased); }
    require!(e.collection_returned, EscrowError::NotFinal);
    Ok(())
}
