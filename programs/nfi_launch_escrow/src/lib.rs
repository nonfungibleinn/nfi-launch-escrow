//! NFI Launchpad escrow. Each launch's mint payments (price and NFI's fee) sit in a program-owned vault until the
//! window ends; then anyone may release them to the payout wallet and the treasury fixed at init. If NFI's canceller or
//! the creator cancels first, every payment may be taken back, forever, by burning the asset in the same instruction.
//! The escrow is the Candy Machine's authority and mint authority and the collection's update authority from init:
//! the only way to mint is pay_and_mint, which takes the payment, writes the receipt and mints in one instruction. NFI's
//! hot key can pause minting and co-sign policy, never cancel or move money. See the Launchpad blueprint, "Phase 2b
//! design", and the round-4 review (nfi-security-audit/apps/launch).
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

    // ---- config: the upgrade authority creates it; the config authority (the multisig on mainnet) changes it ----
    pub fn init_config(ctx: Context<InitConfig>, nfi_authority: Pubkey, canceller: Pubkey) -> Result<()> { instructions::init_config(ctx, nfi_authority, canceller) }
    pub fn set_nfi_authority(ctx: Context<AdminConfig>, nfi_authority: Pubkey) -> Result<()> { instructions::set_nfi_authority(ctx, nfi_authority) }
    pub fn set_canceller(ctx: Context<AdminConfig>, canceller: Pubkey) -> Result<()> { instructions::set_canceller(ctx, canceller) }
    pub fn set_treasury(ctx: Context<SetTreasury>) -> Result<()> { instructions::set_treasury(ctx) }
    pub fn propose_authority(ctx: Context<AdminConfig>, new_authority: Option<Pubkey>) -> Result<()> { instructions::propose_authority(ctx, new_authority) }
    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> { instructions::accept_authority(ctx) }

    /// The creator, NFI's hot key and (unless it is the creator) the payout wallet sign: wallets, window, prices and the
    /// reveal commitment are fixed here; the collection and the machine are handed to the escrow.
    pub fn init(ctx: Context<Init>, args: InitArgs) -> Result<()> { instructions::init(ctx, args) }
    /// The only mint: the minter pays the phase's price plus fee into the vault, NFI's permit co-signs, the machine mints.
    pub fn pay_and_mint(ctx: Context<PayAndMint>, group: u8) -> Result<()> { instructions::pay_and_mint(ctx, group) }
    /// NFI's canceller or the creator, while Open and before the window ends: refunds open, forever.
    pub fn cancel(ctx: Context<Cancel>) -> Result<()> { instructions::cancel(ctx) }
    /// NFI's hot key: blocks pay_and_mint only; moves nothing.
    pub fn set_paused(ctx: Context<NfiEscrow>, paused: bool) -> Result<()> { instructions::set_paused(ctx, paused) }
    /// NFI's hot key: a new per-launch permit key.
    pub fn set_permit(ctx: Context<NfiEscrow>, permit: Pubkey) -> Result<()> { instructions::set_permit(ctx, permit) }
    /// The creator and NFI's hot key: move or re-limit a phase that has not started. Prices never change.
    pub fn set_group(ctx: Context<SetGroup>, group: u8, start: i64, end: i64, per_wallet: u16, allocation: u32) -> Result<()> { instructions::set_group(ctx, group, start, end, per_wallet, allocation) }
    /// After a cancel: the asset's owner burns it and is paid in full; once it is gone, anyone cranks and the minter is paid.
    pub fn refund(ctx: Context<Refund>) -> Result<()> { instructions::refund(ctx) }
    /// Anyone, once the window ended: the vault pays the payout wallet.
    pub fn release(ctx: Context<Release>) -> Result<()> { instructions::release(ctx) }
    /// Anyone, after the release: the vault pays the treasury its fees.
    pub fn release_fee(ctx: Context<ReleaseFee>) -> Result<()> { instructions::release_fee(ctx) }
    /// Anyone, once minting is over: an asset takes the name and URI committed for its mint number at init.
    pub fn reveal(ctx: Context<Reveal>, name: String, uri: String, proof: Vec<[u8; 32]>) -> Result<()> { instructions::reveal(ctx, name, uri, proof) }
    /// Anyone, once the escrow is final: the collection's update authority and the machine's authority go back to the creator.
    pub fn return_collection(ctx: Context<ReturnCollection>) -> Result<()> { instructions::return_collection(ctx) }
    /// Anyone, after a release (and the asset's reveal): returns a receipt's rent to its minter.
    pub fn close_receipt(ctx: Context<CloseReceipt>) -> Result<()> { instructions::close_receipt(ctx) }
    /// Anyone, once the escrow is not open: returns a mint counter's rent to its minter.
    pub fn close_counter(ctx: Context<CloseCounter>) -> Result<()> { instructions::close_counter(ctx) }
    /// The creator, once everything is final and returned: rent back.
    pub fn close_escrow(ctx: Context<CloseEscrow>) -> Result<()> { instructions::close_escrow(ctx) }
}
