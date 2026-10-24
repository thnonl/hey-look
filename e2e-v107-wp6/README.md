# QA kit for WP6 (mail core and data safety), 1.0.7

Outside every repo. Written by the coder (branch `feature/v107-wp6`). Throw-away stub mailboxes only.

## Files

- `stub-wp6.mjs` - the stub (IMAP over TLS 19871, SMTP over TLS 19872, admin HTTP 19873), lineage `test-builds\bridge\qa\stub.mjs` (r10 to r20). Certificate files are read from `test-builds\bridge\qa\`. Start: `node E:\hey-mail\e2e-v107-wp6\stub-wp6.mjs` (stop it by its PID only). Log: `stub-wp6.log`; every SMTP DATA and every APPEND is saved in `cap\`.
- `smoke.mjs` - self-check of the stub (starts its own copy and stops it by PID): `node E:\hey-mail\e2e-v107-wp6\smoke.mjs`. Run it after any change of the stub; it prints `wp6 stub smoke: ok`.
- Account in the app: IMAP `127.0.0.1:19871` SSL/TLS, SMTP `127.0.0.1:19872` SSL/TLS, any user and password, "Trust this certificate" on.

## Admin switches (GET, `http://127.0.0.1:19873`)

| Switch | What it does | Spec name |
|---|---|---|
| `/cfg?uidplus=0\|1&move=0\|1` | CAPABILITY without UIDPLUS (UID EXPUNGE is BAD) / without MOVE (UID MOVE is BAD) | `uidplus`, `move` |
| `/cfg?renumber=<folder>` or `/renumber?folder=<f>` | new UIDVALIDITY (+1) for that folder only; its messages get UIDs 1..n in the opposite order | `renumber` |
| `/cfg?markDeleted=<folder>:<uid>` or `/markdeleted?folder=&uid=&v=0\|1` | a `\Deleted` mark set by another client | `markDeleted` |
| `/remove?folder=&uid=` | another client deleted the message for good | |
| `/cfg?refuseCreate=1` | CREATE answers NO | `refuseCreate` |
| `/cfg?appendDelay=<ms>` | APPEND is stored and answered after the delay (kill the app meanwhile) | `appendDelay` |
| `/cfg?searchDelay=<ms>` | SEARCH answers after the delay (Cancel test) | `searchDelay` |
| `/cfg?xgm=1` (`gmail=1`) | advertises X-GM-EXT-1 and answers X-GM-RAW | `xgm` |
| `/cfg?maxConnections=<n>` | the n+1st logged-in connection gets `NO [UNAVAILABLE]` | `maxConnections` |
| `/mode?holdAfterData=<ms>` | SMTP: the 250 after DATA is held back (the message is saved when DATA ends) | `holdAfterData` |
| `/mode?dropAfter250=1` | SMTP: the connection is closed right after the 250 | `dropAfter250` |
| `/msgids` | Message-IDs the SMTP side received, in order (same ID twice = sent twice) | |
| `/seedmany?folder=INBOX&n=2100&subj=...&clear=1&days=...` | n mails at once (AC-6.3.x, 6.7.5: `subj=invoice&n=450`) | |
| `/fixture?name=links\|nfd\|pt\|ko\|attach[&names=a.txt,x.AppImage]` | the kit mails (below) | |
| `/state`, `/log`, `/caplist`, `/inject`, `/injectraw`, `/folder`, `/reseed` | as in the earlier kits; `/state` also lists `validity` per folder | |

Not in the stub: a `.` folder delimiter (AC-6.4.2 is covered by the Rust test `drafts_tests` with the fake server; on a real server of that kind use any Dovecot with `INBOX.` namespace).

## Fixtures

- `links`: the 10 links of AC-6.14.1 (ids `l1`..`l10`, the expected result is written beside each link): 3, 4, 5, 6 warn (L1, L2, L3 target `xn--pple-43d.test`, L4 target `evil.test`), 1, 2, 7, 8, 9, 10 do not.
- `nfd`: the first line "Xem thư này trên trình duyệt" is NFD (combining marks); `pt` "Ver este e-mail no navegador"; `ko` "브라우저에서 보기". The list preview and the notification start with the real content.
- `attach`: attachments `a.txt, install.command, x.AppImage, a.webloc, y.deb, a.pdf` (AC-6.8, 6.15).

## Debug seams of the app (debug builds)

`HEYLOOK_TEST_SYNC_DELAY_MS` (AC-6.1.7: holds the sync back so a Delete comes first), `HEYLOOK_TEST_OUTBOX_TICK_S=120` (AC-6.12.1: the outbox worker has not ticked), `HEYLOOK_TEST_QUIT_PAGE`. Data folder of the build is its own.

## Per row: what to do, and what the automated tests already cover

The Rust tests (`cargo test --lib`: `uidvalidity_tests`, `drafts_tests`, `sendonce_tests`, `limit_tests`, `serversearch`, `mail`, `smtp`, `attach`, `snippet`, `pgpstore`, `idle`) and the node tests registered in `.github/node-tests.txt` cover the logic with a fake server; the rows below need the real app against this stub.

| Row | QA on Windows (stub) | Tests that already pin it |
|---|---|---|
| W6.1 UIDVALIDITY (AC-6.1.1 to 6.1.8) | `renumber`, `markDeleted`, `uidplus`, `move` as the AC says; stub log: no STORE/MOVE/EXPUNGE after the renumber, `UID EXPUNGE` carries only our UIDs; startup.log `folder:` lines | `uidvalidity_tests.rs`, `foldermove_tests`, `readrace_tests`, `test-folder-reset.mjs` |
| W6.4 Drafts folder (AC-6.4.1 to 6.4.7, 6.17.1) | stub without `Drafts` (delete it with `/folder?op=del&name=Drafts`), `refuseCreate=1`, create it by `/folder?op=add` while the app runs | `drafts_tests.rs` |
| W6.5 / W6.12 exactly once and quit (AC-6.5.x, 6.12.x) | `appendDelay`, `holdAfterData`, `dropAfter250`, `/msgids`; kill the process by PID | `sendonce_tests.rs`, `test-quit-flush.mjs` |
| W6.3 limit (AC-6.3.x) | `/seedmany?n=2100`, limit 2000 then 500 | `limit_tests.rs`, `test-prune-limit.mjs`, `test-list-limit-footer.mjs` |
| W6.2 Junk rule (AC-6.2.x) | two mailboxes, B without Junk | `test-junk-folder.mjs` |
| W6.11 / W6.17b update | data folder with an old `update_cache`; the update kit of round u1 | `update.rs` tests, `test-update-toast.mjs` |
| W6.6 push folders (AC-6.6.x) | Favorites; `/inject?folder=Sent`; `maxConnections=3` | `idle.rs` tests |
| W6.7 server search (AC-6.7.x) | `/seedmany?subj=invoice&n=12&folder=Archive`, `n=450` for the cap, `searchDelay=10000` for Cancel, `xgm=1` for the Gmail path; `from:` `after:` `is:unread` `has:attachment` | `serversearch.rs` tests, `test-server-search-ui.mjs` |
| W6.8 folder name (AC-6.8.x) | custom save folder `E:\QA\v107 saves`, `D:\`; `/fixture?name=attach` | `test-folder-name.mjs` |
| W6.9 secure connection (AC-6.9.x) | account with SSL on a plain port (the stub's `19873` admin port answers plain HTTP: use it as the "plain" port), STARTTLS on a silent port; startup.log `connect:` line has the raw text | `mail.rs`, `smtp.rs`, `test-send-error-text.mjs` |
| W6.10 PGP S2K (AC-6.10.x) | import a secret key without passphrase: refused text | `pgpstore.rs` `every_stored_secret_key_is_passphrase_protected_with_a_strong_s2k` (run with `--nocapture` for the S2K lines) |
| W6.13 notification text (AC-6.13.1) | `/fixture?name=nfd`, `pt`, `ko`: the Windows notification and the list preview | `snippet.rs` tests |
| W6.14 link warning (AC-6.14.x) | `/fixture?name=links`: click each of the 10 links in the pane, by the context menu "Open link" and in a reader window | `test-link-check.mjs` |
| W6.15 / W6.16 | Mac and Linux only (see `webkit-checks-107.md` section 37, rows WK-37.12, WK-37.13); Windows: `.exe` still asks | `attach.rs` tests |

WebKit rows for Mac / Linux: `E:\hey-mail\reports\v1-0-1\webkit-checks-107.md`, section 37.
