#!/usr/bin/env bash
# Build and test nfi_launch_escrow inside WSL from a copy of the repo in the Linux filesystem (the SBF toolchain is
# unhappy on /mnt/c). Same shape as nfi-raffle-program/ops/wsl-build.sh.
#   bash ops/wsl-build.sh sync     # copy the Windows checkout to ~/nfi-launch-escrow
#   bash ops/wsl-build.sh keypair  # program keypair (once); prints the id to put in Anchor.toml and lib.rs
#   bash ops/wsl-build.sh pin      # a Cargo.lock the SBF toolchain can parse
#   bash ops/wsl-build.sh build    # anchor build --features test
#   bash ops/wsl-build.sh test     # anchor test --features test (local validator), full log in ~/nfi-launch-escrow-test.log
#   bash ops/wsl-build.sh lock     # Cargo.lock back to the Windows checkout
set -uo pipefail
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
SRC=/mnt/c/Users/TheOn/nfi-launch-escrow
DST=$HOME/nfi-launch-escrow
cmd="${1:-build}"
case "$cmd" in
  sync)
    mkdir -p "$DST"
    rsync -a --delete --exclude node_modules --exclude target --exclude .git --exclude Cargo.lock "$SRC/" "$DST/" 2>/dev/null || cp -r "$SRC/." "$DST/"
    [ -f "$SRC/Cargo.lock" ] && cp "$SRC/Cargo.lock" "$DST/Cargo.lock"
    mkdir -p "$DST/target/deploy" && cp "$SRC/target/deploy/nfi_launch_escrow-keypair.json" "$DST/target/deploy/" 2>/dev/null
    cd "$DST" && yarn install --silent >/dev/null 2>&1
    echo "synced";;
  keypair)
    mkdir -p "$SRC/target/deploy" "$DST/target/deploy"
    f="$SRC/target/deploy/nfi_launch_escrow-keypair.json"
    [ -f "$f" ] || solana-keygen new --no-bip39-passphrase -s -o "$f" >/dev/null
    cp "$f" "$DST/target/deploy/"
    echo "program id: $(solana-keygen pubkey "$f")";;
  pin)
    cd "$DST"
    [ -f Cargo.lock ] || cargo generate-lockfile -q
    for pair in crypto-common:0.1.6 hashbrown:0.15.5 block-buffer:0.10.4 digest:0.10.7 indexmap:2.9.0 bytemuck:1.23.0; do
      crate=${pair%%:*}; ver=${pair##*:}
      cargo update -q "$crate" --precise "$ver" 2>/dev/null && echo "pinned $crate $ver"
    done
    echo "pin done";;
  build)
    cd "$DST" && anchor build -- --features test 2>&1 | grep -E -e '^error' -e '^warning' -e 'failed to parse' -e 'Finished' -e 'Compiling nfi_launch' -e '\-\-> ' | head -40
    ls -la target/deploy/*.so target/idl/*.json 2>/dev/null;;
  test)
    cd "$DST"
    pkill -f "solana-test-validator" 2>/dev/null; sleep 1
    rm -rf .anchor/test-ledger
    anchor test --skip-build -- --features test > "$HOME/nfi-launch-escrow-test.log" 2>&1; echo "EXIT=$?" >> "$HOME/nfi-launch-escrow-test.log"
    grep -v -e "^   Compiling" -e Downloaded "$HOME/nfi-launch-escrow-test.log" | grep -E -e "passing|failing|pending|✔|✓|[0-9]+\) |Error|error|EXIT=|AssertionError|expected" | tail -80;;
  testlog)
    tail -120 "$HOME/nfi-launch-escrow-test.log";;
  lint)
    cd "$DST" && cargo clippy --all-targets -- -D warnings 2>&1 | grep -e '^error' -e '^warning' -e '\-\-> ' | grep -v 'could not compile' | head -30;;
  lock)
    cp "$DST/Cargo.lock" "$SRC/Cargo.lock" && echo "Cargo.lock copied to the Windows checkout";;
  check)
    cd "$DST"
    echo "--- keypair pubkey:"; solana-keygen pubkey target/deploy/nfi_launch_escrow-keypair.json
    echo "--- declare_id:"; grep -o 'declare_id!("[^"]*")' programs/nfi_launch_escrow/src/lib.rs
    echo "--- .so:"; ls -la target/deploy/nfi_launch_escrow.so | awk '{print $5" bytes"}'
    echo "--- instructions in the IDL:"; node -e 'const i=require("./target/idl/nfi_launch_escrow.json"); console.log(i.instructions.map(x=>x.name).join(" "))';;
  *) echo "unknown command $cmd"; exit 2;;
esac
