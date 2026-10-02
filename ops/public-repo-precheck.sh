#!/usr/bin/env bash
# Golden rule: nothing sensitive ever reaches a public repository. Runs as the pre-push hook (ops/install-hooks.sh) and
# refuses the push if any commit being pushed adds key material, a credential, an endpoint with a key, or our hosts.
# Patterns, not judgement: when in doubt, it does not go in. Run by hand: bash ops/public-repo-precheck.sh [range]
set -euo pipefail
cd "$(dirname "$0")/.."
RANGE="${1:-}"
PATTERNS='api[-_]?key=[A-Za-z0-9_-]{8,}|BEGIN (RSA|OPENSSH|EC|PGP) PRIVATE|\[\s*[0-9]{1,3}(\s*,\s*[0-9]{1,3}){40,}\s*\]|LAUNCH_PERMIT_SEED=|DISCORD_(TOKEN|SECRET)|DB_PASS|CF_(TOKEN|API)|xox[baprs]-|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|master_gumgyr|159\.65\.170|cloudways|nfinn\.io/\.env|/home/master/nfi-verify/\.env|helius-rpc\.com/\?api-key=[a-z0-9]'
fail=0
scan() { # $1 = label, stdin = text
  local hits; hits=$(grep -nEi "$PATTERNS" | grep -vE "public-repo-precheck|PATTERNS=|never prints a secret|NEVER cat" || true)
  if [ -n "$hits" ]; then echo "REFUSED ($1): sensitive pattern"; echo "$hits" | head -10; fail=1; fi
}
if [ -n "$RANGE" ]; then git diff "$RANGE" | grep '^+' | scan "diff $RANGE"; git diff --name-only "$RANGE" | grep -Ei '(^|/)(\.env|.*\.pem|.*-keypair\.json|id\.json|keys/.*)$' | sed 's/^/REFUSED (file name): /' | grep . && fail=1 || true
else git ls-files -z | xargs -0 cat 2>/dev/null | scan "working tree"; git ls-files | grep -Ei '(^|/)(\.env|.*\.pem|.*-keypair\.json|id\.json|keys/.*)$' | sed 's/^/REFUSED (file name): /' | grep . && fail=1 || true; fi
[ "$fail" = 0 ] && echo "precheck clean" || exit 1
