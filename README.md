# Hey Look!

Desktop email client (Tauri 2 + React + TypeScript + Rust).
Every feature is always on: there are no plans, tiers, license checks or paywalls in this codebase.

## Features (v1)

- Multi-account IMAP/SMTP (Gmail, Outlook, iCloud, Yahoo, custom) with app-password auth; passwords live in Windows Credential Manager
- Unified inbox, per-account view, conversation threading (References / In-Reply-To)
- Folders: Inbox, Unread, Starred, Pinned, Snoozed, Scheduled, Sent, Drafts, Archive, Junk, Trash
- Full-text-ish search (subject, sender, snippet, body)
- Compose: rich text (TipTap), attachments, Cc/Bcc, contact autocomplete, signatures, templates
- Undo send (configurable window), schedule send (outbox worker, survives restarts while the app runs)
- Snooze, pin, star, mark unread, archive, trash, junk, block sender, 1-click unsubscribe (RFC 8058) / mailto fallback
- Remote content (tracking pixels) blocked by default; messages render in a script-less sandboxed iframe
- AI Copilot: summarize a thread, "Let AI write" in compose, via any OpenAI-compatible endpoint (Settings -> AI)
- Command bar (Ctrl+K), keyboard shortcuts (c / j k e # ! s p * u r a), dark mode

## Not in v1 (needs more work)

PGP / encrypted send, calendar, shared inbox / team features, Gmail & Microsoft OAuth (use app passwords for now),
read-receipt tracking pixels (needs a server), inline `cid:` images, attachment download, push/IDLE (polls every 2 min).

## Dev

```bash
npm install
npm run tauri dev      # run
npm run tauri build    # installer
```

Requires Rust (MSVC), Node 20+, WebView2.
