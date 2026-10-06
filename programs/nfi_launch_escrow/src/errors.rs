use anchor_lang::prelude::*;

#[error_code]
pub enum EscrowError {
    #[msg("Only the config authority may do this")]
    NotAuthority,
    #[msg("Config values cannot be empty, and NFI's hot key and the canceller must differ")]
    BadConfig,
    #[msg("Minting is paused")]
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
    #[msg("The asset does not exist as a Core asset of this collection owned by the minter")]
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
    #[msg("Not an unminted Core Candy Machine of this creator for this collection")]
    BadMachine,
    #[msg("The collection carries a plugin, a plugin authority or an external plugin adapter an escrow launch refuses")]
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
    #[msg("Only the config's canceller or the creator may cancel")]
    NotCanceller,
    #[msg("The wallet must already hold its rent-exempt minimum")]
    WalletUnfunded,
    #[msg("The collection already has assets")]
    CollectionNotEmpty,
    #[msg("A hidden-settings machine needs a reveal commitment, and a machine with final metadata must not have one")]
    RevealCommitment,
    #[msg("A phase must open before the window ends and close after it opens, no later than the window")]
    BadPhase,
    #[msg("This phase has not started")]
    PhaseNotStarted,
    #[msg("This phase has ended")]
    PhaseEnded,
    #[msg("This phase's allocation is minted out")]
    PhaseSoldOut,
    #[msg("This wallet reached the phase's mint limit")]
    WalletLimit,
    #[msg("The permit key is not this launch's")]
    NotPermit,
    #[msg("Only a phase that has not started can change")]
    PhaseStarted,
    #[msg("This launch has no reveal commitment")]
    NoReveal,
    #[msg("The collection has gone back to the creator")]
    CollectionReturned,
    #[msg("Already revealed, or refunded")]
    AlreadyRevealed,
    #[msg("Reveal waits until minting is over")]
    MintingNotOver,
    #[msg("The name and URI are not the ones committed for this mint number")]
    BadRevealProof,
    #[msg("The asset's committed reveal has not happened yet")]
    RevealPending,
}
