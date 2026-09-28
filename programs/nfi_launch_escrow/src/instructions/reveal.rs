use anchor_lang::prelude::*;
use crate::mplcore::{asset_owner_and_collection, update_asset, MplCore, MPL_CORE_ID};
use crate::errors::EscrowError;
use crate::state::*;

/// The creator renames an asset or points it at new metadata (a hidden reveal) while the escrow holds the collection's
/// update authority: the program signs the Core update for them. Name and URI only; never the update authority, never
/// a plugin. Refused after a cancel: nothing about a refundable asset changes until it is refunded.
#[derive(Accounts)]
pub struct UpdateAsset<'info> {
    #[account(seeds = [ESCROW_SEED, escrow.candy_machine.as_ref()], bump = escrow.bump, has_one = creator @ EscrowError::NotCreator, has_one = collection @ EscrowError::WrongCollection)]
    pub escrow: Account<'info, LaunchEscrow>,
    /// CHECK: a live Core asset in the escrow's collection (checked by hand); MPL Core validates the update.
    #[account(mut)]
    pub asset: UncheckedAccount<'info>,
    /// CHECK: the escrow's collection (has_one).
    pub collection: UncheckedAccount<'info>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub mpl_core_program: Program<'info, MplCore>,
    pub system_program: Program<'info, System>,
}

pub fn update_asset_meta(ctx: Context<UpdateAsset>, new_name: Option<String>, new_uri: Option<String>) -> Result<()> {
    let e = &ctx.accounts.escrow;
    require!(e.status != EscrowStatus::Cancelled, EscrowError::NotOpen);
    require!(new_name.as_ref().is_none_or(|s| s.len() <= 32) && new_uri.as_ref().is_none_or(|s| s.len() <= 200), EscrowError::BadConfig);
    let asset = &ctx.accounts.asset;
    require!(*asset.owner == MPL_CORE_ID, EscrowError::AssetUnreadable);
    {
        let data = asset.try_borrow_data()?;
        let (_, coll) = asset_owner_and_collection(&data)?;
        require!(coll == Some(e.collection), EscrowError::WrongCollection);
    }
    let seeds = e.signer_seeds();
    let seed_refs: Vec<&[u8]> = seeds.iter().map(|s| s.as_slice()).collect();
    update_asset(&asset.to_account_info(), &ctx.accounts.collection.to_account_info(), &ctx.accounts.creator.to_account_info(), &e.to_account_info(), &ctx.accounts.system_program.to_account_info(), &ctx.accounts.mpl_core_program.to_account_info(), &[&seed_refs], new_name, new_uri)?;
    Ok(())
}
