
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

Already using Hey Look!? A copy from this page or the website updates itself (Settings > About); a copy from the Microsoft Store is updated by the Store.

The installers are not code-signed with a publisher certificate yet (the macOS app is signed with the project’s own self-signed certificate and is not notarized).
- Windows: if SmartScreen appears, choose "More info" > "Run anyway".
- macOS: the app is not notarized. Drag it to Applications and start it once; when macOS says it was not opened, click Done, then open System Settings > Privacy & Security and choose Open Anyway. Details on the download page: https://heylook.namthai.site/download.html#install-notes. If you update from a version before 1.0.6, the Keychain asks about your saved passwords once more at the first start.
- Linux: the AppImage runs on any distro; the .deb and .rpm installs ask for your password.

The changes of 1.0.11 were tested on Windows 11 (on the computer itself, not in Windows Sandbox) and on an Apple silicon Mac (Apple M1 Pro, macOS 27.0.1), with debug builds of the 1.0.11 release candidate (on the Mac signed with a local test identity, not with the release signature) and with test mail servers instead of real mail accounts. Linux was not tested on this release (no Linux virtual machine could be started). On Windows every step was driven by test events through the test interface of the app, not by real mouse or keyboard input. On the Mac almost every step was driven the same way; real pointer input was used only to look at the Notifications page of System Settings (nothing was changed there) and to right-click a hidden picture (the menu opened and Show this picture loaded the picture; checked on an earlier build of the same release candidate). On macOS no notification banner was seen on screen, so whether banners appear was not tested, and the test of a banner while Hey Look! is in the background could not be run; with the notification permission turned off, the note in Settings (checked in Spanish) showed its text and the Open System Settings button. The downloadable macOS app and the Linux packages (AppImage, .deb, .rpm) were not installed or tested. Windows 10, Intel Macs and macOS 11 and 12 are supported but were not tested on this release, and neither were real sign-in, audible sound, the system's own tooltips on Windows and touch input. Real Google and Microsoft sign-in, real CalDAV servers (iCloud, Fastmail, Baikal, Nextcloud, Radicale) and the blocking of screen capture for Confidential mail (Windows Print Screen and Snipping Tool, macOS screenshots) were not tested by the project’s QA (simulated servers were used instead); the owner checks them after the release. Linux does not block screenshots of Confidential mail. The APT repository and the Snap Store are not available in this release. Hey Look! is in the Microsoft Store, which gets each release after Microsoft has approved it, so the Store version can be behind this one for a while. On macOS each pop-out window you close keeps a small empty system window (about 0.2 MB) until Hey Look! quits. Known limitations are listed in the release notes above and on the website: https://heylook.namthai.site/features.html#limits
