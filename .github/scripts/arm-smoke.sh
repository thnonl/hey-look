#!/usr/bin/env bash
# The smoke test of the native Linux ARM64 build, on the ARM64 runner that built it (job build, leg "Linux (ARM64)", release profile):
#   bash .github/scripts/arm-smoke.sh
# What it shows (each line is printed as "ok" or fails the step):
#   1. the machine is aarch64 and the release binary is an AArch64 ELF (not an x86-64 file that only happens to be somewhere);
#   2. the glibc floor: the newest GLIBC_x.y symbol the binary needs is not above 2.35 (Ubuntu 22.04, the image that built it);
#   3. the .deb says Architecture: arm64 and the .rpm / AppImage are aarch64 files;
#   4. the .deb installs (apt resolves its dependencies on arm64) and the installed program is the same AArch64 file;
#   5. the installed program starts on a virtual display (Xvfb) with a session bus, is still running after 25 s and has made its database.
# No secret, nothing leaves the runner. The tray and the keyring are not part of this check (no tray host, no Secret Service on the runner).
set -euo pipefail

bundle=src-tauri/target/release/bundle
bin=src-tauri/target/release/hey-look
ok() { echo "ok    $*"; }
fail() { echo "::error::arm-smoke: $*"; exit 1; }

[ "$(uname -m)" = aarch64 ] || fail "this runner is $(uname -m), not aarch64"
ok "the runner is aarch64"

[ -f "$bin" ] || fail "$bin does not exist"
readelf -h "$bin" | grep -q 'Machine:.*AArch64' || fail "$bin is not an AArch64 ELF: $(file "$bin")"
ok "$bin is an AArch64 ELF"

# the glibc floor of the packages (the x64 Linux build is made on the same Ubuntu release)
need=$(objdump -T "$bin" | grep -o 'GLIBC_[0-9.]*' | sed 's/GLIBC_//' | sort -uV | tail -n 1)
echo "newest glibc symbol the binary needs: ${need:-none}"
[ -n "$need" ] || fail "no GLIBC symbol found (is objdump working?)"
top=$(printf '%s\n%s\n' "$need" 2.35 | sort -V | tail -n 1)
[ "$top" = 2.35 ] || fail "the binary needs glibc $need, above the floor 2.35"
ok "glibc floor: needs $need, floor 2.35"

deb=$(ls $bundle/deb/*.deb)
[ "$(printf '%s\n' "$deb" | wc -l)" = 1 ] || fail "expected exactly one .deb"
arch=$(dpkg-deb -f "$deb" Architecture)
[ "$arch" = arm64 ] || fail "the .deb says Architecture: $arch"
ok "$(basename "$deb") says Architecture: arm64"
ls -l $bundle/rpm/*.rpm $bundle/appimage/*.AppImage
rpm_arch=$(ls $bundle/rpm/*.rpm | sed -E 's/.*\.([a-z0-9_]+)\.rpm$/\1/')
[ "$rpm_arch" = aarch64 ] || fail "the .rpm is named for $rpm_arch"
ok "the .rpm is for aarch64"
appimage=$(ls $bundle/appimage/*.AppImage)
file "$appimage" | grep -q 'ARM aarch64' || fail "the AppImage is not an ARM aarch64 file: $(file "$appimage")"
ok "the AppImage is an ARM aarch64 file"

# the installed program
sudo apt-get install -y --no-install-recommends xvfb dbus-x11 "./$deb" > apt-install.log 2>&1 || { tail -n 30 apt-install.log; fail "the .deb did not install"; }
ok "the .deb installed (dependencies resolved on arm64)"
installed=$(command -v hey-look || true)
[ -n "$installed" ] || fail "hey-look is not on the PATH after the install"
readelf -h "$(readlink -f "$installed")" | grep -q 'Machine:.*AArch64' || fail "the installed program is not AArch64"
ok "the installed $installed is AArch64"
cmp -s "$(readlink -f "$installed")" "$bin" || echo "note: the installed program differs from the build output (the bundler strips or relinks it)"

log="$RUNNER_TEMP/hey-look-smoke.log"
export HOME_BEFORE="$HOME"
dbus-run-session -- xvfb-run -a -s "-screen 0 1280x800x24" "$installed" > "$log" 2>&1 &
pid=$!
sleep 25
if ! kill -0 "$pid" 2> /dev/null; then
  echo "--- program output"; tail -n 40 "$log"
  fail "the program is not running 25 s after the start"
fi
ok "the program was still running after 25 s"
db=$(find "$HOME" -name 'heylook.db*' -not -path '*/node_modules/*' 2> /dev/null | head -n 1 || true)
[ -n "$db" ] || { echo "--- program output"; tail -n 40 "$log"; fail "no heylook.db was made under $HOME"; }
ok "the database exists: $db"
# stop only what this step started (the dbus-run-session group leader's children)
pkill -TERM -P "$pid" 2> /dev/null || true
kill -TERM "$pid" 2> /dev/null || true
wait "$pid" 2> /dev/null || true
echo "program output (last lines):"; tail -n 15 "$log"
echo "ARM64 Linux smoke test passed"
