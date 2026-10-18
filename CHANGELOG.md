# Changelog

## 1.0.7 (unreleased)

### Changed

- The action row of a message you write is always one row, in every language: what does not fit (Write with AI, Templates, Save draft, Importance, Confidential, Sign, Encrypt, Meeting, Picture, in that order) moves into "More actions", and comes back when the window grows; Send, Discard and Attach never move
- A blocked remote picture in a message you read is drawn as a box of the size the message gave it (48 x 48 when it gave none) with an icon and the picture's description; tracking pixels are not drawn at all. "Load content" loads the real pictures
- The Week view of the calendar fits 08:00 to 20:00 on the screen when the window is tall enough (the hours are between 32 and 48 px high), so an evening event is no longer hidden below the fold
- A failed email link (no mail program on the computer) says "default mail app" and copies only the address; on a Mac the quit question and the Send later popover say "menu bar" instead of "tray"
- The website moved to https://heylook.namthai.site/ (the old thnonl.github.io/hey-look/ addresses are redirected there)

### Fixed

- A press elsewhere closes an open menu, calendar popup or colour palette inside a dialog (Settings, New event, the key dialogs), on the top bar of Windows (the logo, the title, an empty part of the bar) and inside the text of a message you read
- New mail opened in the first moments after the start is no longer lost: a request that comes while the mailboxes are still being read (the button, the key C, the command bar, the tray or menu bar icon menu) is kept and opens when they are ready, with a message and a spinner while it waits, and "Couldn't open a new message" with Retry after 30 seconds (if the mailboxes are ready after that, the message goes and the new message opens by itself)
- Ctrl+B (Cmd+B) and the side menu button follow what is on screen in a narrow window: the full menu opens over the list with the keyboard focus on the selected folder, the button reads "Collapse side menu", and the next press closes it; your saved choice is not changed
- The accessible name of the message body, the signature editor and the template editor follows a language switch while they are open
- A hidden file picker no longer takes a Tab stop in the message header; the preview in Settings > Appearance is a picture only (nothing in it takes the focus or reacts to a click)
- "Show in folder" says when it could not show the file (for example after the file was moved or deleted) instead of doing nothing, and on Linux it opens the folder when the file manager cannot select the file
- Every Copy button (View original, encryption keys, Copy sender email, the webmail search) works on Linux and on a Mac and says "Couldn't copy to the clipboard" when it could not copy
- A new Summarize, Translate or Write with AI removes the message about the earlier AI problem at once
- Starting a sixth translation, or deleting mail while translations run, no longer removes the message of a running translation; only the short-lived messages are limited to five
- Discard on a draft you opened from Drafts and changed asks "Discard your changes?" and puts the draft back the way it was when you opened it (the edits an autosave saved no longer stay in Drafts); a new message keeps the old question
- A new message that was autosaved and then emptied (all text, recipients and files removed) leaves no draft behind when you close it, move to another mail or close its window
- "Move to Drafts" of an encrypted scheduled message stores the draft for your own key only, like every other draft (it was also encrypted for the recipients); a locked key asks for its passphrase first
- Delete, Archive and Move act on the messages they were pressed on: a message that arrives in the conversation during the Undo time stays in the Inbox; each queued move, Undo and finished move is written to the log (no subjects or addresses)
- Undo of a send, a failed send, a message moved into a window and a restored message keep the signature choice (Automatic, a named signature or No signature) instead of turning Automatic into No signature
- A signed or encrypted message that was scheduled goes out with the date of the send, not the day it was scheduled; a Reply sets Answered and a Forward sets Forwarded on the original on the mail server once the message is sent (other mail programs show these)
- A draft from before 1.0.6 that forwards a message with a signature keeps your own signature in the signature box
- A recipient whose key can only sign now reads "their key can only sign, not encrypt" (in the strip and in the recipient's key popover) instead of "no public key"
- Every header line of a message you send, save as a draft or keep in Sent is at most 78 characters, also for a long list of recipients with quoted names (a name is cut at a space inside its quotes only when nothing else fits) and for the header lines of attachments and pictures (a long media type or file name); a signed message is folded before it is signed, so its signature stays valid

## 1.0.6 — 2026-10-18

Writing a message got much more complete and much safer, and messages can now be written and read in windows of their own. Nothing you write is lost to a crash any more, the message that goes out is built the way other mail programs build theirs, and the mail list, the mailboxes, the side menu and the AI Assistant got a number of long-wanted touches.

### Highlights

- Pop-out windows: write a message, or read a conversation, in a window of its own (Shift+click, double-click, or a setting that makes it the normal way)
- An Outlook-like rich-text editor: fonts and sizes, colours and highlight, lists, styles, tables, pictures, links, emoji and symbols, find and replace, text direction, a protected block for the quoted message, and paste options (keep source formatting, merge, text only)
- A side menu you can fold to a column of icons (Ctrl+B or Cmd+B); it folds by itself in a narrow window
- The message you write fits small windows: the formatting row and the text are always in view
- Nothing is lost: autosave to Drafts, a recovery copy after a crash, and Bcc, names and Reply-To are kept
- Translate long mail in parts, up to 60,000 characters, with Cancel (also for Summarize and Write with AI); AI messages that stay until you close them and take you to the setting to fix
- Right-click menus: on a conversation in the mail list, and on text anywhere in the app
- Mailboxes: your own order and a Display name
- Importance (High or Low) on messages you write, and Preview as recipient (Light or Dark)
- Dark theme: the top bar is tinted by your chosen colour
- Quit always ends, the tray and the window come back on Linux, and the app window runs under a Content Security Policy
- macOS: the app is signed with a fixed, self-signed certificate (not notarized)

### Added

Writing a message

- A formatting toolbar in one row (more controls move into a More menu when the window is narrow): font, font size (a box you can type a size into, or a list), bold, italic, underline, strikethrough, subscript and superscript, font colour and highlight colour with the Office palette (recent colours are remembered), clear all formatting, Undo and Redo. Ctrl+] and Ctrl+[ change the font size, Ctrl+= and Ctrl+Shift+= subscript and superscript, Ctrl+Space or Ctrl+\ clear the formatting, Alt+F10 goes to the toolbar. The signature and template editors have the same toolbar
- Paragraphs: align left, centre, right or justify (Ctrl+L, Ctrl+E, Ctrl+R, Ctrl+Shift+J), increase and decrease indent (Ctrl+T, Ctrl+Shift+T), line spacing and space before and after a paragraph, bulleted lists (filled circle, hollow circle, filled square) and numbered lists (1. a. A. i. I.) with a style menu on each button, a Styles menu (Normal, Heading 1 to 3, Quote, Code; Ctrl+Shift+S, Ctrl+Shift+N, Ctrl+Alt+1 to 3) and a horizontal line
- Text direction: Left-to-right and Right-to-left text per paragraph or list; an Arabic or Hebrew paragraph is right-aligned with its list markers on the right, and pasted right-to-left paragraphs keep their direction
- Insert menu: Table (pick the size on a 10 x 8 grid or in Insert table..., up to 20 columns and 100 rows; floating tools for rows, columns, borders, cell shading and a header row; Tab goes from cell to cell and adds a row at the end), Links (Ctrl+K opens a small dialog; a bubble under a link offers Open, Edit and Remove; Ctrl+click opens a link), Pictures (align, put a link on a picture, drag a corner handle to resize), Emoji (a picker; the system's own panel is named under it), Symbol (24 common symbols) and Date & time
- More menu: Change case (sentence case, lowercase, UPPERCASE, Capitalize Each Word, tOGGLE cASE; Shift+F3 goes round three of them), Find and replace (Ctrl+F finds, Ctrl+H replaces; matches are marked, Match case, Previous and Next, Replace, Replace all in one undo step; the signature and the quoted message are not searched) and Zoom (75 to 200 % of the editor only; nothing of it is sent)
- Paste options: pasting from Word, Excel, Outlook, Gmail, Google Docs, web pages and Apple programs is cleaned (Word's typed numbers and bullets become real lists, no Word styles, scripts, forms or web pictures come in). A small Paste options button after the paste switches the same paste between Keep source formatting, Merge formatting and Keep text only; open it with a click or by pressing and releasing Ctrl. Ctrl+Shift+V (Cmd+Shift+V on a Mac) always pastes text only, and a drop of text from another program is cleaned the same way. Tables pasted from Word, Excel or a web page stay tables
- Replies and forwards quote the original message in a block of its own that keeps its look (fonts, colours, tables, lists, alignment, right-to-left text, pictures), below your text and signature, with the "On <date>, <name> wrote:" line (or the forward header) above it. Typing, pasting and Enter while it is selected go below it, and Backspace and Delete next to it leave it alone. "Edit quoted text" turns it into ordinary text; Hide / Show and Remove are next to it. Scripts, forms, event handlers and external styles are removed, pictures from the web are not loaded while you write (they stay in the message you send), and pictures inside the original travel with the reply. A very large original (more than about 1.5 MB of HTML) is quoted as plain text
- Signatures and templates can have pictures (a logo from a file, 240 px wide at first, drag a corner to change it; a picture over 1 MB is made smaller, or refused with a message when it is still too heavy). In the message that goes out the logo is an inline picture, not an attachment
- Settings > Composing: Default font (new messages, replies and forwards start in Calibri 11 pt; the message is sent with that font and without extra space between paragraphs), When pasting from other apps (what Ctrl+V does), Open new messages, replies and forwards in a separate window, and Check for missing alt text before sending (off by default)
- Importance: mark a message High or Low (two buttons next to Confidential). The message carries the importance headers other mail programs understand; High and Low mail you receive shows a red "!" or a blue arrow in the list and a label in the reading pane (mail downloaded before this version shows no mark)
- Preview as recipient (Light or Dark) in the formatting toolbar shows how the message looks on a light or a dark background; it does not change what is sent
- Autosave: the message is saved to Drafts about every 30 seconds while you change it (the same draft is replaced, never doubled) and a copy is kept on your computer every few seconds. After an unexpected end, the next start asks nothing: every message that was open (also one that has only recipients typed in To, Cc or Bcc) is saved to Drafts by itself, and one toast that stays until you close it says how many messages were kept and where, with Continue writing (opens the newest) and, for several, Show all; a message that cannot be saved to the server (no Drafts folder, no connection) is kept on this computer and the toast says so, and a copy that stays on this computer for more than 30 days is removed. A message that is on the server already is never doubled

Windows of their own

- Write in a window of its own: hold Shift when you click New mail, Reply, Reply all or Forward (or press Shift+C, R, A or F), double-click a draft in Drafts, or use Pop out (Ctrl+Shift+O) in the message you are writing. The window shows the subject in its title bar, remembers its size and place, and keeps working when the main window is in the tray. Send shows "Sending… n s" with an Undo button. Closing a window with a message asks Save, Discard or Cancel; an empty one closes at once. Quitting or updating saves every window's message to Drafts first, and a message written in a window comes back in a window after a crash. The same draft is never open in two windows
- Read in a window of its own: double-click a conversation (or Shift+Enter, Open in new window in its right-click menu, the button above the message or the command bar), with Reply, Reply all, Forward, Archive, Delete, Flag, Mark as unread, Snooze, Summarize and Translate. Mail you archive, delete or flag there is done by the main window (with its Undo); the window says when the conversation was moved elsewhere. Up to 8 windows can be open
- Settings > Composing > "Open new messages, replies and forwards in a separate window" makes a window the normal way, and Shift then does the opposite

Mail list, mailboxes and menus

- Right-click a conversation (or the Menu key, or Shift+F10) for Reply, Reply all, Forward, Mark read or unread, Flag, Pin, Snooze, Move to, Archive, Delete, Move to Junk, Copy sender email and Copy subject; with several conversations ticked it works on all of them
- The browser's own right-click menu is gone. In text fields (the message you write, the search box, every setting) the usual menu with spelling suggestions, Cut, Copy and Paste stays. On other text (a message you read, a dialog, a notification) right-click for Copy and Select all, and Copy email address on an address; links in a mail have Open link and Copy link address. The Menu key and Shift+F10 open the same menus
- Mailboxes: drag a mailbox in the folder pane or in Settings to put them in your order, or use Alt+Up and Alt+Down (also in the mailbox's right-click menu); the order is kept
- Mailboxes: the Display name of a mailbox is shown in the folder pane, the list header and the command bar instead of the address (the address is in the tooltip)
- Side menu: the folder pane folds to a column of icons (the button at its top, or Ctrl+B / Cmd+B): each mailbox is its colour with its unread number, then the folders of the selected mailbox; names and counts are in the tooltips. With the pointer resting on the icons, or the keyboard focus in them, the full menu opens over the list for a moment. In a window narrower than 1100 px it folds by itself; your own choice wins over the width and is kept after a restart, except that an open menu never leaves the reading pane narrower than 440 px. Settings > Appearance > Side menu: Automatic, Always expanded, Always icons only, Reset to automatic
- In the dark theme the top bar is tinted by the primary colour you chose in Settings > Appearance (it was always the same dark grey)

AI Assistant

- Guidance: when Summarize, Translate or Write with AI cannot work, a message stays on screen until you close it and says what happened and what to do (the Assistant is not set up, the provider rejected the key, the address could not be reached, the model name was not found, the provider is busy, the answer could not be read, or it took too long). Its button Open AI Assistant settings opens Settings on the AI Assistant tab with the cursor in the field the problem is about, also from a message window or a writing window; Try again is there where trying again can help
- Translate: a long email is translated in full, up to 60,000 characters (it was the first 12,000), cut at paragraphs and then sentences into parts of about 8,000 characters that are translated one after the other and put together in the layout of the original. The notice says "Part 2 of 5"; Cancel stops the request and the parts not yet started; a part that fails on the network or with a server error is tried once more, and Retry goes on from the failed part without redoing the finished ones. Beyond 60,000 characters the first part is translated and a note says so
- Summarize and Write with AI show that they are running and have a Cancel button that drops the request to the provider; an answer that arrives after Cancel, or after you moved to another conversation or closed the message, is ignored

### Changed

- Languages: the Vietnamese, French, Chinese, Spanish, Japanese, German and Russian texts of the app and the website were reviewed again by language specialists (one word for one thing, consistent tone, short labels, spacing and punctuation)
- The app window runs under a Content Security Policy: only the app's own scripts run (no inline or remote scripts), and the app talks only to itself and to its own Rust side
- Quit always ends. The app waits at most 8 seconds for a window that does not answer, 45 seconds for one that is saving or sending, and 60 seconds for a question to you ("Quit and discard?"), then quits; the message you were writing is kept as a recovery copy and a message in its Undo time goes out at the next start. A question that has to be answered is shown in front, also when the window was hidden in the tray. If the app is still alive 40 seconds after the quit began, it is ended
- Linux: when the window comes back from the tray ("Open Hey Look!") the app checks that the page still runs and loads it again when it does not, instead of leaving a blank page; a web view process that ends is loaded again at once. The tray icon has no click action on Linux (the desktop's indicator service does not pass clicks on): use "Open Hey Look!" in its menu
- PDF attachments: on Windows the preview shows the PDF again (it was a blank "blocked" page); only a file that really is a PDF is drawn, and a file called .pdf that holds anything else says so. On macOS and Linux the preview shows the file with a note that PDF files open in your default app, an Open button (a temporary copy opens in your default app) and Save as. A link inside a PDF does nothing instead of taking the app window to a web page. If any preview cannot be drawn, the dialog says so and offers Open
- The preview of an attachment and the picture viewer open on top of the whole window (the Reply buttons of later messages were drawn over them); the focus moves into them, Tab stays inside, and Esc gives the focus back
- Insert link (button or Ctrl+K) opens a small dialog in the app with the address and an optional text, instead of the system prompt; Remove link is in it too
- Start: when the app cannot start at all on Windows (for example the WebView2 Runtime is missing or damaged) it says so in a message in the language of Windows, with where to get the runtime and where the log file is, instead of closing without a word; macOS and Linux write the reason to the log file
- Windows of their own (macOS): closing one is done in steps the log shows, a window closed before its page is up is never shown, two quick clicks on the same thing open one window, and the native window is finished by hand so a closed window does not stay listed
- Messages you send are built the way other mail programs build theirs: their own Message-ID with your address domain (the Sent copy has the same one, so replies reach the right conversation), the greeting to the mail server (EHLO) no longer contains the name of your computer, long recipient and References lists are wrapped to 78 characters per line, the plain-text version keeps links as "text (address)", bullets and numbers, quotes and tables, and an address that appears twice (also in different upper and lower case) is only sent to once. A message with only Bcc recipients can be sent (the To line reads "undisclosed-recipients")
- Attachments: the size is counted as it is sent (about a third more than the files) and the limit of your mail server is used when it tells one, so a message the server would refuse is stopped before sending with the real numbers; the limit is asked when a message opens and when files are added. File names are cleaned before sending (no folder part, no hidden or control characters, no reserved Windows names, a sensible length) and two files with the same name get a number
- macOS: the app is signed with a fixed certificate (self-signed, not notarized), so macOS keeps remembering which app may read your saved passwords across updates. Because the signature changes once, the first start after updating to this version asks about your saved passwords one more time

### Fixed

- A meeting is kept when a message is saved as a draft and opened again: the Meeting button stays on with its times, place and "Send invite" (also after a crash recovery, in a window of its own and after Undo); a private header of the draft in the Drafts folder carries it and is never part of a message that is sent
- The Send later popover, and every other popover and menu of the message, stay whole inside a small window (960 x 560 and lower): the presets, the date and time and the footer fit or scroll in one box, panels open above their button when there is more room, and the alt text popover of a picture is no longer cut off
- In the Send later popover of a low window, "Choose time" opens the time list also after the popover was scrolled (it did nothing and the popover jumped to the top); scrolling the window around it no longer resets the scroll of the popover
- The picture toolbar and the resize handles no longer overlap: the handles sit inside the corners of the picture, and the toolbar keeps clear of the picture's edges
- A picture that is made smaller and re-encoded (a GIF becomes a PNG) is named for what it is (photo.png), in the message, the draft and the sent message, and the notice says that the animation is not kept
- Summarize says when only the first part of a long conversation was summarized, like Translate does
- The notice "AI Assistant is not set up" goes away when you save the AI settings
- A screen reader reads Snooze as "Snooze" (the tooltip with its key, "Snooze (s)", stays)
- Choosing several pictures at once (the Picture button, a drop or a paste, and in the signature editor) puts all of them in the message, in the order you chose them, and the cursor is behind the last one; before, only the last picture stayed
- A picture file dropped on the message window follows Settings > Composing > Pasted and dropped pictures (in the message by default, attached when you chose that); the "Drop to insert in the message" and "Drop here to attach" areas still do what they say, and other files are always attached
- Generate a key (Settings > Encryption, and Set up encryption in a message): Esc, and a click outside the question "Close without a backup?", no longer open the save dialog of the backup instead of leaving the dialog; Done and the X ask once, Close anyway closes the dialog, and Back up now saves the backup so that Done closes it
- The Send later popover, the recipient suggestions and the menus of a message stay inside the window, above the picture toolbar (which steps aside while one is open) and above the notification at the bottom of the window, also when a picture is selected in a small window
- A reply or a forward made from a message whose subject or sender name holds a line break or another control character is sent with a one-line subject and clean names (the line break becomes a space)
- Discard removes the draft that autosave made, also when an autosave was still on its way to the server at that moment; before, a draft of the discarded message could stay in Drafts
- Writing at the smallest window size (the main window at 960 x 560, or the window of its own at its smallest): the formatting row and the text are always in view and the text keeps room for about eight lines. In a narrow or low pane the actions are one row of icons (Send, Discard, Attach) with a More actions menu, the fields above the message scroll instead of pushing it out, and many recipients or attachments get a box with a scroll bar. Suggestions, the Send later popover and the Sign menu are no longer cut off
- Drafts: Bcc recipients and the display names of To, Cc and Bcc are kept in a saved draft and come back when you reopen it (a reopened draft sent without its Bcc before); a reply you reopen keeps its In-Reply-To and References headers and stays in its conversation; a picture in it keeps its file name; saving or sending removes only that draft, not every draft of the conversation or a version saved in another mail program
- The copy in the Sent folder is exactly the message that was sent (it was two bytes shorter)
- Reply goes to the Reply-To address when there is one and says so under To (with a button to reply to the sender instead); Reply all adds the other people without repeating anyone, leaving out your own addresses; Reply and Reply all keep display names, also with a comma ("Doe, John")
- Reply and Forward no longer flatten the original: tables, colours, fonts, lists and alignment arrive as they were. Forward carries the attachments of the original (you can remove them before sending); pictures in the text stay in the text. The header lines of a reply and of a forward are shown as text, even when a name or subject contains markup
- Recipients: a person is in one of To, Cc and Bcc only (the first one that has them) and a note says where an address already is; an address with a quoted name such as "Doe, John" <john@example.com> stays one recipient, also when pasted or dropped; a list copied from a spreadsheet becomes one recipient per row; the Enter that confirms a conversion with a Japanese, Chinese or Korean input method no longer creates a recipient
- Pasting from a web page: pictures from the web are no longer fetched while you write (they are not pasted, with a short notice), and pictures that point to a file or a network path (\\server\share) are never sent as picture sources
- After pasting formatted text and choosing Keep text only or Merge formatting, the text no longer stays bold when it was pasted at the start of a paragraph, and what you type next continues in the format you had before
- macOS: Cmd+Shift+V pastes the clipboard as plain text in the message you write, in the signature and template editors and in To and Subject (it pasted nothing before)
- Ctrl+1 and Ctrl+2 with a button of the message toolbar selected no longer switches away and blanks the message you are writing
- Report, Snooze and the other buttons that need a selected mail are greyed out while a message is open and no mail is selected
- Writing in a window of its own: "Scheduled for ..." shows the Undo and View buttons in the main window again
- Add account: when the system keyring is locked or does not answer, the form ends after 30 seconds with "Your system keyring is locked or not answering. Unlock it (Passwords and Keys / KWallet) and try again." instead of waiting for ever, and Cancel works during the wait (nothing is left in the keyring)
- Settings no longer jump while you use them: in Settings > AI Assistant the model-list messages have a fixed place under Save, "Remove the saved key" is on the line of the API key label, and the Model box keeps its focus when the list arrives; in Add account and Settings > mailbox > Calendar the sign-in messages take turns in one place of fixed size under the button, and the focus goes back to the button when a sign-in ends
- Settings > AI Assistant: when saving fails (a locked key store, a file that cannot be written) the reason is shown under Save in all languages and what you typed stays; before, nothing was shown
- AI Assistant errors: an answer the app cannot read is one sentence in your language, not the raw reply of the provider; the message for an Assistant that is not set up says so in its title; an error about the connection no longer shows a password or a token that is part of the address in Settings; a failed translation in the message has an Open AI Assistant settings link
- A link inside a PDF attachment no longer takes the window away from the app: the window now stays in the app for every web address except the app's own (a link to another program on your own computer, such as 127.0.0.1, was let through before)
- The button that folds the side menu stays at the top of the menu while the list of folders scrolls, in the full menu and in the column of icons
- A message you deleted or archived leaves the list when its Undo time ends, also when the window was hidden to the tray at that time (it could stay listed until the next refresh); the list is read again when the window comes back
- The corner handles of a selected picture are cut off with the editor when you scroll the message, instead of showing over the To row and the attachments
- Closing a reply or a forward in which you typed nothing (Discard, or closing its window) no longer asks "Discard this message?"; a letter, an address or an attachment you added still asks
- The corner handles of a selected picture are no longer drawn over the Settings dialog or other windows: they show only while the message has the focus
- Find and replace on a Mac: the Replace row can be reached (a button with an arrow on the Find panel, a Replace item in the More menu, and Cmd+Shift+H); Windows and Linux keep Ctrl+H
- The Symbol popup is as wide as its grid (the last column was cut off) and its symbols are readable in the dark theme
- The More menu of the message toolbar fits the window, scrolls when it is longer than the room, shows a shadow where more rows wait, and keeps the row you reach with the arrow keys in view
- Save draft can no longer delete other drafts: when it replaces the previous copy of a draft, every message the mail server proposes is checked by its own Message-ID header first, so a server that ignores that search (and answers with every message) loses nothing; never more than 5 messages are removed in one replace, and if the check cannot be made the old copy is left in place (a stale copy, never a lost draft)
- macOS: the title bar of a window of its own (message or conversation) follows Light and Dark with the system again when the app theme is System; a message window opened in Dark mode kept a black title bar after the Mac went to Light. Every window now gets the title bar theme from one place when it opens, when you change the theme in Settings (Light and Dark too) and when the system changes (it was set once, by the window itself); the app checks every few seconds that each title bar shows what it should; the message window's page no longer fixes itself to the screen edge, which kept the colour under its title bar from changing
- A message with Meeting on in a small window: switching Meeting on brings the meeting row (When, Where) into view instead of leaving it cut through by the lower edge of the scrolling header, and a field that a focus or Tab scrolls into view no longer hides under the sticky action row

### Known limitations

- PDF files open in your default app on macOS and Linux (the preview offers Open and Save as); the PDF is drawn inside the app only on Windows
- Confidential mail: Linux has no screenshot blocking (the window is hidden from screen capture and recording on Windows and macOS only)
- macOS: a pop-out window that is closed leaves a small, invisible native window entry behind (about 1.4 MB each, not drawn); it is freed when you quit the app
- macOS: native notifications are not available yet; they need an Apple Developer ID, and macOS may not show banners for a self-signed app
- Linux: the app does not follow the KDE or GNOME colour scheme on its own; choose Light or Dark in Settings > Appearance
- Linux: the x86_64 release packages (AppImage, .deb, .rpm) are not covered by the tests, which ran on an ARM virtual machine
- Format Painter, AutoFormat and the mini toolbar are not included yet
- There is no plain-text-only mode when writing a message

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
- Website: "No ads" now stands next to "Free" and "No account" (home page, comparison table, features, download page, footer) in all eight languages
- Website: the live preview of the Appearance choices with Reading pane = Bottom no longer squeezes the mail rows on top of each other; the list scrolls, Compact is one line like in the app, and the folder column and long messages fit at every text size and window width

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
