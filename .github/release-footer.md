
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

The installers are not code-signed yet.
- Windows: if SmartScreen appears, choose "More info" > "Run anyway".
- macOS: the app is not notarized. Drag it to Applications and start it once; when macOS says it was not opened, click Done, then open System Settings > Privacy & Security and choose Open Anyway. Details in the README.

Windows is the primary platform. The macOS and Linux builds are new, have fewer native integrations (tray badge, notifications), and have not been tested on real hardware by the maintainer.
