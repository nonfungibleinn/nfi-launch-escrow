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
}

#[event]
pub struct Paid {
    pub escrow: Pubkey,
    pub asset: Pubkey,
    pub minter: Pubkey,
    pub group: u8,
    pub price: u64,
    pub fee: u64,
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
    pub minter: Pubkey,
    pub amount: u64,
    pub burned: bool,
}

#[event]
pub struct Released {
    pub escrow: Pubkey,
    pub to_payout: u64,
    pub to_treasury: u64,
}

#[event]
pub struct PausedChanged {
    pub escrow: Pubkey,
    pub paused: bool,
}
