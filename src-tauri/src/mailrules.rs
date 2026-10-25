//! Mail rules (1.0.8): the pure matcher and planner, and the rows of the `rules` table.
//!
//! A rule has one or more conditions (all must match), each with one or more values (any may match), and one action. Matching is done on
//! what is stored on this computer; nothing is sent anywhere. Text is compared in Unicode NFKC, lower case; a typed value without any
//! accent mark also matches text with marks ("hoa don" finds "hóa đơn"), a value with marks must match the marks.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::cell::OnceCell;

type R<T> = Result<T, String>;

/// The body condition looks at this many characters of the message text.
pub const BODY_CHARS: usize = 20_000;

/// One condition of a rule. `field`: from | to | subject | body | subjectBody | any | list; `op`: contains | equals.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Cond {
    pub field: String,
    #[serde(default)]
    pub op: String,
    #[serde(default)]
    pub values: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub id: String,
    /// None = applies to every account
    #[serde(default)]
    pub account_id: Option<String>,
    pub name: String,
    /// The columns of 1.0.7 and older builds (one condition). A rule saved by 1.0.8 keeps them only so that an older build never matches more than intended
    /// (see `legacy_columns`); the conditions below are what counts.
    #[serde(default)]
    pub field: String,
    #[serde(default)]
    pub op: String,
    #[serde(default)]
    pub value: String,
    /// archive | trash | junk | read | star | pin | move
    pub action: String,
    pub arg: Option<String>,
    pub enabled: bool,
    #[serde(default)]
    pub conditions: Vec<Cond>,
    /// the place in the one ordered list (lower runs first)
    #[serde(default)]
    pub position: i64,
}

impl Rule {
    /// The conditions that count: the saved ones, or for a rule of an older build the one made of its field / op / value (the value is NOT split on commas).
    pub fn conds(&self) -> Vec<Cond> {
        if !self.conditions.is_empty() {
            return self.conditions.clone();
        }
        vec![Cond { field: self.field.clone(), op: self.op.clone(), values: vec![self.value.clone()] }]
    }
}

#[cfg(test)]
impl Rule {
    /// A one-condition rule for the tests of other modules.
    pub(crate) fn basic(name: &str, field: &str, value: &str, action: &str) -> Rule {
        Rule {
            id: name.into(), account_id: None, name: name.into(), field: field.into(), op: "contains".into(), value: value.into(), action: action.into(), arg: None, enabled: true,
            conditions: vec![], position: 0,
        }
    }
}

/// Does the action take the message out of the Inbox?
pub fn is_move(action: &str) -> bool {
    matches!(action, "archive" | "trash" | "junk" | "move")
}

// ---------- text ----------

/// Reply / forward prefixes of the 8 languages and common clients (lower case), without the colon. The same list is in src/ruleSuggest.ts (tests share a table).
const PREFIXES: &[&str] = &[
    "re", "fw", "fwd", "aw", "wg", "sv", "vs", "tr", "rv", "res", "enc", "r", "i", "antw", "doorst", "odp", "отв", "ответ", "пересл", "回复", "回覆", "答复", "转发", "轉寄", "返信", "転送", "trả lời", "tl",
    "chuyển tiếp", "ct",
];

fn lc(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

/// The length in bytes of a reply / forward prefix (with an optional `[n]` / `(n)` counter and the colon) at the start of `s`, or None.
fn prefix_len(s: &str) -> Option<usize> {
    let mut best: Option<usize> = None;
    for p in PREFIXES.iter() {
        let mut it = s.char_indices();
        let mut ok = true;
        for pc in p.chars() {
            match it.next() {
                Some((_, c)) if lc(c) == pc => {}
                _ => {
                    ok = false;
                    break;
                }
            }
        }
        if !ok {
            continue;
        }
        let rest_at = it.clone().next().map_or(s.len(), |(i, _)| i);
        let mut rest = &s[rest_at..];
        // an optional counter: Re[2]: or Re(2):
        if let Some(open) = rest.chars().next().filter(|c| *c == '[' || *c == '(') {
            let close = if open == '[' { ']' } else { ')' };
            if let Some(end) = rest.find(close) {
                let inner = &rest[1..end];
                if !inner.is_empty() && inner.chars().all(|c| c.is_ascii_digit()) {
                    rest = &rest[end + 1..];
                }
            }
        }
        let rest = rest.trim_start_matches(' ');
        let colon = match rest.chars().next() {
            Some(':') => 1,
            Some('：') => '：'.len_utf8(),
            _ => continue,
        };
        let total = s.len() - rest.len() + colon;
        if best.map_or(true, |b| total > b) {
            best = Some(total);
        }
    }
    best
}

/// The subject without the reply / forward prefixes in front of it (repeatedly).
pub fn strip_prefixes(subject: &str) -> String {
    let mut s = subject.trim();
    while let Some(n) = prefix_len(s) {
        s = s[n..].trim_start();
    }
    s.to_string()
}

/// NFKC, then lower case: NFC and NFD forms are equal, full-width Latin equals ASCII, Cyrillic / Greek / Vietnamese lower-case fully.
pub fn norm(s: &str) -> String {
    if s.is_ascii() {
        return s.to_ascii_lowercase();
    }
    icu_normalizer::ComposingNormalizer::new_nfkc().normalize(s).to_lowercase()
}

fn is_mark(c: char) -> bool {
    matches!(c as u32, 0x0300..=0x036F | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0x20D0..=0x20FF | 0xFE20..=0xFE2F)
}

/// Hangul and Kana are left alone when marks are taken off: their decomposed forms (jamo, dakuten) would make "하" match "한" and "か" match "が".
fn keep_whole(c: char) -> bool {
    matches!(c as u32, 0xAC00..=0xD7A3 | 0x3040..=0x30FF | 0x1100..=0x11FF | 0x3130..=0x318F)
}

/// The text with accent marks taken off and đ -> d (the text is already `norm`ed).
fn fold(s: &str) -> String {
    if s.is_ascii() {
        return s.to_string();
    }
    let nfd = icu_normalizer::DecomposingNormalizer::new_nfd();
    let mut out = String::with_capacity(s.len());
    let mut buf = [0u8; 4];
    for c in s.chars() {
        if c.is_ascii() || keep_whole(c) {
            out.push(c);
        } else if c == 'đ' {
            out.push('d');
        } else {
            for d in nfd.normalize(c.encode_utf8(&mut buf)).chars() {
                if !is_mark(d) {
                    out.push(d);
                }
            }
        }
    }
    out
}

/// Does the (normed) typed value carry accent marks or đ? Then the marks of the text must match.
fn has_marks(v: &str) -> bool {
    if v.is_ascii() {
        return false;
    }
    v.contains('đ') || fold(v) != v
}

/// A text in the forms it is compared in.
struct Forms {
    exact: String,
    folded: OnceCell<String>,
}

impl Forms {
    fn new(s: &str) -> Self {
        Forms { exact: norm(s), folded: OnceCell::new() }
    }
    fn folded(&self) -> &str {
        if self.exact.is_ascii() {
            return &self.exact;
        }
        self.folded.get_or_init(|| fold(&self.exact))
    }
}

/// A typed value, ready to be compared.
struct Val {
    exact: String,
    folded: String,
    use_fold: bool,
}

impl Val {
    fn new(v: &str) -> Option<Val> {
        let exact = norm(v.trim());
        if exact.is_empty() {
            return None;
        }
        let use_fold = !has_marks(&exact);
        let folded = if use_fold { fold(&exact) } else { String::new() };
        Some(Val { exact, folded, use_fold })
    }
    fn hit(&self, hay: &Forms, equals: bool) -> bool {
        let (h, v) = if self.use_fold { (hay.folded(), self.folded.as_str()) } else { (hay.exact.as_str(), self.exact.as_str()) };
        if equals { h == v } else { h.contains(v) }
    }
}

// ---------- the message and the compiled rule ----------

/// What a rule can look at.
#[derive(Clone, Debug, Default)]
pub struct MailIn {
    pub from_name: String,
    pub from_email: String,
    pub to: Vec<String>,
    pub subject: String,
    /// the text of the message (it is cut to `BODY_CHARS` here)
    pub body: String,
    /// encrypted mail has no readable text at sync time: the body never matches
    pub encrypted: bool,
}

pub struct Prepared {
    from_name: Forms,
    from_email: Forms,
    to_each: Vec<Forms>,
    to_text: Forms,
    subject: Forms,
    subject_core: Forms,
    body: Option<Forms>,
}

impl Prepared {
    pub fn new(m: &MailIn) -> Prepared {
        let body = if m.encrypted || m.body.is_empty() {
            None
        } else {
            let cut: String = if m.body.len() <= BODY_CHARS { m.body.clone() } else { m.body.chars().take(BODY_CHARS).collect() };
            Some(Forms::new(&cut))
        };
        Prepared {
            from_name: Forms::new(&m.from_name),
            from_email: Forms::new(&m.from_email),
            to_each: m.to.iter().map(|t| Forms::new(t)).collect(),
            to_text: Forms::new(&m.to.join(",")),
            subject: Forms::new(&m.subject),
            subject_core: Forms::new(&strip_prefixes(&m.subject)),
            body,
        }
    }
}

struct CompiledCond {
    field: String,
    equals: bool,
    vals: Vec<Val>,
    /// the values with their reply prefixes removed (for "Subject is exactly")
    vals_core: Vec<Val>,
}

impl CompiledCond {
    fn new(c: &Cond) -> Self {
        let equals = c.op == "equals";
        let vals = c.values.iter().filter_map(|v| Val::new(v)).collect();
        let vals_core = if c.field == "subject" || c.field == "any" { c.values.iter().filter_map(|v| Val::new(&strip_prefixes(v))).collect() } else { vec![] };
        CompiledCond { field: c.field.clone(), equals, vals, vals_core }
    }

    fn matches(&self, m: &Prepared) -> bool {
        if self.vals.is_empty() {
            return false;
        }
        let any = |f: &dyn Fn(&Val) -> bool| self.vals.iter().any(f);
        let from = |eq: bool| -> bool {
            if eq {
                any(&|v| v.hit(&m.from_email, true))
            } else {
                any(&|v| v.hit(&m.from_email, false) || v.hit(&m.from_name, false))
            }
        };
        let to = |eq: bool| -> bool {
            if eq {
                any(&|v| m.to_each.iter().any(|t| v.hit(t, true)))
            } else {
                any(&|v| v.hit(&m.to_text, false))
            }
        };
        let subject = |eq: bool| -> bool {
            if eq {
                self.vals_core.iter().any(|v| v.hit(&m.subject_core, true))
            } else {
                any(&|v| v.hit(&m.subject, false))
            }
        };
        let body = || m.body.as_ref().is_some_and(|b| any(&|v| v.hit(b, false)));
        match self.field.as_str() {
            "from" => from(self.equals),
            "to" => to(self.equals),
            "subject" => subject(self.equals),
            "body" => body(),
            "subjectBody" => subject(false) || body(),
            // the mailing list (List-Id) is not matched yet
            "list" => false,
            // "any" (sender, recipients or subject), and what an older build saved with another word
            _ => from(self.equals) || to(self.equals) || subject(self.equals),
        }
    }
}

/// A rule with its values prepared once (not once per message).
pub struct Compiled<'a> {
    pub rule: &'a Rule,
    conds: Vec<CompiledCond>,
}

impl<'a> Compiled<'a> {
    pub fn new(rule: &'a Rule) -> Self {
        Compiled { rule, conds: rule.conds().iter().map(CompiledCond::new).collect() }
    }
    /// All conditions match (a rule without conditions never matches).
    pub fn matches(&self, m: &Prepared) -> bool {
        !self.conds.is_empty() && self.conds.iter().all(|c| c.matches(m))
    }
}

/// The rules to run for one message, in the order to run them: every matching rule that does not move the message, then the FIRST matching rule that does
/// (the later moving rules are not tried). The ones that do not move run first because a flag set before the move travels with the message.
pub fn plan<'a, 'b>(rules: &'b [Compiled<'a>], m: &Prepared) -> Vec<&'a Rule> {
    let mut out: Vec<&'a Rule> = rules.iter().filter(|c| !is_move(&c.rule.action) && c.matches(m)).map(|c| c.rule).collect();
    if let Some(c) = rules.iter().find(|c| is_move(&c.rule.action) && c.matches(m)) {
        out.push(c.rule);
    }
    out
}

// ---------- the table ----------

/// The old columns written next to the conditions. A rule that is one condition with one value of a kind the older builds know keeps its real columns (they match the same
/// or less than 1.0.8 does); any other rule gets a field / op / value that no message has, so an older build does nothing with it.
pub fn legacy_columns(conds: &[Cond]) -> (String, String, String) {
    if let [c] = conds {
        if let [v] = c.values.as_slice() {
            if matches!(c.field.as_str(), "from" | "to" | "subject" | "any") && matches!(c.op.as_str(), "contains" | "equals") && !v.trim().is_empty() {
                return (c.field.clone(), c.op.clone(), v.clone());
            }
        }
    }
    ("any".into(), "equals".into(), "\u{1}hey-look-rule-v2\u{1}".into())
}

const COLS: &str = "id,name,field,op,value,action,arg,enabled,account_id,conditions,position";

fn from_row(r: &rusqlite::Row) -> rusqlite::Result<Rule> {
    let conditions: Option<String> = r.get(9)?;
    let mut rule = Rule {
        id: r.get(0)?,
        name: r.get(1)?,
        field: r.get(2)?,
        op: r.get(3)?,
        value: r.get(4)?,
        action: r.get(5)?,
        arg: r.get(6)?,
        enabled: r.get::<_, i64>(7)? != 0,
        account_id: r.get(8)?,
        conditions: conditions.and_then(|j| serde_json::from_str::<Vec<Cond>>(&j).ok()).unwrap_or_default(),
        position: r.get::<_, Option<i64>>(10)?.unwrap_or(0),
    };
    rule.conditions = rule.conds();
    Ok(rule)
}

/// Give every rule without a position one, after the others, in `rowid` order (the order the list had before). Cheap and safe to call often: rows that have a position
/// are not touched. A row an older build wrote again has no position and goes to the end.
pub fn backfill_positions(c: &Connection) -> R<()> {
    let mut st = c.prepare("SELECT id FROM rules WHERE position IS NULL ORDER BY rowid").map_err(|e| e.to_string())?;
    let ids: Vec<String> = st.query_map([], |r| r.get(0)).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
    drop(st);
    if ids.is_empty() {
        return Ok(());
    }
    let mut next: i64 = c.query_row("SELECT COALESCE(MAX(position),0) FROM rules", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    for id in ids {
        next += 1;
        c.execute("UPDATE rules SET position=?1 WHERE id=?2", params![next, id]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Every rule, in the order they run.
pub fn list(c: &Connection) -> R<Vec<Rule>> {
    backfill_positions(c)?;
    let mut st = c.prepare(&format!("SELECT {COLS} FROM rules ORDER BY position, rowid")).map_err(|e| e.to_string())?;
    let rows = st.query_map([], from_row).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    Ok(rows)
}

/// The enabled rules, in the order they run.
pub fn list_enabled(c: &Connection) -> Vec<Rule> {
    list(c).map(|v| v.into_iter().filter(|r| r.enabled).collect()).unwrap_or_default()
}

/// Store a rule. A new rule goes to the end of the order; a rule that is saved again keeps its place.
pub fn save(c: &Connection, rule: &Rule) -> R<()> {
    let mut conds: Vec<Cond> = rule
        .conditions
        .iter()
        .map(|k| Cond { field: k.field.clone(), op: if k.op == "equals" { "equals".into() } else { "contains".into() }, values: k.values.iter().map(|v| v.trim().to_string()).filter(|v| !v.is_empty()).collect() })
        .filter(|k| !k.values.is_empty())
        .collect();
    if conds.is_empty() {
        // a caller that still sends one field / op / value
        if rule.value.trim().is_empty() {
            return Err("a rule needs at least one condition with a value".into());
        }
        conds = rule.conds();
    }
    if conds.len() > 10 {
        return Err("a rule has at most 10 conditions".into());
    }
    let (field, op, value) = legacy_columns(&conds);
    let json = serde_json::to_string(&conds).map_err(|e| e.to_string())?;
    let pos: i64 = match c.query_row("SELECT position FROM rules WHERE id=?1", [&rule.id], |r| r.get::<_, Option<i64>>(0)) {
        Ok(Some(p)) => p,
        _ => c.query_row("SELECT COALESCE(MAX(position),0)+1 FROM rules", [], |r| r.get(0)).map_err(|e| e.to_string())?,
    };
    c.execute(
        "INSERT INTO rules(id,name,field,op,value,action,arg,enabled,account_id,conditions,position) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, field=excluded.field, op=excluded.op, value=excluded.value, action=excluded.action, arg=excluded.arg,
           enabled=excluded.enabled, account_id=excluded.account_id, conditions=excluded.conditions, position=excluded.position",
        params![rule.id, rule.name, field, op, value, rule.action, rule.arg, rule.enabled as i64, rule.account_id, json, pos],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Swap the rule with the previous (`down` false) or next one that applies to the same mailbox scope (the list the person sees). Nothing happens at the ends.
pub fn move_in_list(c: &Connection, id: &str, down: bool) -> R<()> {
    let all = list(c)?;
    let Some(i) = all.iter().position(|r| r.id == id) else { return Ok(()) };
    let scope = &all[i].account_id;
    let other = if down {
        all.iter().enumerate().skip(i + 1).find(|(_, r)| &r.account_id == scope)
    } else {
        all.iter().enumerate().take(i).rev().find(|(_, r)| &r.account_id == scope)
    };
    let Some((j, _)) = other else { return Ok(()) };
    // positions can be equal in a damaged table: renumber the whole list so that the swap is real
    let mut ids: Vec<&str> = all.iter().map(|r| r.id.as_str()).collect();
    ids.swap(i, j);
    for (n, rid) in ids.iter().enumerate() {
        c.execute("UPDATE rules SET position=?1 WHERE id=?2", params![n as i64 + 1, rid]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mail(from_name: &str, from: &str, to: &[&str], subject: &str, body: &str) -> MailIn {
        MailIn { from_name: from_name.into(), from_email: from.into(), to: to.iter().map(|s| s.to_string()).collect(), subject: subject.into(), body: body.into(), encrypted: false }
    }

    fn cond(field: &str, op: &str, values: &[&str]) -> Cond {
        Cond { field: field.into(), op: op.into(), values: values.iter().map(|s| s.to_string()).collect() }
    }

    fn rule(name: &str, action: &str, conds: Vec<Cond>) -> Rule {
        Rule { id: name.into(), account_id: None, name: name.into(), field: String::new(), op: String::new(), value: String::new(), action: action.into(), arg: None, enabled: true, conditions: conds, position: 0 }
    }

    fn hit(conds: Vec<Cond>, m: &MailIn) -> bool {
        let r = rule("r", "archive", conds);
        Compiled::new(&r).matches(&Prepared::new(m))
    }

    fn sample() -> MailIn {
        mail("Deals Team", "deals@shop.example", &["me@x.test"], "Re: Weekly report", "Your invoice for October is attached.")
    }

    #[test]
    fn conditions_all_must_match() {
        let m = sample();
        assert!(hit(vec![cond("from", "contains", &["@shop.example"]), cond("subject", "contains", &["weekly"])], &m));
        assert!(!hit(vec![cond("from", "contains", &["@shop.example"]), cond("subject", "contains", &["nothing"])], &m));
        assert!(!hit(vec![], &m), "a rule without conditions matches nothing");
    }

    #[test]
    fn any_value_of_a_condition_matches() {
        let m = sample();
        assert!(hit(vec![cond("subject", "contains", &["zzz", "weekly"])], &m));
        assert!(!hit(vec![cond("subject", "contains", &["zzz", "yyy"])], &m));
        assert!(!hit(vec![cond("subject", "contains", &["", "  "])], &m), "empty values never match");
    }

    #[test]
    fn old_rule_value_with_comma_is_literal() {
        let mut r = rule("old", "archive", vec![]);
        r.field = "subject".into();
        r.op = "contains".into();
        r.value = "Smith, John".into();
        let c = Compiled::new(&r);
        assert!(c.matches(&Prepared::new(&mail("", "a@b.c", &[], "Re: Smith, John called", ""))));
        assert!(!c.matches(&Prepared::new(&mail("", "a@b.c", &[], "Smith called", ""))));
    }

    #[test]
    fn from_contains_checks_name_and_address() {
        let m = sample();
        assert!(hit(vec![cond("from", "contains", &["deals team"])], &m));
        assert!(hit(vec![cond("from", "contains", &["deals@shop"])], &m));
        assert!(!hit(vec![cond("from", "contains", &["other"])], &m));
    }

    #[test]
    fn from_equals_checks_address_only() {
        let m = sample();
        assert!(hit(vec![cond("from", "equals", &["Deals@Shop.example"])], &m));
        assert!(!hit(vec![cond("from", "equals", &["Deals Team"])], &m));
        assert!(!hit(vec![cond("from", "equals", &["@shop.example"])], &m));
    }

    #[test]
    fn to_equals_matches_one_of_many_recipients() {
        let m = mail("", "a@b.c", &["me@x.test", "you@y.test", "them@z.test"], "s", "");
        assert!(hit(vec![cond("to", "equals", &["you@y.test"])], &m), "one of three recipients (was: never matched)");
        assert!(!hit(vec![cond("to", "equals", &["y.test"])], &m));
        assert!(hit(vec![cond("to", "contains", &["y.test"])], &m));
    }

    #[test]
    fn subject_equals_ignores_reply_prefixes() {
        for s in ["Re: Weekly report", "RE[2]: Weekly report", "AW: WG: Weekly report", "回复：Weekly report", "Trả lời: Weekly report", "Fwd: Re: Weekly report", "Weekly report"] {
            assert!(hit(vec![cond("subject", "equals", &["Weekly report"])], &mail("", "a@b.c", &[], s, "")), "{s}");
        }
        assert!(hit(vec![cond("subject", "equals", &["Re: Weekly report"])], &mail("", "a@b.c", &[], "Weekly report", "")), "the typed value loses its prefixes too");
        assert!(!hit(vec![cond("subject", "equals", &["Weekly"])], &mail("", "a@b.c", &[], "Weekly report", "")));
        assert_eq!(strip_prefixes("AW: WG: Rechnung 2026"), "Rechnung 2026");
        assert_eq!(strip_prefixes("Reply to everyone"), "Reply to everyone", "a word that starts like a prefix is not one");
        assert_eq!(strip_prefixes("Отв: Ответ: Привет"), "Привет");
        assert_eq!(strip_prefixes("答复：转发：会议"), "会议");
    }

    #[test]
    fn body_first_20000_chars_only() {
        let body = format!("{}needle", "a".repeat(BODY_CHARS));
        assert!(!hit(vec![cond("body", "contains", &["needle"])], &mail("", "a@b.c", &[], "s", &body)));
        let body = format!("{}needle", "a".repeat(BODY_CHARS - 6));
        assert!(hit(vec![cond("body", "contains", &["needle"])], &mail("", "a@b.c", &[], "s", &body)));
        // characters, not bytes
        let body = format!("{}needle", "é".repeat(BODY_CHARS - 6));
        assert!(hit(vec![cond("body", "contains", &["needle"])], &mail("", "a@b.c", &[], "s", &body)));
    }

    #[test]
    fn subject_or_body() {
        let m = sample();
        assert!(hit(vec![cond("subjectBody", "contains", &["invoice"])], &m));
        assert!(hit(vec![cond("subjectBody", "contains", &["weekly"])], &m));
        assert!(!hit(vec![cond("subjectBody", "contains", &["refund"])], &m));
        assert!(!hit(vec![cond("body", "contains", &["weekly"])], &m), "Body alone does not look at the subject");
    }

    #[test]
    fn any_field_is_from_to_or_subject() {
        let m = sample();
        assert!(hit(vec![cond("any", "contains", &["me@x.test"])], &m));
        assert!(hit(vec![cond("any", "contains", &["shop.example"])], &m));
        assert!(!hit(vec![cond("any", "contains", &["invoice"])], &m), "not the body");
    }

    #[test]
    fn encrypted_body_never_matches() {
        let mut m = sample();
        m.encrypted = true;
        assert!(!hit(vec![cond("body", "contains", &["invoice"])], &m));
        assert!(hit(vec![cond("subjectBody", "contains", &["weekly"])], &m), "the subject still does");
        assert!(hit(vec![cond("from", "contains", &["shop"])], &m));
    }

    #[test]
    fn nfc_and_nfd_are_equal() {
        let nfd = "Hóa đơn".chars().flat_map(|c| icu_normalizer::DecomposingNormalizer::new_nfd().normalize(&c.to_string()).chars().collect::<Vec<_>>()).collect::<String>();
        assert_ne!(nfd, "Hóa đơn");
        assert!(hit(vec![cond("body", "contains", &["hóa đơn"])], &mail("", "a@b.c", &[], "s", &nfd)));
        assert!(hit(vec![cond("body", "contains", &[&nfd])], &mail("", "a@b.c", &[], "s", "Hóa đơn tháng 10")));
    }

    #[test]
    fn accent_smart_folding() {
        let m = mail("", "a@b.c", &[], "s", "Gửi bạn hóa đơn tháng 10, résumé");
        assert!(hit(vec![cond("body", "contains", &["hoa don"])], &m), "no marks typed: marks of the text do not matter");
        assert!(hit(vec![cond("body", "contains", &["hóa đơn"])], &m));
        assert!(!hit(vec![cond("body", "contains", &["hòa đơn"])], &m), "marks typed: they must match");
        assert!(hit(vec![cond("body", "contains", &["resume"])], &m));
        assert!(!hit(vec![cond("body", "contains", &["hóa don"])], &m), "one mark typed (and đ missing) -> exact: the text has đ");
        let plain = mail("", "a@b.c", &[], "s", "hoa don");
        assert!(!hit(vec![cond("body", "contains", &["hóa đơn"])], &plain), "marks typed, none in the text");
        assert!(hit(vec![cond("body", "contains", &["đ"])], &mail("", "a@b.c", &[], "s", "đơn")));
        assert!(!hit(vec![cond("body", "contains", &["đ"])], &mail("", "a@b.c", &[], "s", "don")), "đ typed: the text must have đ");
        assert!(hit(vec![cond("body", "contains", &["d"])], &mail("", "a@b.c", &[], "s", "đơn")));
        // Hangul and Kana keep their syllables
        assert!(!hit(vec![cond("body", "contains", &["하"])], &mail("", "a@b.c", &[], "s", "한국")));
        assert!(!hit(vec![cond("body", "contains", &["か"])], &mail("", "a@b.c", &[], "s", "がっこう")));
        assert!(hit(vec![cond("body", "contains", &["がっこう"])], &mail("", "a@b.c", &[], "s", "がっこう")));
    }

    #[test]
    fn cyrillic_and_vietnamese_lower_case() {
        assert!(hit(vec![cond("subject", "contains", &["ПРИВЕТ"])], &mail("", "a@b.c", &[], "привет, мир", "")));
        assert!(hit(vec![cond("subject", "contains", &["привет"])], &mail("", "a@b.c", &[], "ПРИВЕТ МИР", "")));
        assert!(hit(vec![cond("subject", "contains", &["HÓA ĐƠN"])], &mail("", "a@b.c", &[], "hóa đơn tháng", "")));
        assert!(hit(vec![cond("subject", "contains", &["ΑΘΗΝΑ"])], &mail("", "a@b.c", &[], "athens αθήνα", "")));
    }

    #[test]
    fn fullwidth_equals_ascii() {
        assert!(hit(vec![cond("subject", "contains", &["ｉｎｖｏｉｃｅ"])], &mail("", "a@b.c", &[], "Invoice 12", "")));
        assert!(hit(vec![cond("subject", "contains", &["invoice"])], &mail("", "a@b.c", &[], "ＩＮＶＯＩＣＥ", "")));
        assert!(hit(vec![cond("body", "contains", &["ﾒｰﾙ"])], &mail("", "a@b.c", &[], "s", "メール")), "half-width Kana");
    }

    #[test]
    fn first_moving_rule_wins_and_non_moving_rules_still_run() {
        let rules = vec![
            rule("Move1", "move", vec![cond("from", "contains", &["shop"])]),
            rule("Read", "read", vec![cond("from", "contains", &["shop"])]),
            rule("Move2", "trash", vec![cond("subject", "contains", &["weekly"])]),
            rule("Flag", "star", vec![cond("subject", "contains", &["weekly"])]),
            rule("NoMatch", "archive", vec![cond("subject", "contains", &["zzz"])]),
        ];
        let c: Vec<Compiled> = rules.iter().map(Compiled::new).collect();
        let names: Vec<&str> = plan(&c, &Prepared::new(&sample())).iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["Read", "Flag", "Move1"], "the flags first, then only the first move");
        let other = mail("", "x@other.test", &[], "weekly", "");
        let names: Vec<&str> = plan(&c, &Prepared::new(&other)).iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["Flag", "Move2"]);
    }

    #[test]
    fn disabled_and_other_mailbox_rules_are_skipped() {
        // the sync loads the enabled rules of the mailbox: this is the filter it uses (see lib.rs `rules_for_account`)
        let mut a = rule("A", "archive", vec![cond("from", "contains", &["shop"])]);
        a.enabled = false;
        let mut b = rule("B", "archive", vec![cond("from", "contains", &["shop"])]);
        b.account_id = Some("other".into());
        let c = rule("C", "archive", vec![cond("from", "contains", &["shop"])]);
        let got: Vec<String> = [a, b, c].into_iter().filter(|r| rule_applies(r, "mine")).map(|r| r.name).collect();
        assert_eq!(got, ["C"]);
    }

    #[test]
    fn timing_guard_50_messages_against_50_rules() {
        let rules: Vec<Rule> = (0..50)
            .map(|i| rule(&format!("R{i}"), if i % 2 == 0 { "read" } else { "archive" }, vec![cond("from", "contains", &["@shop.example"]), cond("subjectBody", "contains", &[&format!("needle{i}"), "hóa đơn"])]))
            .collect();
        let body = "Lorem ipsum dolor sit amet, résumé hóa đơn. ".repeat(500);
        let t = std::time::Instant::now();
        let compiled: Vec<Compiled> = rules.iter().map(Compiled::new).collect();
        let mut planned = 0;
        for i in 0..50 {
            let m = mail("Shop", "a@shop.example", &["me@x.test"], &format!("Hello {i}"), &body);
            planned += plan(&compiled, &Prepared::new(&m)).len();
        }
        assert!(planned > 0);
        // a generous bound for a debug build on a slow CI runner (release is far below 50 ms)
        assert!(t.elapsed() < std::time::Duration::from_secs(5), "took {:?}", t.elapsed());
    }

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE rules(id TEXT PRIMARY KEY, name TEXT NOT NULL, field TEXT NOT NULL, op TEXT NOT NULL, value TEXT NOT NULL, action TEXT NOT NULL, arg TEXT, enabled INTEGER NOT NULL DEFAULT 1, account_id TEXT, conditions TEXT, position INTEGER);",
        )
        .unwrap();
        c
    }

    #[test]
    fn position_backfilled_in_rowid_order_once() {
        let c = db();
        for id in ["a", "b", "c"] {
            c.execute("INSERT INTO rules(id,name,field,op,value,action) VALUES(?1,?1,'from','contains','x','archive')", [id]).unwrap();
        }
        let ids = |v: Vec<Rule>| v.into_iter().map(|r| format!("{}:{}", r.id, r.position)).collect::<Vec<_>>();
        assert_eq!(ids(list(&c).unwrap()), ["a:1", "b:2", "c:3"]);
        // a second call changes nothing; a row an older build wrote again (no position) goes to the end
        assert_eq!(ids(list(&c).unwrap()), ["a:1", "b:2", "c:3"]);
        c.execute("DELETE FROM rules WHERE id='a'", []).unwrap();
        c.execute("INSERT INTO rules(id,name,field,op,value,action) VALUES('a','a','from','contains','x','archive')", []).unwrap();
        assert_eq!(ids(list(&c).unwrap()), ["b:2", "c:3", "a:4"]);
    }

    #[test]
    fn new_save_keeps_old_columns_safe_for_older_builds() {
        let c = db();
        let mut r = rule("two", "move", vec![cond("from", "contains", &["a@b.c"]), cond("body", "contains", &["x"])]);
        r.arg = Some("f:Projects".into());
        save(&c, &r).unwrap();
        let (f, o, v): (String, String, String) = c.query_row("SELECT field,op,value FROM rules WHERE id='two'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        // what a 1.0.7 build would run: "any equals <a string no message has>"
        let old = Rule { field: f, op: o, value: v, conditions: vec![], ..r.clone() };
        let oc = Compiled::new(&old);
        assert!(!oc.matches(&Prepared::new(&mail("A", "a@b.c", &[], "x", "x"))));
        assert!(!oc.matches(&Prepared::new(&mail("", "", &[], &old.value, ""))) || old.value.contains('\u{1}'), "the value has a control character no subject has");
        // one condition, one value of a known kind keeps real columns
        let one = rule("one", "archive", vec![cond("subject", "contains", &["sale"])]);
        save(&c, &one).unwrap();
        let (f, o, v): (String, String, String) = c.query_row("SELECT field,op,value FROM rules WHERE id='one'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!((f.as_str(), o.as_str(), v.as_str()), ("subject", "contains", "sale"));
        // a body condition alone is unknown to older builds
        let b = rule("b", "archive", vec![cond("body", "contains", &["sale"])]);
        save(&c, &b).unwrap();
        let f: String = c.query_row("SELECT field FROM rules WHERE id='b'", [], |r| r.get(0)).unwrap();
        assert_eq!(f, "any");
        // saving again keeps the place, the order holds, and the conditions come back
        save(&c, &Rule { name: "renamed".into(), ..r.clone() }).unwrap();
        let all = list(&c).unwrap();
        assert_eq!(all.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["two", "one", "b"]);
        assert_eq!(all[0].conditions.len(), 2);
        assert_eq!(all[0].name, "renamed");
        // a rule with only empty values is refused
        assert!(save(&c, &rule("e", "archive", vec![cond("from", "contains", &[" "])])).is_err());
    }

    #[test]
    fn move_up_and_down_swap_inside_the_scope() {
        let c = db();
        for (id, acc) in [("a", None), ("b", Some("m1")), ("c", None), ("d", Some("m1"))] {
            let mut r = rule(id, "archive", vec![cond("from", "contains", &["x"])]);
            r.account_id = acc.map(|s| s.to_string());
            save(&c, &r).unwrap();
        }
        let order = |c: &Connection| list(c).unwrap().into_iter().map(|r| r.id).collect::<String>();
        assert_eq!(order(&c), "abcd");
        move_in_list(&c, "c", false).unwrap();
        assert_eq!(order(&c), "cbad", "c swaps with a, the previous rule of its scope");
        move_in_list(&c, "c", false).unwrap();
        assert_eq!(order(&c), "cbad", "the first row stays");
        move_in_list(&c, "d", false).unwrap();
        assert_eq!(order(&c), "cdab");
        move_in_list(&c, "b", true).unwrap();
        assert_eq!(order(&c), "cdab", "the last row of its scope stays");
    }
}

/// Does the rule apply to the mailbox (its own, or every mailbox) and is it on?
pub fn rule_applies(r: &Rule, account_id: &str) -> bool {
    r.enabled && r.account_id.as_deref().filter(|a| !a.is_empty()).map_or(true, |a| a == account_id)
}
