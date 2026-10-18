//! The scripts the bridge runs in a page. The page side (`bridge.js`) is pasted in front of every request: the content security policy of
//! the app forbids `eval`, so a script given to /eval is placed into the text of the script the web view runs, not evaluated by the page.

/// The page side: console ring buffer, safe JSON, click / type / key. Also the initialization script of every window.
pub const BRIDGE_JS: &str = include_str!("bridge.js");

/// A JSON string literal that is also safe inside a script (`</script>` cannot occur: it is never put in an HTML page).
pub fn lit(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// The script that starts a request. `body` is the body of a function (use `return`); with `await_promise` it is an async function and
/// the answer is waited for, otherwise it runs at once. The script returns the answer envelope when it is already there, else `{"done":false}`.
pub fn start_script(id: &str, body: &str, await_promise: bool) -> String {
    let run = if await_promise {
        format!("(async function () {{\n{body}\n}})().then(function (v) {{ H.finish(id, true, v); }}, function (e) {{ H.finish(id, false, e); }});")
    } else {
        format!("try {{ var v = (function () {{\n{body}\n}})(); H.finish(id, true, v); }} catch (e) {{ H.finish(id, false, e); }}")
    };
    format!("{BRIDGE_JS}\n;(function () {{ var H = window.__hlb; var id = {}; H.begin(id); try {{ {run} }} catch (e) {{ H.finish(id, false, e); }} return H.take(id); }})()", lit(id))
}

/// The script that asks for the answer of a request.
pub fn poll_script(id: &str) -> String {
    format!("(window.__hlb ? window.__hlb.take({}) : '{{\"done\":true,\"ok\":false,\"error\":\"the page was reloaded while the script ran\"}}')", lit(id))
}

/// Whether `js` is a single expression (`document.title`) rather than a function body: one line, no `;`, no `return`. Such a script gets
/// its `return` added; anything else must say `return` itself.
pub fn is_expression(js: &str) -> bool {
    let t = js.trim();
    if t.is_empty() || t.contains('\n') || t.contains(';') {
        return false;
    }
    let bytes = t.as_bytes();
    let mut from = 0;
    while let Some(p) = t[from..].find("return") {
        let at = from + p;
        let before_ok = at == 0 || !(bytes[at - 1].is_ascii_alphanumeric() || bytes[at - 1] == b'_' || bytes[at - 1] == b'$' || bytes[at - 1] == b'.');
        let after = at + 6;
        let after_ok = after >= bytes.len() || !(bytes[after].is_ascii_alphanumeric() || bytes[after] == b'_' || bytes[after] == b'$');
        if before_ok && after_ok {
            return false;
        }
        from = at + 6;
    }
    true
}

/// The body of the function that /eval runs.
pub fn eval_body(js: &str) -> String {
    if is_expression(js) { format!("return ({});", js.trim()) } else { js.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expressions_and_bodies() {
        for e in ["document.title", "  1 + 1 ", "window.__store.getState().language", "await fetch('/x').then(r => r.status)", "returnValue + 1", "a.return", "x ? 1 : 2"] {
            assert!(is_expression(e), "{e}");
        }
        for b in ["", "const a = 1; return a", "return document.title", "a;\nb", "x\ny", "return(1)", "{ return 1 }"] {
            assert!(!is_expression(b), "{b}");
        }
        assert_eq!(eval_body("document.title"), "return (document.title);");
        assert_eq!(eval_body("return 5"), "return 5");
    }

    #[test]
    fn start_script_pastes_the_body() {
        let s = start_script("r1", "return 1 + 1", true);
        assert!(s.contains("(async function () {\nreturn 1 + 1\n})()"));
        assert!(s.contains("var id = \"r1\";"));
        assert!(s.starts_with("/* Page side of the test bridge"));
        let s = start_script("r2", "return 2", false);
        assert!(s.contains("(function () {\nreturn 2\n})()") && !s.contains("(async function () {\nreturn 2"));
        assert!(poll_script("r1").contains("take(\"r1\")"));
    }

    #[test]
    fn nothing_evaluates_text_in_the_page() {
        // the content security policy has no 'unsafe-eval': the page side must never call eval / new Function
        for banned in ["eval(", "new Function", "setTimeout('", "setTimeout(\""] {
            assert!(!BRIDGE_JS.contains(banned), "bridge.js contains {banned}");
        }
    }
}
