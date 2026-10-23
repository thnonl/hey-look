#!/usr/bin/env bash
# Runs the node tests of one shard of .github/node-tests.txt (the CI list of scripts/test-*.mjs and the other node checks).
#   bash .github/scripts/run-node-tests.sh <shard> [list-file]
# Each line of the list is "<shard> | <command>"; "#" lines and empty lines are comments. A shard is run line by line from the repo root.
# Unlike a plain `run:` block it does not stop at the first failure: every command of the shard runs, then the failures are listed, so one
# CI run shows ALL broken tests. The output of each command is a collapsible group named after it, a failed one is also repeated (last
# lines) outside the group as an ::error::. The seconds of each command go to the job summary (slowest first) to balance the shards.
# Every command has a time limit, so one hung test (a browser that never answers) cannot hold the whole shard until the job's own limit: after the
# limit the command and everything it started (the whole process tree, a headless browser included) are killed and it is reported as
# "TIMEOUT: <command>", a failure like any other. The limit is in seconds: NODE_TEST_TIMEOUT overrides it for every shard, else the shard's own
# (static 300, ui-* 900; the slowest legitimate test of the recorded runs took 290 s, the whole static shard 61 s). NODE_TEST_KILL_GRACE (default 5)
# is the time between the TERM and the KILL.
# Exit 0 only when every command of the shard passed and the shard is not empty.
set -uo pipefail

shard="${1:?usage: run-node-tests.sh <shard> [list-file]}"
list="${2:-.github/node-tests.txt}"
case "$shard" in static) default_limit=300 ;; *) default_limit=900 ;; esac
limit="${NODE_TEST_TIMEOUT:-$default_limit}"
grace="${NODE_TEST_KILL_GRACE:-5}"
case "$limit$grace" in *[!0-9]*) echo "::error::NODE_TEST_TIMEOUT and NODE_TEST_KILL_GRACE must be whole seconds"; exit 1 ;; esac

# The pid and all its descendants (deepest first), found before anything is killed (a killed parent hands its children to init).
tree_pids() {
  local c
  # (pgrep where there is one; `ps -ef` has UID PID PPID in its first columns on Linux, macOS and Git Bash alike)
  for c in $( (pgrep -P "$1" 2>/dev/null || ps -ef 2>/dev/null | awk -v p="$1" '$3 == p { print $2 }') ); do tree_pids "$c"; done
  echo "$1"
}

# Runs "bash -c <cmd>" with its output in <log>; returns its exit code, or 124 when the limit was hit (the tree is killed then).
run_limited() {
  local cmd="$1" log="$2" pid watcher flag rc pids p
  flag=$(mktemp)
  rm -f "$flag"
  bash -c "$cmd" > "$log" 2>&1 &
  pid=$!
  (
    sleep "$limit"
    : > "$flag"
    pids=$(tree_pids "$pid")
    kill -TERM $pids 2>/dev/null
    sleep "$grace"
    for p in $pids; do kill -KILL "$p" 2>/dev/null; done
  ) > /dev/null 2>&1 &
  watcher=$!
  wait "$pid"
  rc=$?
  if [ -e "$flag" ]; then
    # the limit was hit: let the watcher finish its kill, then make sure nothing of the command is left
    wait "$watcher" 2>/dev/null
    rc=124
  else
    kill $(tree_pids "$watcher") 2>/dev/null
    wait "$watcher" 2>/dev/null
  fi
  rm -f "$flag"
  return "$rc"
}

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
  run_limited "$cmd" "$log"
  rc=$?
  cat "$log"
  echo "::endgroup::"
  dt=$((SECONDS - t0))
  result=FAILED
  [ "$rc" = 0 ] && result=ok
  [ "$rc" = 124 ] && result=TIMEOUT
  printf '%s\t%s\t%s\n' "$dt" "$result" "$cmd" >> "$times"
  if [ "$rc" = 124 ]; then
    failed+=("TIMEOUT: $cmd")
    echo "::error::TIMEOUT: $cmd (killed after ${dt}s, limit ${limit}s)"
    tail -n 25 "$log"
  elif [ "$rc" != 0 ]; then
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
