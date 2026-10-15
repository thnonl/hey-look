# Contributing and building Hey Look!

The developer parts of the project: sign-in clients, building from source, the code layout, releasing and how the app works. For using the app see the [README](README.md) and the [website](https://thnonl.github.io/hey-look/help.html). To report a vulnerability see [SECURITY.md](SECURITY.md).

## Configuration

### Google

Google sign-in needs an OAuth client of type **Desktop app** (Google Cloud Console, Gmail API enabled).
Provide it in any of these ways, in this order of priority:

1. Environment variables at run time
2. Values embedded at build time from the environment or a `.env` file
3. Typed into **Settings → Add account → Google**

| Variable | Meaning |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth client id |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret |

Copy `.env.example` to `.env` (it is git-ignored) and fill in the values. The consent screen is *In production* but not yet verified by Google: people see “Google hasn’t verified this app”, and the project is limited to 100 users for its whole life until the verification is done (the app and `docs/help.html#google-review` say so; `GOOGLE_REVIEW_PENDING` in `src/signIn.ts` switches the review texts off after approval). In *Testing* mode Google would expire refresh tokens after 7 days; do not switch the app back to Testing.

#### Calendar sync (Google Calendar)

Calendar sync uses the same OAuth client and a **separate consent** (a desktop app cannot add scopes to an existing grant), so a user who never turns it on is never asked. To use it:

1. Google Cloud Console, the project of `GOOGLE_CLIENT_ID` → APIs & Services → Library → **Google Calendar API** → **Enable**. Without it every request fails with `403 accessNotConfigured` and Settings shows "Calendar sync isn't available in this version of Hey Look! (Google reported: ...)".
2. Google Auth Platform → Data Access → Add or remove scopes: `https://www.googleapis.com/auth/calendar.events` and `https://www.googleapis.com/auth/calendar.calendarlist.readonly` (both sensitive, not restricted). Add them before the first verification submission so one review covers mail and calendar.
3. The app is *In production* (unverified): no test-user list and no 7-day expiry. If Google ever revokes a grant, the app shows **Allow access again** (calendar) or **Sign in again** (mail).

The calendar sign-in keeps its own refresh token in the credential store under `<account id>:calendar` (the mail token is `<account id>`). Tests never use a real account: `cargo test` runs the sync layer against a fake provider and the Google provider against a small fake HTTP server (`src-tauri/src/calsync/fake_http.rs`). Debug builds can point the Calendar API, Microsoft Graph and the token endpoint at such a server with `HEYLOOK_GCAL_BASE`, `HEYLOOK_GRAPH_BASE` and `HEYLOOK_TOKEN_BASE`; a release build ignores them. `npm run dev` (the browser mock) has a fake Google mailbox (`nam@gmail.com`) and a fake Outlook mailbox (`nam@outlook.com`) with three calendars each; `#calsync=ok|syncing|first|offline|busy|auth|blocked|notsetup|error|truncated` (Google) and `#calsyncms=...` (Outlook) in the address show every state of Settings > Calendar.

### Microsoft

Microsoft sign-in (Outlook.com, Hotmail, Live, Microsoft 365) needs an app registration in Microsoft Entra
(portal.azure.com → App registrations):

1. Supported account types: **personal Microsoft accounts and accounts in any organizational directory**.
2. Authentication → add platform **Mobile and desktop applications** with redirect URI `http://localhost` (the port is ignored), and allow public client flows.
3. API permissions → Office 365 Exchange Online (delegated): `IMAP.AccessAsUser.All`, `SMTP.Send`, plus `offline_access`. For calendar sync also add Microsoft Graph (delegated) `Calendars.ReadWrite` (see below).
4. Copy the Application (client) ID. No secret is needed.

Provide it the same three ways as Google:

| Variable | Meaning |
|---|---|
| `MICROSOFT_CLIENT_ID` | Application (client) ID |
| `MICROSOFT_CLIENT_SECRET` | Optional, only for confidential clients (not shown in the app) |

The **Tenant** field in the Microsoft tab is typed in the app (empty = `common`, personal and work accounts); enter a tenant ID or domain only for a
single-tenant app registration, which personal accounts cannot use.

Work and school tenants may block IMAP / SMTP AUTH until an admin enables it for the mailbox.

#### Calendar sync (Microsoft Graph)

Calendar sync uses the same Entra app, the same client ID, the same tenant setting and the same redirect (`http://localhost`), and a **separate consent** with its own refresh token (a token request names one resource: the mail token is for Exchange Online, the calendar token for Microsoft Graph), so a user who never turns it on is never asked. Steps in the Entra admin center / Azure portal, for the app of `MICROSOFT_CLIENT_ID`:

1. App registrations → the app → **API permissions** → Add a permission → **Microsoft Graph** → **Delegated permissions** → `Calendars.ReadWrite`. Keep `openid`, `email`, `profile`, `offline_access`. The permission needs no admin consent for the user's own calendars: do **not** grant tenant-wide admin consent unless it is your own test tenant (users consent themselves; a tenant that disabled user consent shows "Need admin approval", and Hey Look! then tells the person that their organization must approve it).
2. **Authentication**: keep the platform "Mobile and desktop applications" with the redirect URI `http://localhost` (no new URI is needed) and public client flows allowed. Check **Supported account types** = "Accounts in any organizational directory and personal Microsoft accounts" (without personal accounts, outlook.com and hotmail.com mailboxes cannot consent).
3. Branding & properties: home page, privacy and terms URLs. Publisher verification needs a Microsoft AI Cloud Partner Program account and a custom domain: until then the consent page says "unverified" and some tenants block unverified apps.
4. For QA use a throw-away outlook.com account (and a second one as an invitation organizer). Tests never use a real account: the Microsoft provider is tested against a fake Graph server (`src-tauri/src/calsync/microsoft_tests*.rs`).

No GitHub secret changes: the client ID is the one that already ships.

### Servers with their own certificate

Proton Mail Bridge listens on `127.0.0.1` with a self-signed certificate: choose **Proton Mail Bridge** in the provider list and use the
username and password Bridge shows. For other servers turn on **Trust this server's certificate** under the advanced settings. The
certificate is then not checked for IMAP and SMTP of that account, so use it only for servers you control.

### iCloud

Apple does not provide OAuth for IMAP / SMTP. In **Settings → Add account → iCloud, Yahoo, other** pick iCloud and enter an
app-specific password from account.apple.com (Sign-In and Security → App-Specific Passwords).

---

## Development

Prerequisites: Node.js 20+, Rust (stable, MSVC toolchain), Microsoft WebView2 runtime, Visual Studio Build Tools.

```bash
npm install
npm run tauri dev                      # run the desktop app with hot reload
npm run tauri build -- --no-bundle     # release executable: src-tauri/target/release/hey-look.exe
npm run tauri build                    # release plus installers
npm run dev                            # UI only, in a browser, with generated mock data (no backend)
npx tsc --noEmit                       # type-check the UI
cargo check --manifest-path src-tauri/Cargo.toml
```

Debug builds (`tauri dev`, `tauri build --debug`) can run on a throw-away data folder: set `HEYLOOK_DATA_DIR` to a folder, or put a file `heylook-data-dir.txt` (first line = folder) next to the executable (it survives an installer-driven update), and the app keeps its database and files there (release builds ignore both). Testing on a copy of real data, and the system credential store, which cannot be redirected, are covered in `src-tauri/src/legacy_names.rs`.

### Project layout

```
src/                     React + TypeScript UI
  store.ts               application state (zustand): lists, selection, undo queue, toasts, dialogs
  prefs.ts               settings model, All-accounts defaults and per-account overrides
  api.ts                 typed wrappers over the Tauri commands
  i18n/                  translations: index.ts (`t()`, language choice), ns/*.ts (one dictionary per area, English / Vietnamese / French side by side)
  backendErrors.ts       shows the errors the Rust side sends as `CODE: text` in the language in use
  components/            folder pane, message list, reading pane, composer, search, settings, …
  devMock.ts, fakeMail.ts  mock backend for browser previews, generated sample mail
src-tauri/src/           Rust backend
  lib.rs                 commands, sync workers, search, threading, delayed actions
  mail.rs                IMAP: folders, fetch, flags, move, parsing (MIME, attachments, inline images)
  smtp.rs                message building and sending
  ical.rs, calendar.rs   iCalendar parsing and writing, repeat rules, events, invitations and replies
  oauth.rs               Google and Microsoft OAuth 2.0 (PKCE, loopback redirect) and token refresh; mail and calendar are separate grants
  calsync/               calendar sync with online calendars: provider trait (mod.rs), local model + apply (store.rs), rounds, scheduler and
                         back-off (engine.rs), writes with etags (write.rs), commands + consent + worker (cmds.rs), google.rs, microsoft.rs, http.rs; fake.rs / fake_http.rs for tests
  discover.rs            server-settings lookup (presets, autoconfig, ISPDB, DNS SRV / MX)
  winframe.rs            custom title bar on Windows: caption-button hit-testing (Snap Layouts), system menu
  shell.rs               tray icon, badges, native notifications, snooze reminders
  i18n.rs                the few texts the operating system shows (tray menu, notifications, repeat descriptions) in en / vi / fr, and `coded()` for errors the UI translates; i18n/<code>.rs holds the same texts of each later language
  update.rs              updates: check (GitHub latest.json through the updater plugin), signed download with progress, install, restart
  ai.rs                  OpenAI-compatible chat client
  db.rs                  SQLite schema and settings storage
```

### Translations

The UI is in English, Vietnamese, French, Simplified Chinese, Spanish, Japanese, German and Russian (Settings > General > Language, also the globe button in the top bar and the first-run Welcome screen; the default is English, for every user, and the language of the computer is never used).

- Every text the person reads is a key in `src/i18n/ns/<area>.ts`: `t("settings.general.language")`, with `{name}` for values and plural entries (`{ one, other }`, parameter `{n}`; see Plurals below). A component calls `const t = useT()` once so it follows a language change; dates and numbers go through `src/i18n/format.ts` (or `Intl` with `intlLocale()`), never a hard-coded locale.
- Add the English, Vietnamese and French text in the same dictionary (`ns/<area>.ts`): a key missing in one of them fails `npx tsc --noEmit`. The other languages have their own files (below); after adding keys run `node --experimental-strip-types scripts/i18n-new-language.mjs --sync` once: it appends the new keys, with the English text as a placeholder, to every `src/i18n/locales/<code>/<area>.ts` so `tsc` passes, and the translators pick them up later (`scripts/i18n-status.mjs` lists them).
- `node --experimental-strip-types scripts/test-i18n.mjs` (also in CI) checks that every language has the same keys and `{placeholders}` as English, the plural forms it needs, no empty text, the French-only spacing rules (no-break space before `: ; ! ? »`), that no key is unused, that every error code of the Rust side has a sentence, and that no new hard-coded English appears in `src/` (a deliberate exception gets a comment `// i18n-ok: why`).
- `npm run dev` (browser preview) offers a pseudo-language, "Pseudo-locale (dev)" in Settings > General > Language (or `#lang=en-XA` in the address): every translated text is longer, accented and in brackets, so text that is not translated, or does not fit, shows at a glance.
- Errors from Rust: `i18n::coded("CODE", &[("name", value)], "English text")` (or `"CODE: English text"`), and the sentence goes into `src/i18n/ns/backend.ts` as `backend.CODE`. Texts that only the operating system can show (tray, notifications) are in `src-tauri/src/i18n.rs`; the UI mirrors its language there as the setting `ui_language`.
- **File layout.** English, Vietnamese and French sit side by side in `src/i18n/ns/<area>.ts` (one file per area: common, app, mail, settings, compose, pgp, reading, calendar, errors, updates, backend, signin; gathered by `en.ts` / `vi.ts` / `fr.ts`). Every other language has its own folder, so translators of different languages never edit the same file and never conflict:
  ```
  src/i18n/locales/<code>/<area>.ts   one file per area, same names as ns/; typed: a missing or extra key fails `npx tsc --noEmit`
  src/i18n/locales/<code>/index.ts    gathers the files (only touched when a new area is added in ns/)
  src/i18n/locales/<code>/keep.json   keys whose text is the same as English on purpose (a JSON array)
  src-tauri/src/i18n/<code>.rs        the texts the operating system shows: tray menu, notifications, reminder titles, file dialogs, repeat descriptions
  ```
  Codes: `zh-Hans` (folder `zh-Hans`, Rust file `zh_hans.rs`), `es`, `ja`, `de`, `ru`. A new file starts as a stub: the first line is `// STUB: English placeholders, to be translated` and every text is the English one.
  Vietnamese and French, which live in `ns/`, list the texts that are the same as English on purpose (French "Agenda", "Notifications", "SMS") in `src/i18n/ns/keep.json` (`{ "vi": [...], "fr": [...] }`); `test-i18n.mjs` fails on an entry that is not a key or that is translated.
- **A translator takes one language** and edits only its files: translate each value in `src/i18n/locales/<code>/*.ts` (keys, `{placeholders}` and the structure stay as they are), then the strings in `src-tauri/src/i18n/<code>.rs` (the word order and plural rules of the Rust functions are the translator's to change). Delete the `// STUB` line of a file when all of it is translated. Words that really are the same as English ("OpenPGP", a product name) are recognised automatically; for another one add its key to `keep.json`. Check your work:
  - `npx tsc --noEmit` (keys), `node --experimental-strip-types scripts/test-i18n.mjs` (placeholders, plural forms, empty texts) and `cd src-tauri && cargo test --lib i18n`;
  - `node --experimental-strip-types scripts/i18n-status.mjs --lang=<code> --list` shows what is still English (`--areas` per area). Without `--lang` it prints every language. `--strict` exits 1 while anything is left: the release gate, not part of the normal test run.
- **Plurals.** A plural text is an object with the forms of the language (CLDR categories, `Intl.PluralRules` picks the form for `{n}`; a form that is missing falls back to `other`): `{ one: "{n} message", other: "{n} messages" }` in English, German, Spanish and French (French uses `one` for 0 and 1); Russian `one` (1, 21, 31 ...), `few` (2-4, 22-24 ...), `many` (0, 5-20, 25-30 ...), `other` (fractions); Japanese and Chinese `other` only (`{ other: "{n}件" }`). The forms each language must have are `plural` in its registry entry; `test-i18n.mjs` fails on a missing or unknown form. Every form keeps the same `{placeholders}` (a form may leave out `{n}`). In Rust the translator writes the plural rules by hand in `<code>.rs`.
- **Dates and the calendar** use the date-fns locale (`DF` in `format.ts`) and `Intl` with the language's `intl` tag. The code asks for English date-fns patterns (`"d MMM yyyy"`); a language that writes them differently lists the replacements in `fmt.patterns` of its registry entry (Japanese: `"d MMM yyyy"` becomes `"yyyy年M月d日"`). Other per-language choices are in the same `fmt` object (`weekdayShort` for the calendar columns and `weekdayText` for dates in lists and sentences, `capitalMonthTitle`, `intlRanges` / `rangeMonth` or `dayRange` for week and all-day ranges, `dayPeriodsFromDict` for am/pm); the first day of the week is the user's setting, not the language's. No component compares a language code. The CSS picks the CJK fonts and the strict line breaking (`line-break: strict`, `word-break: auto-phrase` for Japanese) with `:lang(zh-Hans)` / `:lang(ja)` in `App.css`. The 12-hour clock is the user's setting (24 h by default in every language). **Known limit:** the native date and time fields (`<input type="date">`, `type="time"`) of the event dialog and the scheduling picker follow the operating system / browser locale, not the app language (a `lang` attribute does not change them in Chromium); everything the app writes itself follows the app language.
- **Review sheets.** `node --experimental-strip-types scripts/i18n-export-tsv.mjs <code> <target-dir>` writes key / English / translation as TSV files of about 12 KB (`--bytes=N`, `--untranslated`), for a proof-read by a person or a model; keep the output outside the repository.
- **Adding a language** (the header menu, the Welcome screen, Settings and the checks all read one list, so no component changes):
  1. `src/i18n/languages.ts`: one entry `{ code, nativeName, englishName, short, dir, sortOrder, intl, plural, fmt? }`. `nativeName` is the language in itself (never translated); `short` is the label of the header button; `plural` the CLDR forms (see above); `dir: "rtl"` is only recorded, no right-to-left layout exists yet. English stays first.
  2. `node --experimental-strip-types scripts/i18n-new-language.mjs <code>` creates `src/i18n/locales/<code>/` (all the files above, from the English dictionaries) and `src-tauri/src/i18n/<code>.rs`, and prints the shared lines still to add: the import and the entry in `DICTS` (`index.ts`), the date-fns locale in `DF` (`format.ts`), and in `src-tauri/src/i18n.rs` the `mod`, the `Lang` variant, the `LANGS` entry, the `parse` arm and the `match` arms that call the new module (the compiler lists what is missing). A missing piece fails `npx tsc --noEmit` or `cargo check`.
  3. `node --experimental-strip-types scripts/test-i18n.mjs` fails when a registry entry has no folder, a folder has no entry, or Rust does not know the code. Past about five languages the Welcome screen shows one button that opens the list instead of a button per language.
- Out of scope: the website, the README, mail content, AI prompts, and invitation / reply e-mails that Hey Look! sends (they are mail content for other people).

### The support reminder (what it stores)
Now and then (about every two months) a small toast says Hey Look! is free and made by one person and offers a link to the support page. Settings > General > "Occasional support reminder" turns it off, as does "Don't remind me again" on the toast. The logic is `src/supportNudge.ts` (pure, tested by `scripts/test-support-nudge.mjs`), the toast is `src/supportNudgeHost.ts`. It stores one object, `supportNudge`, inside the preferences (`settings` table, key `prefs`), on this computer only: nothing is sent anywhere and there is no telemetry.
- `enabled`: the switch (default on).
- `firstRunAt`: when the app was first used, in ms since the epoch. For an install from before the reminder existed it is the creation time of the local database file (`first_run_hint` in `lib.rs`), else the day it first ran with the reminder.
- `nextDueAt`: when the next reminder is due. First: `firstRunAt` plus a random 7 to 30 days, drawn once. After it was shown: two calendar months later; after "Buy me a coffee": six months later.
- `lastShownAt`: when it was last shown (for the record).
A due reminder waits for a calm moment (window focused, open for at least 2 minutes, no message being written, no dialog, no other toast, no send or download under way) and stays due until one comes. In the browser preview (`npm run dev`) `#nudge=now` shows it at once, `#nudge=due` makes it due and lets the real check decide, `#firstrun=90` pretends the database is 90 days old.

### Releasing
1. Bump the version to `X.Y.Z` in `package.json` (and `package-lock.json`), `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` (then `cargo check` updates `Cargo.lock`), and add a `## X.Y.Z — <date>` section to `CHANGELOG.md` (no `xx` left in it).
2. Dry run: Actions > Release > **Run workflow** on the branch (or `gh workflow run release.yml --ref <branch>`). It builds all three platforms and keeps the installers as workflow artifacts; no tag, no release.
3. Tag the commit that passed: `git tag -a vX.Y.Z -m "Hey Look! X.Y.Z" && git push origin vX.Y.Z`. The workflow makes a draft release (notes from `CHANGELOG.md` plus `.github/release-footer.md`), uploads the installers and their updater signatures (`.sig`), writes and checks `latest.json` (the manifest installed apps read), checks all file names and then publishes the release as the latest one. If a build fails nothing is published: use "Re-run failed jobs" for a flaky step, or fix the code, delete the draft and the tag (`gh release delete vX.Y.Z --yes --cleanup-tag`, `git tag -d vX.Y.Z`) and tag again.
4. A published tag is never moved; fixes ship as the next version.

**Signing.** Update packages are signed with a minisign key. The public key is in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`); the private key and its password exist only as the repo secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` and in the owner's backup. Never commit them or paste them anywhere. **If the key or its password is lost, installed apps can no longer update themselves** (people have to install a new build by hand). A tag run fails without the secret; a dry run without it builds unsigned (with a warning). Anyone with write access to the repo can read the secrets through a workflow, so keep write access to the owner.

**Testing the updater.** Run the workflow by hand with the `test_version` input (for example `0.9.0`): it builds a debug test build of that version (unsigned, nothing committed). Add `platforms` (`windows`, `macos`, `linux` or a comma list such as `windows,macos`; default `all`) to build only the system you test, for example `gh workflow run release.yml -f test_version=0.9.0 -f platforms=windows`. A newer manual run of the same kind and platforms on the same ref cancels an older one that is still building; a tag run always builds all three platforms. A debug build reads `HEYLOOK_UPDATE_ENDPOINT` (a URL of a `latest.json`, for example a local server) instead of GitHub; release builds ignore that variable.

### Signing and notarisation
The macOS app is **ad-hoc signed** today: people must allow it once in System Settings > Privacy & Security, and macOS cannot show native notifications for it. The release workflow can sign it with an Apple *Developer ID Application* certificate and have Apple notarise it, but only when the secrets below exist. Without them a run behaves exactly as before (ad-hoc signed, the `Signature=adhoc` check). Windows has its own route (SignPath), described at the end of this section; it is off until you set it up.

**Owner steps (once).**
1. Join the **Apple Developer Program** (developer.apple.com/programs, individual, 99 USD per year; enrolment usually takes 1 to 3 days, longer if Apple asks for identity checks). Your legal name is shown as the developer.
2. In the developer account > Certificates, create a **Developer ID Application** certificate (not "Apple Development", not "Mac App Store"). On a Mac, in Keychain Access > login > My Certificates, expand it, right-click the *key* > Export as a `.p12` and choose a password.
3. Base64 of the `.p12` (one line): `openssl base64 -A -in certificate.p12 -out certificate-base64.txt`.
4. The signing identity is the certificate's full name: `security find-identity -v -p codesigning` prints it, for example `Developer ID Application: Your Name (ABCDE12345)`. The ten characters in brackets are the Team ID.
5. For notarisation create an **App Store Connect API key** (App Store Connect > Users and Access > Integrations > Team Keys, role *Developer*) and download the `.p8` once. Note the *Key ID* and the *Issuer ID* shown above the table. (Alternative without a key: your Apple ID and an app-specific password made at account.apple.com > Sign-In and Security.)
6. Keep the `.p12`, its password and the `.p8` with the updater-key backups. Never commit them or paste them into an issue.
7. Set them yourself in the repo (the values are typed or piped by you, never by an agent):
   ```
   gh secret set APPLE_CERTIFICATE < certificate-base64.txt
   gh secret set APPLE_CERTIFICATE_PASSWORD
   gh secret set APPLE_SIGNING_IDENTITY        # the full name from step 4
   gh secret set APPLE_API_ISSUER              # Issuer ID
   gh secret set APPLE_API_KEY                 # Key ID
   gh secret set APPLE_API_PRIVATE_KEY < AuthKey_XXXXXXXXXX.p8
   gh variable set APPLE_TEAM_ID --body ABCDE12345
   ```
   With the Apple ID alternative set `APPLE_ID` and `APPLE_PASSWORD` (the app-specific password) instead of the three `APPLE_API_*` secrets; `APPLE_TEAM_ID` is needed there.
8. Signing starts when `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD` and `APPLE_SIGNING_IDENTITY` are all set, and notarisation when the `APPLE_API_*` trio (or the Apple ID trio) is set too. A signed run without notarisation credentials warns in the log: such an app is still blocked by Gatekeeper. A group that is only *partly* set (for example the certificate and identity but no password) does not sign: the log warns and names the missing secrets (never values), and with `REQUIRE_MAC_SIGNING` (step 9) on a tag run it fails. `APPLE_TEAM_ID` is required once signing runs (same rule): the check after the build compares it with the Team ID of the signature.
9. When you are ready to ship signed builds only, set the repo variable `REQUIRE_MAC_SIGNING` to `true`: a **tag** run then fails if the macOS app would not be signed and notarised (a dry run still builds without).

**What the workflow does** (step `macOS signing` in `.github/workflows/release.yml`): test builds (`test_version`) are never signed. Otherwise, with the secrets, it exports the `APPLE_*` variables to the build (so a run without secrets has none, not empty ones), writes your identity in place of `-` in `tauri.conf.json` **in the CI checkout only**, and the bundler imports the certificate into a temporary keychain, signs the app, submits it to Apple's notary service and staples the ticket. The updater package (`.app.tar.gz`) and its minisign signature are made from the signed app, so the update signature steps are unchanged. The step is the last one before the build, so `npm ci` and the node scripts never see the secrets; right after the build the step `Remove Apple signing material` deletes the `.p8` key file and the temporary keychain and empties the variables for every later step. The reformatted certificate is masked in the log.

**How to verify.** Run the workflow by hand (dry run, `platforms: macos`) and read the step `Check Developer ID signature and notarisation` (it checks `Authority=Developer ID Application`, your `TeamIdentifier`, `xcrun stapler validate` and `spctl --assess`). On a Mac download the dmg from the dry run's artifacts and run `codesign -dv --verbose=4 "/Applications/Hey Look!.app"` (Authority line `Developer ID Application`), `spctl -a -vv "/Applications/Hey Look!.app"` (`accepted`, `source=Notarized Developer ID`) and `xcrun stapler validate "/Applications/Hey Look!.app"`. The workflow also runs `codesign --verify --deep --strict` (every nested framework and helper must verify, not only the main executable). A dmg that was downloaded with a browser must open without the "Open Anyway" steps. The first update from an ad-hoc signed version to a signed one makes the Keychain ask once, because the app's identity changed.

**The disk image.** The bundler signs the `.dmg` but notarises and staples only the `.app` inside it. The workflow does not notarise the dmg itself: that would mean submitting it to Apple after the build and uploading it again over the draft, with the notary key kept on the runner longer, none of which can be tested without the Apple account. The check step prints, for information only, `spctl -a -t open --context context:primary-signature -vv` and `stapler validate` of the dmg. If on a Mac a browser-downloaded dmg still shows a warning, notarise it by hand or add the step then: `xcrun notarytool submit <dmg> --key AuthKey_XXXXXXXXXX.p8 --key-id <Key ID> --issuer <Issuer ID> --wait`, then `xcrun stapler staple <dmg>`, and upload it to the draft with `gh release upload vX.Y.Z <dmg> --clobber` before the publish job runs (the dmg has no update signature, so the updater is not affected).

### Update signature check
Whatever signing happens (Apple, SignPath, none), every installer that the updater downloads has a minisign signature (`.sig`) that the installed app verifies with the public key in `tauri.conf.json`. A file that changes after it was signed would make **every update fail in every installed app**, silently, until people reinstall by hand. So the workflow checks it with `.github/scripts/verify-update-sigs.cjs` (pure node, no minisign binary; `node .github/scripts/verify-update-sigs.cjs --selftest` runs its tests): in each build job right after the build (signed runs only, because an unsigned dry run has no signatures), and again in the publish job on the files of the draft release, **before** `latest.json` is written and before anything is published. One mismatch, a signature without its file, or fewer than 6 signatures stops the release. By hand: `node .github/scripts/verify-update-sigs.cjs --conf src-tauri/tauri.conf.json <folder with the installers and .sig files>`.

### Windows signing with SignPath (off by default)
Not set up yet: without the settings below the Windows installers are built and published unsigned, exactly as before, and the job and steps below are skipped. The route is the SignPath Foundation (free for open source; you apply at signpath.org). Signing happens **after** the build, so the update signatures are made again afterwards.

**Owner steps (after SignPath accepted the project).** Install the SignPath GitHub App on this repo; in SignPath create the project, an artifact configuration and a signing policy with manual approval (you approve every release there), and a CI user token. The artifact is a zip that holds the two installers at its top level, so the configuration covers `*-setup.exe` (a PE file) and `*.msi`, both Authenticode-signed (see SignPath's documentation for the exact XML). Then set:
```
gh secret set SIGNPATH_API_TOKEN
gh variable set SIGNPATH_ORGANIZATION_ID --body <id>
gh variable set SIGNPATH_PROJECT_SLUG --body <slug>
gh variable set SIGNPATH_SIGNING_POLICY_SLUG --body <slug>
```
All three variables turn it on for tag runs; a dry run signs only when you pass `-f sign_windows=true` (and then waits for your approval). Only part of the three variables set = a warning and no signing; the variables set but no token = a warning (an error with `REQUIRE_WIN_SIGNING`). Test builds are never signed. When you want to ship signed Windows installers only, set the variable `REQUIRE_WIN_SIGNING` to `true`: a tag run then fails early if Windows signing is not configured, and the publish job refuses to publish unless SignPath signed the installers.

**What the workflow does.** The Windows build job keeps the unsigned `-setup.exe` and `.msi` as the workflow artifact `windows-unsigned` (tauri-action has already put them and their old signatures into the draft). The job `sign-windows` hands them to SignPath and waits (up to 2 hours) for your approval, gives the signed files the names of the draft's assets, makes the update signatures again from the signed files (`tauri signer sign`; the updater key is only in that step), runs the signature check above and `Get-AuthenticodeSignature` = `Valid` on both, and uploads them over the draft with `--clobber`. On a dry run the result is the artifact `windows-signed`. The publish job needs `sign-windows`, and its own signature check runs on the draft's final files. Known limit: SignPath cannot sign inside an NSIS installer, so the `hey-look.exe` inside the installer and the uninstaller stay unsigned; the downloaded installer itself is signed, which is what SmartScreen looks at.

**Not verified yet.** The SignPath steps have never run (no account): the action version (`signpath/github-action-submit-signing-request@v3`), its permission needs, the artifact layout and the `tauri signer sign` call are written from the documentation. The first run is a dry run: `gh workflow run release.yml --ref <branch> -f platforms=windows -f sign_windows=true`.

### How it works
- The UI never talks to a mail server. It calls Rust commands; the backend syncs IMAP folders into SQLite, and the UI
  reads from that local database, which keeps lists instant and search offline.
- Archive, delete and junk are queued in the backend and committed after the undo window; the queue is flushed on quit.
- A background thread keeps syncing, shows notifications and updates the badges even when the window is hidden.
