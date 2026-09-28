use anchor_lang::prelude::*;
use crate::mplcore::{collection_update_authority, screen_collection};
use crate::errors::EscrowError;
use crate::events::EscrowInitialised;
use crate::instructions::config::plain_wallet;
use crate::state::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitArgs {
    pub candy_guard: Pubkey,
    pub window_end: i64,
    pub groups: Vec<Group>,
}

/// The creator (payer, the machine's authority) and NFI's authority from the config both sign. Nobody else can create
/// an escrow at a machine's address, so nobody can squat it. The treasury comes from the config, never from arguments.
/// The collection must already be under this escrow's update authority (the deploy plan hands it over one step before)
/// and carry no permanent delegate or external adapter, so that for the whole life of the escrow no one can block a
/// burn, claw back a sold asset or move one out of the collection (review 2, finding 1).
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
    /// CHECK: the Core collection, read by hand: its update authority must be the escrow and its plugins are screened.
    pub collection: UncheckedAccount<'info>,
    /// CHECK: the payout wallet, checked to be a plain system account.
    pub payout: UncheckedAccount<'info>,
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
        require!(g.canonical(), EscrowError::BadGroups);
        require!(args.groups[..i].iter().all(|h| h.label_bytes() != g.label_bytes()), EscrowError::BadGroups);
        g.price.checked_add(g.fee).ok_or(EscrowError::Overflow)?;
    }
    let escrow_key = ctx.accounts.escrow.key();
    let vault_key = ctx.accounts.vault.key();
    let treasury = ctx.accounts.config.treasury;
    let payout = ctx.accounts.payout.key();
    plain_wallet(&ctx.accounts.payout)?;
    require!(payout != escrow_key && payout != vault_key && treasury != escrow_key && treasury != vault_key, EscrowError::BadWallet);
    {
        let coll = &ctx.accounts.collection;
        require!(*coll.owner == crate::mplcore::MPL_CORE_ID, EscrowError::CoreUnreadable);
        let data = coll.try_borrow_data()?;
        require!(collection_update_authority(&data)? == escrow_key, EscrowError::CollectionNotEscrowed);
        screen_collection(&data)?;
    }
    let e = &mut ctx.accounts.escrow;
    e.bump = ctx.bumps.escrow;
    e.vault_bump = ctx.bumps.vault;
    e.creator = ctx.accounts.creator.key();
    e.payout = payout;
    e.nfi_authority = ctx.accounts.nfi_authority.key();
    e.treasury = treasury;
    e.candy_machine = ctx.accounts.candy_machine.key();
    e.candy_guard = args.candy_guard;
    e.collection = ctx.accounts.collection.key();
    e.window_end = args.window_end;
    e.status = EscrowStatus::Open;
    e.cancelled_by = CancelledBy::Nobody;
    e.cancelled_at = 0;
    e.paused = false;
    e.fee_released = false;
    e.collection_returned = false;
    e.groups = args.groups;
    ctx.accounts.vault.bump = ctx.bumps.vault;
    emit!(EscrowInitialised { escrow: e.key(), candy_machine: e.candy_machine, creator: e.creator, payout: e.payout, window_end: e.window_end, groups: e.groups.len() as u8 });
    Ok(())
}
