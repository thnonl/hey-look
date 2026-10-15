# IMAP IDLE integration test

Opt-in test of `src-tauri/src/idle.rs` against real IMAP servers in Docker. Nothing here is part of a release build, and CI does not run it:
the Rust tests (`src-tauri/src/idle_it.rs`) return at once unless `HEYLOOK_IDLE_IT=1`.

Run everything (starts and removes the containers): `powershell -File scripts\idle-it\run.ps1` (Windows) or `scripts/idle-it/run.sh`.

By hand, with the containers from `run.ps1` running:

```
cd src-tauri
HEYLOOK_IDLE_IT=1 HL_IT_PORT=13993 HL_IT_USER=u1 HL_IT_PASS=pw1 HL_IT_SMTP_PORT=13025 HL_IT_CONTAINER=hl-idle-gm HL_IT_NOIDLE_PORT=13995 \
  cargo test --lib idle_it -- --test-threads=1 --nocapture
```

Servers: GreenMail 2.1.0 (advertises IDLE, pushes `* n EXISTS`; mail by SMTP on 13025), Dovecot 2.3 with `dovecot-idle.conf` (IDLE, "Still here" every 5 s; mail by IMAP APPEND), Dovecot with `dovecot-noidle.conf` (no IDLE in the capability list). All use a self-signed certificate, user `u1`, password `pw1`.

What it proves: new mail by SMTP is reported within 5 s (no poll); a burst of mails is one or two syncs; the session survives the server closing the connection (a TCP relay cuts it) and a real server restart (`docker restart`); IDLE is renewed on the keepalive timer without a new connection; a peer that goes silent is cut by the watchdog and the worker reconnects; a server without IDLE gives state `polling` and no reconnect loop; stop ends the worker in well under a second.
