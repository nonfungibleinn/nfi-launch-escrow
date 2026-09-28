use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::{AccountMeta, Instruction}, program::invoke};
use crate::errors::EscrowError;
use crate::events::Refunded;
use crate::instructions::debit;
use crate::state::*;

pub const MPL_CORE_ID: Pubkey = anchor_lang::solana_program::pubkey!("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const CORE_BURN_V1: u8 = 12;
const CORE_KEY_UNINITIALIZED: u8 = 0;
const CORE_KEY_ASSET_V1: u8 = 1;

#[derive(Clone)]
pub struct MplCore;
impl Id for MplCore {
    fn id() -> Pubkey { MPL_CORE_ID }
}

/// After a cancel. While the asset exists, its current owner signs and the asset is burned in this same instruction;
/// the payment goes to that owner (whoever gives the NFT back is made whole, so a secondary buyer is never trapped),
/// and the receipt's rent goes back to the original minter. Once the asset is the one-byte shell Core leaves after a
/// burn, anyone may crank the refund, which pays the original minter. Anything else at the asset's address is refused.
#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut, seeds = [ESCROW_SEED, escrow.candy_machine.as_ref()], bump = escrow.bump)]
    pub escrow: Account<'info, LaunchEscrow>,
    #[account(mut, seeds = [VAULT_SEED, escrow.key().as_ref()], bump = escrow.vault_bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut, close = minter, seeds = [RECEIPT_SEED, escrow.key().as_ref(), receipt.asset.as_ref()], bump = receipt.bump, has_one = escrow, has_one = minter)]
    pub receipt: Account<'info, MintReceipt>,
    /// CHECK: the original minter named on the receipt; receives the rent, and the payment when the asset is already gone.
    #[account(mut)]
    pub minter: UncheckedAccount<'info>,
    /// CHECK: the asset on the receipt (address checked); MPL Core validates the burn.
    #[account(mut, constraint = asset.key() == receipt.asset @ EscrowError::AssetUnreadable)]
    pub asset: UncheckedAccount<'info>,
    /// CHECK: the launch's collection (address checked against the escrow).
    #[account(mut, constraint = collection.key() == escrow.collection @ EscrowError::AssetNotInCollection)]
    pub collection: UncheckedAccount<'info>,
    /// The asset's owner while it exists (receives the payment); anyone once it is gone. Pays the burn's network fee.
    #[account(mut)]
    pub signer: Signer<'info>,
    pub mpl_core_program: Program<'info, MplCore>,
    pub system_program: Program<'info, System>,
}

pub fn refund(ctx: Context<Refund>) -> Result<()> {
    let e = &mut ctx.accounts.escrow;
    require!(e.status == EscrowStatus::Cancelled, EscrowError::NotCancelled);
    let r = &ctx.accounts.receipt;
    require!(!r.refunded, EscrowError::AlreadyRefunded);
    let asset = &ctx.accounts.asset;
    require!(*asset.owner == MPL_CORE_ID, EscrowError::AssetUnreadable);
    // Exactly two shapes are accepted: a live AssetV1 (key 1, full header), or the one-byte Uninitialized shell (key 0)
    // that Core leaves after a burn. Compressed or otherwise unknown layouts are refused (review 1, finding 3).
    let (exists, owner_now) = {
        let data = asset.try_borrow_data()?;
        if data.len() == 1 && data[0] == CORE_KEY_UNINITIALIZED { (false, Pubkey::default()) }
        else {
            require!(data.len() >= 66 && data[0] == CORE_KEY_ASSET_V1, EscrowError::AssetUnreadable);
            require!(data[33] == 2, EscrowError::AssetNotInCollection);
            let coll = Pubkey::try_from(&data[34..66]).map_err(|_| EscrowError::AssetUnreadable)?;
            require!(coll == e.collection, EscrowError::AssetNotInCollection);
            (true, Pubkey::try_from(&data[1..33]).map_err(|_| EscrowError::AssetUnreadable)?)
        }
    };
    let amount = r.price.checked_add(r.fee).ok_or(EscrowError::Overflow)?;
    let paid_to = if exists {
        require!(ctx.accounts.signer.key() == owner_now, EscrowError::NotOwner);
        // BurnV1: asset (w), collection (w), payer (s, w), authority (s), system program, log wrapper (none: Core's own id).
        let metas = vec![
            AccountMeta::new(asset.key(), false),
            AccountMeta::new(ctx.accounts.collection.key(), false),
            AccountMeta::new(ctx.accounts.signer.key(), true),
            AccountMeta::new_readonly(ctx.accounts.signer.key(), true),
            AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            AccountMeta::new_readonly(MPL_CORE_ID, false),
        ];
        let ix = Instruction { program_id: MPL_CORE_ID, accounts: metas, data: vec![CORE_BURN_V1, 0] };
        invoke(&ix, &[asset.to_account_info(), ctx.accounts.collection.to_account_info(), ctx.accounts.signer.to_account_info(), ctx.accounts.signer.to_account_info(), ctx.accounts.system_program.to_account_info(), ctx.accounts.mpl_core_program.to_account_info()])?;
        debit(&ctx.accounts.vault.to_account_info(), &ctx.accounts.signer.to_account_info(), amount)?;
        owner_now
    } else {
        debit(&ctx.accounts.vault.to_account_info(), &ctx.accounts.minter.to_account_info(), amount)?;
        r.minter
    };
    e.price_refunded = e.price_refunded.checked_add(r.price).ok_or(EscrowError::Overflow)?;
    e.fee_refunded = e.fee_refunded.checked_add(r.fee).ok_or(EscrowError::Overflow)?;
    e.receipts_open = e.receipts_open.checked_sub(1).ok_or(EscrowError::Overflow)?;
    let asset_key = r.asset;
    ctx.accounts.receipt.refunded = true;
    emit!(Refunded { escrow: e.key(), asset: asset_key, minter: paid_to, amount, burned: exists });
    Ok(())
}
