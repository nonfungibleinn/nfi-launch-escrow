use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use crate::errors::EscrowError;
use crate::events::Paid;
use crate::mplcore::{asset_owner_and_collection, candy_machine_view, cm_mint_asset, CandyMachineProgram, MintAccounts, MplCore, MPL_CORE_ID};
use crate::state::*;

/// The ONLY way to mint from an escrow launch (round 4, L-001/L-002): the escrow PDA is the machine's mint authority, so
/// the machine mints only when this instruction asks it to, and this instruction takes the phase's price plus fee into
/// the vault, writes the receipt and mints, all or nothing. The program enforces the phase's window, its allocation and
/// the per-wallet limit; NFI's per-launch permit key co-signs for the policies that live off chain (allowlists,
/// per-account limits), so a leak of that key can at most let a wallet skip a policy, never skip the payment.
/// The asset is created here, fresh (the machine refuses an existing account), with no asset plugins, owned by the
/// minter, so every receipt names an asset that nobody else could have prepared (L-004, L-055).
#[derive(Accounts)]
#[instruction(group: u8)]
pub struct PayAndMint<'info> {
    #[account(mut, seeds = [ESCROW_SEED, escrow.candy_machine.as_ref()], bump = escrow.bump, has_one = candy_machine, has_one = collection, has_one = permit @ EscrowError::NotPermit)]
    pub escrow: Box<Account<'info, LaunchEscrow>>,
    #[account(mut, seeds = [VAULT_SEED, escrow.key().as_ref()], bump = escrow.vault_bump)]
    pub vault: Account<'info, Vault>,
    #[account(init, payer = minter, space = 8 + MintReceipt::INIT_SPACE, seeds = [RECEIPT_SEED, escrow.key().as_ref(), asset.key().as_ref()], bump)]
    pub receipt: Box<Account<'info, MintReceipt>>,
    #[account(init_if_needed, payer = minter, space = 8 + MintCounter::INIT_SPACE, seeds = [COUNTER_SEED, escrow.key().as_ref(), minter.key().as_ref(), &[group]], bump)]
    pub counter: Box<Account<'info, MintCounter>>,
    /// A fresh keypair: the new asset's address. It signs, as Core requires for a new account.
    #[account(mut)]
    pub asset: Signer<'info>,
    #[account(mut)]
    pub minter: Signer<'info>,
    /// NFI's per-launch policy key (has_one on the escrow).
    pub permit: Signer<'info>,
    /// CHECK: the escrow's machine (has_one); the Candy Machine program checks it.
    #[account(mut)]
    pub candy_machine: UncheckedAccount<'info>,
    /// CHECK: the machine's authority PDA; the Candy Machine program checks its seeds.
    #[account(mut)]
    pub candy_machine_authority: UncheckedAccount<'info>,
    /// CHECK: the escrow's collection (has_one); the Candy Machine program checks it against the machine.
    #[account(mut)]
    pub collection: UncheckedAccount<'info>,
    pub candy_machine_program: Program<'info, CandyMachineProgram>,
    pub mpl_core_program: Program<'info, MplCore>,
    pub system_program: Program<'info, System>,
    /// CHECK: the instructions sysvar, address checked; passed through to the machine.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    /// CHECK: the slot hashes sysvar, address checked; the machine's item selection reads it.
    #[account(address = anchor_lang::solana_program::sysvar::slot_hashes::ID)]
    pub slot_hashes: UncheckedAccount<'info>,
}

pub fn pay_and_mint(ctx: Context<PayAndMint>, group: u8) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let escrow_key = ctx.accounts.escrow.key();
    let minter_key = ctx.accounts.minter.key();
    let e = &mut ctx.accounts.escrow;
    require!(e.status == EscrowStatus::Open, EscrowError::NotOpen);
    require!(!e.paused, EscrowError::Paused);
    require!(now < e.window_end, EscrowError::WindowOver);
    let window_end = e.window_end;
    let g = e.groups.get_mut(group as usize).ok_or(EscrowError::BadGroup)?;
    require!(now >= g.start, EscrowError::PhaseNotStarted);
    require!(now < g.closes(window_end), EscrowError::PhaseEnded);
    require!(g.allocation == 0 || g.minted < g.allocation, EscrowError::PhaseSoldOut);
    let (price, fee) = (g.price, g.fee);
    let per_wallet = g.per_wallet;
    g.minted = g.minted.checked_add(1).ok_or(EscrowError::Overflow)?;
    let c = &mut ctx.accounts.counter;
    if c.escrow == Pubkey::default() {
        c.bump = ctx.bumps.counter;
        c.escrow = escrow_key;
        c.minter = minter_key;
    }
    require!(per_wallet == 0 || c.count < per_wallet, EscrowError::WalletLimit);
    c.count = c.count.checked_add(1).ok_or(EscrowError::Overflow)?;
    let due = price.checked_add(fee).ok_or(EscrowError::Overflow)?;
    if due > 0 {
        transfer(CpiContext::new(ctx.accounts.system_program.to_account_info(), Transfer { from: ctx.accounts.minter.to_account_info(), to: ctx.accounts.vault.to_account_info() }), due)?;
    }
    let mint_index = candy_machine_view(&ctx.accounts.candy_machine.try_borrow_data()?)?.items_redeemed;
    let e = &mut ctx.accounts.escrow;
    e.price_in = e.price_in.checked_add(price).ok_or(EscrowError::Overflow)?;
    e.fee_in = e.fee_in.checked_add(fee).ok_or(EscrowError::Overflow)?;
    e.receipts = e.receipts.checked_add(1).ok_or(EscrowError::Overflow)?;
    e.receipts_open = e.receipts_open.checked_add(1).ok_or(EscrowError::Overflow)?;
    let seeds = e.signer_seeds();
    let seed_refs: Vec<&[u8]> = seeds.iter().map(|s| s.as_slice()).collect();
    let escrow_ai = e.to_account_info();
    let minter_ai = ctx.accounts.minter.to_account_info();
    cm_mint_asset(&MintAccounts {
        candy_machine: &ctx.accounts.candy_machine.to_account_info(),
        authority_pda: &ctx.accounts.candy_machine_authority.to_account_info(),
        mint_authority: &escrow_ai,
        payer: &minter_ai,
        owner: &minter_ai,
        asset: &ctx.accounts.asset.to_account_info(),
        collection: &ctx.accounts.collection.to_account_info(),
        core: &ctx.accounts.mpl_core_program.to_account_info(),
        system: &ctx.accounts.system_program.to_account_info(),
        instructions: &ctx.accounts.instructions.to_account_info(),
        slot_hashes: &ctx.accounts.slot_hashes.to_account_info(),
        program: &ctx.accounts.candy_machine_program.to_account_info(),
    }, &[&seed_refs])?;
    // Belt and braces: the asset now exists, in this collection, owned by the minter.
    {
        let a = ctx.accounts.asset.to_account_info();
        require!(*a.owner == MPL_CORE_ID, EscrowError::AssetNotMinted);
        let (owner, coll) = asset_owner_and_collection(&a.try_borrow_data()?)?;
        require!(owner == minter_key && coll == Some(ctx.accounts.escrow.collection), EscrowError::AssetNotMinted);
    }
    let r = &mut ctx.accounts.receipt;
    r.bump = ctx.bumps.receipt;
    r.escrow = escrow_key;
    r.asset = ctx.accounts.asset.key();
    r.minter = minter_key;
    r.group = group;
    r.price = price;
    r.fee = fee;
    r.paid_at = now;
    r.refunded = false;
    r.mint_index = mint_index;
    r.revealed = false;
    emit!(Paid { escrow: escrow_key, asset: r.asset, minter: r.minter, group, price, fee, mint_index });
    Ok(())
}

/// Anyone, once the escrow is no longer open: a mint counter's rent goes back to its minter.
#[derive(Accounts)]
pub struct CloseCounter<'info> {
    #[account(seeds = [ESCROW_SEED, escrow.candy_machine.as_ref()], bump = escrow.bump)]
    pub escrow: Box<Account<'info, LaunchEscrow>>,
    #[account(mut, close = minter, has_one = escrow, has_one = minter)]
    pub counter: Account<'info, MintCounter>,
    /// CHECK: the counter names the minter; rent goes here.
    #[account(mut)]
    pub minter: UncheckedAccount<'info>,
    pub signer: Signer<'info>,
}

pub fn close_counter(ctx: Context<CloseCounter>) -> Result<()> {
    require!(ctx.accounts.escrow.status != EscrowStatus::Open, EscrowError::NotFinal);
    Ok(())
}
