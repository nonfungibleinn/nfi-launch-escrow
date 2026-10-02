#!/usr/bin/env bash
# Deploy the PRODUCTION build to devnet and create its config, from WSL:
#   bash ops/devnet.sh deploy            # solana program deploy (upgrade authority = ~/.config/solana/id.json)
#   bash ops/devnet.sh init-config <nfi_authority_pubkey> <treasury_pubkey>
#   bash ops/devnet.sh show              # program + config as deployed
# Needs ~3 devnet SOL on the wallet for the deploy (program rent). The config must be created right after the deploy,
# before any change to the upgrade authority (README). The same steps, with a multisig wallet, are the mainnet runbook.
set -euo pipefail
DST="$HOME/nfi-launch-escrow"
RPC="https://api.devnet.solana.com"
BIN="/home/theon/.local/share/solana/install/active_release/bin"
cd "$DST"
case "${1:-}" in
  deploy)
    grep -q '"value": "3600"' target/idl/nfi_launch_escrow.json || { echo "target/idl says MIN_WINDOW_SECS != 3600: run 'wsl-build.sh build-release' first (never deploy a test build)"; exit 1; }
    # --max-len caps the program account at the binary size (398,864 bytes): about 2.03 SOL of rent (`solana program extend` adds room later) instead of the default double allocation. Mainnet uses the default so upgrades have room.
    $BIN/solana program deploy --url "$RPC" --max-len 398864 --program-id target/deploy/nfi_launch_escrow-keypair.json target/deploy/nfi_launch_escrow.so
    $BIN/solana program show --url "$RPC" 3qRS59TJmgaNUzKjKsUe3XGggodSXA9GHU9Q5u2ffE1n;;
  upgrade)
    # An in-place upgrade (same program id). If the binary grew past the account, `solana program extend <id> <bytes>` first.
    grep -q '"value": "3600"' target/idl/nfi_launch_escrow.json || { echo "not a production build"; exit 1; }
    sha256sum target/deploy/nfi_launch_escrow.so; stat -c "%s bytes" target/deploy/nfi_launch_escrow.so
    $BIN/solana program deploy --url "$RPC" --program-id target/deploy/nfi_launch_escrow-keypair.json target/deploy/nfi_launch_escrow.so
    $BIN/solana program show --url "$RPC" 3qRS59TJmgaNUzKjKsUe3XGggodSXA9GHU9Q5u2ffE1n;;
  init-config)
    [ -n "${2:-}" ] && [ -n "${3:-}" ] || { echo "usage: devnet.sh init-config <nfi_authority> <treasury>"; exit 2; }
    RPC="$RPC" node ops/init-config.mjs "$2" "$3";;
  show)
    $BIN/solana program show --url "$RPC" 3qRS59TJmgaNUzKjKsUe3XGggodSXA9GHU9Q5u2ffE1n
    RPC="$RPC" node ops/init-config.mjs --show;;
  *) echo "usage: devnet.sh deploy | init-config <nfi_authority> <treasury> | show"; exit 2;;
esac
