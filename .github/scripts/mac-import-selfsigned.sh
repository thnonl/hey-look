#!/usr/bin/env bash
# macOS runner only. Puts the self-signed code-signing certificate of the release (secrets APPLE_CERTIFICATE = base64 of the .p12,
# APPLE_CERTIFICATE_PASSWORD, APPLE_SIGNING_IDENTITY = the certificate's common name) into its own temporary keychain, trusts it
# for code signing and puts the keychain on the user's search list, so `codesign -s "<identity>"` (which is how the Tauri bundler
# signs when tauri.conf.json names an identity and APPLE_CERTIFICATE is NOT in its environment) finds it.
#
# Why not let the bundler import the certificate (APPLE_CERTIFICATE in its environment)? tauri-macos-sign only accepts a certificate whose
# common name starts with an Apple prefix ("Developer ID Application:", "Apple Development:", ...) and that has an organizational unit
# (the Team ID); a self-signed certificate has neither, so the bundler stops with "failed to resolve signing identity".
# Why trust? `security find-identity -v` and `codesign -s` accept only identities that are valid for code signing; a self-signed
# certificate is valid only when it is trusted as a root for code signing.
#
# Reads the three values from the environment, never prints them. Needs: openssl (LibreSSL on macOS is fine), security.
# Keychain: $RUNNER_TEMP/heylook-signing.keychain-db (removed again by the workflow step "Remove Apple signing material").
set -euo pipefail

: "${APPLE_CERTIFICATE:?}" "${APPLE_CERTIFICATE_PASSWORD:?}" "${APPLE_SIGNING_IDENTITY:?}"
tmp="${RUNNER_TEMP:-$(mktemp -d)}"
kc="$tmp/heylook-signing.keychain-db"
p12="$tmp/heylook-signing.p12"
pem="$tmp/heylook-signing.pem"
kcpw="$(openssl rand -hex 16)"

# one line of base64 (a secret pasted with a line break still works); openssl instead of base64(1), whose flags differ between macOS versions
printf '%s' "$APPLE_CERTIFICATE" | tr -d ' \r\n' | openssl base64 -d -A > "$p12"
trap 'rm -f "$p12" "$pem"' EXIT

security create-keychain -p "$kcpw" "$kc"
security set-keychain-settings -lut 21600 "$kc"
security unlock-keychain -p "$kcpw" "$kc"
security import "$p12" -k "$kc" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security >/dev/null
# lets codesign use the private key without a dialog (there is nobody to click it on a runner)
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$kcpw" "$kc" >/dev/null

# the keychain joins the search list (the existing ones stay)
existing=()
while IFS= read -r line; do
  line="${line#\"}"; line="${line%\"}"; line="$(echo "$line" | sed 's/^[[:space:]]*//')"
  [ -n "$line" ] && existing+=("$line")
done < <(security list-keychains -d user)
security list-keychains -d user -s "$kc" ${existing[@]+"${existing[@]}"}

# trust it for code signing: user trust settings first, the admin ones (sudo is passwordless on hosted runners) when that is refused
security find-certificate -c "$APPLE_SIGNING_IDENTITY" -p "$kc" > "$pem"
if ! security add-trusted-cert -r trustRoot -p codeSign -k "$kc" "$pem"; then
  echo "user trust settings refused, trying the admin ones"
  sudo security add-trusted-cert -d -r trustRoot -p codeSign -k "$kc" "$pem"
fi

echo "Identities valid for code signing in the signing keychain:"
ids="$(security find-identity -v -p codesigning "$kc")"
echo "$ids"
if ! grep -qF "\"$APPLE_SIGNING_IDENTITY\"" <<<"$ids"; then
  echo "::error::the certificate was imported but is not a valid code-signing identity named \"$APPLE_SIGNING_IDENTITY\" (name differs from APPLE_SIGNING_IDENTITY, or the trust setting did not apply)"
  exit 1
fi
