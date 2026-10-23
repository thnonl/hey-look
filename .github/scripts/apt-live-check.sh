#!/usr/bin/env bash
# The check after a Pages deploy (WP15, spec 4.8 and 15.9): the files of the APT repository are served the way apt needs them.
#   bash .github/scripts/apt-live-check.sh <inrelease-sha256> [base-url]
# base-url defaults to https://heylook.namthai.site. It
#   1. waits (up to APT_WAIT seconds, default 1200) until the live apt/dists/stable/InRelease is the file that was deployed (the Pages CDN
#      keeps a file for up to 10 minutes and the owner's Caddy may cache it too);
#   2. checks with curl -I the InRelease, Packages.xz, one by-hash file and the newest .deb: status 200, no Location, no Content-Encoding
#      (apt wants the bytes as they are), Content-Length = the size in Release / Packages;
#   3. downloads the newest .deb: its sha256 is the one in Packages, and (with GH_TOKEN) the digest of the GitHub release asset;
#   4. for the real address: http:// answers with a redirect to https:// (the documented URL is https).
# Exit 0 only when everything holds. APT_SKIP_HTTP_REDIRECT=1 skips step 4 (a local test server).
set -uo pipefail
want="${1:?usage: apt-live-check.sh <inrelease-sha256> [base-url]}"
base="${2:-https://heylook.namthai.site}"
wait_s="${APT_WAIT:-1200}"
die() { echo "::error::$*" >&2; exit 1; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
apt="$base/apt"

fetch() { curl -fsS --retry 3 --retry-delay 3 -H 'Cache-Control: no-cache' -o "$2" "$1"; }

# 1. wait for the deployed InRelease
t0=$SECONDS
while :; do
  if fetch "$apt/dists/stable/InRelease" "$work/InRelease" 2> /dev/null && [ "$(sha256sum "$work/InRelease" | cut -d' ' -f1)" = "$want" ]; then break; fi
  [ $((SECONDS - t0)) -lt "$wait_s" ] || die "the live InRelease is not the deployed one after ${wait_s}s (live sha256 $(sha256sum "$work/InRelease" 2> /dev/null | cut -d' ' -f1), deployed $want)"
  echo "waiting for the deployed InRelease ($((SECONDS - t0))s) ..."
  sleep 30
done
echo "the live InRelease is the deployed one after $((SECONDS - t0))s"

# the clear-signed text is the Release: the hash and size of Packages.xz are in its SHA256 block
rel=$(sed -n '/^SHA256:/,/^[^ ]/p' "$work/InRelease")
line=$(grep -E ' main/binary-amd64/Packages\.xz$' <<< "$rel" | head -1)
xzhash=$(awk '{print $1}' <<< "$line"); xzsize=$(awk '{print $2}' <<< "$line")
[ -n "$xzhash" ] || die "InRelease lists no main/binary-amd64/Packages.xz"

head_ok() { # head_ok URL EXPECTED_LENGTH
  local url="$1" len="$2" h status
  h=$(curl -sSI --retry 3 --retry-delay 3 "$url") || die "HEAD $url failed"
  status=$(head -1 <<< "$h" | awk '{print $2}')
  [ "$status" = 200 ] || die "HEAD $url: status $status, expected 200"
  ! grep -qi '^location:' <<< "$h" || die "HEAD $url: it redirects ($(grep -i '^location:' <<< "$h" | tr -d '\r'))"
  ! grep -qi '^content-encoding:' <<< "$h" || die "HEAD $url: Content-Encoding is set ($(grep -i '^content-encoding:' <<< "$h" | tr -d '\r')): a proxy changed the bytes"
  local got
  got=$(grep -i '^content-length:' <<< "$h" | tail -1 | awk '{print $2}' | tr -d '\r')
  [ "$got" = "$len" ] || die "HEAD $url: Content-Length is '$got', expected $len"
  echo "ok  $url (200, $len bytes, no Location, no Content-Encoding)"
}

head_ok "$apt/dists/stable/InRelease" "$(wc -c < "$work/InRelease" | tr -d ' ')"
head_ok "$apt/dists/stable/main/binary-amd64/Packages.xz" "$xzsize"
head_ok "$apt/dists/stable/main/binary-amd64/by-hash/SHA256/$xzhash" "$xzsize"

# 3. the newest .deb against Packages
fetch "$apt/dists/stable/main/binary-amd64/Packages.xz" "$work/Packages.xz" || die "download of Packages.xz failed"
[ "$(sha256sum "$work/Packages.xz" | cut -d' ' -f1)" = "$xzhash" ] || die "Packages.xz: the sha256 is not the one of InRelease"
xz -dc "$work/Packages.xz" > "$work/Packages" || die "Packages.xz does not decompress"
# the stanza with the highest version
newest=$(awk -v RS= -F'\n' '{v="";for(i=1;i<=NF;i++)if($i~/^Version: /)v=substr($i,10); print v "\t" NR}' "$work/Packages" | sort -V | tail -1 | cut -f2)
stanza=$(awk -v RS= -v n="$newest" 'NR==n' "$work/Packages")
file=$(sed -n 's/^Filename: //p' <<< "$stanza"); size=$(sed -n 's/^Size: //p' <<< "$stanza"); sha=$(sed -n 's/^SHA256: //p' <<< "$stanza"); ver=$(sed -n 's/^Version: //p' <<< "$stanza")
[ -n "$file" ] && [ -n "$sha" ] || die "could not read the newest package out of Packages"
head_ok "$apt/$file" "$size"
fetch "$apt/$file" "$work/newest.deb" || die "download of $file failed"
got=$(sha256sum "$work/newest.deb" | cut -d' ' -f1)
[ "$got" = "$sha" ] || die "$file: the downloaded sha256 $got is not the one in Packages ($sha)"
echo "ok  $file $ver: sha256 = Packages"
if [ -n "${GH_TOKEN:-}" ] && command -v gh > /dev/null; then
  digest=$(gh api "repos/thnonl/hey-look/releases/tags/v$ver" --jq ".assets[] | select(.name == \"HeyLook_${ver}_linux_amd64.deb\") | .digest" 2> /dev/null)
  if [ -n "$digest" ]; then
    [ "$digest" = "sha256:$got" ] || die "$file: the GitHub release digest $digest is not the sha256 of the served file ($got)"
    echo "ok  the digest of the GitHub release asset v$ver is the same"
  else
    echo "::warning::no release digest found for v$ver (a dry run?)"
  fi
fi

# 4. http -> https (the real address only)
if [ "${APT_SKIP_HTTP_REDIRECT:-0}" != 1 ]; then
  h=$(curl -sSI --retry 3 "http://${base#https://}/apt/dists/stable/InRelease") || die "HEAD of the http address failed"
  status=$(head -1 <<< "$h" | awk '{print $2}')
  case "$status" in 301 | 302 | 307 | 308) ;; *) die "http:// answers $status, expected a redirect to https" ;; esac
  grep -qi '^location: https://' <<< "$h" || die "http:// redirects, but not to https:// ($(grep -i '^location:' <<< "$h" | tr -d '\r'))"
  echo "ok  http:// redirects to https:// ($status)"
fi
echo "APT live check passed (newest version $ver)"
echo "version=$ver"
