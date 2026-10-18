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

/// The text of a source file outside its inline test modules, for the tests that read the sources. Line endings are normalised. The
/// cut is at the first `#[cfg(test)]` that is directly followed by a `mod name {` block (other attributes may sit between them), not at
/// the first `#[cfg(test)]` anywhere: a single `#[cfg(test)]` function or `mod x;` declaration in the middle of the code must not
/// make the rest of the file invisible to a guard (that is how a guard went blind and passed or failed for the wrong reason).
pub fn non_test_code(src: &str) -> String {
    let src = src.replace("\r\n", "\n");
    let lines: Vec<&str> = src.lines().collect();
    for (i, l) in lines.iter().enumerate() {
        if l.trim() != "#[cfg(test)]" {
            continue;
        }
        let next = lines[i + 1..].iter().map(|l| l.trim()).find(|l| !l.starts_with("#["));
        if next.is_some_and(|l| (l.starts_with("mod ") || l.starts_with("pub mod ")) && l.ends_with('{')) {
            return lines[..i].join("\n");
        }
    }
    src
}

#[cfg(test)]
mod tests {
    use super::non_test_code;

    #[test]
    fn the_cut_is_at_the_first_inline_test_module() {
        let src = "fn a() {}\n#[cfg(test)]\nfn only_in_tests() {}\nfn b() {}\n#[cfg(test)]\nmod x;\n#[cfg(test)]\n#[allow(dead_code)]\nmod tests {\n}\n";
        let code = non_test_code(src);
        assert!(code.contains("fn b()") && code.contains("mod x;") && !code.contains("mod tests"), "{code}");
        assert_eq!(non_test_code("fn a() {}\r\n#[cfg(test)]\r\nmod tests {\r\n}\r\n"), "fn a() {}");
        assert_eq!(non_test_code("fn a() {}"), "fn a() {}");
    }
}
