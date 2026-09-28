//! NFI Launchpad escrow. Each launch's mint payments (price and NFI's fee) sit in a program-owned vault until the
//! window ends; then anyone may release them to the payout wallet and the treasury fixed at init. If NFI or the
//! creator cancels first, every payment may be taken back, forever, by burning the asset in the same instruction.
//! NFI can cancel and pause, and can never receive funds from this program except the fee after a release. Each payment
//! is bound on chain to the mint of its asset in the same transaction, and the escrow holds the collection's update
//! authority while refunds are possible. See the Launchpad blueprint, "Phase 2b design".
#![allow(clippy::too_many_arguments)]
#![allow(deprecated)]

use anchor_lang::prelude::*;

pub mod mplcore;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("3qRS59TJmgaNUzKjKsUe3XGggodSXA9GHU9Q5u2ffE1n");

#[program]
pub mod nfi_launch_escrow {
    use super::*;

    // ---- config: the upgrade authority creates it; the config authority rotates it ----
    pub fn init_config(ctx: Context<InitConfig>, nfi_authority: Pubkey) -> Result<()> { instructions::init_config(ctx, nfi_authority) }
    pub fn update_config(ctx: Context<UpdateConfig>, nfi_authority: Pubkey) -> Result<()> { instructions::update_config(ctx, nfi_authority) }
    pub fn propose_authority(ctx: Context<AdminConfig>, new_authority: Option<Pubkey>) -> Result<()> { instructions::propose_authority(ctx, new_authority) }
    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> { instructions::accept_authority(ctx) }

    /// The creator and NFI's authority (from the config) both sign: wallets, window and prices are fixed here and never change.
    pub fn init(ctx: Context<Init>, args: InitArgs) -> Result<()> { instructions::init(ctx, args) }
    /// In the mint transaction, before the mint of the same asset: the minter pays the group's price plus fee.
    pub fn pay(ctx: Context<Pay>, group: u8, amount: u64) -> Result<()> { instructions::pay(ctx, group, amount) }
    /// NFI (the config's current key) or the creator, while Open and before the window ends: refunds open, forever.
    pub fn cancel(ctx: Context<Cancel>) -> Result<()> { instructions::cancel(ctx) }
    /// NFI: blocks pay only; moves nothing.
    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> { instructions::set_paused(ctx, paused) }
    /// After a cancel: the asset's owner burns it and is paid in full; once it is gone, anyone cranks and the minter is paid.
    pub fn refund(ctx: Context<Refund>) -> Result<()> { instructions::refund(ctx) }
    /// Anyone, once the window ended: the vault pays the payout wallet.
    pub fn release(ctx: Context<Release>) -> Result<()> { instructions::release(ctx) }
    /// Anyone, after the release: the vault pays the treasury its fees.
    pub fn release_fee(ctx: Context<ReleaseFee>) -> Result<()> { instructions::release_fee(ctx) }
    /// The creator, while the escrow holds the collection: rename an asset or point it at new metadata (a reveal).
    pub fn update_asset(ctx: Context<UpdateAsset>, new_name: Option<String>, new_uri: Option<String>) -> Result<()> { instructions::update_asset_meta(ctx, new_name, new_uri) }
    /// The creator, once the escrow is final: the collection's update authority comes back.
    pub fn return_collection(ctx: Context<ReturnCollection>) -> Result<()> { instructions::return_collection(ctx) }
    /// Anyone, after a release: returns a receipt's rent to its minter.
    pub fn close_receipt(ctx: Context<CloseReceipt>) -> Result<()> { instructions::close_receipt(ctx) }
    /// The creator, once everything is final and returned: rent back.
    pub fn close_escrow(ctx: Context<CloseEscrow>) -> Result<()> { instructions::close_escrow(ctx) }
}
