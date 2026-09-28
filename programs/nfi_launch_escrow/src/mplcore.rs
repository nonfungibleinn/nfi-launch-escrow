//! The little of MPL Core this program reads and calls, by hand: the Rust client overflows the SBF stack frame (learned
//! on nfi_raffle), so account layouts are parsed at fixed offsets and the four instructions are built as raw metas.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::{AccountMeta, Instruction}, program::{invoke, invoke_signed}};
use crate::errors::EscrowError;

pub const MPL_CORE_ID: Pubkey = anchor_lang::solana_program::pubkey!("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
pub const KEY_UNINITIALIZED: u8 = 0;
pub const KEY_ASSET_V1: u8 = 1;
pub const KEY_COLLECTION_V1: u8 = 5;
const IX_BURN_V1: u8 = 12;
const IX_UPDATE_V1: u8 = 15;
const IX_UPDATE_COLLECTION_V1: u8 = 16;

#[derive(Clone)]
pub struct MplCore;
impl Id for MplCore {
    fn id() -> Pubkey { MPL_CORE_ID }
}

fn rd_u32(data: &[u8], o: usize) -> Result<u32> { Ok(u32::from_le_bytes(data.get(o..o + 4).ok_or(EscrowError::CoreUnreadable)?.try_into().unwrap())) }
fn rd_u64(data: &[u8], o: usize) -> Result<u64> { Ok(u64::from_le_bytes(data.get(o..o + 8).ok_or(EscrowError::CoreUnreadable)?.try_into().unwrap())) }
fn rd_pk(data: &[u8], o: usize) -> Result<Pubkey> { Pubkey::try_from(data.get(o..o + 32).ok_or(EscrowError::CoreUnreadable)?).map_err(|_| EscrowError::CoreUnreadable.into()) }

/// A live asset's owner and collection: key(1) | owner(32) | update_authority tag(1) (2 = Collection) + pubkey(32).
pub fn asset_owner_and_collection(data: &[u8]) -> Result<(Pubkey, Option<Pubkey>)> {
    require!(data.len() >= 34 && data[0] == KEY_ASSET_V1, EscrowError::AssetUnreadable);
    let owner = rd_pk(data, 1)?;
    let coll = if data[33] == 2 { Some(rd_pk(data, 34)?) } else { None };
    Ok((owner, coll))
}

/// A collection's update authority: key(1) | update_authority(32).
pub fn collection_update_authority(data: &[u8]) -> Result<Pubkey> {
    require!(data.len() >= 33 && data[0] == KEY_COLLECTION_V1, EscrowError::CoreUnreadable);
    rd_pk(data, 1)
}

/// Refuses a collection whose plugins could defeat a refund or bite a holder: a permanent freeze, transfer or burn
/// delegate (the creator could freeze, claw back or burn sold assets) or any external plugin adapter (an oracle or a
/// lifecycle hook can veto burns). Layout per the MPL Core account docs, as nfi_raffle reads it.
pub fn screen_collection(data: &[u8]) -> Result<()> {
    require!(data.len() >= 33 && data[0] == KEY_COLLECTION_V1, EscrowError::CoreUnreadable);
    let mut o = 1 + 32; // key, update authority
    o += 4 + rd_u32(data, o)? as usize; // name
    o += 4 + rd_u32(data, o)? as usize; // uri
    o += 8; // num_minted, current_size
    if o >= data.len() { return Ok(()); } // no plugin header: no plugins at all
    require!(data[o] == 3, EscrowError::CollectionPluginRefused); // PluginHeaderV1
    let reg = rd_u64(data, o + 1)? as usize;
    require!(data.get(reg) == Some(&4), EscrowError::CollectionPluginRefused); // PluginRegistryV1
    let n = rd_u32(data, reg + 1)? as usize;
    let mut p = reg + 5;
    for _ in 0..n {
        let plugin_type = *data.get(p).ok_or(EscrowError::CoreUnreadable)?;
        // 5 PermanentFreezeDelegate, 7 PermanentTransferDelegate, 8 PermanentBurnDelegate
        require!(!matches!(plugin_type, 5 | 7 | 8), EscrowError::CollectionPluginRefused);
        let auth = *data.get(p + 1).ok_or(EscrowError::CoreUnreadable)?; // Authority: None | Owner | UpdateAuthority | Address(pk)
        p += 2 + if auth == 3 { 32 } else { 0 } + 8; // + offset u64
    }
    require!(rd_u32(data, p)? == 0, EscrowError::CollectionPluginRefused); // external plugin adapters
    Ok(())
}

/// BurnV1 by the asset's owner: asset (w), collection (w) or Core's id when none, payer (s, w), authority (s), system, log wrapper (none).
pub fn burn<'info>(asset: &AccountInfo<'info>, collection: &AccountInfo<'info>, owner: &AccountInfo<'info>, system: &AccountInfo<'info>, core: &AccountInfo<'info>) -> Result<()> {
    let metas = vec![
        AccountMeta::new(asset.key(), false),
        AccountMeta::new(collection.key(), false),
        AccountMeta::new(owner.key(), true),
        AccountMeta::new_readonly(owner.key(), true),
        AccountMeta::new_readonly(system.key(), false),
        AccountMeta::new_readonly(MPL_CORE_ID, false),
    ];
    let ix = Instruction { program_id: MPL_CORE_ID, accounts: metas, data: vec![IX_BURN_V1, 0] };
    invoke(&ix, &[asset.clone(), collection.clone(), owner.clone(), owner.clone(), system.clone(), core.clone()])?;
    Ok(())
}

fn opt_string(out: &mut Vec<u8>, s: &Option<String>) {
    match s {
        None => out.push(0),
        Some(v) => { out.push(1); out.extend_from_slice(&(v.len() as u32).to_le_bytes()); out.extend_from_slice(v.as_bytes()); }
    }
}

/// UpdateV1 by the collection's update authority (the escrow PDA, signing by seeds): asset (w), collection, payer (s, w),
/// authority (s), system, log wrapper (none). Name and URI only; the update authority is never changed here.
pub fn update_asset<'info>(asset: &AccountInfo<'info>, collection: &AccountInfo<'info>, payer: &AccountInfo<'info>, escrow: &AccountInfo<'info>, system: &AccountInfo<'info>, core: &AccountInfo<'info>, seeds: &[&[&[u8]]], name: Option<String>, uri: Option<String>) -> Result<()> {
    let metas = vec![
        AccountMeta::new(asset.key(), false),
        AccountMeta::new_readonly(collection.key(), false),
        AccountMeta::new(payer.key(), true),
        AccountMeta::new_readonly(escrow.key(), true),
        AccountMeta::new_readonly(system.key(), false),
        AccountMeta::new_readonly(MPL_CORE_ID, false),
    ];
    let mut data = vec![IX_UPDATE_V1];
    opt_string(&mut data, &name);
    opt_string(&mut data, &uri);
    data.push(0); // new_update_authority: None
    let ix = Instruction { program_id: MPL_CORE_ID, accounts: metas, data };
    invoke_signed(&ix, &[asset.clone(), collection.clone(), payer.clone(), escrow.clone(), system.clone(), core.clone()], seeds)?;
    Ok(())
}

/// UpdateCollectionV1 that hands the update authority to `to`: collection (w), payer (s, w), authority (s, the escrow PDA),
/// new_update_authority, system, log wrapper (none). Name and URI untouched.
pub fn hand_collection<'info>(collection: &AccountInfo<'info>, payer: &AccountInfo<'info>, escrow: &AccountInfo<'info>, to: &AccountInfo<'info>, system: &AccountInfo<'info>, core: &AccountInfo<'info>, seeds: &[&[&[u8]]]) -> Result<()> {
    let metas = vec![
        AccountMeta::new(collection.key(), false),
        AccountMeta::new(payer.key(), true),
        AccountMeta::new_readonly(escrow.key(), true),
        AccountMeta::new_readonly(to.key(), false),
        AccountMeta::new_readonly(system.key(), false),
        AccountMeta::new_readonly(MPL_CORE_ID, false),
    ];
    let ix = Instruction { program_id: MPL_CORE_ID, accounts: metas, data: vec![IX_UPDATE_COLLECTION_V1, 0, 0] };
    invoke_signed(&ix, &[collection.clone(), payer.clone(), escrow.clone(), to.clone(), system.clone(), core.clone()], seeds)?;
    Ok(())
}
