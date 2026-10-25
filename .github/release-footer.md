
### Which file do I download?
| System | File |
|---|---|
| Windows 10/11 (recommended) | `...-setup.exe` |
| Windows (MSI, for managed installs; needs WebView2) | `....msi` |
| macOS 11+ (Apple silicon and Intel) | `....dmg` |
| Linux, any distro | `....AppImage` |
| Debian / Ubuntu | `....deb` |
| Fedora / openSUSE | `....rpm` |

The `.sig` files, `latest.json` and the `.app.tar.gz` are used by the app’s updater; you don’t need them.

Already using Hey Look!? It updates itself (Settings > About).

The installers are not code-signed with a publisher certificate yet (the macOS app is signed with the project’s own self-signed certificate and is not notarized).
- Windows: if SmartScreen appears, choose "More info" > "Run anyway".
- macOS: the app is not notarized. Drag it to Applications and start it once; when macOS says it was not opened, click Done, then open System Settings > Privacy & Security and choose Open Anyway. Details on the download page: https://heylook.namthai.site/download.html#install-notes. If you update from a version before 1.0.6, the Keychain asks about your saved passwords once more at the first start.
- Linux: the AppImage runs on any distro; the .deb and .rpm installs ask for your password.

The changes of this release were tested on Windows 11 (x64) on real hardware, and their layout and behaviour in the web engines of macOS and Linux (WebKit) were checked on a MacBook Pro with Apple silicon (macOS 27) and in an ARM virtual machine (Ubuntu 24.04, KDE, WebKitGTK) on that Mac, with copies of the app built from the source of this release (the Linux copy was a debug build); the downloadable macOS app was only checked for its version and processor type. Windows 10, Intel Macs and macOS 11 and 12 are supported but were not tested on this release, and the Linux x86_64 packages (AppImage, .deb, .rpm) are built the same way but were not installed or tested. Real Google and Microsoft sign-in, real CalDAV servers (iCloud, Fastmail, Baikal, Nextcloud, Radicale) and the blocking of screen capture for Confidential mail (Windows Print Screen and Snipping Tool, macOS screenshots) were not tested by the project’s QA (simulated servers were used instead); the owner checks them after the release. Linux does not block screenshots of Confidential mail. The APT repository, the Microsoft Store and the Snap Store are not available in this release. On macOS each pop-out window you close keeps a small empty system window (about 0.2 MB) until Hey Look! quits. Known limitations are listed in the release notes above and on the website: https://heylook.namthai.site/features.html#limits
