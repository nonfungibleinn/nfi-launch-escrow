use anchor_lang::prelude::*;
use crate::state::{CancelledBy, EscrowStatus};

#[event]
pub struct EscrowInitialised {
    pub escrow: Pubkey,
    pub candy_machine: Pubkey,
    pub creator: Pubkey,
    pub payout: Pubkey,
    pub window_end: i64,
    pub groups: u8,
    pub reveal_root: [u8; 32],
}

#[event]
pub struct Paid {
    pub escrow: Pubkey,
    pub asset: Pubkey,
    pub minter: Pubkey,
    pub group: u8,
    pub price: u64,
    pub fee: u64,
    pub mint_index: u64,
}

#[event]
pub struct StatusChanged {
    pub escrow: Pubkey,
    pub status: EscrowStatus,
    pub by: CancelledBy,
}

#[event]
pub struct Refunded {
    pub escrow: Pubkey,
    pub asset: Pubkey,
    /// The receipt's original minter.
    pub minter: Pubkey,
    /// Who received the money: the owner who burned, or the minter once the asset was already gone.
    pub paid_to: Pubkey,
    pub amount: u64,
    pub burned: bool,
}

#[event]
pub struct Released {
    pub escrow: Pubkey,
    pub to_payout: u64,
}

#[event]
pub struct FeeReleased {
    pub escrow: Pubkey,
    pub to_treasury: u64,
}

#[event]
pub struct PausedChanged {
    pub escrow: Pubkey,
    pub paused: bool,
}

#[event]
pub struct PermitChanged {
    pub escrow: Pubkey,
    pub permit: Pubkey,
}

#[event]
pub struct GroupChanged {
    pub escrow: Pubkey,
    pub group: u8,
    pub label: [u8; 6],
    pub start: i64,
    pub end: i64,
    pub per_wallet: u16,
    pub allocation: u32,
}

#[event]
pub struct Revealed {
    pub escrow: Pubkey,
    pub asset: Pubkey,
    pub mint_index: u64,
}

#[event]
pub struct CollectionReturned {
    pub escrow: Pubkey,
    pub collection: Pubkey,
    pub to: Pubkey,
}

/// Every change to the program-wide config, so an alarm can watch for one (round 4, L-059).
#[event]
pub struct ConfigChanged {
    pub authority: Pubkey,
    pub nfi_authority: Pubkey,
    pub canceller: Pubkey,
    pub treasury: Pubkey,
}
