# Hey Look!

A fast, private desktop mail client for Windows, macOS and Linux. Free and open source, no ads, no account needed.

[![Hey Look! intro](docs/media/preview.gif)](https://thnonl.github.io/hey-look/#film)

[Watch the full intro video with sound](https://thnonl.github.io/hey-look/#film)

**Website:** https://thnonl.github.io/hey-look/ · **Help and FAQ:** https://thnonl.github.io/hey-look/help.html

## Download

Get the latest version from [GitHub Releases](https://github.com/thnonl/hey-look/releases/latest) or the [download page](https://thnonl.github.io/hey-look/download.html).

- **Windows 10 / 11:** `HeyLook_<version>_windows_x64-setup.exe` (or `.msi`)
- **macOS 11+ (Apple silicon and Intel):** `HeyLook_<version>_darwin_universal.dmg`
- **Linux:** `HeyLook_<version>_linux_amd64.AppImage` or `.deb` (`.rpm` for Fedora / openSUSE)

## Highlights

- Many mailboxes in one place: Google and Microsoft (OAuth), iCloud, Yahoo, any IMAP/SMTP server
- New Inbox mail arrives at once (push, IMAP IDLE) when the server supports it, otherwise it is polled
- Undo send, send later, snooze, filters and sweep by sender
- OpenPGP encryption and signing; calendar invitations with a local calendar, and optional two-way sync with Google Calendar and Outlook / Microsoft 365 calendars (turn it on per mailbox)
- Writing: an Outlook-like rich-text editor (fonts and sizes, colours and highlight, lists, styles, alignment, text direction, tables, pictures, links, emoji and symbols, find and replace, change case, zoom), paste options (keep source formatting, merge, text only), replies that quote the original in a protected block with its look kept, signatures and templates with pictures, High or Low importance, and Preview as recipient (Light or Dark)
- Nothing you write is lost: the message is saved to Drafts about every 30 seconds, a copy is kept on your computer, and after a crash the next start offers to restore it
- Windows of their own: write a message (Shift+click New mail, Reply or Forward, double-click a draft, or Pop out with Ctrl+Shift+O) or read a conversation (double-click it) in a window of its own; up to 8 windows. Settings > Composing makes a window the normal way
- A side menu that folds to a column of icons (Ctrl+B / Cmd+B) and folds by itself in a narrow window; mailboxes in your own order (drag, or Alt+Up and Alt+Down) with a Display name; a right-click menu on conversations and on text
- Confidential mail: a message marked Confidential is protected while it is open (no copy or print, and no screen capture on Windows and macOS; Linux does not block screen capture), and the composer has a Confidential button
- Eight languages: English (the default), Tiếng Việt, Français, 中文（简体）, Español, 日本語, Deutsch and Русский; switch in the header, in Settings > General or on the Welcome screen. The language is the one you choose, never taken from your computer's. The website is available in the same eight languages
- Date and time fields that follow your language and the 12 / 24 hour setting
- Mail is shown on its original background in every theme; a button in the reading pane switches it to dark and remembers your choice
- macOS: the Dock icon shows the unread number
- AI Assistant (optional, your own endpoint): summarize, translate (long mail is translated in parts of about 8,000 characters, up to 60,000, with Cancel) and write with AI; when it cannot work, a message stays on screen and opens the setting to fix
- Command bar (`Ctrl/Cmd+K`), keyboard shortcuts, light and dark themes with your own colour (the top bar follows it in the dark theme)
- Signed in-app updates that ask first; no ads, no analytics, no account
- Your mail stays on your computer, passwords in your system's credential store

## Keyboard shortcuts worth knowing

`Ctrl` is `Cmd` on a Mac. The command bar (`Ctrl+K`) lists every command; Settings > Shortcuts has the list.

| Keys | Action |
|---|---|
| `Ctrl+B` | Fold or open the side menu (not while writing) |
| `Ctrl+K` | Command bar; in the text of a message you write: add or edit a link |
| `Shift+C`, `R`, `A`, `F` | New mail, Reply, Reply all, Forward in a window of its own |
| `Shift+Enter` | Open the selected conversation in a window of its own |
| `Ctrl+Shift+O` | Move the message you are writing to a window of its own |
| `Ctrl+F`, `Ctrl+H` | Find, Replace (in the message you write) |
| `Shift+F3` | Change case: lowercase, UPPERCASE, Capitalize Each Word |
| `Ctrl+Shift+V` | Paste as text only |
| `Ctrl+]`, `Ctrl+[` | Larger, smaller font |
| `Alt+F10` | Go to the formatting toolbar |
| `Shift+F10` or the Menu key | Open the context menu at the selection |
| `Alt+Up`, `Alt+Down` | Move the selected mailbox up or down |

## First launch

- **Windows:** if SmartScreen appears, choose **More info**, then **Run anyway**.
- **macOS:** the app is not notarized by Apple, so macOS blocks its first start once:
  1. Open the `.dmg`, drag **Hey Look!** to **Applications**, and start it from **Applications** (not from the disk image).
  2. macOS says “Hey Look!” Not Opened (or “can’t be opened”). Click **Done**, not **Move to Trash**.
  3. Open **System Settings > Privacy & Security**, scroll to **Security**, click **Open Anyway** next to the message about Hey Look!, confirm with your password or Touch ID, then click **Open**.

  You do this only once; versions that Hey Look! installs itself start normally. The app is signed with a fixed, self-signed certificate (no Apple account behind it), so macOS keeps remembering which app may read your saved passwords from the Keychain across updates; the first start after updating from a version before 1.0.6 asks about it one more time. This is not notarization: the **Open Anyway** step above is still needed. If you use Terminal, instead of steps 2 and 3 you can run `xattr -dr com.apple.quarantine "/Applications/Hey Look!.app"` once.
- **Linux:** links and attachments open with `xdg-open` (package `xdg-utils`), so a default browser and app must be set.

## Where your data lives

- Mail cache and settings: `%APPDATA%\thnonl.heylook\heylook.db` (macOS `~/Library/Application Support/thnonl.heylook/`, Linux `~/.local/share/thnonl.heylook/`)
- Passwords, OAuth tokens, the AI key: Windows Credential Manager, macOS Keychain or the Linux Secret Service (GNOME Keyring, KWallet; it must be running and unlocked)
- The AI Assistant sends text only when you press a button, to the endpoint you configure: up to 24,000 characters of a conversation for a summary, up to 60,000 characters of a message for a translation (in parts of about 8,000), and for Write with AI your draft, the subject and, for a reply, up to 6,000 characters of the message you reply to. Decrypted OpenPGP content is sent too if you ask about it.
- A recovery copy of the message you are writing is kept in the local database until it is saved, sent or discarded (none for a message with Encrypt on).
- Hey Look! contacts only your mail servers, the sign-in and server-lookup services you use, the AI endpoint you configure, the sites behind images you allow or links you press, and github.com for the update check (can be turned off).
- Only for a mailbox where you turn on calendar sync (Settings > Mailboxes > your mailbox > Calendar): `www.googleapis.com` (Google Calendar) or `graph.microsoft.com` (Microsoft Graph, for Outlook.com, Hotmail and Microsoft 365) to download its calendars and to save the events you add, change, delete or answer. The calendar sign-in is a separate permission with its own token in the credential store (`<mailbox>:calendar`); turning sync off removes the calendars from this computer and deletes the token, nothing changes in Google Calendar or Outlook.

### Calendar sync with Google or Microsoft (optional)

Turn it on per mailbox: **Settings > Mailboxes > (mailbox) > Calendar > Sync calendar with Google** (or **with Microsoft** for Outlook.com, Hotmail and Microsoft 365). Your browser opens Google's or Microsoft's own permission page for the calendar only; your mail sign-in is not touched. The permissions (the exact ones the consent page shows):

- Google: `https://www.googleapis.com/auth/calendar.events` (see and edit events on all your calendars), to show your events in the app and to save the ones you create, change, delete or answer back to Google Calendar; `https://www.googleapis.com/auth/calendar.calendarlist.readonly` (see the list of your calendars), to list your calendars with their names and colours so you can choose which ones to sync.
- Microsoft: `Calendars.ReadWrite` (Microsoft Graph, delegated), with `offline_access`, `openid`, `email` and `profile` to stay signed in and to check the address, for the same purpose. It needs no admin consent for your own calendars; a work or school organization that restricts apps may still ask an administrator to approve Hey Look!, and the app then says so. Only your own calendars are listed, not those shared with you.

Calendar data stays on your computer and goes only between this computer and Google Calendar or Microsoft Graph; the developer runs no server and the AI Assistant never gets calendar data. Hey Look!'s use of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

What syncs: your calendars, events from a year ago (Microsoft: to two years ahead), every 5 minutes while the app runs and when you press **Sync now**. Single events can be added, changed and deleted from Hey Look! (Google or Outlook sends the invitations to guests); repeating events and events somebody else organizes are shown but can only be changed in Google Calendar or Outlook for now. Offline, the saved events stay visible and changes need a connection.

## Known limitations

Details and more in the [Help](https://thnonl.github.io/hey-look/help.html).

- **macOS:** no native notifications (they need an Apple Developer ID, which the project does not have yet, and macOS may not show banners for a self-signed app); the app is signed with the project’s own self-signed certificate (not an Apple one), not notarized. PDF files open in your default app (the preview offers Open and Save as). A pop-out window that you close leaves a small, invisible native window entry behind (about 1.4 MB each) until you quit the app.
- **Installers** are not code-signed with a publisher certificate yet; on Windows the tray Quit, running the installer over an open app and opening links in the browser were not tested on this release.
- **Linux:** tested on a KDE desktop in an ARM virtual machine; the x86_64 packages (AppImage, .deb, .rpm) are built the same way but are not covered by that test. It needs a notification service for notifications. PDF files open in your default app (the preview offers Open and Save as). A Confidential message is not protected from screen capture. The tray icon has no click action (the desktop's indicator service does not pass clicks on): open the window with **Open Hey Look!** in the tray menu.
- **Google:** Google has not finished reviewing Hey Look!, so its sign-in page says “Google hasn’t verified this app” (choose **Advanced**, then **Go to Hey Look! (unsafe)**), and until the review is done **Sign in with Google and Google calendar sync are limited to the first 100 people**. Gmail also works with an app password. What to expect, and what to do: [Help](https://thnonl.github.io/hey-look/help.html#google-review).
- **Calendar:** local events plus optional two-way sync with Google Calendar and Outlook / Microsoft 365 (per mailbox); repeating events from those calendars are read-only; CalDAV sync may come later. Some work or school organizations only let an administrator approve the Microsoft calendar permission. The sync was tested against simulated Google and Microsoft servers; a check with real accounts is still to be done.
- **Languages:** the texts of every language except English (Vietnamese, French, Chinese, Spanish, Japanese, German, Russian) were written with AI help and have not been reviewed by native speakers yet, so they may contain mistakes. The Windows installer and the system menu items of macOS are not translated by Hey Look!.
- **Writing:** there is no plain-text-only mode. Format Painter, AutoFormat and the mini toolbar are not included yet.
- **Folders:** Archive and Delete create an Archive or Trash folder when the server has none and allows it (a filter does not create folders; it reports the missing one). Drafts is not created. Sent is created for the copy of a sent message when the server has none.
- **OpenPGP secret keys** are stored in the app's own database, protected by their passphrase, not in the system credential store.
- **Undo send** does not survive a normal Quit: the message is sent at once. A message you are writing is saved to Drafts by itself about every 30 seconds while it changes, and a copy is kept on your computer every few seconds. If Hey Look! is closed by force (an installer, Task Manager, a crash) while you are writing, or on macOS when you log out, restart or shut down, the next start asks "Restore your unsaved message?" (Restore, Discard or Not now); what you typed in the last few seconds before the end may be missing, and a message with Encrypt on is not copied to the disk, so it is only as safe as its last draft (Settings > Mailboxes > Security > Encrypt drafts). A message you already sent is kept and goes out at the next start.
- **Windows:** overlay tools (for example RivaTuner Statistics Server) can crash the web view; Hey Look! restarts itself at most three times in ten minutes; exclude `hey-look.exe` and `msedgewebview2.exe` there.
- Mail servers must offer SSL/TLS or STARTTLS; new Inbox mail is delivered by IMAP IDLE (push) when the server supports it, otherwise mail is polled (every 2 minutes by default). While push works, the other folders are checked every 10 minutes. Settings > Mailboxes > Reading & sync has the interval and a push switch (off = polling only). Push was tested with test mail servers, not with every provider; if a provider misbehaves, turn it off there.

## Build

```bash
npm install
npm run tauri dev                      # run the desktop app
npm run tauri build -- --no-bundle     # release executable
npm run tauri build                    # release plus installers
cargo check --manifest-path src-tauri/Cargo.toml
```

OAuth clients, the code layout, releasing and how it works: [CONTRIBUTING.md](CONTRIBUTING.md).

## Support the project

Hey Look! is free. If it helps you, you can [buy me a coffee](https://thnonl.github.io/hey-look/support.html): on [Ko-fi](https://ko-fi.com/namthnonl) or by bank transfer (the same link is under Settings > About). Hey Look! may show a small reminder about this about once every two months; Settings > General > Occasional support reminder turns it off.

## Security

Please report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

## License

MIT, free to use: see [LICENSE](LICENSE).
