#!/usr/bin/env bash
# Offline fixtures for install-linux-deps.sh (a fake `sudo` and a fake `apt-get` that answers from a plan; no root, no network):
#   bash .github/scripts/test-install-linux-deps.sh
# Exit 0 when every case behaves as expected. Also checks that both jobs of release.yml use the script, the same pinned cache steps and the same key.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/install-linux-deps.sh"
workflow="$here/../workflows/release.yml"
fails=0
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/bin"
cat > "$work/bin/sudo" << 'SUDO'
#!/usr/bin/env bash
exec "$@"
SUDO
# fake apt-get: the answer of call N is word N of $FAKE_PLAN (0 = ok, anything else = that exit code; 124 = ran out of time); every call is
# logged with its sub-command, the archive named in sources.list at that moment and its arguments
cat > "$work/bin/apt-get" << 'APT'
#!/usr/bin/env bash
n=$(( $(cat "$FAKE_DIR/n" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$FAKE_DIR/n"
args=" $* "
sub=update; case "$args" in *" install "*) sub=install ;; esac
case "$args" in *" --no-download "*) sub="$sub --no-download" ;; esac
case "$args" in *" --download-only "*) sub="$sub --download-only" ;; esac
echo "$sub | $(grep -h -o 'azure[^ ]*\|mirror+file:[^ ]*\|http://archive[^ ]*' "$FAKE_ETC/sources.list" | head -1) | $*" >> "$FAKE_DIR/calls"
set -- $FAKE_PLAN
rc="${!n:-0}"
# a successful install leaves a package file, like the real one
case "$sub" in "install --download-only") [ "$rc" = 0 ] && echo deb > "$FAKE_ARCHIVES/libfake.deb" ;; esac
exit "$rc"
APT
chmod +x "$work/bin/sudo" "$work/bin/apt-get"

# run <plan> : runs the script against a fresh fake system; sets out, rc, calls
run() {
  rm -rf "$work/etc" "$work/arch" "$work/fake"
  mkdir -p "$work/etc/sources.list.d" "$work/fake" "$work/arch"
  echo 'deb mirror+file:/etc/apt/apt-mirrors.txt jammy main restricted' > "$work/etc/sources.list"
  echo 'deb http://security.ubuntu.com/ubuntu jammy-security main' >> "$work/etc/sources.list"
  # leftovers of a root-owned run in the cache directory must not reach the cache
  mkdir -p "$work/arch/partial"
  : > "$work/arch/lock"
  out=$(PATH="$work/bin:$PATH" FAKE_PLAN="$1" FAKE_DIR="$work/fake" FAKE_ETC="$work/etc" FAKE_ARCHIVES="$work/arch" APT_ETC="$work/etc" APT_ARCHIVES="$work/arch" APT_ATTEMPT_LIMIT=30 \
    bash "$script" 2>&1)
  rc=$?
  calls=$(cat "$work/fake/calls" 2>/dev/null)
}

# check <name> <detail> <command...> : passes when the command succeeds
check() {
  local name="$1" detail="$2"
  shift 2
  if "$@"; then echo "ok    $name"; else echo "FAIL  $name: $detail"; fails=$((fails + 1)); fi
}
has() { printf '%s\n' "$1" | grep -qF -- "$2"; }
line_has() { printf '%s\n' "$1" | sed -n "${2}p" | grep -qF -- "$3"; }
count_lines() { [ "$(printf '%s\n' "$1" | wc -l | tr -d ' ')" = "$2" ]; }

# 1. a full cache: one call, no update, exit 0
run "0"
check "cache hit: exit 0" "rc=$rc $out" [ "$rc" = 0 ]
check "cache hit: one apt-get call, install --no-download, no update" "$calls" bash -c 'echo "$1" | grep -q "^install --no-download" && [ "$(echo "$1" | wc -l)" = 1 ]' _ "$calls"
check "cache hit: lock and partial are not left for the cache" "$(ls -A "$work/arch")" bash -c '[ ! -e "$1/lock" ] && [ ! -e "$1/partial" ]' _ "$work/arch"
conf="$work/etc/apt.conf.d/99heylook-ci"
check "the conf has the retries, the timeouts and IPv4" "$(cat "$conf" 2>&1)" bash -c 'grep -q "Acquire::Retries \"5\"" "$1" && grep -q "Acquire::http::Timeout \"20\"" "$1" && grep -q "Acquire::https::Timeout" "$1" && grep -q ForceIPv4 "$1"' _ "$conf"
check "apt-get is told IPv4 and the archive directory" "$calls" has "$calls" "-o Acquire::ForceIPv4=true -o Dir::Cache::archives=$work/arch"

# 2. a miss: the cache try fails, then update + install in attempt 1
run "1 0 0 0"
check "miss: attempt 1 installs after the failed cache try" "rc=$rc $calls" bash -c '[ "$1" = 0 ]' _ "$rc"
check "miss: four calls: cache try, update, download, install" "$calls" bash -c 'echo "$1" | sed -n 2p | grep -q "^update" && echo "$1" | sed -n 3p | grep -q "^install --download-only" && echo "$1" | sed -n 4p | grep -q "^install --no-download" && [ "$(echo "$1" | wc -l)" = 4 ]' _ "$calls"
check "miss: it says attempt 1" "$out" has "$out" "installed in attempt 1"
check "miss: the package file is kept, lock and partial are gone" "$(ls -A "$work/arch")" bash -c '[ -f "$1/libfake.deb" ] && [ ! -e "$1/lock" ] && [ ! -e "$1/partial" ]' _ "$work/arch"

# 3. attempt 1 runs out of time (124): attempt 2 uses the azure archive and wins; the runner's sources are put back
run "1 0 124 0 0 0"
check "slow mirror: exit 0, attempt 2" "rc=$rc $out" bash -c '[ "$1" = 0 ] && echo "$2" | grep -q "installed in attempt 2"' _ "$rc" "$out"
check "slow mirror: attempt 1 was on the runner's own mirror list" "$calls" line_has "$calls" 2 "mirror+file"
check "slow mirror: attempt 2 was on azure.archive.ubuntu.com" "$calls" line_has "$calls" 4 "azure.archive.ubuntu.com"
check "slow mirror: the runner's own sources are back, the security host was never touched" "$(cat "$work/etc/sources.list")" bash -c 'grep -q "mirror+file:/etc/apt/apt-mirrors.txt" "$1" && ! grep -q azure "$1" && grep -q "http://security.ubuntu.com/ubuntu" "$1"' _ "$work/etc/sources.list"

# 4. an update fails, an install runs out of time: the third attempt has the original sources again
run "1 100 0 124 0 0 0"
check "attempt 3 wins" "rc=$rc $out" bash -c '[ "$1" = 0 ] && echo "$2" | grep -q "installed in attempt 3"' _ "$rc" "$out"
check "attempt 3 is on the runner's sources again" "$calls" line_has "$calls" 5 "mirror+file"

# 5. everything fails: exit 1 with an error line
run "1 1 1 1 1 1 1 1"
check "all attempts fail: exit 1 and an ::error::" "rc=$rc $out" bash -c '[ "$1" = 1 ] && echo "$2" | grep -q "::error::" && echo "$2" | grep -q "attempt 3 failed"' _ "$rc" "$out"
check "all attempts fail: the sources are restored" "$(cat "$work/etc/sources.list")" grep -q 'mirror+file' "$work/etc/sources.list"

# 6. the package list is the one the workflow had
want="libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libssl-dev libdbus-1-dev pkg-config"
got=$(bash -c 'source <(sed -n "/^PACKAGES=/p" "$1"); echo "${PACKAGES[*]}"' _ "$script")
check "the package list is the one of the workflow before" "$got" [ "$got" = "$want" ]
run "0"
check "the packages are passed to apt-get" "$calls" has "$calls" "$want"

# 7. the workflow: both jobs restore the cache, run this script, then save; one SHA pin, one key, only the .deb files
for job in rust-tests build; do
  block=$(awk -v job="$job" '$0 ~ "^  " job ":" {on=1; next} on && /^  [a-z][a-z-]*:/ {exit} on {print}' "$workflow")
  r=$(printf '%s\n' "$block" | grep -n 'actions/cache/restore@' | head -1 | cut -d: -f1)
  i=$(printf '%s\n' "$block" | grep -n 'run: bash .github/scripts/install-linux-deps.sh' | head -1 | cut -d: -f1)
  s=$(printf '%s\n' "$block" | grep -n 'actions/cache/save@' | head -1 | cut -d: -f1)
  check "release.yml $job: restore ($r), script ($i), save ($s) in this order" "missing step" bash -c '[ -n "$1" ] && [ -n "$2" ] && [ -n "$3" ] && [ "$1" -lt "$2" ] && [ "$2" -lt "$3" ]' _ "$r" "$i" "$s"
  check "release.yml $job: no apt command of its own" "" bash -c '! echo "$1" | grep -q "sudo apt"' _ "$block"
done
pins=$(grep -o 'actions/cache/\(restore\|save\)@[0-9a-f]\{40\}' "$workflow" | sed 's/.*@//' | sort -u | wc -l | tr -d ' ')
check "release.yml: one SHA pin for the cache actions" "pins=$pins" [ "$pins" = 1 ]
key="key: apt-\${{ runner.os }}-\${{ runner.arch }}-\${{ steps.aptkey.outputs.image }}-\${{ hashFiles('.github/scripts/install-linux-deps.sh') }}-v1"
keys=$(grep -cF "$key" "$workflow")
check "release.yml: the same key in the four cache steps" "keys=$keys" [ "$keys" = 4 ]
paths=$(grep -cF 'path: ~/apt-archives/*.deb' "$workflow")
check "release.yml: only the .deb files are cached (four steps)" "paths=$paths" [ "$paths" = 4 ]

[ "$fails" = 0 ] && echo "all install-linux-deps cases passed" || echo "$fails case(s) failed"
exit $((fails > 0))
