
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
- macOS: the app is not notarized. Drag it to Applications and start it once; when macOS says it was not opened, click Done, then open System Settings > Privacy & Security and choose Open Anyway. Details in the README.

Tested on Windows 11 (x64) on real hardware, on macOS (universal build, not notarized; MacBook Pro with Apple Silicon). The Linux packages (AppImage, .deb) are built the same way but were not tested again for this release. On macOS the Dock icon shows the unread number; native notifications are not available yet. Known limitations are listed in the README.
