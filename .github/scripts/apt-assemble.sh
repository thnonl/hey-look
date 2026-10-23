#!/usr/bin/env bash
# Puts the APT repository into the website that pages.yml deploys (WP15, spec 15.8).
#   bash .github/scripts/apt-assemble.sh <site-dir> <apt-branch-checkout> <keyring.gpg>
# <site-dir> is the built site (_site, it already holds apt/heylook-archive-keyring.*, apt/heylook.sources from docs/apt), <apt-branch-checkout>
# a checkout of the branch `apt` (dists/ and pool.json, written and signed by the release workflow), <keyring.gpg> the public key in git
# (docs/apt/heylook-archive-keyring.gpg). It copies dists/ and pool.json to <site-dir>/apt, downloads every .deb named by pool.json from the
# GitHub release it points at (never from anywhere else), and then checks everything the way a client does: the signature of InRelease and
# Release.gpg with the committed public key, every hash of Release, and every .deb against Packages (apt-repo.sh verify). Any failure stops
# before the site is uploaded, so write access to the branch `apt` alone cannot publish a forged repository. No secret is used.
# Prints (on stdout, for $GITHUB_OUTPUT) version=<newest version> and inrelease_sha256=<sha256 of the deployed InRelease>.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
site="${1:?usage: apt-assemble.sh <site-dir> <apt-branch-checkout> <keyring.gpg>}"
branch="${2:?usage: apt-assemble.sh <site-dir> <apt-branch-checkout> <keyring.gpg>}"
keyring="${3:?usage: apt-assemble.sh <site-dir> <apt-branch-checkout> <keyring.gpg>}"
die() { echo "::error::$*" >&2; exit 1; }
command -v jq > /dev/null || die "jq is needed"

[ -f "$branch/dists/stable/InRelease" ] && [ -f "$branch/pool.json" ] || die "the branch apt has no dists/stable/InRelease or no pool.json"
[ -d "$site" ] || die "$site does not exist"
apt="$site/apt"
mkdir -p "$apt"
cp -a "$branch/dists" "$apt/dists"
cp "$branch/pool.json" "$apt/pool.json"

n=0
while IFS=$'\t' read -r file url sha size; do
  case "$url" in
    https://github.com/thnonl/hey-look/releases/download/v*/HeyLook_*_linux_amd64.deb) ;;
    *) die "pool.json: $file points at '$url', which is not a release asset of this repository" ;;
  esac
  case "$file" in pool/main/h/hey-look/hey-look_*_amd64.deb) ;; *) die "pool.json: unexpected pool path '$file'" ;; esac
  mkdir -p "$apt/$(dirname "$file")"
  curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors -o "$apt/$file" "$url" || die "download of $url failed"
  got=$(sha256sum "$apt/$file" | cut -d' ' -f1)
  [ "$got" = "$sha" ] || die "$file: the download from the release has sha256 $got, pool.json says $sha"
  [ "$(wc -c < "$apt/$file" | tr -d ' ')" = "$size" ] || die "$file: the size is not $size"
  n=$((n + 1))
done < <(jq -r '.[] | [.file, .url, .sha256, .size] | @tsv' "$apt/pool.json")
[ "$n" -ge 1 ] || die "pool.json lists no package"

bash "$here/apt-repo.sh" verify "$apt" "$keyring" || die "the repository of the branch apt does not verify: the site is not changed"

# the newest version and the hash of the InRelease that is deployed (the live check waits for exactly this file)
echo "version=$(jq -r '[.[].version] | sort_by(split(".") | map(tonumber)) | last' "$apt/pool.json")"
echo "inrelease_sha256=$(sha256sum "$apt/dists/stable/InRelease" | cut -d' ' -f1)"
