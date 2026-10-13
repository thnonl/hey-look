#!/usr/bin/env bash
# Checks the asset names of a release before it is published.
# Usage: check-release-assets.sh <version> < names.txt   (one asset name per line)
# Exit 0 when the set is complete and every name is clean, 1 otherwise (one line per problem).
set -uo pipefail
v="${1:?usage: check-release-assets.sh <version> < names}"
vre="${v//./\\.}"
name_re="^HeyLook_${vre}_(windows|darwin|linux)_[a-z0-9_]+(-setup\.exe|\.msi|\.dmg|\.AppImage|\.deb|\.rpm|\.app\.tar\.gz)\$"

names=$(tr -d '\r' | sed '/^[[:space:]]*$/d')
bad=0
problem() { echo "problem: $*"; bad=1; }

if [ -z "$names" ]; then
  problem "the release has no assets"
fi

while IFS= read -r n; do
  [ -z "$n" ] && continue
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

for ext in -setup.exe .msi .dmg .AppImage .deb .rpm; do
  c=$(count "$ext")
  [ "$c" = 1 ] || problem "expected exactly one '*$ext', found $c"
done
c=$(count .app.tar.gz)
[ "$c" -le 1 ] || problem "expected at most one '*.app.tar.gz', found $c"

[ "$bad" = 0 ] && echo "asset check passed ($(grep -c . <<<"$names") assets)"
exit "$bad"
