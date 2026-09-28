use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use crate::errors::EscrowError;
use crate::events::Paid;
use crate::state::*;

/// Sent by the minter in the same transaction as the mint, before it. The asset key is the mint's asset signer, so the
/// receipt's address is the asset's: no asset can be paid for twice, and a payment cannot exist without its mint
/// (the transaction is atomic). The amount must be exactly the group's price plus fee.
#[derive(Accounts)]
pub struct Pay<'info> {
    #[account(mut, seeds = [ESCROW_SEED, escrow.candy_machine.as_ref()], bump = escrow.bump)]
    pub escrow: Account<'info, LaunchEscrow>,
    #[account(mut, seeds = [VAULT_SEED, escrow.key().as_ref()], bump = escrow.vault_bump)]
    pub vault: Account<'info, Vault>,
    #[account(init, payer = minter, space = 8 + MintReceipt::INIT_SPACE, seeds = [RECEIPT_SEED, escrow.key().as_ref(), asset.key().as_ref()], bump)]
    pub receipt: Account<'info, MintReceipt>,
    /// CHECK: the asset the mint creates later in this transaction; only its address is used here.
    pub asset: UncheckedAccount<'info>,
    #[account(mut)]
    pub minter: Signer<'info>,
    pub system_program: Program<'info, System>,
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
