# Hey Look!

A fast, private desktop mail client for Windows, macOS and Linux. Free and open source, no account needed.

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
- Confidential mail: a message marked Confidential is protected while it is open (no copy, print or screen capture on Windows and macOS), and the composer has a Confidential button
- English (the default), Tiếng Việt and Français: switch in the header, in Settings > General or on the Welcome screen
- Mail is shown on its original background in every theme; a button in the reading pane switches it to dark and remembers your choice
- macOS: the Dock icon shows the unread number
- Command bar (`Ctrl/Cmd+K`), keyboard shortcuts, light and dark themes with your own colour
- Signed in-app updates that ask first; no analytics, no account
- Your mail stays on your computer, passwords in your system's credential store

## First launch

- **Windows:** if SmartScreen appears, choose **More info**, then **Run anyway**.
- **macOS:** the app is not notarized by Apple, so macOS blocks its first start once:
  1. Open the `.dmg`, drag **Hey Look!** to **Applications**, and start it from **Applications** (not from the disk image).
  2. macOS says “Hey Look!” Not Opened (or “can’t be opened”). Click **Done**, not **Move to Trash**.
  3. Open **System Settings > Privacy & Security**, scroll to **Security**, click **Open Anyway** next to the message about Hey Look!, confirm with your password or Touch ID, then click **Open**.

  You do this only once; versions that Hey Look! installs itself start normally. If you use Terminal, instead of steps 2 and 3 you can run `xattr -dr com.apple.quarantine "/Applications/Hey Look!.app"` once.
- **Linux:** links and attachments open with `xdg-open` (package `xdg-utils`), so a default browser and app must be set.

## Where your data lives

- Mail cache and settings: `%APPDATA%\thnonl.heylook\heylook.db` (macOS `~/Library/Application Support/thnonl.heylook/`, Linux `~/.local/share/thnonl.heylook/`)
- Passwords, OAuth tokens, the AI key: Windows Credential Manager, macOS Keychain or the Linux Secret Service (GNOME Keyring, KWallet; it must be running and unlocked)
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

- **macOS:** no native notifications (they need an Apple Developer ID, which the project does not have yet); the app is ad-hoc signed, not notarized; the first-start steps and log out / restart on this exact build were not tested. Only the Quit item of the app menu follows the app language; the other system menu items stay in the system language.
- **Installers** are not code-signed with a publisher certificate yet; on Windows the tray Quit, running the installer over an open app and opening links in the browser were not tested on this release.
- **Linux:** tested under WSL2 Ubuntu 22.04 with WSLg only (new-mail notifications with dunst; no tray test); needs a notification service for notifications.
- **Google:** Google has not finished reviewing Hey Look!, so its sign-in page says “Google hasn’t verified this app” (choose **Advanced**, then **Go to Hey Look! (unsafe)**), and until the review is done **Sign in with Google and Google calendar sync are limited to the first 100 people**. Gmail also works with an app password. What to expect, and what to do: [Help](https://thnonl.github.io/hey-look/help.html#google-review).
- **Calendar:** local events plus optional two-way sync with Google Calendar and Outlook / Microsoft 365 (per mailbox); repeating events from those calendars are read-only; CalDAV sync may come later. Some work or school organizations only let an administrator approve the Microsoft calendar permission. The sync was tested against simulated Google and Microsoft servers; a check with real accounts is still to be done.
- **Languages:** the Vietnamese and French texts were written with AI help and have not been reviewed by native speakers yet, so they may contain mistakes. The Windows installer and the system menu items of macOS are not translated by Hey Look!.
- **OpenPGP secret keys** are stored in the app's own database, protected by their passphrase, not in the system credential store.
- **Undo send** does not survive a normal Quit: the message is sent at once. If Hey Look! is closed by force (an installer, Task Manager, a crash) while you are writing, or on macOS when you log out, restart or shut down, the unsaved text is lost; a message you already sent is kept and goes out at the next start.
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

Hey Look! is free. If it helps you, you can [buy me a coffee](https://thnonl.github.io/hey-look/support.html): on [Ko-fi](https://ko-fi.com/namthnonl) or by bank transfer (the same link is under Settings > About).

## Security

Please report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

## License

MIT, free to use: see [LICENSE](LICENSE).
