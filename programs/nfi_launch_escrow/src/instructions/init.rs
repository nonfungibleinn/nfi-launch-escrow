use anchor_lang::prelude::*;
use crate::errors::EscrowError;
use crate::events::EscrowInitialised;
use crate::instructions::config::plain_wallet;
use crate::mplcore::{candy_machine_authority_pda, candy_machine_view, collection_update_authority, hand_collection, screen_collection, MplCore, CANDY_MACHINE_ID, MPL_CORE_ID};
use crate::state::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitArgs {
    pub window_end: i64,
    pub groups: Vec<Group>,
}

/// The creator (payer, the machine's authority and the collection's update authority) and NFI's authority from the
/// config both sign. Nobody else can create an escrow at a machine's address, so nobody can squat it. The treasury
/// comes from the config, never from arguments. The machine is read: its collection must be this collection and its
/// guard is recorded as the one pay must find. The collection's plugins are screened and its update authority is
/// handed to the escrow IN THIS INSTRUCTION (review 3, finding 3: a handover before init could orphan the collection
/// if init then failed), so that for the whole life of the escrow no one can block a burn, claw back a sold asset or
/// move one out of the collection (review 2, finding 1).
#[derive(Accounts)]
pub struct Init<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = nfi_authority @ EscrowError::NotNfi)]
    pub config: Account<'info, Config>,
    #[account(init, payer = creator, space = 8 + LaunchEscrow::INIT_SPACE, seeds = [ESCROW_SEED, candy_machine.key().as_ref()], bump)]
    pub escrow: Account<'info, LaunchEscrow>,
    #[account(init, payer = creator, space = 8 + Vault::INIT_SPACE, seeds = [VAULT_SEED, escrow.key().as_ref()], bump)]
    pub vault: Account<'info, Vault>,
    /// CHECK: a Core Candy Machine, read by hand: its authority, guard and collection are checked.
    #[account(owner = CANDY_MACHINE_ID @ EscrowError::BadMachine)]
    pub candy_machine: UncheckedAccount<'info>,
    /// CHECK: the Core collection, read by hand and handed to the escrow by CPI; MPL Core validates the update.
    #[account(mut, owner = MPL_CORE_ID @ EscrowError::CoreUnreadable)]
    pub collection: UncheckedAccount<'info>,
    /// CHECK: the payout wallet, checked to be a plain system account.
    pub payout: UncheckedAccount<'info>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub nfi_authority: Signer<'info>,
    pub mpl_core_program: Program<'info, MplCore>,
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
    let creator_key = ctx.accounts.creator.key();
    let treasury = ctx.accounts.config.treasury;
    let payout = ctx.accounts.payout.key();
    plain_wallet(&ctx.accounts.payout)?;
    require!(payout != escrow_key && payout != vault_key && treasury != escrow_key && treasury != vault_key, EscrowError::BadWallet);
    let cm_key = ctx.accounts.candy_machine.key();
    let candy_guard = {
        let data = ctx.accounts.candy_machine.try_borrow_data()?;
        let (authority, mint_authority, collection_mint) = candy_machine_view(&data)?;
        require!(authority == creator_key && collection_mint == ctx.accounts.collection.key(), EscrowError::BadMachine);
        mint_authority
    };
    {
        let data = ctx.accounts.collection.try_borrow_data()?;
        require!(collection_update_authority(&data)? == creator_key, EscrowError::CollectionNotCreators);
        screen_collection(&data, &candy_machine_authority_pda(&cm_key))?;
    }
    hand_collection(&ctx.accounts.collection.to_account_info(), &ctx.accounts.creator.to_account_info(), &ctx.accounts.creator.to_account_info(), &ctx.accounts.escrow.to_account_info(), &ctx.accounts.system_program.to_account_info(), &ctx.accounts.mpl_core_program.to_account_info(), &[])?;
    let e = &mut ctx.accounts.escrow;
    e.bump = ctx.bumps.escrow;
    e.vault_bump = ctx.bumps.vault;
    e.creator = creator_key;
    e.payout = payout;
    e.nfi_authority = ctx.accounts.nfi_authority.key();
    e.treasury = treasury;
    e.candy_machine = cm_key;
    e.candy_guard = candy_guard;
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
