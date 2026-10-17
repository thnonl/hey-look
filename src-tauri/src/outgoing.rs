//! The outgoing HTML sanitiser (QA round 17, BUG-05; spec-rich-text.md REQ-2 / REQ-3).
//!
//! Every message body is cleaned here when the MIME is built (`smtp::body`), which is the one place that Send, Send later, the
//! Undo-send hold, the outbox update and Save draft all pass through. It is an allow-list: the input is tokenised, and only the tags,
//! attributes, URL schemes and CSS properties named below are written to the output (rebuilt from the parsed pieces, never copied), so
//! whatever the editor, a paste, a signature, a template or a tampered database row put into the HTML, what leaves the computer is:
//!   - no script, frame, object, embed, form, base, meta, link, style or svg content (and no comment / conditional comment);
//!   - no event attributes, `srcset`, `background`, `data-*`, `contenteditable`, ProseMirror classes (only `class="sig"`);
//!   - links only to http, https, mailto and tel; picture sources only `cid:`, `data:image/(png|jpeg|gif|webp);base64,...` (size cap) and
//!     http(s); never `file:`, UNC (`\\host\share`), `//host`, `ftp:`, `javascript:`, `vbscript:`, `data:text/html`;
//!   - `style` only with the properties of `CSS_PROPS` and values without `url()`, `expression()`, escapes, `@import`.
//! The output is well formed (every element it opens is closed, stray end tags are dropped).

/// Tags that are written. Everything else is unwrapped (its text stays) or, for `DROP_WITH_CONTENT`, removed with its content.
const ALLOWED_TAGS: &[&str] = &[
    "p", "br", "div", "span", "strong", "b", "em", "i", "u", "s", "strike", "sub", "sup", "a", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
    "blockquote", "pre", "code", "hr", "img", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
];
const VOID_TAGS: &[&str] = &["br", "hr", "img", "col"];
/// Removed together with everything inside (their text is not content of the message). The first group is raw text in HTML (ends at the
/// first matching end tag); the second can nest.
const RAW_TEXT_DROP: &[&str] = &["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript", "plaintext"];
const NESTED_DROP: &[&str] = &["object", "applet", "svg", "math", "template", "select", "frameset"];
/// A picture of a message may be this long as a `data:` URI (characters); a larger one is dropped (pictures travel as `cid:` parts).
pub const MAX_DATA_URI: usize = 8 * 1024 * 1024;

const CSS_PROPS: &[&str] = &[
    "font-family", "font-size", "font-weight", "font-style", "text-decoration", "color", "background-color", "text-align", "line-height",
    "margin", "margin-top", "margin-right", "margin-bottom", "margin-left", "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
    "border", "border-top", "border-right", "border-bottom", "border-left", "border-color", "border-style", "border-width", "border-collapse",
    "width", "height", "max-width", "vertical-align", "list-style-type", "direction", "white-space",
];
const CSS_FUNCTIONS: &[&str] = &["rgb", "rgba", "hsl", "hsla"];

fn is_ws(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\n' | b'\r' | 0x0c)
}

/// `&amp; &lt; &gt; &quot; &apos; &nbsp;` and numeric references (also without the closing `;`, as browsers read them). Anything else
/// stays as written; it is escaped again on output, so an entity this does not know can never turn into markup or a scheme.
fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'&' {
            let start = i;
            while i < b.len() && b[i] != b'&' {
                i += 1;
            }
            out.push_str(&s[start..i]);
            continue;
        }
        let rest = &s[i + 1..];
        if let Some(num) = rest.strip_prefix('#') {
            let (hex, digits) = match num.strip_prefix(['x', 'X']) {
                Some(h) => (true, h),
                None => (false, num),
            };
            let len = digits.bytes().take_while(|c| if hex { c.is_ascii_hexdigit() } else { c.is_ascii_digit() }).count();
            if len > 0 && len <= 8 {
                let v = u32::from_str_radix(&digits[..len], if hex { 16 } else { 10 }).unwrap_or(0xFFFD);
                out.push(char::from_u32(v).filter(|c| *c != '\0').unwrap_or('\u{FFFD}'));
                let used = 1 + 1 + usize::from(hex) + len;
                i += used + usize::from(s.as_bytes().get(i + used) == Some(&b';'));
                continue;
            }
        } else {
            let named: [(&str, char); 6] = [("amp;", '&'), ("lt;", '<'), ("gt;", '>'), ("quot;", '"'), ("apos;", '\''), ("nbsp;", '\u{a0}')];
            if let Some((name, c)) = named.iter().find(|(n, _)| rest.starts_with(n)) {
                out.push(*c);
                i += 1 + name.len();
                continue;
            }
        }
        out.push('&');
        i += 1;
    }
    out
}

fn esc_attr(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
}

/// A URL as a browser would read it: tab / newline removed, leading and trailing blanks cut, spaces inside written as `%20`, other
/// control characters dropped. The scheme is judged on this value.
fn normalize_url(raw: &str) -> String {
    let s = decode_entities(raw);
    let s: String = s.chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect();
    let s = s.trim_matches(|c: char| c <= ' ' || c == '\u{a0}' || c.is_control());
    s.chars().filter(|c| !c.is_control()).collect::<String>().replace(' ', "%20")
}

fn has_scheme(url: &str, scheme: &str) -> bool {
    url.len() > scheme.len() && url.get(..scheme.len()).is_some_and(|p| p.eq_ignore_ascii_case(scheme))
}

/// http(s) with a host: not `//host`, not `\\host`, not `file:` ...
fn is_web_url(url: &str) -> bool {
    (has_scheme(url, "http://") || has_scheme(url, "https://")) && !url.contains('\\')
}

/// `href` of a link: http, https, mailto, tel.
fn safe_href(raw: &str) -> Option<String> {
    let u = normalize_url(raw);
    (is_web_url(&u) || has_scheme(&u, "mailto:") || has_scheme(&u, "tel:")).then_some(u)
}

/// `src` of a picture: `cid:`, `data:image/(png|jpeg|gif|webp);base64,` (not larger than `MAX_DATA_URI`), http(s).
fn safe_src(raw: &str) -> Option<String> {
    let u = normalize_url(raw);
    if is_web_url(&u) {
        return Some(u);
    }
    if has_scheme(&u, "cid:") {
        let id = &u[4..];
        return (id.len() <= 255 && !id.is_empty() && !id.contains(['<', '>', '"', '\'', '\\'])).then_some(u);
    }
    if has_scheme(&u, "data:image/") && u.len() <= MAX_DATA_URI {
        let lower: String = u.chars().take(40).collect::<String>().to_ascii_lowercase();
        let ok_type = ["data:image/png;base64,", "data:image/jpeg;base64,", "data:image/gif;base64,", "data:image/webp;base64,"].iter().find(|p| lower.starts_with(*p));
        if let Some(p) = ok_type {
            let payload = &u[p.len()..];
            if !payload.is_empty() && payload.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'/' | b'=' | b'%')) {
                return Some(u);
            }
        }
    }
    None
}

fn digits(v: &str, max_len: usize, percent: bool) -> Option<String> {
    let v = decode_entities(v);
    let v = v.trim();
    let (num, pct) = match v.strip_suffix('%') {
        Some(n) if percent => (n, true),
        _ => (v, false),
    };
    (!num.is_empty() && num.len() <= max_len && num.bytes().all(|c| c.is_ascii_digit())).then(|| format!("{num}{}", if pct { "%" } else { "" }))
}

fn color(v: &str) -> Option<String> {
    let v = decode_entities(v);
    let v = v.trim();
    let hex = v.strip_prefix('#').unwrap_or(v);
    let is_hex = matches!(hex.len(), 3 | 4 | 6 | 8) && hex.bytes().all(|c| c.is_ascii_hexdigit());
    let is_name = (3..=20).contains(&v.len()) && v.bytes().all(|c| c.is_ascii_alphabetic());
    (is_hex || is_name).then(|| if is_hex && !v.starts_with('#') { format!("#{v}") } else { v.to_string() })
}

/// One `style` attribute: the declarations with an allowed property and a plain value. `None` when nothing is left.
fn clean_style(raw: &str) -> Option<String> {
    let s = decode_entities(raw);
    if s.contains(['\\', '<', '>']) || s.contains("/*") {
        // CSS escapes and comments can hide a function name or a scheme: nothing of this attribute is trusted
        return None;
    }
    let mut kept: Vec<String> = vec![];
    // declarations are split on `;` outside quotes and parentheses
    let (mut depth, mut quote, mut start) = (0i32, None::<char>, 0usize);
    let mut parts: Vec<&str> = vec![];
    for (i, c) in s.char_indices() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '"' | '\'') => quote = Some(c),
            (None, '(') => depth += 1,
            (None, ')') => depth -= 1,
            (None, ';') if depth <= 0 => {
                parts.push(&s[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&s[start..]);
    for decl in parts {
        let Some((prop, value)) = decl.split_once(':') else { continue };
        let prop = prop.trim().to_ascii_lowercase();
        let value = value.trim();
        if !CSS_PROPS.contains(&prop.as_str()) || value.is_empty() || value.len() > 300 {
            continue;
        }
        let value = value.trim_end_matches("!important").trim();
        let plain = value.chars().all(|c| !c.is_control() && !matches!(c, '{' | '}' | '@' | '/' | '=' | '`' | '$'));
        // every `name(` must be one of the colour functions (no url(), image-set(), expression(), var(), attr() ...)
        let lower = value.to_ascii_lowercase();
        let mut funcs_ok = true;
        let lb = lower.as_bytes();
        for (i, &c) in lb.iter().enumerate() {
            if c == b'(' {
                let mut j = i;
                while j > 0 && is_ws(lb[j - 1]) {
                    j -= 1;
                }
                let end = j;
                while j > 0 && (lb[j - 1].is_ascii_alphanumeric() || lb[j - 1] == b'-') {
                    j -= 1;
                }
                funcs_ok &= CSS_FUNCTIONS.contains(&&lower[j..end]);
            }
        }
        if plain && funcs_ok && !lower.contains("javascript") && !lower.contains("expression") && !lower.contains("import") {
            kept.push(format!("{prop}:{value}"));
        }
    }
    (!kept.is_empty()).then(|| kept.join(";"))
}

/// The attributes of an allowed tag that are written, as `(name, value)` with the value already unescaped.
fn clean_attrs(tag: &str, attrs: &[(String, String)]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = vec![];
    let mut put = |k: &str, v: Option<String>| {
        if let Some(v) = v {
            if !out.iter().any(|(n, _)| n == k) {
                out.push((k.to_string(), v));
            }
        }
    };
    for (k, raw) in attrs {
        let v = raw.as_str();
        match (tag, k.as_str()) {
            (_, "style") => put("style", clean_style(v)),
            (_, "dir") => put("dir", Some(decode_entities(v).trim().to_ascii_lowercase()).filter(|d| matches!(d.as_str(), "ltr" | "rtl" | "auto"))),
            (_, "align") => put("align", Some(decode_entities(v).trim().to_ascii_lowercase()).filter(|d| matches!(d.as_str(), "left" | "right" | "center" | "justify"))),
            // the signature region is found again by its class when a draft is opened; no other class is written
            ("div", "class") => put("class", decode_entities(v).split_whitespace().any(|c| c.eq_ignore_ascii_case("sig")).then(|| "sig".to_string())),
            ("a", "href") => put("href", safe_href(v)),
            ("img", "src") => put("src", safe_src(v)),
            ("img", "alt") => put("alt", Some(decode_entities(v)).filter(|a| a.len() <= 1000)),
            ("img", "title") | ("a", "title") => put("title", Some(decode_entities(v)).filter(|a| a.len() <= 1000)),
            ("img", "width") | ("img", "height") | ("td", "width") | ("th", "width") | ("td", "height") | ("th", "height") | ("table", "width") | ("col", "width") => {
                put(k, digits(v, 5, true))
            }
            ("ol", "start") | ("li", "value") | ("td", "colspan") | ("td", "rowspan") | ("th", "colspan") | ("th", "rowspan") | ("col", "span") | ("colgroup", "span") => {
                put(k, digits(v, 3, false))
            }
            ("ol", "type") => put("type", Some(decode_entities(v).trim().to_string()).filter(|d| matches!(d.as_str(), "1" | "a" | "A" | "i" | "I"))),
            ("table", "border") | ("table", "cellpadding") | ("table", "cellspacing") => put(k, digits(v, 3, false)),
            ("table", "bgcolor") | ("td", "bgcolor") | ("th", "bgcolor") | ("tr", "bgcolor") => put("bgcolor", color(v)),
            ("td", "valign") | ("th", "valign") | ("tr", "valign") => {
                put("valign", Some(decode_entities(v).trim().to_ascii_lowercase()).filter(|d| matches!(d.as_str(), "top" | "middle" | "bottom" | "baseline")))
            }
            _ => {}
        }
    }
    out
}

/// Parsed start tag: lower-case name, attributes (name lower-cased, value as written but without the quotes), `/>`.
struct Start {
    name: String,
    attrs: Vec<(String, String)>,
    self_closing: bool,
}

/// The tag that begins at `b[i] == '<'` (followed by a letter). Returns it with the index after its `>`; `None` when the tag never ends
/// (a browser reads the rest of the text as part of that tag, so the rest is dropped).
fn parse_start(s: &str, i: usize) -> Option<(Start, usize)> {
    let b = s.as_bytes();
    let mut j = i + 1;
    let ns = j;
    while j < b.len() && !is_ws(b[j]) && b[j] != b'/' && b[j] != b'>' {
        j += 1;
    }
    let name = s[ns..j].to_ascii_lowercase();
    let mut attrs = vec![];
    let mut self_closing = false;
    loop {
        while j < b.len() && (is_ws(b[j]) || b[j] == b'/') {
            self_closing = b[j] == b'/';
            j += 1;
        }
        if j >= b.len() {
            return None;
        }
        if b[j] == b'>' {
            return Some((Start { name, attrs, self_closing }, j + 1));
        }
        self_closing = false;
        let ks = j;
        // an attribute name may start with `=` (kept as part of the name, like a browser); it runs to blank, `/`, `>` or `=`
        j += 1;
        while j < b.len() && !is_ws(b[j]) && b[j] != b'/' && b[j] != b'>' && b[j] != b'=' {
            j += 1;
        }
        let key = s[ks..j].to_ascii_lowercase();
        while j < b.len() && is_ws(b[j]) {
            j += 1;
        }
        let mut value = String::new();
        if j < b.len() && b[j] == b'=' {
            j += 1;
            while j < b.len() && is_ws(b[j]) {
                j += 1;
            }
            if j < b.len() && (b[j] == b'"' || b[j] == b'\'') {
                let q = b[j];
                let vs = j + 1;
                let end = b[vs..].iter().position(|&c| c == q)?;
                value = s[vs..vs + end].to_string();
                j = vs + end + 1;
            } else {
                let vs = j;
                while j < b.len() && !is_ws(b[j]) && b[j] != b'>' {
                    j += 1;
                }
                value = s[vs..j].to_string();
            }
        }
        attrs.push((key, value));
    }
}

/// Position of the next `<` + `name` (case-insensitive) at or after `from` whose next byte ends a tag name; `closing` looks for `</name`.
fn find_tag(b: &[u8], from: usize, name: &str, closing: bool) -> Option<usize> {
    let n = name.as_bytes();
    let head = if closing { 2 } else { 1 };
    let mut i = from;
    while i < b.len() {
        let lt = b[i..].iter().position(|&c| c == b'<')? + i;
        let ok = b.len() >= lt + head + n.len()
            && (!closing || b[lt + 1] == b'/')
            && b[lt + head..lt + head + n.len()].eq_ignore_ascii_case(n)
            && b.get(lt + head + n.len()).is_none_or(|&c| is_ws(c) || c == b'/' || c == b'>');
        if ok {
            return Some(lt);
        }
        i = lt + 1;
    }
    None
}

/// Index after the `>` of the tag that starts at `at`; the end of the text when it has none.
fn after_tag(s: &str, at: usize) -> usize {
    s[at..].find('>').map(|g| at + g + 1).unwrap_or(s.len())
}

/// Index after the end tag of a raw-text element (`</script ...>`), searching from `from`; the end of the text when there is none.
fn skip_raw(s: &str, from: usize, name: &str) -> usize {
    find_tag(s.as_bytes(), from, name, true).map(|p| after_tag(s, p)).unwrap_or(s.len())
}

/// Index after the matching end tag of an element that can nest (`<svg>`, `<object>` ...), starting after its start tag.
fn skip_nested(s: &str, from: usize, name: &str) -> usize {
    let b = s.as_bytes();
    let (mut depth, mut at) = (1usize, from);
    loop {
        let (o, c) = (find_tag(b, at, name, false), find_tag(b, at, name, true));
        match (o, c) {
            (_, None) => return s.len(),
            (Some(op), Some(cp)) if op < cp => {
                depth += 1;
                at = op + 1 + name.len();
            }
            (_, Some(cp)) => {
                depth -= 1;
                if depth == 0 {
                    return after_tag(s, cp);
                }
                at = cp + 2 + name.len();
            }
        }
    }
}

/// The cleaned HTML of a message body (see the module comment).
pub fn clean_html(input: &str) -> String {
    let b = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut open: Vec<&'static str> = vec![];
    let mut i = 0;
    let mut text_start = 0;
    let flush = |out: &mut String, from: usize, to: usize| {
        if to > from {
            // text: entities are kept as written (they are text), a bare `<` or `>` is escaped
            for c in input[from..to].chars() {
                match c {
                    '<' => out.push_str("&lt;"),
                    '>' => out.push_str("&gt;"),
                    '\0' => {}
                    c => out.push(c),
                }
            }
        }
    };
    while i < b.len() {
        if b[i] != b'<' {
            i += 1;
            continue;
        }
        let next = b.get(i + 1).copied().unwrap_or(0);
        let is_tag = next.is_ascii_alphabetic();
        let is_end = next == b'/' && b.get(i + 2).is_some_and(|c| c.is_ascii_alphabetic());
        let is_markup = next == b'!' || next == b'?' || (next == b'/' && !is_end);
        if !is_tag && !is_end && !is_markup {
            i += 1; // a `<` that is only text
            continue;
        }
        flush(&mut out, text_start, i);
        if is_markup {
            // comment (also `<!--[if mso]>`), doctype, CDATA, processing instruction, `</ >`: dropped
            i = if input[i..].starts_with("<!--") {
                input[i + 4..].find("-->").map(|p| i + 4 + p + 3).unwrap_or(b.len())
            } else {
                input[i..].find('>').map(|p| i + p + 1).unwrap_or(b.len())
            };
            text_start = i;
            continue;
        }
        if is_end {
            let ns = i + 2;
            let mut j = ns;
            while j < b.len() && !is_ws(b[j]) && b[j] != b'/' && b[j] != b'>' {
                j += 1;
            }
            let name = input[ns..j].to_ascii_lowercase();
            i = input[j..].find('>').map(|p| j + p + 1).unwrap_or(b.len());
            text_start = i;
            if let Some(pos) = open.iter().rposition(|t| *t == name) {
                while open.len() > pos {
                    let t = open.pop().unwrap();
                    out.push_str("</");
                    out.push_str(t);
                    out.push('>');
                }
            }
            continue;
        }
        let Some((tag, end)) = parse_start(input, i) else {
            i = b.len();
            text_start = i;
            break;
        };
        i = end;
        text_start = end;
        let name = tag.name.as_str();
        if RAW_TEXT_DROP.contains(&name) {
            i = skip_raw(input, end, name);
            text_start = i;
            continue;
        }
        if NESTED_DROP.contains(&name) && !tag.self_closing {
            i = skip_nested(input, end, name);
            text_start = i;
            continue;
        }
        let Some(&known) = ALLOWED_TAGS.iter().find(|t| **t == name) else { continue };
        let attrs = clean_attrs(known, &tag.attrs);
        // a picture without an allowed source is not written at all
        if known == "img" && !attrs.iter().any(|(k, _)| k == "src") {
            continue;
        }
        out.push('<');
        out.push_str(known);
        for (k, v) in attrs {
            out.push(' ');
            out.push_str(&k);
            out.push_str("=\"");
            esc_attr(&v, &mut out);
            out.push('"');
        }
        out.push('>');
        if !VOID_TAGS.contains(&known) && !tag.self_closing {
            open.push(known);
        }
    }
    flush(&mut out, text_start, b.len());
    while let Some(t) = open.pop() {
        out.push_str("</");
        out.push_str(t);
        out.push('>');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clean(s: &str) -> String {
        clean_html(s)
    }

    /// No markup that can run, load or leak survives, whatever the payload looked like.
    fn assert_inert(out: &str) {
        let l = out.to_ascii_lowercase();
        for bad in [
            "<script", "<iframe", "<object", "<embed", "<svg", "<form", "<meta", "<base", "<link", "<style", "<input", "<button", "<applet", "<math", "javascript:", "vbscript:", "onerror", "onload",
            "onclick", "srcdoc", "srcset", "file:", "\\\\", "data:text", "<!--", "url(", "expression(", "@import", "contenteditable", "data-sig-block", "prosemirror", "background=", "xlink",
        ] {
            assert!(!l.contains(bad), "{bad:?} survived in {out}");
        }
    }

    #[test]
    fn plain_message_html_is_unchanged() {
        let html = "<p>Hello <strong>bold</strong> <em>it</em> <u>u</u> <s>s</s></p><ul><li>a</li><li>b</li></ul><ol><li>1</li></ol><blockquote><p>q</p></blockquote><pre><code>x &lt; y</code></pre><h2>T</h2><hr><p>a<br>b</p>";
        assert_eq!(clean(html), html);
        let quote = r#"<br><br><div>On Fri, Ann &lt;a@b.c&gt; wrote:</div><blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex"><p>x</p></blockquote>"#;
        assert_eq!(clean(quote), quote);
        let sig = r#"<br><div class="sig">-- <br><p>Ann</p></div>"#;
        assert_eq!(clean(sig), sig);
        assert_eq!(clean("a &amp; b &lt;c&gt; &nbsp; 東京 é"), "a &amp; b &lt;c&gt; &nbsp; 東京 é");
    }

    #[test]
    fn o01_hostile_paste_payload_is_inert() {
        let hostile = r##"<p>Hostile paste r17</p>
<script>window.__pwned=1</script><iframe src="http://127.0.0.1:19080/frame"></iframe><object data="x.swf"></object><embed src="y.swf">
<svg onload="alert(1)"><circle r="1"/></svg><img src=x onerror="alert(1)"><img src="http://127.0.0.1:19080/pixel?id=1" onerror=alert(2)>
<a href="javascript:alert(1)">js</a><a href="  JaVa&#x09;script:alert(1)">js2</a><a href="data:text/html,<script>alert(1)</script>">d</a><a href="jav&#97;script&colon;alert(1)">js3</a>
<form action="http://evil.test"><input name=x><button>go</button></form><meta http-equiv="refresh" content="0;url=http://evil.test"><base href="http://evil.test/">
<p style="background:url(http://127.0.0.1:19080/bg);color:red">Styled</p><link rel="stylesheet" href="http://127.0.0.1/x.css"><style>@import url(http://x/y.css);body{display:none}</style>
<div srcdoc="<script>1</script>" contenteditable="true" class="ProseMirror" data-sig-block="">x</div><!--[if mso]><v:image src="http://x"><![endif]-->
<p style="position:fixed;top:0;left:0;width:100%;height:100%;color:red">overlay</p>"##;
        let out = clean(hostile);
        assert_inert(&out);
        assert!(out.contains("Hostile paste r17") && out.contains("Styled") && out.contains("overlay") && out.contains("js3"), "the visible text is kept: {out}");
        assert!(out.contains(r#"<p style="color:red">Styled</p>"#), "{out}");
        assert!(out.contains(r#"<p style="width:100%;height:100%;color:red">overlay</p>"#), "position is not an allowed property: {out}");
        assert!(!out.contains("<a href"), "none of the four bad links keeps an address: {out}");
    }

    #[test]
    fn o14_unc_and_file_picture_sources_are_removed() {
        for src in [
            r"\\127.0.0.1\share\x.png",
            "file:///C:/Windows/win.ini",
            "//127.0.0.1/share/x.png",
            "FILE:///etc/passwd",
            "ftp://x/y.png",
            "javascript:alert(1)",
            "vbscript:msgbox(1)",
            "data:text/html,<script>alert(1)</script>",
            "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+",
            "data:image/png,notbase64",
            "http:\\\\127.0.0.1\\x.png",
            "&#102;ile:///C:/x.png",
            "fi\tle:///C:/x.png",
            "\u{1}file:///C:/x.png",
            "",
        ] {
            let out = clean(&format!(r#"<p>a</p><img src="{src}" alt="x"><p>b</p>"#));
            assert_eq!(out, "<p>a</p><p>b</p>", "{src:?} -> {out}");
        }
        // unquoted and single-quoted forms
        assert_eq!(clean(r"<img src=\\host\x.png>"), "");
        assert_eq!(clean("<img src='file:///C:/x'>"), "");
    }

    #[test]
    fn allowed_picture_sources_are_kept() {
        assert_eq!(clean(r#"<img src="cid:abc-123@heylook" width="480" alt="a &amp; b">"#), r#"<img src="cid:abc-123@heylook" width="480" alt="a &amp; b">"#);
        let png = "data:image/png;base64,iVBORw0KGgo=";
        assert_eq!(clean(&format!(r#"<img src="{png}">"#)), format!(r#"<img src="{png}">"#));
        for t in ["jpeg", "gif", "webp"] {
            assert!(clean(&format!(r#"<img src="data:image/{t};base64,AAAA">"#)).contains("src="));
        }
        assert_eq!(clean(r#"<img src="https://example.com/logo.png?a=1&amp;b=2">"#), r#"<img src="https://example.com/logo.png?a=1&amp;b=2">"#);
        assert!(clean(r#"<img src="HTTP://example.com/x.png">"#).contains("src="));
        // a data: picture over the size cap is dropped
        let big = format!(r#"<img src="data:image/png;base64,{}">"#, "A".repeat(MAX_DATA_URI));
        assert_eq!(clean(&big), "");
    }

    #[test]
    fn links_keep_only_web_mail_and_phone_schemes() {
        for href in ["https://example.com/a?b=1&amp;c=2", "http://example.com", "mailto:ann@example.com?subject=Hi%20there", "tel:+4930123", "HTTPS://EXAMPLE.COM"] {
            let out = clean(&format!(r#"<a href="{href}" target="_blank" rel="noopener">x</a>"#));
            assert!(out.starts_with(r#"<a href=""#) && !out.contains("target") && !out.contains("rel="), "{href} -> {out}");
        }
        for href in [
            "javascript:alert(1)", "JAVASCRIPT:alert(1)", " javascript:alert(1)", "java\nscript:alert(1)", "&#x6A;avascript:alert(1)", "&#106avascript:alert(1)", "vbscript:x",
            "data:text/html;base64,PHNjcmlwdD4=", "file:///C:/Windows/win.ini", r"\\host\share", "//host/x", "ftp://x/y", "blob:http://x/1", "about:blank", "#frag", "relative/path", "sms:123",
        ] {
            let out = clean(&format!(r#"<a href="{href}">x</a>"#));
            assert_eq!(out, "<a>x</a>", "{href:?} -> {out}");
        }
    }

    #[test]
    fn style_keeps_only_plain_allowed_declarations() {
        assert_eq!(clean(r#"<p style="text-align:center;margin:0 0 11pt;font-family:'Segoe UI',Arial,sans-serif;color:rgb(255, 0, 0)">x</p>"#), r#"<p style="text-align:center;margin:0 0 11pt;font-family:'Segoe UI',Arial,sans-serif;color:rgb(255, 0, 0)">x</p>"#);
        for style in [
            "background:url(http://x/y.png)",
            "background-color:url(javascript:alert(1))",
            "color:expression(alert(1))",
            "width:expression(alert(1))",
            "color:red;background-image:url('http://x')",
            "list-style-type:url(x)",
            "border:1px solid url(x)",
            "color:\\75rl(x)",
            "color:/*x*/red",
            "behavior:url(x.htc)",
            "-moz-binding:url(x)",
            "position:fixed",
            "color:var(--x)",
            "font-family:image-set('x')",
            "color:red\u{0};background:url(x)",
        ] {
            let out = clean(&format!(r#"<p style="{style}">x</p>"#));
            assert_inert(&out);
            assert!(!out.contains("url") && !out.contains("position") && !out.contains("var(") && !out.contains("binding") && !out.contains("behavior"), "{style} -> {out}");
        }
        // entity-hidden url(
        assert!(!clean(r#"<p style="background:&#117;rl(http://x)">x</p>"#).contains("style"));
    }

    #[test]
    fn editor_internals_never_leave() {
        let html = r#"<div class="ProseMirror sig tiptap" contenteditable="true" data-sig-block="" data-name="x.png" id="a" onclick="x()"><p class="is-editor-empty" data-placeholder="Write">x</p><img class="ProseMirror-separator" src="cid:a" data-name="x.png"><br class="ProseMirror-trailingBreak"></div><div class="sig-block none">y</div>"#;
        let out = clean(html);
        assert_eq!(out, r#"<div class="sig"><p>x</p><img src="cid:a"><br></div><div>y</div>"#);
        assert_inert(&out);
    }

    #[test]
    fn dangerous_containers_are_removed_with_their_content() {
        assert_eq!(clean("a<script>alert(1)</script>b"), "ab");
        assert_eq!(clean("a<SCRIPT >alert(1)</SCRIPT >b"), "ab");
        assert_eq!(clean("a<script>x</scriptfoo>y</script>b"), "ab");
        assert_eq!(clean("a<style>p{x:y}</style>b"), "ab");
        assert_eq!(clean("a<iframe src=x>text</iframe>b"), "ab");
        assert_eq!(clean("a<object><param name=x><object>n</object>t</object>b"), "ab");
        assert_eq!(clean("a<svg><g><script>1</script></g><svg>n</svg></svg>b"), "ab");
        assert_eq!(clean("a<textarea><img src=x onerror=1></textarea>b"), "ab");
        assert_eq!(clean("a<noscript><img src=x></noscript>b"), "ab");
        assert_eq!(clean("a<template><img src=x onerror=1></template>b"), "ab");
        // unterminated: everything after is part of the element
        assert_eq!(clean("a<script>alert(1)"), "a");
        assert_eq!(clean("a<svg><g>never closed"), "a");
        // form, meta refresh, base, link, input: no element, the text stays
        assert_eq!(clean(r#"<form action=http://e><input name=q value=v>text<button>Go</button></form>"#), "textGo");
        assert_eq!(clean(r#"<meta http-equiv="refresh" content="0;url=http://e"><base href="http://e"><link rel=stylesheet href=http://e>ok"#), "ok");
    }

    #[test]
    fn tokenizer_tricks_cannot_make_markup() {
        for p in [
            "<scr<script>ipt>alert(1)</scr</script>ipt>",
            "<img src=x onerror=alert(1)//",
            "<img/src=x/onerror=alert(1)>",
            "<img src=\"x\"onerror=\"alert(1)\">",
            "<IMG SRC=x ONERROR=alert(1)>",
            "<a href=\"x\" onmouseover=alert(1)>t</a>",
            "<p onclick=alert(1)>t</p>",
            "<b/onclick=alert(1)>t</b>",
            "<<script>script>alert(1)<</script>/script>",
            "<script/src=http://x></script>",
            "<svg/onload=alert(1)>",
            "<math><mi xlink:href=javascript:alert(1)>x</mi></math>",
            "<body onload=alert(1)>x</body>",
            "<details open ontoggle=alert(1)>x</details>",
            "<a href=\"javascript:alert(1)\"><img src=x></a>",
            "<![CDATA[<script>alert(1)</script>]]>",
            "<?php echo 1; ?>",
            "<!-- <script>alert(1)</script> -->",
            "<!--[if gte mso 9]><xml><o:OfficeDocumentSettings></o:OfficeDocumentSettings></xml><![endif]-->",
            "<p title=\"<script>alert(1)</script>\">t</p>",
            "&lt;script&gt;alert(1)&lt;/script&gt;",
        ] {
            let out = clean(p);
            assert_inert(&out.replace("&lt;script&gt;", ""));
            assert!(!out.to_ascii_lowercase().contains("<script"), "{p} -> {out}");
            // what is written re-parses to itself (a second pass changes nothing): the output is a fixed point
            assert_eq!(clean(&out), out, "not idempotent for {p}");
        }
        // an unterminated tag swallows the rest, like a browser does
        assert_eq!(clean("ok<img src=\"x onerror=alert(1)"), "ok");
        assert_eq!(clean("a < b and c > d"), "a &lt; b and c &gt; d");
        assert_eq!(clean("1<2"), "1&lt;2");
    }

    #[test]
    fn output_is_well_formed() {
        assert_eq!(clean("<p>one<p>two</div></span>"), "<p>one<p>two</p></p>");
        assert_eq!(clean("<b><i>x</b>y</i>"), "<b><i>x</i></b>y");
        assert_eq!(clean("<ul><li>a<li>b</ul>c"), "<ul><li>a<li>b</li></li></ul>c");
        assert_eq!(clean("<br/><hr/><img src=\"cid:a\"/>"), "<br><hr><img src=\"cid:a\">");
        assert_eq!(clean("<DIV CLASS=SIG><P>x"), "<div class=\"sig\"><p>x</p></div>");
    }

    #[test]
    fn tables_and_lists_keep_their_layout_attributes_only() {
        let out = clean(r##"<table border="1" cellpadding="4" cellspacing="0" width="100%" style="border-collapse:collapse;width:100%" onclick="x()" background="http://x/b.png"><tbody><tr><td colspan="2" rowspan="1" bgcolor="#ffff00" valign="top" style="border:1px solid #999999;padding:4px 6px;vertical-align:top" id="c">A</td><th width="50%" align="center">B</th></tr></tbody></table><ol start="3" type="a"><li value="5">x</li></ol>"##);
        assert!(out.contains(r#"<table border="1" cellpadding="4" cellspacing="0" width="100%" style="border-collapse:collapse;width:100%">"#), "{out}");
        assert!(out.contains(r##"<td colspan="2" rowspan="1" bgcolor="#ffff00" valign="top" style="border:1px solid #999999;padding:4px 6px;vertical-align:top">A</td>"##), "{out}");
        assert!(out.contains(r#"<th width="50%" align="center">B</th>"#) && out.contains(r#"<ol start="3" type="a"><li value="5">x</li></ol>"#), "{out}");
        assert_inert(&out);
        let bad = clean(r#"<td colspan="9999999" bgcolor="red;x" width="1;2" valign="javascript">x</td>"#);
        assert_eq!(bad, "<td>x</td>");
    }

    /// REQ-2 (spec-rich-text.md): every tag, attribute and style property the rich-text editor may write goes through unchanged.
    #[test]
    fn everything_the_editor_writes_is_allowed() {
        for tag in ["p", "div", "span", "strong", "b", "em", "i", "u", "s", "sub", "sup", "ul", "ol", "li", "h1", "h2", "h3", "blockquote", "pre", "code", "table", "thead", "tbody", "tr", "th", "td"] {
            let html = format!("<{tag}>x</{tag}>");
            assert_eq!(clean(&html), html, "<{tag}>");
        }
        for html in ["<br>", "<hr>", r#"<img src="cid:a" alt="b" width="10" height="5">"#, r#"<a href="https://e.test/">x</a>"#, r#"<ol type="a" start="3"><li>x</li></ol>"#] {
            assert_eq!(clean(html), html);
        }
        let attrs = [
            r##"<td colspan="2" rowspan="2" bgcolor="#FFFF00" valign="top" align="center" width="50%">x</td>"##,
            r#"<table border="1" cellpadding="4" cellspacing="0" width="100%">x</table>"#,
            r#"<p dir="rtl" style="text-align:right">x</p>"#,
        ];
        for html in attrs {
            assert_eq!(clean(html), html);
        }
        for prop in [
            "font-family:Calibri,Carlito,Arial,sans-serif", "font-size:10.5pt", "font-weight:bold", "font-style:italic", "text-decoration:underline", "color:#C00000", "background-color:#FFFF00",
            "text-align:justify", "line-height:1.15", "margin:0 0 0 40px", "margin-top:1px", "margin-right:1px", "margin-bottom:1px", "margin-left:1px", "padding:0", "padding-left:1ex",
            "border:0", "border-top:1px solid #bfbfbf", "border-left:2px solid #ccc", "border-collapse:collapse", "width:100%", "height:auto", "max-width:100%", "vertical-align:top",
            "list-style-type:lower-alpha", "direction:rtl", "white-space:pre-wrap",
            // the paragraph formats (WP5b): space after, indent, alignment, line spacing, every marker of a list
            "margin:0 0 10pt 40px", "margin:12pt 0 0 80px", "margin:0 0 0 320px", "margin:12pt 0 10pt", "text-align:center", "text-align:right", "line-height:1.5", "line-height:2", "line-height:1.15",
            "list-style-type:disc", "list-style-type:circle", "list-style-type:square", "list-style-type:decimal", "list-style-type:upper-alpha", "list-style-type:lower-roman", "list-style-type:upper-roman",
        ] {
            let html = format!(r#"<span style="{prop}">x</span>"#);
            assert_eq!(clean(&html), html, "{prop}");
        }
        // links: web, mail and phone only; the picture source of a message is its own part or a web address
        for href in ["http://e.test/", "https://e.test/", "mailto:a@e.test", "tel:+49301"] {
            assert_eq!(clean(&format!(r#"<a href="{href}">x</a>"#)), format!(r#"<a href="{href}">x</a>"#));
        }
        // and nothing else of the editor leaks: classes other than the signature's, ids, data-*
        assert_eq!(clean(r#"<p class="x" id="y" data-z="1">a</p><div class="sig">b</div>"#), r#"<p>a</p><div class="sig">b</div>"#);
    }

    /// REQ-17 .. REQ-20: the whole of what the paragraph formats write (editor/emailHtml.ts, blockFormat.ts) passes untouched, and a hostile value does not.
    #[test]
    fn paragraph_formats_pass_and_hostile_values_do_not() {
        for html in [
            r#"<p style="margin:0 0 10pt 40px;text-align:center;line-height:2">x</p>"#,
            r#"<p style="margin:0 0 0 320px;text-align:justify;line-height:1.15">x</p>"#,
            r#"<h2 style="font-size:14pt;font-weight:bold;margin:12pt 0 0 80px;text-align:right">x</h2>"#,
            r#"<ol type="A" start="4" style="list-style-type:upper-alpha;margin:0 0 0 40px;padding:0"><li><p style="margin:0;text-align:center">x</p></li></ol>"#,
            r#"<ol type="I" style="list-style-type:upper-roman;margin:0 0 0 40px;padding:0"><li>x</li></ol>"#,
            r#"<ul style="list-style-type:square;margin:0 0 0 40px;padding:0"><li>x</li></ul>"#,
        ] {
            assert_eq!(clean(html), html);
        }
        // anything that is not a plain value of these properties is taken out, the rest of the paragraph stays
        assert_eq!(clean(r#"<p style="text-align:center;line-height:expression(alert(1));margin:0">x</p>"#), r#"<p style="text-align:center;margin:0">x</p>"#);
        assert_eq!(clean(r#"<ul style="list-style-type:url(javascript:x);margin:0">x</ul>"#), r#"<ul style="margin:0">x</ul>"#);
        assert_eq!(clean(r#"<p style="margin-left:url(x)">x</p>"#), "<p>x</p>");
    }

    /// The golden files of the editor's serializer (scripts/fixtures/rich/*.html, checked against the editor documents by
    /// scripts/test-rich-golden.mjs): the sanitiser must not change a byte of them, so what the editor writes is what leaves the computer.
    #[test]
    fn serializer_golden_files_pass_the_sanitiser_unchanged() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/fixtures/rich");
        let mut n = 0;
        for e in std::fs::read_dir(&dir).expect("scripts/fixtures/rich exists") {
            let path = e.unwrap().path();
            if path.extension().and_then(|x| x.to_str()) != Some("html") {
                continue;
            }
            let html = std::fs::read_to_string(&path).unwrap().replace("\r\n", "\n");
            let html = html.trim_end_matches('\n');
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            let out = clean(html);
            assert_eq!(out, html, "{name}: the sanitiser changed what the editor wrote");
            n += 1;
        }
        assert!(n >= 12, "{n} golden files found");
    }

    #[test]
    fn crlf_and_nul_cannot_break_attributes() {
        let out = clean("<a href=\"https://e.com/a\r\nb\u{0}c\">x</a><img src=\"cid:a\" alt=\"l1\r\nl2\">");
        assert!(!out.contains('\r') && !out.contains('\n') && !out.contains('\0'), "{out:?}");
        assert!(out.starts_with(r#"<a href="https://e.com/abc">"#), "{out}");
    }

    /// The MIME text of the HTML part, quoted-printable undone.
    fn html_part(m: &lettre::Message) -> String {
        let raw = String::from_utf8_lossy(&m.formatted()).into_owned();
        raw.replace("=\r\n", "").replace("=3D", "=")
    }

    fn account() -> crate::db::Account {
        crate::db::Account {
            id: "a1".into(),
            email: "me@example.com".into(),
            display_name: "Me".into(),
            imap_host: "imap.example.com".into(),
            imap_port: 993,
            imap_ssl: true,
            smtp_host: "smtp.example.com".into(),
            smtp_port: 465,
            smtp_security: "ssl".into(),
            username: "me@example.com".into(),
            auth: "password".into(),
            color: None,
            smtp_username: String::new(),
            tls_insecure: false,
        }
    }

    /// Send, Send later / Undo hold (the same build) and Save draft all go through `smtp::body`: the message that leaves has the cleaned HTML.
    #[test]
    fn built_messages_and_drafts_carry_the_cleaned_html() {
        let hostile = r#"<p>Hi</p><img src="\\127.0.0.1\share\x.png"><img src="file:///C:/Windows/win.ini"><a href="javascript:alert(1)">x</a><script>alert(1)</script><p onclick="x()" class="ProseMirror" contenteditable="true">end</p><div data-sig-block=""></div>"#;
        let json = serde_json::json!({ "accountId": "a1", "to": ["ann@example.com"], "subject": "s", "html": hostile, "text": "Hi" });
        let d: crate::smtp::Draft = serde_json::from_value(json).unwrap();
        for (what, m) in [("send", crate::smtp::build(&account(), &d).unwrap()), ("draft", crate::smtp::build_draft(&account(), &d).unwrap())] {
            let out = html_part(&m);
            assert!(out.contains("<p>Hi</p><a>x</a><p>end</p><div></div>"), "{what}: {out}");
            for bad in ["file:", "127.0.0.1", "javascript", "<script", "onclick", "ProseMirror", "contenteditable", "data-sig-block"] {
                assert!(!out.contains(bad), "{what}: {bad} in {out}");
            }
        }
        // a signed message is cleaned too (the signature covers the cleaned part)
        let sign = |_: &[u8]| Ok(("-----BEGIN PGP SIGNATURE-----\nx\n-----END PGP SIGNATURE-----".to_string(), "pgp-sha256".to_string()));
        let out = html_part(&crate::smtp::build_signed(&account(), &d, false, &sign).unwrap());
        assert!(!out.contains("file:") && !out.contains("javascript") && !out.contains("<script"), "{out}");
    }

    /// BUG-18: hostile attachment names reach the MIME as a clean base name; two files that only collide after cleaning stay two; two real
    /// `report.pdf` stay as the sender named them; a name cannot carry a header line.
    #[test]
    fn hostile_attachment_names_are_cleaned_in_the_mime() {
        let att = |n: &str| serde_json::json!({ "filename": n, "mime": "text/plain", "dataBase64": "aGk=" });
        let names = ["..\\..\\Windows\\evil.bat", "/etc/passwd", "CON.txt", "x/passwd", "a\r\nBcc: evil@x.y\r\n.txt", "report.pdf", "report.pdf", "evil.exe. "];
        let d: crate::smtp::Draft = serde_json::from_value(serde_json::json!({
            "accountId": "a1", "to": ["ann@example.com"], "subject": "s", "html": "<p>x</p>", "text": "x",
            "attachments": names.iter().map(|n| att(n)).collect::<Vec<_>>()
        }))
        .unwrap();
        let raw = String::from_utf8_lossy(&crate::smtp::build(&account(), &d).unwrap().formatted()).into_owned();
        let unfolded = raw.replace("\r\n ", " ").replace("\r\n\t", " ");
        for want in ["filename=\"evil.bat\"", "filename=\"passwd\"", "filename=\"_CON.txt\"", "filename=\"passwd (2)\"", "filename=\"aBcc: evil@x.y.txt\"", "filename=\"evil.exe\""] {
            assert!(unfolded.contains(want), "{want} missing in {unfolded}");
        }
        assert_eq!(unfolded.matches("filename=\"report.pdf\"").count(), 2, "the same name twice stays twice");
        for bad in ["Windows", "etc/passwd", "..\\"] {
            assert!(!unfolded.contains(bad), "{bad} in {unfolded}");
        }
        assert!(!raw.contains("\r\nBcc:") && !raw.contains("\nBcc:"), "a file name cannot add a header: {raw}");
    }

    #[test]
    fn very_large_and_odd_input_does_not_hang_or_panic() {
        let big = "<p>x</p>".repeat(200_000);
        let t = std::time::Instant::now();
        assert_eq!(clean(&big).len(), big.len());
        assert!(t.elapsed().as_secs() < 5);
        // nesting that is never closed
        let deep = "<div>".repeat(50_000);
        assert_eq!(clean(&deep).matches("</div>").count(), 50_000);
        for odd in ["<", "<a", "<a ", "<a b", "<a b=", "<a b='", "</", "</a", "<!", "<!-", "<!--", "&", "&#", "&#x", "<img src=", "<a href=\"", "\u{0}", "<p>é<", "東京<b>京", "<\u{1F600}>"] {
            let _ = clean(odd);
        }
        // multi-byte text around markup
        assert_eq!(clean("東京<b>京</b>é"), "東京<b>京</b>é");
        // case games on tag names inside raw text
        assert_eq!(clean("<ScRiPt>x</sCrIpT>y"), "y");
    }
}
