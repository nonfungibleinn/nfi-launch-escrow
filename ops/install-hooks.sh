#!/usr/bin/env bash
# Installs the pre-push guard (golden rule: nothing sensitive in a public repository). Run once per clone.
set -euo pipefail
cd "$(dirname "$0")/.."
cat > .git/hooks/pre-push <<'HOOK'
#!/usr/bin/env bash
# Every ref being pushed: scan the commits not yet on the remote.
z=0000000000000000000000000000000000000000
while read -r local_ref local_sha remote_ref remote_sha; do
  [ "$local_sha" = "$z" ] && continue
  if [ "$remote_sha" = "$z" ]; then range="$(git rev-list --max-parents=0 "$local_sha" | tail -1)^..$local_sha" 2>/dev/null || range="$local_sha"; else range="$remote_sha..$local_sha"; fi
  bash ops/public-repo-precheck.sh "$range" || { echo "push refused by ops/public-repo-precheck.sh"; exit 1; }
done
exit 0
HOOK
chmod +x .git/hooks/pre-push ops/public-repo-precheck.sh
echo "pre-push hook installed"
