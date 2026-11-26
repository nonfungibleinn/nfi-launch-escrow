use anchor_lang::prelude::*;
use crate::mplcore::{asset_gone, asset_owner_and_collection, burn, MplCore, MPL_CORE_ID};
use crate::errors::EscrowError;
use crate::events::Refunded;
use crate::instructions::debit;
use crate::state::*;

/// After a cancel. While the asset exists, its current owner signs and the asset is burned in this same instruction;
/// the payment goes to that owner (whoever gives the NFT back is made whole, so a secondary buyer is never trapped),
/// and the receipt's rent goes back to the original minter. Once the asset is the one-byte shell Core leaves after a
/// burn (or anything Core no longer owns), anyone may crank the refund, which pays the original minter. While the
/// escrow holds the collection a live asset must be in it; once the collection has gone back to the creator a holder
/// whose asset was moved out of it is still made whole (review 2, finding 1c).
#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut, seeds = [ESCROW_SEED, escrow.candy_machine.as_ref()], bump = escrow.bump)]
    pub escrow: Box<Account<'info, LaunchEscrow>>,
    #[account(mut, seeds = [VAULT_SEED, escrow.key().as_ref()], bump = escrow.vault_bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut, close = minter, seeds = [RECEIPT_SEED, escrow.key().as_ref(), receipt.asset.as_ref()], bump = receipt.bump, has_one = escrow, has_one = minter)]
    pub receipt: Account<'info, MintReceipt>,
    /// CHECK: the original minter named on the receipt; receives the rent, and the payment when the asset is already gone.
    #[account(mut)]
    pub minter: UncheckedAccount<'info>,
    /// CHECK: the asset on the receipt (address checked); MPL Core validates the burn.
    #[account(mut, constraint = asset.key() == receipt.asset @ EscrowError::AssetUnreadable)]
    pub asset: UncheckedAccount<'info>,
    /// CHECK: the asset's own collection (read from the asset), or MPL Core's id when it has none.
    #[account(mut)]
    pub collection: UncheckedAccount<'info>,
    /// The asset's owner while it exists (receives the payment); anyone once it is gone. Pays the burn's network fee.
    #[account(mut)]
    pub signer: Signer<'info>,
    pub mpl_core_program: Program<'info, MplCore>,
    pub system_program: Program<'info, System>,
}

pub fn refund(ctx: Context<Refund>) -> Result<()> {
    let e = &mut ctx.accounts.escrow;
    require!(e.status == EscrowStatus::Cancelled, EscrowError::NotCancelled);
    let r = &ctx.accounts.receipt;
    require!(!r.refunded, EscrowError::AlreadyRefunded);
    let asset = &ctx.accounts.asset;
    // A live AssetV1 is burned here; Core's one-byte shell after a burn, or an address Core no longer owns (what its
    // permissionless Collect leaves: round 4, L-005), is a gone asset and pays the original minter.
    let (exists, owner_now) = if asset_gone(&asset.to_account_info())? { (false, Pubkey::default()) } else {
        let data = asset.try_borrow_data()?;
        let (owner, coll) = asset_owner_and_collection(&data)?;
        // While the escrow holds the collection nothing can leave it, so a live asset here that is not in it was
        // created at a burned asset's address by whoever kept its keypair: it earns no refund (0.5.3).
        require!(e.collection_returned || coll == Some(e.collection), EscrowError::WrongCollection);
        let want = coll.unwrap_or(MPL_CORE_ID);
        require!(ctx.accounts.collection.key() == want, EscrowError::WrongCollection);
        (true, owner)
    };
    let amount = r.price.checked_add(r.fee).ok_or(EscrowError::Overflow)?;
    let paid_to = if exists {
        require!(ctx.accounts.signer.key() == owner_now, EscrowError::NotOwner);
        burn(&asset.to_account_info(), &ctx.accounts.collection.to_account_info(), &ctx.accounts.signer.to_account_info(), &ctx.accounts.system_program.to_account_info(), &ctx.accounts.mpl_core_program.to_account_info())?;
        debit(&ctx.accounts.vault.to_account_info(), &ctx.accounts.signer.to_account_info(), amount)?;
        owner_now
    } else {
        debit(&ctx.accounts.vault.to_account_info(), &ctx.accounts.minter.to_account_info(), amount)?;
        r.minter
    };
    e.price_refunded = e.price_refunded.checked_add(r.price).ok_or(EscrowError::Overflow)?;
    e.fee_refunded = e.fee_refunded.checked_add(r.fee).ok_or(EscrowError::Overflow)?;
    e.receipts_open = e.receipts_open.checked_sub(1).ok_or(EscrowError::Overflow)?;
    let asset_key = r.asset;
    let minter = r.minter;
    ctx.accounts.receipt.refunded = true;
    emit!(Refunded { escrow: e.key(), asset: asset_key, minter, paid_to, amount, burned: exists });
    Ok(())
}
