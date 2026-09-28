use anchor_lang::prelude::*;
use crate::errors::EscrowError;
use crate::events::{PausedChanged, StatusChanged};
use crate::state::*;

/// The config's CURRENT NFI key or the creator, while Open and before the window ends. From here every receipt may be
/// refunded, and nothing can ever be released. After window_end a cancel is impossible: release is a promise.
#[derive(Accounts)]
pub struct Cancel<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [ESCROW_SEED, escrow.candy_machine.as_ref()], bump = escrow.bump)]
    pub escrow: Account<'info, LaunchEscrow>,
    pub signer: Signer<'info>,
}

pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let nfi_now = ctx.accounts.config.nfi_authority;
    let e = &mut ctx.accounts.escrow;
    require!(e.status == EscrowStatus::Open, EscrowError::NotOpen);
    require!(now < e.window_end, EscrowError::WindowOver);
    let who = ctx.accounts.signer.key();
    let by = if who == nfi_now { CancelledBy::Nfi } else if who == e.creator { CancelledBy::Creator } else { return err!(EscrowError::NotNfi) };
    e.status = EscrowStatus::Cancelled;
    e.cancelled_by = by;
    e.cancelled_at = now;
    emit!(StatusChanged { escrow: e.key(), status: EscrowStatus::Cancelled, by });
    Ok(())
}

/// The config's current NFI key only. Pausing blocks pay; every exit (cancel, refund, release, close) always works.
#[derive(Accounts)]
pub struct SetPaused<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = nfi_authority @ EscrowError::NotNfi)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [ESCROW_SEED, escrow.candy_machine.as_ref()], bump = escrow.bump)]
    pub escrow: Account<'info, LaunchEscrow>,
    pub nfi_authority: Signer<'info>,
}

pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
    let e = &mut ctx.accounts.escrow;
    e.paused = paused;
    emit!(PausedChanged { escrow: e.key(), paused });
    Ok(())
}
