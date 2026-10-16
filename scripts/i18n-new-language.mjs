// Scaffold (or top up) the files of one UI language.
//
//   node --experimental-strip-types scripts/i18n-new-language.mjs <code>            create the files of a language that is in src/i18n/languages.ts
//   node --experimental-strip-types scripts/i18n-new-language.mjs <code> --sync     add the keys that English got since (English text, to be translated)
//   node --experimental-strip-types scripts/i18n-new-language.mjs --sync            --sync for every language that has a locales/<code>/ folder
//
// Creates, from the English dictionaries in src/i18n/ns/*.ts (the English text is copied as it is, comments included):
//   src/i18n/locales/<code>/<area>.ts   one file per area (common, app, mail, ...), typed so that a missing or extra key fails `tsc`
//   src/i18n/locales/<code>/index.ts    gathers them
//   src/i18n/locales/<code>/keep.json   keys whose text is the same as English on purpose (read by scripts/i18n-status.mjs)
//   src-tauri/src/i18n/<code>.rs        the texts of the OS (tray, notifications, ...) with English placeholders
// Plural messages get the forms of the language (`plural` in the registry): Russian one / few / many / other, Japanese and Chinese other.
// Existing files are never overwritten (a translated file is safe); --sync only appends missing keys.
//
// Then prints the few lines of shared code that name the language (registry, DICTS, date-fns locale, Rust `Lang`). A translator who
// takes a language that is already wired (all of ours are) edits only the files above and nothing shared.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { LANGUAGES } from "../src/i18n/languages.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const NS_DIR = join(root, "src/i18n/ns");
const STUB = "// STUB: English placeholders, to be translated";
const INLINE = new Set(["en", "vi", "fr"]);

const argv = process.argv.slice(2);
const sync = argv.includes("--sync");
const code = argv.find((a) => !a.startsWith("--"));

/** "zh-Hans" -> "zhHans" (identifier), "zh_hans" (Rust module). */
const ident = (c) => c.replace(/-(\w)/g, (_, x) => x.toUpperCase());
const rustMod = (c) => c.toLowerCase().replace(/-/g, "_");

const write = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text.replace(/\r\n/g, "\n"));
};

/** The `en` properties of an ns file: [{ key, comments: string[], node, text }]. */
function readEnglish(nsFile) {
  const src = readFileSync(nsFile, "utf8");
  const sf = ts.createSourceFile(nsFile, src, ts.ScriptTarget.Latest, true);
  let en;
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "define") {
      const obj = n.arguments[0];
      for (const p of obj.properties) if (p.name?.getText(sf) === "en") en = p.initializer;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!en) throw new Error(`${nsFile}: no define({ en: {...} })`);
  const lead = src.slice(0, src.indexOf("export default")).trim();
  const props = en.properties.map((p) => {
    const comments = (ts.getLeadingCommentRanges(src, p.getFullStart()) ?? []).map((r) => src.slice(r.pos, r.end));
    return { key: JSON.parse(p.name.getText(sf).replace(/^'|'$/g, '"')), comments, init: p.initializer, sf, src };
  });
  return { props, lead };
}

/** Source of one property for a language: the English text, plural objects reshaped to the language's forms. */
function entry(p, lang) {
  const { init, sf } = p;
  let value;
  if (ts.isObjectLiteralExpression(init)) {
    const forms = new Map(init.properties.map((q) => [q.name.getText(sf), q.initializer.getText(sf)]));
    const other = forms.get("other");
    const parts = lang.plural.map((c) => `${c}: ${forms.get(c) ?? other}`);
    const one = `{ ${parts.join(", ")} }`;
    value = one.length > 130 ? `{\n${parts.map((x) => `    ${x},`).join("\n")}\n  }` : one;
  } else {
    value = init.getText(sf).split("\n").map((l, i) => (i === 0 ? l : l.replace(/^ {2}/, ""))).join("\n");
  }
  return `${p.comments.map((c) => `  ${c.trim()}\n`).join("")}  ${JSON.stringify(p.key)}: ${value},\n`;
}

const nsNames = () => readdirSync(NS_DIR).filter((f) => f.endsWith(".ts")).map((f) => f.replace(/\.ts$/, "")).sort();

function localeFile(lang, ns) {
  const { props, lead } = readEnglish(join(NS_DIR, `${ns}.ts`));
  const note = lead.split("\n").filter((l) => l.startsWith("//")).join("\n");
  return `${STUB}
import { defineLocale } from "../../types.ts";
import type ns from "../../ns/${ns}.ts";
${note ? `\n${note}\n` : ""}
export default defineLocale<typeof ns.en>({
${props.map((p) => entry(p, lang)).join("")}});
`;
}

function indexFile(lang, names) {
  const id = ident(lang.code);
  return `// ${lang.englishName} (${lang.code}): gathers the files of this folder, one per area. A new area added in src/i18n/ns/ needs a line here.
import type { en } from "../../en.ts";
import type { Msg } from "../../types.ts";
${names.map((n) => `import ${n} from "./${n}.ts";`).join("\n")}

export const ${id} = {
${names.map((n) => `  ...${n},`).join("\n")}
} satisfies Record<keyof typeof en, Msg>;
`;
}

/** Add the keys English has and this file lacks (English text), at the end of the object. */
function syncFile(file, lang, ns) {
  const { props } = readEnglish(join(NS_DIR, `${ns}.ts`));
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  let obj;
  const visit = (n) => {
    if (ts.isCallExpression(n) && n.expression.getText(sf).startsWith("defineLocale")) obj = n.arguments[0];
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!obj) return 0;
  const have = new Set(obj.properties.map((p) => JSON.parse(p.name.getText(sf).replace(/^'|'$/g, '"'))));
  const missing = props.filter((p) => !have.has(p.key));
  if (!missing.length) return 0;
  const at = obj.getEnd() - 1; // before the closing brace
  const add = `  // added by i18n-new-language --sync: English placeholders\n${missing.map((p) => entry({ ...p, comments: [] }, lang)).join("")}`;
  const before = src.slice(0, at);
  write(file, before + (before.endsWith("\n") ? "" : "\n") + add + src.slice(at));
  return missing.length;
}

// ---- Rust -----------------------------------------------------------------------------------------------------------------------
function englishRustTexts() {
  const rs = readFileSync(join(root, "src-tauri/src/i18n.rs"), "utf8");
  const body = rs.slice(rs.indexOf("fn texts(k: K)"), rs.indexOf("/// The text in the current language."));
  const out = [];
  for (const m of body.matchAll(/((?:K::\w+\s*\|?\s*)+)=>\s*\[\s*("(?:[^"\\]|\\.)*")/g)) {
    for (const k of m[1].match(/K::\w+/g)) out.push([k, m[2]]);
  }
  if (!out.length) throw new Error("could not read the English texts from src-tauri/src/i18n.rs");
  return out;
}

function rustFile(lang) {
  const texts = englishRustTexts();
  return `//! The texts the operating system shows (tray menu, notifications, reminder titles, file dialog titles, repeat descriptions) in ${lang.englishName}.
//! STUB: English placeholders, to be translated. Edit this file only: every function below returns English now; translate the strings (and the word order
//! and plural rules where the language needs other ones). Keep the product name "Hey Look!" and the {placeholders} (\`{n}\`, \`{who}\`) as they are.
//! The compiler stops on a missing text. \`cargo test --lib i18n\` checks the file.

use super::K;

/// The fixed texts.
pub fn text(k: K) -> &'static str {
    match k {
${texts.map(([k, v]) => `        ${k} => ${v},`).join("\n")}
    }
}

/// Tray tooltip: the unread count.
pub fn unread_tooltip(n: u32) -> String {
    match n {
        0 => "Hey Look!".to_string(),
        1 => "Hey Look! — 1 unread conversation".to_string(),
        n => format!("Hey Look! — {n} unread conversations"),
    }
}

/// Notification for more than three new messages at once.
pub fn new_messages(n: usize) -> String {
    format!("{n} new messages")
}

/// Title of the notification for a snoozed conversation that came back.
pub fn snooze_ended(who: &str) -> String {
    format!("Snooze ended: {who}")
}

/// Event reminder title: the event starts now (\`minutes\` = 0) or in \`minutes\` minutes.
pub fn event_reminder(summary: &str, minutes: i64) -> String {
    match minutes {
        0 => format!("{summary} is starting"),
        1 => format!("{summary} in 1 minute"),
        m => format!("{summary} in {m} minutes"),
    }
}

/// Day name, \`i\` = 0 for Monday.
pub fn day_name(i: usize) -> &'static str {
    const DAYS: [&str; 7] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    DAYS[i % 7]
}

/// "Monday, Tuesday and Friday"
pub fn day_list(days: &[String]) -> String {
    match days.len() {
        0 => String::new(),
        1 => days[0].clone(),
        n => format!("{} and {}", days[..n - 1].join(", "), days[n - 1]),
    }
}

/// "Every Wednesday" / "Every 2 weeks on Wednesday" (\`list\` from \`day_list\`).
pub fn every_weekday(n: u32, list: &str) -> String {
    match n {
        1 => format!("Every {list}"),
        n => format!("Every {n} weeks on {list}"),
    }
}

/// "Every 2 days" etc. \`unit\`: 'd' day, 'm' month, 'y' year.
pub fn every_n(n: u32, unit: char) -> String {
    match unit {
        'd' => format!("Every {n} days"),
        'm' => format!("Every {n} months"),
        _ => format!("Every {n} years"),
    }
}

/// ", 5 times"
pub fn times_tail(c: u32) -> String {
    match c {
        1 => ", 1 time".to_string(),
        c => format!(", {c} times"),
    }
}

/// ", until 31 Dec 2026" (\`month0\` = 0 for January)
pub fn until_tail(day: u32, month0: u32, year: i32) -> String {
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    format!(", until {day} {} {year}", MONTHS[(month0 % 12) as usize])
}
`;
}

// ---- main -----------------------------------------------------------------------------------------------------------------------
function create(lang) {
  const dir = join(root, "src/i18n/locales", lang.code);
  const names = nsNames();
  let made = 0;
  const put = (file, text) => {
    if (existsSync(file)) return console.log(`  keep   ${file.slice(root.length)} (exists)`);
    write(file, text);
    made++;
    console.log(`  create ${file.slice(root.length)}`);
  };
  for (const ns of names) put(join(dir, `${ns}.ts`), localeFile(lang, ns));
  put(join(dir, "index.ts"), indexFile(lang, names));
  put(join(dir, "keep.json"), "[]\n");
  put(join(root, "src-tauri/src/i18n", `${rustMod(lang.code)}.rs`), rustFile(lang));
  return made;
}

function topUp(lang) {
  const dir = join(root, "src/i18n/locales", lang.code);
  let added = 0;
  for (const ns of nsNames()) {
    const file = join(dir, `${ns}.ts`);
    if (!existsSync(file)) {
      write(file, localeFile(lang, ns));
      console.log(`  create ${file.slice(root.length)} (new area: also add it to ${lang.code}/index.ts)`);
      continue;
    }
    const n = syncFile(file, lang, ns);
    if (n) console.log(`  ${lang.code}/${ns}.ts: +${n} key(s)`);
    added += n;
  }
  return added;
}

if (!code && !sync) {
  console.error("usage: node --experimental-strip-types scripts/i18n-new-language.mjs <code> [--sync]   |   ... --sync");
  process.exit(2);
}
const targets = code ? LANGUAGES.filter((l) => l.code === code) : LANGUAGES.filter((l) => !INLINE.has(l.code));
if (code && !targets.length) {
  console.error(`"${code}" is not in src/i18n/languages.ts. Add its entry first (code, nativeName, englishName, short, dir, sortOrder, intl, plural), e.g.:
  { code: "${code}", nativeName: "...", englishName: "...", short: "${code.slice(0, 2).toUpperCase()}", dir: "ltr", sortOrder: ${LANGUAGES.length}, intl: "${code}", plural: ["one", "other"] },
then run this again. Plural forms: https://www.unicode.org/cldr/charts/latest/supplemental/language_plural_rules.html`);
  process.exit(1);
}
if (code && INLINE.has(code)) {
  console.error(`${code} lives inside src/i18n/ns/*.ts, not in locales/.`);
  process.exit(1);
}
for (const lang of targets) {
  console.log(`${lang.code} (${lang.englishName})`);
  if (sync) {
    const n = topUp(lang);
    console.log(n ? `  ${n} key(s) added` : "  up to date");
  } else {
    create(lang);
    const id = ident(lang.code);
    console.log(`
Shared code that names the language (only for a language that is not wired yet; the five shipped ones are):
  src/i18n/index.ts      import { ${id} } from "./locales/${lang.code}/index.ts";  and  "${lang.code}": ${id}  in DICTS
  src/i18n/format.ts     import { ... } from "date-fns/locale/<date-fns name>";  and the entry in DF
  src-tauri/src/i18n.rs  mod ${rustMod(lang.code)};  a Lang variant, the parse() arm, the lang()/set_lang() numbers and the arms that call ${rustMod(lang.code)}::*
Then: npx tsc --noEmit  &&  node --experimental-strip-types scripts/test-i18n.mjs  &&  (cd src-tauri && cargo test --lib i18n)`);
  }
}
