#!/usr/bin/env bash
# The mainnet runbook, from WSL. Every step prints what it did; nothing here ever prints a secret key.
#   bash ops/mainnet.sh keygen                                  # the temporary deployer keypair (outside the synced tree); prints its address to fund
#   bash ops/mainnet.sh deploy                                  # the PRODUCTION build (target/prod, hash checked) to mainnet, deployer = upgrade authority
#   bash ops/mainnet.sh init-config <nfi> <canceller> <treasury> # the config, by the deployer while it still is the upgrade authority
#   bash ops/mainnet.sh handover <vault> <vault again>          # upgrade authority -> the multisig vault; config authority proposed to it
#   bash ops/mainnet.sh show                                    # program, authorities, config, deployer balance
#   bash ops/mainnet.sh hash                                    # sha256 of the production build vs the one on chain
set -euo pipefail
BIN="/home/theon/.local/share/solana/install/active_release/bin"
DST="/home/theon/nfi-launch-escrow"
KEY="/home/theon/nfi-keys/mainnet-deployer.json"
RPC="${MAINNET_RPC:-https://api.mainnet-beta.solana.com}"
PROGRAM="3qRS59TJmgaNUzKjKsUe3XGggodSXA9GHU9Q5u2ffE1n"
SQUADS_V4="SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf"
SO="target/prod/nfi_launch_escrow.so"
cd "$DST"
# Only the binary build-release recorded, with its recorded hash and a production IDL (round 4, L-041).
prod_check() {
  [ -f "$SO" ] || { echo "no $SO: run 'wsl-build.sh build-release' first"; exit 1; }
  (cd target/prod && sha256sum -c nfi_launch_escrow.so.sha256) || { echo "target/prod binary does not match its recorded hash"; exit 1; }
  grep -q '"value": "3600"' target/prod/nfi_launch_escrow.json || { echo "target/prod IDL says MIN_WINDOW_SECS != 3600 (never deploy a test build)"; exit 1; }
}
case "${1:-}" in
  keygen)
    mkdir -p "$(dirname "$KEY")"
    [ -f "$KEY" ] || "$BIN/solana-keygen" new --no-bip39-passphrase -s -o "$KEY" >/dev/null
    chmod 600 "$KEY"
    echo "deployer: $("$BIN/solana-keygen" pubkey "$KEY")"
    "$BIN/solana" balance -u "$RPC" "$("$BIN/solana-keygen" pubkey "$KEY")";;
  deploy)
    prod_check
    "$BIN/solana" program deploy --url "$RPC" --keypair "$KEY" --upgrade-authority "$KEY" --program-id target/deploy/nfi_launch_escrow-keypair.json "$SO"
    "$BIN/solana" program show --url "$RPC" "$PROGRAM";;
  init-config)
    [ -n "${2:-}" ] && [ -n "${3:-}" ] && [ -n "${4:-}" ] || { echo "usage: mainnet.sh init-config <nfi_authority> <canceller> <treasury>"; exit 2; }
    RPC="$RPC" ANCHOR_WALLET="$KEY" node ops/init-config.mjs "$2" "$3" "$4";;
  handover)
    # A Squads vault cannot sign the CLI's transaction, so the signer check is skipped; instead the address is typed twice
    # and must be a system-owned account (the VAULT), never the multisig account itself (Squads-owned: it cannot sign, the
    # authority would be lost for good). Round 4, L-009.
    [ -n "${2:-}" ] && [ "${2:-}" = "${3:-}" ] || { echo "usage: mainnet.sh handover <multisig_vault> <multisig_vault again>"; exit 2; }
    owner=$("$BIN/solana" account --url "$RPC" --output json "$2" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).account.owner)}catch{console.log("none")}})')
    [ "$owner" = "11111111111111111111111111111111" ] || { echo "$2 is owned by $owner, not the System Program: not a Squads vault (the multisig account is owned by $SQUADS_V4)"; exit 1; }
    "$BIN/solana" program set-upgrade-authority --url "$RPC" --keypair "$KEY" --upgrade-authority "$KEY" --new-upgrade-authority "$2" --skip-new-upgrade-authority-signer-check "$PROGRAM"
    RPC="$RPC" ANCHOR_WALLET="$KEY" node ops/init-config.mjs --propose "$2"
    "$BIN/solana" program show --url "$RPC" "$PROGRAM"
    echo "now: in Squads, the vault executes accept_authority (ops/init-config.mjs --accept-ix prints the instruction for the proposal)";;
  show)
    "$BIN/solana" program show --url "$RPC" "$PROGRAM" || true
    RPC="$RPC" node ops/init-config.mjs --show
    [ -f "$KEY" ] && echo "deployer $("$BIN/solana-keygen" pubkey "$KEY"): $("$BIN/solana" balance -u "$RPC" "$("$BIN/solana-keygen" pubkey "$KEY")")";;
  hash)
    prod_check
    "$BIN/solana" program dump --url "$RPC" "$PROGRAM" /tmp/onchain.so >/dev/null
    local_len=$(stat -c %s "$SO")
    head -c "$local_len" /tmp/onchain.so > /tmp/onchain.trim.so
    echo "built:    $(sha256sum "$SO" | cut -d' ' -f1)"
    echo "on chain: $(sha256sum /tmp/onchain.trim.so | cut -d' ' -f1)  (first $local_len bytes; the account is zero padded)";;
  *) echo "usage: mainnet.sh keygen | deploy | init-config <nfi> <canceller> <treasury> | handover <vault> <vault> | show | hash"; exit 2;;
esac
