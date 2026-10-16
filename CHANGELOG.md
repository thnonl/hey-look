# Changelog

## 1.0.5 — 2026-10-16

A few leftovers from 1.0.4: Cancel on an AI request, error messages that pile up, a mail that turns read after a failed Archive, the Junk folder and the 404 page of the website.

### Fixed

- Notifications and the mail list no longer show link markup from marketing mail: a plain-text part that starts with "[View in browser](https://...tracking address...)" gave a notification (and a list row) full of that text. Markdown links now show their text, "View in browser", "Unsubscribe", "Click here" and their translations are left out, and addresses, tracking tokens, image and reference markers, HTML entities and invisible characters are removed. When little readable text is left, the notification shows the sender and the subject only; the preview line is cut at about 100 characters on a word, never inside an emoji or a letter with accents. Mail already in the list is cleaned once at the next start; search still finds every word and address of the message
- Translate: Cancel now stops the request to the AI provider, not only the waiting, so a cancelled translation no longer keeps running (and costing tokens) in the background
- Many failed translations no longer cover the mail list and the reading pane: at most three notices of the same kind stay on screen, the rest are folded into one "more notifications" row with Dismiss all
- The notices about a translation (running, ready, failed) follow the language you choose, also when you change the language while they are on screen
- Archive and Delete: when the move is refused or you press Undo, the next mail that Hey Look! opened for you goes back to unread, if you did nothing with it in the first 10 seconds, and the selection returns to the mail you moved
- Junk: the Junk folder and the actions that move mail to Junk (Move to Junk, Block sender, the ! key) are hidden or greyed out, with the hint "No Junk folder", when the mailbox has no Junk folder. Archive and Trash stay, they are created when you first use them
- Updates: the "new version available" notice now appears when you start the app or come back to its window, also within a few hours of an earlier check, on every system. Before, a check that found nothing new made the app skip the next ones for 6 hours (1 hour after a failure), even after quitting and starting it again, and only Settings > About found the update (seen on a Mac, where the app stays open for days). Now starting the app checks again when the last check is 5 minutes old, and coming back to the window after 2 hours (15 minutes after a failed check). A busy or broken answer from GitHub (for example HTTP 429 or 500) is no longer taken for "no release": the update the app already knows stays and the check is repeated soon. The log (startup.log) now says, for every check, whether it asked the server or why not, and why a notice did not appear
- Writing a message: when you click another mail (or open one with the keyboard, a notification, a search result or the calendar) the message you are writing closes instead of staying in the way. An empty message is dropped; a message with text is saved to Drafts first and a Draft saved notice with Edit brings it back. If saving fails, the message stays open and your text is kept. While you write, no mail is selected in the list, so the buttons and keys for the selected mail (Archive, Delete, Flag and the others) cannot act on a mail you are not looking at
- Pasting a picture into a message: the small toolbar under the picture (Small, Medium, Large, Original, Alt text, As attachment, delete) no longer draws the Alt text label over As attachment, in any language or window width. Deleting the only picture no longer leaves a message you cannot type in, and Backspace under the signature no longer moves the signature block down: the signature stays in its place
- Writing a message: Ctrl+Shift+B only adds the Bcc field (it also turned the paragraph into a quote), Ctrl+K (Cmd+K on a Mac) in the text adds or edits a link, AltGr keys on German, Polish and other keyboards type their characters (@  { [ ] } | ~ €) instead of changing the paragraph into a heading, and Ctrl+Enter only sends (it also added a line break)
- Website: the 404 page (page not found) is written in the language of the address in all eight languages, including the top menu and the footer

## 1.0.4 — 2026-10-16

Small fixes found while testing 1.0.3: event times, Archive and Delete errors, quick clicks on flag and pin, long texts in Settings, the macOS app menu and the website on phones.

### Fixed

- New event, Edit event and the meeting strip in a new message: when you change the start date or time, the end now moves with it and keeps the length of the event (an all-day event follows by days). Changing the end never moves the start; an end before the start is still refused when you save
- Archive, Delete, Junk and Move: Hey Look! now checks the target folder before it moves the mail. A missing Archive or Trash is created again where the server allows it. When the folder cannot be found or created (also when it was removed on the server after the last sync), the mail stays where it is, the "Archived" message goes away and the error shows within a moment. Before, "Archived" and Undo appeared first and the error came about 7 seconds later. Junk and other folders are looked up but never created
- Flag and Pin: pressing the button several times quickly now ends in the state of your last click and stays there, as Mark read and Mark unread already do
- Settings: long texts are no longer cut off with an ellipsis in any of the eight languages at a 960 px or 1280 px window (for example the default account in Russian, the Notifications choices and the PGP key list)
- macOS: About, Services, Hide, Hide Others and Show All in the app menu now follow the language you chose, like Quit; Show All is new
- Windows: when Windows refuses to show a notification, Hey Look! no longer hides the error. Send test in Settings > Notifications shows it, and the log (startup.log) gets a line saying the notification failed
- Translate (More actions > Translate to ...): a long email no longer looks as if nothing happens. A notice with a spinner and a Cancel button stays on screen until the translation arrives, and the message shows a Translating box (with the time that has passed) where the translation will appear. The translation goes on when you open other mail or folders; when it is ready while you are elsewhere, a notice with Show takes you back to the mail. An error (no answer within 180 seconds, a provider error, no API key) replaces the spinner and offers Retry. The AI Assistant no longer waits for ever for an answer
- AI Assistant: when the AI provider answers with an error, the message now says it in one short sentence, in your language, with the provider’s own words when it gave a readable reason (for example “The AI Assistant returned an error (503): upstream overloaded”), instead of the raw answer of the server
- Translate: the notice with the timer and Cancel no longer squeezes a long sentence (for example in German) into three lines in a narrow reading pane; the timer and Cancel move to their own line instead
- Test copies of Hey Look! (builds run on a separate data folder) no longer share the AI key, passwords and notification icon of the installed app: they use their own credential store name and notification id
- Website: the logo keeps its size on phones, the top menu folds into the menu button before it can touch the buttons, long German words no longer run off the page, and the Theme and Animations buttons are described with whole sentences in every language

## 1.0.3 — 2026-10-16

Hey Look! now speaks eight languages, dates and times have their own pickers, and more bugs found in testing are fixed.

### Added

- Languages: five more languages for the app, so there are now eight: English, Tiếng Việt, Français, 中文（简体）, Español, 日本語, Deutsch and Русский. English stays the default, and the language is always the one you choose; it is never taken from your computer’s language. Dates, times, the tray menu and notifications follow it. The new texts were written with AI help and have not been reviewed by native speakers yet, so they may contain mistakes
- The website is translated into all eight languages too: English at the root and one folder per language (`/vi/`, `/fr/`, `/zh/`, `/es/`, `/ja/`, `/de/`, `/ru/`), with a language menu on every page
- Date and time fields: the New event dialog, the meeting strip, Send later and the search filters no longer use the browser’s own date and time boxes. You type a date or time the way your language writes it, or pick it from a month grid or a time list; times follow the 12 or 24 hour setting of Settings > General
- A small support reminder: about once every two months (the first one 1 to 4 weeks after you start using Hey Look!, and six months after you press “Buy me a coffee”) a note says you can support the project. It waits for a calm moment (never while you write a message, with a dialog open, or while something is sending or downloading), goes away by itself after 15 seconds, and stays on this computer. Press “Don’t remind me again” on it, or turn off Settings > General > Occasional support reminder

### Fixed

- Adding an IMAP account whose server accepts the connection and then says nothing (for example a port that does not speak IMAP, with STARTTLS) now shows the secure-connection hint after at most 20 seconds, as for SMTP. Before it waited about 80 seconds and said “The mail server did not respond”
- Linux: saving an attachment when the Downloads folder is missing (never created, or moved away) now creates it; if that is not possible, or the folder cannot be written to, the files go to your home folder and Hey Look! says so. Before, the save failed with “No such file or directory”
- Update restart: when you press Restart now while a message is open and it cannot be saved to Drafts, a question now asks what to do: Keep writing (nothing restarts) or Restart and discard. After a discard the update toast no longer says the message is in Drafts
- Folders: a server folder is taken for the Sent, Drafts, Archive, Trash or Junk folder when the server flags it, or when its whole name is a standard one (English, German, French, Spanish, Italian, Portuguese, Vietnamese) at the top level or directly under INBOX. A folder such as `Trash-old`, `Archive 2019` or one inside another folder (`Old/Trash`) is no longer mistaken for it, and a flagged folder is no longer passed over for a plain one with a similar name
- Sending: when the server has no Sent folder, Hey Look! now creates one (where the server allows it) and keeps the copy of the sent message there. The send itself, Undo and Send later are unchanged
- The Send later popup stays inside the window when the window is 960 px wide or narrower: it moves sideways, scrolls when the window is short, and its buttons wrap
- Spanish: the Inbox folder is called “Recibidos” (as in Gmail and Apple Mail), so the name fits the folder list
- Mark read / Mark unread: pressing the button several times quickly now ends in the state of your last click and stays there. Before, the mail could keep switching between read and unread for a moment after you stopped clicking
- Moving quickly from one unread mail to the next no longer turns a mail you just opened back to unread a moment later: the mail list now ignores a refresh that was started before your last change

## 1.0.2 — 2026-10-15

Fixes for the mail list, the reading pane and Archive / Delete.

### Fixed

- With the Unread filter on, the mail you are reading no longer disappears from the reading pane (“Select an item to read”) a few seconds after it is marked read. The same happened under the Flagged filter when you unflagged the open mail (since 1.0.0)
- Archive and Delete now work when the server has no Archive or Trash folder, or one that appeared or was renamed after the last check: Hey Look! looks at the server, creates a missing Archive or Trash (where the server allows it) and moves the mail. If the folder cannot be found or created, the mail stays where it is and an error says so. Before, the mail was only hidden for a moment and came back, and the error showed after the success message; the action then kept failing until the next restart or sync (since 1.0.0)
- A filtered mail list (for example Unread with a few mails) no longer ends with “Download limit reached (500 mails per mailbox)”; that notice now appears only under an unfiltered folder that really reached the limit (since 1.0.0)

## 1.0.1 — 2026-10-15

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
