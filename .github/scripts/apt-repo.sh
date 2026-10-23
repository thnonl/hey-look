#!/usr/bin/env bash
# The signed APT repository of Hey Look! (https://heylook.namthai.site/apt), built from the .deb files of the GitHub releases.
# Spec: WP15 (reports spec-107-wp15-apt.md). One suite `stable`, one component `main`, one architecture `amd64`, built with apt-ftparchive,
# stateless: the repository is made again from the list of releases every time (no database). Used by release.yml (jobs apt-repo and
# apt-repo-dryrun), pages.yml (assemble) and by hand. Needs: bash, apt-ftparchive (apt-utils), gpg and gpgv, jq, xz, gzip, sha256sum, git;
# `fetch` also gh. dpkg-deb is used when it exists.
#
#   apt-repo.sh fetch   --repo OWNER/REPO --keep N --out DIR [--old-pool FILE] [--require-version V] [--local-deb FILE]
#                       DIR gets hey-look_<version>_amd64.deb for the newest N published releases (tag vX.Y.Z, not a draft, not a
#                       pre-release, with the asset HeyLook_<version>_linux_amd64.deb), each checked against the sha256 `digest` of its
#                       asset, and pool.json. A version already listed in --old-pool with another sha256 fails (a pool file never changes).
#                       --local-deb: the .deb of this run instead of the release of its version (dry run; the releases newer than it are left out).
#   apt-repo.sh build   DEBS_DIR OUT_DIR [--previous DIR]
#                       OUT_DIR gets pool/ and dists/stable (Packages, .gz, .xz, Release, by-hash copies) and pool.json; NOT signed.
#                       --previous: a checkout of the branch `apt`; the by-hash files of its Release stay one more generation.
#   apt-repo.sh sign    OUT_DIR FINGERPRINT       InRelease and Release.gpg (SHA512). GNUPGHOME holds the key; the passphrase comes from
#                       the environment variable APT_SIGNING_PASSPHRASE (loopback pinentry, fd 0), empty = a key without one.
#   apt-repo.sh verify  OUT_DIR KEYRING.gpg       gpgv of InRelease and Release.gpg (SHA512), every hash of Release, by-hash copies, Packages
#                       against the pool files. Exit 1 with one line per problem.
#   apt-repo.sh fingerprint KEYFILE               the fingerprint(s) of a key file (armoured or binary), one per line
#   apt-repo.sh genkey  GNUPGHOME UID PUBDIR      a THROW-AWAY key (RSA 4096, sign only, no passphrase, no expiry); public parts to PUBDIR
#   apt-repo.sh summary OUT_DIR KEYRING.gpg       Markdown for the job summary: fingerprint, Depends line, pool table
#   apt-repo.sh same    DIR_A DIR_B               exit 0 when both repositories have the same Packages and pool.json
#   apt-repo.sh publish-branch OUT_DIR REMOTE     commits dists/ and pool.json to the orphan branch `apt` of REMOTE when they changed, and
#                       pushes (token for a https remote: APT_GIT_TOKEN). Prints changed=true|false.
#   apt-repo.sh --selftest                        builds a repository from a dummy .deb with a throw-away key and checks every rule
set -uo pipefail

SUITE=stable
COMP=main
ARCH=amd64
PKG=hey-look
BRANCH=apt

die() { echo "::error::$*" >&2; exit 1; }
say() { echo "apt-repo: $*" >&2; }
need() { command -v "$1" > /dev/null 2>&1 || die "$1 is needed"; }

sha() { sha256sum "$1" | cut -d' ' -f1; }
size() { wc -c < "$1" | tr -d ' '; }
pool_path() { echo "pool/$COMP/${PKG:0:1}/$PKG/${PKG}_$1_${ARCH}.deb"; } # relative to the repository root
control() { # control FILE FIELD
  if command -v dpkg-deb > /dev/null 2>&1; then dpkg-deb -f "$1" "$2"; else
    # no dpkg-deb (a Windows shell): read the control file out of the ar archive
    ar p "$1" control.tar.xz 2> /dev/null | tar -xJO ./control 2> /dev/null | sed -n "s/^$2: //p" | head -1
  fi
}

# ---------------------------------------------------------------- fetch
cmd_fetch() {
  local repo="" keep=3 out="" oldpool="" require="" localdeb=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --repo) repo="$2"; shift 2 ;;
      --keep) keep="$2"; shift 2 ;;
      --out) out="$2"; shift 2 ;;
      --old-pool) oldpool="$2"; shift 2 ;;
      --require-version) require="$2"; shift 2 ;;
      --local-deb) localdeb="$2"; shift 2 ;;
      *) die "fetch: unknown option $1" ;;
    esac
  done
  [ -n "$repo" ] && [ -n "$out" ] || die "fetch: --repo and --out are needed"
  case "$keep" in '' | *[!0-9]* | 0) die "fetch: --keep must be a whole number >= 1" ;; esac
  need gh; need jq
  mkdir -p "$out"
  local rel="$out/.releases.json"
  gh api "repos/$repo/releases" --paginate --jq '.[] | select(.draft == false and .prerelease == false) | select(.tag_name | test("^v[0-9]+\\.[0-9]+\\.[0-9]+$")) | {version: (.tag_name | ltrimstr("v")), tag: .tag_name, assets: [.assets[] | {name, id, size, digest, url: .browser_download_url}]}' | jq -s . > "$rel" || die "could not list the releases of $repo"

  local localver=""
  if [ -n "$localdeb" ]; then
    [ -f "$localdeb" ] || die "fetch: $localdeb does not exist"
    localver=$(control "$localdeb" Version)
    [ -n "$localver" ] || die "fetch: $localdeb has no Version"
  fi

  # the newest versions first (sort -V); a release without the .deb asset is skipped with a warning
  local versions v
  versions=$(jq -r '.[].version' "$rel" | sort -t. -k1,1nr -k2,2nr -k3,3nr)
  : > "$out/.chosen"
  local n=0
  if [ -n "$localver" ]; then echo "$localver" >> "$out/.chosen"; n=1; fi
  for v in $versions; do
    [ "$n" -ge "$keep" ] && break
    if [ -n "$localver" ]; then
      # the dry run's own .deb stands for its version; a release of the same or a newer version is not part of this repository
      [ "$(printf '%s\n%s\n' "$v" "$localver" | sort -V | tail -1)" = "$localver" ] || continue
      [ "$v" != "$localver" ] || continue
    fi
    if [ "$(jq -r --arg v "$v" --arg a "HeyLook_${v}_linux_amd64.deb" '[.[] | select(.version == $v) | .assets[] | select(.name == $a)] | length' "$rel")" != 1 ]; then
      echo "::warning::release v$v has no asset HeyLook_${v}_linux_amd64.deb: left out of the repository" >&2
      continue
    fi
    echo "$v" >> "$out/.chosen"
    n=$((n + 1))
  done
  if [ -n "$require" ] && ! grep -qx "$require" "$out/.chosen"; then
    die "version $require is not among the published releases with a .deb (the release must be published before this job)"
  fi
  [ -s "$out/.chosen" ] || die "no release with a .deb found"

  local pool="$out/pool.json"
  echo "[]" > "$pool"
  for v in $(cat "$out/.chosen"); do
    local file="$out/${PKG}_${v}_${ARCH}.deb" url="" digest=""
    if [ "$v" = "$localver" ]; then
      cp "$localdeb" "$file"
      url="local"
    else
      local a
      a=$(jq -c --arg v "$v" --arg n "HeyLook_${v}_linux_amd64.deb" '[.[] | select(.version == $v) | .assets[] | select(.name == $n)][0]' "$rel")
      url=$(jq -r .url <<< "$a")
      digest=$(jq -r '.digest // ""' <<< "$a")
      local id
      id=$(jq -r .id <<< "$a")
      gh api -H "Accept: application/octet-stream" "repos/$repo/releases/assets/$id" > "$file" || die "download of v$v failed"
      case "$digest" in
        sha256:*) [ "$(sha "$file")" = "${digest#sha256:}" ] || die "version $v: the sha256 of the download ($(sha "$file")) is not the digest of the GitHub asset ($digest)" ;;
        *) die "version $v: the GitHub asset has no sha256 digest" ;;
      esac
    fi
    local cv cp ca
    cv=$(control "$file" Version); cp=$(control "$file" Package); ca=$(control "$file" Architecture)
    [ "$cp" = "$PKG" ] && [ "$ca" = "$ARCH" ] || die "version $v: the .deb is package '$cp' for '$ca', expected $PKG/$ARCH"
    [ "$cv" = "$v" ] || die "version $v: the .deb says Version $cv"
    jq --arg v "$v" --arg f "$(pool_path "$v")" --arg u "$url" --arg s "$(sha "$file")" --argjson z "$(size "$file")" '. + [{version: $v, file: $f, url: $u, sha256: $s, size: $z}]' "$pool" > "$pool.new" && mv "$pool.new" "$pool"
  done
  if [ -n "$oldpool" ] && [ -f "$oldpool" ]; then check_pool "$oldpool" "$pool" || exit 1; fi
  rm -f "$out/.releases.json" "$out/.chosen"
  say "pool: $(jq -r '[.[].version] | join(", ")' "$pool")"
}

# A pool file never changes: a version of the old pool.json that is in the new one has the same sha256.
check_pool() {
  local old="$1" new="$2" bad=0 v o n
  for v in $(jq -r '.[].version' "$old"); do
    o=$(jq -r --arg v "$v" '.[] | select(.version == $v) | .sha256' "$old")
    n=$(jq -r --arg v "$v" '.[] | select(.version == $v) | .sha256' "$new")
    if [ -n "$n" ] && [ "$o" != "$n" ]; then
      echo "::error::version $v changed: the pool already holds a file with sha256 $o, now there is $n. A published .deb must never change." >&2
      bad=1
    fi
  done
  return $bad
}

# ---------------------------------------------------------------- build
rel_opts() {
  printf '%s\n' \
    -o "APT::FTPArchive::Release::Origin=Hey Look!" \
    -o "APT::FTPArchive::Release::Label=Hey Look!" \
    -o "APT::FTPArchive::Release::Suite=$SUITE" \
    -o "APT::FTPArchive::Release::Codename=$SUITE" \
    -o "APT::FTPArchive::Release::Architectures=$ARCH" \
    -o "APT::FTPArchive::Release::Components=$COMP" \
    -o "APT::FTPArchive::Release::Description=Hey Look! desktop mail client" \
    -o "APT::FTPArchive::Release::Acquire-By-Hash=yes"
}

cmd_build() {
  local debs="" out="" previous=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --previous) previous="$2"; shift 2 ;;
      *) if [ -z "$debs" ]; then debs="$1"; elif [ -z "$out" ]; then out="$1"; else die "build: too many arguments"; fi; shift ;;
    esac
  done
  [ -d "$debs" ] && [ -n "$out" ] || die "usage: apt-repo.sh build DEBS_DIR OUT_DIR [--previous DIR]"
  need apt-ftparchive; need xz; need jq
  [ ! -e "$out/dists" ] || die "build: $out/dists exists already (the repository is made from nothing)"
  local d="$out/dists/$SUITE" bin="$out/dists/$SUITE/$COMP/binary-$ARCH"
  mkdir -p "$bin" "$out/pool/$COMP/${PKG:0:1}/$PKG"
  local n=0 f v
  for f in "$debs"/*.deb; do
    [ -f "$f" ] || continue
    v=$(control "$f" Version)
    cp "$f" "$out/$(pool_path "$v")"
    n=$((n + 1))
  done
  [ "$n" -ge 1 ] || die "build: no .deb in $debs"
  [ ! -f "$debs/pool.json" ] || cp "$debs/pool.json" "$out/pool.json"

  (cd "$out" && apt-ftparchive packages "pool/$COMP" > "dists/$SUITE/$COMP/binary-$ARCH/Packages") || die "apt-ftparchive packages failed"
  gzip -9 -n -c "$bin/Packages" > "$bin/Packages.gz"
  xz -9e -c "$bin/Packages" > "$bin/Packages.xz"
  cat > "$bin/Release" << EOF
Archive: $SUITE
Origin: Hey Look!
Label: Hey Look!
Component: $COMP
Architecture: $ARCH
EOF
  local opts=()
  while IFS= read -r l; do opts+=("$l"); done < <(rel_opts)
  (cd "$out/dists" && apt-ftparchive "${opts[@]}" release "$SUITE" > "$SUITE/Release.new" && mv "$SUITE/Release.new" "$SUITE/Release") || die "apt-ftparchive release failed"

  # by-hash copies of the index files (a client reads them by the hash in Release: no "Hash Sum mismatch" while a cache is half old)
  local h
  mkdir -p "$bin/by-hash/SHA256"
  for f in Packages Packages.gz Packages.xz Release; do
    h=$(sha "$bin/$f")
    cp "$bin/$f" "$bin/by-hash/SHA256/$h"
  done
  # one more generation: the by-hash files named by the Release of the branch `apt` stay (a client with the old InRelease still finds them)
  if [ -n "$previous" ] && [ -f "$previous/dists/$SUITE/Release" ]; then
    local pbin="$previous/dists/$SUITE/$COMP/binary-$ARCH" ph
    for ph in $(release_hashes "$previous/dists/$SUITE/Release" | awk -v p="$COMP/binary-$ARCH/" 'index($3, p) == 1 && $3 !~ /by-hash/ {print $1}'); do
      [ -f "$pbin/by-hash/SHA256/$ph" ] && [ ! -e "$bin/by-hash/SHA256/$ph" ] && cp "$pbin/by-hash/SHA256/$ph" "$bin/by-hash/SHA256/$ph"
    done
  fi
  say "built $n package file(s): $(find "$out/pool" -name '*.deb' | wc -l | tr -d ' ') in the pool"
}

# the SHA256 lines of a Release: "<hash> <size> <path>"
release_hashes() {
  awk '/^SHA256:/ {on=1; next} /^[^ ]/ {on=0} on {print $1, $2, $3}' "$1"
}

# ---------------------------------------------------------------- sign
gpg_sign() { # gpg_sign ARGS...   (the passphrase is read from fd 0)
  printf '%s\n' "${APT_SIGNING_PASSPHRASE:-}" | gpg --batch --yes --pinentry-mode loopback --passphrase-fd 0 --digest-algo SHA512 "$@"
}

cmd_sign() {
  local out="${1:-}" fpr="${2:-}"
  [ -d "$out/dists/$SUITE" ] && [ -n "$fpr" ] || die "usage: apt-repo.sh sign OUT_DIR FINGERPRINT"
  need gpg
  local d="$out/dists/$SUITE"
  rm -f "$d/InRelease" "$d/Release.gpg"
  gpg_sign --local-user "$fpr!" --clearsign -o "$d/InRelease" "$d/Release" || die "signing InRelease failed (wrong passphrase or key?)"
  gpg_sign --local-user "$fpr!" --detach-sign --armor -o "$d/Release.gpg" "$d/Release" || die "signing Release.gpg failed"
  say "signed with $fpr"
}

# ---------------------------------------------------------------- verify
cmd_verify() {
  local out="${1:-}" keyring="${2:-}"
  [ -d "$out/dists/$SUITE" ] && [ -f "$keyring" ] || die "usage: apt-repo.sh verify OUT_DIR KEYRING.gpg"
  need gpgv
  local d="$out/dists/$SUITE" bad=0 st
  problem() { echo "problem: $*" >&2; bad=1; }
  # the signatures: made by the key of the keyring, digest SHA512 (hash algorithm 10)
  st=$(gpgv --status-fd 1 --keyring "$keyring" --output "$d/.Release.from-InRelease" "$d/InRelease" 2> /dev/null) || problem "InRelease: gpgv does not accept the signature"
  grep -q '^\[GNUPG:\] VALIDSIG ' <<< "$st" || problem "InRelease: no valid signature"
  [ "$(awk '/^\[GNUPG:\] VALIDSIG / {print $10}' <<< "$st" | head -1)" = 10 ] || problem "InRelease: the signature digest is not SHA512"
  cmp -s "$d/.Release.from-InRelease" "$d/Release" || problem "InRelease does not carry the text of Release"
  rm -f "$d/.Release.from-InRelease"
  st=$(gpgv --status-fd 1 --keyring "$keyring" "$d/Release.gpg" "$d/Release" 2> /dev/null) || problem "Release.gpg: gpgv does not accept the signature"
  [ "$(awk '/^\[GNUPG:\] VALIDSIG / {print $10}' <<< "$st" | head -1)" = 10 ] || problem "Release.gpg: the signature digest is not SHA512"
  # the fields
  local f
  for f in "Origin: Hey Look!" "Label: Hey Look!" "Suite: $SUITE" "Codename: $SUITE" "Architectures: $ARCH" "Components: $COMP" "Acquire-By-Hash: yes"; do
    grep -qx "$f" "$d/Release" || problem "Release has no line '$f'"
  done
  grep -q '^Date: ' "$d/Release" || problem "Release has no Date"
  ! grep -q '^Valid-Until:' "$d/Release" || problem "Release has Valid-Until (a repository that is not rebuilt would stop working for every user)"
  # every file of Release exists with its size and hash
  local h z p n=0
  while read -r h z p; do
    [ -n "$p" ] || continue
    n=$((n + 1))
    if [ ! -f "$d/$p" ]; then problem "Release lists $p, which does not exist"; continue; fi
    [ "$(size "$d/$p")" = "$z" ] || problem "$p: the size is not $z"
    [ "$(sha "$d/$p")" = "$h" ] || problem "$p: the sha256 is not the one of Release"
    case "$p" in
      "$COMP/binary-$ARCH/Packages" | "$COMP/binary-$ARCH/Packages.gz" | "$COMP/binary-$ARCH/Packages.xz" | "$COMP/binary-$ARCH/Release")
        [ -f "$d/$COMP/binary-$ARCH/by-hash/SHA256/$h" ] || problem "$p: no by-hash copy"
        ;;
    esac
  done < <(release_hashes "$d/Release")
  [ "$n" -ge 4 ] || problem "Release lists only $n file(s)"
  # Packages against the pool
  local pk="$d/$COMP/binary-$ARCH/Packages" files=0 fn ps pz
  while IFS='|' read -r fn ps pz; do
    files=$((files + 1))
    if [ ! -f "$out/$fn" ]; then problem "Packages names $fn, which is not in the repository"; continue; fi
    [ "$(sha "$out/$fn")" = "$ps" ] || problem "$fn: the sha256 is not the one of Packages"
    [ "$(size "$out/$fn")" = "$pz" ] || problem "$fn: the size is not $pz"
  done < <(awk -v RS= -F'\n' '{fn="";s="";z="";for(i=1;i<=NF;i++){if($i~/^Filename: /)fn=substr($i,11);if($i~/^SHA256: /)s=substr($i,9);if($i~/^Size: /)z=substr($i,7)} print fn "|" s "|" z}' "$pk")
  [ "$files" -ge 1 ] || problem "Packages lists no package"
  [ "$(grep -c '^Package: ' "$pk")" = "$files" ] || problem "Packages: a stanza without Filename"
  grep -v -x -e "Package: $PKG" -e '' "$pk" | grep -q '^Package: ' && problem "Packages names a package other than $PKG"
  local extra
  extra=$(cd "$out" && find pool -type f ! -name '*.deb' | head -3)
  [ -z "$extra" ] || problem "the pool holds something that is not a .deb: $extra"
  [ "$bad" = 0 ] && say "verified: $files package file(s), $n file(s) of Release" || return 1
}

# ---------------------------------------------------------------- keys
cmd_fingerprint() {
  need gpg
  gpg --show-keys --with-colons "$1" 2> /dev/null | awk -F: '/^pub/ {pub=1; next} /^fpr/ && pub {print $10; pub=0}'
}

cmd_genkey() {
  local home="${1:-}" uid="${2:-}" pub="${3:-}"
  [ -n "$home" ] && [ -n "$uid" ] && [ -n "$pub" ] || die "usage: apt-repo.sh genkey GNUPGHOME UID PUBDIR"
  need gpg
  mkdir -p "$home" "$pub"; chmod 700 "$home"
  export GNUPGHOME="$home"
  gpg --batch --pinentry-mode loopback --passphrase '' --quick-generate-key "$uid" rsa4096 sign never > /dev/null 2>&1 || die "could not make the throw-away key"
  local fpr
  fpr=$(gpg --list-keys --with-colons "$uid" | awk -F: '/^fpr/ {print $10; exit}')
  gpg --batch --armor --export "$fpr" 2> /dev/null > "$pub/heylook-archive-keyring.asc"
  gpg --batch --export "$fpr" 2> /dev/null > "$pub/heylook-archive-keyring.gpg"
  echo "$fpr"
}

# ---------------------------------------------------------------- summary, same, branch
cmd_summary() {
  local out="${1:-}" keyring="${2:-}"
  [ -d "$out/dists/$SUITE" ] || die "usage: apt-repo.sh summary OUT_DIR KEYRING.gpg"
  echo "### APT repository"
  echo
  if [ -f "$keyring" ]; then echo "Signing key fingerprint: \`$(cmd_fingerprint "$keyring" | head -1)\`"; echo; fi
  echo "| version | size | sha256 | Depends |"
  echo "|---|---:|---|---|"
  local f
  for f in "$out"/pool/"$COMP"/"${PKG:0:1}"/"$PKG"/*.deb; do
    [ -f "$f" ] || continue
    printf '| %s | %s | `%s` | `%s` |\n' "$(control "$f" Version)" "$(size "$f")" "$(sha "$f")" "$(control "$f" Depends)"
  done
}

cmd_same() {
  local a="$1" b="$2" p="dists/$SUITE/$COMP/binary-$ARCH/Packages"
  [ -f "$a/$p" ] && [ -f "$b/$p" ] || return 1
  cmp -s "$a/$p" "$b/$p" && { [ ! -f "$a/pool.json" ] || [ ! -f "$b/pool.json" ] || cmp -s "$a/pool.json" "$b/pool.json"; }
}

cmd_publish_branch() {
  local out="${1:-}" remote="${2:-}"
  [ -d "$out/dists/$SUITE" ] && [ -n "$remote" ] || die "usage: apt-repo.sh publish-branch OUT_DIR REMOTE"
  need git
  local work auth=()
  work=$(mktemp -d)
  if [ -n "${APT_GIT_TOKEN:-}" ]; then
    echo "::add-mask::$(printf 'x-access-token:%s' "$APT_GIT_TOKEN" | base64 | tr -d '\n')"
    auth=(-c "http.extraheader=AUTHORIZATION: basic $(printf 'x-access-token:%s' "$APT_GIT_TOKEN" | base64 | tr -d '\n')")
  fi
  local g=(git "${auth[@]}")
  if "${g[@]}" ls-remote --exit-code --heads "$remote" "$BRANCH" > /dev/null 2>&1; then
    "${g[@]}" clone --quiet --depth 1 --branch "$BRANCH" "$remote" "$work/co" || die "could not clone the branch $BRANCH"
  else
    git init --quiet "$work/co"
    git -C "$work/co" checkout --quiet --orphan "$BRANCH"
    say "the branch $BRANCH does not exist yet: it is created"
  fi
  if [ -f "$work/co/dists/$SUITE/$COMP/binary-$ARCH/Packages" ] && cmd_same "$work/co" "$out"; then
    echo "changed=false"
    say "Packages and pool.json are the same as on the branch $BRANCH: no commit"
    rm -rf "$work"
    return 0
  fi
  git -C "$work/co" rm -r -q --ignore-unmatch dists pool.json > /dev/null 2>&1
  rm -rf "$work/co/dists" "$work/co/pool.json"
  cp -a "$out/dists" "$work/co/dists"
  [ ! -f "$out/pool.json" ] || cp "$out/pool.json" "$work/co/pool.json"
  git -C "$work/co" add -A
  local vs
  vs=$(jq -r '[.[].version] | join(", ")' "$out/pool.json" 2> /dev/null || echo "?")
  git -C "$work/co" -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" commit --quiet -m "APT repository: $vs" || die "nothing to commit?"
  "${g[@]}" -C "$work/co" push --quiet "$remote" "HEAD:refs/heads/$BRANCH" || die "push to $BRANCH failed"
  echo "changed=true"
  say "pushed the branch $BRANCH ($vs)"
  rm -rf "$work"
}

# ---------------------------------------------------------------- selftest
selftest() {
  need apt-ftparchive; need gpg; need gpgv; need jq; need dpkg-deb; need git
  local fails=0
  t=$(mktemp -d) # (not local: the trap below runs after this function is gone)
  trap 'rm -rf "$t"' EXIT
  ok() { echo "ok    $1"; }
  nok() { echo "FAIL  $1"; fails=$((fails + 1)); }
  expect() { # expect NAME CMD... : passes when the command succeeds
    local name="$1"; shift
    if "$@" > "$t/last.out" 2>&1; then ok "$name"; else nok "$name"; sed 's/^/        /' "$t/last.out" | head -12; fi
  }
  expect_fail() { # expect_fail NAME PATTERN CMD... : the command fails and its output matches PATTERN
    local name="$1" pat="$2"; shift 2
    if "$@" > "$t/last.out" 2>&1; then nok "$name (it passed)"; elif grep -q -e "$pat" "$t/last.out"; then ok "$name"; else nok "$name (output has no '$pat')"; sed 's/^/        /' "$t/last.out" | head -12; fi
  }
  with_home() { local h="$1"; shift; ( export GNUPGHOME="$h"; "$@" ); } # a command with another keyring
  mkdeb() { # mkdeb DIR VERSION
    local root="$t/deb-$2"
    mkdir -p "$root/DEBIAN" "$root/usr/bin"
    printf '#!/bin/sh\necho hey look %s\n' "$2" > "$root/usr/bin/hey-look"; chmod 755 "$root/usr/bin/hey-look"
    printf 'Package: hey-look\nVersion: %s\nArchitecture: amd64\nMaintainer: Test <test@example.invalid>\nDepends: libc6, libayatana-appindicator3-1\nDescription: dummy\n' "$2" > "$root/DEBIAN/control"
    mkdir -p "$1"
    dpkg-deb --root-owner-group -b "$root" "$1/hey-look_$2_amd64.deb" > /dev/null
  }
  local fpr other
  fpr=$(cmd_genkey "$t/gh1" "Hey Look! APT test (throwaway)" "$t/pub1") || exit 1
  other=$(cmd_genkey "$t/gh2" "Somebody Else" "$t/pub2") || exit 1
  expect "genkey: two different keys" [ "$fpr" != "$other" ]
  expect "fingerprint reads the key file (armoured and binary)" [ "$(cmd_fingerprint "$t/pub1/heylook-archive-keyring.asc")" = "$fpr" -a "$(cmd_fingerprint "$t/pub1/heylook-archive-keyring.gpg")" = "$fpr" ]

  mkdeb "$t/debs" 1.0.5; mkdeb "$t/debs" 1.0.6
  echo '[{"version":"1.0.5","sha256":"aa"},{"version":"1.0.6","sha256":"bb"}]' > "$t/debs/pool.json"
  local out="$t/repo"
  expect "build" cmd_build "$t/debs" "$out"
  expect "the layout" bash -c "cd '$out' && [ -f dists/stable/main/binary-amd64/Packages ] && [ -f dists/stable/main/binary-amd64/Packages.gz ] && [ -f dists/stable/main/binary-amd64/Packages.xz ] && [ -f dists/stable/Release ] && [ -f pool/main/h/hey-look/hey-look_1.0.5_amd64.deb ] && [ -f pool/main/h/hey-look/hey-look_1.0.6_amd64.deb ] && [ -f pool.json ]"
  expect "by-hash copies of the three indexes" bash -c "[ \$(ls '$out'/dists/stable/main/binary-amd64/by-hash/SHA256 | wc -l) -ge 4 ]"
  expect "sign" with_home "$t/gh1" cmd_sign "$out" "$fpr"
  expect "verify passes" cmd_verify "$out" "$t/pub1/heylook-archive-keyring.gpg"
  expect "InRelease is clear-signed, Release.gpg is detached" bash -c "grep -q 'BEGIN PGP SIGNED MESSAGE' '$out/dists/stable/InRelease' && grep -q 'BEGIN PGP SIGNATURE' '$out/dists/stable/Release.gpg'"
  expect "Release has the fields, Acquire-By-Hash, no Valid-Until" bash -c "grep -qx 'Acquire-By-Hash: yes' '$out/dists/stable/Release' && grep -qx 'Origin: Hey Look!' '$out/dists/stable/Release' && ! grep -q Valid-Until '$out/dists/stable/Release'"
  expect_fail "verify with the key of somebody else fails" "does not accept the signature" cmd_verify "$out" "$t/pub2/heylook-archive-keyring.gpg"
  # tampering
  cp -a "$out" "$t/bad1"
  printf 'x' >> "$t/bad1/dists/stable/main/binary-amd64/Packages"
  expect_fail "a changed Packages byte is found" "Packages: the" cmd_verify "$t/bad1" "$t/pub1/heylook-archive-keyring.gpg"
  cp -a "$out" "$t/bad2"
  printf 'x' >> "$t/bad2/pool/main/h/hey-look/hey-look_1.0.6_amd64.deb"
  expect_fail "a changed .deb is found" "hey-look_1.0.6_amd64.deb: the" cmd_verify "$t/bad2" "$t/pub1/heylook-archive-keyring.gpg"
  cp -a "$out" "$t/bad3"
  sed -i 's/^Suite: stable/Suite: evil/' "$t/bad3/dists/stable/Release"
  expect_fail "a changed Release is found" "problem:" cmd_verify "$t/bad3" "$t/pub1/heylook-archive-keyring.gpg"
  # signed by another key
  cp -a "$out" "$t/bad4"
  with_home "$t/gh2" cmd_sign "$t/bad4" "$other" > /dev/null 2>&1
  expect_fail "a repository signed by another key fails against our keyring" "does not accept the signature" cmd_verify "$t/bad4" "$t/pub1/heylook-archive-keyring.gpg"
  # a passphrase
  local ph
  ph=$(cmd_genkey "$t/gh3" "Passphrase Test" "$t/pub3") || exit 1
  expect "a key without a passphrase signs with an empty one" with_home "$t/gh3" cmd_sign "$out" "$ph"
  with_home "$t/gh1" cmd_sign "$out" "$fpr" > /dev/null 2>&1
  expect "verify passes again after the key of the repository signed it" cmd_verify "$out" "$t/pub1/heylook-archive-keyring.gpg"

  # the pool never changes
  echo '[{"version":"1.0.5","sha256":"aa"},{"version":"1.0.6","sha256":"bb"}]' > "$t/old.json"
  echo '[{"version":"1.0.6","sha256":"bb"},{"version":"1.0.7","sha256":"cc"}]' > "$t/new-ok.json"
  echo '[{"version":"1.0.6","sha256":"FORGED"},{"version":"1.0.7","sha256":"cc"}]' > "$t/new-bad.json"
  expect "pool: the same sha256 passes, a new version passes, a dropped version passes" check_pool "$t/old.json" "$t/new-ok.json"
  expect_fail "pool: another file under an existing version fails and names the version" "version 1.0.6 changed" check_pool "$t/old.json" "$t/new-bad.json"

  # the branch: created, then no new commit for the same repository, then a commit for a changed one
  git init --quiet --bare "$t/remote.git"
  expect "publish-branch creates the orphan branch" bash -c "'$0' publish-branch '$out' '$t/remote.git' 2>/dev/null | grep -qx changed=true"
  expect "the branch holds dists and pool.json and no .deb" bash -c "git -C '$t/remote.git' ls-tree -r --name-only apt | grep -q '^dists/stable/InRelease\$' && git -C '$t/remote.git' ls-tree -r --name-only apt | grep -qx pool.json && ! git -C '$t/remote.git' ls-tree -r --name-only apt | grep -q '\\.deb\$'"
  local c1 c2
  c1=$(git -C "$t/remote.git" rev-parse apt)
  # the same repository built again (a new Date and a new signature) is not a change
  cp -a "$out" "$t/again"
  with_home "$t/gh1" cmd_sign "$t/again" "$fpr" > /dev/null 2>&1
  expect "publish-branch: the same Packages makes no commit" bash -c "'$0' publish-branch '$t/again' '$t/remote.git' 2>/dev/null | grep -qx changed=false"
  c2=$(git -C "$t/remote.git" rev-parse apt)
  expect "the branch head did not move" [ "$c1" = "$c2" ]
  mkdeb "$t/debs2" 1.0.6; mkdeb "$t/debs2" 1.0.7
  echo '[{"version":"1.0.6","sha256":"bb"},{"version":"1.0.7","sha256":"cc"}]' > "$t/debs2/pool.json"
  local out2="$t/repo2"
  cmd_build "$t/debs2" "$out2" --previous "$t/again" > /dev/null 2>&1
  with_home "$t/gh1" cmd_sign "$out2" "$fpr" > /dev/null 2>&1
  expect "a new version verifies" cmd_verify "$out2" "$t/pub1/heylook-archive-keyring.gpg"
  expect "the by-hash files of the previous generation stay one generation" bash -c "[ \$(ls '$out2'/dists/stable/main/binary-amd64/by-hash/SHA256 | wc -l) -gt \$(ls '$out'/dists/stable/main/binary-amd64/by-hash/SHA256 | wc -l) ]"
  expect "publish-branch: a changed Packages makes a commit" bash -c "'$0' publish-branch '$out2' '$t/remote.git' 2>/dev/null | grep -qx changed=true"
  expect "the branch moved" [ "$(git -C "$t/remote.git" rev-parse apt)" != "$c1" ]
  expect "the summary has the version and the Depends line" bash -c "'$0' summary '$out2' '$t/pub1/heylook-archive-keyring.gpg' | grep -q 'libayatana-appindicator3-1'"

  # THE SELFTEST IS HERMETIC: no network, no real gh, no token. A fake `gh` and a fake `curl` stand first in PATH for everything below (and a real
  # gh or GH_TOKEN of the machine, a CI runner has both, is never reached: GH_TOKEN is unset here and set only per case). Every call is logged in
  # $HL_NETLOG; the fake curl serves the release assets from local files, passes calls to this machine (127.0.0.1) to the real curl, and REFUSES
  # every other host (logged as BLOCKED, and the selftest fails if there is one). Before this, a case called the real GitHub API on a runner and got a 404.
  local bin="$t/bin" fk="$t/fake"
  mkdir -p "$bin"
  local real_curl
  real_curl=$(command -v curl || true)
  export HL_NETLOG="$t/netlog" REAL_CURL="$real_curl"
  : > "$HL_NETLOG"
  cat > "$bin/gh" << 'GH'
#!/usr/bin/env bash
# a fake gh: `gh api repos/X/releases --paginate --jq FILTER`, `gh api -H ... repos/X/releases/assets/ID` and `gh api repos/X/releases/tags/vV --jq FILTER`
echo "gh $*" >> "$HL_NETLOG"
args=("$@"); path=""
for a in "${args[@]}"; do case "$a" in repos/*) path="$a" ;; esac; done
case "$path" in
  */releases/assets/*) cat "$FAKE/asset-${path##*/}"; exit 0 ;;
  */releases/tags/*)
    # the release of one tag, as the live check asks for the digest of an asset; FAKE_GH_MODE says what GitHub answers
    case "${FAKE_GH_MODE:-404}" in
      ok) printf 'sha256:%s\n' "$FAKE_GH_DIGEST"; exit 0 ;;
      wrong) printf 'sha256:%064d\n' 0; exit 0 ;;
      empty) exit 0 ;;
      json) printf '{"message":"Not Found","status":"404"}\n'; exit 0 ;;
      *) # what the real gh does on a 404: the JSON body on stdout, the error on stderr, exit 1
        printf '{"message":"Not Found","documentation_url":"https://docs.github.com/rest/releases/releases#get-a-release-by-tag-name","status":"404"}\n'
        echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
    esac ;;
esac
filter=""
for i in "${!args[@]}"; do [ "${args[$i]}" = "--jq" ] && filter="${args[$((i + 1))]}"; done
jq -c "$filter" "$FAKE/releases.json"
GH
  chmod +x "$bin/gh"
  cat > "$bin/curl" << 'CURL'
#!/usr/bin/env bash
# a fake curl: the release assets of apt-assemble.sh come from local files ($ASSETS); this machine goes to the real curl; nothing else is allowed
out=""; url=""
args=("$@")
for i in "${!args[@]}"; do [ "${args[$i]}" = "-o" ] && out="${args[$((i + 1))]}"; case "${args[$i]}" in http*://*) url="${args[$i]}" ;; esac; done
case "$url" in
  https://github.com/thnonl/hey-look/releases/download/v*/HeyLook_*_linux_amd64.deb)
    echo "curl asset $url" >> "$HL_NETLOG"
    v="${url##*/HeyLook_}"; v="${v%%_linux_amd64.deb}"
    cp "$ASSETS/hey-look_${v}_amd64.deb" "$out" ;;
  http://127.0.0.1:* | http://localhost:*) exec "$REAL_CURL" "$@" ;;
  *) echo "curl BLOCKED $url" >> "$HL_NETLOG"; echo "the selftest is hermetic: no request to $url" >&2; exit 7 ;;
esac
CURL
  chmod +x "$bin/curl"
  unset GH_TOKEN GITHUB_TOKEN
  export PATH="$bin:$PATH"
  # fetch, with the fake gh: which releases are chosen, the digest check, the pool rule
  # fakerel DIR VERSION DRAFT PRERELEASE WITHDEB [corrupt]: adds a release to the fake GitHub in DIR
  fakerel() {
    local dir="$1" ver="$2" assets="[]" f d id
    mkdir -p "$dir"
    [ -f "$dir/releases.json" ] || echo "[]" > "$dir/releases.json"
    if [ "$5" = yes ]; then
      mkdeb "$dir/deb-$ver" "$ver"
      f="$dir/deb-$ver/hey-look_${ver}_amd64.deb"
      id=$(( $(ls "$dir" | grep -c '^asset-') + 101 ))
      cp "$f" "$dir/asset-$id"
      d=$(sha "$f")
      [ "${6:-}" = corrupt ] && d="0000000000000000000000000000000000000000000000000000000000000000"
      assets=$(jq -n --arg n "HeyLook_${ver}_linux_amd64.deb" --argjson id "$id" --arg d "sha256:$d" --arg u "https://github.com/thnonl/hey-look/releases/download/v$ver/HeyLook_${ver}_linux_amd64.deb" '[{name: $n, id: $id, size: 1, digest: $d, browser_download_url: $u}]')
    fi
    jq --arg t "v$ver" --argjson dr "$3" --argjson pr "$4" --argjson a "$assets" '. + [{tag_name: $t, draft: $dr, prerelease: $pr, assets: $a}]' "$dir/releases.json" > "$dir/r.new" && mv "$dir/r.new" "$dir/releases.json"
  }
  fakerel "$fk" 1.0.2 false false no      # a release made by hand without the .deb: left out with a warning
  fakerel "$fk" 1.0.4 false false yes
  fakerel "$fk" 1.0.5 false false yes
  fakerel "$fk" 1.0.6 false false yes
  fakerel "$fk" 1.0.7 true false yes      # a draft: not published
  fakerel "$fk" 1.0.8 false true yes      # a pre-release: not part of the repository
  fakerel "$fk" 1.0.10 false false yes    # (1.0.10 is newer than 1.0.6: versions are compared as numbers)
  fetch_with_fake() { ( export PATH="$bin:$PATH" FAKE="${FAKEDIR:-$fk}"; cmd_fetch --repo thnonl/hey-look "$@" ); }
  fetch_list() { # fetch_list OUTDIR WANTED_VERSIONS ARGS...
    local o="$1" want="$2"; shift 2
    fetch_with_fake --out "$o" "$@" > /dev/null 2>&1 || return 1
    [ "$(jq -r '[.[].version] | join(",")' "$o/pool.json")" = "$want" ]
  }
  expect "fetch: the newest 3 published releases (1.0.10, 1.0.6, 1.0.5; no draft, no pre-release, none without the .deb)" fetch_list "$t/f1" 1.0.10,1.0.6,1.0.5 --keep 3
  expect "fetch: --keep 1" fetch_list "$t/f1b" 1.0.10 --keep 1
  expect "fetch: --require-version of a version that is there passes" fetch_with_fake --keep 3 --out "$t/f2" --require-version 1.0.6
  expect_fail "fetch: --require-version of a version that is not published fails" "is not among the published releases" fetch_with_fake --keep 1 --out "$t/f3" --require-version 1.0.6
  expect "fetch: pool.json has file, url, sha256 and size of each" jq -e 'all(.[]; (.file | startswith("pool/main/h/hey-look/hey-look_")) and (.url | startswith("https://github.com/thnonl/hey-look/releases/download/v")) and (.sha256 | length == 64) and .size > 0)' "$t/f2/pool.json"
  # the dry run: its own .deb stands for its version; releases of that version or newer are left out
  mkdeb "$t/mine" 1.0.7
  expect "fetch --local-deb: this run's 1.0.7 and the two newest releases below it" fetch_list "$t/f4" 1.0.7,1.0.6,1.0.5 --keep 3 --local-deb "$t/mine/hey-look_1.0.7_amd64.deb"
  expect "fetch --local-deb: the local file is marked local" test "$(jq -r '.[0].url' "$t/f4/pool.json")" = local
  # a download that is not what GitHub says it is
  fakerel "$t/fake-bad" 1.0.9 false false yes corrupt
  FAKEDIR="$t/fake-bad" expect_fail "fetch: a download whose sha256 is not the digest of the asset fails" "version 1.0.9: the sha256" fetch_with_fake --keep 3 --out "$t/f5"
  # the pool never changes
  echo '[{"version":"1.0.5","sha256":"aaaa"},{"version":"1.0.6","sha256":"bbbb"}]' > "$t/oldpool.json"
  expect_fail "fetch: a version whose file is not the one of the old pool.json fails and names the version" "version 1.0.5 changed" fetch_with_fake --keep 3 --out "$t/f6" --old-pool "$t/oldpool.json"

  # the site: apt-assemble.sh (pages.yml) and apt-live-check.sh, with a fake curl that "downloads" the release assets from local files
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  assemble() { mkdir -p "$1"; ( export PATH="$bin:$PATH" ASSETS="${ASSETS_DIR:-$t/f2}"; bash "$here/apt-assemble.sh" "$@" ); }
  cmd_build "$t/f2" "$t/arepo" > /dev/null 2>&1
  with_home "$t/gh1" cmd_sign "$t/arepo" "$fpr" > /dev/null 2>&1
  mkdir -p "$t/branch" "$t/site/apt"
  cp -a "$t/arepo/dists" "$t/branch/dists"; cp "$t/arepo/pool.json" "$t/branch/pool.json"
  expect "assemble: dists, pool.json and the downloaded .deb files go into the site; version and InRelease hash are printed" bash -c "
    out=\$(PATH='$bin':\$PATH ASSETS='$t/f2' bash '$here/apt-assemble.sh' '$t/site' '$t/branch' '$t/pub1/heylook-archive-keyring.gpg' 2>/dev/null) &&
    grep -qx 'version=1.0.10' <<< \"\$out\" && grep -qx \"inrelease_sha256=\$(sha256sum '$t/branch/dists/stable/InRelease' | cut -d' ' -f1)\" <<< \"\$out\" &&
    [ -f '$t/site/apt/pool/main/h/hey-look/hey-look_1.0.6_amd64.deb' ] && [ -f '$t/site/apt/dists/stable/InRelease' ] && [ -f '$t/site/apt/pool.json' ]"
  # a release asset that is not the file of pool.json
  mkdir -p "$t/assets-bad"; cp "$t/f2"/hey-look_*.deb "$t/assets-bad/"; printf 'x' >> "$t/assets-bad/hey-look_1.0.6_amd64.deb"
  ASSETS_DIR="$t/assets-bad" expect_fail "assemble: a download that differs from pool.json stops the site" "hey-look_1.0.6_amd64.deb: the download from the release has sha256" assemble "$t/site-bad1" "$t/branch" "$t/pub1/heylook-archive-keyring.gpg"
  # a branch whose Packages was changed without a new signature, and one signed by another key
  cp -a "$t/branch" "$t/branch-bad"; printf 'x' >> "$t/branch-bad/dists/stable/main/binary-amd64/Packages"
  expect_fail "assemble: a changed Packages on the branch stops the site" "does not verify" assemble "$t/site-bad2" "$t/branch-bad" "$t/pub1/heylook-archive-keyring.gpg"
  expect_fail "assemble: a repository that the committed key did not sign stops the site" "does not verify" assemble "$t/site-bad3" "$t/branch" "$t/pub2/heylook-archive-keyring.gpg"
  expect_fail "assemble: a pool.json that points outside the releases stops the site" "not a release asset" bash -c "
    mkdir -p '$t/branch-url' '$t/site-bad4' && cp -a '$t/branch/.' '$t/branch-url/' && sed -i 's#https://github.com/thnonl#https://example.org/thnonl#' '$t/branch-url/pool.json' &&
    PATH='$bin':\$PATH ASSETS='$t/f2' bash '$here/apt-assemble.sh' '$t/site-bad4' '$t/branch-url' '$t/pub1/heylook-archive-keyring.gpg'"
  if command -v python3 > /dev/null && command -v curl > /dev/null; then
    cp "$t/pub1/heylook-archive-keyring.gpg" "$t/site/apt/"
    ( cd "$t/site" && python3 -m http.server 18799 --bind 127.0.0.1 > /dev/null 2>&1 & echo $! > "$t/http.pid" )
    sleep 1
    local want_sha
    want_sha=$(sha256sum "$t/site/apt/dists/stable/InRelease" | cut -d' ' -f1)
    expect "live check: the served files are right (200, no Location, no Content-Encoding, the sizes, the hashes)" env APT_SKIP_HTTP_REDIRECT=1 APT_WAIT=5 bash "$here/apt-live-check.sh" "$want_sha" http://127.0.0.1:18799
    expect_fail "live check: another InRelease than the deployed one is waited for and then fails" "is not the deployed one" env APT_SKIP_HTTP_REDIRECT=1 APT_WAIT=1 bash "$here/apt-live-check.sh" 0000000000000000000000000000000000000000000000000000000000000000 http://127.0.0.1:18799
    # the digest of the GitHub release asset: only the answer sha256:<64 hex> counts, an error is an error (never compared as a digest)
    local live_sha
    live_sha=$(sha256sum "$t/site/apt/pool/main/h/hey-look/hey-look_1.0.10_amd64.deb" | cut -d' ' -f1)
    : > "$HL_NETLOG"
    expect "live check: the digest GitHub gives for the release asset is the sha256 of the served .deb" env GH_TOKEN=selftest-token FAKE_GH_MODE=ok FAKE_GH_DIGEST="$live_sha" APT_SKIP_HTTP_REDIRECT=1 APT_WAIT=5 bash "$here/apt-live-check.sh" "$want_sha" http://127.0.0.1:18799
    expect "live check: that call went to the fake gh (releases/tags/v1.0.10), nowhere else" grep -q 'gh api repos/thnonl/hey-look/releases/tags/v1.0.10' "$HL_NETLOG"
    expect_fail "live check: another digest than the served file's fails" "is not the sha256 of the served file" env GH_TOKEN=selftest-token FAKE_GH_MODE=wrong APT_SKIP_HTTP_REDIRECT=1 APT_WAIT=5 bash "$here/apt-live-check.sh" "$want_sha" http://127.0.0.1:18799
    expect_fail "live check: a 404 of the GitHub API (JSON body, exit 1) is an error that names the version" "could not read the release digest for 1.0.10 (HTTP/gh error" env GH_TOKEN=selftest-token FAKE_GH_MODE=404 APT_SKIP_HTTP_REDIRECT=1 APT_WAIT=5 bash "$here/apt-live-check.sh" "$want_sha" http://127.0.0.1:18799
    expect_fail "live check: an error body with exit 0 is an error, not a digest" "could not read the release digest for 1.0.10" env GH_TOKEN=selftest-token FAKE_GH_MODE=json APT_SKIP_HTTP_REDIRECT=1 APT_WAIT=5 bash "$here/apt-live-check.sh" "$want_sha" http://127.0.0.1:18799
    expect_fail "live check: an empty answer is an error, not a missing digest to be ignored" "could not read the release digest for 1.0.10" env GH_TOKEN=selftest-token FAKE_GH_MODE=empty APT_SKIP_HTTP_REDIRECT=1 APT_WAIT=5 bash "$here/apt-live-check.sh" "$want_sha" http://127.0.0.1:18799
    : > "$HL_NETLOG"
    expect "live check: without GH_TOKEN the digest is not compared and gh is not called" bash -c "env -u GH_TOKEN -u GITHUB_TOKEN APT_SKIP_HTTP_REDIRECT=1 APT_WAIT=5 bash '$here/apt-live-check.sh' '$want_sha' http://127.0.0.1:18799 | grep -q 'not compared' && ! grep -q '^gh ' '$HL_NETLOG'"
    printf 'x' >> "$t/site/apt/pool/main/h/hey-look/hey-look_1.0.10_amd64.deb"
    expect_fail "live check: a .deb that is not the one of Packages fails" "Content-Length" env APT_SKIP_HTTP_REDIRECT=1 APT_WAIT=5 bash "$here/apt-live-check.sh" "$want_sha" http://127.0.0.1:18799
    kill "$(cat "$t/http.pid")" 2> /dev/null
  else
    echo "note  live check not tried (python3 or curl is missing)"
  fi

  expect "hermetic: no request went anywhere but to this machine and the fake gh" bash -c "! grep -q BLOCKED '$HL_NETLOG'"
  if [ "$fails" = 0 ]; then echo "apt-repo selftest: all cases passed"; return 0; fi
  echo "apt-repo selftest: $fails case(s) failed"
  return 1
}

main() {
  local c="${1:-}"
  [ $# -eq 0 ] || shift
  case "$c" in
    fetch) cmd_fetch "$@" ;;
    build) cmd_build "$@" ;;
    sign) cmd_sign "$@" ;;
    verify) cmd_verify "$@" ;;
    fingerprint) cmd_fingerprint "$@" ;;
    genkey) cmd_genkey "$@" ;;
    summary) cmd_summary "$@" ;;
    same) cmd_same "$@" ;;
    publish-branch) cmd_publish_branch "$@" ;;
    --selftest) selftest ;;
    *) sed -n '2,32p' "$0"; exit 2 ;;
  esac
}
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
