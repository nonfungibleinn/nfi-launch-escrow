use anchor_lang::prelude::*;

#[error_code]
pub enum EscrowError {
    #[msg("Only the config authority may do this")]
    NotAuthority,
    #[msg("Config values cannot be empty")]
    BadConfig,
    #[msg("Payments are paused")]
    Paused,
    #[msg("Only NFI's authority may do this")]
    NotNfi,
    #[msg("Only the creator may do this")]
    NotCreator,
    #[msg("Only the asset's owner may refund while the asset exists")]
    NotOwner,
    #[msg("The escrow is not open")]
    NotOpen,
    #[msg("The escrow is not cancelled")]
    NotCancelled,
    #[msg("The window has not ended")]
    WindowNotOver,
    #[msg("The window has ended")]
    WindowOver,
    #[msg("Window out of bounds")]
    BadWindow,
    #[msg("Between one and eight groups, each with a distinct label")]
    BadGroups,
    #[msg("Payout and treasury must be plain wallets, not this escrow's accounts")]
    BadWallet,
    #[msg("No such group")]
    BadGroup,
    #[msg("The amount does not match the group's price plus fee")]
    BadAmount,
    #[msg("No mint of this asset from this launch's machine, in this group, follows in the transaction")]
    MintNotFound,
    #[msg("Already refunded")]
    AlreadyRefunded,
    #[msg("The asset does not belong to this launch's collection")]
    AssetNotInCollection,
    #[msg("The asset account is neither a live MPL Core asset nor a burned one")]
    AssetUnreadable,
    #[msg("Receipts are still open")]
    ReceiptsOpen,
    #[msg("The vault does not hold that much")]
    InsufficientVault,
    #[msg("The escrow is not final")]
    NotFinal,
    #[msg("Arithmetic overflow")]
    Overflow,
}
