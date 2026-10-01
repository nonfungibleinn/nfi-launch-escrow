#!/usr/bin/env bash
# The mainnet runbook, from WSL. Every step prints what it did; nothing here ever prints a secret key.
#   bash ops/mainnet.sh keygen                       # the temporary deployer keypair (outside the synced tree); prints its address to fund
#   bash ops/mainnet.sh deploy                       # PRODUCTION build to mainnet, default size (2x, room for one upgrade), deployer = upgrade authority
#   bash ops/mainnet.sh init-config <nfi> <treasury> # the config, by the deployer while it still is the upgrade authority
#   bash ops/mainnet.sh handover <vault>             # upgrade authority -> the multisig vault; config authority proposed to it (the vault accepts in Squads)
#   bash ops/mainnet.sh show                         # program, authorities, config, deployer balance
#   bash ops/mainnet.sh hash                         # sha256 of the built binary vs the one on chain
set -euo pipefail
BIN="/home/theon/.local/share/solana/install/active_release/bin"
DST="/home/theon/nfi-launch-escrow"
KEY="/home/theon/nfi-keys/mainnet-deployer.json"
RPC="${MAINNET_RPC:-https://api.mainnet-beta.solana.com}"
PROGRAM="3qRS59TJmgaNUzKjKsUe3XGggodSXA9GHU9Q5u2ffE1n"
cd "$DST"
case "${1:-}" in
  keygen)
    mkdir -p "$(dirname "$KEY")"
    [ -f "$KEY" ] || "$BIN/solana-keygen" new --no-bip39-passphrase -s -o "$KEY" >/dev/null
    chmod 600 "$KEY"
    echo "deployer: $("$BIN/solana-keygen" pubkey "$KEY")"
    "$BIN/solana" balance -u "$RPC" "$("$BIN/solana-keygen" pubkey "$KEY")";;
  deploy)
    grep -q '"value": "3600"' target/idl/nfi_launch_escrow.json || { echo "target/idl says MIN_WINDOW_SECS != 3600: run 'wsl-build.sh build-release' first (never deploy a test build)"; exit 1; }
    sha256sum target/deploy/nfi_launch_escrow.so
    "$BIN/solana" program deploy --url "$RPC" --keypair "$KEY" --upgrade-authority "$KEY" --program-id target/deploy/nfi_launch_escrow-keypair.json target/deploy/nfi_launch_escrow.so
    "$BIN/solana" program show --url "$RPC" "$PROGRAM";;
  init-config)
    [ -n "${2:-}" ] && [ -n "${3:-}" ] || { echo "usage: mainnet.sh init-config <nfi_authority> <treasury>"; exit 2; }
    RPC="$RPC" ANCHOR_WALLET="$KEY" node ops/init-config.mjs "$2" "$3";;
  handover)
    [ -n "${2:-}" ] || { echo "usage: mainnet.sh handover <multisig_vault>"; exit 2; }
    "$BIN/solana" program set-upgrade-authority --url "$RPC" --keypair "$KEY" --upgrade-authority "$KEY" --new-upgrade-authority "$2" --skip-new-upgrade-authority-signer-check "$PROGRAM"
    RPC="$RPC" ANCHOR_WALLET="$KEY" node ops/init-config.mjs --propose "$2"
    "$BIN/solana" program show --url "$RPC" "$PROGRAM"
    echo "now: in Squads, the vault executes accept_authority (ops/init-config.mjs --accept-ix prints the instruction for the proposal)";;
  show)
    "$BIN/solana" program show --url "$RPC" "$PROGRAM" || true
    RPC="$RPC" node ops/init-config.mjs --show
    [ -f "$KEY" ] && echo "deployer $("$BIN/solana-keygen" pubkey "$KEY"): $("$BIN/solana" balance -u "$RPC" "$("$BIN/solana-keygen" pubkey "$KEY")")";;
  hash)
    "$BIN/solana" program dump --url "$RPC" "$PROGRAM" /tmp/onchain.so >/dev/null
    local_len=$(stat -c %s target/deploy/nfi_launch_escrow.so)
    head -c "$local_len" /tmp/onchain.so > /tmp/onchain.trim.so
    echo "built:    $(sha256sum target/deploy/nfi_launch_escrow.so | cut -d' ' -f1)"
    echo "on chain: $(sha256sum /tmp/onchain.trim.so | cut -d' ' -f1)  (first $local_len bytes; the account is zero padded)";;
  *) echo "usage: mainnet.sh keygen | deploy | init-config <nfi> <treasury> | handover <vault> | show | hash"; exit 2;;
esac
