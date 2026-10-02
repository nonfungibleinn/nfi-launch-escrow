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
    #[msg("The escrow is not released")]
    NotReleased,
    #[msg("The window has not ended")]
    WindowNotOver,
    #[msg("The window has ended")]
    WindowOver,
    #[msg("Window out of bounds")]
    BadWindow,
    #[msg("Between one and eight groups, each with a distinct, zero-padded label")]
    BadGroups,
    #[msg("Payout and treasury must be plain system wallets, not programs, sysvars or this escrow's accounts")]
    BadWallet,
    #[msg("No such group")]
    BadGroup,
    #[msg("The amount does not match the group's price plus fee")]
    BadAmount,
    #[msg("No mint of this asset from this launch's machine, in this group, precedes this payment in the transaction")]
    MintNotFound,
    #[msg("The asset does not exist as a Core asset of this collection: nothing to pay for")]
    AssetNotMinted,
    #[msg("Already refunded")]
    AlreadyRefunded,
    #[msg("The collection account passed is not the asset's collection")]
    WrongCollection,
    #[msg("The asset account is neither a live MPL Core asset nor a burned one")]
    AssetUnreadable,
    #[msg("The MPL Core account is not what the program expects")]
    CoreUnreadable,
    #[msg("The collection's update authority must be the creator")]
    CollectionNotCreators,
    #[msg("Not a Core Candy Machine of this creator for this collection")]
    BadMachine,
    #[msg("The collection carries a permanent delegate or an external plugin adapter")]
    CollectionPluginRefused,
    #[msg("Receipts are still open")]
    ReceiptsOpen,
    #[msg("The fee has not been released yet")]
    FeeNotReleased,
    #[msg("Already released")]
    AlreadyReleased,
    #[msg("The vault does not hold that much")]
    InsufficientVault,
    #[msg("The escrow is not final")]
    NotFinal,
    #[msg("Arithmetic overflow")]
    Overflow,
}
