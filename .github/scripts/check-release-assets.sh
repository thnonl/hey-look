#!/usr/bin/env bash
# Checks the asset names of a release before it is published.
# Usage: check-release-assets.sh <version> [--pre] < names.txt   (one asset name per line)
#   --pre: the list before latest.json exists (it must not be there yet); without it latest.json is required exactly once.
# Expected: 7 installers, 6 signatures (none for the .dmg) and latest.json = 14 assets.
# Exit 0 when the set is complete and every name is clean, 1 otherwise (one line per problem).
set -uo pipefail
v="${1:?usage: check-release-assets.sh <version> [--pre] < names}"
pre=0
[ "${2:-}" = "--pre" ] && pre=1
vre="${v//./\\.}"
name_re="^HeyLook_${vre}_(windows|darwin|linux)_[a-z0-9_]+(-setup\.exe|\.msi|\.dmg|\.AppImage|\.deb|\.rpm|\.app\.tar\.gz)(\.sig)?\$"

names=$(tr -d '\r' | sed '/^[[:space:]]*$/d')
bad=0
problem() { echo "problem: $*"; bad=1; }

if [ -z "$names" ]; then
  problem "the release has no assets"
fi

while IFS= read -r n; do
  [ -z "$n" ] && continue
  [ "$n" = "latest.json" ] && continue
  if ! [[ "$n" =~ $name_re ]]; then
    problem "bad asset name: '$n'"
  fi
done <<<"$names"

count() { # how many names end with the literal suffix $1
  local c=0 n
  while IFS= read -r n; do
    [ -z "$n" ] && continue
    case "$n" in *"$1") c=$((c + 1)) ;; esac
  done <<<"$names"
  echo "$c"
}

has() { # is the exact name $1 in the list
  local n
  while IFS= read -r n; do
    [ "$n" = "$1" ] && return 0
  done <<<"$names"
  return 1
}

for ext in -setup.exe .msi .dmg .AppImage .deb .rpm .app.tar.gz; do
  c=$(count "$ext")
  [ "$c" = 1 ] || problem "expected exactly one '*$ext', found $c"
done

# every installer except the .dmg has exactly one signature
for ext in -setup.exe .msi .app.tar.gz .AppImage .deb .rpm; do
  c=$(count "$ext.sig")
  [ "$c" = 1 ] || problem "expected exactly one '*$ext.sig', found $c"
done
c=$(count ".dmg.sig")
[ "$c" = 0 ] || problem "a .dmg has no signature, found $c '*.dmg.sig'"

# a signature without its installer
while IFS= read -r n; do
  case "$n" in
    *.sig) has "${n%.sig}" || problem "signature without its installer: '$n'" ;;
  esac
done <<<"$names"

j=$(count "latest.json")
if [ "$pre" = 1 ]; then
  [ "$j" = 0 ] || problem "latest.json must not exist yet, found $j"
else
  [ "$j" = 1 ] || problem "expected exactly one latest.json, found $j"
fi

[ "$bad" = 0 ] && echo "asset check passed ($(grep -c . <<<"$names") assets)"
exit "$bad"
