#!/usr/bin/env bash
# Deploy the PRODUCTION build to devnet and create its config, from WSL:
#   bash ops/devnet.sh deploy                                   # solana program deploy (upgrade authority = ~/.config/solana/id.json)
#   bash ops/devnet.sh upgrade                                  # in-place upgrade (same program id)
#   bash ops/devnet.sh init-config <nfi> <canceller> <treasury> # the config (seed "config2" since round 4)
#   bash ops/devnet.sh show                                     # program + config as deployed
#   bash ops/devnet.sh hash                                     # sha256 of the production build vs the one on chain
# Only target/prod (written by 'wsl-build.sh build-release', hash recorded) is ever deployed (round 4, L-041).
set -euo pipefail
DST="$HOME/nfi-launch-escrow"
RPC="https://api.devnet.solana.com"
BIN="/home/theon/.local/share/solana/install/active_release/bin"
PROGRAM="3qRS59TJmgaNUzKjKsUe3XGggodSXA9GHU9Q5u2ffE1n"
SO="target/prod/nfi_launch_escrow.so"
cd "$DST"
prod_check() {
  [ -f "$SO" ] || { echo "no $SO: run 'wsl-build.sh build-release' first"; exit 1; }
  (cd target/prod && sha256sum -c nfi_launch_escrow.so.sha256) || { echo "target/prod binary does not match its recorded hash"; exit 1; }
  grep -q '"value": "3600"' target/prod/nfi_launch_escrow.json || { echo "target/prod IDL says MIN_WINDOW_SECS != 3600 (never deploy a test build)"; exit 1; }
}
case "${1:-}" in
  deploy)
    prod_check
    $BIN/solana program deploy --url "$RPC" --program-id target/deploy/nfi_launch_escrow-keypair.json "$SO"
    $BIN/solana program show --url "$RPC" "$PROGRAM";;
  upgrade)
    # If the binary grew past the account, `solana program extend <id> <bytes>` first.
    prod_check
    stat -c "%s bytes" "$SO"
    $BIN/solana program deploy --url "$RPC" --program-id target/deploy/nfi_launch_escrow-keypair.json "$SO"
    $BIN/solana program show --url "$RPC" "$PROGRAM";;
  init-config)
    [ -n "${2:-}" ] && [ -n "${3:-}" ] && [ -n "${4:-}" ] || { echo "usage: devnet.sh init-config <nfi_authority> <canceller> <treasury>"; exit 2; }
    RPC="$RPC" node ops/init-config.mjs "$2" "$3" "$4";;
  show)
    $BIN/solana program show --url "$RPC" "$PROGRAM"
    RPC="$RPC" node ops/init-config.mjs --show;;
  hash)
    prod_check
    $BIN/solana program dump --url "$RPC" "$PROGRAM" /tmp/onchain-dev.so >/dev/null
    local_len=$(stat -c %s "$SO")
    head -c "$local_len" /tmp/onchain-dev.so > /tmp/onchain-dev.trim.so
    echo "built:    $(sha256sum "$SO" | cut -d' ' -f1)"
    echo "on chain: $(sha256sum /tmp/onchain-dev.trim.so | cut -d' ' -f1)";;
  *) echo "usage: devnet.sh deploy | upgrade | init-config <nfi> <canceller> <treasury> | show | hash"; exit 2;;
esac
