#!/usr/bin/env bash
# Puts the Store's offline installers into the website that pages.yml deploys (WP14 option B, spec W14.1; only when the repository variable
# STORE_EXE is `true`, otherwise pages.yml does not call this and the site is exactly what it was).
#   bash .github/scripts/store-exe-assemble.sh <site-dir> <owner/repo> [keep]
# For the newest <keep> (default 3) PUBLISHED releases that carry HeyLook_<V>_windows_x64_offline.exe it downloads the asset from the
# release (never from anywhere else) into <site-dir>/downloads/<V>/ and checks it against the sha256 digest and the size GitHub states for the
# asset: any mismatch, a missing or odd digest, a name that does not belong to the tag, or a url outside the release stops the job before
# anything is uploaded. The address https://heylook.namthai.site/downloads/<V>/HeyLook_<V>_windows_x64_offline.exe never changes for a
# published version (Partner Center wants a stable URL without redirects). Needs gh (with GH_TOKEN), jq, curl, sha256sum.
# Prints, for $GITHUB_OUTPUT: count=<n>, newest=<version>, newest_sha256=<hex>, newest_size=<bytes> (count=0 and nothing else when no release has it yet).
set -uo pipefail
site="${1:?usage: store-exe-assemble.sh <site-dir> <owner/repo> [keep]}"
repo="${2:?usage: store-exe-assemble.sh <site-dir> <owner/repo> [keep]}"
keep="${3:-3}"
die() { echo "::error::$*" >&2; exit 1; }
# (jq.exe on Windows ends its lines with CR; this script is also run there by its test)
jq() { command jq "$@" | tr -d '\r'; }
for c in gh jq curl sha256sum; do command -v "$c" > /dev/null || die "$c is needed"; done
[ -d "$site" ] || die "$site does not exist"
case "$keep" in '' | *[!0-9]*) die "keep must be a number" ;; esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# [{tag, version, name, size, digest, url}] of the published, non-prerelease releases that have exactly one offline installer, newest version first
gh api "repos/$repo/releases" --paginate --jq '.[] | select(.draft == false and .prerelease == false) | {tag: .tag_name, assets: [.assets[] | select(.name | test("^HeyLook_[0-9]+\\.[0-9]+\\.[0-9]+_windows_x64_offline\\.exe$")) | {name, size, digest, url: .browser_download_url}]} | select((.assets | length) == 1) | {tag, name: .assets[0].name, size: .assets[0].size, digest: .assets[0].digest, url: .assets[0].url}' > "$work/all.jsonl" || die "could not list the releases of $repo"
jq -s --argjson keep "$keep" 'map(. + {version: (.tag | ltrimstr("v"))}) | sort_by(.version | split(".") | map(tonumber)) | reverse | .[0:$keep]' "$work/all.jsonl" > "$work/pick.json" || die "could not read the release list"

n=$(jq 'length' "$work/pick.json")
if [ "$n" = 0 ]; then
  echo "::notice::no published release has a Store offline installer yet: nothing is added to the site" >&2
  echo "count=0"
  exit 0
fi

i=0
while IFS=$'\t' read -r tag version name size digest url; do
  [ "$tag" = "v$version" ] || die "release tag '$tag' is not v<version>"
  [ "$name" = "HeyLook_${version}_windows_x64_offline.exe" ] || die "$tag: the asset '$name' does not belong to the version $version"
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die "$tag: GitHub states no sha256 digest for $name (got '$digest'); the file cannot be verified"
  [ "$url" = "https://github.com/$repo/releases/download/$tag/$name" ] || die "$tag: the download url '$url' is not the release asset of this repository"
  dir="$site/downloads/$version"
  mkdir -p "$dir"
  curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors -o "$dir/$name" "$url" || die "download of $url failed"
  got=$(sha256sum < "$dir/$name" | cut -d' ' -f1)
  [ "sha256:$got" = "$digest" ] || die "$name: the download has sha256 $got, GitHub says $digest"
  [ "$(wc -c < "$dir/$name" | tr -d ' ')" = "$size" ] || die "$name: the size is not $size"
  echo "ok  $name $size bytes $got" >&2
  if [ "$i" = 0 ]; then newest="$version"; newest_sha="$got"; newest_size="$size"; fi
  i=$((i + 1))
done < <(jq -r '.[] | [.tag, .version, .name, (.size | tostring), .digest, .url] | @tsv' "$work/pick.json")

echo "count=$i"
echo "newest=$newest"
echo "newest_sha256=$newest_sha"
echo "newest_size=$newest_size"
