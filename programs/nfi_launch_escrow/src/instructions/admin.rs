use anchor_lang::prelude::*;
use crate::errors::EscrowError;
use crate::events::{PausedChanged, StatusChanged};
use crate::state::*;

/// The config's CANCELLER (a cold key, the multisig on mainnet) or the creator, while Open and before the window ends.
/// From here every receipt may be refunded, and nothing can ever be released. After window_end a cancel is impossible:
/// release is a promise. NFI's hot key cannot cancel (round 4, L-006); it can only pause.
#[derive(Accounts)]
pub struct Cancel<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [ESCROW_SEED, escrow.candy_machine.as_ref()], bump = escrow.bump)]
    pub escrow: Box<Account<'info, LaunchEscrow>>,
    pub signer: Signer<'info>,
}

pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let canceller = ctx.accounts.config.canceller;
    let e = &mut ctx.accounts.escrow;
    require!(e.status == EscrowStatus::Open, EscrowError::NotOpen);
    require!(now < e.window_end, EscrowError::WindowOver);
    let who = ctx.accounts.signer.key();
    let by = if who == canceller { CancelledBy::Nfi } else if who == e.creator { CancelledBy::Creator } else { return err!(EscrowError::NotCanceller) };
    e.status = EscrowStatus::Cancelled;
    e.cancelled_by = by;
    e.cancelled_at = now;
    emit!(StatusChanged { escrow: e.key(), status: EscrowStatus::Cancelled, by });
    Ok(())
}

/// The config's current hot NFI key: it pauses minting and nothing else, never money or exits.
#[derive(Accounts)]
pub struct NfiEscrow<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = nfi_authority @ EscrowError::NotNfi)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [ESCROW_SEED, escrow.candy_machine.as_ref()], bump = escrow.bump)]
    pub escrow: Box<Account<'info, LaunchEscrow>>,
    pub nfi_authority: Signer<'info>,
}

/// Pausing blocks pay_and_mint only; every exit (cancel, refund, release, close) always works.
pub fn set_paused(ctx: Context<NfiEscrow>, paused: bool) -> Result<()> {
    let e = &mut ctx.accounts.escrow;
    e.paused = paused;
    emit!(PausedChanged { escrow: e.key(), paused });
    Ok(())
}
