//! The one-line preview ("snippet") of a message in the list: readable words only.
//!
//! Visible text is taken from the text/plain part when the message has a real one, otherwise from the HTML. The HTML is read
//! by a small scanner that never lets markup text through: `<style>`, `<script>`, `<head>`, `<title>`, `<template>`, `<xml>`,
//! comments (conditional comments for Outlook included) and doctype / CDATA are skipped whole. Hidden preheader text is kept
//! (it is what mail apps show), but the invisible padding after it (`&zwnj;&nbsp;` runs, figure spaces, soft hyphens, zero-width
//! characters) is removed and white space is collapsed. The result is cut at a word boundary.
//!
//! The text then goes through `preview_text`: link markup (`[text](address)`, `<address>`, images, `[1]` markers), bare addresses and
//! tracking tokens, "View in browser" / "Unsubscribe" / "Click here" lines (in the eight app languages) and rules of dashes are left
//! out. The desktop notification uses the same text (`notification_preview`, `notification_line`). The stored body, which search
//! reads, is not touched.

use rusqlite::{params, Connection};

/// Longest snippet, in characters.
pub const SNIPPET_MAX: usize = 200;
/// Stop reading a big HTML body once this many bytes of text are collected (the snippet needs a few hundred characters).
const SCAN_CAP: usize = 4096;
/// Settings key that marks the one-time clean-up of stored snippets as done.
const FIXED_KEY: &str = "snippet_fix_v1";

/// Elements whose content is never visible text.
const SKIP: &[&[u8]] = &[b"style", b"script", b"title", b"template", b"xml"];
/// Elements that do not separate words (everything else puts a space between its neighbours).
const INLINE: &[&[u8]] = &[b"a", b"b", b"i", b"u", b"s", b"em", b"strong", b"span", b"font", b"small", b"big", b"sup", b"sub", b"abbr", b"code", b"mark", b"label", b"wbr"];

fn find_ci(h: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || from >= h.len() || h.len() - from < needle.len() {
        return None;
    }
    let first = needle[0].to_ascii_lowercase();
    let last_start = h.len() - needle.len();
    let mut i = from;
    while i <= last_start {
        if h[i].to_ascii_lowercase() == first && h[i..i + needle.len()].eq_ignore_ascii_case(needle) {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn find_bytes(h: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    if from >= h.len() || h.len() - from < needle.len() {
        return None;
    }
    h[from..].windows(needle.len()).position(|w| w == needle).map(|p| p + from)
}

/// The `>` that ends the tag whose name ends at `from`, skipping quoted attribute values.
fn tag_end(b: &[u8], from: usize) -> Option<usize> {
    let mut k = from;
    while k < b.len() {
        match b[k] {
            b'>' => return Some(k),
            q @ (b'"' | b'\'') => {
                let after_eq = b[..k].iter().rev().find(|c| !c.is_ascii_whitespace()).map(|c| *c == b'=').unwrap_or(false);
                match after_eq.then(|| b[k + 1..].iter().position(|c| *c == q)).flatten() {
                    Some(p) => k += p + 2,
                    None => k += 1,
                }
            }
            _ => k += 1,
        }
    }
    None
}

fn named_entity(n: &str) -> Option<&'static str> {
    Some(match n {
        "nbsp" | "ensp" | "emsp" | "thinsp" | "numsp" | "puncsp" | "hairsp" | "MediumSpace" | "NewLine" | "Tab" => " ",
        "zwnj" | "zwj" | "shy" | "lrm" | "rlm" | "ZeroWidthSpace" | "NoBreak" => "",
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "hellip" => "\u{2026}",
        "mdash" => "\u{2014}",
        "ndash" => "\u{2013}",
        "lsquo" => "\u{2018}",
        "rsquo" => "\u{2019}",
        "ldquo" => "\u{201C}",
        "rdquo" => "\u{201D}",
        "bull" => "\u{2022}",
        "middot" => "\u{00B7}",
        "laquo" => "\u{00AB}",
        "raquo" => "\u{00BB}",
        "copy" => "\u{00A9}",
        "reg" => "\u{00AE}",
        "trade" => "\u{2122}",
        "euro" => "\u{20AC}",
        "pound" => "\u{00A3}",
        "yen" => "\u{00A5}",
        "cent" => "\u{00A2}",
        "deg" => "\u{00B0}",
        "times" => "\u{00D7}",
        "rarr" => "\u{2192}",
        "larr" => "\u{2190}",
        _ => return None,
    })
}

/// `&name;`, `&#123;` or `&#x1F;` at the start of `s` (which begins with `&`): the text it stands for and its length in bytes.
fn entity(s: &str) -> Option<(String, usize)> {
    let semi = s.bytes().take(12).position(|c| c == b';')?;
    let body = &s[1..semi];
    let text = if let Some(num) = body.strip_prefix('#') {
        let code = match num.strip_prefix(['x', 'X']) {
            Some(h) => u32::from_str_radix(h, 16).ok()?,
            None => num.parse::<u32>().ok()?,
        };
        char::from_u32(code).map(String::from).unwrap_or_default()
    } else {
        named_entity(body)?.to_string()
    };
    Some((text, semi + 1))
}

/// Visible text of an HTML document, entities decoded, not yet collapsed.
fn html_raw_text(h: &str) -> String {
    let b = h.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < b.len() && out.len() < SCAN_CAP {
        match b[i] {
            b'<' => {
                let rest = &b[i..];
                if rest.starts_with(b"<!-->") {
                    i += 5;
                } else if rest.starts_with(b"<!--->") {
                    i += 6;
                } else if rest.starts_with(b"<!--") {
                    // comments, conditional comments (<!--[if mso]> ... <![endif]-->) included
                    i = find_bytes(b, i + 4, b"-->").map(|p| p + 3).unwrap_or(b.len());
                } else if rest.starts_with(b"<!") || rest.starts_with(b"<?") {
                    // doctype, <![endif]>, <![CDATA[ ... ]]>, processing instructions
                    i = b[i..].iter().position(|c| *c == b'>').map(|p| i + p + 1).unwrap_or(b.len());
                } else {
                    let mut j = i + 1;
                    let closing = b.get(j) == Some(&b'/');
                    if closing {
                        j += 1;
                    }
                    if !b.get(j).map(|c| c.is_ascii_alphabetic()).unwrap_or(false) {
                        out.push('<'); // a lone "<" in text ("a < b")
                        i += 1;
                        continue;
                    }
                    let ns = j;
                    while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b':' || b[j] == b'-') {
                        j += 1;
                    }
                    let name = b[ns..j].to_ascii_lowercase();
                    let Some(end) = tag_end(b, j) else { break };
                    let self_closing = b[end - 1] == b'/';
                    i = end + 1;
                    if closing || self_closing {
                        if !INLINE.contains(&name.as_slice()) {
                            out.push(' ');
                        }
                        continue;
                    }
                    if SKIP.contains(&name.as_slice()) {
                        let close = [b"</".as_slice(), name.as_slice()].concat();
                        i = match find_ci(b, i, &close) {
                            Some(p) => b[p..].iter().position(|c| *c == b'>').map(|q| p + q + 1).unwrap_or(b.len()),
                            None => b.len(),
                        };
                    } else if name == b"a" {
                        // a link whose text is boilerplate ("View in browser", "Unsubscribe") is not text
                        if let Some(p) = find_ci(b, i, b"</a") {
                            if p - i <= 600 && is_boilerplate(&clean_text(&html_raw_text(&h[i..p]))) {
                                i = b[p..].iter().position(|c| *c == b'>').map(|q| p + q + 1).unwrap_or(b.len());
                                out.push(' ');
                            }
                        }
                    } else if name == b"head" {
                        // the head is not text; a head that is never closed ends where the body starts
                        if let Some(p) = find_ci(b, i, b"</head") {
                            i = b[p..].iter().position(|c| *c == b'>').map(|q| p + q + 1).unwrap_or(b.len());
                        } else if let Some(p) = find_ci(b, i, b"<body") {
                            i = p;
                        }
                    } else if !INLINE.contains(&name.as_slice()) {
                        out.push(' ');
                    }
                }
            }
            b'&' => match entity(&h[i..]) {
                Some((t, n)) => {
                    out.push_str(&t);
                    i += n;
                }
                None => {
                    out.push('&');
                    i += 1;
                }
            },
            _ => {
                let n = b[i..].iter().position(|c| *c == b'<' || *c == b'&').unwrap_or(b.len() - i);
                out.push_str(&h[i..i + n]);
                i += n;
            }
        }
    }
    out
}

/// Characters that take no room (zero-width, joiners, soft hyphen, bidi marks, filler letters used as padding).
/// (`clean_text` keeps the joiner and the emoji selector that sit inside an emoji sequence.)
fn invisible(c: char) -> bool {
    matches!(c,
        '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}'
        | '\u{FEFF}' | '\u{00AD}' | '\u{034F}' | '\u{061C}' | '\u{180B}'..='\u{180E}' | '\u{115F}' | '\u{1160}' | '\u{3164}' | '\u{FFA0}'
        | '\u{FE00}'..='\u{FE0F}')
}

/// Emoji and pictographs: the characters a joiner (U+200D) or an emoji selector (U+FE0F) can belong to.
fn emoji_like(c: char) -> bool {
    matches!(c as u32,
        0xA9 | 0xAE | 0x203C | 0x2049 | 0x2122 | 0x2139 | 0x2194..=0x21AA | 0x231A..=0x23FF | 0x24C2 | 0x25AA..=0x25FE
        | 0x2600..=0x27BF | 0x2934 | 0x2935 | 0x2B05..=0x2B55 | 0x3030 | 0x303D | 0x3297 | 0x3299 | 0x1F000..=0x1FAFF | 0xE0020..=0xE007F)
}

/// Drop invisible characters, turn every kind of space and control character into one space, collapse runs, trim.
/// An emoji sequence stays whole: the zero-width joiner between two emoji and the emoji selector after one are kept.
pub fn clean_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len().min(SCAN_CAP + 64));
    let mut space = false;
    let mut in_emoji = false; // the last character written is an emoji (or a part of an emoji sequence)
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if invisible(c) {
            let keep = in_emoji
                && match c {
                    '\u{200D}' => it.peek().is_some_and(|n| emoji_like(*n)),
                    '\u{FE0F}' | '\u{FE0E}' => true,
                    _ => false,
                };
            let keycap = matches!(c, '\u{FE0F}') && !in_emoji && out.chars().next_back().is_some_and(|p| p.is_ascii_digit() || p == '#' || p == '*') && it.peek() == Some(&'\u{20E3}');
            if keep || keycap {
                out.push(c);
            }
            continue;
        }
        if c.is_whitespace() || c.is_control() {
            space = !out.is_empty();
            in_emoji = false;
            continue;
        }
        if space {
            out.push(' ');
            space = false;
        }
        out.push(c);
        in_emoji = emoji_like(c);
    }
    out
}

/// Visible text of an HTML document as one clean line.
pub fn html_text(h: &str) -> String {
    clean_text(&html_raw_text(h))
}

/// The nearest grapheme boundary at or before byte `idx` (so a cut never lands inside an emoji sequence, a flag, or a letter with
/// its combining marks). `idx` is a character boundary of `s`; a text that is one single huge cluster is cut where it was asked to.
fn grapheme_floor(s: &str, idx: usize) -> usize {
    use unicode_segmentation::GraphemeCursor;
    if idx == 0 || idx >= s.len() {
        return idx.min(s.len());
    }
    let mut cur = GraphemeCursor::new(idx, s.len(), true);
    match cur.is_boundary(s, 0) {
        Ok(true) => idx,
        Ok(false) => match cur.prev_boundary(s, 0) {
            Ok(Some(p)) if p > 0 => p,
            _ => idx,
        },
        Err(_) => idx,
    }
}

/// At most `SNIPPET_MAX` characters, ending at a word boundary when the text had to be cut.
pub fn truncate_words(s: &str) -> String {
    let Some((cut, _)) = s.char_indices().nth(SNIPPET_MAX) else { return s.to_string() };
    let cut = grapheme_floor(s, cut);
    let head = &s[..cut];
    if s[cut..].starts_with(' ') {
        return head.trim_end().to_string();
    }
    match head.rfind(' ') {
        Some(p) if p >= SNIPPET_MAX / 2 => head[..p].trim_end().to_string(),
        _ => head.to_string(), // one very long word: cut it
    }
}

/// The snippet of a message. `real_text` is the text/plain part when the message has one (not text made from the HTML).
/// Link markup, URLs and "view in browser" lines are left out (`preview_text`); the stored body is not touched, so search still
/// finds every word of it.
pub fn make(real_text: Option<&str>, html: Option<&str>) -> String {
    if let Some(c) = real_text.map(preview_text).filter(|c| !c.is_empty()) {
        return truncate_words(&c);
    }
    if let Some(c) = html.map(|h| preview(&html_text(h), false)).filter(|c| !c.is_empty()) {
        return truncate_words(&c);
    }
    String::new()
}

// ---- readable preview: no link markup, URLs, tracking tokens or "view in browser" lines ----

/// Characters of a text part that are read for the preview (a marketing text/plain part can be one long list of links).
const PREVIEW_SOURCE_MAX: usize = 6000;
/// Longest preview line of a desktop notification, in characters as a person counts them (graphemes), the ellipsis included.
pub const NOTIFY_PREVIEW_MAX: usize = 100;
/// A notification shows no preview line when fewer readable letters than this are left (a CJK character counts for two).
const NOTIFY_MIN_READABLE: usize = 6;
/// Longest subject / sender line of a desktop notification, in graphemes.
const NOTIFY_LINE_MAX: usize = 200;

/// Letters, digits and the combining marks that belong to them.
fn wordish(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '\u{0300}'..='\u{036F}' | '\u{064B}'..='\u{065F}')
}

/// White space and punctuation of the scripts the app is translated into (what stands between words and around a link).
fn sepish(c: char) -> bool {
    c.is_whitespace()
        || c.is_ascii_punctuation()
        || matches!(c,
            '\u{00A0}' | '«' | '»' | '·' | '•' | '–' | '—' | '…' | '‘' | '’' | '“' | '”' | '‹' | '›' | '¡' | '¿' | '。' | '、' | '！' | '？' | '：' | '；' | '，'
            | '｜' | '（' | '）' | '「' | '」' | '『' | '』' | '【' | '】' | '《' | '》' | '،' | '؛' | '؟' | '\u{3000}')
}

/// Han, kana and Hangul: scripts written without spaces between words.
fn cjk(c: char) -> bool {
    matches!(c as u32, 0x3040..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xAC00..=0xD7AF | 0xF900..=0xFAFF | 0xFF66..=0xFF9F)
}

/// Text of "view this email in your browser" / "having trouble viewing" lines and links: cut off the start of a line.
const VIEW_PHRASES: &[&str] = &[
    // English
    "view in browser", "view in your browser", "view in web browser", "view in your web browser", "view this email in your browser", "view this email in a browser",
    "view this email in browser", "view this email online", "view this message in your browser", "view email in browser", "view email in your browser", "view it in your browser",
    "view as a web page", "view as web page", "view web version", "view the web version", "view on the web",
    "read in browser", "read this email in your browser", "open in browser", "open in your browser", "open this email in your browser",
    "having trouble viewing this email", "having trouble viewing this message", "having trouble viewing", "trouble viewing this email",
    "email not displaying correctly", "email not displaying properly", "email not displaying", "not displaying correctly", "if you cannot see this email",
    "if you can t see this email", "if you can t read this email", "can t see this email", "is this email not displaying correctly",
    // French
    "voir dans le navigateur", "voir dans votre navigateur", "afficher dans le navigateur", "afficher dans votre navigateur", "visualiser dans le navigateur",
    "visualiser dans votre navigateur", "consulter dans le navigateur", "consulter dans votre navigateur", "voir cet e mail dans votre navigateur",
    "voir cet email dans votre navigateur", "voir ce message dans votre navigateur", "afficher cet e mail dans votre navigateur", "ouvrir dans le navigateur",
    "voir la version en ligne", "consulter la version en ligne", "afficher la version en ligne", "problèmes d affichage",
    "vous ne parvenez pas à lire ce message", "si vous ne voyez pas ce message correctement", "vous ne voyez pas cet e mail correctement",
    // German
    "im browser ansehen", "im browser anzeigen", "im browser öffnen", "im browser betrachten", "im webbrowser ansehen", "e mail im browser ansehen",
    "diese e mail im browser ansehen", "diese e mail im browser anzeigen", "newsletter im browser ansehen", "newsletter im browser anzeigen", "web version ansehen", "probleme bei der darstellung", "wird diese e mail nicht richtig angezeigt",
    "wird diese e mail nicht korrekt angezeigt", "wenn diese e mail nicht richtig angezeigt wird", "sollte diese e mail nicht richtig dargestellt werden",
    // Spanish
    "ver en el navegador", "ver en tu navegador", "ver en su navegador", "ver en navegador", "ver este correo en el navegador", "ver este correo en tu navegador",
    "ver este email en el navegador", "ver este email en tu navegador", "ver este mensaje en el navegador", "ver correo en el navegador", "ver versión web", "ver la versión web", "ver en el navegador web", "abrir en el navegador", "problemas para ver este correo",
    "problemas para ver este email", "si no puedes ver este correo correctamente", "si no ves correctamente este correo", "si no se visualiza correctamente",
    // Japanese
    "ブラウザで見る", "ブラウザで表示", "ブラウザで開く", "ブラウザでご覧ください", "ブラウザで確認", "ウェブブラウザで表示", "ウェブで見る", "web版を見る", "ウェブ版を見る",
    "メールが正しく表示されない場合", "メールが正しく表示されない", "メールが表示されない場合", "このメールが正しく表示されない場合", "表示されない場合はこちら",
    // Russian
    "открыть в браузере", "посмотреть в браузере", "просмотреть в браузере", "смотреть в браузере", "прочитать в браузере", "открыть письмо в браузере",
    "посмотреть письмо в браузере", "веб версия письма", "версия для браузера", "если письмо не отображается",
    "если письмо не отображается корректно", "письмо не отображается", "не отображается письмо",
    // Simplified Chinese
    "在浏览器中查看", "在浏览器中打开", "在浏览器查看", "在浏览器中阅读", "网页版查看", "如果无法正常显示", "如果邮件无法正常显示",
    "无法查看此邮件", "无法正常查看此邮件", "邮件无法显示", "邮件显示不正常",
    // Vietnamese
    "xem trong trình duyệt", "xem email trên trình duyệt", "xem email trong trình duyệt", "xem trên trình duyệt", "xem thư trên trình duyệt",
    "xem thư trong trình duyệt", "xem email này trên trình duyệt", "xem phiên bản web", "xem bản web", "xem bản trực tuyến",
    "mở trong trình duyệt", "mở trên trình duyệt", "nếu không xem được email", "nếu bạn không xem được email", "không xem được email", "email không hiển thị",
    "email không hiển thị đúng", "gặp sự cố khi xem email",
    "xem trong trinh duyet", "xem email tren trinh duyet", "xem tren trinh duyet", "xem phien ban web",
    // Arabic
    "عرض في المتصفح", "عرض في المتصفّح", "افتح في المتصفح", "عرض الرسالة في المتصفح",
    // more ways to say it
    "click here to view this email in your browser", "click here to view in your browser", "click here to view in browser", "click here to view this email online",
    "click here to view it online", "click to view in browser", "tap here to view in browser", "view this email as a web page", "view this newsletter in your browser",
    "voir ce mail dans le navigateur", "voir ce mail dans votre navigateur", "voir ce message en ligne", "voir cet email en ligne", "ouvrir cet e mail dans votre navigateur",
    "sehen sie diese e mail im browser", "sehen sie die e mail im browser", "e mail im browser öffnen", "diese e mail im browser öffnen", "newsletter im browser öffnen",
    "ver este correo en línea", "ver este email online", "ver mensaje en el navegador", "abrir este correo en el navegador", "ver este correo electrónico en el navegador",
    "ブラウザで表示する", "ブラウザでご確認ください", "ブラウザでメールを見る", "このメールが正しく表示されない場合", "このメールが表示されない場合",
    "откройте письмо в браузере", "откройте его в браузере", "открыть это письмо в браузере", "посмотреть это письмо в браузере", "прочитать письмо в браузере",
    "在浏览器中查看此邮件", "在浏览器中查看本邮件", "请在浏览器中查看", "在浏览器里查看", "点击这里在浏览器中查看",
    "xem thư này trên trình duyệt", "xem email này trong trình duyệt", "mở email trong trình duyệt", "xem phiên bản trình duyệt", "xem thư trực tuyến",
    // Portuguese (W6.13)
    "ver no navegador", "ver no browser", "ver este e-mail no navegador", "ver este email no navegador", "ver esta mensagem no navegador", "ver e-mail no navegador",
    "visualizar no navegador", "visualizar este e-mail no navegador", "visualizar este email no navegador", "abrir no navegador", "ver versão online", "ver versão web",
    "clique aqui para ver no navegador", "problemas para visualizar este e-mail", "se não consegue visualizar este e-mail", "se você não consegue visualizar este e-mail",
    "caso não consiga visualizar este e-mail",
    // Italian
    "visualizza nel browser", "visualizza questa email nel browser", "visualizza questa e-mail nel browser", "visualizza questa newsletter nel browser", "visualizza online",
    "vedi nel browser", "apri nel browser", "leggi nel browser", "visualizza la versione web", "visualizza la versione online", "se non riesci a visualizzare questa email",
    "se non visualizzi correttamente questa email", "problemi di visualizzazione",
    // Dutch
    "bekijk in browser", "bekijk in je browser", "bekijk in uw browser", "bekijk deze e-mail in je browser", "bekijk deze e-mail in uw browser", "bekijk online",
    "bekijk de webversie", "bekijk webversie", "bekijk de online versie", "open in browser", "lees in je browser", "problemen met het bekijken van deze e-mail",
    "als deze e-mail niet goed wordt weergegeven", "wordt deze e-mail niet goed weergegeven",
    // Polish
    "zobacz w przeglądarce", "wyświetl w przeglądarce", "zobacz wiadomość w przeglądarce", "wyświetl wiadomość w przeglądarce", "zobacz tę wiadomość w przeglądarce",
    "otwórz w przeglądarce", "zobacz wersję online", "zobacz wersję w przeglądarce", "jeśli nie widzisz tej wiadomości", "jeśli wiadomość nie wyświetla się poprawnie",
    "jeżeli wiadomość nie wyświetla się poprawnie", "problem z wyświetlaniem wiadomości",
    // Turkish
    "tarayıcıda görüntüle", "tarayıcınızda görüntüleyin", "tarayıcıda görüntülemek için tıklayın", "bu e-postayı tarayıcıda görüntüle", "bu e-postayı tarayıcınızda görüntüleyin",
    "web tarayıcısında görüntüle", "tarayıcıda aç", "web sürümünü görüntüle", "e-posta düzgün görünmüyorsa", "e-posta doğru görüntülenmiyorsa", "görüntüleme sorunu yaşıyorsanız",
    // Korean
    "브라우저에서 보기", "브라우저에서 보시려면 클릭하세요", "웹 브라우저에서 보기", "웹브라우저에서 보기", "웹페이지로 보기", "웹에서 보기", "브라우저로 보기", "웹 버전 보기", "웹버전 보기",
    "이메일이 정상적으로 보이지 않으면", "메일이 정상적으로 보이지 않는 경우", "메일이 보이지 않으면", "이 메일이 제대로 보이지 않으면",
    // Indonesian
    "lihat di browser", "lihat di browser anda", "lihat di peramban", "lihat email ini di browser", "lihat email di browser", "lihat versi web", "lihat versi online",
    "buka di browser", "baca di browser", "jika email ini tidak tampil dengan benar", "jika tidak dapat melihat email ini", "email tidak tampil dengan benar", "kesulitan melihat email ini",
    // Traditional Chinese
    "在瀏覽器中查看", "在瀏覽器中檢視", "在瀏覽器中開啟", "在瀏覽器中閱讀", "在瀏覽器查看", "使用瀏覽器查看", "於瀏覽器中檢視", "請在瀏覽器中查看", "網頁版查看", "線上檢視",
    "如果郵件無法正常顯示", "如果無法正常顯示", "無法查看此郵件", "郵件無法顯示", "電子郵件無法正常顯示",
];

/// Text of links and buttons that are not content ("click here", "unsubscribe"): dropped when they are all there is.
const ACTION_PHRASES: &[&str] = &[
    // English
    "view online", "view it online", "read online", "web version", "online ansehen", "online anzeigen", "webversion", "version en ligne", "ver en línea", "ver online",
    "在线查看", "网页版", "веб версия", "онлайн версия", "xem trực tuyến", "xem trên web",
    "click here", "tap here", "click here to view", "click here to unsubscribe", "click to view", "unsubscribe", "unsubscribe here", "unsubscribe from this list",
    "unsubscribe from these emails", "manage preferences", "manage your preferences", "manage your email preferences", "update preferences", "update your preferences",
    "email preferences", "privacy policy", "terms of service", "terms and conditions", "privacy", "terms", "preferences", "datenschutz", "confidentialité", "forward to a friend", "forward this email", "view privacy policy",
    // French
    "cliquez ici", "cliquer ici", "se désabonner", "me désabonner", "vous désabonner", "désabonnement", "se désinscrire", "me désinscrire", "désinscription",
    "gérer mes préférences", "gérer vos préférences", "politique de confidentialité",
    // (fix56: "Désabonnez-vous", "ne plus recevoir", "annuler l'abonnement" ...; accents do not matter, see `fold`)
    "désabonnez vous", "désabonne toi", "désabonner de la newsletter", "ne plus recevoir", "annuler l abonnement", "annuler mon abonnement", "annuler votre abonnement",
    "se retirer de la liste", "gérer mes abonnements", "gérer vos abonnements", "désinscrivez vous",
    // German
    "hier klicken", "klicken sie hier", "hier klicken zum anzeigen", "abmelden", "newsletter abbestellen", "abbestellen", "vom newsletter abmelden",
    "newsletter abmelden", "einstellungen verwalten", "datenschutzerklärung",
    "abmeldung", "newsletter abmeldung", "abo kündigen", "abo kuendigen", "abo beenden", "keine weiteren e mails", "keine weiteren e mails erhalten", "nicht mehr erhalten",
    "newsletter kündigen", "newsletter kuendigen", "newsletter beenden", "austragen", "aus dem verteiler austragen",
    // Spanish
    "haz clic aquí", "haga clic aquí", "clic aquí", "cancelar suscripción", "cancelar la suscripción", "darse de baja", "darme de baja", "anular suscripción",
    "gestionar preferencias", "gestiona tus preferencias", "política de privacidad",
    "cancela tu suscripción", "cancelar tu suscripción", "cancelar mi suscripción", "anular la suscripción", "darte de baja", "dar de baja", "date de baja",
    "desuscribirse", "desuscribirme", "no recibir más", "gestionar suscripciones", "gestiona tus suscripciones",
    // Japanese
    "こちらをクリック", "ここをクリック", "こちら", "配信停止", "配信解除", "メール配信停止", "メール配信解除", "購読解除", "登録解除", "配信停止はこちら", "配信設定",
    "メルマガ解除", "メルマガ配信停止", "配信を停止", "メール配信を停止", "配信中止", "受信停止", "メール受信停止", "受信を停止", "配信解除はこちら", "登録解除はこちら",
    // Russian
    "нажмите здесь", "кликните здесь", "нажмите сюда", "отписаться", "отписаться от рассылки", "отказаться от рассылки", "отписаться здесь",
    "управление подпиской", "политика конфиденциальности",
    "отпишитесь", "отписка", "отказаться от подписки", "отменить подписку", "отмена подписки", "больше не получать", "прекратить рассылку",
    // Simplified Chinese
    "点击这里", "点击此处", "单击此处", "点此查看", "取消订阅", "退订", "退订邮件", "点击退订", "不再接收", "管理订阅", "隐私政策",
    "停止接收", "取消接收", "退订此邮件", "取消关注",
    // Vietnamese
    "nhấn vào đây", "nhấp vào đây", "bấm vào đây", "click vào đây", "chạm vào đây", "hủy đăng ký", "huỷ đăng ký", "hủy nhận tin", "hủy nhận email", "bỏ đăng ký",
    "ngừng nhận email", "ngừng nhận tin", "từ chối nhận email", "quản lý đăng ký", "chính sách bảo mật",
    "nhan vao day", "nhap vao day", "bam vao day", "huy dang ky", "bo dang ky",
    "hủy đăng kí", "huỷ đăng kí", "bỏ đăng kí", "hủy nhận thư", "ngừng nhận thư", "hủy theo dõi", "từ chối nhận tin", "từ chối nhận thư",
    // Arabic
    "انقر هنا", "اضغط هنا", "إلغاء الاشتراك", "الغاء الاشتراك",
    // Portuguese, Italian, Dutch, Polish, Turkish, Korean, Indonesian, Traditional Chinese (W6.13)
    "clique aqui", "cancelar inscrição", "cancelar subscrição", "descadastrar", "gerenciar preferências", "política de privacidade",
    "clicca qui", "annulla l iscrizione", "cancella iscrizione", "disiscriviti", "gestisci le preferenze", "informativa sulla privacy",
    "klik hier", "uitschrijven", "afmelden", "voorkeuren beheren", "privacybeleid",
    "kliknij tutaj", "kliknij tu", "wypisz się", "zrezygnuj z subskrypcji", "zarządzaj preferencjami", "polityka prywatności",
    "buraya tıklayın", "buraya tıklayınız", "abonelikten çık", "tercihleri yönet", "gizlilik politikası",
    "여기를 클릭", "여기를 클릭하세요", "수신거부", "수신 거부", "구독 취소", "개인정보처리방침", "환경설정 관리",
    "klik di sini", "klik disini", "berhenti berlangganan", "kelola preferensi", "kebijakan privasi",
    "點擊這裡", "點擊此處", "點此查看", "取消訂閱", "退訂", "不再接收", "管理訂閱", "隱私權政策",
];

/// The text in Unicode normalisation form C, for MATCHING only (W6.13): "Xem thư" typed with a combining horn and hook (NFD, as macOS mail and some
/// newsletter tools write Vietnamese) is the same phrase as the precomposed one. What is shown keeps its own bytes.
fn nfc(s: &str) -> std::borrow::Cow<'_, str> {
    icu_normalizer::ComposingNormalizer::new_nfc().normalize(s)
}

/// Base letters of the precomposed Latin letters (Latin-1 to Latin Extended-B: U+00C0..=U+024F, Latin Extended Additional with the Vietnamese ones: U+1E00..=U+1EFF),
/// read once from the NFD of each character, so "é" is "e" and "ệ" is "e" (a letter with only combining marks after its base; anything else stays itself).
fn base_letters() -> &'static (Vec<char>, Vec<char>) {
    static T: std::sync::OnceLock<(Vec<char>, Vec<char>)> = std::sync::OnceLock::new();
    T.get_or_init(|| {
        let nfd = icu_normalizer::DecomposingNormalizer::new_nfd();
        let table = |from: u32, to: u32| -> Vec<char> {
            (from..=to)
                .map(|u| {
                    let Some(c) = char::from_u32(u) else { return '\u{FFFD}' };
                    let mut buf = [0u8; 4];
                    let d = nfd.normalize(c.encode_utf8(&mut buf));
                    let mut it = d.chars();
                    match it.next() {
                        Some(b) if it.all(|m| matches!(m, '\u{0300}'..='\u{036F}')) => b,
                        _ => c,
                    }
                })
                .collect()
        };
        (table(0x00C0, 0x024F), table(0x1E00, 0x1EFF))
    })
}

/// A lower-case character as the phrases and the unsubscribe words compare it (the ONE place that decides what "the same letter" means): accents and the
/// combining marks are gone (Vietnamese "hủy" = "huy", French "désabonner" = "desabonner", Spanish "suscripción" = "suscripcion", German "kündigen" = "kundigen"),
/// "đ" is a "d", Russian "ё" is an "е", the Turkish dotless i is an i (capital I lowers to i), curly apostrophes are the straight one; None = skip (the dot above the İ
/// lowers to and the other combining marks). Kana, Han, Hangul, Arabic and Cyrillic letters other than "ё" are left as they are.
fn fold(c: char) -> Option<char> {
    if c.is_ascii() {
        return Some(c);
    }
    match c {
        '\u{0131}' => Some('i'),
        '\u{0110}' | '\u{0111}' => Some('d'),
        '\u{0401}' | '\u{0451}' => Some('\u{0435}'),
        '\u{2018}' | '\u{2019}' | '\u{02BC}' | '\u{00B4}' => Some('\''),
        '\u{0300}'..='\u{036F}' => None,
        '\u{00C0}'..='\u{024F}' => Some(base_letters().0[(c as u32 - 0xC0) as usize]),
        '\u{1E00}'..='\u{1EFF}' => Some(base_letters().1[(c as u32 - 0x1E00) as usize]),
        _ => Some(c),
    }
}

/// `s` as the matching sees it: NFC, lower case, `fold`ed. For testing a text against folded words (the unsubscribe words in `mail.rs`); one allocation, none of
/// the work for plain ASCII.
pub fn fold_for_match(s: &str) -> String {
    if s.is_ascii() {
        return s.to_ascii_lowercase();
    }
    nfc(s).chars().flat_map(|c| c.to_lowercase()).filter_map(fold).collect()
}

/// The phrases in a comparable form (lower case, one space between words, punctuation gone), longest first; `true` = a "view" phrase.
fn phrases() -> &'static [(Vec<char>, bool)] {
    static P: std::sync::OnceLock<Vec<(Vec<char>, bool)>> = std::sync::OnceLock::new();
    P.get_or_init(|| {
        let norm = |s: &str| -> Vec<char> {
            let mut out: Vec<char> = Vec::new();
            for c in nfc(s).chars().flat_map(|c| c.to_lowercase()).filter_map(fold) {
                if wordish(c) {
                    out.push(c);
                } else if out.last().is_some_and(|l| *l != ' ') {
                    out.push(' ');
                }
            }
            while out.last() == Some(&' ') {
                out.pop();
            }
            out
        };
        let mut v: Vec<(Vec<char>, bool)> = VIEW_PHRASES.iter().map(|p| (norm(p), true)).chain(ACTION_PHRASES.iter().map(|p| (norm(p), false))).collect();
        v.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
        v
    })
}

/// If `s` starts with the phrase `p` (case-insensitive; any punctuation or spaces stand for the single space of the phrase), the byte
/// length of that start. The phrase must end at the end of a word, except in Chinese / Japanese / Korean where words are not spaced.
fn eat_phrase(s: &str, p: &[char]) -> Option<usize> {
    let mut pi = 0;
    let mut end = 0;
    let mut it = s.char_indices().peekable();
    while pi < p.len() {
        let (idx, c) = it.next()?;
        if wordish(c) {
            for lc in c.to_lowercase().filter_map(fold) {
                if p.get(pi) != Some(&lc) {
                    return None;
                }
                pi += 1;
            }
            end = idx + c.len_utf8();
        } else if sepish(c) && p[pi] == ' ' {
            pi += 1;
            while it.peek().is_some_and(|(_, d)| sepish(*d)) {
                it.next();
            }
        } else {
            return None;
        }
    }
    let last = *p.last()?;
    if s[end..].chars().next().is_some_and(wordish) && !cjk(last) {
        return None;
    }
    Some(end)
}

/// `s` without the boilerplate phrases at its start ("view" phrases always, "click here" / "unsubscribe" ones when `actions`),
/// white space and punctuation between them included; and whether there was any.
fn strip_boilerplate(s: &str, actions: bool) -> (&str, bool) {
    let n = nfc(s);
    if matches!(n, std::borrow::Cow::Borrowed(_)) {
        return strip_normalized(s, actions);
    }
    // not in form C (Vietnamese typed with combining marks, Hangul jamo): the phrases are looked for in the normalised text; what is left is the ORIGINAL text after the
    // part that was eaten, so the shown text keeps its bytes
    let (rest, hit) = strip_normalized(&n, actions);
    if !hit {
        return (s, false);
    }
    let eaten = &n[..n.len() - rest.len()];
    let end = s
        .char_indices()
        .map(|(i, _)| i)
        .chain(std::iter::once(s.len()))
        .find(|&i| nfc(&s[..i]).len() >= eaten.len() && nfc(&s[..i]).starts_with(eaten))
        .unwrap_or(s.len());
    (&s[end..], true)
}

fn strip_normalized(mut s: &str, actions: bool) -> (&str, bool) {
    let mut hit = false;
    'again: loop {
        s = s.trim_start_matches(sepish);
        for (p, view) in phrases() {
            if *view || actions {
                if let Some(n) = eat_phrase(s, p) {
                    s = &s[n..];
                    hit = true;
                    continue 'again;
                }
            }
        }
        return (s, hit);
    }
}

/// Text that is nothing but such phrases ("View in browser", "Unsubscribe | Manage preferences").
fn is_boilerplate(text: &str) -> bool {
    let (rest, hit) = strip_boilerplate(text, true);
    hit && !rest.chars().any(wordish)
}

/// Text with HTML entities decoded (`&amp;`, `&#8217;`, `&nbsp;`), unknown ones left as they are.
fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        let rest = &s[i..];
        if rest.starts_with('&') {
            match entity(rest) {
                Some((t, n)) => {
                    out.push_str(&t);
                    i += n;
                }
                None => {
                    out.push('&');
                    i += 1;
                }
            }
        } else {
            let n = rest.find('&').unwrap_or(rest.len());
            out.push_str(&rest[..n]);
            i += n;
        }
    }
    out
}

/// A link target: a web / mail / phone address, a relative path or an anchor.
fn link_target(t: &str) -> bool {
    let t = t.trim_start_matches('<');
    let l: String = t.chars().take(12).collect::<String>().to_ascii_lowercase();
    ["http://", "https://", "ftp://", "ftps://", "mailto:", "tel:", "sms:", "cid:", "www.", "/", "#"].iter().any(|p| l.starts_with(p)) || t.contains("://")
}

/// A web / mail / phone address (not a relative path), for `<...>` around a bare address.
fn absolute_url(t: &str) -> bool {
    let l: String = t.chars().take(12).collect::<String>().to_ascii_lowercase();
    ["http://", "https://", "ftp://", "ftps://", "mailto:", "tel:", "www."].iter().any(|p| l.starts_with(p))
}

/// Index of the bracket that closes the one at `open` (nesting counted), looking at most `limit` characters ahead.
fn matching(c: &[char], open: usize, o: char, cl: char, limit: usize) -> Option<usize> {
    let mut depth = 0usize;
    for (k, &ch) in c.iter().enumerate().skip(open).take(limit) {
        if ch == o {
            depth += 1;
        } else if ch == cl {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                return Some(k);
            }
        }
    }
    None
}

/// `[text](target)` or `[text][ref]` at `open` (a `[`): the text of the link and the index after it. Not a link when the target
/// is not an address (`[note](see above)` is words).
fn markdown_link(c: &[char], open: usize, depth: u8) -> Option<(String, usize)> {
    let close = matching(c, open, '[', ']', 2500)?;
    let end = match c.get(close + 1) {
        Some('(') => match matching(c, close + 1, '(', ')', 2500) {
            Some(end) => {
                let target: String = c[close + 2..end].iter().collect();
                let first = target.split_whitespace().next().unwrap_or("");
                if !(first.is_empty() || link_target(first)) {
                    return None;
                }
                end
            }
            None => {
                // a link that is cut off (a snippet stored cut at 200 characters): its address runs to the next space
                let from = close + 2;
                let stop = c[from..].iter().position(|ch| ch.is_whitespace()).map_or(c.len(), |p| from + p);
                let first: String = c[from..stop].iter().collect();
                if !absolute_url(&first) {
                    return None;
                }
                stop - 1
            }
        },
        Some('[') => matching(c, close + 1, '[', ']', 40)?,
        _ => return None,
    };
    // (the text is read only for a real link: a text full of brackets must not be scanned again for every one of them)
    let inner = &c[open + 1..close];
    let text = if depth < 3 { strip_links_in(inner, depth + 1) } else { inner.iter().collect() };
    Some((text, end + 1))
}

/// Links in Markdown form turned into their text (or into nothing when the text is boilerplate); images, `<https://...>` and
/// reference markers (`[1]`, `[1]:`) removed. Dropped items leave a space; new lines stay.
fn strip_links(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    strip_links_in(&c, 0)
}

fn strip_links_in(c: &[char], depth: u8) -> String {
    let mut out = String::with_capacity(c.len());
    let mut i = 0;
    while i < c.len() {
        match c[i] {
            '!' if c.get(i + 1) == Some(&'[') => match markdown_link(c, i + 1, depth) {
                Some((_, end)) => {
                    out.push(' ');
                    i = end;
                }
                None => {
                    out.push('!');
                    i += 1;
                }
            },
            '[' => {
                if let Some((text, end)) = markdown_link(c, i, depth) {
                    if !is_boilerplate(&text) {
                        out.push_str(&text);
                    }
                    out.push(' ');
                    i = end;
                } else if let Some(close) = matching(c, i, '[', ']', 8).filter(|k| {
                    let t = &c[i + 1..*k];
                    // (not glued to a word: "array[0]" is code, "see the report [1]" is a reference)
                    (i == 0 || !c[i - 1].is_alphanumeric()) && !t.is_empty() && (t.iter().all(char::is_ascii_digit) || (t[0] == '^' && t.len() > 1 && t[1..].iter().all(char::is_ascii_alphanumeric)))
                }) {
                    // a reference marker: [1], [^2]; and the colon of a reference definition "[1]: https://..."
                    out.push(' ');
                    i = close + 1;
                    if c.get(i) == Some(&':') {
                        i += 1;
                    }
                } else if let Some(close) = matching(c, i, '[', ']', 240).filter(|k| image_marker(&c[i + 1..*k])) {
                    // the alt text of a picture in a text part ("[image: Google]", "[cid:logo.png@01D9]", "[Image]"): not words, and no alt text is kept
                    out.push(' ');
                    i = close + 1;
                } else {
                    out.push('[');
                    i += 1;
                }
            }
            '<' => {
                let end = c.iter().enumerate().skip(i + 1).take(2000).find(|(_, ch)| **ch == '>').map(|(k, _)| k);
                match end {
                    Some(k) if {
                        let t: String = c[i + 1..k].iter().collect();
                        !t.is_empty() && !t.contains(char::is_whitespace) && absolute_url(&t)
                    } =>
                    {
                        out.push(' ');
                        i = k + 1;
                    }
                    _ => {
                        out.push('<');
                        i += 1;
                    }
                }
            }
            ch => {
                out.push(ch);
                i += 1;
            }
        }
    }
    out
}

/// The words that open the marker of a picture in a text part, compared lower case: English, and the labels the mail programs of the app's languages write
/// (Gmail "[image: Google]", Outlook "[cid:image001.png@01D9...]", Apple Mail "[Image]", "[Bild: ...]", "[Imagen: ...]", "[Image : ...]" (French), "[Изображение: ...]", "[画像: ...]", "[Hình ảnh: ...]").
const IMAGE_WORDS: [&str; 16] = ["image", "img", "inline image", "inline-image", "picture", "photo", "bild", "imagen", "imagem", "immagine", "изображение", "画像", "图片", "圖片", "hình ảnh", "ảnh"];

/// The text between the brackets of `[image: alt text]`, `[cid:...]` and `[Image]` (a picture of a text part). Only a whole bracket that starts with the word (and a colon,
/// or nothing more) counts: "[Image] was uploaded" or "[image 2 of 5]" in a sentence is not touched.
fn image_marker(t: &[char]) -> bool {
    let text: String = t.iter().collect();
    let low = text.trim().to_lowercase();
    if low.starts_with("cid:") {
        return true;
    }
    IMAGE_WORDS.iter().any(|w| match low.strip_prefix(w) {
        Some("") => true,
        // "image: alt", "Image : alt" (French spacing), "画像：alt" (full-width colon)
        Some(rest) => {
            let r = rest.trim_start();
            r.starts_with(':') || r.starts_with('：')
        }
        None => false,
    })
}

/// `host.tld/path`: an address written without a scheme.
fn host_and_path(t: &str) -> bool {
    let Some((host, path)) = t.split_once('/') else { return false };
    let labels: Vec<&str> = host.split('.').collect();
    !path.is_empty()
        && labels.len() >= 2
        && labels.iter().all(|l| !l.is_empty() && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
        && labels.last().is_some_and(|l| l.len() >= 2 && l.bytes().all(|b| b.is_ascii_alphabetic()))
}

/// A long run of letters and digits, or a path with query characters, that no person writes (a tracking token).
fn tracking_like(t: &str) -> bool {
    t.len() >= 28 && t.bytes().any(|b| matches!(b, b'/' | b'=' | b'%' | b'?' | b'&'))
        || t.len() >= 36 && t.bytes().any(|b| b.is_ascii_digit()) && t.bytes().any(|b| b.is_ascii_uppercase()) && t.bytes().any(|b| b.is_ascii_lowercase())
}

/// One word of the text with an address taken out: nothing left for an address or a tracking token, the text around a
/// `scheme://...` that is glued to a word, the word itself otherwise.
fn drop_url_in_token(tok: &str) -> String {
    const OPEN: &[char] = &['(', '[', '{', '<', '"', '\'', '“', '‘', '«'];
    if let Some(p) = tok.find("://") {
        let start = tok[..p].char_indices().rev().take_while(|(_, c)| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')).last().map(|(i, _)| i).unwrap_or(p);
        return tok[..start].trim_matches(|c| OPEN.contains(&c)).to_string();
    }
    let core = tok.trim_matches(|c: char| OPEN.contains(&c) || matches!(c, ')' | ']' | '}' | '>' | '.' | ',' | ';' | ':' | '!' | '?' | '"' | '\'' | '”' | '’' | '»'));
    let l = core.to_ascii_lowercase();
    if l.starts_with("mailto:") || l.starts_with("tel:") || l.starts_with("www.") || (core.is_ascii() && (host_and_path(core) || tracking_like(core))) {
        return String::new();
    }
    tok.to_string()
}

/// Words that only point at an address ("at", "visit", "see", "go to", "unter", "sur", "tại", "на"): the obvious ones of the app's languages that are written with spaces
/// (Japanese and Chinese attach their particles to the word before, so nothing is dropped there). Lower case, without a closing colon or comma.
const POINTER_WORDS: [&str; 23] = [
    "at", "on", "to", "via", "visit", "see", "open", "unter", "auf", "bei", "en", "visita", "visite", "sur", "à", "visitez", "tại", "на", "по", "go to", "truy cập", "besuchen sie", "ir a",
];

/// Takes the pointer word (or the two that make one: "go to", "truy cập") off the end of the kept words. Only called after an address was removed, so a sentence without one is never touched.
fn drop_pointer_word(kept: &mut Vec<String>) {
    let word = |t: &String| t.trim_end_matches([':', ',']).to_lowercase();
    let n = kept.len();
    if n >= 2 {
        let two = format!("{} {}", word(&kept[n - 2]), word(&kept[n - 1]));
        if POINTER_WORDS.contains(&two.as_str()) {
            kept.truncate(n - 2);
            return;
        }
    }
    if n >= 1 && POINTER_WORDS.contains(&word(&kept[n - 1]).as_str()) {
        kept.pop();
    }
}

/// A character of a rule, frame or bullet row ("-----", "=====", "_____", "* * *", "┄┄┄").
fn rule_char(c: char) -> bool {
    matches!(c, '-' | '_' | '=' | '*' | '#' | '~' | '+' | '|' | '<' | '>' | '^' | '/' | '\\' | '.' | '·' | '•' | '—' | '–' | '\u{2500}'..='\u{259F}')
}

/// Runs of rule characters (3 or more, 4 or more of dots only; single spaces inside a run allowed) replaced by one space.
fn collapse_rules(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < c.len() {
        if !rule_char(c[i]) {
            out.push(c[i]);
            i += 1;
            continue;
        }
        let (mut j, mut n, mut other) = (i, 0usize, false);
        while j < c.len() {
            if rule_char(c[j]) {
                n += 1;
                other |= c[j] != '.';
                j += 1;
            } else if c[j] == ' ' && c.get(j + 1).is_some_and(|d| rule_char(*d)) {
                j += 1;
            } else {
                break;
            }
        }
        if n >= if other { 3 } else { 4 } {
            out.push(' ');
        } else {
            out.extend(&c[i..j]);
        }
        i = j;
    }
    out
}

/// "()" "[]" and the like left behind by removed addresses.
fn drop_empty_brackets(s: &str) -> String {
    let mut t = s.to_string();
    for _ in 0..4 {
        let n = t.replace("()", "").replace("[]", "").replace("( )", "").replace("[ ]", "");
        if n == t {
            break;
        }
        t = n;
    }
    t
}

/// Punctuation left at the ends of a line by removed items. (A comma, colon or semicolon at the end of a line stays: the lines are
/// joined into one text, and `preview` trims the end of that text.)
fn trim_junk(s: &str) -> &str {
    const LEAD: &[char] = &[' ', '|', '·', '•', ':', ';', ',', '>', ')', ']', '}', '_', '=', '~', '*', '/', '\\'];
    const TRAIL: &[char] = &[' ', '|', '·', '•', '<', '(', '[', '{', '-', '–', '—', '_', '=', '~', '*', '/', '\\'];
    let mut t = s;
    loop {
        let a = t.trim_start_matches(LEAD);
        // a dash opens a line only as a separator ("- item"), not in "-5 degrees"; "#" only as a Markdown heading ("# Title"), not in "#1"
        let b = ['-', '–', '—'].iter().find_map(|d| a.strip_prefix(*d)).filter(|r| r.starts_with(char::is_whitespace)).unwrap_or(a);
        let b = if b.starts_with('#') {
            let r = b.trim_start_matches('#');
            if b.len() - r.len() <= 6 && r.starts_with(char::is_whitespace) { r } else { b }
        } else {
            b
        };
        if b.len() == t.len() {
            break;
        }
        t = b;
    }
    t.trim_end_matches(TRAIL)
}

/// One line of the text, after the links of the whole text were handled: no addresses, rules or boilerplate.
fn line_text(line: &str) -> String {
    let mut kept: Vec<String> = Vec::new();
    let mut removed = false;
    for tok in line.split_whitespace() {
        let t = drop_url_in_token(tok);
        if t.is_empty() {
            // an address was taken out: the word that only pointed at it ("... apps at <address> for details") goes with it
            removed = true;
            drop_pointer_word(&mut kept);
        } else {
            kept.push(t);
        }
    }
    let mut s = kept.join(" ");
    if removed {
        for p in [" ,", " .", " ;", " :", " !", " ?"] {
            s = s.replace(p, &p[1..]);
        }
    }
    let s = clean_text(&drop_empty_brackets(&collapse_rules(&s)));
    if s.is_empty() || is_boilerplate(&s) {
        return String::new();
    }
    let (rest, hit) = strip_boilerplate(&s, false);
    trim_junk(if hit { rest } else { &s }).to_string()
}

/// Markup remnants in text: comments (conditional ones included), `<![endif]>`-style fragments, `<!DOCTYPE`, `<?...?>`. They come from
/// a text/plain part that quotes them, from entity-encoded markup (`&lt;!--[if mso]&gt;`) and from half-cut comments. A comment with
/// no end is dropped up to the next `>` on its line (or the end of the line), so it never swallows the readable lines after it.
fn strip_markup_remnants(s: &str) -> String {
    if !s.contains("<!") && !s.contains("<?") {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(p) = rest.find("<!").into_iter().chain(rest.find("<?")).min() {
        out.push_str(&rest[..p]);
        let at = &rest[p..];
        let line = at.find(['\n', '\r']).unwrap_or(at.len());
        let skip = if at.starts_with("<!-->") {
            5
        } else if at.starts_with("<!--->") {
            6
        } else if at.starts_with("<!--") {
            at[4..].find("-->").map(|q| q + 7).or_else(|| at[..line].find('>').map(|q| q + 1)).unwrap_or(line)
        } else {
            at[..line].find('>').map(|q| q + 1).unwrap_or(2)
        };
        out.push(' ');
        rest = &at[skip..];
    }
    out.push_str(rest);
    out
}

fn preview(raw: &str, decode: bool) -> String {
    let raw = match raw.char_indices().nth(PREVIEW_SOURCE_MAX) {
        Some((i, _)) => &raw[..i],
        None => raw,
    };
    let decoded = strip_markup_remnants(&if decode { decode_entities(raw) } else { raw.to_string() });
    // invisible characters out and white space tidy line by line first, so they cannot split a link; the lines stay lines
    let tidy = decoded.split(['\n', '\r', '\u{2028}', '\u{2029}', '\u{85}']).map(clean_text).filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n");
    let linked = strip_links(&tidy);
    let mut out = String::new();
    for line in linked.split('\n') {
        let l = line_text(line);
        if l.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&l);
        if out.len() > SNIPPET_MAX * 8 {
            break;
        }
    }
    let end = out.trim_end_matches([' ', ',', ':', ';']).len();
    out.truncate(end);
    out
}

/// The readable words of a plain text part as one line: Markdown links become their text (or nothing for "View in browser",
/// "Unsubscribe", "Click here" and their translations), bare and `<angle>` addresses, tracking tokens, images, reference markers,
/// HTML entities, invisible characters and rules of dashes or underscores are gone, white space is collapsed. Letters of every
/// script and emoji are kept; the result is as long as the text (`truncate_words` or `truncate_display` cut it).
pub fn preview_text(raw: &str) -> String {
    preview(raw, true)
}

/// How much readable text a line holds: letters, a Han / kana / Hangul character counting for two.
fn readable_len(s: &str) -> usize {
    s.chars().filter(|c| c.is_alphabetic()).map(|c| if cjk(c) { 2 } else { 1 }).sum()
}

/// `s` cut to at most `max` graphemes (what a person counts as a character: an emoji family, a flag, a letter with its accents
/// are one), at a word boundary when there is one in the second half, with "…" at the end when something was cut.
pub fn truncate_display(s: &str, max: usize) -> String {
    use unicode_segmentation::UnicodeSegmentation;
    if s.graphemes(true).nth(max).is_none() {
        return s.to_string();
    }
    let cut = s.grapheme_indices(true).nth(max.saturating_sub(1).max(1)).map(|(i, _)| i).unwrap_or(s.len());
    let head = &s[..cut];
    let whole = if s[cut..].starts_with(char::is_whitespace) {
        head
    } else {
        match head.rfind(char::is_whitespace) {
            Some(p) if p >= head.len() / 2 => &head[..p],
            _ => head,
        }
    };
    let trimmed = whole.trim_end_matches(|c: char| c.is_whitespace() || matches!(c, ',' | ';' | ':' | '.' | '-' | '–' | '—' | '|' | '/' | '(' | '['));
    format!("{}…", if trimmed.is_empty() { head } else { trimmed })
}

/// The preview line of a desktop notification, from a stored snippet (old snippets are cleaned again): at most
/// `NOTIFY_PREVIEW_MAX` characters, and empty when too little readable text is left (a notification then shows no third line).
pub fn notification_preview(snippet: &str) -> String {
    let s = preview_text(snippet);
    if readable_len(&s) < NOTIFY_MIN_READABLE {
        return String::new();
    }
    truncate_display(&s, NOTIFY_PREVIEW_MAX)
}

/// A subject or sender name for a notification: control characters and invisible padding out, white space collapsed, nothing else
/// changed (emoji joiners, accents, bidi marks of right-to-left text stay), very long lines cut.
pub fn notification_line(s: &str) -> String {
    let mut out = String::with_capacity(s.len().min(1024));
    let mut space = false;
    for c in s.chars() {
        if c.is_whitespace() || c.is_control() {
            space = !out.is_empty();
            continue;
        }
        if matches!(c, '\u{200B}' | '\u{2060}' | '\u{FEFF}' | '\u{00AD}' | '\u{034F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}') {
            continue;
        }
        if space {
            out.push(' ');
            space = false;
        }
        out.push(c);
        if out.len() > NOTIFY_LINE_MAX * 16 {
            break;
        }
    }
    truncate_display(&out, NOTIFY_LINE_MAX)
}

/// A stored snippet that looks like style sheet text or markup instead of words.
pub fn looks_like_junk(s: &str) -> bool {
    let t = s.trim_start();
    t.starts_with(['#', '.', '@', '<']) || (t.contains('{') && t.contains(';'))
}

/// One-time clean-up of snippets stored before the scanner above existed: rows whose snippet looks like CSS or markup get a
/// new one from their stored `body_html` (or `body_text`). Safe on a big database: it walks `rowid` in batches of 200, one
/// short transaction each, never touches a row without a body, never writes an empty snippet, and can be run again (it only
/// changes rows whose new snippet differs). Returns the number of rows changed.
pub fn fix_stored(conn: &Connection) -> Result<usize, String> {
    let done: Option<String> = conn.query_row("SELECT value FROM settings WHERE key=?1", [FIXED_KEY], |r| r.get(0)).ok();
    if done.is_some() {
        return Ok(0);
    }
    let e = |x: rusqlite::Error| x.to_string();
    let mut changed = 0usize;
    // one mail file at a time: the `messages` view has no rowid
    for schema in crate::shard::message_schemas(conn) {
        let table = format!("{schema}.messages");
        let mut last = 0i64;
        loop {
            let batch: Vec<(i64, String)> = {
                let mut st = conn
                    .prepare(&format!(
                        "SELECT rowid, snippet FROM {table} WHERE rowid>?1
                           AND (body_html IS NOT NULL OR body_text IS NOT NULL)
                           AND (snippet LIKE '#%' OR snippet LIKE '.%' OR snippet LIKE '@%' OR snippet LIKE '<%'
                                OR (instr(snippet,'{{')>0 AND instr(snippet,';')>0))
                         ORDER BY rowid LIMIT 200"
                    ))
                    .map_err(e)?;
                let rows = st.query_map([last], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?.collect::<Result<Vec<_>, _>>().map_err(e)?;
                rows
            };
            let Some(&(max, _)) = batch.last() else { break };
            let tx = conn.unchecked_transaction().map_err(e)?;
            for (rid, old) in &batch {
                if !looks_like_junk(old) {
                    continue;
                }
                let (html, text): (Option<String>, Option<String>) =
                    tx.query_row(&format!("SELECT body_html, body_text FROM {table} WHERE rowid=?1"), [rid], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?;
                let new = {
                    let from_html = make(None, html.as_deref());
                    if from_html.is_empty() { make(text.as_deref(), None) } else { from_html }
                };
                if !new.is_empty() && new != *old {
                    tx.execute(&format!("UPDATE {table} SET snippet=?1 WHERE rowid=?2"), params![new, rid]).map_err(e)?;
                    changed += 1;
                }
            }
            tx.commit().map_err(e)?;
            last = max;
        }
    }
    conn.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?1,'1')", [FIXED_KEY]).map_err(e)?;
    Ok(changed)
}

/// Settings key that marks the one-time removal of link markup from stored snippets as done.
const LINKS_FIXED_KEY: &str = "snippet_fix_v2";

/// One-time clean-up of snippets stored before link markup was left out of the preview ("[View in browser](https://...)", bare
/// addresses): a snippet that holds an address or link markup is cleaned (`preview_text`); when little is left of it (the
/// snippet was cut inside the link) it is made again from the stored body. Never touches a row without such markup, never writes an
/// empty snippet, never changes the stored body (search reads `body_text`). Same batches and flag as `fix_stored`. Returns the
/// number of rows changed.
pub fn fix_stored_links(conn: &Connection) -> Result<usize, String> {
    let done: Option<String> = conn.query_row("SELECT value FROM settings WHERE key=?1", [LINKS_FIXED_KEY], |r| r.get(0)).ok();
    if done.is_some() {
        return Ok(0);
    }
    let e = |x: rusqlite::Error| x.to_string();
    let mut changed = 0usize;
    for schema in crate::shard::message_schemas(conn) {
        let table = format!("{schema}.messages");
        let mut last = 0i64;
        loop {
            let batch: Vec<(i64, String)> = {
                let mut st = conn
                    .prepare(&format!(
                        "SELECT rowid, snippet FROM {table} WHERE rowid>?1
                           AND (snippet LIKE '%](%' OR snippet LIKE '%://%' OR snippet LIKE '%www.%' OR snippet LIKE '%mailto:%'
                                OR snippet LIKE '%&nbsp;%' OR snippet LIKE '%&amp;%')
                         ORDER BY rowid LIMIT 200"
                    ))
                    .map_err(e)?;
                let rows = st.query_map([last], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?.collect::<Result<Vec<_>, _>>().map_err(e)?;
                rows
            };
            let Some(&(max, _)) = batch.last() else { break };
            let tx = conn.unchecked_transaction().map_err(e)?;
            for (rid, old) in &batch {
                let mut new = truncate_words(&preview_text(old));
                if new.chars().count() < 40 {
                    let (html, text): (Option<String>, Option<String>) =
                        tx.query_row(&format!("SELECT body_html, body_text FROM {table} WHERE rowid=?1"), [rid], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?;
                    let from_text = make(text.as_deref(), None);
                    let again = if from_text.is_empty() || looks_like_junk(&from_text) { make(None, html.as_deref()) } else { from_text };
                    if !again.is_empty() && !looks_like_junk(&again) {
                        new = again;
                    }
                }
                if !new.is_empty() && new != *old {
                    tx.execute(&format!("UPDATE {table} SET snippet=?1 WHERE rowid=?2"), params![new, rid]).map_err(e)?;
                    changed += 1;
                }
            }
            tx.commit().map_err(e)?;
            last = max;
        }
    }
    conn.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?1,'1')", [LINKS_FIXED_KEY]).map_err(e)?;
    Ok(changed)
}

/// Settings key that marks the one-time removal of picture markers ("[image: Google]") from stored snippets as done.
const MARKERS_FIXED_KEY: &str = "snippet_fix_v3";

/// One-time clean-up of snippets stored with the alt text of a picture of a text part ("[image: Google] You allowed ..."): cleaned with `preview_text`; a snippet that
/// would be left empty is made again from the stored body. Never changes a body, never writes an empty snippet. The notification builder cleans a snippet again
/// when it reads it (`notification_preview`), so a row not reached yet shows no marker either. Same batches as `fix_stored_links`. Returns the rows changed.
pub fn fix_stored_markers(conn: &Connection) -> Result<usize, String> {
    let done: Option<String> = conn.query_row("SELECT value FROM settings WHERE key=?1", [MARKERS_FIXED_KEY], |r| r.get(0)).ok();
    if done.is_some() {
        return Ok(0);
    }
    let e = |x: rusqlite::Error| x.to_string();
    let mut changed = 0usize;
    for schema in crate::shard::message_schemas(conn) {
        let table = format!("{schema}.messages");
        let mut last = 0i64;
        loop {
            let batch: Vec<(i64, String)> = {
                let mut st = conn
                    .prepare(&format!(
                        "SELECT rowid, snippet FROM {table} WHERE rowid>?1
                           AND (snippet LIKE '%[image%' OR snippet LIKE '%[img%' OR snippet LIKE '%[cid:%' OR snippet LIKE '%[inline%' OR snippet LIKE '%[picture%'
                                OR snippet LIKE '%[photo%' OR snippet LIKE '%[bild%' OR snippet LIKE '%[imagen%' OR snippet LIKE '%[imagem%' OR snippet LIKE '%[immagine%'
                                OR snippet LIKE '%[изображение%' OR snippet LIKE '%[画像%' OR snippet LIKE '%[图片%' OR snippet LIKE '%[圖片%' OR snippet LIKE '%[hình ảnh%' OR snippet LIKE '%[ảnh%')
                         ORDER BY rowid LIMIT 200"
                    ))
                    .map_err(e)?;
                let rows = st.query_map([last], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?.collect::<Result<Vec<_>, _>>().map_err(e)?;
                rows
            };
            let Some(&(max, _)) = batch.last() else { break };
            let tx = conn.unchecked_transaction().map_err(e)?;
            for (rid, old) in &batch {
                let mut new = truncate_words(&preview_text(old));
                if new.is_empty() {
                    let (html, text): (Option<String>, Option<String>) =
                        tx.query_row(&format!("SELECT body_html, body_text FROM {table} WHERE rowid=?1"), [rid], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?;
                    new = make(text.as_deref(), html.as_deref());
                }
                if !new.is_empty() && new != *old {
                    tx.execute(&format!("UPDATE {table} SET snippet=?1 WHERE rowid=?2"), params![new, rid]).map_err(e)?;
                    changed += 1;
                }
            }
            tx.commit().map_err(e)?;
            last = max;
        }
    }
    conn.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?1,'1')", [MARKERS_FIXED_KEY]).map_err(e)?;
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The text part of Google's "security alert" mail, as the owner saw it in the toast (the picture alt text first, then the words, then links).
    const GOOGLE_ALERT: &str = "[image: Google]\r\nYou allowed Claude for Google Drive access to some of your Google Account data\r\n\r\nnam@example.com\r\n\r\nIf you didn't allow this, check activity: https://accounts.google.com/AccountChooser?Email=nam@example.com&continue=https://myaccount.google.com/alert/nt/1761563412?rfn%3D311%26rfnc%3D1%26eid%3D-3414%26et%3D0\r\n\r\nYou can also see security activity at\r\nhttps://myaccount.google.com/notifications\r\n";

    #[test]
    fn picture_markers_of_a_text_part_are_dropped_with_their_alt_text() {
        let p = preview_text(GOOGLE_ALERT);
        assert!(p.starts_with("You allowed Claude for Google Drive access to some of your Google Account data"), "{p}");
        for bad in ["[image", "Google]", "http", "://", "accounts.google", "%3D"] {
            assert!(!p.contains(bad), "{bad:?} in {p:?}");
        }
        let n = notification_preview(GOOGLE_ALERT);
        assert!(n.starts_with("You allowed Claude") && !n.contains('[') && !n.contains("http"), "{n}");
        assert!(n.chars().count() <= NOTIFY_PREVIEW_MAX, "{n}");
        for (raw, want) in [
            ("[image: Google] Hello there", "Hello there"),
            ("[Image: Logo of the shop] Sale today", "Sale today"),
            ("[image] Sale today", "Sale today"),
            ("[cid:image001.png@01D9A1B2.C3D4E5F0] Dear customer, your order shipped", "Dear customer, your order shipped"),
            ("[CID:logo.png@x] [image: a]
[image: b] Text", "Text"),
            ("[Bild: Firmenlogo] Ihre Rechnung ist da", "Ihre Rechnung ist da"),
            ("[Imagen: logotipo] Su pedido ha salido", "Su pedido ha salido"),
            ("[Image : logo] Votre commande est partie", "Votre commande est partie"),
            ("[Изображение: логотип] Ваш заказ отправлен", "Ваш заказ отправлен"),
            ("[画像: ロゴ] ご注文を発送しました", "ご注文を発送しました"),
            ("[画像：ロゴ]ご注文を発送しました", "ご注文を発送しました"),
            ("[Hình ảnh: logo] Đơn hàng của bạn đã được gửi", "Đơn hàng của bạn đã được gửi"),
            ("[图片: 标志] 您的订单已发货", "您的订单已发货"),
        ] {
            assert_eq!(preview_text(raw), want, "{raw}");
        }
        // words in brackets that are not a picture marker stay
        for keep in ["The [image 2 of 5] slider", "Use array[0] and [note] here"] {
            let p = preview_text(keep);
            assert!(p.contains('['), "{keep:?} -> {p:?}");
        }
        assert_eq!(preview_text("[Image] was uploaded"), "was uploaded");
    }

    #[test]
    fn notification_text_is_plain_words_for_newsletters_with_many_links() {
        let raw = "[image: Shop]\n[View in browser](https://x.example/v?u=1)\nBig <https://t.example/a?b=c> sale www.shop.example/deals?utm_source=mail today (https://t.example/zz) mailto:sales@shop.example \u{200C}\u{00A0}\u{200C}\u{00A0}\u{200C}\u{00A0}  shop now [1] [2]\n[1]: https://a.example/1\n[2]: https://b.example/2\nhttps://very.long.example/path/with/many/segments/and?query=abcdefghijklmnopqrstuvwxyz0123456789&other=1";
        let p = preview_text(raw);
        assert_eq!(p, "Big sale today shop now", "{p}");
        assert_eq!(notification_preview(raw), "Big sale today shop now");
        let v = "[image: Cửa hàng] Ưu đãi lớn cho khách hàng thân thiết https://khuyen-mai.example/abc?x=1 xem ngay";
        assert_eq!(notification_preview(v), "Ưu đãi lớn cho khách hàng thân thiết xem ngay");
        let j = "[画像: ロゴ] 新商品のお知らせです。詳細は https://shop.example/new をご覧ください。";
        let n = notification_preview(j);
        assert!(n.starts_with("新商品のお知らせです") && !n.contains("http") && !n.contains('['), "{n}");
        // nothing readable is left: no preview line at all (the notification then shows the sender and the subject only)
        for empty in ["[image: Google]", "[cid:a.png@b] [image: x] https://only.example/link", "  \u{200B}\u{200C}\u{00A0} ", ""] {
            assert_eq!(notification_preview(empty), "", "{empty:?}");
        }
    }


    const NEWSLETTER: &str = r#"<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml"><head><meta charset="utf-8"><title>IP2Location Newsletter</title>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><style>table,td{border-collapse:collapse;}</style><![endif]-->
<style type="text/css">#outlook a { padding: 0; } body { margin:0; } @media only screen and (max-width:600px){ .col{width:100%!important;} }</style>
<script>var x = "<div>fake</div>"; if (a < b) { go(); }</script></head>
<body><div style="display:none;max-height:0;overflow:hidden;mso-hide:all">Big savings &amp; new data &zwnj;&nbsp;&zwnj;&nbsp;&#8199;&#847; &zwnj;&nbsp;&shy;&#x200B;</div>
<!--[if !mso]><!--><div>Hello <b>Nam</b>,</div><!--<![endif]--><!--[if mso]><table><tr><td>Outlook only</td></tr></table><![endif]-->
<table><tr><td>Row&nbsp;one</td><td>Row two</td></tr></table><p>a &lt; b &amp; c</p><img alt="logo" src="data:image/png;base64,AAAA>BBB"></body></html>"#;

    #[test]
    fn newsletter_snippet_has_words_only() {
        let s = html_text(NEWSLETTER);
        assert_eq!(s, "Big savings & new data Hello Nam, Row one Row two a < b & c");
        for bad in ["{", "outlook a", "padding", "@media", "mso", "OfficeDocument", "fake", "IP2Location", "Outlook only", "&zwnj", "&nbsp"] {
            assert!(!s.contains(bad), "{bad:?} in {s:?}");
        }
        assert_eq!(make(None, Some(NEWSLETTER)), s);
    }

    #[test]
    fn real_text_part_wins_and_blank_text_falls_back_to_the_html() {
        assert_eq!(make(Some("  Hello\r\n\r\n  there\u{200B}\u{00A0} \u{2007}friend  "), Some("<p>html</p>")), "Hello there friend");
        assert_eq!(make(Some(" \u{200B}\u{00A0}\r\n"), Some("<style>p{x:y}</style><p>html</p>")), "html");
        assert_eq!(make(None, None), "");
        assert_eq!(make(None, Some("<style>a{b:c}</style>")), "");
    }

    #[test]
    fn comment_remnants_never_reach_a_snippet_or_a_notification() {
        let google = "<!--[if !mso]><!--><div>Keep track of your Google Account data</div><!--<![endif]-->\
            <!--[if gte mso 9]><xml><o:x>1</o:x></xml><![endif]--><!--[if false]><!--><p>namth.onl@gmail.com</p><!--<![endif]-->";
        assert_eq!(make(None, Some(google)), "Keep track of your Google Account data namth.onl@gmail.com");
        // entity-encoded markup of the html part and literal lines of a text part
        let enc = "<p>Keep track of your data &lt;!--[if !mso]&gt;&lt;! &lt;!--[if false]&gt;&lt;!</p>";
        assert_eq!(make(None, Some(enc)), "Keep track of your data");
        let text = "Keep track of your Google Account data\n<!--[if !mso]><!\n<!--[if false]><!\n<![endif]-->\n<?xml version?>\nnamth.onl@gmail.com";
        assert_eq!(make(Some(text), None), "Keep track of your Google Account data namth.onl@gmail.com");
        // one line, and an old stored snippet
        let old = "Keep track of your Google Account data namth.onl@gmail.com <!--[if !mso]><! <!--[if false]><!";
        assert_eq!(notification_preview(old), "Keep track of your Google Account data namth.onl@gmail.com");
        // unterminated: only the rest of its line goes, later lines stay
        assert_eq!(preview_text("Hello <!--[if mso\nWorld <!-- never closed"), "Hello World");
        assert_eq!(make(None, Some("<p>Hi</p><!--[if mso]><table><tr><td>x")), "Hi");
        for s in [make(Some(text), None), notification_preview(old), preview_text("a <! b <![ c <? d")] {
            assert!(!s.contains("<!") && !s.contains("<?"), "{s}");
        }
    }

    #[test]
    fn markup_edge_cases() {
        // an unclosed head ends where the body starts; unclosed style swallows the rest (nothing readable follows it)
        assert_eq!(html_text("<html><head><meta x><title>t</title><body>Hi there</body>"), "Hi there");
        assert_eq!(html_text("Intro<style>p{color:red}"), "Intro");
        // ">" inside a quoted attribute, quotes with an odd apostrophe, uppercase tags
        assert_eq!(html_text(r#"<A HREF="x>y" title='a'>Link</A> <STYLE>b{c:d}</STYLE>after"#), "Link after");
        assert_eq!(html_text("<p title=it's>text</p>"), "text");
        // comments, CDATA, processing instructions
        assert_eq!(html_text("a<!-- <b>x</b> -->b<![CDATA[ z ]]>c<?php echo 1 ?>d"), "abcd");
        assert_eq!(html_text("one<!-->two"), "onetwo");
        // entities
        assert_eq!(html_text("&lt;b&gt; &#65;&#x42; &copy; &unknown; &amp"), "<b> AB \u{a9} &unknown; &amp");
        // inline tags do not split words, block tags do
        assert_eq!(html_text("<b>Bo</b>ld<br>next<div>line</div>"), "Bold next line");
        // multi-byte text survives the byte scanner
        assert_eq!(html_text("<p>Xin chào, Nguyễn Văn Ánh &mdash; 日本語</p>"), "Xin chào, Nguyễn Văn Ánh \u{2014} 日本語");
    }

    #[test]
    fn long_text_is_cut_at_a_word() {
        let words: Vec<String> = (0..80).map(|i| format!("word{i}")).collect();
        let s = clean_text(&words.join("   "));
        let t = truncate_words(&s);
        assert!(t.chars().count() <= SNIPPET_MAX && t.chars().count() > SNIPPET_MAX - 12, "{}", t.chars().count());
        assert!(s.starts_with(&t) && s[t.len()..].starts_with(' '), "cut on a space: {t:?}");
        assert!(!t.ends_with(' '));
        // short text is untouched; one huge word is cut hard
        assert_eq!(truncate_words("short one"), "short one");
        assert_eq!(truncate_words(&"x".repeat(500)).chars().count(), SNIPPET_MAX);
        // exactly at the limit with a space next
        let exact = format!("{} tail", "y".repeat(SNIPPET_MAX));
        assert_eq!(truncate_words(&exact), "y".repeat(SNIPPET_MAX));
        // multi-byte characters are counted as characters
        assert_eq!(truncate_words(&"é".repeat(300)).chars().count(), SNIPPET_MAX);
    }

    #[test]
    fn junk_detection() {
        for j in ["#outlook a { padding: 0; }", ".ExternalClass { width:100%; }", "@media only screen { }", "<div>x</div>", "Hello body { margin:0; } done"] {
            assert!(looks_like_junk(j), "{j}");
        }
        for ok in ["Hello there", "Your order {12} shipped", "Meeting at 10: bring notes; thanks"] {
            assert!(!looks_like_junk(ok), "{ok}");
        }
    }

    fn db() -> Connection {
        crate::db::test_conn(&["a"])
    }

    fn put(c: &Connection, id: &str, snippet: &str, html: Option<&str>, text: Option<&str>) {
        c.execute(
            "INSERT INTO messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet,body_html,body_text) VALUES(?1,'a','inbox',(SELECT COUNT(*)+1 FROM messages),'t','s','n','x@y.z','','',0,?2,?3,?4)",
            params![id, snippet, html, text],
        )
        .unwrap();
    }

    fn snippet_of(c: &Connection, id: &str) -> String {
        c.query_row("SELECT snippet FROM messages WHERE id=?1", [id], |r| r.get(0)).unwrap()
    }

    #[test]
    fn stored_junk_snippets_are_recomputed_once_and_only_when_a_body_exists() {
        let c = db();
        let junk = "#outlook a { padding: 0; } body { margin:0; }";
        put(&c, "html", junk, Some(NEWSLETTER), Some("#outlook a { padding: 0; }"));
        put(&c, "textonly", ".x { color: red; }", None, Some("Plain words here"));
        put(&c, "nobody", junk, None, None);
        put(&c, "emptybody", junk, Some("<style>p{a:b}</style>"), Some(""));
        put(&c, "fine", "Hello there", Some("<p>Different</p>"), Some("Different"));
        put(&c, "hash", "#1 rated plugin for everything", Some("<p>#1 rated plugin for everything</p>"), None);
        // more rows than one batch
        for i in 0..450 {
            put(&c, &format!("bulk{i}"), "@media print { a { b: c; } }", Some(&format!("<style>a{{b:c}}</style><p>Bulk number {i}</p>")), None);
        }
        c.execute("DELETE FROM settings WHERE key=?1", [FIXED_KEY]).unwrap();
        let n = fix_stored(&c).unwrap();
        assert_eq!(n, 2 + 450, "html row, text-only row and the bulk rows");
        assert_eq!(snippet_of(&c, "html"), "Big savings & new data Hello Nam, Row one Row two a < b & c");
        assert_eq!(snippet_of(&c, "textonly"), "Plain words here");
        assert_eq!(snippet_of(&c, "nobody"), junk, "no body: untouched");
        assert_eq!(snippet_of(&c, "emptybody"), junk, "nothing readable: untouched");
        assert_eq!(snippet_of(&c, "fine"), "Hello there", "a normal snippet is never replaced");
        assert_eq!(snippet_of(&c, "hash"), "#1 rated plugin for everything");
        assert_eq!(snippet_of(&c, "bulk449"), "Bulk number 449");
        // done once: the flag stops a second run, and without the flag nothing changes either
        assert_eq!(fix_stored(&c).unwrap(), 0);
        c.execute("DELETE FROM settings WHERE key=?1", [FIXED_KEY]).unwrap();
        assert_eq!(fix_stored(&c).unwrap(), 0, "idempotent");
        assert_eq!(snippet_of(&c, "html"), "Big savings & new data Hello Nam, Row one Row two a < b & c");
    }

    // ---- readable preview: link markup, addresses, boilerplate ----

    /// The text/plain part of the marketing mail of bug F-27 (Sendinblue): a Markdown link to a tracking address first.
    const F27_TEXT: &str = "[View in browser](https://ecafgcd.r.af.d.sendibt2.com/tr/mr/Tri_95Hx3VWzJfQSa7ggBekbb0Elk9qsx0y6UH1lWEQ8lP4o2bJ6sXAn1ZcR7u?p=eyJ1IjoiMSJ9)\r\n\r\n\u{1F525} Mở Đặt Cọc iPhone Duo\r\n\r\nƯu đãi lớn cho khách hàng thân thiết, số lượng có hạn.\r\n\r\n[Unsubscribe](https://ecafgcd.r.af.d.sendibt2.com/unsub/abc)";

    /// The snippet as the app stored it before the fix: the first 200 characters, cut inside the link.
    const F27_OLD_SNIPPET: &str = "[View in browser](https://ecafgcd.r.af.d.sendibt2.com/tr/mr/Tri_95Hx3VWzJfQSa7ggBekbb0Elk9qsx0y6UH1lWEQ8lP4o2bJ6sXAn1ZcR7u?p=eyJ1IjoiMSJ9";

    fn graphemes(s: &str) -> usize {
        use unicode_segmentation::UnicodeSegmentation;
        s.graphemes(true).count()
    }

    #[test]
    fn f27_the_sample_of_the_screenshot_shows_no_link_markup() {
        // the stored snippet cut inside the link: nothing readable is left, so the notification has no third line
        assert_eq!(preview_text(F27_OLD_SNIPPET), "");
        assert_eq!(notification_preview(F27_OLD_SNIPPET), "");
        // the screenshot's own text (the link cut at 140 characters with an ellipsis)
        let shot = "[View in browser](https://ecafgcd.r.af.d.sendibt2.com/tr/mr/Tri_95Hx3VWzJfQSa7ggBekbb0Elk9qsx0y6UH1lWEQ8l\u{2026}";
        assert_eq!(notification_preview(shot), "");
        // a new snippet comes from the whole text: the preheader after the link is what is shown
        let s = make(Some(F27_TEXT), None);
        assert_eq!(s, "\u{1F525} Mở Đặt Cọc iPhone Duo Ưu đãi lớn cho khách hàng thân thiết, số lượng có hạn.");
        assert_eq!(notification_preview(&s), s, "short enough: shown whole");
        // the same through the HTML path: the visible text of the HTML has the link text only
        let html = "<a href=\"https://x.example/t?u=1\">View in browser</a><p>\u{1F525} Mở Đặt Cọc iPhone Duo</p><a href=\"https://x.example/u\">Unsubscribe</a>";
        assert_eq!(make(None, Some(html)), "\u{1F525} Mở Đặt Cọc iPhone Duo");
    }

    #[test]
    fn markdown_links_become_their_text_or_nothing() {
        for (raw, want) in [
            ("See [our site](https://x.example/a?b=c) now", "See our site now"),
            ("Read [the guide](<https://x.example/g>) first", "Read the guide first"),
            ("[Shop now](https://x.example/s \"Shop\") and save", "Shop now and save"),
            ("A [reference link][1] and [another][ref] done", "A reference link and another done"),
            ("Footnote [1] marker [^2] gone.", "Footnote marker gone."),
            ("[1]: https://x.example/one\nText after", "Text after"),
            ("![logo](https://x.example/logo.png) Welcome back", "Welcome back"),
            ("[![logo](https://x.example/l.png)](https://x.example/home) Welcome", "Welcome"),
            ("[Mail us](mailto:a@b.example) or call", "Mail us or call"),
            ("Parens (see [this](https://x.example/a_(b)) page) ok", "Parens (see this page) ok"),
            // brackets that are words stay
            ("[External] Please review", "[External] Please review"),
            ("[note](see above) stays", "[note](see above) stays"),
            ("array[0] = 5 and x[i]", "array[0] = 5 and x[i]"),
        ] {
            assert_eq!(preview_text(raw), want, "{raw:?}");
        }
        // a link cut off inside its address keeps its text
        assert_eq!(preview_text("Open [the offer](https://x.example/tr/abcdef0123"), "Open the offer");
        assert_eq!(preview_text("[View in browser](https://x.example/tr/abcdef0123"), "");
        assert_eq!(preview_text("[a](https://x.example/b)[c](https://x.example/d)"), "a c");
    }

    #[test]
    fn boilerplate_links_and_lines_are_dropped_in_every_language() {
        let phrases = [
            // English
            "View in browser", "View this email in your browser", "View this email in a browser.", "Having trouble viewing this email?", "Email not displaying correctly?",
            "Click here", "Unsubscribe", "Manage preferences", "View online", "Web version",
            // French
            "Voir dans le navigateur", "Afficher dans votre navigateur", "Voir la version en ligne", "Cliquez ici", "Se désabonner",
            // German
            "Im Browser ansehen", "Diese E-Mail im Browser ansehen", "Hier klicken", "Klicken Sie hier", "Abmelden", "Newsletter abbestellen",
            // Spanish
            "Ver en el navegador", "Ver este correo en el navegador", "Haz clic aquí", "Cancelar suscripción", "Darse de baja",
            // Japanese
            "ブラウザで見る", "ブラウザで表示", "メールが正しく表示されない場合", "こちらをクリック", "配信停止", "購読解除",
            // Russian
            "Открыть в браузере", "Посмотреть в браузере", "Если письмо не отображается", "Нажмите здесь", "Отписаться", "Отказаться от рассылки",
            // Simplified Chinese
            "在浏览器中查看", "在浏览器中打开", "如果无法正常显示", "点击这里", "点击此处", "取消订阅", "退订",
            // Vietnamese
            "Xem trong trình duyệt", "Xem email trên trình duyệt", "Xem email trong trình duyệt", "Xem trên trình duyệt", "Nhấn vào đây", "Bấm vào đây",
            "Nhấp vào đây", "Hủy đăng ký", "Huỷ đăng ký", "Hủy nhận tin", "Không xem được email?", "Xem trong trinh duyet", "Nhan vao day",
            // Arabic
            "عرض في المتصفح", "انقر هنا", "إلغاء الاشتراك",
        ];
        for p in phrases {
            // as a Markdown link, then real words
            let md = format!("[{p}](https://t.example/x?id=1)\nReal words here");
            assert_eq!(preview_text(&md), "Real words here", "link {p:?}");
            // as a line of its own with a bare address after it, and in capitals
            let line = format!("{p} https://t.example/x?id=1\nReal words here");
            assert_eq!(preview_text(&line), "Real words here", "line {p:?}");
            assert_eq!(preview_text(&format!("{}\nReal words here", p.to_uppercase())), "Real words here", "upper {p:?}");
            // nothing else in the text: nothing
            assert_eq!(preview_text(&md.replace("\nReal words here", "")), "", "alone {p:?}");
        }
        // several in a row, with separators, and the "view" lead-in in front of the preheader on one line
        assert_eq!(preview_text("[Unsubscribe](https://u.example) | [Manage preferences](https://m.example) | [View in browser](https://v.example)"), "");
        assert_eq!(preview_text("Having trouble viewing this email? View it in your browser. Big summer sale starts today"), "Big summer sale starts today");
        assert_eq!(preview_text("Xem email trên trình duyệt | \u{1F525} Mở Đặt Cọc iPhone Duo"), "\u{1F525} Mở Đặt Cọc iPhone Duo");
        assert_eq!(preview_text("在浏览器中查看 全场五折，仅限今天"), "全场五折，仅限今天");
        assert_eq!(preview_text("ブラウザで見る 夏のセール開催中"), "夏のセール開催中");
        assert_eq!(make(None, Some("<a href=\"https://v.example\">View this email in your browser</a> Summer sale")), "Summer sale");
        // words that only start like a phrase, and "click here" inside a real sentence, are content
        assert_eq!(preview_text("Click here to claim your 50% discount"), "Click here to claim your 50% discount");
        assert_eq!(preview_text("Unsubscribe from the plan before Friday to avoid charges"), "Unsubscribe from the plan before Friday to avoid charges");
        assert_eq!(preview_text("Viewing hours are 9 to 5"), "Viewing hours are 9 to 5");
        assert_eq!(preview_text("Read online reviews before you buy"), "Read online reviews before you buy");
        assert_eq!(preview_text("[Click here to claim your 50% discount](https://x.example/c)"), "Click here to claim your 50% discount");
    }

    fn nfd(s: &str) -> String {
        icu_normalizer::DecomposingNormalizer::new_nfd().normalize(s).into_owned()
    }

    /// W6.13: the "view in browser" lines of Portuguese, Italian, Dutch, Polish, Turkish, Korean, Indonesian and Traditional Chinese are dropped like the older languages'.
    #[test]
    fn boilerplate_of_the_added_languages_is_dropped() {
        let phrases = [
            // Portuguese
            "Ver no navegador", "Ver este e-mail no navegador", "Visualizar no navegador", "Ver versão online", "Clique aqui", "Cancelar inscrição", "Descadastrar",
            // Italian
            "Visualizza nel browser", "Visualizza questa email nel browser", "Vedi nel browser", "Problemi di visualizzazione", "Clicca qui", "Annulla l'iscrizione", "Disiscriviti",
            // Dutch
            "Bekijk in browser", "Bekijk deze e-mail in je browser", "Bekijk online", "Bekijk de webversie", "Klik hier", "Uitschrijven", "Afmelden",
            // Polish
            "Zobacz w przeglądarce", "Wyświetl wiadomość w przeglądarce", "Otwórz w przeglądarce", "Jeśli nie widzisz tej wiadomości", "Kliknij tutaj", "Wypisz się",
            // Turkish
            "Tarayıcıda görüntüle", "Bu e-postayı tarayıcıda görüntüle", "Tarayıcınızda görüntüleyin", "Buraya tıklayın", "Abonelikten çık",
            // Korean
            "브라우저에서 보기", "웹 브라우저에서 보기", "웹페이지로 보기", "메일이 정상적으로 보이지 않는 경우", "여기를 클릭", "수신거부", "구독 취소",
            // Indonesian
            "Lihat di browser", "Lihat email ini di browser", "Lihat versi web", "Klik di sini", "Berhenti berlangganan",
            // Traditional Chinese
            "在瀏覽器中查看", "在瀏覽器中檢視", "無法查看此郵件", "點擊這裡", "取消訂閱", "退訂",
        ];
        for p in phrases {
            let md = format!("[{p}](https://t.example/x?id=1)\nReal words here");
            assert_eq!(preview_text(&md), "Real words here", "link {p:?}");
            let line = format!("{p} https://t.example/x?id=1\nReal words here");
            assert_eq!(preview_text(&line), "Real words here", "line {p:?}");
            assert_eq!(preview_text(&format!("{}\nReal words here", p.to_uppercase())), "Real words here", "upper {p:?}");
            assert_eq!(preview_text(&md.replace("\nReal words here", "")), "", "alone {p:?}");
            // decomposed (NFD) text finds the same phrase, and the real words after it keep their bytes
            assert_eq!(preview_text(&nfd(&line)), "Real words here", "NFD line {p:?}");
            assert_eq!(preview_text(&nfd(&md.replace("Real words here", "Thư thật"))), nfd("Thư thật"), "NFD link {p:?}");
        }
        // the lead-in in front of the real content, on one line (what the notification shows)
        assert_eq!(preview_text("Ver este e-mail no navegador | Promoção de verão começa hoje"), "Promoção de verão começa hoje");
        assert_eq!(preview_text("브라우저에서 보기 여름 세일 시작"), "여름 세일 시작");
        assert_eq!(preview_text("在瀏覽器中查看 全場五折，僅限今天"), "全場五折，僅限今天");
        assert_eq!(preview_text("Tarayıcıda görüntüle | Yaz indirimi başladı"), "Yaz indirimi başladı");
        // real content that only starts like a phrase is content
        assert_eq!(preview_text("Ver novidades da semana"), "Ver novidades da semana");
        assert_eq!(preview_text("Klik hier om je account te bevestigen voor vrijdag"), "Klik hier om je account te bevestigen voor vrijdag");
        assert_eq!(preview_text("Afmelden voor de training kan tot vrijdag"), "Afmelden voor de training kan tot vrijdag");
    }

    /// fix56: the unsubscribe wordings the language review added (vi, zh, ja, fr, es, de, ru) are dropped when they are all there is, accents and decomposed text do not matter,
    /// and the order / account / log-out wordings next to them stay content.
    #[test]
    fn unsubscribe_wordings_of_the_review_are_dropped_and_order_wordings_stay() {
        let phrases = [
            // Vietnamese
            "Hủy đăng kí", "Bỏ đăng kí", "Hủy nhận thư", "Ngừng nhận thư", "Hủy theo dõi", "Từ chối nhận tin", "Huy nhan tin", "ngung nhan email",
            // Simplified Chinese
            "停止接收", "取消接收", "退订此邮件", "取消关注", "不再接收",
            // Japanese
            "メルマガ解除", "配信を停止", "配信中止", "受信停止", "メール配信を停止", "配信停止はこちら",
            // French
            "Désabonnez-vous", "Ne plus recevoir", "Annuler l’abonnement", "Annuler mon abonnement", "Se retirer de la liste", "Desabonnez-vous", "Desinscrivez-vous", "Gérer mes abonnements",
            // Spanish
            "Cancela tu suscripción", "Cancelar tu suscripción", "Anular la suscripción", "Darte de baja", "Dar de baja", "Date de baja", "Cancelar suscripcion", "Desuscribirse",
            // German
            "Abmeldung", "Abo kündigen", "Abo beenden", "Keine weiteren E-Mails", "Nicht mehr erhalten", "Abo kuendigen", "abo kundigen", "Austragen",
            // Russian
            "Отпишитесь", "Отписка", "Отказаться от подписки", "Отменить подписку", "Отмена подписки", "Больше не получать", "Прекратить рассылку",
        ];
        for p in phrases {
            for t in [p.to_string(), nfd(p)] {
                let md = format!("[{t}](https://t.example/x?id=1)
Real words here");
                assert_eq!(preview_text(&md), "Real words here", "link {t:?}");
                assert_eq!(preview_text(&format!("{t} https://t.example/x?id=1
Real words here")), "Real words here", "line {t:?}");
                assert_eq!(preview_text(&md.replace("
Real words here", "")), "", "alone {t:?}");
            }
        }
        // order, account, travel and log-out lines are content, in every language
        for text in [
            "Hủy nhận hàng tại cửa hàng", "Ngừng nhận đơn mới từ hôm nay", "取消订单后款项将退回", "退订房间需提前三天", "キャンセルは前日までにお願いします", "退会手続きのご案内",
            "Annuler la commande avant vendredi", "Annuler la réservation de ce soir", "Cancelar el pedido antes del viernes", "Cancelar reserva de hotel",
            "Von allen Geräten abmelden und neu anmelden", "Sitzung abmelden nach 10 Minuten", "Отменить заказ можно до пятницы", "Отмена заказа в течение часа",
        ] {
            for t in [text.to_string(), nfd(text)] {
                assert_eq!(preview_text(&t), t, "{t:?}");
            }
        }
    }

    /// fix56: the folding that both the snippet phrases and the unsubscribe words use, in one place.
    #[test]
    fn fold_for_match_folds_accents_decomposed_text_case_and_a_few_letters() {
        assert_eq!(fold_for_match("Hủy đăng ký"), "huy dang ky");
        assert_eq!(fold_for_match(&nfd("HỦY ĐĂNG KÝ")), "huy dang ky");
        assert_eq!(fold_for_match("Désabonnez-vous"), "desabonnez-vous");
        assert_eq!(fold_for_match("Cancelar suscripción"), "cancelar suscripcion");
        assert_eq!(fold_for_match("Abo kündigen"), "abo kundigen");
        assert_eq!(fold_for_match("Annuler l’abonnement"), "annuler l'abonnement");
        assert_eq!(fold_for_match("ЕЩЁ Ёлка"), "еще елка");
        assert_eq!(fold_for_match("İSTANBUL ılık"), "istanbul ilik");
        // other scripts are left as they are (a voiced kana mark is part of the letter), plain ASCII is just lower-cased
        assert_eq!(fold_for_match("メルマガ解除"), "メルマガ解除");
        assert_eq!(fold_for_match(&nfd("メルマガ解除")), "メルマガ解除");
        assert_eq!(fold_for_match("Отписаться Й"), "отписаться й");
        assert_eq!(fold_for_match("Hello World"), "hello world");
        assert_eq!(fold_for_match("取消订阅"), "取消订阅");
    }

    /// W6.13: Vietnamese typed with combining marks (NFD) and precomposed (NFC) are the same phrase; the shown text keeps its bytes when it is not boilerplate.
    #[test]
    fn nfd_vietnamese_phrases_are_found_and_the_shown_text_keeps_its_bytes() {
        let nfc_phrases = [
            "Xem thư này trên trình duyệt", "Xem trong trình duyệt", "Xem email trên trình duyệt", "Xem phiên bản web", "Mở trong trình duyệt", "Không xem được email?", "Nhấn vào đây",
            "Hủy đăng ký", "Huỷ đăng ký", "Chính sách bảo mật", "Xem bản trực tuyến",
        ];
        for p in nfc_phrases {
            let d = nfd(p);
            assert_ne!(d, p, "the fixture is really decomposed: {p:?}");
            for (name, text) in [("nfc", p.to_string()), ("nfd", d.clone())] {
                assert_eq!(preview_text(&format!("{text}\nSố lượng có hạn")), "Số lượng có hạn", "{name} line {p:?}");
                // (a "view" phrase leads a line of content; "click here" / "unsubscribe" ones are only dropped when they are all there is)
                let view = !["Nhấn vào đây", "Hủy đăng ký", "Huỷ đăng ký", "Chính sách bảo mật"].contains(&p);
                if view {
                    assert_eq!(preview_text(&format!("{text} | Ưu đãi lớn")), "Ưu đãi lớn", "{name} lead-in {p:?}");
                }
                assert_eq!(preview_text(&format!("[{text}](https://t.example/x)")), "", "{name} link alone {p:?}");
                assert_eq!(preview_text(&format!("{}\nSố lượng có hạn", text.to_uppercase())), "Số lượng có hạn", "{name} upper {p:?}");
            }
            // what follows is shown as it came (NFD stays NFD), what is not boilerplate is not touched
            let rest = nfd("Ưu đãi lớn cho khách hàng");
            if !["Nhấn vào đây", "Hủy đăng ký", "Huỷ đăng ký", "Chính sách bảo mật"].contains(&p) {
                assert_eq!(preview_text(&format!("{d} {rest}")), rest, "bytes of the rest, {p:?}");
            }
        }
        let real = nfd("Xem lại hóa đơn tháng này trước thứ sáu");
        assert_eq!(preview_text(&real), real, "NFD content that only starts like a phrase keeps its bytes");
        let real = nfd("Hủy đăng ký học phần trước ngày 30");
        assert_eq!(preview_text(&real), real);
        // a link whose text is the NFD phrase, the notification and the stored snippet
        assert_eq!(make(None, Some(&format!("<a href=\"https://v.example\">{}</a> Summer sale", nfd("Xem thư này trên trình duyệt")))), "Summer sale");
        assert_eq!(notification_preview(&nfd("Xem thư này trên trình duyệt | Ưu đãi iPhone")), nfd("Ưu đãi iPhone"));
        // Hangul as jamo (NFD) is found too
        assert_eq!(preview_text(&nfd("브라우저에서 보기 여름 세일")), nfd("여름 세일"));
        // Turkish capital I / dotted İ
        assert_eq!(preview_text("TARAYICIDA GÖRÜNTÜLE\nİndirim başladı"), "İndirim başladı");
    }

    /// W6.13: normalisation changes nothing about what is not boilerplate, whatever the input (the same loop as the fuzz test, with decomposed input).
    #[test]
    fn nfd_input_never_panics_and_plain_text_is_unchanged() {
        let mut seed = 0xD1B5_4A32_D192_ED03u64;
        for i in 0..8_000 {
            let s = nfd(&fuzz_string(&mut seed));
            let p = preview_text(&s);
            assert!(!p.contains(['\n', '\r']), "iteration {i}: {s:?}");
            let _ = notification_preview(&s);
            let _ = make(Some(&s), None);
        }
        for text in ["Hello world, this is a plain message", "Chào bạn, đây là thư thường", "안녕하세요 여러분", "Merhaba arkadaşlar, toplantı yarın"] {
            for t in [text.to_string(), nfd(text)] {
                assert_eq!(preview_text(&t), t, "{t:?}");
            }
        }
    }

    #[test]
    fn bare_addresses_tracking_tokens_and_markup_are_removed() {
        for (raw, want) in [
            ("Hello https://a.example/x?y=1&z=2 world", "Hello world"),
            ("Hello (https://a.example/x) world", "Hello world"),
            ("Visit <https://a.example/x?y=1> today", "Visit today"),
            ("Mail <mailto:a@b.example> today", "Mail today"),
            ("Go to HTTP://A.EXAMPLE/X now, ftp://f.example/file or www.example.com/page.", "now, or"),
            ("see:https://a.example/x done", "see: done"),
            ("Track at ecafgcd.r.af.d.sendibt2.com/tr/mr/Tri_95Hx3VW now", "Track now"),
            ("Token Tri_95Hx3VWzJfQSa7ggBekbb0Elk9qsx0y6UH1lWEQ8lP4o2bJ6 end", "Token end"),
            ("Path /a/b/c/d/e/f/g/h/i/j/k/l/m/n/o?x=1&y=2 end", "Path end"),
            ("tel:+84901234567 or mailto:x@y.example", "or"),
            // entities and invisible characters
            ("Tom &amp; Jerry&nbsp;&mdash; caf&eacute; &#8217;s &#x1F525;", "Tom & Jerry \u{2014} caf&eacute; \u{2019}s \u{1F525}"),
            ("Pad\u{200B}ded\u{200C}\u{00A0}\u{034F}\u{FEFF}\u{00AD} te\u{2060}xt", "Padded text"),
            // rules and runs of separators
            ("Offer ----------\n__________\n=========\n* * * * *\n\u{2500}\u{2500}\u{2500}\u{2500} ends", "Offer ends"),
            ("Wait... what?! 1 - 2 = 3 / 4 -- done", "Wait... what?! 1 - 2 = 3 / 4 -- done"),
            // white space
            ("  many \t spaces \r\n\r\n\r\n and \u{2028} lines  ", "many spaces and lines"),
        ] {
            assert_eq!(preview_text(raw), want, "{raw:?}");
        }
        // only addresses and markup: nothing
        for raw in [
            "https://a.example/x?y=1",
            "https://a.example/x?y=1 https://b.example/z\nwww.c.example",
            "<https://a.example/x>\n<https://b.example/y>",
            "[1]: https://a.example\n[2]: https://b.example",
            "![](https://a.example/p.png)",
            "---------- ========== __________",
            "Tri_95Hx3VWzJfQSa7ggBekbb0Elk9qsx0y6UH1lWEQ8lP4o2bJ6sXAn1ZcR7u",
            "&nbsp;&zwnj;&nbsp;&zwnj;",
        ] {
            assert_eq!(preview_text(raw), "", "{raw:?}");
            assert_eq!(notification_preview(raw), "", "{raw:?}");
            assert_eq!(make(Some(raw), None), "", "{raw:?}");
        }
        // an address that is part of the words of a person is dropped, the words stay
        assert_eq!(preview_text("Reply to me at nam@example.com about https://x.example/p"), "Reply to me at nam@example.com about");
    }

    #[test]
    fn normal_mail_is_not_changed() {
        for s in [
            "Hi Nam, can we meet at 10:30 tomorrow? Bring the Q3 report (draft) \u{2014} thanks!",
            "Your order #12345 shipped! It should arrive by Friday, Oct. 16.",
            "Meeting notes: 1) budget 2) hiring 3) roadmap; see you at 3 p.m.",
            "C++ and .NET developers: 50% off, e.g. $99 -> $49 (until 5/12/2026).",
            "Re: invoice [INV-2026-0042] is attached, total 1,250.00 EUR",
            "-5 degrees tonight, bring a coat",
            "Wait... really?!? Yes!!! OK.",
        ] {
            assert_eq!(preview_text(s), s, "{s:?}");
            assert_eq!(notification_preview(s), s, "{s:?}");
            assert_eq!(make(Some(s), None), s, "{s:?}");
        }
    }

    #[test]
    fn letters_of_every_script_and_emoji_survive_and_diacritics_keep_their_form() {
        let samples = [
            "Xin chào Nguyễn Văn Ánh, ưu đãi đặc biệt hôm nay",
            "こんにちは、世界。今日のお知らせです",
            "你好，世界。今天的特别优惠",
            "Привет, мир! Сегодня специальное предложение",
            "مرحبا بالعالم، عرض خاص اليوم",
            "שלום עולם, מבצע מיוחד",
            "안녕하세요, 오늘의 특별 할인",
            "Grüße aus Köln: Straße, Fußball, Übung",
            "\u{1F525} Mở \u{2764}\u{FE0F} \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467} \u{1F1FB}\u{1F1F3} 1\u{FE0F}\u{20E3} \u{1F44D}\u{1F3FD}",
        ];
        for s in samples {
            assert_eq!(preview_text(s), s, "{s:?}");
            assert_eq!(clean_text(s), s, "{s:?}");
        }
        // precomposed (NFC) and decomposed (NFD) Vietnamese are both kept exactly as they came
        let nfc = "Nguy\u{1EC5}n V\u{0103}n \u{00C1}nh \u{0111}\u{1EB7}t c\u{1ECD}c";
        let nfd = "Nguye\u{0302}\u{0303}n Va\u{0306}n A\u{0301}nh \u{0111}a\u{0323}\u{0306}t co\u{0323}c";
        assert_eq!(preview_text(nfc), nfc);
        assert_eq!(preview_text(nfd), nfd);
        assert_eq!(notification_preview(nfc), nfc);
        assert_eq!(notification_preview(nfd), nfd);
        assert_eq!(notification_line(nfc), nfc);
        assert_eq!(notification_line(nfd), nfd);
        // a joiner outside an emoji sequence is padding, inside one it is the picture
        assert_eq!(clean_text("a\u{200D}b \u{200D}c"), "ab c");
        assert_eq!(clean_text("\u{1F468}\u{200D}\u{1F469}"), "\u{1F468}\u{200D}\u{1F469}");
        assert_eq!(clean_text("\u{1F468}\u{200D} x"), "\u{1F468} x");
    }

    #[test]
    fn the_notification_preview_is_cut_on_a_word_and_never_inside_a_cluster() {
        use unicode_segmentation::UnicodeSegmentation;
        let words: Vec<String> = (0..60).map(|i| format!("word{i}")).collect();
        let long = words.join(" ");
        let p = notification_preview(&long);
        assert!(p.ends_with('\u{2026}') && graphemes(&p) <= NOTIFY_PREVIEW_MAX && graphemes(&p) > NOTIFY_PREVIEW_MAX - 12, "{p:?}");
        let body = p.trim_end_matches('\u{2026}');
        assert!(long.starts_with(body) && long[body.len()..].starts_with(' '), "cut on a word: {p:?}");
        assert!(!body.ends_with(' '));
        // exactly 100 stays whole, 101 is cut
        assert_eq!(truncate_display(&"a".repeat(100), 100), "a".repeat(100));
        assert_eq!(graphemes(&truncate_display(&"a".repeat(101), 100)), 100);
        // text without spaces (Chinese, Japanese) is cut on a character
        let zh = "你好世界".repeat(60);
        let p = notification_preview(&zh);
        assert_eq!(graphemes(&p), NOTIFY_PREVIEW_MAX);
        assert!(p.ends_with('\u{2026}') && zh.starts_with(p.trim_end_matches('\u{2026}')));
        // emoji sequences: every cut position of a text full of families, flags, keycaps, skin tones and accents
        let unit = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}\u{1F1FB}\u{1F1F3}1\u{FE0F}\u{20E3}\u{1F44D}\u{1F3FD}e\u{0301}\u{0323}\u{2764}\u{FE0F}";
        let text = unit.repeat(40);
        let all: Vec<&str> = text.graphemes(true).collect();
        for max in 2..=60 {
            let cut = truncate_display(&text, max);
            assert!(graphemes(&cut) <= max, "max {max}: {}", graphemes(&cut));
            let body = cut.trim_end_matches('\u{2026}');
            assert!(text.starts_with(body), "max {max}");
            // every cluster of the result is a cluster of the original: nothing was split
            for (i, g) in body.graphemes(true).enumerate() {
                assert_eq!(g, all[i], "max {max} cluster {i}");
            }
            assert!(!body.ends_with('\u{200D}'), "max {max}");
        }
        let p = notification_preview(&text);
        assert!(graphemes(&p) <= NOTIFY_PREVIEW_MAX);
        // the stored snippet limit (200 characters) does not split a sequence either
        let t = truncate_words(&format!("{}{}", "a".repeat(SNIPPET_MAX - 1), "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}"));
        assert_eq!(t, "a".repeat(SNIPPET_MAX - 1));
        let t = truncate_words(&format!("{}{}", "a".repeat(SNIPPET_MAX - 1), "e\u{0301}\u{0323}tail"));
        assert!(t.chars().count() <= SNIPPET_MAX && !t.ends_with('e'), "{t:?}");
        // very long text and a single huge word
        let huge = "lorem ipsum ".repeat(50_000);
        let p = notification_preview(&huge);
        assert!(graphemes(&p) <= NOTIFY_PREVIEW_MAX && p.ends_with('\u{2026}'));
        assert!(graphemes(&notification_preview(&"x".repeat(100_000))) <= NOTIFY_PREVIEW_MAX);
        let _ = preview_text(&"[".repeat(100_000));
        assert!(preview_text(&"<a ".repeat(100_000)).len() <= PREVIEW_SOURCE_MAX);
        assert!(preview_text(&"[a](".repeat(50_000)).len() < 100_000);
    }

    #[test]
    fn too_little_readable_text_means_no_preview_line() {
        for s in ["", " ", "OK", "Hi!", "\u{1F525}\u{1F525}\u{1F525}", "12345 67890", "-- -- --", "[View in browser](https://x.example)", "Yes \u{1F44D}", "a b c d e"] {
            assert_eq!(notification_preview(s), "", "{s:?}");
        }
        for s in ["Thanks a lot", "Meeting moved", "お知らせです", "Cảm ơn bạn", "好的，谢谢你"] {
            assert_eq!(notification_preview(s), s, "{s:?}");
        }
        // three Han / kana characters are enough (they are whole words), two are not
        assert_eq!(notification_preview("お知らせ"), "お知らせ");
        assert_eq!(notification_preview("好的"), "");
    }

    #[test]
    fn notification_lines_are_cleaned_without_changing_real_subjects() {
        for s in ["\u{1F525} Mở Đặt Cọc iPhone Duo", "Re: Q3 report (final) - v2", "Fwd: [External] Invoice #42", "Grüße aus Köln", "お知らせ", "Привет!", "مرحبا", "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467} family trip", "RLM mark \u{200F}text"] {
            assert_eq!(notification_line(s), s, "{s:?}");
        }
        assert_eq!(notification_line("  Hello \t\r\n  world\u{0007}\u{0000} !\u{200B}\u{FEFF}\u{00AD} "), "Hello world !");
        assert_eq!(notification_line("\u{202E}evil\u{202C}"), "evil");
        assert_eq!(notification_line(" \r\n\t "), "");
        let long = "word ".repeat(500);
        let l = notification_line(&long);
        assert!(graphemes(&l) <= NOTIFY_LINE_MAX && l.ends_with('\u{2026}'));
    }

    #[test]
    fn cleaning_twice_changes_nothing_more() {
        for s in [F27_TEXT, F27_OLD_SNIPPET, "Click [here](https://x.example) now [1] https://y.example ---- done", "Xem trong trình duyệt | Ưu đãi lớn"] {
            let once = preview_text(s);
            assert_eq!(preview_text(&once), once, "{s:?}");
            let n = notification_preview(s);
            assert_eq!(notification_preview(&n), n, "{s:?}");
        }
    }

    /// A small deterministic random generator (the tests must not depend on the rand crate's API).
    fn next(seed: &mut u64) -> u64 {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 7;
        *seed ^= *seed << 17;
        *seed
    }

    fn fuzz_string(seed: &mut u64) -> String {
        const PIECES: &[&str] = &[
            "[", "]", "(", ")", "![", "](", "<", ">", "&", "&#x", "&#", "&amp;", "&nbsp;", ";", "http://", "https://a.b/c?d=e", "www.", "mailto:", "://", "\u{200D}", "\u{FE0F}",
            "\u{20E3}", "\u{1F468}", "\u{1F1FB}", "\u{1F1F3}", "\u{1F3FD}", "\u{E0067}", "é", "e\u{0301}", "\u{0323}", "\n", "\r\n", "\u{2028}", " ", "\t", "-----", "_____", "....", "* * *",
            "Click here", "View in browser", "Having trouble viewing", "xem trong trình duyệt", "日本語", "مرحبا", "\u{0}", "\u{FFFF}", "\u{10FFFF}", "[1]", "[1]:", "[^1]",
            "Tri_95Hx3VWzJfQSa7ggBekbb0Elk9qsx0y6UH1lWEQ8lP4o2bJ6sXAn1ZcR7u", "a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p?q=1&r=2", "ß", "İ", "ǅ", "!", "…", "«", "»", "'", "\"",
        ];
        let mut s = String::new();
        for _ in 0..next(seed) % 60 {
            if next(seed) % 4 == 0 {
                // any character of the Unicode range (surrogates are not characters, they are skipped)
                if let Some(c) = char::from_u32((next(seed) % 0x11_0000) as u32) {
                    s.push(c);
                }
            } else {
                s.push_str(PIECES[(next(seed) % PIECES.len() as u64) as usize]);
            }
        }
        s
    }

    #[test]
    fn cleaning_never_panics_on_any_text() {
        let mut seed = 0x9E37_79B9_7F4A_7C15u64;
        for i in 0..30_000 {
            let s = fuzz_string(&mut seed);
            let p = preview_text(&s);
            assert!(!p.contains(['\n', '\r']), "iteration {i}: {s:?}");
            assert!(!p.starts_with(' ') && !p.ends_with(' '), "iteration {i}: {p:?}");
            let n = notification_preview(&s);
            assert!(graphemes(&n) <= NOTIFY_PREVIEW_MAX, "iteration {i}: {s:?}");
            let m = make(Some(&s), Some(&s));
            assert!(m.chars().count() <= SNIPPET_MAX, "iteration {i}");
            let l = notification_line(&s);
            assert!(graphemes(&l) <= NOTIFY_LINE_MAX, "iteration {i}");
            let _ = truncate_display(&s, (i % 40) + 1);
            let _ = truncate_words(&s);
            let _ = clean_text(&s);
            let _ = html_text(&s);
        }
        // the same inside one long text, and every prefix of a text full of markup
        let mut big = String::new();
        for _ in 0..200 {
            big.push_str(&fuzz_string(&mut seed));
            big.push(' ');
        }
        let _ = preview_text(&big);
        let _ = notification_preview(&big);
        let sample = "[View in browser](https://a.b/c) <https://d.e> ![x](y) \u{1F468}\u{200D}\u{1F469} &#x1F525; Xin chào";
        for (i, _) in sample.char_indices().chain(std::iter::once((sample.len(), ' '))) {
            let _ = preview_text(&sample[..i]);
            let _ = notification_preview(&sample[..i]);
        }
    }

    #[test]
    fn stored_snippets_with_link_markup_are_cleaned_once_and_search_text_is_untouched() {
        let c = db();
        let raw = F27_TEXT;
        put(&c, "f27", F27_OLD_SNIPPET, None, Some(raw));
        put(&c, "html", "[View in browser](https://v.example/t?u=1", Some("<a href=\"https://v.example/t\">View in browser</a><p>Summer sale words</p>"), None);
        put(&c, "mid", "Visit https://a.example/x?y=1 for details about the new plan", None, Some("Visit https://a.example/x?y=1 for details about the new plan"));
        put(&c, "plain", "Hello there", None, Some("Hello there"));
        put(&c, "bracket", "[External] Please review the attached file today", None, Some("[External] Please review the attached file today"));
        put(&c, "nobody", "[View in browser](https://v.example/t?u=1", None, None);
        for i in 0..450 {
            put(&c, &format!("bulk{i}"), &format!("Bulk {i} see https://a.example/{i} for the details of this message"), None, None);
        }
        c.execute("DELETE FROM settings WHERE key=?1", [LINKS_FIXED_KEY]).unwrap();
        let n = fix_stored_links(&c).unwrap();
        assert_eq!(n, 3 + 450, "f27, html, mid and the bulk rows");
        assert_eq!(snippet_of(&c, "f27"), "\u{1F525} Mở Đặt Cọc iPhone Duo Ưu đãi lớn cho khách hàng thân thiết, số lượng có hạn.");
        assert_eq!(snippet_of(&c, "html"), "Summer sale words");
        assert_eq!(snippet_of(&c, "mid"), "for details about the new plan");
        assert_eq!(snippet_of(&c, "plain"), "Hello there");
        assert_eq!(snippet_of(&c, "bracket"), "[External] Please review the attached file today");
        assert_eq!(snippet_of(&c, "nobody"), "[View in browser](https://v.example/t?u=1", "nothing readable and no body: untouched");
        assert_eq!(snippet_of(&c, "bulk449"), "Bulk 449 for the details of this message");
        // the stored body is the search text: untouched, so every word and the address are still found
        let body: String = c.query_row("SELECT body_text FROM messages WHERE id='f27'", [], |r| r.get(0)).unwrap();
        assert_eq!(body, raw);
        let hits = |q: &str| -> i64 { c.query_row("SELECT COUNT(*) FROM messages WHERE body_text LIKE ?1 OR snippet LIKE ?1", [format!("%{q}%")], |r| r.get(0)).unwrap() };
        assert_eq!(hits("sendibt2"), 1);
        assert_eq!(hits("khách hàng thân thiết"), 1);
        assert_eq!(hits("a.example/x?y=1"), 1);
        // done once, and a second run without the flag changes nothing
        assert_eq!(fix_stored_links(&c).unwrap(), 0);
        c.execute("DELETE FROM settings WHERE key=?1", [LINKS_FIXED_KEY]).unwrap();
        assert_eq!(fix_stored_links(&c).unwrap(), 0, "idempotent");
    }

    #[test]
    fn stored_snippets_with_picture_markers_are_cleaned_once_and_the_body_is_untouched() {
        let c = db();
        put(&c, "g", "[image: Google] You allowed Claude for Google Drive access to some of your Google Account data", None, Some("[image: Google]
You allowed Claude for Google Drive access to some of your Google Account data"));
        put(&c, "cid", "[cid:logo.png@01D9A1B2]", None, Some("[cid:logo.png@01D9A1B2]
Invoice 42 is ready for you"));
        put(&c, "plain", "Hello there", None, Some("Hello there"));
        put(&c, "word", "The [image 2 of 5] slider shows the album", None, None);
        put(&c, "only", "[image: Google]", None, None);
        c.execute("DELETE FROM settings WHERE key=?1", [MARKERS_FIXED_KEY]).unwrap();
        assert_eq!(fix_stored_markers(&c).unwrap(), 2, "the two rows with a marker and words");
        assert_eq!(snippet_of(&c, "g"), "You allowed Claude for Google Drive access to some of your Google Account data");
        assert_eq!(snippet_of(&c, "cid"), "Invoice 42 is ready for you", "left empty: made again from the stored text");
        assert_eq!(snippet_of(&c, "plain"), "Hello there");
        assert_eq!(snippet_of(&c, "word"), "The [image 2 of 5] slider shows the album");
        assert_eq!(snippet_of(&c, "only"), "[image: Google]", "nothing readable and no body: untouched");
        let body: String = c.query_row("SELECT body_text FROM messages WHERE id='g'", [], |r| r.get(0)).unwrap();
        assert!(body.starts_with("[image: Google]"), "the stored body keeps the marker (search text)");
        assert_eq!(fix_stored_markers(&c).unwrap(), 0, "done once");
    }

    #[test]
    fn the_word_that_pointed_at_a_removed_address_goes_with_it() {
        let g = "You allowed Claude for Google Drive access to some of your Google Account data. Review your connected apps at https://myaccount.google.com/connections?utm_source=alert for details.";
        assert_eq!(preview_text(g), "You allowed Claude for Google Drive access to some of your Google Account data. Review your connected apps for details.");
        assert!(notification_preview(g).starts_with("You allowed Claude for Google Drive access"), "{}", notification_preview(g));
        for (raw, want) in [
            ("Open the app, go to https://a.example/x and sign in", "Open the app, and sign in"),
            ("Visit https://a.example/x today", "today"),
            ("See here https://a.example/x now", "See here now"),
            ("See: https://a.example/x , thanks", "thanks"),
            ("Your invoice is ready, see https://a.example/i/42.", "Your invoice is ready"),
            ("Mehr Infos unter https://a.example/x lesen Sie hier", "Mehr Infos lesen Sie hier"),
            ("Consulte su pedido en https://a.example/x hoy", "Consulte su pedido hoy"),
            ("Détails sur https://a.example/x ici", "Détails ici"),
            ("Xem chi tiết tại https://a.example/x ngay", "Xem chi tiết ngay"),
            ("Подробности на https://a.example/x здесь", "Подробности здесь"),
            ("Truy cập https://a.example/x để xem", "để xem"),
        ] {
            assert_eq!(preview_text(raw), want, "{raw}");
        }
        // no address removed: nothing is dropped, whatever the words are
        for same in [
            "Meet me at noon on Monday to talk, see you there",
            "The meeting is at 10 and we open the doors on time",
            "Ưu đãi lớn cho khách hàng thân thiết tại cửa hàng của chúng tôi",
            "Подробности на сайте магазина по телефону",
            "ご注文を発送しました。詳細はこちらをご覧ください",
            "您的订单已发货，请在应用中查看详情",
        ] {
            assert_eq!(preview_text(same), same, "{same}");
        }
        // an address that is the whole sentence leaves nothing; a pointer word that is not before an address stays
        assert_eq!(preview_text("at https://a.example/x"), "");
        assert_eq!(preview_text("Look at the https://a.example/x link and come back at five"), "Look at the link and come back at five");
    }
}
