use anchor_lang::prelude::*;
use crate::errors::EscrowError;
use crate::events::EscrowInitialised;
use crate::instructions::config::plain_wallet;
use crate::mplcore::{candy_machine_authority_pda, candy_machine_view, cm_set_authority, cm_set_mint_authority, collection_update_authority, hand_collection, screen_collection, CandyMachineProgram, MplCore, CANDY_MACHINE_ID, MPL_CORE_ID};
use crate::state::*;

/// A phase as init takes it (the minted count starts at zero).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct GroupArgs {
    pub label: [u8; 6],
    pub price: u64,
    pub fee: u64,
    pub start: i64,
    pub end: i64,
    pub per_wallet: u16,
    pub allocation: u32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitArgs {
    pub window_end: i64,
    pub groups: Vec<GroupArgs>,
    /// NFI's per-launch policy key that co-signs every mint.
    pub permit: Pubkey,
    /// Merkle root of the final metadata for a hidden-settings machine; all zero for a machine with final config lines.
    pub reveal_root: [u8; 32],
}

/// Checks one phase against the window: it opens before the window ends and closes no later than it.
pub fn valid_phase(start: i64, end: i64, window_end: i64) -> bool {
    start < window_end && (end == 0 || (end > start && end <= window_end))
}

/// The creator (payer, the machine's authority and the collection's update authority) and NFI's authority from the
/// config both sign, and so does the payout wallet (round 4, L-012: the money goes to a wallet whose owner proved
/// control). Nobody else can create an escrow at a machine's address, so nobody can squat it. The treasury comes from
/// the config, never from arguments. In THIS instruction the escrow takes:
///   - the collection's update authority (review 3, finding 3: a handover before init could orphan the collection),
///   - the machine's mint authority and authority (round 4, L-001/L-002): from here only pay_and_mint can mint, always
///     with the payment, and nobody can change the machine's supply, items or settings.
///
/// The collection must be empty and its plugins screened (L-004, L-014); a hidden-settings machine must come with its
/// reveal commitment, and a machine with final config lines must not (L-013).
#[derive(Accounts)]
pub struct Init<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = nfi_authority @ EscrowError::NotNfi)]
    pub config: Account<'info, Config>,
    #[account(init, payer = creator, space = 8 + LaunchEscrow::INIT_SPACE, seeds = [ESCROW_SEED, candy_machine.key().as_ref()], bump)]
    pub escrow: Box<Account<'info, LaunchEscrow>>,
    #[account(init, payer = creator, space = 8 + Vault::INIT_SPACE, seeds = [VAULT_SEED, escrow.key().as_ref()], bump)]
    pub vault: Account<'info, Vault>,
    /// CHECK: a Core Candy Machine, read by hand: its authority, collection and supply are checked; handed to the escrow by CPI.
    #[account(mut, owner = CANDY_MACHINE_ID @ EscrowError::BadMachine)]
    pub candy_machine: UncheckedAccount<'info>,
    /// CHECK: the Core collection, read by hand and handed to the escrow by CPI; MPL Core validates the update.
    #[account(mut, owner = MPL_CORE_ID @ EscrowError::CoreUnreadable)]
    pub collection: UncheckedAccount<'info>,
    /// The payout wallet: a plain, funded system account that signs (the creator's own wallet signs once for both).
    pub payout: Signer<'info>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub nfi_authority: Signer<'info>,
    pub candy_machine_program: Program<'info, CandyMachineProgram>,
    pub mpl_core_program: Program<'info, MplCore>,
    pub system_program: Program<'info, System>,
}

pub fn init(ctx: Context<Init>, args: InitArgs) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(args.window_end >= now.saturating_add(MIN_WINDOW_SECS) && args.window_end <= now.saturating_add(MAX_WINDOW_SECS), EscrowError::BadWindow);
    require!(!args.groups.is_empty() && args.groups.len() <= MAX_GROUPS, EscrowError::BadGroups);
    require!(args.permit != Pubkey::default(), EscrowError::BadConfig);
    let mut groups: Vec<Group> = Vec::with_capacity(args.groups.len());
    for a in args.groups.iter() {
        let g = Group { label: a.label, price: a.price, fee: a.fee, start: a.start, end: a.end, per_wallet: a.per_wallet, allocation: a.allocation, minted: 0 };
        require!(g.canonical(), EscrowError::BadGroups);
        require!(groups.iter().all(|h| h.label_bytes() != g.label_bytes()), EscrowError::BadGroups);
        require!(valid_phase(g.start, g.end, args.window_end), EscrowError::BadPhase);
        g.price.checked_add(g.fee).ok_or(EscrowError::Overflow)?;
        groups.push(g);
    }
    let escrow_key = ctx.accounts.escrow.key();
    let vault_key = ctx.accounts.vault.key();
    let creator_key = ctx.accounts.creator.key();
    let treasury = ctx.accounts.config.treasury;
    let payout = ctx.accounts.payout.key();
    plain_wallet(&ctx.accounts.payout)?;
    require!(payout != escrow_key && payout != vault_key && treasury != escrow_key && treasury != vault_key, EscrowError::BadWallet);
    let cm_key = ctx.accounts.candy_machine.key();
    let items_available = {
        let data = ctx.accounts.candy_machine.try_borrow_data()?;
        let m = candy_machine_view(&data)?;
        require!(m.authority == creator_key && m.collection == ctx.accounts.collection.key(), EscrowError::BadMachine);
        require!(m.items_redeemed == 0 && m.items_available > 0, EscrowError::BadMachine);
        require!(m.hidden == (args.reveal_root != [0u8; 32]), EscrowError::RevealCommitment);
        m.items_available
    };
    {
        let data = ctx.accounts.collection.try_borrow_data()?;
        require!(collection_update_authority(&data)? == creator_key, EscrowError::CollectionNotCreators);
        screen_collection(&data, &candy_machine_authority_pda(&cm_key), args.reveal_root != [0u8; 32])?;
    }
    let bump = ctx.bumps.escrow;
    let seeds: [&[u8]; 3] = [ESCROW_SEED, cm_key.as_ref(), &[bump]];
    let creator = ctx.accounts.creator.to_account_info();
    let escrow_ai = ctx.accounts.escrow.to_account_info();
    let cm = ctx.accounts.candy_machine.to_account_info();
    let cm_program = ctx.accounts.candy_machine_program.to_account_info();
    hand_collection(&ctx.accounts.collection.to_account_info(), &creator, &creator, &escrow_ai, &ctx.accounts.system_program.to_account_info(), &ctx.accounts.mpl_core_program.to_account_info(), &[])?;
    cm_set_mint_authority(&cm, &creator, &escrow_ai, &cm_program, &[&seeds])?;
    cm_set_authority(&cm, &creator, &escrow_key, &cm_program, &[])?;
    {
        let data = ctx.accounts.candy_machine.try_borrow_data()?;
        let m = candy_machine_view(&data)?;
        require!(m.authority == escrow_key && m.mint_authority == escrow_key, EscrowError::BadMachine);
    }
    let e = &mut ctx.accounts.escrow;
    e.bump = bump;
    e.vault_bump = ctx.bumps.vault;
    e.creator = creator_key;
    e.payout = payout;
    e.treasury = treasury;
    e.permit = args.permit;
    e.candy_machine = cm_key;
    e.collection = ctx.accounts.collection.key();
    e.window_end = args.window_end;
    e.status = EscrowStatus::Open;
    e.cancelled_by = CancelledBy::Nobody;
    e.cancelled_at = 0;
    e.paused = false;
    e.fee_released = false;
    e.collection_returned = false;
    e.items_available = items_available;
    e.reveal_root = args.reveal_root;
    e.revealed = 0;
    e.groups = groups;
    ctx.accounts.vault.bump = ctx.bumps.vault;
    emit!(EscrowInitialised { escrow: e.key(), candy_machine: e.candy_machine, creator: e.creator, payout: e.payout, window_end: e.window_end, groups: e.groups.len() as u8, reveal_root: e.reveal_root });
    Ok(())
}
