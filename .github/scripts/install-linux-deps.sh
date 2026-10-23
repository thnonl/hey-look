#!/usr/bin/env bash
# Installs the system packages of the Linux build and of the Rust tests (the step "Install Linux dependencies" of both jobs in release.yml).
#   bash .github/scripts/install-linux-deps.sh
#
# Why this is more than one apt-get line: on 2026-10-23 the step took 1542 s in two dry runs in a row (the Ubuntu mirror gave 21 kB/s) and
# 24 s in the other job of the same run. So:
#   1. apt gets a conf (99heylook-ci): 5 retries, a stall timeout of 20 s, IPv4 only, downloaded packages are kept.
#   2. The .deb files live in $APT_ARCHIVES (default ~/apt-archives, a normal user directory: the cache step of the workflow restores it
#      without sudo and saves it after this script). First try: install from that directory only (--no-download, no `apt-get update`, no
#      mirror traffic). It works on a full cache hit and fails fast on a miss, a partial cache or a stale index.
#   3. Then the hardened path, up to 3 attempts of `apt-get update` + `apt-get install --download-only`, each with a time limit
#      ($APT_ATTEMPT_LIMIT, 180 s; a slow mirror delivers no more than a few MB in that time, a normal install takes 24 s), then the install
#      itself from the downloaded files (no limit: only the network steps are cut short, never dpkg): attempt 1 with the runner's own sources,
#      attempt 2 with the archive switched to archive.ubuntu.com (the runner's own list points at azure.archive.ubuntu.com, which is the slow
#      one when a run is slow: dry run 39997925232 got 40 kB/s from it, so a second try on the same host helps nobody), attempt 3 with the
#      runner's original sources again (its mirror:// list tries the next mirror when one fails). Partial downloads are kept between attempts
#      (apt resumes them).
#      The time limit is `sudo timeout ... apt-get` (timeout INSIDE sudo): a `timeout ... sudo apt-get` kills only sudo, apt-get and its download
#      methods go on as root and keep the lock of $APT_ARCHIVES, so the next attempts failed with "Could not get lock ... held by apt-get". And
#      before every retry whatever a cut-short step left behind (apt-get, apt, the methods in /usr/lib/apt/methods) is stopped by its exact pid,
#      and the script waits (up to 60 s) until no apt-get, apt, method or dpkg runs. A running dpkg is only waited for, never killed.
#   4. The debs are root-owned after apt: they are handed to the user and `lock` / `partial` are removed, so the cache step saves *.deb only.
# The package list is the only one; the cache key of the workflow includes the hash of this file.
# The tray library is the Ayatana one (libayatana-appindicator3-dev), never libappindicator3-dev: the Tauri bundler writes the dependency of the
# .deb from the dev package it finds, and libappindicator3-1 does not exist on Debian 12 (WP15, DEC-003). Do not install both.
# Test: .github/scripts/test-install-linux-deps.sh (fake apt-get, no root).
set -uo pipefail

PACKAGES=(libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf libssl-dev libdbus-1-dev pkg-config)
etc="${APT_ETC:-/etc/apt}"
archives="${APT_ARCHIVES:-$HOME/apt-archives}"
limit="${APT_ATTEMPT_LIMIT:-180}"
case "$limit" in '' | *[!0-9]*) echo "::error::APT_ATTEMPT_LIMIT must be whole seconds"; exit 1 ;; esac

say() { echo "install-linux-deps: $*"; }

# (`timeout` cannot run a shell function: the command is spelled out; it runs apt-get itself, as root, so its TERM reaches apt-get)
# net: a step that uses the network has a time limit. local: dpkg unpacking and configuring is never cut short (a package left half
# configured would block the next attempt), so it runs without a limit and only from the files that were downloaded (--no-download).
apt_net() { sudo timeout -k 10 "$limit" apt-get -o Acquire::ForceIPv4=true -o "Dir::Cache::archives=$archives" "$@"; }
apt_local() { sudo apt-get -o Acquire::ForceIPv4=true -o "Dir::Cache::archives=$archives" install -y --no-download "${PACKAGES[@]}"; }

write_conf() {
  sudo mkdir -p "$etc/apt.conf.d"
  sudo tee "$etc/apt.conf.d/99heylook-ci" > /dev/null << 'CONF'
Acquire::Retries "5";
Acquire::http::Timeout "20";
Acquire::https::Timeout "20";
Acquire::ForceIPv4 "true";
APT::Keep-Downloaded-Packages "true";
CONF
}

# The files that name the Ubuntu archive: sources.list and the .list / .sources files next to it.
source_files() {
  local f
  for f in "$etc/sources.list" "$etc/sources.list.d/"*.list "$etc/sources.list.d/"*.sources; do
    [ -f "$f" ] && echo "$f"
  done
}

# Keeps a copy of every source file once (as <file>.heylook-orig), so the runner's own setup can be put back.
backup_sources() {
  local f
  while IFS= read -r f; do
    [ -e "$f.heylook-orig" ] || sudo cp -p "$f" "$f.heylook-orig"
  done < <(source_files)
}

restore_sources() {
  local f
  while IFS= read -r f; do
    [ -e "$f.heylook-orig" ] && sudo cp -p "$f.heylook-orig" "$f"
  done < <(source_files)
}

# Points the Ubuntu archive (any *archive.ubuntu.com host and the runner's mirror:// list; not the security host) at $1.
use_archive() {
  local f n=0
  while IFS= read -r f; do
    sudo sed -E -i 's#(https?://([a-z0-9.-]+\.)?archive\.ubuntu\.com/ubuntu/?|mirror\+file:[^ ]*apt-mirrors\.txt)#'"$1"'#g' "$f" && n=$((n + 1))
  done < <(source_files)
  say "the archive is $1 in $n source file(s)"
}

# The pids of apt-get, apt and the download methods (what a cut-short network step can leave running), one per line.
leftover_pids() {
  command -v pgrep > /dev/null 2>&1 || return 0
  { pgrep -x apt-get; pgrep -x apt; pgrep -f '^/usr/lib/apt/methods/'; } 2> /dev/null | sort -u | grep -v -x "$$" || true
}
# The same and dpkg (only waited for).
busy_pids() {
  command -v pgrep > /dev/null 2>&1 || return 0
  { leftover_pids; pgrep -x dpkg; } 2> /dev/null | sort -u || true
}
# Before a retry: stop what the last step left behind (TERM, then KILL after 3 s, by exact pid), then wait for the lock to be free.
stop_leftovers() {
  local pids i
  pids=$(leftover_pids | tr '\n' ' ')
  if [ -n "${pids// /}" ]; then
    say "stopping what the cut-short step left running (pid $pids)"
    # shellcheck disable=SC2086
    sudo kill -TERM $pids 2> /dev/null
    sleep 3
    pids=$(leftover_pids | tr '\n' ' ')
    # shellcheck disable=SC2086
    [ -z "${pids// /}" ] || sudo kill -KILL $pids 2> /dev/null
  fi
  for i in $(seq 1 60); do
    [ -z "$(busy_pids)" ] && return 0
    sleep 1
  done
  say "apt-get, apt or dpkg is still running after 60 s: $(busy_pids | tr '\n' ' ')"
}

finish() {
  # the debs were written by root: the cache step runs as the user. Only the .deb files are cached (not lock, not partial)
  sudo chown -R "$(id -u):$(id -g)" "$archives" || true
  sudo rm -rf "$archives/lock" "$archives/partial"
  say "done; $(find "$archives" -maxdepth 1 -name '*.deb' | wc -l) .deb file(s) in $archives"
  exit 0
}

mkdir -p "$archives/partial"
write_conf
backup_sources

say "from the cached packages only (no download, no apt-get update)"
if apt_local; then
  say "installed from the cache"
  finish
fi
say "the cache did not hold everything: installing from the mirror"

for attempt in 1 2 3; do
  case "$attempt" in
    2) use_archive "http://archive.ubuntu.com/ubuntu/" ;;
    3) restore_sources; say "the runner's own sources again (its mirror list tries the next mirror when one fails)" ;;
  esac
  stop_leftovers
  say "attempt $attempt of 3 (limit $limit s each for the update and the download)"
  if apt_net update && apt_net install -y --download-only "${PACKAGES[@]}" && apt_local; then
    say "installed in attempt $attempt"
    restore_sources
    finish
  fi
  say "attempt $attempt failed or ran out of time"
done

restore_sources
echo "::error::the Linux system packages could not be installed in 3 attempts"
exit 1
