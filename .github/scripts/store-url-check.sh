#!/usr/bin/env bash
# The check after a Pages deploy that carried the Store's offline installer (WP14 option B, spec W14.1): the address Partner Center is given
# serves the file as it is.
#   bash .github/scripts/store-url-check.sh <version> <sha256> <size> [base-url]
# base-url defaults to https://heylook.namthai.site. It
#   1. waits (up to STORE_URL_WAIT seconds, default 1200) until HEAD <base>/downloads/<V>/HeyLook_<V>_windows_x64_offline.exe answers 200
#      (the Pages CDN and the owner's Caddy may need minutes);
#   2. checks that answer: status 200, no Location (Partner Center rejects a redirect), no Content-Encoding (a proxy must not change the bytes),
#      Content-Length = <size>; Accept-Ranges is only printed;
#   3. downloads the file: its sha256 is <sha256> (the digest GitHub states for the release asset);
#   4. robots.txt of the site disallows /downloads/ (crawlers have no business there).
# Exit 0 only when everything holds.
set -uo pipefail
v="${1:?usage: store-url-check.sh <version> <sha256> <size> [base-url]}"
want_sha="${2:?usage: store-url-check.sh <version> <sha256> <size> [base-url]}"
want_size="${3:?usage: store-url-check.sh <version> <sha256> <size> [base-url]}"
base="${4:-https://heylook.namthai.site}"
wait_s="${STORE_URL_WAIT:-1200}"
die() { echo "::error::$*" >&2; exit 1; }
[[ "$want_sha" =~ ^[0-9a-f]{64}$ ]] || die "the sha256 must be 64 lower-case hex digits"
case "$want_size" in '' | *[!0-9]*) die "the size must be a number" ;; esac
url="$base/downloads/$v/HeyLook_${v}_windows_x64_offline.exe"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

t0=$SECONDS
while :; do
  h=$(curl -sSI -H 'Cache-Control: no-cache' "$url" 2> /dev/null | tr -d '\r') && status=$(head -1 <<< "$h" | awk '{print $2}') || status=""
  [ "$status" = 200 ] && break
  [ $((SECONDS - t0)) -lt "$wait_s" ] || die "HEAD $url: still not 200 after ${wait_s}s (last status '${status:-none}')"
  echo "waiting for $url (status '${status:-none}', $((SECONDS - t0))s) ..."
  sleep "${STORE_URL_SLEEP:-30}"
done
echo "the address answers 200 after $((SECONDS - t0))s"

! grep -qi '^location:' <<< "$h" || die "HEAD $url: it redirects ($(grep -i '^location:' <<< "$h")): Partner Center refuses a redirect"
! grep -qi '^content-encoding:' <<< "$h" || die "HEAD $url: Content-Encoding is set ($(grep -i '^content-encoding:' <<< "$h")): a proxy changed the bytes"
got=$(grep -i '^content-length:' <<< "$h" | tail -1 | awk '{print $2}')
[ "$got" = "$want_size" ] || die "HEAD $url: Content-Length is '$got', expected $want_size"
echo "ok  HEAD: 200, $want_size bytes, no Location, no Content-Encoding, $(grep -i '^accept-ranges:' <<< "$h" || echo 'no Accept-Ranges header')"

curl -fsS --retry 3 --retry-delay 5 -H 'Cache-Control: no-cache' -o "$work/file" "$url" || die "download of $url failed"
sha=$(sha256sum < "$work/file" | cut -d' ' -f1)
[ "$sha" = "$want_sha" ] || die "$url: the served file has sha256 $sha, the release asset has $want_sha"
echo "ok  the served file is the release asset (sha256 $sha)"

robots=$(curl -fsS "$base/robots.txt") || die "robots.txt could not be read"
grep -qx 'Disallow: /downloads/' <<< "$(tr -d '\r' <<< "$robots")" || die "robots.txt does not disallow /downloads/"
echo "ok  robots.txt disallows /downloads/"
echo "Store URL check passed: $url"
