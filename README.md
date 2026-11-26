# nfi_launch_escrow

The on-chain half of the NFI Launchpad's refund model (nfinn.io/launch). Mint payments are held per launch until the
window ends; if the launch is cancelled first, every holder takes the whole payment back by burning the asset. The
design, the account layout and the instruction rules live in the NFI Launchpad blueprint, section "Phase 2b design".
Modelled on nfi_raffle.

Program id: `3qRS59TJmgaNUzKjKsUe3XGggodSXA9GHU9Q5u2ffE1n`. The deploy keypair is **not** in this repository.

## Status

Revision 0.5.3 (25 November 2026; 0.5.2 on 1 November, 0.5.1 on 7 October, 0.5 on 6 October): the round-4 review fixes (an
independent multi-reviewer audit of program and service), then hardening. 0.5.2: the mint number a receipt records is
cross-checked against the escrow's own receipt count on every mint, and the reveal judges "sold out" by that count, so a
changed Candy Machine layout stops minting instead of writing a wrong mint number. 0.5.3 (the 9 October verification audit):
`set_permit` and `set_group` are removed, so nothing but a pause can change a launch after init; the reveal tree is
positional with a proof of exactly the tree's depth; a burned asset counts as revealed; an address Core no longer owns is a
gone asset for refunds; while the escrow holds the collection a refund's live asset must be in it. No account layout changed.
The suite (27 cases, real MPL Core, Core Candy Machine and Candy Guard fixtures from mainnet) passes on a local
validator. Devnet only. Not independently audited.

## Money flow

```
init (creator + payout + NFI sign) ──pay_and_mint×N──▶ Open ──release (anyone, after window_end)──▶ Released ──release_fee (anyone)──▶ reveal×N (if committed), close_receipt×N, return_collection, close_escrow
                                                        │
                                                        └──cancel (NFI's canceller or the creator)──▶ Cancelled ──refund×N (burns the asset; forever)──▶ return_collection (all refunded, or 30 days after the cancel), close_escrow once every receipt is refunded
```

Decisions (owner): refunds never expire; NFI's fee is refunded on a cancel; a refund burns the asset in the same
instruction (27 September). On 6 October: payment and mint are one instruction; NFI's hot key cannot cancel; the
collection goes back 30 days after a cancel even with refunds unclaimed; a hidden reveal is committed at init.

## Minting: pay_and_mint is the only way

`init` makes the escrow PDA the Candy Machine's **authority and mint authority** (and the collection's update
authority, below). The machine mints only for its mint authority, so the only mint left is `pay_and_mint`, which in one
instruction:

1. checks the escrow is open and not paused, the phase has started and not ended, its allocation is not minted out and
   the wallet is under the phase's per-wallet limit (a counter PDA per wallet and phase);
2. moves the phase's price plus NFI's fee from the minter into the vault;
3. asks the machine to mint a fresh asset (the machine refuses an existing account) with no plugins, owned by the minter;
4. writes the receipt naming that asset and its mint number: the machine's redeemed count, which must equal the receipts
   written so far (the escrow has been the machine's only minter since init), or the mint is refused.

NFI's per-launch permit key co-signs every mint for the policies that live off chain (allowlists, per-account limits).
A leak of that key lets a wallet skip a policy; it never lets anyone mint without paying. The key is fixed at init: the
answer to a leaked permit is a pause (hot key), then a cancel (canceller or creator).
The Candy Guard the SDK creates with the machine is orphaned at init and can no longer mint. Prices, phase times,
allocations and per-wallet limits are all fixed at init.

## What the escrow holds besides the money

For the life of the escrow the launch collection's **update authority is the escrow PDA**. `init` takes it over
itself, by CPI with the creator's signature, so a failed init never orphans a collection. Before that it requires the
collection to be empty (no asset minted outside the escrow) and screens its plugins with an ALLOWLIST: Royalties,
Attributes, ImmutableMetadata (not on a reveal launch), VerifiedCreators, Autograph and exactly one UpdateDelegate, which
must belong to the update authority and name at most the machine's own authority PDA as its additional delegate. No
plugin may sit under an Address authority (a key the creator kept). Anything else, and any external plugin adapter, is
refused. So while a refund is still possible nobody can add a plugin that vetoes a burn, move an asset out of the
collection, freeze it or claw it back.

`return_collection` (anyone; the destination is the creator fixed at init) hands the collection's update authority and
the machine's authority back once the escrow is final:
- after a release, at once; on a reveal launch once every asset is revealed or 30 days after the window ended;
- after a cancel, once every receipt is refunded **or 30 days after the cancel**. The refund money stays in the vault and
  stays claimable forever. But from then on the creator holds the collection, and a creator who adds a burn-vetoing
  adapter or moves an asset to another collection could block a refund still unclaimed. That is the owner's choice
  (6 October 2026) and the refund terms say so: claim within 30 days of a cancel.

## Reveal

A hidden-settings machine must come with a reveal commitment at init: the Merkle root of every item's final
(mint number, name, URI), leaves `sha256(0x00 | u64 LE mint number | u32 len | name | u32 len | uri)`, nodes
`sha256(0x01 | left | right)`. The tree is positional and full: leaf i is item i, the leaves are padded with 32 zero
bytes to the next power of two, and a proof is exactly the tree's depth long (at most 20), so one mint number has one
leaf. A machine with final config lines must not have one. `reveal` is permissionless,
waits until minting is over (sold out by the escrow's receipt count, window ended, or not open), accepts only the committed leaf for the asset's mint
number (recorded on its receipt), runs once per asset, and locks the asset (ImmutableMetadata, no authority): nobody,
the creator included, can change a revealed asset's name or URI again. The lock sits on each asset, not the collection,
because a collection-level ImmutableMetadata also refuses the handover of the update authority. A burned asset has
nothing to reveal: `reveal` counts it with no proof and no write, so a burn cannot hold the collection back.

## Who may do what

| instruction | who | when |
| --- | --- | --- |
| init_config | the program's upgrade authority, once, **right after the deploy** and before any authority change | |
| set_nfi_authority, set_canceller, set_treasury, propose/accept_authority | the config authority (the multisig on mainnet) | |
| init | creator (the machine's authority and the collection's update authority) + payout wallet + NFI's hot key | |
| pay_and_mint | the minter + the launch's permit key | Open, not paused, before window_end, phase open |
| cancel | the config's **canceller** (cold), or the creator | Open, before window_end |
| set_paused | NFI's hot key | any time; touches minting only |
| refund | the asset's owner (burns it); anyone once it is burned (incl. after Core's Collect) | Cancelled |
| release | anyone | Open, after window_end |
| release_fee | anyone | Released, once |
| reveal | anyone, to the committed metadata only | minting over, collection not returned |
| return_collection | anyone, to the creator | final (see above) |
| close_receipt | anyone | Released, and the asset revealed if a reveal is committed |
| close_counter | anyone | not Open |
| close_escrow | the creator | final, fee leg done, collection returned, no open receipt, no open mint counter (their rent is the minters') |

Rotating a key in the config revokes the old one on every live escrow at once. The payout wallet, the treasury, the
window and the prices are fixed at init and never change. Payout and treasury must be plain, rent-exempt system wallets
(checked), the payout wallet signs init, and the two release legs are separate so a treasury that cannot take a credit
can never hold the creator's share.

## What a compromised key can do

- **Upgrade authority**: anything (replace the program). Must be the NFI Programs multisig with a timelock on mainnet.
- **Config authority**: rotate the hot key, the canceller and the treasury of FUTURE escrows. Same multisig.
- **Canceller**: cancel open launches (refunds open; nothing is taken). The multisig on mainnet.
- **Hot NFI key** (the service): pause minting and co-sign inits. It cannot change a launch, cancel, release, refund
  or move any lamport.
- **A permit key**: let a wallet skip an off-chain policy (allowlist, per-account limit) on its launch; never a free mint.

## Build and test

Inside WSL (the SBF toolchain does not like `/mnt/c`):

```
bash ops/wsl-build.sh sync && bash ops/wsl-build.sh pin && bash ops/wsl-build.sh build && bash ops/wsl-build.sh test
```

The value-conservation property test (`tests/audit-property.ts`: a model of every escrow, vault, receipt and counter checked after each of about 12,000 random actions over 4 seeds) runs on its own with `bash ops/wsl-build.sh property`, about 50 minutes, on a validator on private ports; the default `test` runs the suite only.

`--features test` shortens the minimum window to five seconds and the two 30-day grace periods to six seconds so the
whole life runs in one test. Never on for a deploy. `anchor-lang` is pinned exactly.

**Verifiable build, the only production build.** `bash ops/wsl-build.sh build-verifiable` builds the production program
in the Solana Foundation's verifiable-build image (`solanafoundation/solana-verifiable-build:4.2.2`, needs docker) and
writes the binary, its IDL and its sha256 to `target/prod/`; it stops, leaving no `target/prod`, if any step fails.
`ops/devnet.sh` and `ops/mainnet.sh` deploy only that binary, only if its hash matches and its IDL says
`MIN_WINDOW_SECS` = 3600. Anyone can then check the deployed program against this repository:

```
solana-verify verify-from-repo -u devnet --program-id 3qRS59TJmgaNUzKjKsUe3XGggodSXA9GHU9Q5u2ffE1n \
  --library-name nfi_launch_escrow --base-image solanafoundation/solana-verifiable-build:4.2.2 \
  --commit-hash <commit> https://github.com/nonfungibleinn/nfi-launch-escrow
```

On devnet the program at commit `e41551d` (revision 0.5.2) verifies (executable hash `4db9da8b…`), with the verification record
on chain; before it, `c6b7113` (0.5.1, hash `602fe0a6…`).

**Upgrades and account layouts.** `LaunchEscrow`, `MintReceipt` and `MintCounter` carry no version field. An upgrade
must not change an account layout while any escrow, receipt or counter of the old layout is open: the new program could
not read them, and their refunds, releases and closes would fail. A layout change waits until every escrow is closed, or
ships under new seeds. Revisions 0.5.1 to 0.5.3 changed no layout.

**Mainnet handover.** `ops/mainnet.sh handover` accepts one target, the NFI Programs multisig vault pinned in the script,
and `ops/mainnet.sh confirm` (read-only) must pass before the deployer key is retired: the vault holds the upgrade
authority and the config authority, and no handover is pending.

## What a refund cannot do

- **A frozen asset cannot burn.** Core refuses BurnV1 while a FreezeDelegate says frozen (a marketplace listing or a
  staking lock the holder chose). The refund fails cleanly and works after the thaw (tested); the refund UI says
  "unlist or unstake first".
- **An asset burned outside refund** pays the receipt's minter when anyone cranks the refund, not whoever last held it.
  The same holds for whatever sits at its address afterwards under another program.
- **A different asset at a burned asset's address** (created by whoever kept the asset's keypair) earns no refund while
  the escrow holds the collection: a live asset must be in the launch's collection.
- **After the 30-day grace** the creator holds the collection again (above).

## Layout

```
programs/nfi_launch_escrow/src
  lib.rs            instruction list
  state.rs          Config, LaunchEscrow, Group, MintReceipt, MintCounter, Vault, constants
  mplcore.rs        MPL Core and Core Candy Machine layouts read by hand, the hand-built CPIs, the reveal Merkle check
  instructions/     config, init, pay (pay_and_mint, close_counter), admin (cancel, set_paused),
                    refund, release (+ release_fee, return_collection), reveal, close
tests/escrow.ts     lifecycle, the round-4 findings, and the TypeScript reveal tree (revealLeaf, revealTree)
tests/fixtures      mpl_core.so, mpl_core_candy_machine.so, mpl_core_candy_guard.so (mainnet dumps)
```
