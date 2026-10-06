use anchor_lang::prelude::*;
use crate::mplcore::{candy_machine_view, lock_asset_metadata, reveal_leaf, reveal_root_of, update_asset, MplCore};
use crate::errors::EscrowError;
use crate::events::Revealed;
use crate::state::*;

/// Anyone may reveal an asset, but only to the metadata committed at init (round 4, L-013): the name and URI must be the
/// leaf for the asset's mint number under the escrow's reveal root. Once per asset, and only once minting is over (the
/// machine sold out, the window ended, or the escrow is no longer open: L-025), so nobody can learn which mint numbers are
/// the rare ones while they can still be minted. The revealed asset is then locked (ImmutableMetadata, no authority): nobody,
/// the creator included, can change its name or URI again, before or after the collection goes back (owner decision).
#[derive(Accounts)]
pub struct Reveal<'info> {
    #[account(mut, seeds = [ESCROW_SEED, escrow.candy_machine.as_ref()], bump = escrow.bump, has_one = collection @ EscrowError::WrongCollection, has_one = candy_machine @ EscrowError::BadMachine)]
    pub escrow: Box<Account<'info, LaunchEscrow>>,
    #[account(mut, seeds = [RECEIPT_SEED, escrow.key().as_ref(), receipt.asset.as_ref()], bump = receipt.bump, has_one = escrow, has_one = asset @ EscrowError::AssetUnreadable)]
    pub receipt: Box<Account<'info, MintReceipt>>,
    /// CHECK: the receipt's asset; MPL Core validates the update.
    #[account(mut)]
    pub asset: UncheckedAccount<'info>,
    /// CHECK: the escrow's collection (has_one); written by Core when the asset gains its lock.
    #[account(mut)]
    pub collection: UncheckedAccount<'info>,
    /// CHECK: the escrow's machine (has_one), read for its redeemed count.
    pub candy_machine: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub mpl_core_program: Program<'info, MplCore>,
    pub system_program: Program<'info, System>,
}

pub fn reveal(ctx: Context<Reveal>, name: String, uri: String, proof: Vec<[u8; 32]>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let e = &ctx.accounts.escrow;
    require!(e.has_reveal(), EscrowError::NoReveal);
    require!(!e.collection_returned, EscrowError::CollectionReturned);
    let r = &ctx.accounts.receipt;
    require!(!r.revealed && !r.refunded, EscrowError::AlreadyRevealed);
    require!(name.len() <= 32 && uri.len() <= 200 && proof.len() <= MAX_PROOF, EscrowError::BadConfig);
    let redeemed = candy_machine_view(&ctx.accounts.candy_machine.try_borrow_data()?)?.items_redeemed;
    let minting_over = e.status != EscrowStatus::Open || now >= e.window_end || redeemed >= e.items_available;
    require!(minting_over, EscrowError::MintingNotOver);
    require!(reveal_root_of(reveal_leaf(r.mint_index, &name, &uri), &proof) == e.reveal_root, EscrowError::BadRevealProof);
    let seeds = e.signer_seeds();
    let seed_refs: Vec<&[u8]> = seeds.iter().map(|s| s.as_slice()).collect();
    update_asset(&ctx.accounts.asset.to_account_info(), &ctx.accounts.collection.to_account_info(), &ctx.accounts.payer.to_account_info(), &e.to_account_info(), &ctx.accounts.system_program.to_account_info(), &ctx.accounts.mpl_core_program.to_account_info(), &[&seed_refs], Some(name), Some(uri))?;
    lock_asset_metadata(&ctx.accounts.asset.to_account_info(), &ctx.accounts.collection.to_account_info(), &ctx.accounts.payer.to_account_info(), &e.to_account_info(), &ctx.accounts.system_program.to_account_info(), &ctx.accounts.mpl_core_program.to_account_info(), &[&seed_refs])?;
    let asset = r.asset;
    let mint_index = r.mint_index;
    ctx.accounts.receipt.revealed = true;
    let e = &mut ctx.accounts.escrow;
    e.revealed = e.revealed.checked_add(1).ok_or(EscrowError::Overflow)?;
    emit!(Revealed { escrow: e.key(), asset, mint_index });
    Ok(())
}
