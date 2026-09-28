//! NFI Launchpad escrow. Each launch's mint payments (price and NFI's fee) sit in a program-owned vault until the
//! window ends; then anyone may release them to the payout wallet and the treasury fixed at init. If NFI or the
//! creator cancels first, every payment may be taken back, forever, by burning the asset in the same instruction.
//! NFI can cancel and pause, and can never receive funds from this program except the fee on a release. Each payment
//! is bound on chain to the mint of its asset in the same transaction. See the Launchpad blueprint, "Phase 2b design".
#![allow(clippy::too_many_arguments)]
#![allow(deprecated)]

use anchor_lang::prelude::*;

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
    pub fn init_config(ctx: Context<InitConfig>, nfi_authority: Pubkey, treasury: Pubkey) -> Result<()> { instructions::init_config(ctx, nfi_authority, treasury) }
    pub fn update_config(ctx: Context<AdminConfig>, nfi_authority: Pubkey, treasury: Pubkey) -> Result<()> { instructions::update_config(ctx, nfi_authority, treasury) }
    pub fn propose_authority(ctx: Context<AdminConfig>, new_authority: Option<Pubkey>) -> Result<()> { instructions::propose_authority(ctx, new_authority) }
    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> { instructions::accept_authority(ctx) }

    /// The creator and NFI's authority (from the config) both sign: wallets, window and prices are fixed here and never change.
    pub fn init(ctx: Context<Init>, args: InitArgs) -> Result<()> { instructions::init(ctx, args) }
    /// In the mint transaction, before the mint of the same asset: the minter pays the group's price plus fee.
    pub fn pay(ctx: Context<Pay>, group: u8, amount: u64) -> Result<()> { instructions::pay(ctx, group, amount) }
    /// NFI or the creator, while Open and before the window ends: refunds open, forever.
    pub fn cancel(ctx: Context<Cancel>) -> Result<()> { instructions::cancel(ctx) }
    /// NFI: blocks pay only; moves nothing.
    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> { instructions::set_paused(ctx, paused) }
    /// After a cancel: the asset's owner burns it and is paid in full; once it is gone, anyone cranks and the minter is paid.
    pub fn refund(ctx: Context<Refund>) -> Result<()> { instructions::refund(ctx) }
    /// Anyone, once the window ended: the vault pays the payout wallet and the treasury.
    pub fn release(ctx: Context<Release>) -> Result<()> { instructions::release(ctx) }
    /// Anyone, after a release: returns a receipt's rent to its minter.
    pub fn close_receipt(ctx: Context<CloseReceipt>) -> Result<()> { instructions::close_receipt(ctx) }
    /// The creator, once the escrow is final and every receipt is closed: rent back.
    pub fn close_escrow(ctx: Context<CloseEscrow>) -> Result<()> { instructions::close_escrow(ctx) }
}
