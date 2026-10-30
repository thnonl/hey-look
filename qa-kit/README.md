# Hey Look! 1.0.11 RC1 QA kit (Windows host)

Build: release/v1.0.11 @ ae1ef18b (version bump, i18n review, dark-logo fix 8cd0e7b6, BUG-1 box fix, QA hooks). Debug build, features gui-subsystem,qa-secrets,
identifier thnonl.heylook.qa.v1011. File: hey-look-qa-1011-rc1-ae1ef18b.exe (sha256 in exe.sha256). Older rc1 exes are in superseded/.

## Start
    powershell -NoProfile -ExecutionPolicy Bypass -File E:\hey-mail\test-builds\v1011-rc1\launch-kit.ps1 [-Port N] [-DataDir <dir>]
Prints JSON: {pid, cdpPort, cdpUrl, dataDir, bridgeFile}. Default data dir E:\hey-mail\test-builds\v1011-rc1\data (own APPDATA/LOCALAPPDATA
under it, own WebView2 profile). CDP: http://127.0.0.1:<cdpPort>/json (free port picked at start). Test bridge: HEYLOOK_TEST_BRIDGE=0;
port + token in <dataDir>\test-bridge.json (see hey-mail-app\scripts\test-bridge.md). Secrets are in <dataDir>\qa-secrets.json (no system prompt).

## Rules
- NEVER read or write %APPDATA%\thnonl.heylook (owner's real data) or %LOCALAPPDATA%\Hey Look! (installed app). Do not kill the owner's hey-look.exe
  (path C:\Users\namth\AppData\Local\Hey Look!\hey-look.exe). Stop only the kit PID printed by the launcher.
- A fresh data dir = first run (Welcome screen). Use a new -DataDir for a clean run; reuse the folder to keep state.
- No real-input rows (CDP / bridge only).
- Window placement (owner rule): the launcher moves the kit window to the SECOND monitor (X=3200, Y=0, 2400x1350, \.\DISPLAY1) and holds it there while the
  app starts (it places its own window again in the first seconds). Option -Monitor 2 is the default; -X -Y -W -H change the rectangle. Never use -Monitor 0
  on the owner's host. The window can show for a fraction of a second on the primary screen before the first move. The UI shards use headless Chrome.

## Rows that need more than clicking (added after QA round 1)
All helpers are in tools\ (python is on the host). Use a NEW data folder for a seeded run; both scripts refuse to overwrite.
1. Account + fixtures (DMARC/DKIM rows, WP1-R10, WP2-R3/R4):
   - `python tools\kit-seed.py <dataDir> --imaps --tls-insecure --imap-port 33993 --smtp-port 33025 --written-to friend@written.example`
   - start the image listener, then `python tools\kit-mail.py 127.0.0.1 33025 127.0.0.1:18081`
   - mails: A written-to + dmarc pass, B built-in service (accounts.google.com) + dkim/dmarc pass: pictures show by themselves; C no Authentication-Results, D dmarc fail, E stranger: pictures stay hidden.
   The app reads the TOPMOST Authentication-Results header, so the fixtures only have to write one (no product hook needed).
2. Send failure (WP5-b2): `launch-kit.ps1 -SmtpFail refuse` (or `auth` = 535, `temp` = 451) sets HEYLOOK_QA_SMTP_FAIL for this kit run: every send fails with that server answer;
   the editor must unlock in place with its content and the error toast must show. Without the flag the send is normal. (qa-secrets kits only; a release build does not contain it.)
3. Account name == address (WP5-c "X . X"): `kit-seed.py ... --name-same` writes the display name equal to the address. (The Profile field cannot be set by the bridge `type`: it writes the value without the input event the app listens to; type with CDP Input.insertText or use the seed.)
4. Sent mark (WP5-b1): while the mark shows, the compose pane has the class `sent-mark` and `data-sent-mark="1"`; the element is `.cp-sent` (label `.cp-sent-lbl`, text "Message sent"). It stays 1000 ms (600 ms with reduced motion).
   Timing: `performance.getEntriesByName('hl:sent-mark')` (start = mark drawn, duration = how long it showed, written when the pane ends). Probe: `document.querySelector('.compose-pane.sent-mark')`.
5. BUG-1 fix (small boxes): the hidden-picture box shows the whole text only from 140 x 84 px, one line from 96 x 56, the icon alone below (the tooltip has the line). Probe: all `.hl-bp[data-hl-pic]` in the frame: every visible child inside the box rect.
