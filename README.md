# Hey Look!

**A fast, private desktop mail client.** Hey Look! connects straight to your mail servers, keeps a local copy of your
mailboxes, and gives you the tools to stay on top of a busy inbox: conversations, snooze, undo for every move,
scheduled sending, powerful search, per-mailbox settings and a calm, polished interface.

Everything is included. There are no plans, tiers, license checks or accounts to create: install it, add your mail
account, and every feature is available.

- Desktop app for Windows 10 / 11 (the primary platform), with macOS and Linux builds, built with Tauri 2 (Rust) and React
- Your mail goes directly between the app and your mail provider, nothing passes through a Hey Look! server
- Open design: IMAP and SMTP, OAuth for Google and Microsoft, any OpenAI-compatible endpoint for the optional AI Assistant

---

## Download

Get the latest version from the [GitHub Releases page](https://github.com/thnonl/hey-look/releases/latest) and install it.

| System | File |
|---|---|
| Windows 10/11 (recommended) | `HeyLook_<version>_windows_x64-setup.exe` |
| Windows (MSI, for managed installs) | `HeyLook_<version>_windows_x64.msi` (does not install WebView2 itself; the setup.exe does) |
| macOS 11+ (Apple silicon and Intel) | `HeyLook_<version>_darwin_universal.dmg` |
| Linux, any distro | `HeyLook_<version>_linux_amd64.AppImage` |
| Debian / Ubuntu | `HeyLook_<version>_linux_amd64.deb` |
| Fedora / openSUSE | `HeyLook_<version>_linux_x86_64.rpm` |

Windows is the primary platform. The macOS and Linux builds are new, have fewer native integrations (tray badge,
notifications), and have not been tested on real hardware by the maintainer.

The installers are not code-signed yet:
- **Windows**: if SmartScreen appears, choose **More info**, then **Run anyway**.
- **macOS**: if the app "can't be opened", open **System Settings > Privacy & Security** and choose **Open Anyway**.

Hey Look! tells you when a newer version is available (Settings > About). You download and install it yourself; the check
can be turned off, see [Where your data lives](#where-your-data-lives).

---

## Highlights

| | |
|---|---|
| **Many mailboxes, one place** | Google and Microsoft (OAuth), iCloud, Yahoo and any IMAP/SMTP server. A combined view or one mailbox at a time. |
| **Conversations** | Messages are threaded; read, flag, pin and snooze whole conversations. |
| **Undo everywhere** | Archive, delete and junk wait a few seconds on the server so you can take them back. Undo send is built in. |
| **Settings that follow you** | One set of defaults for **All accounts**, and any mailbox can override any of them. |
| **Search that goes deep** | Filters, operators, date pickers and a choice of scope: this folder, a whole mailbox, or everything. |
| **Quiet by design** | Smart notifications, a calm unread badge, a tray icon that keeps working when the window is closed. |
| **Private by default** | Remote images and trackers are blocked, passwords stay in Windows Credential Manager, no telemetry. The only call of its own is the check for a newer version (it asks github.com; you can turn it off). |

---

## Features

### Mailboxes and sync
- Add Google and Microsoft (Outlook.com, Hotmail, Microsoft 365) accounts with OAuth 2.0 (no password stored), or any account with IMAP/SMTP and an app password
- **Detect settings** finds IMAP / SMTP servers for an address: built-in presets, the provider's autoconfig, the Thunderbird ISPDB, DNS SRV, the MX host, then common host names. Only the domain and address are sent, never the password.
- Servers with a **self-signed or private-CA certificate** (Proton Mail Bridge, company servers) can be trusted per account; a **different SMTP login** can be set when sending uses other credentials
- A background worker keeps syncing while the window is hidden in the tray; each mailbox can have its own interval
- Standard folders (Inbox, Sent, Drafts, Archive, Junk, Deleted) and your own folders, with nesting shown
- Older mail is downloaded as you scroll: near the end of a folder the next 200 messages are fetched (50 at a time), until the server has no more; the Inbox also fills in the background up to 500 messages (the other folders 100 each). Both stop at the **Max emails to download per mailbox** limit (default 2000, up to 5000, counted over all folders of a mailbox; see below), and the list footer then says so. **Load older messages** at the bottom retries after an error. The list only keeps the rows in view, so thousands of messages stay fast
- Favorites, quick views (Unread, Flagged, Pinned, Snoozed, Scheduled) and per-mailbox colors

### Reading
- Focused and Other tabs separate people from newsletters and bulk mail
- Messages are shown in a sandboxed frame with no scripts; remote content is blocked until you allow it
  (once, per mailbox, or always). Allowed images are downloaded by the app itself, so senders never see your webview
- Links whose visible text points somewhere else than where they go trigger a warning
- Attachments: save one or all, inline images shown in the message
- Newsletter detection with **one-click unsubscribe** (RFC 8058) and a mailto fallback
- View the original source, print, translate with the AI Assistant, expand or collapse a whole thread

### Writing
- Rich-text editor, Cc/Bcc, recipient chips with address checking and keyboard-friendly suggestions
  (people who wrote to you and people you wrote to)
- Attach by button, drag and drop or paste; a warning when the total goes over the usual 25 MB limit
- Signatures and templates, shared by all accounts or specific to one
- **Undo send**, **Send later** (presets or any date and time) and draft saving to the server
- Ctrl+Enter sends; opening another message while you are writing asks before it replaces your draft

### Calendar
- **Invitations** (iMIP, `text/calendar` and `.ics` files) show a card in the reading pane: time in your zone, place, organizer,
  attendees and conflicts. **Accept / Tentative / Decline** send a proper reply from the right account (with an optional note);
  updated and cancelled invitations are recognised, and a reply to your own invitation updates the attendee list.
- A local calendar (Mail | Calendar switch, `Ctrl+1` / `Ctrl+2`) with **Month, Week and Agenda** views, repeating events
  (read-only series), reminders, import and export of `.ics`. New events can invite people (sent as a calendar invitation), and the
  **Meeting** switch in the composer turns a message into an invitation. No CalDAV or Exchange sync.

### Organizing
- Archive, delete, move to any folder, junk, block sender, pin, flag, mark read/unread, **snooze** with your own times
- **Filters** (rules) that run on new mail, per mailbox or for all
- **Sweep**: clean the inbox sender by sender (archive, delete, mark read or block everything from one sender)
- Hover actions on every conversation, configurable; bulk selection with Select all

### Search
- Search box with a panel for scope, filters (unread, flagged, pinned, has attachment), dates, From/To/Subject
- Operators you can also type: `from:` `to:` `subject:` `body:` `folder:` `is:unread|read|flagged|pinned`
  `has:attachment` `after:2026-01-31` `before:` `after:7d`, and `"quoted phrases"`
- Results show which folder each conversation lives in; recent searches are remembered
- Only downloaded mail is searched. At the end of the results (or when there are none), **Search in <webmail>** appears for each mailbox whose webmail is known: Gmail, Outlook, Microsoft 365, Yahoo, iCloud, Fastmail and Zoho (a custom server gets no button). **Gmail** opens the same search directly, with the operators translated. The others have no search link, so the search text is copied and the webmail opens: paste it into its search box (operators the webmail is not known to understand are left out)

### Notifications and tray
- Native Windows notifications with up to three action buttons (Archive, Delete, Mark as read, Flag, Reply, Snooze)
- Per-mailbox switch, sound, preview and buttons; smart mode skips newsletters
- Snooze reminders when a conversation comes back
- Tray icon with an unread badge (number, dot or off), tray menu (open, new mail, check now, pause, quit)
  and a taskbar badge. Unread counts are conversations, and bulk mail can be left out
- Optional start with Windows, minimized to the tray

### Updates
- **Hey Look! updates itself after you agree.** It checks automatically when the app starts or comes back from the tray (at most every 6 hours, can be turned off) and on demand in Settings > About. A newer version shows a dot on the Settings button, one toast per version, and a card with the release notes. **Download and install** downloads the update with a progress bar while you keep working, checks its signature, and restarts Hey Look! into the new version (after a 5 second countdown you can cancel). If you are writing a message it asks first and saves your message as a draft; **Later** installs the update when you quit. **Skip this version** hides the notice for that version.
- Only GitHub is asked, and nothing is downloaded until you agree. Every update package is signed; the app refuses anything that does not match its built-in public key

### Appearance
- Light, dark or follow Windows; three densities; reading pane on the right or bottom; resizable panes
- **Primary color**: choose a preset or any color; dark mode derives a lighter shade automatically
- A live preview made from generated sample mail shows every choice before you commit
- Text size, date and time formats, command bar (Ctrl+K)
- **Windows**: the top bar is the title bar (drag, double-click to maximize, right-click for the system menu, Snap Layouts on Windows 11, `F11` full screen); macOS and Linux keep the system title bar

### AI Assistant (optional)
Summaries, translation and a "Write with AI" helper in the composer. It talks only to the endpoint you configure
(any OpenAI-compatible API, including local servers). The key is stored in Windows Credential Manager.

---

## Settings that follow your mailboxes

Open **Settings → Mailboxes**.

- **All accounts** holds the defaults: composing options, signatures, templates, filters, notifications, remote
  content and sync interval, favorites.
- Each **account** has the same pages. A setting you change there is marked **Custom** and overrides the All accounts
  value for that mailbox only; untouched settings are marked **Same as All accounts** and follow any later change.
- **Reading & sync → Max emails to download per mailbox** (500 / 1000 / 2000 / 5000, default 2000) is one value for every
  mailbox, counted per mailbox over all its folders. The fewer mails, the less disk space they use and the better the app
  performs. It limits the background download and scrolling for older mail; new mail always arrives. When a mailbox is over the limit, the
  oldest mails (by date, any folder) are removed **from this computer only** as new mail arrives; they stay on the server, and
  Drafts, flagged mail, pinned or snoozed conversations and the newest message of each folder are kept. Lowering the limit
  trims the excess at the next arrival; raising it lets older mail download again.
  **Reset** goes back to inheriting.
- Signatures, templates and filters can belong to All accounts or to one mailbox; a mailbox sees its own plus the shared ones.

App-wide options (appearance, tray, shortcuts, AI Assistant, blocked senders) live in their own pages.

---

## Keyboard shortcuts

| Key | Action | Key | Action |
|---|---|---|---|
| `c` | New mail | `r` / `a` / `f` | Reply / Reply all / Forward |
| `/` | Search | `e` | Archive |
| `j` / `k` | Next / previous conversation | `#` or `Delete` | Delete |
| `s` | Snooze | `!` | Move to Junk |
| `p` | Pin | `*` | Flag |
| `u` | Mark unread | `Ctrl+A` | Select all |
| `Ctrl+K` | Command bar | `Ctrl+Enter` | Send (while writing) |
| `F5` | Sync now | `Esc` | Close, deselect |
| `F11` | Full screen (Windows) | | |
| `Ctrl+1` / `Ctrl+2` | Mail / Calendar | `c` `t` `m` `w` `a` `←` `→` | Calendar: new event, today, month / week / agenda, previous / next |

---

## Getting started

1. Run `Hey Look!.exe` (or install a build, see below).
2. On the welcome screen choose **Sign in with Google**, **Sign in with Microsoft** or **Other email account**.
   - Google and Microsoft: the app needs an OAuth client, see [Configuration](#configuration).
   - iCloud and Yahoo need an **app password**. Apple offers no OAuth for third-party mail apps, so iCloud cannot use a sign-in window.
3. Your mail downloads in the background. Closing the window keeps Hey Look! running in the tray; use **Quit** in the tray menu to exit. (Turn off "Keep running in the tray when the window is closed" in Settings and the close button quits instead, after asking when scheduled messages are waiting.)

### Where your data lives
- Mail cache and settings: `%APPDATA%\thnonl.heylook\heylook.db` (SQLite)
- Passwords, OAuth tokens, the AI key and the OAuth client secrets: Windows Credential Manager (entries named `hey-look…`)
- Nothing is sent anywhere except to your mail servers, Google's and Microsoft's sign-in services, the Thunderbird ISPDB and your own domain's autoconfig URL when you press **Detect settings**, the AI endpoint you configure, and github.com for the update check (GitHub sees your IP address; when you agree to update, the installer is downloaded from github.com). Turn the check off in Settings > About, "Check for updates automatically", and no automatic request is made.

---

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

**Testing the updater.** Run the workflow by hand with the `test_version` input (for example `0.9.0`): it builds a debug test build of that version (unsigned, nothing committed). A debug build reads `HEYLOOK_UPDATE_ENDPOINT` (a URL of a `latest.json`, for example a local server) instead of GitHub; release builds ignore that variable.

### How it works
- The UI never talks to a mail server. It calls Rust commands; the backend syncs IMAP folders into SQLite, and the UI
  reads from that local database, which keeps lists instant and search offline.
- Archive, delete and junk are queued in the backend and committed after the undo window; the queue is flushed on quit.
- A background thread keeps syncing, shows notifications and updates the badges even when the window is hidden.

---

## Known limitations

- Windows is the primary and supported platform; tray, notifications and badges use Windows APIs. The macOS and Linux builds are build-verified only (not tested on real hardware) and have fewer native integrations
- The installers are not code-signed (see [Download](#download) for how to open them)
- Updating needs permission on some systems: MSI installs ask for administrator rights (UAC), `.deb` and `.rpm` installs ask for your password. If an update cannot be installed, the app offers the download from GitHub instead
- Mail is fetched by polling (default every 2 minutes), not IMAP IDLE push
- Search covers mail downloaded to this computer
- No shared inboxes; the calendar is local (no CalDAV / Exchange sync, single occurrences of a repeating event can't be edited)
- Meeting updates and cancellations are accepted when the From address matches the stored organizer. There is no DKIM / SPF / S/MIME check on the invitation and SENT-BY is not honoured, so a forged From address that equals the organizer can still change or cancel an event you received; mail providers normally reject such spoofing
- The interface is English only
