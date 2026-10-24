# imap 2.4.1, patched for Hey Look!

This is the unmodified crates.io source of `imap` 2.4.1 (licences: `LICENSE-APACHE`, `LICENSE-MIT`, kept) with two changes, listed in
`hey-look.patch` (apply with `patch -p1` from this folder):

1. `src/extensions/idle.rs` `Handle::init`: when the server answers `IDLE` with anything but a `+` continuation and the tagged answer is
   not `NO` / `BAD`, the crate hit `unreachable!()`. It now returns `Error::Parse(ParseError::Invalid(..))`.
2. `src/extensions/idle.rs` `Handle::make`: when `init` failed (for instance `tag NO` / `tag BAD` to IDLE), the half-built handle was
   dropped and its `Drop` sent `DONE` outside IDLE; a real server answers that with the tag `DONE` and the tag check of
   `read_response_onto` panicked. A failed `init` now marks the handle done, so nothing is sent.
3. `src/client.rs` `read_response_onto`: `assert_eq!` of the answer's tag is now an error (`Parse(Invalid)`) when it differs.
4. `src/parse.rs` `parse_mailbox`: an untagged `NO` / `BAD` / `BYE` line inside a SELECT / EXAMINE answer hit `unreachable!()`; the line
   is skipped.

5. `src/extensions/idle.rs`: new `Handle::wait_interruptible(timeout, poll, finish, stop)` (an addition, nothing changed). The IDLE read
   is cut into slices of `poll`; `stop()` is asked after each empty slice and ends the wait (no DONE is sent then); the read timeout is
   left at `finish`, so the answer to the DONE of the drop cannot block for ever (`wait_with_timeout` resets it to none). A thread blocked
   in a read cannot be woken from another thread on Windows when the peer is silent: `TcpStream::shutdown` returned the read only when
   the peer closed (measured: 60 s with a peer that did nothing), so stopping a push session needs this.

6. `src/client.rs`: new `Session::uid_search_with_literals(parts)` and `SearchPart` (an addition, nothing changed): `UID SEARCH` with literals (`{n}`, the server's `+`, the bytes), for search text that is not ASCII (server search, W6.7). `hey-look.patch` does not list it; the code carries a comment.

Why: Hey Look! is built with `panic = "abort"`, so any panic in the crate ends the whole app, and a mail server must never be able to do
that. The tests `idle::tests::a_server_that_answers_idle_wrongly_...` and `an_untagged_alert_inside_the_examine_answer_...` run the IDLE
worker against a fake server that does each of this; without the patch they fail with a panic.

`Cargo.toml` is the crate's own, minus the example / integration-test targets, the dev-dependencies and the badges (a path dependency
builds none of them). Wired in with `[patch.crates-io]` in `src-tauri/Cargo.toml`. When upstream fixes these, delete this folder and the
`[patch]` entry.
