#!/usr/bin/env bash
# Install tests of the APT repository in containers (WP15 spec 15.6): what a Debian or Ubuntu user does, on ubuntu:22.04, ubuntu:24.04 and
# debian:12 (pinned by digest). Needs docker, python3 (a small web server on the host) and, for `local`, apt-repo.sh next to this file.
#
#   apt-install-test.sh local --repo DIR --keyring KEYRING.gpg --sources heylook.sources --version V [--previous V0]
#       DIR is a repository made and signed by apt-repo.sh (dists/, pool/). It is served over http on this machine; the containers run the
#       three commands of the download page with only the host part of the address replaced:
#         sudo wget -qO /etc/apt/keyrings/heylook-archive-keyring.gpg <base>/apt/heylook-archive-keyring.gpg
#         sudo wget -qO /etc/apt/sources.list.d/heylook.sources <base>/apt/heylook.sources
#         sudo apt update && sudo apt install hey-look
#       then: the version, /usr/bin/hey-look, no missing library, the upgrade from --previous (Ubuntu only: an old .deb names the old tray
#       library, which Debian 12 does not have), the remove command and a clean `apt update` after it, and two negative tests: a repository
#       with one changed byte in its index, and one signed by another key, must make `apt update` fail (a hash or size mismatch, NO_PUBKEY).
#   apt-install-test.sh live --version V [--base https://heylook.namthai.site]
#       the same user commands against the live https address in an ubuntu:24.04 container (pages.yml, after a deploy).
# Environment (to run it somewhere else than a Linux runner, for example Docker Desktop on Windows):
#   APT_TEST_HOST (127.0.0.1)  address of this machine as the container sees it (host.docker.internal on Docker Desktop)
#   APT_TEST_BIND (127.0.0.1)  address the web server listens on (0.0.0.0 on Docker Desktop)
#   APT_TEST_DOCKER_ARGS (--network host)  extra arguments of docker run (empty on Docker Desktop)
#   APT_TEST_PORT (18650)      first of three ports
#   APT_TEST_IMAGES            "name=image ..." instead of the three pinned images
#   APT_TEST_KEEP=1            keep the temporary folder with the three served trees
#   PYTHON (python3)
# Exit 0 only when every image passed.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Pinned by digest (the tag stays for the reader). Move them from time to time: docker buildx imagetools inspect <tag> --format '{{.Manifest.Digest}}'
IMG_U22='ubuntu:22.04@sha256:0a9887931b0e38af2e3487ed39e29436b0535c4f3f52e57745baaf79d1898956'
IMG_U24='ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac'
IMG_D12='debian:12@sha256:854dd8ab51d62866dbd8f5431d15ce77b12983a2a4a1e1fe43a2395dc7ef9f61'
images="${APT_TEST_IMAGES:-ubuntu-22.04=$IMG_U22 ubuntu-24.04=$IMG_U24 debian-12=$IMG_D12}"
host="${APT_TEST_HOST:-127.0.0.1}"
bind="${APT_TEST_BIND:-127.0.0.1}"
dargs="${APT_TEST_DOCKER_ARGS---network host}"
port0="${APT_TEST_PORT:-18650}"
py="${PYTHON:-python3}"
SITE=https://heylook.namthai.site

die() { echo "::error::$*" >&2; exit 1; }
native() { if command -v cygpath > /dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }

# The script that runs inside each container. Variables: NAME BASE VERSION PREVIOUS UPGRADE BAD1 BAD2 (BAD* empty = no negative tests) LIVE
inner() {
  cat << 'INNER'
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive APT_LISTCHANGES_FRONTEND=none
fail() { echo "FAIL [$NAME]: $*"; exit 1; }
step() { echo "--- [$NAME] $*"; }
KEY=/etc/apt/keyrings/heylook-archive-keyring.gpg
SRC=/etc/apt/sources.list.d/heylook.sources

step "test setup (not a step of the user): wget and ca-certificates"
apt-get update -qq > /tmp/setup.log 2>&1 && apt-get install -y -qq wget ca-certificates > /tmp/setup.log 2>&1 || { tail -20 /tmp/setup.log; fail "could not install wget"; }

# the container is root and has no sudo; apt asks nothing
sudo() { "$@"; }
apt() { command apt -y "$@"; }

# `apt-get update` must say nothing about our repository except that it fetched it, and no error at all
clean_update() { # clean_update LOGFILE
  apt-get update > "$1" 2>&1
  local rc=$?
  [ "$rc" = 0 ] || { cat "$1"; fail "apt update exit code $rc"; }
  if grep -E '^E:' "$1"; then cat "$1"; fail "apt update printed an error"; fi
  if grep -E '^W:' "$1" | grep -i -E "heylook|$HOSTPAT"; then cat "$1"; fail "apt update printed a warning about the repository"; fi
}
HOSTPAT=$(printf '%s' "$BASE" | sed -e 's#^[a-z]*://##' -e 's#[^A-Za-z0-9.:-]#.#g')

step "the commands of the download page"
[ -d /etc/apt/keyrings ] || fail "/etc/apt/keyrings does not exist on this system: the first command of the page needs 'sudo install -d -m 0755 /etc/apt/keyrings' before it"
sudo wget -qO "$KEY" "$BASE/apt/heylook-archive-keyring.gpg" || fail "wget of the key"
sudo wget -qO "$SRC" "$BASE/apt/heylook.sources" || fail "wget of heylook.sources"
cat "$SRC"
sudo apt update > /tmp/update1.log 2>&1 || { cat /tmp/update1.log; fail "sudo apt update"; }
cat /tmp/update1.log
if grep -E '^E:' /tmp/update1.log; then fail "apt update printed an error"; fi
if grep -E '^W:' /tmp/update1.log | grep -i -E "heylook|$HOSTPAT"; then fail "apt update printed a warning about the repository"; fi
grep -q "$HOSTPAT" /tmp/update1.log || fail "apt update did not fetch from $BASE"
cand=$(apt-cache policy hey-look | sed -n 's/^  Candidate: //p')
[ "$cand" = "$VERSION" ] || { apt-cache policy hey-look; fail "the candidate of hey-look is '$cand', expected $VERSION"; }
policy=$(apt-cache policy hey-look)
grep -q "$HOSTPAT/apt stable/main" <<< "$policy" || { echo "$policy"; fail "hey-look does not come from $BASE/apt stable/main"; }

if [ -n "$PREVIOUS" ] && [ "$UPGRADE" = yes ]; then
  step "install the previous version $PREVIOUS, then upgrade"
  sudo apt install "hey-look=$PREVIOUS" > /tmp/install0.log 2>&1 || { tail -30 /tmp/install0.log; fail "install of hey-look=$PREVIOUS"; }
  [ "$(dpkg-query -W -f='${Version}' hey-look)" = "$PREVIOUS" ] || fail "the installed version is not $PREVIOUS"
fi
step "sudo apt install hey-look"
sudo apt install hey-look > /tmp/install.log 2>&1 || { tail -30 /tmp/install.log; fail "sudo apt install hey-look"; }
tail -3 /tmp/install.log
got=$(dpkg-query -W -f='${Version}' hey-look)
[ "$got" = "$VERSION" ] || fail "dpkg says version '$got', expected $VERSION"
status=$(dpkg -s hey-look)
grep -E '^(Status|Version|Depends):' <<< "$status"
[ -x /usr/bin/hey-look ] || fail "/usr/bin/hey-look is missing"
if ldd /usr/bin/hey-look | grep 'not found'; then fail "hey-look has a library that is not installed"; fi
case "$NAME" in
  debian-*) grep -q '^Depends:.*libayatana-appindicator3-1' <<< "$status" || fail "on Debian 12 the .deb must depend on libayatana-appindicator3-1" ;;
esac

if [ "$LIVE" = 1 ]; then
  echo "OK [$NAME] (live)"
  exit 0
fi

step "remove: the command of the download page"
sudo apt remove hey-look > /tmp/remove.log 2>&1 || { tail -20 /tmp/remove.log; fail "apt remove"; }
sudo rm "$SRC" "$KEY" || fail "rm of the source and the key"
if dpkg-query -W -f='${db:Status-Abbrev}' hey-look 2> /dev/null | grep -q '^ii'; then fail "hey-look is still installed after apt remove"; fi
clean_update /tmp/update2.log
grep -i heylook /tmp/update2.log && fail "apt update still names the repository after the remove command"

negative() { # negative LABEL BASE PATTERN
  step "negative test: $1"
  local b="$2" hp
  hp=$(printf '%s' "$b" | sed -e 's#^[a-z]*://##')
  wget -qO "$KEY" "$BASE/apt/heylook-archive-keyring.gpg" || fail "wget of the key ($1)"
  wget -qO "$SRC" "$b/apt/heylook.sources" || fail "wget of heylook.sources ($1)"
  if apt-get update > /tmp/neg.log 2>&1; then cat /tmp/neg.log; fail "apt update accepted the repository: $1"; fi
  grep -q -E "$3" /tmp/neg.log || { cat /tmp/neg.log; fail "apt update failed but not with '$3': $1"; }
  if apt-get install -y hey-look > /tmp/neg2.log 2>&1; then fail "hey-look was installed from a repository that must be refused: $1"; fi
  echo "refused as expected: $(grep -m1 -E "$3" /tmp/neg.log)"
  rm -f "$SRC" "$KEY"
  apt-get update > /dev/null 2>&1
}
if [ -n "$BAD1" ]; then negative "a changed byte in the index" "$BAD1" "Hash Sum mismatch|File has unexpected size"; fi
if [ -n "$BAD2" ]; then negative "signed by another key" "$BAD2" "NO_PUBKEY"; fi
echo "OK [$NAME]"
INNER
}

# one container
run_container() { # run_container NAME IMAGE LOG ENV...
  local name="$1" image="$2" log="$3"
  shift 3
  local upgrade=no
  case "$name" in ubuntu-*) upgrade=yes ;; esac
  # shellcheck disable=SC2086
  inner | docker run --rm -i $dargs -e "NAME=$name" -e "UPGRADE=$upgrade" "$@" "$image" bash -c 'cat > /tmp/t.sh && exec bash /tmp/t.sh < /dev/null' > "$log" 2>&1
}

run_all() { # run_all NAMEFILTER ENV...   runs the images in parallel, prints their logs, returns 1 when one failed
  local filter="$1"
  shift
  local pids=() names=() logs=() pair name image log
  for pair in $images; do
    name="${pair%%=*}"; image="${pair#*=}"
    case "$filter" in all) ;; *) [ "$name" = "$filter" ] || continue ;; esac
    log=$(mktemp)
    run_container "$name" "$image" "$log" "$@" &
    pids+=($!); names+=("$name"); logs+=("$log")
  done
  [ "${#pids[@]}" -ge 1 ] || die "no image to test"
  local i bad=0
  for i in "${!pids[@]}"; do
    if wait "${pids[$i]}"; then
      echo "::group::${names[$i]}: passed"; cat "${logs[$i]}"; echo "::endgroup::"
    else
      bad=1
      echo "::group::${names[$i]}: FAILED"; cat "${logs[$i]}"; echo "::endgroup::"
      echo "::error::install test failed on ${names[$i]}: $(grep -m1 '^FAIL' "${logs[$i]}" || tail -1 "${logs[$i]}")"
    fi
    rm -f "${logs[$i]}"
  done
  return $bad
}

mode="${1:-}"
[ $# -eq 0 ] || shift
case "$mode" in
  live)
    version="" base="$SITE"
    while [ $# -gt 0 ]; do
      case "$1" in --version) version="$2"; shift 2 ;; --base) base="$2"; shift 2 ;; *) die "unknown option $1" ;; esac
    done
    [ -n "$version" ] || die "live: --version is needed"
    run_all ubuntu-24.04 -e "BASE=$base" -e "VERSION=$version" -e "PREVIOUS=" -e "BAD1=" -e "BAD2=" -e "LIVE=1"
    ;;
  local)
    repo="" keyring="" sources="" version="" previous=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --repo) repo="$2"; shift 2 ;;
        --keyring) keyring="$2"; shift 2 ;;
        --sources) sources="$2"; shift 2 ;;
        --version) version="$2"; shift 2 ;;
        --previous) previous="$2"; shift 2 ;;
        *) die "unknown option $1" ;;
      esac
    done
    [ -d "$repo/dists/stable" ] && [ -f "$keyring" ] && [ -f "$sources" ] && [ -n "$version" ] || die "usage: apt-install-test.sh local --repo DIR --keyring FILE --sources FILE --version V [--previous V0]"
    command -v docker > /dev/null || die "docker is needed"
    command -v "$py" > /dev/null || py=python
    command -v "$py" > /dev/null || die "python3 is needed"
    work=$(mktemp -d)
    servers=()
    # (APT_TEST_KEEP=1 leaves the temporary trees in place, for a look at them)
    cleanup() { local p; for p in "${servers[@]}"; do kill "$p" 2> /dev/null; done; if [ "${APT_TEST_KEEP:-0}" = 1 ]; then echo "kept: $work"; else rm -rf "$work"; fi; }
    trap cleanup EXIT

    # the three trees: good, one byte changed in the index, signed by another key
    for t in good bad1 bad2; do
      mkdir -p "$work/$t/apt"
      cp -a "$repo/." "$work/$t/apt/"
      cp "$keyring" "$work/$t/apt/heylook-archive-keyring.gpg"
    done
    for f in "$work"/bad1/apt/dists/stable/main/binary-amd64/Packages* "$work"/bad1/apt/dists/stable/main/binary-amd64/by-hash/SHA256/*; do
      case "$f" in */Release) continue ;; esac
      printf 'x' >> "$f"
    done
    # (the by-hash copy of the architecture Release is left alone; apt takes the Packages file)
    other=$(bash "$here/apt-repo.sh" genkey "$work/gh-other" "Somebody Else (test)" "$work/pub-other") || die "could not make the second throw-away key"
    GNUPGHOME="$work/gh-other" bash "$here/apt-repo.sh" sign "$work/bad2/apt" "$other" > /dev/null || die "could not sign the third tree"

    base_of() { echo "http://$host:$((port0 + $1))"; }
    n=0
    for t in good bad1 bad2; do
      b=$(base_of $n)
      # heylook.sources is the file of the site, with only the address replaced
      sed "s#^URIs: $SITE/apt\$#URIs: $b/apt#" "$sources" > "$work/$t/apt/heylook.sources"
      changed=$(diff "$sources" "$work/$t/apt/heylook.sources" | grep -c '^<')
      [ "$changed" = 1 ] || die "heylook.sources: expected exactly the URIs line to change, $changed lines differ (is the address $SITE/apt in the file?)"
      "$py" -m http.server "$((port0 + n))" --bind "$bind" --directory "$(native "$work/$t")" > "$work/server-$t.log" 2>&1 &
      servers+=($!)
      n=$((n + 1))
    done
    # wait for the three servers
    for n in 0 1 2; do
      for i in $(seq 1 50); do
        curl -fsS -o /dev/null "http://127.0.0.1:$((port0 + n))/apt/dists/stable/InRelease" 2> /dev/null && break
        sleep 0.2
      done
      curl -fsS -o /dev/null "http://127.0.0.1:$((port0 + n))/apt/dists/stable/InRelease" 2> /dev/null || die "the test web server on port $((port0 + n)) does not answer"
    done
    run_all all -e "BASE=$(base_of 0)" -e "BAD1=$(base_of 1)" -e "BAD2=$(base_of 2)" -e "VERSION=$version" -e "PREVIOUS=$previous" -e "LIVE=0"
    ;;
  *)
    sed -n '2,24p' "$0"
    exit 2
    ;;
esac
