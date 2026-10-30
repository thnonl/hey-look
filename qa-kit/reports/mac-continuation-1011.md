# Mac QA continuation: Hey Look! 1.0.11 RC (2026-10-30)

You continue the Mac QA of 1.0.11 started by an earlier session that ran out of context. Read that session's report first: `~/qa-heylook/src/reports/v1-0-1/qa-1011-rc1-mac-linux.md` (on the MacBook, uncommitted) and this folder's `mac-linux-1011-brief.md` (rows 1-8, rules). Standing rules apply (isolated QA identifiers only; never touch /Applications/Hey Look!, the owner's keychain or real data; do not push/tag/fix code; skip reduced-motion rows; computer-use allowed for QA incl. read-only System Settings).

Code: `git fetch origin && git checkout -B release/v1.0.11 origin/release/v1.0.11` (HEAD 177b70ee or newer). Fixtures: `git checkout origin/qa/v1011-fixtures -- qa-kit` (do not commit). Tools in place on the Mac from the previous session: `~/qa-heylook/v1011-kit` (kit-seed/kit-mail data), GreenMail 2.1.2 jar in `~/qa-heylook/mail` (delete when QA is finished), image listener 127.0.0.1:18081 with Referer/UA log `~/qa-heylook/mail/img-listener.log`, local srcset copy `~/qa-heylook/mail/newsletter-srcset-local.html`. Verify what is still running before starting new copies.

## Results so far (Mac, RC b5e1d6bd unless noted)
- Row 3 (auto pictures): PASS (A,B auto; C,D,E hidden; popover; Stop/Remove).
- Fonts (row 8, Mac): PASS.
- BUG-2 (auto-shown pictures requested twice): PASS on b5e1d6bd (one backend request per picture, none from the page).
- BUG-1 (placeholder tiers): FAIL on b5e1d6bd (168x50 showed one line). Fixed in 177b70ee by judging the rendered size (mail zoom). RECHECK. If it still shows one line, record for that box: getBoundingClientRect, data-tier, data-tier0 and the frame's documentElement.style.zoom.
- Row 1 notifications: at launch startup.log shows "asking for permission (start)" then "authorizationStatus denied" within 0.4 s: no prompt can be shown for the self-signed build. System Settings > Notifications has one 'Hey Look QA' entry (Allow ON, Alert style Temporary, badge ON, sound ON) but its identifier is unknown; list scrolling failed. Owner's Hey Look! entry untouched.

## To do on 177b70ee
1. BUG-1 recheck (168x50, 110x60, 96x56, 140x84, 140x83; en first, then es/de/ja/zh-Hans/ru/vi). BUG-2 quick recheck.
2. Row 1: find out which QA identifier the single 'Hey Look QA' System Settings entry belongs to (e.g. quit all QA apps, remove nothing, relaunch only v1011 and watch which entry changes; or check `tccutil`-free evidence such as the app's own log). Then: does the self-signed build ever get the permission prompt? Does a banner show when the entry is Allow+Banners? What does the app show (settings.tray.macQuiet 'delivered quietly' note) when denied? Conclude clearly: "banners impossible for self-signed build" or "banners work after Allow".
3. Row 4 compose: lock + Undo (10 s countdown), sent mark (`.cp-sent`, `data-sent-mark="1"`, `performance.getEntriesByName('hl:sent-mark')` 0.5-1.8 s; check the SVG stroke animation in WKWebView), SMTP failure (stop GreenMail or `HEYLOOK_QA_SMTP_FAIL=refuse|auth|temp`): unlock in place, content intact, friendly error text (no raw 'os error'); pop-out compose.
4. Row 6: move/delete appears at once in the destination with counts; Undo reverts; failure rolls back.
5. Row 3 leftovers: Show this picture, dark-source `<picture>` logo in the Dark reading background; restart persistence of the noauto list and switch.
6. Rows 5/7a: es UI language, calendar (default 'My events' / Import .ics): mini-calendar header probe `[...document.querySelectorAll('.mini-cal thead th')].map(e=>e.textContent)` must be `L M X J V S D`; event dialog Calendar field with `kit-seed.py --name-same` shows the address once; sidebar; move dialog.
7. WP4 on Mac: compose status line wording per language, zh-Hans spacing, vi 'Bảo mật', rule dialog at 960x560 (Cancel/Save inside the window, ja chips).
8. Linux: the VM at 192.168.64.3 was never started (no start method found). Ask the owner/orchestrator how to start it; otherwise NOT RUN.

Write the report as `reports/v1-0-1/qa-1011-rc1-mac-linux.md` additions after each row, and reply to the orchestrator session ("Hey Look" Windows host session) with a verdict per row (PASS/FAIL/NOT RUN + evidence).
