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
cd "$DST"
case "${1:-}" in
  deploy)
    grep -q '"value": "3600"' target/idl/nfi_launch_escrow.json || { echo "target/idl says MIN_WINDOW_SECS != 3600: run 'wsl-build.sh build-release' first (never deploy a test build)"; exit 1; }
    # --max-len caps the program account at ~450 KB (the binary is ~399 KB): about 3.1 SOL of rent instead of the default double allocation. Mainnet uses the default so upgrades have room.
    solana program deploy --url "$RPC" --max-len 450000 --program-id target/deploy/nfi_launch_escrow-keypair.json target/deploy/nfi_launch_escrow.so
    solana program show --url "$RPC" 3qRS59TJmgaNUzKjKsUe3XGggodSXA9GHU9Q5u2ffE1n;;
  init-config)
    [ -n "${2:-}" ] && [ -n "${3:-}" ] || { echo "usage: devnet.sh init-config <nfi_authority> <treasury>"; exit 2; }
    RPC="$RPC" node ops/init-config.mjs "$2" "$3";;
  show)
    solana program show --url "$RPC" 3qRS59TJmgaNUzKjKsUe3XGggodSXA9GHU9Q5u2ffE1n
    RPC="$RPC" node ops/init-config.mjs --show;;
  *) echo "usage: devnet.sh deploy | init-config <nfi_authority> <treasury> | show"; exit 2;;
esac
