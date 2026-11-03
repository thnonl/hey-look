#!/usr/bin/env bash
# Checks the asset names of a release before it is published.
# Usage: check-release-assets.sh <version> [--pre] [--store-exe] [--no-arm] < names.txt   (one asset name per line)
#   --pre: the list before latest.json exists (it must not be there yet); without it latest.json is required exactly once.
#   --store-exe: the repository variable STORE_EXE is on (WP14 option B): HeyLook_<version>_windows_x64_offline.exe must be there exactly once,
#   without a signature (the updater never uses it, latest.json does not name it). Without the flag that file is a bare executable and an error.
#   --no-arm: the ARM64 builds are not part of this release (repository variable ARM64_BUILD=false, the plan job output `arm`): the x64/universal set only.
# Expected: 12 installers (x64: setup.exe, msi, AppImage, deb, rpm; ARM64: the same five; macOS: dmg, app.tar.gz), 11 signatures (none for the .dmg) and
# latest.json = 24 assets (25 with --store-exe). With --no-arm: 7 installers, 6 signatures, latest.json = 14 (15 with --store-exe).
# Every installer is counted by its full suffix, which names the architecture (one per suffix), and a file that ends with none of them is refused.
# Exit 0 when the set is complete and every name is clean, 1 otherwise (one line per problem).
set -uo pipefail
v="${1:?usage: check-release-assets.sh <version> [--pre] < names}"
pre=0
store_exe=0
arm=1
shift
for flag in "$@"; do
  case "$flag" in
    --pre) pre=1 ;;
    --store-exe) store_exe=1 ;;
    --no-arm) arm=0 ;;
    *) echo "unknown option: $flag" >&2; exit 2 ;;
  esac
done
offline="HeyLook_${v}_windows_x64_offline.exe"
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
  # the only .exe that may be published is the installer (and, with --store-exe, the Store's offline installer, exactly named)
  case "$n" in
    *-setup.exe | *-setup.exe.sig) ;;
    "$offline") if [ "$store_exe" = 1 ]; then continue; fi; problem "the Store offline installer is not expected (STORE_EXE is off): '$n'"; continue ;;
    *.exe | *.exe.sig) problem "a bare executable is not allowed among the assets: '$n'"; continue ;;
  esac
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

# The installers by full suffix: the architecture is part of the name (what the bundler writes: Windows x64 / arm64, Linux amd64 / arm64 .deb,
# x86_64 / aarch64 .rpm and .AppImage). One of each; the ARM64 ones unless --no-arm.
x64_installers=(_windows_x64-setup.exe _windows_x64.msi _linux_amd64.AppImage _linux_amd64.deb _linux_x86_64.rpm)
arm_installers=(_windows_arm64-setup.exe _windows_arm64.msi _linux_aarch64.AppImage _linux_arm64.deb _linux_aarch64.rpm)
mac_installers=(_darwin_universal.app.tar.gz)
installers=("${x64_installers[@]}" "${mac_installers[@]}")
[ "$arm" = 1 ] && installers+=("${arm_installers[@]}")

for ext in "${installers[@]}" _darwin_universal.dmg; do
  c=$(count "$ext")
  [ "$c" = 1 ] || problem "expected exactly one '*$ext', found $c"
done

# every installer except the .dmg has exactly one signature
for ext in "${installers[@]}"; do
  c=$(count "$ext.sig")
  [ "$c" = 1 ] || problem "expected exactly one '*$ext.sig', found $c"
done

# nothing else: a file that ends with none of the known suffixes (a third Windows setup, an installer of an architecture we do not build)
while IFS= read -r n; do
  [ -z "$n" ] && continue
  [ "$n" = "latest.json" ] && continue
  [ "$n" = "$offline" ] && continue
  known=0
  for ext in "${installers[@]}" _darwin_universal.dmg; do
    case "$n" in *"$ext" | *"$ext.sig") known=1 ;; esac
  done
  [ "$known" = 1 ] || problem "an asset that belongs to no expected installer: '$n'"
done <<<"$names"
if [ "$store_exe" = 1 ]; then
  c=$(count "_offline.exe")
  [ "$c" = 1 ] && has "$offline" || problem "expected exactly one '$offline', found $c"
fi
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
