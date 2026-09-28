# nfi_launch_escrow

The on-chain half of the NFI Launchpad's refund model (launch.nfinn.io). Mint payments are held per launch until the
window ends; if the launch is cancelled first, every minter takes their whole payment back by burning the asset. The
design, the account layout, the instruction rules and the attack list live in the NFI Launchpad blueprint, section
"Phase 2b design". Modelled on nfi_raffle.

Program id: `3qRS59TJmgaNUzKjKsUe3XGggodSXA9GHU9Q5u2ffE1n`. The deploy keypair is **not** in this repository.

## Status

Revision 0.1 (27 September 2026): the program and its attack-first test suite (13 cases) pass on a local validator.
Not yet: the adversarial review rounds, devnet dual running beside the freeze guard, service integration (the permit
builder places `pay` before `mintV1`; the studio's deploy plan adds `init`; approval compares the escrow's fields),
mainnet. Unaudited.

## Money flow

```
init (creator + NFI sign) ──pay×N (in each mint tx)──▶ Open ──release (anyone, after window_end)──▶ Released ──close_receipt×N, close_escrow
                                                        │
                                                        └──cancel (NFI or creator)──▶ Cancelled ──refund×N (burns the asset; forever)──▶ close_escrow once every receipt is refunded
```

Decisions (owner, 27 September 2026): refunds never expire; NFI's fee is refunded on a cancel; a refund burns the
asset in the same instruction.

## Build and test

Inside WSL (the SBF toolchain does not like `/mnt/c`):

```
bash ops/wsl-build.sh sync && bash ops/wsl-build.sh pin && bash ops/wsl-build.sh build && bash ops/wsl-build.sh test
```

`--features test` shortens the minimum window to five seconds so the whole life runs in one test. Never on for a deploy.

## Layout

```
programs/nfi_launch_escrow/src
  lib.rs            instruction list
  state.rs          LaunchEscrow, MintReceipt, Vault, constants
  instructions/     init, pay, admin (cancel, set_paused), refund (hand-built MPL Core BurnV1), release, close
tests/escrow.ts     lifecycle and attacks
tests/fixtures      mpl_core.so (mainnet dump)
```
