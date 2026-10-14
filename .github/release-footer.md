
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

The installers are not code-signed with a publisher certificate yet (the macOS app is only ad-hoc signed).
- Windows: if SmartScreen appears, choose "More info" > "Run anyway".
- macOS: the app is not notarized. Drag it to Applications and start it once; when macOS says it was not opened, click Done, then open System Settings > Privacy & Security and choose Open Anyway. Details in the README.

Windows is the primary platform. The macOS and Linux builds have fewer native integrations (tray badge, notifications). Windows 11 (x64) was tested on real hardware. macOS (universal build, ad-hoc signed, not notarized) was tested on a MacBook Pro with Apple Silicon running macOS 27 (quit, update and mail core flows; see Known limitations for what was not verified). Linux (AppImage, .deb) was tested under WSL2 Ubuntu 22.04 with WSLg only, not on a native Linux desktop, and the tray could not be tested.
