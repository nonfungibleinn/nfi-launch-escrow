use anchor_lang::prelude::*;

#[error_code]
pub enum EscrowError {
    #[msg("Payments are paused")]
    Paused,
    #[msg("Only NFI's authority may do this")]
    NotNfi,
    #[msg("Only the creator may do this")]
    NotCreator,
    #[msg("Only the minter may do this while the asset exists")]
    NotMinter,
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
    #[msg("No such group")]
    BadGroup,
    #[msg("The amount does not match the group's price plus fee")]
    BadAmount,
    #[msg("Already refunded")]
    AlreadyRefunded,
    #[msg("The asset is not owned by the minter")]
    AssetNotOwned,
    #[msg("The asset does not belong to this launch's collection")]
    AssetNotInCollection,
    #[msg("The asset account is not what MPL Core writes")]
    AssetUnreadable,
    #[msg("Receipts are still open")]
    ReceiptsOpen,
    #[msg("The vault still holds funds")]
    VaultNotEmpty,
    #[msg("The escrow is not final")]
    NotFinal,
    #[msg("Arithmetic overflow")]
    Overflow,
}
