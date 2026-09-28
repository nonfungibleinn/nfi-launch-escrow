use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::{AccountMeta, Instruction}, program::invoke};
use crate::errors::EscrowError;
use crate::events::Refunded;
use crate::instructions::debit;
use crate::state::*;

pub const MPL_CORE_ID: Pubkey = anchor_lang::solana_program::pubkey!("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const CORE_BURN_V1: u8 = 12;

#[derive(Clone)]
pub struct MplCore;
impl Id for MplCore {
    fn id() -> Pubkey { MPL_CORE_ID }
}

/// After a cancel. While the asset exists, its owner (the minter) must sign and the asset is burned in this same
/// instruction, so nobody keeps both the NFT and the money. Once the asset is gone (burned earlier by its owner),
/// anyone may crank the refund; the money always goes to the minter named on the receipt, and the receipt's rent too.
#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut, seeds = [ESCROW_SEED, escrow.candy_machine.as_ref()], bump = escrow.bump)]
    pub escrow: Account<'info, LaunchEscrow>,
    #[account(mut, seeds = [VAULT_SEED, escrow.key().as_ref()], bump = escrow.vault_bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut, close = minter, seeds = [RECEIPT_SEED, escrow.key().as_ref(), receipt.asset.as_ref()], bump = receipt.bump, has_one = escrow, has_one = minter)]
    pub receipt: Account<'info, MintReceipt>,
    /// CHECK: the receipt names the minter; funds and rent go here whoever signs.
    #[account(mut)]
    pub minter: UncheckedAccount<'info>,
    /// CHECK: the asset on the receipt (address checked); MPL Core validates the burn.
    #[account(mut, constraint = asset.key() == receipt.asset @ EscrowError::AssetNotOwned)]
    pub asset: UncheckedAccount<'info>,
    /// CHECK: the launch's collection (address checked against the escrow).
    #[account(mut, constraint = collection.key() == escrow.collection @ EscrowError::AssetNotInCollection)]
    pub collection: UncheckedAccount<'info>,
    /// The minter while the asset exists; anyone once it is gone. Pays the burn's network fee.
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
    let exists = asset.lamports() > 0 && asset.data_len() > 0 && *asset.owner == MPL_CORE_ID;
    let mut burned = false;
    if exists {
        // The asset must be this minter's and this launch's, read straight from what MPL Core wrote:
        // key(1) | owner(32) | update_authority: tag(1) = 2 for Collection, then the collection(32).
        let data = asset.try_borrow_data()?;
        require!(data.len() >= 66 && data[0] == 1, EscrowError::AssetUnreadable);
        let owner = Pubkey::try_from(&data[1..33]).map_err(|_| EscrowError::AssetUnreadable)?;
        require!(owner == r.minter, EscrowError::AssetNotOwned);
        require!(data[33] == 2, EscrowError::AssetNotInCollection);
        let coll = Pubkey::try_from(&data[34..66]).map_err(|_| EscrowError::AssetUnreadable)?;
        require!(coll == e.collection, EscrowError::AssetNotInCollection);
        drop(data);
        require!(ctx.accounts.signer.key() == r.minter, EscrowError::NotMinter);
        // BurnV1: asset (w), collection (w), payer (s, w), authority (s), log wrapper (none), system program.
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
        burned = true;
    }
    let amount = r.price.checked_add(r.fee).ok_or(EscrowError::Overflow)?;
    debit(&ctx.accounts.vault.to_account_info(), &ctx.accounts.minter.to_account_info(), amount)?;
    e.price_refunded = e.price_refunded.checked_add(r.price).ok_or(EscrowError::Overflow)?;
    e.fee_refunded = e.fee_refunded.checked_add(r.fee).ok_or(EscrowError::Overflow)?;
    e.receipts_open = e.receipts_open.checked_sub(1).ok_or(EscrowError::Overflow)?;
    let asset_key = r.asset;
    let minter = r.minter;
    ctx.accounts.receipt.refunded = true;
    emit!(Refunded { escrow: e.key(), asset: asset_key, minter, amount, burned });
    Ok(())
}
