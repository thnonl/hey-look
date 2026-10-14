# Changelog

## 1.0.0 — 2026-10-14

First public release of Hey Look!, a fast, private desktop mail client.

- Many mailboxes in one place: Google and Microsoft (OAuth), iCloud, Yahoo and any IMAP/SMTP server
- Conversations, snooze, pin, flag, undo for archive/delete/junk, undo send and send later
- Search with filters and operators, Focused/Other inbox, Sweep (clean up by sender), filters
- Calendar invitations (accept/tentative/decline) and a local calendar (month, week and agenda views, reminders, `.ics` import and export); syncing with other calendar services may come in a later update
- OpenPGP encryption and signing
- Optional AI Assistant with any OpenAI-compatible endpoint
- Tray icon with unread badge and native notifications (Windows with action buttons, Linux without, macOS none in this version)
- New: Hey Look! updates itself. When a new version is out, agree once, keep working while it downloads, and the app restarts into the new version (it asks first while you are writing)
- Linux: links and attachments open through the desktop's `xdg-open` (then `gio`, `sensible-browser`) with the AppImage's own library paths removed, and a link or file that cannot be opened is reported instead of nothing happening; "Send test" reports a missing notification service
- Not tested on the release build (planned for 1.0.1 testing): Windows tray Quit while a message is in its Undo time, the installer run over a running app, link and attachment opening on Windows; on macOS the first-start steps and log out / restart with the app running.
- Linux new-mail notifications were verified on WSLg with dunst; behaviour with a minimised window was not verified.
