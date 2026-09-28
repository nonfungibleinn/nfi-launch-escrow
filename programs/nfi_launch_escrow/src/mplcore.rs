//! The little of MPL Core and the Core Candy Machine this program reads and calls, by hand: the Rust clients overflow
//! the SBF stack frame (learned on nfi_raffle), so account layouts are parsed at fixed offsets and the Core
//! instructions are built as raw metas.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::{AccountMeta, Instruction}, program::invoke_signed};
use crate::errors::EscrowError;

pub const MPL_CORE_ID: Pubkey = anchor_lang::solana_program::pubkey!("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
pub const CANDY_MACHINE_ID: Pubkey = anchor_lang::solana_program::pubkey!("CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J");
const CANDY_MACHINE_DISC: [u8; 8] = [51, 173, 177, 113, 25, 241, 109, 189];
pub const KEY_UNINITIALIZED: u8 = 0;
pub const KEY_ASSET_V1: u8 = 1;
pub const KEY_COLLECTION_V1: u8 = 5;
const IX_BURN_V1: u8 = 12;
const IX_UPDATE_V1: u8 = 15;
const IX_UPDATE_COLLECTION_V1: u8 = 16;
const PLUGIN_UPDATE_DELEGATE: u8 = 4;
/// Collection plugins a launch may carry: Royalties, UpdateDelegate (pinned below), Attributes, AddBlocker,
/// ImmutableMetadata, VerifiedCreators, Autograph. Everything else (every freeze, transfer or burn delegate, editions,
/// Bubblegum, execute freezes, groups, anything newer) is refused: an allowlist, so a future plugin type cannot slip in.
const PLUGINS_ALLOWED: [u8; 7] = [0, 4, 6, 11, 12, 13, 14];

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

/// The Core Candy Machine's authority PDA: the one key allowed as the collection's additional update delegate.
pub fn candy_machine_authority_pda(candy_machine: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"candy_machine", candy_machine.as_ref()], &CANDY_MACHINE_ID).0
}

/// A Core Candy Machine's authority, mint authority (its guard) and collection: disc(8) | authority | mint_authority | collection_mint.
pub fn candy_machine_view(data: &[u8]) -> Result<(Pubkey, Pubkey, Pubkey)> {
    require!(data.len() >= 104 && data[..8] == CANDY_MACHINE_DISC, EscrowError::BadMachine);
    Ok((rd_pk(data, 8)?, rd_pk(data, 40)?, rd_pk(data, 72)?))
}

/// Refuses a collection whose plugins could defeat a refund or bite a holder (review 2 finding 1, review 3 findings
/// 1 and 2). Allowlist of plugin types; no external plugin adapters (an oracle or a lifecycle hook can veto burns);
/// and the UpdateDelegate is PINNED: exactly one, owned by the update authority (never an address the creator keeps),
/// with at most one additional delegate and that one the candy machine's authority PDA. Otherwise a delegate the
/// creator kept could hand the collection back to themselves after init and block every refund.
/// Layout per the MPL Core account docs, as nfi_raffle reads it.
pub fn screen_collection(data: &[u8], cm_authority: &Pubkey) -> Result<()> {
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
    let mut update_delegates = 0u8;
    for _ in 0..n {
        let plugin_type = *data.get(p).ok_or(EscrowError::CoreUnreadable)?;
        require!(PLUGINS_ALLOWED.contains(&plugin_type), EscrowError::CollectionPluginRefused);
        let auth = *data.get(p + 1).ok_or(EscrowError::CoreUnreadable)?; // Authority: 0 None | 1 Owner | 2 UpdateAuthority | 3 Address(pk)
        require!(auth <= 3, EscrowError::CollectionPluginRefused);
        let auth_len = if auth == 3 { 32 } else { 0 };
        let offset = rd_u64(data, p + 2 + auth_len)? as usize;
        if plugin_type == PLUGIN_UPDATE_DELEGATE {
            update_delegates += 1;
            require!(update_delegates == 1 && auth == 2, EscrowError::CollectionPluginRefused);
            // Plugin::UpdateDelegate { additional_delegates: Vec<Pubkey> }: variant(1) | u32 len | keys
            require!(data.get(offset) == Some(&PLUGIN_UPDATE_DELEGATE), EscrowError::CoreUnreadable);
            let k = rd_u32(data, offset + 1)? as usize;
            require!(k <= 1, EscrowError::CollectionPluginRefused);
            if k == 1 { require!(rd_pk(data, offset + 5)? == *cm_authority, EscrowError::CollectionPluginRefused); }
        }
        p += 2 + auth_len + 8;
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
    invoke_signed(&ix, &[asset.clone(), collection.clone(), owner.clone(), owner.clone(), system.clone(), core.clone()], &[])?;
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

/// UpdateCollectionV1 that hands the update authority to `to`: collection (w), payer (s, w), authority (s: the current
/// update authority, a wallet passing its signature through or the escrow PDA by seeds), new_update_authority, system,
/// log wrapper (none). Name and URI untouched.
pub fn hand_collection<'info>(collection: &AccountInfo<'info>, payer: &AccountInfo<'info>, authority: &AccountInfo<'info>, to: &AccountInfo<'info>, system: &AccountInfo<'info>, core: &AccountInfo<'info>, seeds: &[&[&[u8]]]) -> Result<()> {
    let metas = vec![
        AccountMeta::new(collection.key(), false),
        AccountMeta::new(payer.key(), true),
        AccountMeta::new_readonly(authority.key(), true),
        AccountMeta::new_readonly(to.key(), false),
        AccountMeta::new_readonly(system.key(), false),
        AccountMeta::new_readonly(MPL_CORE_ID, false),
    ];
    let ix = Instruction { program_id: MPL_CORE_ID, accounts: metas, data: vec![IX_UPDATE_COLLECTION_V1, 0, 0] };
    invoke_signed(&ix, &[collection.clone(), payer.clone(), authority.clone(), to.clone(), system.clone(), core.clone()], seeds)?;
    Ok(())
}
