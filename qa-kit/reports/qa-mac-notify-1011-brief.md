# Mac QA brief: macOS notifications through UNUserNotificationCenter (1.0.11)

Branch: `fix/v1011-mac-notify` (origin, based on main = v1.0.10 dc9d2d6a). Commit: ce6edb57 (round 2: banner diagnostics, quiet state, CI fix; d85ae56d was round 1).
Goal: prove on a real Mac that Send test and new-mail alerts show banners, that the permission prompt appears once, that a refusal gives the macOS error, and that a click focuses the app.
The change cannot be proven on Windows: the Rust code for macOS was only type-checked (see "What is unverified" at the end). Report every row as PASS / FAIL / NOT RUN with the log lines.

## What changed (so you know what to look for)
- `src-tauri/src/macnotify.rs`: shows notifications itself with `UNUserNotificationCenter` (`addNotificationRequest`), asks `requestAuthorization(alert|sound|badge)`, caches the result, and installs a notification-centre delegate at start.
- Send test: asks on the first press, then shows a banner even while Hey Look! is in front (only the test is presented in the foreground).
- New mail: same path; the existing rule "a Hey Look! window in front = no alert" is unchanged. The notification is silent; the app plays its own sound (as before).
- Click on a notification: brings the main window forward; for a new-mail alert it also opens that conversation (same `open-thread` event as a Windows toast click). Test and "3 new messages" summary only focus.
- The old plugin path (NSUserNotification) and the `HEYLOOK_MAC_NOTIFY` diagnostic are gone on macOS.
- Log lines in startup.log (data folder of the QA copy), prefix `[notify +ms]`:
  `macos: permission <state>`, `macos: asking for permission (<trigger>)`, `macos: permission request answered (granted: true|false)` or `failed: <text>`,
  `macos: handed to the notification centre (heylook.test.N | heylook.mail.N:<thread>)`, `macos: not shown, permission <state>: <error>`,
  `macos: notification centre delegate: installed` (stage line at start), plus (round 2) `macos: delegate set: true|false`, `macos: settings: authorizationStatus ..., alertStyle ...` (all seven values of getNotificationSettings), `macos: before <id>: delegate present: ...`, `macos: willPresent <id>: banner, list | not drawn in front`, `macos: response <id>: <action>` (click).

## 0. Round 2: what to find out (missing banner)
Round 1 symptom: requests reach Notification Centre, no banner in front or in background. The code now logs each suspect cause. Check them in this order with the startup.log `[notify]` lines of ONE Send test (app in front) and ONE new mail (app in background):

| Cause | Log line to read | Reading |
|---|---|---|
| 1 delegate dropped (macOS keeps it weakly) | `macos: before <id>: delegate present: true|false` (written at every send) | `false` = the delegate is nil at send time: report as FAIL cause 1. The object itself is held by a static, so `false` would be new information. |
| 2 delegate set too late | `macos: delegate set: true|false` (at start, from Tauri setup inside didFinishLaunching) and the stage line `macos: notification centre delegate: installed`. | `false`, or no line before the first `asking for permission`/`handed` line = too late/never. For a cold start by a click (row D1) a missing `macos: response <id>: com.apple.UNNotificationDefaultActionIdentifier` line means the click reached no delegate. |
| 3 willPresent result | `macos: willPresent <id>: banner, list` (Send test, app in front; options Banner, List, Sound) or `not drawn in front` (new mail while in front: intended). | The test line must appear exactly once per Send test with the app in front. Missing = macOS did not call the delegate (then see 1 and 2). A new-mail alert while the app is in the background does NOT call willPresent (normal macOS behaviour). |
| 4 alert style none (self-signed app) | `macos: settings: authorizationStatus authorized, alertSetting enabled, alertStyle none|banner|alert, notificationCenterSetting ..., lockScreenSetting ..., badgeSetting ..., soundSetting ...` (written when it changes AND again before every send) | `alertStyle none` with `notificationCenterSetting enabled` = state `quiet`: Settings shows the note (`settings.tray.macQuiet`) + Open System Settings; the notification goes to Notification Centre without a banner by macOS's own setting, not a bug of the app. Switch to Banners (or Alerts) in System Settings > Notifications > Hey Look QA: the next send must show a banner without restart. If macOS offers no Banners/Alerts choice or resets it to None for the self-signed build: cause is the signature (see section 8). `alertSetting disabled` = the person turned alerts off. |
| 5 Focus / Do Not Disturb | Not visible to the app. | Before the run: Control Centre > Focus = off (note it in the report). Repeat the Send test with a Focus on (Do Not Disturb) once: no banner is expected; the notification must be in Notification Centre afterwards. |

New rows:
| # | Steps | Expect (PASS) |
|---|---|---|
| Q1 | In System Settings > Notifications > Hey Look QA set the style to **None** (keep Allow Notifications on, Notification Centre on). Return to the app, open Settings > Notifications & tray. | The quiet note "Notifications are delivered quietly. To see banners, choose Banners or Alerts ..." and the Open System Settings button are shown; the denied note is not. The log has `alertStyle none`. Send test still works (no error toast, `handed to the notification centre`), no banner (by macOS setting). Set the style to Banners, return to the app: the note disappears, Send test shows a banner, no restart. |
| Q2 | Any Send test with the app in front, style Banners. | Log lines in order: `settings: ... alertStyle banner`, `before heylook.test.N: delegate present: true`, `willPresent heylook.test.N: banner, list`, `handed to the notification centre`. A banner is drawn. Paste these lines. |

Decision for the coder from the result: Q2 shows willPresent called and a banner drawn = fixed. willPresent called but no banner while style is Banners = report usernoted lines (E1). willPresent never called = cause 1 or 2. `alertStyle none` at every send even after choosing Banners = signature/bundle problem (outside the code).

## 1. Get the code
```
cd <your hey-mail-app clone>
git fetch origin
git checkout fix/v1011-mac-notify      # or: git checkout -B fix/v1011-mac-notify origin/fix/v1011-mac-notify
git log --oneline -1                   # ce6edb57
npm ci
```

## 2. Build a .app bundle (notifications need a bundle with an Info.plist and a bundle id; a bare binary is `unsupported` and the UI says so)
QA identifier `thnonl.heylook.qa` and name `Hey Look QA` are given by a config override, so the bundle is already named right and nothing of the owner's `thnonl.heylook` is touched:
```
npx tauri build --debug --bundles app --features qa-secrets \
  --config '{"identifier":"thnonl.heylook.qa","productName":"Hey Look QA"}'
```
Output: `src-tauri/target/debug/bundle/macos/Hey Look QA.app` (use your shared CARGO_TARGET_DIR if you set one: `$CARGO_TARGET_DIR/debug/bundle/macos/`).
Note: `src-tauri/tauri.conf.json` has `signingIdentity: "-"`, so the build ad-hoc signs; step 3 replaces that signature.
If the override did not rename the bundle: copy it to `~/qa-heylook/Hey Look QA.app` and set `CFBundleName`, `CFBundleDisplayName` and `CFBundleIdentifier=thnonl.heylook.qa` with `/usr/libexec/PlistBuddy -c "Set :CFBundleName 'Hey Look QA'" "…/Contents/Info.plist"` (same for the other two; add the key with `Add` if missing), then sign again.
The bundle loads the built frontend (`npm run build` runs as part of `tauri build`).

## 3. Sign with the QA identity (hardened runtime, as the release is)
```
security unlock-keychain -p "<qa keychain password>" ~/qa-heylook/qa-signing.keychain-db
security list-keychains -d user -s ~/qa-heylook/qa-signing.keychain-db $(security list-keychains -d user | tr -d '"')
APP="$PWD/src-tauri/target/debug/bundle/macos/Hey Look QA.app"
cp -R "$APP" ~/qa-heylook/    # work on a copy
APP=~/qa-heylook/"Hey Look QA.app"
codesign --force --deep --options runtime --sign "HeyLook QA Local" "$APP"
codesign -dv --verbose=4 "$APP" 2>&1 | grep -E "Identifier|Authority|TeamIdentifier|flags|Signature"
codesign --verify --deep --strict "$APP" && echo VERIFIED
```
Expect: `Identifier=thnonl.heylook.qa`, `flags=…(runtime)`, `TeamIdentifier=not set` (like the owner's release; no entitlements file is needed or used). Record the `Authority=` line.
First start of a self-signed copy: `xattr -dr com.apple.quarantine "$APP"` if it was copied through a browser or AirDrop, else right-click > Open.

## 4. Reset the notification state of the QA bundle id (so the first prompt can appear)
macOS keeps the answer per bundle id. If `thnonl.heylook.qa` was used before:
- System Settings > Notifications: if "Hey Look QA" is listed, note its state. To get a fresh prompt: quit the app, then `tccutil` does not cover notifications, so use a different id for a clean run: rebuild with `"identifier":"thnonl.heylook.qa2"` (or `qa3`, …) when you need an "undetermined" start. Say in the report which id each row used.

## 5. Log capture (start before row A, keep running to the end; one terminal)
```
log stream --level debug --predicate 'subsystem == "com.apple.UserNotifications" OR process == "usernoted" OR process == "hey-look" OR process == "Hey Look QA"' | tee ~/qa-heylook/notify-1011.log
```
(The process inside the bundle is `hey-look`; `Hey Look QA` is listed in case the bundler names it after the product.)
In a second terminal follow the app's own log: `tail -f "<data folder of the QA copy>/startup.log" | grep --line-buffered notify`. The data folder is the one your kit already uses for `thnonl.heylook.qa` (Application Support/thnonl.heylook.qa or the folder in the About page).

## 6. Test rows
Pre-conditions: a QA account is signed in (or use the test bridge as usual); Settings > Notifications & tray is open. Notification style of the app in System Settings: Banners or Alerts (not None) once it appears.

| # | Steps | Expect (PASS) |
|---|---|---|
| A1 | Fresh id (undetermined). Open Settings > Notifications & tray. Click **Send test**. | macOS shows its permission prompt "Hey Look QA would like to send you notifications". startup.log: `asking for permission (send test)`. |
| A2 | Click **Allow**. | Within about 2 s a banner "Hey Look!" test notification appears at the top right, even though the app window is in front. startup.log: `permission request answered (granted: true)` then `handed to the notification centre (heylook.test.N)`. System Settings > Notifications now lists Hey Look QA. No toast of the page (no error). |
| A3 | Click **Send test** again. | No prompt. A second banner appears (stays in Notification Centre). `handed to the notification centre (heylook.test.N+1)`. |
| A4 | Click the test banner (or its entry in Notification Centre). | The Hey Look QA window comes to the front (hide it first with Cmd+H to see the focus). No conversation opens. |
| B1 | Deny case 1: fresh id, click Send test, click **Don’t Allow** in the prompt. | The page shows a toast. Today the page keeps the agreed note for a denied state: "Notifications for Hey Look! are turned off in macOS ... System Settings > Notifications." plus the "Open System Settings" button under the Send test row. Record the exact toast text. If instead the toast reads "Couldn’t show a notification: Notifications are not allowed for this application. Turn them on in System Settings > Notifications." that is the other correct path (see note below). startup.log: `permission request answered (granted: false)` or `failed: …`, then `not shown, permission denied: …`. No banner. |
| B2 | Deny case 2: allowed before, now System Settings > Notifications > Hey Look QA > turn **Allow Notifications** off. Return to the app (window focus re-reads the state), click Send test. | Same as B1: no banner, the note/toast above, "Open System Settings" opens the Hey Look QA pane (button works). |
| B3 | Turn Allow Notifications back on, click Send test. | Banner appears again (state re-read on focus; no restart needed). |
| C1 | Allowed. Put the app in the background (click another app, or Cmd+H). Make new mail arrive (send a mail to the QA account from another account; or sync via the bridge). Subject and preview are plain text. | Banner with sender as title and subject + preview as body. startup.log: `notification: shown for 1 new message(s)` then `handed to the notification centre (heylook.mail.N:<thread>)`. One new-mail sound plays (the app plays it). |
| C2 | Click that banner. | Hey Look QA comes to the front AND opens that conversation. |
| C3 | Bring the app to the front (window focused), make new mail arrive. | No banner: startup.log `notification: skipped … (the window is in front …)`. (Rule unchanged.) |
| C4 | App in the background, 4 or more new messages at once. | One banner "N new messages"; clicking it only brings the app forward. |
| C5 | First new-mail alert with a fresh id (undetermined, no Send test pressed; the start may already have asked: note whether the prompt came at start or at the alert). | A prompt appears once; after Allow the pending alert is shown. |
| D1 | Quit the app. Make a notification pending in Notification Centre (use C1, leave it). Quit and click the old banner. | The app is started by the click, comes to the front and opens the conversation (the delegate is installed at start). If it only starts without opening the conversation, report it as a finding. |
| E1 | Run `log` capture check. | In notify-1011.log find the `usernoted` lines for the three outcomes (presented / not allowed / clicked) and quote them in the report. |

Note on B1: both toasts are acceptable for the deny case in this round; what must hold is (1) no banner, (2) the text names System Settings > Notifications, (3) no crash and no hang (the permission call has a 10 minute guard, the add call 10 s).

## 7. Extra checks (quick)
- Dock badge: with "Badge app icon" on in System Settings, unread count still shows on the Dock icon (unchanged feature).
- Windows/Linux paths are unchanged: nothing to test here; the Windows and Linux sessions run their normal rows.
- Do not touch the owner's installed `Hey Look!` (`thnonl.heylook`) or its data. Do not leave `Hey Look QA` in /Applications.

## 8. What to send back
For each row PASS/FAIL, the exact toast text for B1/B2, the codesign lines of step 3, the startup.log `[notify]` lines of the run, the relevant `log stream` lines (usernoted decisions, any "not authorized", "no valid bundle", "signature" complaints), macOS version and chip, and a screenshot of each banner if you can.
If Send test is accepted by the code (`handed to the notification centre`) but no banner shows and `usernoted` complains about the signature or the bundle, say so in those words: that means the self-signed identity is not accepted by the notification service and the fix is outside the code (Developer ID signing). Also try once with `codesign --force --deep --sign -` (ad hoc, no runtime flag) and report whether the banner then shows.

## What is unverified before this round (for the coder / BA)
- The macOS Rust module compiled only as a type check of the Objective-C part (scratch crate with the same objc2 0.6.5, block2 0.6.2, objc2-foundation 0.3.2, objc2-user-notifications 0.3.2 for `aarch64-apple-darwin`; `-D warnings` clean). The full app was not built for macOS on Windows (no C cross compiler). The real build is the first one on your Mac.
- Runtime behaviour of the delegate (willPresent for the test only, didReceive click), whether `usernoted` accepts a self-signed hardened-runtime app, and the first-prompt flow are untested.
