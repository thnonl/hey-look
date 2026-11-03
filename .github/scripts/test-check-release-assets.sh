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

# The ARM64 installers (1.0.12) are expected unless a case says --no-arm (ARM64_BUILD=false): the cases below that were written for the x64 set run with it.
armflag="--no-arm"

# expect <name> <0|1 = expected exit code> <list> [--pre]
expect() {
  local name="$1" want="$2" list="$3" flag="${4:-}" out rc
  out=$(printf '%s\n' "$list" | bash "$check" 1.0.0 $flag $armflag 2>&1)
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
# WP14 option B: the Store's offline installer exists only with the flag STORE_EXE, exactly named, once, without a signature
off='HeyLook_1.0.0_windows_x64_offline.exe'
expect "the offline installer with --store-exe" 0 "$full
$off" --store-exe
expect "the offline installer with --store-exe --pre" 0 "$base
$off" "--pre --store-exe"
expect "--store-exe but no offline installer" 1 "$full" --store-exe
expect "the offline installer without the flag" 1 "$full
$off"
expect "two offline installers" 1 "$full
$off
$off" --store-exe
expect "a signature of the offline installer" 1 "$full
$off
$off.sig" --store-exe
expect "an offline installer of another version" 1 "$full
HeyLook_1.0.1_windows_x64_offline.exe" --store-exe
expect "an offline installer with a setup name" 1 "$full
HeyLook_1.0.0_windows_x64_offline-setup.exe" --store-exe
expect "CRLF input" 0 "$(printf '%s\n' "$full" | sed 's/$/\r/')"

# ---- 1.0.12: the full set with the ARM64 installers (12 installers, 11 signatures, latest.json = 24)
armflag=""
arm='HeyLook_1.0.0_windows_arm64-setup.exe
HeyLook_1.0.0_windows_arm64-setup.exe.sig
HeyLook_1.0.0_windows_arm64.msi
HeyLook_1.0.0_windows_arm64.msi.sig
HeyLook_1.0.0_linux_aarch64.AppImage
HeyLook_1.0.0_linux_aarch64.AppImage.sig
HeyLook_1.0.0_linux_arm64.deb
HeyLook_1.0.0_linux_arm64.deb.sig
HeyLook_1.0.0_linux_aarch64.rpm
HeyLook_1.0.0_linux_aarch64.rpm.sig'
fullarm="$base
$arm
latest.json"
expect "the full list of 24 with ARM64" 0 "$fullarm"
expect "the list of 23 before latest.json (--pre) with ARM64" 0 "$base
$arm" --pre
expect "ARM64 expected but the ARM64 builds are missing" 1 "$full"
expect "no ARM64 .msi" 1 "$(printf '%s\n' "$fullarm" | grep -v 'arm64.msi')"
expect "no ARM64 .deb signature" 1 "$(printf '%s\n' "$fullarm" | grep -v 'arm64.deb.sig')"
expect "an ARM64 signature without its installer" 1 "$(printf '%s\n' "$fullarm" | grep -v 'linux_aarch64.rpm$')"
expect "a second ARM64 setup under another name" 1 "$fullarm
HeyLook_1.0.0_windows_arm64-setup.exe.sig
HeyLook_1.0.0_windows_x86-setup.exe"
expect "an installer of an architecture that is not built" 1 "$fullarm
HeyLook_1.0.0_windows_x86-setup.exe
HeyLook_1.0.0_windows_x86-setup.exe.sig"
expect "an extra Linux deb" 1 "$fullarm
HeyLook_1.0.0_linux_riscv64.deb
HeyLook_1.0.0_linux_riscv64.deb.sig"
expect "the ARM64 set with the offline installer and --store-exe" 0 "$fullarm
$off" --store-exe
armflag="--no-arm"
expect "--no-arm accepts the x64 set" 0 "$full"
expect "--no-arm refuses ARM64 files that are there anyway" 1 "$fullarm"

[ "$fails" = 0 ] && echo "all cases passed"
exit "$fails"
