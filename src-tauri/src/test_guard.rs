//! Test helper: a test that talks to a socket must fail, not hang the whole suite, when the other side never answers.

use std::sync::mpsc;
use std::time::Duration;

/// Run `f` on its own thread and give it `secs` seconds. A panic inside `f` is re-raised here; a run that does not finish panics with
/// "hung", leaving the stuck thread behind (it dies with the test process).
pub fn within<T: Send + 'static>(secs: u64, f: impl FnOnce() -> T + Send + 'static) -> T {
    let (tx, rx) = mpsc::channel();
    let handle = std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    match rx.recv_timeout(Duration::from_secs(secs)) {
        Ok(v) => v,
        Err(mpsc::RecvTimeoutError::Timeout) => panic!("test hung: no result after {secs} s"),
        Err(mpsc::RecvTimeoutError::Disconnected) => match handle.join() {
            Err(p) => std::panic::resume_unwind(p),
            Ok(()) => unreachable!("the closure ended without sending its result"),
        },
    }
}
