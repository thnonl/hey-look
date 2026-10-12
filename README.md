# Hey Look!

**A fast, private desktop mail client.** Hey Look! connects straight to your mail servers, keeps a local copy of your
mailboxes, and gives you the tools to stay on top of a busy inbox: conversations, snooze, undo for every move,
scheduled sending, powerful search, per-mailbox settings and a calm, polished interface.

Everything is included. There are no plans, tiers, license checks or accounts to create: install it, add your mail
account, and every feature is available.

- Windows 10 / 11 desktop app, built with Tauri 2 (Rust) and React
- Your mail goes directly between the app and your mail provider, nothing passes through a Hey Look! server
- Open design: IMAP and SMTP, OAuth for Google and Microsoft, any OpenAI-compatible endpoint for the optional AI Assistant

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
| **Private by default** | Remote images and trackers are blocked, passwords stay in Windows Credential Manager, no telemetry. |

---

## Features

### Mailboxes and sync
- Add Google and Microsoft (Outlook.com, Hotmail, Microsoft 365) accounts with OAuth 2.0 (no password stored), or any account with IMAP/SMTP and an app password
- A background worker keeps syncing while the window is hidden in the tray; each mailbox can have its own interval
- Standard folders (Inbox, Sent, Drafts, Archive, Junk, Deleted) and your own folders, with nesting shown
- **Load older messages** pages further back than the first download
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

### Notifications and tray
- Native Windows notifications with up to three action buttons (Archive, Delete, Mark as read, Flag, Reply, Snooze)
- Per-mailbox switch, sound, preview and buttons; smart mode skips newsletters
- Snooze reminders when a conversation comes back
- Tray icon with an unread badge (number, dot or off), tray menu (open, new mail, check now, pause, quit)
  and a taskbar badge. Unread counts are conversations, and bulk mail can be left out
- Optional start with Windows, minimized to the tray

### Appearance
- Light, dark or follow Windows; three densities; reading pane on the right or bottom; resizable panes
- **Primary color**: choose a preset or any color; dark mode derives a lighter shade automatically
- A live preview made from generated sample mail shows every choice before you commit
- Text size, date and time formats, command bar (Ctrl+K)

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

---

## Getting started

1. Run `Hey Look!.exe` (or install a build, see below).
2. On the welcome screen choose **Sign in with Google**, **Sign in with Microsoft** or **Other email account**.
   - Google and Microsoft: the app needs an OAuth client, see [Configuration](#configuration).
   - iCloud and Yahoo need an **app password**. Apple offers no OAuth for third-party mail apps, so iCloud cannot use a sign-in window.
3. Your mail downloads in the background. Closing the window keeps Hey Look! running in the tray; use **Quit** in the tray menu to exit.

### Where your data lives
- Mail cache and settings: `%APPDATA%\thnonl.heylook\heylook.db` (SQLite)
- Passwords, OAuth tokens, the AI key and the OAuth client secrets: Windows Credential Manager (entries named `hey-look…`)
- Nothing is sent anywhere except to your mail servers, Google's and Microsoft's sign-in services, and the AI endpoint you configure.

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
| `MICROSOFT_CLIENT_SECRET` | Optional, only for confidential clients |

Work and school tenants may block IMAP / SMTP AUTH until an admin enables it for the mailbox.

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
  oauth.rs               Google and Microsoft OAuth 2.0 (PKCE, loopback redirect) and token refresh
  shell.rs               tray icon, badges, native notifications, snooze reminders
  ai.rs                  OpenAI-compatible chat client
  db.rs                  SQLite schema and settings storage
```

### How it works
- The UI never talks to a mail server. It calls Rust commands; the backend syncs IMAP folders into SQLite, and the UI
  reads from that local database, which keeps lists instant and search offline.
- Archive, delete and junk are queued in the backend and committed after the undo window; the queue is flushed on quit.
- A background thread keeps syncing, shows notifications and updates the badges even when the window is hidden.

---

## Known limitations

- Windows is the supported platform; tray, notifications and badges use Windows APIs
- Mail is fetched by polling (default every 2 minutes), not IMAP IDLE push
- Search covers mail downloaded to this computer
- No end-to-end encryption (PGP), calendar or shared inboxes yet
- The interface is English only
