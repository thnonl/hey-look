# Changelog

## 1.0.1 — 2026-10-xx

New Inbox mail now arrives at once, Hey Look! speaks Vietnamese and French, and your Google and Outlook calendars can sync. Several bugs found in testing are fixed.

### Added

- Push mail: new Inbox mail arrives at once on servers that support IMAP IDLE (the account’s Server settings say Push or Polling). Servers without it, and the other folders, are checked as before at your interval (every 10 minutes while push works). Settings > Mailboxes > Reading & sync has a switch to turn push off
- Calendar: turn on two-way sync with Google Calendar or Outlook / Microsoft 365 (Outlook.com, Hotmail, work and school accounts) for a mailbox (Settings > Mailboxes > your mailbox > Calendar). Repeating events from those calendars are shown but can’t be changed in Hey Look! yet
- Languages: the whole app is now available in English, Vietnamese (Tiếng Việt) and French (Français). Choose it with the globe button in the header, on the Welcome screen or in Settings > General > Language; English stays the default. Dates, times, numbers, the tray menu and notifications follow the language too. The Vietnamese and French texts have not been reviewed by native speakers yet
- A button in the reading pane switches a mail between its original background and a dark one; your choice is remembered
- macOS: the Dock icon shows the unread number (the same count as the menu bar icon; cleared at 0; Settings > Notifications & tray > Dock badge turns it off)
- Settings > About: links to the Website, “Buy me a coffee” (the support page) and the Source code
- Signing in to Google or Microsoft has a Cancel button (mail and calendar); it stops waiting at once and nothing is added. If a Microsoft sign-in ends without access, Hey Look! suggests asking your IT admin to approve it

### Changed

- Mail is shown on its original background in every theme (the colours its sender chose), also in the dark theme, where 1.0.0 recoloured it dark. Use the new button to get the dark version
- Sign-in with Google: Google has not finished reviewing Hey Look! yet, so its sign-in page may say “Google hasn’t verified this app”: choose Advanced, then Go to Hey Look! (unsafe). Hey Look! says so while it waits. Until the review is done, Sign in with Google and Google calendar sync are limited to the first 100 people; when Google blocks a sign-in Hey Look! explains it and offers to add Gmail with an app password instead
- Behind the scenes: the release process is ready to sign and notarise the macOS app and checks every update signature before a release is published. Nothing changes for you until Apple signing is switched on

### Fixed

- A Google or Microsoft mailbox whose sign-in ended (access removed, password changed) failed quietly; it now shows “Sign in again” in the folder list and in Settings
- After a manually added IMAP account had downloaded its mail, “Downloading mails… 100 / 500” could stay on screen for good; it now disappears when the download ends
- Calendar: in an event’s … menu, clicking Edit, Duplicate or Delete with the mouse did nothing (since 1.0.0; the keyboard worked)
- Calendar: the start and end rows of the New event dialog are aligned
- An outgoing (SMTP) server that accepts a connection but never answers the secure handshake could keep Hey Look! waiting for good when you added an account or sent mail; it now gives up after at most 30 seconds and shows the secure-connection hint
- Add account no longer saves a mailbox whose SMTP server cannot be secured (the secure-connection hint now really stops the add)
- A mail server that answers unexpectedly to IDLE or to selecting a folder can no longer stop the app
- A Google sign-in that Google blocks no longer ends with an empty red box; it explains what happened. A blocked calendar no longer offers “Allow access again” when an administrator has to approve it, and calendar sync errors are shown in plain words with the details on a separate line

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
