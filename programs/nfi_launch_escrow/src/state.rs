use anchor_lang::prelude::*;

pub const ESCROW_SEED: &[u8] = b"launch";
pub const VAULT_SEED: &[u8] = b"vault";
pub const RECEIPT_SEED: &[u8] = b"receipt";
pub const MAX_GROUPS: usize = 8;

/// The shortest window init accepts, in seconds after now. Short under the test feature so a local test can run a whole life.
#[cfg(feature = "test")]
pub const MIN_WINDOW_SECS: i64 = 5;
#[cfg(not(feature = "test"))]
pub const MIN_WINDOW_SECS: i64 = 3600;
/// The longest window: ninety days. A creator's money is never held longer than that by this program.
pub const MAX_WINDOW_SECS: i64 = 90 * 86400;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, Debug, PartialEq, Eq)]
pub enum EscrowStatus {
    /// Taking payments (unless paused); releases at window_end.
    Open,
    /// Cancelled by NFI or the creator: every receipt may be refunded, forever.
    Cancelled,
    /// The window ended and the vault paid the creator and the treasury.
    Released,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, Debug, PartialEq, Eq)]
pub enum CancelledBy {
    Nobody,
    Creator,
    Nfi,
}

/// A phase's price and NFI's fee on it, fixed at init. The label matches the candy guard group.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, Debug, PartialEq, Eq)]
pub struct Group {
    pub label: [u8; 6],
    pub price: u64,
    pub fee: u64,
}

/// One launch's escrow, at seeds ["launch", candy_machine]. Owns the vault; only this program moves its lamports.
#[account]
#[derive(InitSpace)]
pub struct LaunchEscrow {
    pub bump: u8,
    pub vault_bump: u8,
    /// The creator (the candy machine's authority). May cancel while Open; closes the accounts at the end.
    pub creator: Pubkey,
    /// Receives the price share on release. Fixed at init, never changed.
    pub payout: Pubkey,
    /// NFI: may cancel and pause. Can never receive funds from this program.
    pub nfi_authority: Pubkey,
    /// Receives the fee share on release, and only then.
    pub treasury: Pubkey,
    pub candy_machine: Pubkey,
    pub candy_guard: Pubkey,
    /// The collection every refunded asset must belong to.
    pub collection: Pubkey,
    /// Unix time after which anyone may release. Immutable.
    pub window_end: i64,
    pub status: EscrowStatus,
    pub cancelled_by: CancelledBy,
    pub cancelled_at: i64,
    pub paused: bool,
    #[max_len(MAX_GROUPS)]
    pub groups: Vec<Group>,
    /// Running sums, in lamports.
    pub price_in: u64,
    pub fee_in: u64,
    pub price_refunded: u64,
    pub fee_refunded: u64,
    /// Receipts written, and how many are still open (not refunded and not closed).
    pub receipts: u64,
    pub receipts_open: u64,
}

/// One payment, at seeds ["receipt", escrow, asset]: a mint cannot be paid twice, and a payment names the asset it bought.
/// Rent is the minter's and comes back to them when the receipt closes.
#[account]
#[derive(InitSpace)]
pub struct MintReceipt {
    pub bump: u8,
    pub escrow: Pubkey,
    pub asset: Pubkey,
    pub minter: Pubkey,
    pub group: u8,
    pub price: u64,
    pub fee: u64,
    pub paid_at: i64,
    pub refunded: bool,
}

/// The lamport vault, program-owned so the program alone may debit it.
#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub bump: u8,
}
