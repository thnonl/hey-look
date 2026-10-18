#!/usr/bin/env bash
# Runs the node tests of one shard of .github/node-tests.txt (the CI list of scripts/test-*.mjs and the other node checks).
#   bash .github/scripts/run-node-tests.sh <shard> [list-file]
# Each line of the list is "<shard> | <command>"; "#" lines and empty lines are comments. A shard is run line by line from the repo root.
# Unlike a plain `run:` block it does not stop at the first failure: every command of the shard runs, then the failures are listed, so one
# CI run shows ALL broken tests. The output of each command is a collapsible group named after it, a failed one is also repeated (last
# lines) outside the group as an ::error::. The seconds of each command go to the job summary (slowest first) to balance the shards.
# Exit 0 only when every command of the shard passed and the shard is not empty.
set -uo pipefail

shard="${1:?usage: run-node-tests.sh <shard> [list-file]}"
list="${2:-.github/node-tests.txt}"

times=$(mktemp)
failed=()
count=0
t_all=$SECONDS
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  case "$line" in '' | '#'*) continue ;; esac
  [ "${line%% | *}" = "$shard" ] || continue
  cmd="${line#* | }"
  count=$((count + 1))
  log=$(mktemp)
  t0=$SECONDS
  echo "::group::$cmd"
  bash -c "$cmd" > "$log" 2>&1
  rc=$?
  cat "$log"
  echo "::endgroup::"
  dt=$((SECONDS - t0))
  printf '%s\t%s\t%s\n' "$dt" "$([ "$rc" = 0 ] && echo ok || echo FAILED)" "$cmd" >> "$times"
  if [ "$rc" != 0 ]; then
    failed+=("$cmd")
    echo "::error::FAILED (exit $rc, ${dt}s): $cmd"
    tail -n 25 "$log"
  fi
  rm -f "$log"
done < "$list"

total=$((SECONDS - t_all))
{
  echo "### Node tests, shard \`$shard\`: $count commands, ${total}s, ${#failed[@]} failed"
  echo
  echo "| seconds | result | command |"
  echo "|---:|---|---|"
  sort -t "$(printf '\t')" -k1,1nr "$times" | head -n 15 | while IFS=$'\t' read -r s r c; do echo "| $s | $r | \`$c\` |"; done
  [ "$count" -gt 15 ] && echo "| | | (the 15 slowest of $count are shown) |"
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
echo "shard $shard: $count commands in ${total}s, ${#failed[@]} failed"
sort -t "$(printf '\t')" -k1,1nr "$times" | head -n 8 | while IFS=$'\t' read -r s r c; do echo "  ${s}s  $c"; done
rm -f "$times"

if [ "$count" = 0 ]; then echo "::error::shard '$shard' has no commands in $list"; exit 1; fi
if [ "${#failed[@]}" != 0 ]; then
  echo "::error::${#failed[@]} failed in shard $shard"
  printf '  FAILED: %s\n' "${failed[@]}"
  exit 1
fi
