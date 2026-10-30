# QA report: Hey Look! 1.0.11 RC1, Windows host (CDP + test bridge)

Date: 2026-10-30 (session about 15:58 to 16:30 local)
Build: hey-look-qa-1011-rc1-8cd0e7b6.exe (release/v1.0.11 @ 8cd0e7b6, debug build, feature qa-secrets, identifier thnonl.heylook.qa.v1011). Kit: E:\hey-mail\test-builds\v1011-rc1\ (exe.sha256 lists 4d3ff7c7...; not re-hashed in this run).
Spec: E:\hey-mail\reports\v1-0-1\plan-1011.md (WP1, WP2, WP4, WP5); brief items from the coordinator.
Host: this Windows 11 machine, not the Sandbox (the brief said "this host"; the owner memory rule "Windows QA in Sandbox" was not applied to this run, the owner should confirm that is acceptable).
Screenshots: E:\hey-mail\reports\v1-0-1\screens-qa-1011-rc1-win\ (file names below).

## Rules kept
- Owner data not touched: no read or write of %APPDATA%\thnonl.heylook, %LOCALAPPDATA%\Hey Look!, the installed hey-look.exe (PID 25940 untouched), HKCU Run, keychain, owner Gmail.
- Kit windows on DISPLAY1 (X >= 3200). Verified by GetWindowRect at each launch; see "Window placement" below.
- No real mouse or keyboard input. Clicks are bridge /click (DOM click at element centre), typing is bridge /type, context menu is a synthetic contextmenu event in the frame. Rows that need real input are NOT RUN.
- No reduced-motion rows.

## Test setup
- Mail: own GreenMail container hl-ct-r1011-gm3 (greenmail/standalone:2.1.0): IMAPS 127.0.0.1:33993 (self-signed, account tls_insecure=1), SMTP 127.0.0.1:33025 (plain, smtp_security none), user u1@example.test / pw1 (test value from make-seed, QA file store only).
- Pictures: host image listener 127.0.0.1:18081 (E:\hey-mail\test-builds\v1011-wp1\host\img-listener.py, log E:\hey-mail\test-builds\v1011-rc1\qa-r1\img-requests.log). Every request is logged with its User-Agent: backend requests use a Chrome UA, WebView page requests would contain "Edg/".
- Fixtures: scripts/fixtures/newsletter-srcset.html (F1) plus three QA mails F2 (src-only + 1x1 tracker), F3 (cid + remote), F4 (dark-source picture element, own fixture).
- Kit data folder used for the reported rows: E:\hey-mail\test-builds\v1011-rc1\data-r4 (fresh seed, port 9337 CDP, bridge via test-bridge.json).
- Seed scripts (scratchpad, not in repo): seed-r2.py (account with IMAPS + tls_insecure), seed-mail-r2.py (fixture sender).

## Harness notes (not product bugs)
- The first WP1 mail set (seed-mail.py in v1011-wp1\host) rewrote the fixture's http:// hosts badly ("http:http://127.0.0.1:18081/img/logo.png"), so the logo showed a broken image. Fixed in seed-mail-r2.py. The same rewrite bug is in v1011-wp1\host\seed-mail.py and will affect the Sandbox runs too.
- A plain-IMAP seed (imap_ssl 0) gives "Couldn't start a secure connection ... connects only with SSL/TLS or STARTTLS". The seed must use IMAPS (see seed-r2.py).
- The bridge `eval` returns null when a multi-statement script has no top-level `return` (for example `(() => {...})()` after a `;`). All probes below use `return`.
- bridge `type` writes the value directly and bypasses the `inert` attribute, so it is not a lock test.

## Row results

Legend: PASS / FAIL / NOT RUN (reason). Evidence paths are in screens-qa-1011-rc1-win\.

### WP1 picture srcset, dark-source picture (fixtures F1 to F4, kit data-r4 unless noted)

| Row | Covers | Result | Evidence |
|---|---|---|---|
| WP1-R1 | AC-1.2 blocked: no request to the srcset host, no srcset/sizes/source in the frame | PASS | F1 probe: `{"hidden":4,"imgs":0,"sources":0,"srcsetAttr":0}`; listener new lines during 3 s blocked = 0 (14-wp1-r4-f1-blocked.png). |
| WP1-R2 | AC-1.1 Show pictures: all 4 pictures show, src only, no srcset | PASS | After click: 4 img, natural 16 px, src data:, srcset false, sizes false; backend fetched only logo.png, top.jpg, wide.png, only.png (no *_2x) (15-wp1-r4-f1-show-pictures.png). |
| WP1-R3 | AC-1.1 right-click Show this picture (picture element) | PASS | F4 blocked 2 placeholders; menu = "Show this picture / Show all pictures in this message / Always show pictures from this sender"; after Show this picture: 1 placeholder left, light logo shown (08-wp1-f4-after-show-this.png, 10-wp1-f4-after-show-this-r2.png). |
| WP1-R4 | AC-1.1 right-click Show all pictures | PASS | F4: hidden=0, both logos natural 16 px, listener shows logo-light and logo-dark fetched (11-wp1-f4-show-all.png). |
| WP1-R5 | Dark-source picture: logo switches in dark background | PASS | Picture currentSrc hash 56a71ef8 (= Brand dark img) after "Message background: dark"; de3d959d (light) after toggling back to original. Source in frame: media rewritten to min-width:0px, srcset data: (12-wp1-f4-dark-background.png, 13-wp1-f4-background-back-original.png). |
| WP1-R6 | No WebView request to the image host (page requests) | PASS | 0 of 10 listener lines have an "Edg/" UA; all requests come from the backend (Chrome/120 UA). |
| WP1-R7 | Regression: src-only pictures, tracking pixel (F2) | PASS (observation) | Blocked: 2 placeholders, 0 requests. After Show pictures: 2 pictures natural 16 px. The 1x1 tracker is also fetched and shown as a 1x1 data: image (invisible). Not a violation of a stated AC; noted for BA (16-wp1-r4-f2-show-pictures.png). |
| WP1-R8 | Regression: cid inline + remote (F3) | PASS | Inline logo (cid) shown 40x16; remote picture placeholder; 0 requests (17-wp1-r4-f3.png). |
| WP1-R9 | AC-1.1 Always show pictures from this sender (4th show path) | NOT RUN | Not driven in this round (time). |
| WP1-R10 | Auto rule path (AC-1.1) | NOT RUN | Needs a written-to or service-domain sender that passes DMARC/DKIM; the GreenMail fixtures are unsigned. |
| WP1-R11 | Pop-out reader window | NOT RUN | Not driven. |
| WP1-R12 | Light/dark at 960x560, WebKit probes (Mac/Linux) | NOT RUN | Window size not set to 960x560 in this run; WebKit probes are Mac/Linux work. |

### WP2 Settings > Mailboxes > Reading & sync (kit data-r4, account u1@example.test)

| Row | Covers | Result | Evidence |
|---|---|---|---|
| WP2-R1 | Group "Show pictures automatically..." under Always show; default ON; list and button present | PASS | 21-settings-reading-sync.png (switch on, button "Show the list of well-known services", "Senders whose pictures are not shown automatically", empty text "No senders yet."). |
| WP2-R2 | REQ-2.1 switch OFF persists after Settings close and reopen | PASS (in session) | Switch set off (checkbox false) -> Settings closed -> reopened -> still false (23-wp2-auto-off.png, 24-wp2-auto-off-reopened.png). Restart persistence NOT RUN. |
| WP2-R3 | AC-2.1 effect of OFF on the reading pane (no auto show) | NOT RUN | No DMARC-passing written-to or service-domain sender in the fixtures. |
| WP2-R4 | REQ-2.2 noauto list: add by "Stop showing", Remove round trip, restart | NOT RUN | The "Stop showing" action needs an auto-rule notice; not reachable without R3's fixture. Empty state text PASS. |
| WP2-R5 | REQ-2.3 trusted list kept in the same group | PASS | Group "Senders whose pictures are always shown" with its own empty text (21-, 25-). |
| WP2-R6 | REQ-2.4 / AC-2.3 service-domain view: count and sort match SERVICE_DOMAINS | PASS (count, sort, note) | UI shows "64 services"; src/autoload.rs SERVICE_DOMAINS has 64 entries (counted in the file); list starts adobe.com, airbnb.com, amazon.ca ...; note text "A sender counts as a well-known service only when the sender check passes (DMARC or a DKIM signature from the same domain). This list is built in and cannot be edited." (22-wp2-domain-view.png). |
| WP2-R7 | REQ-2.4 view type | Deviation to confirm | The list opens inline in the group ("Hide the list of well-known services" toggles it), not as the popover or dialog the spec names. Read-only, so not a bug; BA to confirm. Esc, close button and focus return NOT RUN. |
| WP2-R8 | REQ-2.5 Always show ON disables the auto switch and shows the note | PASS | With Always show = on: auto checkbox disabled=true; notes "Not needed while "Always show pictures" is on: pictures from every sender are shown." (25-wp2-always-on.png). Override reset afterwards. |
| WP2-R9 | Settings search finds the group (REQ-2.6) | NOT RUN | Not driven. |
| WP2-R10 | AC-2.4 keyboard path, focus ring | NOT RUN | Needs real key input; CDP key events not run. |
| WP2-R11 | AC-2.5 texts in 8 languages, no clipping at 960x560 and 1280x800 | NOT RUN | Only English screens checked in this run, at about 1920 logical width. |

### WP5 Send, undo, move/delete (kit data-r4)

| Row | Covers | Result | Evidence |
|---|---|---|---|
| WP5-a1 | Send: compose locked while the Undo toast shows | PASS | Toast "Sending... Undo" visible; compose-pane aria-busy="compose-pane"; Subject ancestor has inert (35-wp5-undo-in-window.png, 32-wp5-send-undo-window.png). Real-input lock NOT RUN. |
| WP5-a2 | Undo unlocks with content intact | PASS | After Undo inside the window: subject "[WP5-QA] undo test 2", body "Undo check body 2", 1 recipient chip, inert false, aria-busy cleared (35-wp5-undo-in-window.png). |
| WP5-a3 | First Undo attempt was too late (timing) | NOT A RESULT | The Undo window is 6 s (Settings > General). My first probe was slower, the send went through (34-wp5-after-undo.png shows no toast). Recorded to avoid a false FAIL. |
| WP5-b1 | Success: sent mark about 1 s, then the compose closes | NOT RUN | Timeline with 0.5 s polling: Send at t=0, compose still open at t=11.3 s, closed at 11.3 s; "undo" text still present until then. The sent-mark element was not identified, so the 1 s timing could not be checked. Needs a re-check with a screenshot series. |
| WP5-b2 | Failure: unlock in place with content, error toast | NOT RUN | No SMTP failure set up in this kit. |
| WP5-b3 | Pop-out compose, same behaviour | NOT RUN | Not driven. |
| WP5-c | Calendar field never shows "X . X" (name == address) | NOT RUN | Could not make the account display name equal its address: the Profile field accepted the text but the DB value stayed "QA One" (tried type, Enter and blur). Observed in the event dialog: "QA One <u1@example.test>" (name differs, shown once each), so the duplicate case was not exercised. Sidebar and move dialog not checked. |
| WP5-d1 | Move (Archive): mail leaves Inbox at once, destination updated, Undo reverts | PASS (partial) | F3 removed from the Inbox list at 304 ms; "Archived" toast with "Undo"; after Undo F3 is back in the Inbox list (37-wp5-archive-moved.png, 38-wp5-archive-undo.png). Destination counts in the sidebar not captured. |
| WP5-d2 | Move failure rolls back | NOT RUN | Not driven. |

### WP4 strings and small items

| Row | Covers | Result | Evidence |
|---|---|---|---|
| WP4-R1 | zh-Hans 已藏 -> 已隐藏 | PASS (static) | grep: no "已藏" in src/; "已隐藏" in src/i18n/locales/zh-Hans/reading.ts. Runtime toast not checked. |
| WP4-R2 | vi "Thư mật" -> "Bảo mật" badge | PASS (static) | src/i18n/locales/vi/mail.ts "mail.row.confidential": "Bảo mật"; vi/compose.ts "compose.bar.confidential": "Bảo mật". Runtime badge NOT RUN. |
| WP4-R3 | de "Älteres" -> "Ältere" | PASS (static) | No "Älteres" in src/, docs/ or tests; de/mail.ts "Ältere Nachrichten laden". |
| WP4-R4 | es mini-calendar weekday header | PASS (runtime), question | Header read in es with the Monday-first setting: "L M X J V S D" (41-wp4-es-calendar.png). Plan AC-4.2 says "L M X J V S D"; the brief in the request says "D L M X J V S". Coordinator/BA to confirm which one is wanted. |
| WP4-R5 | ru default rule name genitive | NOT RUN | Runtime rule creation not done; the code template ru/settings.ts settings.filters.autoName is the filter name template, the default-rule text from the backlog is not located in code. |
| WP4-R6 | compose status line wording (en/de/es/ja/ru/vi) | NOT RUN | Not driven. |
| WP4-R7 | UI language switch works, es screens | PASS | Language select es -> en applied at once; es screens 40-, 41-. |
| WP4-R8 | rule dialog reachable at 1440x900 and 960x560; ja chips | NOT RUN | Not driven. |

## Bugs

### BUG-1 (cosmetic): blocked placeholder text is cut off in small picture boxes
- Requirement: WP1 AC-1.2 (blocked mode shows placeholders); plan item "no clipping" (WP4 AC-4.4) applies to the changed screens.
- Severity: cosmetic.
- Steps: 1) Settings and window as in the kit (1920-ish logical width). 2) Open message "[QA-WP1] F4 dark-source picture" (sender Brand Dark, from the seed) without showing pictures. 3) Look at the two placeholders under the text "Dark-source picture (QA-WP1 F4)...".
- Expected: "Picture hidden for privacy" and its hint readable inside the placeholder box, or the box sized so the text fits.
- Actual: the 120 x 40 placeholder boxes show the icon and "Picture hidden", the second line ("for privacy") is clipped at the box bottom edge.
- Evidence: E:\hey-mail\reports\v1-0-1\screens-qa-1011-rc1-win\06-wp1-f4-blocked.png (run on kit data-r3, same build; the placeholder code path is the same in data-r4).

## Window placement
- Launch 45732 and 50984 were moved by the launcher to X=3300 Y=60 (DISPLAY1, inside 3200..5600, 0..1350). Kit 50984 later showed its main window at x=2552 (visible on the primary edge). The main Tauri Window was then hidden (tray) and the visible helper window sat at (3200,0)-(5600,1350). I moved the hidden main window to (3300,60)-(5236,1108) inside DISPLAY1. The cause of the hide was not identified (no exit line in startup.log).

## Environment incidents (for the coordinator)
- My kit processes ended on their own: PID 30400 (data-r3) around 16:03 and PID 45732 (data-r3) around 16:05, with no clean-exit line and test-bridge.json left behind. I did not stop them.
- Other hey-look-qa processes appeared while I ran: PID 51156 (16:04:17, default data folder, no arguments) and PID 42340 (16:05:09, parent not found). I did not touch them. Someone else may be relaunching the kit; this can break bridge sessions.
- Owner's hey-look.exe (PID 25940) untouched.

## Leftovers (not deleted, per the reuse rule)
- Kit data folders: E:\hey-mail\test-builds\v1011-rc1\data-r1 (first seed, plain IMAP, not usable), data-r2 (IMAPS seed with broken fixture mails), data-r3 (fixed fixture mails, used for WP1 R1 to R5 evidence), data-r4 (reported run). The default data folder data was used by another process (not by me).
- Scripts in scratchpad: seed-r2.py, seed-mail-r2.py.
- Docker: containers hl-ct-r1011-gm, hl-ct-r1011-gm2 (stopped by me, not removed), hl-ct-r1011-gm3 (stopped at the end of this run, not removed). Older containers hl-ct-wp1-gm, hl-ct-wp1b-gm, and the Supabase set were not touched.
- Host image listener: stopped at the end (PID from qa-r1\img-listener.pid).

## Open questions for BA
1. WP4-R4: header order "L M X J V S D" (plan AC-4.2, Monday-first) or "D L M X J V S" (brief)?
2. WP2-R7: inline expansion of the service list vs popover/dialog in REQ-2.4. Accept?
3. WP5-b1: the expected sent-mark timeline (after the 6 s Undo window, does the compose close about 1 s later?).

## Summary
PASS: WP1 R1 to R8 (srcset, blocked, Show pictures, Show this picture, Show all, dark-source switch, regressions), WP2 R1, R2 (in session), R5, R6 (count), R8, WP5 a1, a2, d1, WP4 R1 to R4 (static or runtime), R7.
FAIL: BUG-1 (cosmetic).
NOT RUN: most rows listed above (reasons per row).

VERDICT: FAIL (open: BUG-1; plus many NOT RUN rows, so this is not an RC pass)
