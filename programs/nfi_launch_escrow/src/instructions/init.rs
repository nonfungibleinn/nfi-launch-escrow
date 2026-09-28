use anchor_lang::prelude::*;
use crate::errors::EscrowError;
use crate::events::EscrowInitialised;
use crate::state::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitArgs {
    pub payout: Pubkey,
    pub candy_guard: Pubkey,
    pub collection: Pubkey,
    pub window_end: i64,
    pub groups: Vec<Group>,
}

/// The creator (payer, the machine's authority) and NFI's authority from the config both sign. Nobody else can create
/// an escrow at a machine's address, so nobody can squat it. The treasury comes from the config, never from arguments.
#[derive(Accounts)]
pub struct Init<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = nfi_authority @ EscrowError::NotNfi)]
    pub config: Account<'info, Config>,
    #[account(init, payer = creator, space = 8 + LaunchEscrow::INIT_SPACE, seeds = [ESCROW_SEED, candy_machine.key().as_ref()], bump)]
    pub escrow: Account<'info, LaunchEscrow>,
    #[account(init, payer = creator, space = 8 + Vault::INIT_SPACE, seeds = [VAULT_SEED, escrow.key().as_ref()], bump)]
    pub vault: Account<'info, Vault>,
    /// CHECK: the candy machine's address is the escrow's seed; pay proves each mint comes from it.
    pub candy_machine: UncheckedAccount<'info>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub nfi_authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn init(ctx: Context<Init>, args: InitArgs) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(args.window_end >= now.saturating_add(MIN_WINDOW_SECS) && args.window_end <= now.saturating_add(MAX_WINDOW_SECS), EscrowError::BadWindow);
    require!(!args.groups.is_empty() && args.groups.len() <= MAX_GROUPS, EscrowError::BadGroups);
    for (i, g) in args.groups.iter().enumerate() {
        require!(!g.label_bytes().is_empty(), EscrowError::BadGroups);
        require!(args.groups[..i].iter().all(|h| h.label != g.label), EscrowError::BadGroups);
        g.price.checked_add(g.fee).ok_or(EscrowError::Overflow)?;
    }
    let escrow_key = ctx.accounts.escrow.key();
    let vault_key = ctx.accounts.vault.key();
    let treasury = ctx.accounts.config.treasury;
    for w in [args.payout, treasury] {
        require!(w != Pubkey::default() && w != escrow_key && w != vault_key, EscrowError::BadWallet);
    }
    let e = &mut ctx.accounts.escrow;
    e.bump = ctx.bumps.escrow;
    e.vault_bump = ctx.bumps.vault;
    e.creator = ctx.accounts.creator.key();
    e.payout = args.payout;
    e.nfi_authority = ctx.accounts.nfi_authority.key();
    e.treasury = treasury;
    e.candy_machine = ctx.accounts.candy_machine.key();
    e.candy_guard = args.candy_guard;
    e.collection = args.collection;
    e.window_end = args.window_end;
    e.status = EscrowStatus::Open;
    e.cancelled_by = CancelledBy::Nobody;
    e.cancelled_at = 0;
    e.paused = false;
    e.groups = args.groups;
    ctx.accounts.vault.bump = ctx.bumps.vault;
    emit!(EscrowInitialised { escrow: e.key(), candy_machine: e.candy_machine, creator: e.creator, payout: e.payout, window_end: e.window_end, groups: e.groups.len() as u8 });
    Ok(())
}
