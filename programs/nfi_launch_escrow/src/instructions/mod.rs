pub mod admin;
pub mod close;
pub mod config;
pub mod init;
pub mod pay;
pub mod refund;
pub mod release;
pub mod reveal;

pub use admin::*;
pub use close::*;
pub use config::*;
pub use init::*;
pub use pay::*;
pub use refund::*;
pub use release::*;
pub use reveal::*;

use anchor_lang::prelude::*;
use crate::errors::EscrowError;

/// Moves lamports out of a program-owned account. The vault keeps its rent-exempt minimum until it closes.
pub fn debit<'info>(from: &AccountInfo<'info>, to: &AccountInfo<'info>, lamports: u64) -> Result<()> {
    let rent_min = Rent::get()?.minimum_balance(from.data_len());
    let available = from.lamports().checked_sub(rent_min).ok_or(EscrowError::Overflow)?;
    require!(lamports <= available, EscrowError::InsufficientVault);
    **from.try_borrow_mut_lamports()? = from.lamports().checked_sub(lamports).ok_or(EscrowError::Overflow)?;
    **to.try_borrow_mut_lamports()? = to.lamports().checked_add(lamports).ok_or(EscrowError::Overflow)?;
    Ok(())
}
