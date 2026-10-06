use anchor_lang::prelude::*;
use crate::errors::EscrowError;
use crate::events::{GroupChanged, PausedChanged, PermitChanged, StatusChanged};
use crate::instructions::init::valid_phase;
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

/// The config's current hot NFI key. Each of these touches only minting, never money or exits.
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

/// A new per-launch permit key (a leaked or rotated one stops co-signing at once).
pub fn set_permit(ctx: Context<NfiEscrow>, permit: Pubkey) -> Result<()> {
    require!(permit != Pubkey::default(), EscrowError::BadConfig);
    let e = &mut ctx.accounts.escrow;
    e.permit = permit;
    emit!(PermitChanged { escrow: e.key(), permit });
    Ok(())
}

/// The creator and NFI's hot key together. A phase that has NOT started yet may move or change its limits; a phase that
/// has started is fixed, and a price is never changed (prices are what every receipt and refund is measured by).
#[derive(Accounts)]
pub struct SetGroup<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = nfi_authority @ EscrowError::NotNfi)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [ESCROW_SEED, escrow.candy_machine.as_ref()], bump = escrow.bump, has_one = creator @ EscrowError::NotCreator)]
    pub escrow: Box<Account<'info, LaunchEscrow>>,
    pub nfi_authority: Signer<'info>,
    pub creator: Signer<'info>,
}

pub fn set_group(ctx: Context<SetGroup>, group: u8, start: i64, end: i64, per_wallet: u16, allocation: u32) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let e = &mut ctx.accounts.escrow;
    require!(e.status == EscrowStatus::Open, EscrowError::NotOpen);
    let window_end = e.window_end;
    let g = e.groups.get_mut(group as usize).ok_or(EscrowError::BadGroup)?;
    require!(now < g.start && start > now, EscrowError::PhaseStarted);
    require!(valid_phase(start, end, window_end), EscrowError::BadPhase);
    g.start = start;
    g.end = end;
    g.per_wallet = per_wallet;
    g.allocation = allocation;
    let label = g.label;
    emit!(GroupChanged { escrow: e.key(), group, label, start, end, per_wallet, allocation });
    Ok(())
}
