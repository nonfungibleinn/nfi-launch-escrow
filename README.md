# nfi_launch_escrow

The on-chain half of the NFI Launchpad's refund model (launch.nfinn.io). Mint payments are held per launch until the
window ends; if the launch is cancelled first, every minter takes their whole payment back by burning the asset. The
design, the account layout, the instruction rules and the attack list live in the NFI Launchpad blueprint, section
"Phase 2b design". Modelled on nfi_raffle.

Program id: `3qRS59TJmgaNUzKjKsUe3XGggodSXA9GHU9Q5u2ffE1n`. The deploy keypair is **not** in this repository.

## Status

Revision 0.4 (27 September 2026): three adversarial review rounds fixed; the attack-first suite (30 cases, real Core
Candy Machine, Candy Guard and MPL Core fixtures) passes on a local validator. Not yet: devnet dual running beside the
freeze guard, service integration (below), mainnet. Unaudited.

## Money flow

```
init (creator + NFI sign) ──pay×N (in each mint tx)──▶ Open ──release (anyone, after window_end)──▶ Released ──release_fee (anyone) ──▶ close_receipt×N, return_collection, close_escrow
                                                        │
                                                        └──cancel (NFI or creator)──▶ Cancelled ──refund×N (burns the asset; forever)──▶ return_collection, close_escrow once every receipt is refunded
```

Decisions (owner, 27 September 2026): refunds never expire; NFI's fee is refunded on a cancel; a refund burns the
asset in the same instruction.

## What the escrow holds besides the money

For the life of the escrow the launch collection's **update authority is the escrow PDA** (review 2, finding 1).
`init` takes it over itself, by CPI with the creator's signature, so a failed init never orphans a collection
(review 3, finding 3). Before that it reads the candy machine (its authority must be the creator and its collection
this collection; its mint authority is the guard pay will look for) and screens the collection's plugins with an
ALLOWLIST: Royalties, Attributes, AddBlocker, ImmutableMetadata, VerifiedCreators, Autograph and exactly one
UpdateDelegate, which must belong to the update authority and name at most the machine's own authority PDA as its
additional delegate. Anything else, and any external plugin adapter, is refused. The pin matters: Core lets an update
delegate change the collection's update authority, so a delegate the creator kept could take the collection back after
init and then attach a burn-vetoing oracle (review 3, finding 1). So while a refund is still possible nobody can add a
plugin that vetoes a burn, move an asset out of the collection, freeze it or claw it back.
The creator's reveal (new name and URI per asset) goes through `update_asset`, which the program signs, and is refused
after a cancel. `return_collection` (anyone; the destination is the creator fixed at init) hands the authority back
once the escrow is final: after a release, or after a cancel once every receipt is refunded. A cancelled launch with one unclaimed receipt keeps its collection in escrow:
that is the price of refunds that never expire.

The Core Candy Machine keeps minting after the handover: it acts through the UpdateDelegate plugin its `initialize`
added to the collection, not through the update authority.

## Who may do what

| instruction | who | when |
| --- | --- | --- |
| init_config | the program's upgrade authority, once, **right after the deploy** and before any authority change | |
| update_config, propose/accept_authority | the config authority | |
| init | creator (the machine's authority and the collection's update authority) + NFI's key (from the config) | |
| pay | the minter, in the mint transaction, before `mint_v1` | Open, not paused, before window_end |
| cancel | NFI's **current** config key, or the creator | Open, before window_end |
| set_paused | NFI's current config key | any time; blocks pay only |
| refund | the asset's owner (burns it); anyone once it is a burned shell | Cancelled |
| release | anyone | Open, after window_end |
| release_fee | anyone | Released, once |
| update_asset | the creator | not Cancelled |
| return_collection | anyone, to the creator | final |
| close_receipt | anyone | Released |
| close_escrow | the creator | final, fee leg done, collection returned, no open receipt |

Rotating `nfi_authority` in the config revokes the old key on every live escrow at once. The payout wallet, the
treasury, the window and the prices are fixed at init and never change. Payout and treasury must be plain system
wallets (checked), and the two release legs are separate so a treasury that cannot take a credit can never hold the
creator's share.

## Build and test

Inside WSL (the SBF toolchain does not like `/mnt/c`):

```
bash ops/wsl-build.sh sync && bash ops/wsl-build.sh pin && bash ops/wsl-build.sh build && bash ops/wsl-build.sh test
```

`--features test` shortens the minimum window to five seconds so the whole life runs in one test. Never on for a
deploy: `bash ops/wsl-build.sh check` prints `MIN_WINDOW_SECS` from the built IDL, and it must read 3600.

## What a refund cannot do, and what the service must therefore refuse

- **A frozen asset cannot burn.** Core refuses BurnV1 while a FreezeDelegate says frozen (a marketplace escrow listing,
  a staking lock, or a Candy Guard freeze payment). The refund fails cleanly and works after the thaw (tested). So an
  escrow launch must carry NO Freeze Sol Payment or Freeze Token Payment guard (the approval step checks), and the
  refund UI says "unlist or unstake first" when the asset is frozen.
- **No bot tax on an escrow launch.** Candy Guard's bot tax turns a failed mint into a successful transaction that
  creates no asset; `pay` has already moved the money by then, so the vault would hold a payment with nothing to refund
  against. Newer guard builds also refuse any unknown program in the transaction when the tax's last-instruction rule
  is on. The service never configures a bot tax beside the escrow; its permit simulation refuses bad mints before they
  are sent instead.
- **A mint paid for someone else** (mint_v1 lets the minter name another owner): while the asset exists its owner
  refunds and is paid; once burned outside the program, the crank pays the receipt's minter, not the owner. The UI
  says so on gifts.
- **Trust roots.** The upgrade authority can replace the program; the config authority can rotate NFI's key and cancel
  any live launch (griefing only, never theft). Both must be a multisig on mainnet (a Squads vault signing `init_config`
  by CPI passes the ProgramData check). A non-upgradeable deploy without a config is a dead program.

## Service integration (nfi-verify), still to do

- Deploy plan: create collection (creator authority), create machine, then `init` signed by creator + NFI (it hands
  the collection over itself); `pay` placed before `mintV1` in the permit builder; no Sol Payment, Sol Fixed Fee or
  Freeze guard on escrow launches (the escrow is the price).
- Approval compares the escrow's groups, payout, window and collection to the studio build, and the collection's
  update authority to the escrow PDA.
- Reveal path: hidden reveals call `update_asset`, not Core directly.
- Operator Cancel and Pause; the creator's Cancel; the minter's "refund, don't burn" UI (with the frozen and gift
  notes above); `return_collection` and `close_escrow` on the dashboard once final.

## Layout

```
programs/nfi_launch_escrow/src
  lib.rs            instruction list
  state.rs          Config, LaunchEscrow, MintReceipt, Vault, constants
  mplcore.rs        the MPL Core layouts read by hand and the hand-built BurnV1, UpdateV1, UpdateCollectionV1 CPIs
  instructions/     config, init, pay, admin (cancel, set_paused), refund, release (+ release_fee, return_collection), reveal (update_asset), close
tests/escrow.ts     lifecycle and attacks
tests/fixtures      mpl_core.so, mpl_core_candy_machine.so, mpl_core_candy_guard.so (mainnet dumps)
```
