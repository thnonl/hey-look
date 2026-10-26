
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

The changes of 1.0.10 were tested on Windows 11 (x64) in Windows Sandbox (debug builds, real mouse and keyboard input inside the sandbox), on an Apple silicon Mac (Apple M1 Pro, macOS 27.0.1; a release-profile build with debug assertions) and in an ARM virtual machine (UTM) on that Mac (Ubuntu 24.04.5, KDE Plasma 5.27 on X11, WebKitGTK 2.52; a debug build), all with copies of the app built from the source of this release. On the Mac and in the virtual machine most steps used real input (drags, right-click and Ctrl+click, clicks, typing in the Settings search, closing pop-out and compose windows); the autostart switch (checked in the launch agent or .desktop file on disk), opening a message and a few buttons were driven by test events. The downloadable macOS app and the Linux packages (AppImage, .deb, .rpm) were not installed or tested. Windows 10, Intel Macs and macOS 11 and 12 are supported but were not tested on this release, and neither were real sign-in, audible sound, the system's own tooltips on Windows and touch input. Real Google and Microsoft sign-in, real CalDAV servers (iCloud, Fastmail, Baikal, Nextcloud, Radicale) and the blocking of screen capture for Confidential mail (Windows Print Screen and Snipping Tool, macOS screenshots) were not tested by the project’s QA (simulated servers were used instead); the owner checks them after the release. Linux does not block screenshots of Confidential mail. The APT repository, the Microsoft Store and the Snap Store are not available in this release. On macOS each pop-out window you close keeps a small empty system window (about 0.2 MB) until Hey Look! quits. Known limitations are listed in the release notes above and on the website: https://heylook.namthai.site/features.html#limits
