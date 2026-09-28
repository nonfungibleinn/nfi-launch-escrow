use anchor_lang::prelude::*;
use crate::errors::EscrowError;
use crate::events::{PausedChanged, StatusChanged};
use crate::state::*;

/// NFI's authority or the creator, while Open. From here every receipt may be refunded, and nothing can ever be released.
#[derive(Accounts)]
pub struct Cancel<'info> {
    #[account(mut, seeds = [ESCROW_SEED, escrow.candy_machine.as_ref()], bump = escrow.bump)]
    pub escrow: Account<'info, LaunchEscrow>,
    pub signer: Signer<'info>,
}

pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
    let e = &mut ctx.accounts.escrow;
    require!(e.status == EscrowStatus::Open, EscrowError::NotOpen);
    let who = ctx.accounts.signer.key();
    let by = if who == e.nfi_authority { CancelledBy::Nfi } else if who == e.creator { CancelledBy::Creator } else { return err!(EscrowError::NotNfi) };
    e.status = EscrowStatus::Cancelled;
    e.cancelled_by = by;
    e.cancelled_at = Clock::get()?.unix_timestamp;
    emit!(StatusChanged { escrow: e.key(), status: EscrowStatus::Cancelled, by });
    Ok(())
}

/// NFI only. Pausing blocks pay; every exit (cancel, refund, release, close) always works.
#[derive(Accounts)]
pub struct SetPaused<'info> {
    #[account(mut, seeds = [ESCROW_SEED, escrow.candy_machine.as_ref()], bump = escrow.bump, has_one = nfi_authority @ EscrowError::NotNfi)]
    pub escrow: Account<'info, LaunchEscrow>,
    pub nfi_authority: Signer<'info>,
}

pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
    let e = &mut ctx.accounts.escrow;
    e.paused = paused;
    emit!(PausedChanged { escrow: e.key(), paused });
    Ok(())
}
