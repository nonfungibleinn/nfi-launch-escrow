use anchor_lang::prelude::*;

/// "config2": the round-4 Config gained the canceller, so it lives at a new address (the old one is abandoned).
pub const CONFIG_SEED: &[u8] = b"config2";
pub const ESCROW_SEED: &[u8] = b"launch";
pub const VAULT_SEED: &[u8] = b"vault";
pub const RECEIPT_SEED: &[u8] = b"receipt";
pub const COUNTER_SEED: &[u8] = b"minted";
pub const MAX_GROUPS: usize = 8;
/// Longest reveal proof accepted: a Merkle tree of up to 2^20 items.
pub const MAX_PROOF: usize = 20;

/// The shortest window init accepts, in seconds after now. Short under the test feature so a local test can run a whole
/// life. Exported to the IDL so a deploy can be checked for the production value (3600).
#[cfg(feature = "test")]
#[constant]
pub const MIN_WINDOW_SECS: i64 = 5;
#[cfg(not(feature = "test"))]
#[constant]
pub const MIN_WINDOW_SECS: i64 = 3600;
/// The longest window: ninety days. A creator's money is never held longer than that by this program.
#[constant]
pub const MAX_WINDOW_SECS: i64 = 90 * 86400;
/// After a cancel, how long the escrow keeps the collection while refunds are unclaimed. After it the creator may take
/// the collection back; the refund money stays in the vault, claimable forever (owner decision 2026-10-06).
#[cfg(feature = "test")]
#[constant]
pub const CANCEL_GRACE_SECS: i64 = 6;
#[cfg(not(feature = "test"))]
#[constant]
pub const CANCEL_GRACE_SECS: i64 = 30 * 86400;
/// After the window ends, how long a committed reveal may stay incomplete before the collection can go back anyway.
#[cfg(feature = "test")]
#[constant]
pub const REVEAL_GRACE_SECS: i64 = 6;
#[cfg(not(feature = "test"))]
#[constant]
pub const REVEAL_GRACE_SECS: i64 = 30 * 86400;

/// Program-wide: NFI's keys and treasury, created by the upgrade authority and changed by the config authority (the NFI
/// Programs multisig on mainnet). Each key has one job, so a leak of the hot one is bounded (round 4, L-006):
///   - nfi_authority (hot, the service): co-signs inits, pauses and unpauses minting, rotates a launch's permit key,
///     co-signs a creator's phase change. It can never cancel, and never move money.
///   - canceller (cold, the multisig on mainnet): may cancel any open launch before its window ends.
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub pending_authority: Option<Pubkey>,
    pub nfi_authority: Pubkey,
    pub canceller: Pubkey,
    /// Receives the fee share on release. A plain, funded system wallet, checked when set.
    pub treasury: Pubkey,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, Debug, PartialEq, Eq)]
pub enum EscrowStatus {
    /// Minting (unless paused); releases at window_end.
    Open,
    /// Cancelled by NFI's canceller or the creator before the window ended: every receipt may be refunded, forever.
    Cancelled,
    /// The window ended and the vault paid the creator (the fee leg follows on its own).
    Released,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, Debug, PartialEq, Eq)]
pub enum CancelledBy {
    Nobody,
    Creator,
    Nfi,
}

/// A phase: its price and NFI's fee (fixed at init, never changed), when it mints, and its limits. The program enforces
/// all of it; there is no Candy Guard on an escrow launch (round 4, L-001/L-002).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, Debug, PartialEq, Eq)]
pub struct Group {
    /// The phase label, zero padded (shown to people; the service's phase key).
    pub label: [u8; 6],
    pub price: u64,
    pub fee: u64,
    /// Minting opens at this unix time.
    pub start: i64,
    /// Minting closes at this unix time; 0 = the window's end.
    pub end: i64,
    /// Mints per wallet in this phase; 0 = no limit.
    pub per_wallet: u16,
    /// Mints in this phase in total; 0 = no limit (the machine's supply still applies).
    pub allocation: u32,
    /// Mints so far in this phase.
    pub minted: u32,
}

impl Group {
    /// The label without its zero padding.
    pub fn label_bytes(&self) -> &[u8] {
        let end = self.label.iter().position(|b| *b == 0).unwrap_or(self.label.len());
        &self.label[..end]
    }
    /// Canonical: at least one byte, and nothing after the first zero.
    pub fn canonical(&self) -> bool {
        let n = self.label_bytes().len();
        n > 0 && self.label[n..].iter().all(|b| *b == 0)
    }
    /// When minting in this phase closes.
    pub fn closes(&self, window_end: i64) -> i64 {
        if self.end == 0 { window_end } else { self.end }
    }
}

/// One launch's escrow, at seeds ["launch", candy_machine]. Owns the vault; only this program moves its lamports.
/// From init until it is final the escrow PDA is the Candy Machine's authority AND mint authority and the collection's
/// update authority: nobody but pay_and_mint can mint, nobody can change the machine, and nobody can add a plugin that
/// blocks a burn, move an asset out of the collection, or claw one back while refunds are possible.
#[account]
#[derive(InitSpace)]
pub struct LaunchEscrow {
    pub bump: u8,
    pub vault_bump: u8,
    /// The creator (the machine's and collection's authority before init). May cancel while Open; gets both back at the end.
    pub creator: Pubkey,
    /// Receives the price share on release. Fixed at init, never changed. A plain, funded system wallet that signed init
    /// (or the creator's own wallet).
    pub payout: Pubkey,
    /// The treasury at init (from the config). Receives the fee share after release, and only then.
    pub treasury: Pubkey,
    /// NFI's per-launch policy key: co-signs every mint (allowlists, per-account limits). Its leak can let a wallet skip
    /// those policies, never skip the payment. Rotated by the config's nfi_authority.
    pub permit: Pubkey,
    pub candy_machine: Pubkey,
    /// The collection every paid asset is minted into; under this escrow's update authority until returned.
    pub collection: Pubkey,
    /// Unix time after which anyone may release. Immutable. A cancel is only possible before it.
    pub window_end: i64,
    pub status: EscrowStatus,
    pub cancelled_by: CancelledBy,
    pub cancelled_at: i64,
    pub paused: bool,
    /// The treasury leg of the release, sent on its own so a bad treasury can never hold the creator's share.
    pub fee_released: bool,
    /// The collection's update authority and the machine's authority went back to the creator.
    pub collection_returned: bool,
    /// The machine's supply, read at init.
    pub items_available: u64,
    /// Root of the Merkle tree of every item's final (index, name, uri), committed at init for a hidden-settings machine;
    /// all zero when the machine mints its final metadata directly (then no reveal exists and metadata never changes here).
    pub reveal_root: [u8; 32],
    /// Assets revealed through the commitment.
    pub revealed: u64,
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
    /// Mint counters not yet closed: each holds its minter's rent, so the escrow cannot close before they do (round 4
    /// property test: a closed escrow left counters that could never be closed).
    pub counters_open: u32,
}

impl LaunchEscrow {
    pub fn signer_seeds(&self) -> [Vec<u8>; 3] {
        [ESCROW_SEED.to_vec(), self.candy_machine.to_bytes().to_vec(), vec![self.bump]]
    }
    pub fn has_reveal(&self) -> bool {
        self.reveal_root != [0u8; 32]
    }
}

/// One payment, at seeds ["receipt", escrow, asset]: written by the same instruction that minted the asset, so every asset
/// of an escrow launch has exactly one receipt and every receipt has exactly one asset. Rent is the minter's and comes
/// back to them when the receipt closes.
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
    /// The machine's mint number for this asset (its index in the reveal commitment).
    pub mint_index: u64,
    pub revealed: bool,
}

/// Mints by one wallet in one phase, at seeds ["minted", escrow, minter, group]. Rent is the minter's; anyone may close it
/// back to them once the escrow is no longer open.
#[account]
#[derive(InitSpace)]
pub struct MintCounter {
    pub bump: u8,
    pub escrow: Pubkey,
    pub minter: Pubkey,
    pub count: u16,
}

/// The lamport vault, program-owned so the program alone may debit it.
#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub bump: u8,
}
