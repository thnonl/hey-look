#!/usr/bin/env bash
# Offline fixtures for check-release-assets.sh (no network): `bash .github/scripts/test-check-release-assets.sh`
# Exit 0 when every case behaves as expected.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
check="$here/check-release-assets.sh"
fails=0

base='HeyLook_1.0.0_windows_x64-setup.exe
HeyLook_1.0.0_windows_x64-setup.exe.sig
HeyLook_1.0.0_windows_x64.msi
HeyLook_1.0.0_windows_x64.msi.sig
HeyLook_1.0.0_darwin_universal.dmg
HeyLook_1.0.0_darwin_universal.app.tar.gz
HeyLook_1.0.0_darwin_universal.app.tar.gz.sig
HeyLook_1.0.0_linux_amd64.AppImage
HeyLook_1.0.0_linux_amd64.AppImage.sig
HeyLook_1.0.0_linux_amd64.deb
HeyLook_1.0.0_linux_amd64.deb.sig
HeyLook_1.0.0_linux_x86_64.rpm
HeyLook_1.0.0_linux_x86_64.rpm.sig'
full="$base
latest.json"

# expect <name> <0|1 = expected exit code> <list> [--pre]
expect() {
  local name="$1" want="$2" list="$3" flag="${4:-}" out rc
  out=$(printf '%s\n' "$list" | bash "$check" 1.0.0 $flag 2>&1)
  rc=$?
  [ "$rc" -ne 0 ] && rc=1
  if [ "$rc" = "$want" ]; then echo "ok    $name"; else echo "FAIL  $name (exit $rc, wanted $want): $out"; fails=$((fails + 1)); fi
}

expect "the full list of 14" 0 "$full"
expect "before latest.json (--pre)" 0 "$base" --pre
expect "latest.json missing" 1 "$base"
expect "latest.json already there with --pre" 1 "$full" --pre
expect "no .msi.sig" 1 "$(printf '%s\n' "$full" | grep -v 'msi.sig')"
expect "a .dmg.sig" 1 "$full
HeyLook_1.0.0_darwin_universal.dmg.sig"
expect "a signature without its installer" 1 "$(printf '%s\n' "$full" | grep -v 'x86_64.rpm$')"
expect "no .app.tar.gz" 1 "$(printf '%s\n' "$full" | grep -v 'app.tar.gz')"
expect "two latest.json" 1 "$full
latest.json"
expect "a name with a space" 1 "$(printf '%s\n' "$full" | sed 's/linux_amd64.deb$/linux amd64.deb/')"
expect "a sanitised tauri name" 1 "$(printf '%s\n' "$full" | sed 's/HeyLook_1.0.0_linux_amd64.deb$/Hey.Look._1.0.0_amd64.deb/')"
# a bare, directly runnable program must never be among the assets
expect "a bare hey-look.exe" 1 "$full
hey-look.exe"
expect "a bare HeyLook_..._windows_x64.exe" 1 "$full
HeyLook_1.0.0_windows_x64.exe"
expect "a bare executable in a --pre list" 1 "$base
hey-look.exe" --pre
expect "CRLF input" 0 "$(printf '%s\n' "$full" | sed 's/$/\r/')"

[ "$fails" = 0 ] && echo "all cases passed"
exit "$fails"
