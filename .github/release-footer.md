
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

Tested on Windows 11 (x64) on real hardware, on macOS (universal build, not notarized; a MacBook with Apple silicon) and on Linux (KDE desktop in an ARM virtual machine). Windows 10 and Intel Macs are supported but were not tested on this release, and the Linux x86_64 packages (AppImage, .deb, .rpm) are built the same way but were not installed or tested. Linux does not block screenshots of Confidential mail. On macOS each pop-out window you close keeps a small empty system window (about 0.2 MB) until Hey Look! quits. Known limitations are listed in the release notes above and on the website: https://heylook.namthai.site/features.html#limits
