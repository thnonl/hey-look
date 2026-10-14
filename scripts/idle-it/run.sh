#!/usr/bin/env bash
# IMAP IDLE integration test (opt-in; CI does not run it). See run.ps1 for the three servers it starts.
# Usage: scripts/idle-it/run.sh [--keep]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tauri="$(cd "$here/../../src-tauri" && pwd)"
names="hl-idle-gm hl-idle-dv hl-idle-dv2"
remove_all() { for n in $names; do docker rm -f "$n" >/dev/null 2>&1 || true; done; }
wait_port() { for _ in $(seq 60); do (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && return 0; sleep 1; done; echo "port $1 did not open" >&2; return 1; }
dovecot_start='mkdir -p /tmp/dv /srv/vmail && chown vmail:vmail /srv/vmail && openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=127.0.0.1 -keyout /tmp/dv/key.pem -out /tmp/dv/cert.pem 2>/dev/null && exec dovecot -F'
remove_all
[ "${1:-}" = "--keep" ] || trap remove_all EXIT
docker run -d --name hl-idle-gm -p 127.0.0.1:13025:3025 -p 127.0.0.1:13993:3993 \
  -e 'GREENMAIL_OPTS=-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=u1:pw1@example.test' greenmail/standalone:2.1.0 >/dev/null
docker run -d --name hl-idle-dv -p 127.0.0.1:13994:993 -v "$here/dovecot-idle.conf:/etc/dovecot/dovecot.conf:ro" --entrypoint sh dovecot/dovecot:2.3-latest -c "$dovecot_start" >/dev/null
docker run -d --name hl-idle-dv2 -p 127.0.0.1:13995:993 -v "$here/dovecot-noidle.conf:/etc/dovecot/dovecot.conf:ro" --entrypoint sh dovecot/dovecot:2.3-latest -c "$dovecot_start" >/dev/null
for p in 13993 13025 13994 13995; do wait_port $p; done
sleep 5 # GreenMail opens its ports before it accepts logins
export HEYLOOK_IDLE_IT=1 HL_IT_USER=u1 HL_IT_PASS=pw1 HL_IT_NOIDLE_PORT=13995
cd "$tauri"
echo "=== GreenMail: new mail by SMTP ==="
HL_IT_PORT=13993 HL_IT_SMTP_PORT=13025 HL_IT_CONTAINER=hl-idle-gm cargo test --lib idle_it -- --test-threads=1 --nocapture
echo "=== Dovecot: new mail by IMAP APPEND ==="
HL_IT_PORT=13994 HL_IT_CONTAINER=hl-idle-dv cargo test --lib idle_it -- --test-threads=1 --nocapture
echo "IDLE integration tests passed (GreenMail and Dovecot)."
