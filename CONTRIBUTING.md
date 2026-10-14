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

Copy `.env.example` to `.env` (it is git-ignored) and fill in the values. While the OAuth consent screen is in
*Testing* mode Google expires refresh tokens after 7 days; publish the app to avoid that.

### Microsoft

Microsoft sign-in (Outlook.com, Hotmail, Live, Microsoft 365) needs an app registration in Microsoft Entra
(portal.azure.com → App registrations):

1. Supported account types: **personal Microsoft accounts and accounts in any organizational directory**.
2. Authentication → add platform **Mobile and desktop applications** with redirect URI `http://localhost` (the port is ignored), and allow public client flows.
3. API permissions → Office 365 Exchange Online (delegated): `IMAP.AccessAsUser.All`, `SMTP.Send`, plus `offline_access`.
4. Copy the Application (client) ID. No secret is needed.

Provide it the same three ways as Google:

| Variable | Meaning |
|---|---|
| `MICROSOFT_CLIENT_ID` | Application (client) ID |
| `MICROSOFT_CLIENT_SECRET` | Optional, only for confidential clients (not shown in the app) |

The **Tenant** field in the Microsoft tab is typed in the app (empty = `common`, personal and work accounts); enter a tenant ID or domain only for a
single-tenant app registration, which personal accounts cannot use.

Work and school tenants may block IMAP / SMTP AUTH until an admin enables it for the mailbox.

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
  components/            folder pane, message list, reading pane, composer, search, settings, …
  devMock.ts, fakeMail.ts  mock backend for browser previews, generated sample mail
src-tauri/src/           Rust backend
  lib.rs                 commands, sync workers, search, threading, delayed actions
  mail.rs                IMAP: folders, fetch, flags, move, parsing (MIME, attachments, inline images)
  smtp.rs                message building and sending
  ical.rs, calendar.rs   iCalendar parsing and writing, repeat rules, events, invitations and replies
  oauth.rs               Google and Microsoft OAuth 2.0 (PKCE, loopback redirect) and token refresh
  discover.rs            server-settings lookup (presets, autoconfig, ISPDB, DNS SRV / MX)
  winframe.rs            custom title bar on Windows: caption-button hit-testing (Snap Layouts), system menu
  shell.rs               tray icon, badges, native notifications, snooze reminders
  update.rs              updates: check (GitHub latest.json through the updater plugin), signed download with progress, install, restart
  ai.rs                  OpenAI-compatible chat client
  db.rs                  SQLite schema and settings storage
```

### Releasing
1. Bump the version to `X.Y.Z` in `package.json` (and `package-lock.json`), `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` (then `cargo check` updates `Cargo.lock`), and add a `## X.Y.Z — <date>` section to `CHANGELOG.md` (no `xx` left in it).
2. Dry run: Actions > Release > **Run workflow** on the branch (or `gh workflow run release.yml --ref <branch>`). It builds all three platforms and keeps the installers as workflow artifacts; no tag, no release.
3. Tag the commit that passed: `git tag -a vX.Y.Z -m "Hey Look! X.Y.Z" && git push origin vX.Y.Z`. The workflow makes a draft release (notes from `CHANGELOG.md` plus `.github/release-footer.md`), uploads the installers and their updater signatures (`.sig`), writes and checks `latest.json` (the manifest installed apps read), checks all file names and then publishes the release as the latest one. If a build fails nothing is published: use "Re-run failed jobs" for a flaky step, or fix the code, delete the draft and the tag (`gh release delete vX.Y.Z --yes --cleanup-tag`, `git tag -d vX.Y.Z`) and tag again.
4. A published tag is never moved; fixes ship as the next version.

**Signing.** Update packages are signed with a minisign key. The public key is in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`); the private key and its password exist only as the repo secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` and in the owner's backup. Never commit them or paste them anywhere. **If the key or its password is lost, installed apps can no longer update themselves** (people have to install a new build by hand). A tag run fails without the secret; a dry run without it builds unsigned (with a warning). Anyone with write access to the repo can read the secrets through a workflow, so keep write access to the owner.

**Testing the updater.** Run the workflow by hand with the `test_version` input (for example `0.9.0`): it builds a debug test build of that version (unsigned, nothing committed). Add `platforms` (`windows`, `macos`, `linux` or a comma list such as `windows,macos`; default `all`) to build only the system you test, for example `gh workflow run release.yml -f test_version=0.9.0 -f platforms=windows`. A newer manual run of the same kind and platforms on the same ref cancels an older one that is still building; a tag run always builds all three platforms. A debug build reads `HEYLOOK_UPDATE_ENDPOINT` (a URL of a `latest.json`, for example a local server) instead of GitHub; release builds ignore that variable.

### How it works
- The UI never talks to a mail server. It calls Rust commands; the backend syncs IMAP folders into SQLite, and the UI
  reads from that local database, which keeps lists instant and search offline.
- Archive, delete and junk are queued in the backend and committed after the undo window; the queue is flushed on quit.
- A background thread keeps syncing, shows notifications and updates the badges even when the window is hidden.
