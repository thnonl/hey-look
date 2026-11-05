# QA helpers (not shipped)

## Google sign-in in an existing Chrome profile: `google-consent-profile.ps1` (Windows, preferred)

Uses the Chrome profile that is already signed in to the test account (default `Profile 1` =
thnonline@gmail.com; the script refuses a profile whose signed-in user is another address). Chrome
does not allow a DevTools port on its normal profile folder, so the script reads and presses the page
through UI Automation: no CDP, no mouse, no typing.

```
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\qa\google-consent-profile.ps1 -Check
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\qa\google-consent-profile.ps1 -Snapshot <file>
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\qa\google-consent-profile.ps1 -Action allow -FromUia -Since <file>
```

Take the snapshot before the app's "Sign in with Google" click, then run `-Action allow` (or `deny`).
Chrome opens outside links in the last used profile: when the app's tab is already in the test
profile, the script drives that tab; otherwise it opens the URL again in the test profile and leaves
the other tab alone. It picks only the account link that names the test address, passes Google's
"unverified app" page (Advanced, Go to Hey Look!), and presses Continue, or Cancel for `deny`
(English and Vietnamese labels). When the app has its answer the script closes the tab.
It stops on a password, code or CAPTCHA page (exit 3) and on a wrong or missing account (exit 4).

## Google sign-in without manual clicks: `google-consent.mjs`

Drives the Google account chooser and consent pages in a dedicated QA Chrome profile
(`D:\qa-chrome-profile\heylook`), never the owner's own Chrome profile. Node 22+, no dependencies.

One-time setup (the owner, by hand):

```
node scripts/qa/google-consent.mjs start
```

A Chrome window with the QA profile opens on accounts.google.com. Sign in there to the test account
(thnonline@gmail.com) once. Google keeps the session in that profile. The script never types a
password, a code or a CAPTCHA and stores no credentials.

Check the session: `node scripts/qa/google-consent.mjs check` (exit 0 = signed in, 3 = sign-in needed).

In a QA run:

1. `node scripts/qa/google-consent.mjs snapshot --out=<file>` before the app's "Sign in with Google"
   click, so older Google tabs are ignored.
2. Click "Sign in with Google" in the QA app. The app opens the consent page in the system default
   browser (it has no browser override). Nobody touches that tab.
3. `node scripts/qa/google-consent.mjs consent --action=allow --from-uia --since=<file>` (or
   `--action=deny` for the refusal row). The script reads the new consent URL from the address bar
   (UI Automation, read-only), opens it in the QA profile, clicks the tile of exactly
   `--email` (default thnonline@gmail.com), and then Continue / Allow, or Cancel. The app's loopback
   gets the answer from the QA profile.

It stops without clicking when the account is missing or different (exit 4), when Google asks for a
password, a code or a CAPTCHA (exit 3, NEED_OWNER), or after `--timeout` seconds (exit 5).
`--url=<consent url>` can replace `--from-uia`.
