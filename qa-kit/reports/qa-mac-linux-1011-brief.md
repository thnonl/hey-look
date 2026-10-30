# Mac and Linux QA brief: Hey Look! 1.0.11 RC (2026-10-30)

You are the Mac & Linux QA team on the owner's MacBook. Test the 1.0.11 release candidate on real macOS (and Linux if a Linux machine/VM is available). Report to the main session (reply to the message that delivered this brief) AND write the report to `reports/v1-0-1/qa-1011-rc1-mac-linux.md` in the repo clone.

## Rules (standing owner rules)
- Do not touch the owner's installed `/Applications/Hey Look!`, its keychain entries, login items, or real mail data. Use an isolated build/profile (QA identifier/data dir) and test accounts only. Avoid creating new macOS user accounts in your instructions/reports.
- Stale QA build trees/caches on the Mac/VM may be deleted by you if space is short.
- WebKit and font behaviour must be verified on the real machine with probes; never close a UI row as "not verified".
- Skip reduced-motion rows. Real-input rows that cannot be done via the harness: NOT RUN with reason.
- Computer-use is allowed for QA on Mac/Linux, but no real-mouse rows are required.
- No Gitea; GitHub only.

## Get the code
```
git fetch origin
git checkout -B release/v1.0.11 origin/release/v1.0.11     # HEAD ae1ef18b or newer
```
Build as for earlier QA kits (qa-secrets feature, `--debug --no-bundle`, QA identifier `thnonl.heylook.qa.v1011`, own data dir). Windows QA already ran the same RC; its report is `reports/v1-0-1/qa-1011-rc1-win.md` (fixtures: `tools/kit-mail.py`, `tools/kit-seed.py`, `-SmtpFail` equivalents in the kit README).

## Rows to verify on Mac and Linux
1. **WP3 macOS notifications (Mac only)**: follow `reports/v1-0-1/qa-mac-notify-1011-brief.md` in full (UNUserNotificationCenter; banners, permission prompt, `settings.tray.macQuiet` "delivered quietly" text; behaviour for a self-signed/ad-hoc signed app: do banners show? If macOS refuses banners, say so exactly; the owner then decides to ship with the "delivered quietly" note).
2. **WP1 pictures**: newsletter with `<img src+srcset>` (`scripts/fixtures/newsletter-srcset.html`): Show pictures, right-click Show this picture, Show all; dark-source `<picture>` logo switches in Dark background; blocked placeholders; BUG-1 box tiers (icon only <96x56, icon+line, full text >=140x84; text not clipped).
3. **WP2 settings**: Settings > Mailboxes > Reading & sync: automatic-pictures switch, noauto list, built-in service-domain list (inline); DMARC fixtures A-E (A and B auto-shown, C/D/E hidden), "Stop showing", Remove, restart persistence.
4. **Compose (WP5)**: after Send the compose stays visible and fully locked while the Undo toast shows; Undo unlocks with content intact; success shows the sent mark (class `sent-mark`, `data-sent-mark="1"`, `performance.getEntriesByName('hl:sent-mark')`, ~0.5-1.8 s, look at WKWebView/WebKitGTK rendering of the stroke animation); SMTP failure unlocks in place with content; pop-out compose same.
5. **Calendar label**: event dialog Calendar field never shows `X · X` (seed account whose display name equals its address); also sidebar and move dialog.
6. **Move/delete**: mail appears at once in the destination folder with counts; Undo reverts; failure rolls back.
7. **WP4 strings/layout**: es mini-calendar header must read `L M X J V S D` (week starts Monday; probe `[...document.querySelectorAll('.mini-cal thead th')].map(e=>e.textContent)`, no cell wider than its column; needs `Intl` narrow weekday: macOS 11+, WebKitGTK 2.40+); compose status line wording (en/de/es/ja/ru/vi); zh-Hans spacing between Latin and Han and no leading space after line breaks in toasts; vi "Bảo mật"; ru default rule name; rule dialog at 1440x900 and 960x560 (ja chips); es notice max 3 lines at 492 px.
8. **Fonts/WebKit**: bundled Inter, sent-mark SVG stroke animation, hidden-picture box text fit, run probes and attach outputs. Pass criteria are in `reports/v1-0-1/webkit-checks-107.md`.

## Output
Table `row | PASS/FAIL/NOT RUN | evidence (probe output or screenshot path)` per OS, then bug reports with repro for the coder. Final summary: verdict per OS, list of FAIL/NOT RUN. Do not fix code; do not push; do not tag.
