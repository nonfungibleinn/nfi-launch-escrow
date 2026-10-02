use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{load_current_index_checked, load_instruction_at_checked};
use anchor_lang::system_program::{transfer, Transfer};
use crate::errors::EscrowError;
use crate::events::Paid;
use crate::state::*;

#[allow(dead_code)]
pub const CANDY_GUARD_ID: Pubkey = anchor_lang::solana_program::pubkey!("CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ");
/// Anchor discriminator of Core Candy Guard's mint_v1.
const MINT_V1: [u8; 8] = [145, 98, 192, 118, 184, 147, 118, 104];
/// mint_v1's account positions: candy_guard, candy_machine_program, candy_machine, authority pda, payer, minter, owner, asset, collection.
const IX_CANDY_GUARD: usize = 0;
const IX_CANDY_MACHINE: usize = 2;
const IX_MINTER: usize = 5;
const IX_ASSET: usize = 7;
const IX_COLLECTION: usize = 8;

/// Sent by the minter in the same transaction as the mint, AFTER it. Two proofs, both required:
///   1. (review 1, finding 1) the instructions sysvar holds a Core Candy Guard mint_v1 EARLIER in this transaction that
///      mints THIS asset, from THIS escrow's machine and guard, into THIS escrow's collection, to THIS minter, in the
///      group whose label matches the group paid for; the asset signs, so nobody can pay for someone else's asset.
///   2. the asset account EXISTS now as a live MPL Core asset in this escrow's collection. A Candy Guard bot tax turns a
///      failed mint into a successful transaction that creates no asset; with the payment before the mint that left money
///      in the vault with nothing to refund against (devnet rehearsal, 1 October). Paying after the mint and reading the
///      asset makes that impossible: no asset, no payment, and the whole transaction reverts.
#[derive(Accounts)]
pub struct Pay<'info> {
    #[account(mut, seeds = [ESCROW_SEED, escrow.candy_machine.as_ref()], bump = escrow.bump)]
    pub escrow: Account<'info, LaunchEscrow>,
    #[account(mut, seeds = [VAULT_SEED, escrow.key().as_ref()], bump = escrow.vault_bump)]
    pub vault: Account<'info, Vault>,
    #[account(init, payer = minter, space = 8 + MintReceipt::INIT_SPACE, seeds = [RECEIPT_SEED, escrow.key().as_ref(), asset.key().as_ref()], bump)]
    pub receipt: Account<'info, MintReceipt>,
    /// The asset the mint created earlier in this transaction (read as a Core asset). It signs, as it did for the mint.
    pub asset: Signer<'info>,
    #[account(mut)]
    pub minter: Signer<'info>,
    /// CHECK: the instructions sysvar, address checked.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// The group label out of mint_v1 data: mint_args Vec<u8> (u32 len + bytes) then Option<String> group.
fn group_label(d: &[u8]) -> Option<&[u8]> {
    let args_len = u32::from_le_bytes(d.get(0..4)?.try_into().ok()?) as usize;
    let mut o = 4 + args_len;
    let tag = *d.get(o)?;
    o += 1;
    if tag == 0 { return Some(&[]); }
    let n = u32::from_le_bytes(d.get(o..o + 4)?.try_into().ok()?) as usize;
    d.get(o + 4..o + 4 + n)
}

pub fn pay(ctx: Context<Pay>, group: u8, amount: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let e = &mut ctx.accounts.escrow;
    require!(e.status == EscrowStatus::Open, EscrowError::NotOpen);
    require!(!e.paused, EscrowError::Paused);
    require!(now < e.window_end, EscrowError::WindowOver);
    let g = *e.groups.get(group as usize).ok_or(EscrowError::BadGroup)?;
    let due = g.price.checked_add(g.fee).ok_or(EscrowError::Overflow)?;
    require!(amount == due, EscrowError::BadAmount);
    // The asset must exist: a live Core asset in this escrow's collection, created by the mint just before this instruction.
    {
        let a = ctx.accounts.asset.to_account_info();
        require!(*a.owner == crate::mplcore::MPL_CORE_ID, EscrowError::AssetNotMinted);
        let data = a.try_borrow_data()?;
        let (_, coll) = crate::mplcore::asset_owner_and_collection(&data).map_err(|_| EscrowError::AssetNotMinted)?;
        require!(coll == Some(e.collection), EscrowError::AssetNotMinted);
    }
    // The mint that this payment is for must precede it in this transaction.
    let ixs = ctx.accounts.instructions.to_account_info();
    let me = load_current_index_checked(&ixs)? as usize;
    let mut found = false;
    for i in 0..me {
        let Ok(ix) = load_instruction_at_checked(i, &ixs) else { break };
        if ix.program_id != CANDY_GUARD_ID || ix.data.len() < 8 || ix.data[..8] != MINT_V1 || ix.accounts.len() <= IX_COLLECTION { continue; }
        let a = &ix.accounts;
        if a[IX_CANDY_GUARD].pubkey != e.candy_guard || a[IX_CANDY_MACHINE].pubkey != e.candy_machine || a[IX_ASSET].pubkey != ctx.accounts.asset.key()
            || a[IX_MINTER].pubkey != ctx.accounts.minter.key() || a[IX_COLLECTION].pubkey != e.collection { continue; }
        // data: discriminator(8) | mint_args: u32 len + bytes | group: Option<String> = tag(1) [+ u32 len + bytes]
        // A malformed mint-shaped instruction is skipped, not fatal: the real one may follow (review 3, finding 7).
        let Some(label) = group_label(&ix.data[8..]) else { continue };
        if label != g.label_bytes() { continue; }
        found = true;
        break;
    }
    require!(found, EscrowError::MintNotFound);
    transfer(CpiContext::new(ctx.accounts.system_program.to_account_info(), Transfer { from: ctx.accounts.minter.to_account_info(), to: ctx.accounts.vault.to_account_info() }), due)?;
    e.price_in = e.price_in.checked_add(g.price).ok_or(EscrowError::Overflow)?;
    e.fee_in = e.fee_in.checked_add(g.fee).ok_or(EscrowError::Overflow)?;
    e.receipts = e.receipts.checked_add(1).ok_or(EscrowError::Overflow)?;
    e.receipts_open = e.receipts_open.checked_add(1).ok_or(EscrowError::Overflow)?;
    let r = &mut ctx.accounts.receipt;
    r.bump = ctx.bumps.receipt;
    r.escrow = e.key();
    r.asset = ctx.accounts.asset.key();
    r.minter = ctx.accounts.minter.key();
    r.group = group;
    r.price = g.price;
    r.fee = g.fee;
    r.paid_at = now;
    r.refunded = false;
    emit!(Paid { escrow: e.key(), asset: r.asset, minter: r.minter, group, price: g.price, fee: g.fee });
    Ok(())
}
