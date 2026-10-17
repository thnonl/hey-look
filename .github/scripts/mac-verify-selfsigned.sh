#!/usr/bin/env bash
# macOS runner only. Checks that an app is signed with the release's self-signed certificate, so that the signature (and with it the
# identity that the macOS Keychain remembers for the app's saved passwords) is the same in every release:
#   bash mac-verify-selfsigned.sh <Name.app> "<signing identity = certificate common name>" [<Name.app.tar.gz>]
# Fails when: the bundle does not verify (--deep --strict), the signature is ad-hoc, the authority is not the identity, or the
# designated requirement is not "identifier ... and certificate root = H"<hash of the certificate>"" (for a self-signed certificate the
# leaf is also the root, so codesign writes "root"; "leaf" is accepted too). A requirement that names the cdhash instead changes with every build. With a tar.gz (the updater package) the app inside must have the same requirement.
# Prints the SHA-256 of the signing certificate (the identity) for the log.
set -uo pipefail

app="${1:?app bundle}"; id="${2:?identity}"; tgz="${3:-}"
fail() { echo "::error::$1"; exit 1; }

echo "App bundle: $app"
codesign --verify --deep --strict --verbose=2 "$app" || fail "codesign --verify --deep --strict failed"

out="$(codesign -dv --verbose=4 "$app" 2>&1)" || true
echo "$out"
grep -q 'Signature=adhoc' <<<"$out" && fail "the app is signed ad-hoc although the signing secrets are set (silent fallback)"
grep -qF "Authority=$id" <<<"$out" || fail "Authority is not \"$id\""

req="$(codesign -d -r- "$app" 2>&1)" || true
echo "$req"
dr="$(grep '^designated =>' <<<"$req" || true)"
[ -n "$dr" ] || fail "no designated requirement printed"
grep -q 'cdhash' <<<"$dr" && fail "the designated requirement is based on the cdhash (it would change with every build)"
grep -q 'certificate \(leaf\|root\) = H"[0-9a-f]\{40\}"' <<<"$dr" || fail "the designated requirement does not name the signing certificate"

# the signing certificate: leaf of the signature
d="$(mktemp -d)"
codesign -d --extract-certificates="$d/cert" "$app" >/dev/null 2>&1
[ -s "$d/cert0" ] || fail "could not extract the signing certificate"
echo "Signing certificate subject: $(openssl x509 -inform DER -in "$d/cert0" -noout -subject)"
echo "Signing certificate SHA-256: $(openssl x509 -inform DER -in "$d/cert0" -noout -fingerprint -sha256 | cut -d= -f2)"
leaf_sha1="$(openssl x509 -inform DER -in "$d/cert0" -noout -fingerprint -sha1 | cut -d= -f2 | tr -d ':' | tr 'A-F' 'a-f')"
grep -qF "H\"$leaf_sha1\"" <<<"$dr" || fail "the certificate hash in the requirement is not the hash of the signing certificate"
rm -rf "$d"

if [ -n "$tgz" ]; then
  echo "Updater package: $tgz"
  u="$(mktemp -d)"
  tar -xzf "$tgz" -C "$u"
  inner="$(find "$u" -maxdepth 1 -name '*.app' | head -n 1)"
  [ -n "$inner" ] || fail "no .app inside the updater package"
  codesign --verify --deep --strict --verbose=2 "$inner" || fail "the app inside the updater package does not verify"
  inner_req="$(codesign -d -r- "$inner" 2>&1 | grep '^designated =>' || true)"
  [ "$inner_req" = "$dr" ] || fail "the app inside the updater package has another designated requirement than the app"
  echo "The app inside the updater package has the same designated requirement."
  rm -rf "$u"
fi
echo "OK: signed with \"$id\", requirement names the certificate."
