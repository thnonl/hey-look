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
- Undo send, send later, snooze, filters and sweep by sender
- OpenPGP encryption and signing; calendar invitations with a local calendar
- Confidential mail: a message marked Confidential is protected while it is open (no copy, print or screen capture on Windows and macOS), and the composer has a Confidential button
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

## Known limitations

Details and more in the [Help](https://thnonl.github.io/hey-look/help.html).

- **macOS:** no notifications and no Dock badge in this version; the app is ad-hoc signed, not notarized; the first-start steps and log out / restart on this exact build were not tested.
- **Installers** are not code-signed with a publisher certificate; on Windows the tray Quit, running the installer over an open app and opening links in the browser were not tested on this release.
- **Linux:** tested under WSL2 Ubuntu 22.04 with WSLg only (new-mail notifications with dunst; no tray test); needs a notification service for notifications.
- **Calendar** is local in 1.0 (CalDAV / Exchange sync may come in a later update); the **interface** is English in 1.0 (more languages may come later).
- **OpenPGP secret keys** are stored in the app's own database, protected by their passphrase, not in the system credential store.
- **Undo send** does not survive a normal Quit: the message is sent at once. If Hey Look! is closed by force (an installer, Task Manager, a crash) while you are writing, or on macOS when you log out, restart or shut down, the unsaved text is lost; a message you already sent is kept and goes out at the next start.
- **Windows:** overlay tools (for example RivaTuner Statistics Server) can crash the web view; Hey Look! restarts itself at most three times in ten minutes; exclude `hey-look.exe` and `msedgewebview2.exe` there.
- Mail servers must offer SSL/TLS or STARTTLS; new Inbox mail is delivered by IMAP IDLE (push) when the server supports it, otherwise mail is polled (every 2 minutes by default). While push works, the other folders are checked every 10 minutes. Settings > Mailboxes > Reading & sync has the interval and a push switch.

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

Hey Look! is free. If it helps you, you can support it on [Ko-fi](https://ko-fi.com/namthnonl) or by bank transfer: see the [support page](https://thnonl.github.io/hey-look/support.html).

## Security

Please report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

## License

MIT, free to use: see [LICENSE](LICENSE).
