# Hey Look!

A fast, private desktop mail client for Windows, macOS and Linux. Free and open source, with no ads, no analytics and no account to create.

[![Hey Look! intro](docs/media/preview.gif)](https://heylook.namthai.site/#film)

**Website:** https://heylook.namthai.site/ · [Download](https://heylook.namthai.site/download.html) · [Help and FAQ](https://heylook.namthai.site/help.html)

## Download

Get the latest version from the [download page](https://heylook.namthai.site/download.html) or from [GitHub Releases](https://github.com/thnonl/hey-look/releases/latest): Windows 10 and 11 (`.exe` or `.msi`), macOS 11 or later, Apple silicon and Intel (`.dmg`), and Linux (`.AppImage`, `.deb` or `.rpm`). Hey Look! updates itself after you agree.

The installers are not code-signed with a publisher certificate and the macOS app is not notarized, so the first start needs one extra step: see [First start on macOS](https://heylook.namthai.site/download.html#install-notes) and the [Help](https://heylook.namthai.site/help.html#g-install) for Windows and Linux.

## What it does

- Many mailboxes in one place: Google and Microsoft, iCloud, Yahoo and any IMAP/SMTP server, with push for new mail where the server supports it
- An Outlook-like editor, undo send, send later, snooze, filters, signatures and templates, and a window of its own for writing or reading
- A local calendar for invitations, with optional two-way sync with Google Calendar and Outlook / Microsoft 365
- OpenPGP encryption and signing, and Confidential mail that cannot be copied or printed (and, on Windows and macOS, not captured on screen)
- An optional AI Assistant that uses your own endpoint and sends text only when you press a button
- Eight languages: English, Tiếng Việt, Français, 中文（简体）, Español, 日本語, Deutsch and Русский; light and dark themes

Your mail stays on your computer and your passwords in your system's credential store. Every feature and its known limits: [Features](https://heylook.namthai.site/features.html) and [Known limitations](https://heylook.namthai.site/features.html#limits).

## Documentation and support

- [Features](https://heylook.namthai.site/features.html) · [Help and FAQ](https://heylook.namthai.site/help.html) · [Download](https://heylook.namthai.site/download.html) · [Support the project](https://heylook.namthai.site/support.html)
- [Privacy policy](https://heylook.namthai.site/privacy.html) · [Terms of service](https://heylook.namthai.site/terms.html) · [Google API data use](https://heylook.namthai.site/google-data.html) · [Security](https://heylook.namthai.site/security.html)
- The website in [Tiếng Việt](https://heylook.namthai.site/vi/) · [Français](https://heylook.namthai.site/fr/) · [中文（简体）](https://heylook.namthai.site/zh/) · [Español](https://heylook.namthai.site/es/) · [日本語](https://heylook.namthai.site/ja/) · [Deutsch](https://heylook.namthai.site/de/) · [Русский](https://heylook.namthai.site/ru/)
- What changed: [CHANGELOG.md](CHANGELOG.md) and [GitHub Releases](https://github.com/thnonl/hey-look/releases)
- Bugs and ideas: [GitHub Issues](https://github.com/thnonl/hey-look/issues) (issues are public: never post mail, passwords or tokens)

Hey Look!'s use of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

## Build from source

```bash
npm install
npm run tauri dev      # run the desktop app
npm run tauri build    # release build with installers
```

Prerequisites, sign-in clients, tests and the code layout: [CONTRIBUTING.md](CONTRIBUTING.md).

## Support the project

Hey Look! is free. If it helps you, you can [buy me a coffee](https://heylook.namthai.site/support.html) on Ko-fi; a star on GitHub, a bug report or a better translation helps too. The app may show a small reminder about once every two months; Settings > General > Occasional support reminder turns it off.

## Security

Please report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

## License

MIT, free to use: see [LICENSE](LICENSE).

Third-party data: the emoji names and keywords come from the Unicode CLDR annotations (version 48.2.0), Copyright © 1991-2026 Unicode, Inc., used under the [Unicode License v3](https://www.unicode.org/license.txt).
