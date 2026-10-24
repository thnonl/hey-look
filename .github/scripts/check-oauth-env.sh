#!/usr/bin/env bash
# Tag runs only (release.yml, step "OAuth client ids present"): the OAuth client ids and secrets are embedded into the app at build time
# (src-tauri/build.rs, src-tauri/src/lib.rs), so a release built without one would ship an app whose sign-in does not work, and the build
# would still be green. Names only: a value is never printed.
#   Required: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, MICROSOFT_CLIENT_ID
#   Optional (notice when empty): MICROSOFT_CLIENT_SECRET (the Microsoft sign-in is a public client)
# A value that is empty or only white space counts as missing. Exit 1 with one ::error:: line per missing required name.
#   bash .github/scripts/check-oauth-env.sh            reads the four variables from the environment
#   bash .github/scripts/check-oauth-env.sh --selftest runs the cases below (also in the shard static of the node tests)
set -uo pipefail

check() {
  local bad=0 n v
  for n in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET MICROSOFT_CLIENT_ID; do
    v="${!n-}"
    if [ -z "${v//[[:space:]]/}" ]; then
      echo "::error::$n is not set (add it to the environment 'release'): the release app would have no working sign-in"
      bad=1
    fi
  done
  v="${MICROSOFT_CLIENT_SECRET-}"
  if [ -z "${v//[[:space:]]/}" ]; then
    echo "::notice::MICROSOFT_CLIENT_SECRET is not set: public client (expected)"
  fi
  return $bad
}

selftest() {
  local fails=0 out rc
  run() { # run <expected rc> <description> -- VAR=value ...
    local want="$1" what="$2"; shift 3
    out="$(env -i PATH="$PATH" "$@" bash "${BASH_SOURCE[0]}" 2>&1)"; rc=$?
    if [ "$rc" != "$want" ]; then echo "FAIL $what: exit $rc, expected $want"; echo "$out"; fails=$((fails + 1)); return 1; fi
    LAST="$out"
  }
  local M1=marker-google-id-7f3a M2=marker-google-secret-91c4 M3=marker-ms-id-52de M4=marker-ms-secret-08b1
  run 0 "all four set" -- GOOGLE_CLIENT_ID=$M1 GOOGLE_CLIENT_SECRET=$M2 MICROSOFT_CLIENT_ID=$M3 MICROSOFT_CLIENT_SECRET=$M4 || true
  grep -q "MICROSOFT_CLIENT_SECRET is not set" <<<"$LAST" && { echo "FAIL the notice appears although the Microsoft secret is set"; fails=$((fails + 1)); }
  for m in $M1 $M2 $M3 $M4; do grep -q "$m" <<<"$LAST" && { echo "FAIL a value was printed ($m)"; fails=$((fails + 1)); }; done
  run 0 "Microsoft secret empty is a notice" -- GOOGLE_CLIENT_ID=$M1 GOOGLE_CLIENT_SECRET=$M2 MICROSOFT_CLIENT_ID=$M3 MICROSOFT_CLIENT_SECRET= || true
  grep -q "::notice::MICROSOFT_CLIENT_SECRET is not set: public client (expected)" <<<"$LAST" || { echo "FAIL the notice is missing"; fails=$((fails + 1)); }
  run 0 "Microsoft secret unset is a notice" -- GOOGLE_CLIENT_ID=$M1 GOOGLE_CLIENT_SECRET=$M2 MICROSOFT_CLIENT_ID=$M3 || true
  local n
  for n in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET MICROSOFT_CLIENT_ID; do
    local args=(GOOGLE_CLIENT_ID=$M1 GOOGLE_CLIENT_SECRET=$M2 MICROSOFT_CLIENT_ID=$M3 MICROSOFT_CLIENT_SECRET=$M4)
    local k
    for k in "${!args[@]}"; do case "${args[$k]}" in "$n="*) args[$k]="$n=" ;; esac; done
    run 1 "$n empty" -- "${args[@]}" || continue
    grep -q "::error::$n is not set" <<<"$LAST" || { echo "FAIL the error does not name $n"; fails=$((fails + 1)); }
    for m in $M1 $M2 $M3 $M4; do grep -q "$m" <<<"$LAST" && { echo "FAIL a value was printed ($m)"; fails=$((fails + 1)); }; done
    # a value of white space only counts as missing
    args=(GOOGLE_CLIENT_ID=$M1 GOOGLE_CLIENT_SECRET=$M2 MICROSOFT_CLIENT_ID=$M3 MICROSOFT_CLIENT_SECRET=$M4)
    for k in "${!args[@]}"; do case "${args[$k]}" in "$n="*) args[$k]="$n=  " ;; esac; done
    run 1 "$n only white space" -- "${args[@]}" || true
  done
  run 1 "nothing set" -- || true
  [ "$(grep -c '::error::' <<<"$LAST")" = 3 ] || { echo "FAIL nothing set: expected 3 error lines"; fails=$((fails + 1)); }
  if [ "$fails" -gt 0 ]; then echo "check-oauth-env selftest: $fails failure(s)"; return 1; fi
  echo "check-oauth-env selftest: ok"
}

if [ "${1-}" = "--selftest" ]; then selftest; exit $?; fi
check
