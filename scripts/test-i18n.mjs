// Translations: (1) en / vi / fr have the same keys, the same {placeholders} and compatible plural forms, no key is defined twice,
// no key is unused or missing in the source; (2) a lint for new hard-coded English in the UI code.
// Run: node --experimental-strip-types scripts/test-i18n.mjs [--lint-only] [--list]
//   --list  prints every finding of the lint instead of stopping at the first lines (default prints all, capped at 60)
// A deliberate exception in the code carries a comment `// i18n-ok: why` on the same line or the line above (JSX: `{/* i18n-ok: why */}`).
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { en } from "../src/i18n/en.ts";
import { vi } from "../src/i18n/vi.ts";
import { fr } from "../src/i18n/fr.ts";
import { pseudoize, resolveLang, t, setLangPref, getLang } from "../src/i18n/index.ts";
import { backendText, parseCoded } from "../src/backendErrors.ts";
import { BACKEND_ERRORS } from "../src/calendarSync.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = new Set(process.argv.slice(2));
const failures = [];
const fail = (m) => failures.push(m);

// ------------------------------------------------------------------------------------------------ 1. dictionaries
const NS_DIR = join(root, "src/i18n/ns");
if (!args.has("--lint-only")) {
  const placeholders = (m) => {
    const parts = typeof m === "string" ? [m] : [m.one, m.other];
    const sets = parts.map((s) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort().join(","));
    return sets;
  };
  const phOf = (m) => [...new Set(placeholders(m).flatMap((s) => (s ? s.split(",") : [])))].sort().join(",");
  const text = (m) => (typeof m === "string" ? m : `${m.one} ${m.other}`);

  // no key in two dictionaries (a spread would silently let one win)
  const seen = new Map();
  for (const f of readdirSync(NS_DIR).filter((x) => x.endsWith(".ts"))) {
    const mod = await import(new URL(`../src/i18n/ns/${f}`, import.meta.url));
    for (const k of Object.keys(mod.default.en)) {
      if (seen.has(k)) fail(`key ${k} is defined in ${seen.get(k)} and in ${f}`);
      seen.set(k, f);
    }
  }

  for (const [name, dict] of [["vi", vi], ["fr", fr]]) {
    for (const k of Object.keys(en)) if (!(k in dict)) fail(`${name}: missing key ${k}`);
    for (const k of Object.keys(dict)) if (!(k in en)) fail(`${name}: key ${k} is not in en`);
  }
  for (const [k, m] of Object.entries(en)) {
    if (!/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9_-]+)+$/.test(k)) fail(`key name ${k}: use area.name (letters, digits, dots)`);
    if (!text(m).trim()) fail(`en: ${k} is empty`);
    const want = phOf(m);
    const plural = typeof m !== "string";
    if (plural && !/\{n\}/.test(m.other)) fail(`en: plural ${k} has no {n}`);
    for (const [name, dict] of [["vi", vi], ["fr", fr]]) {
      const v = dict[k];
      if (v === undefined) continue;
      if (!text(v).trim()) fail(`${name}: ${k} is empty`);
      if (phOf(v) !== want) fail(`${name}: ${k} placeholders {${phOf(v)}} differ from en {${want}}`);
      // each form of a plural must carry the same placeholders as the other forms of that language, and both forms must exist when en has both
      if (typeof v !== "string") {
        if (!plural) fail(`${name}: ${k} is a plural but en is not`);
        else if (new Set(placeholders(v)).size > 1 && placeholders(v)[0] !== placeholders(v)[1] && name !== "vi") {
          // a form may leave out {n} ("one" = "1 message"), anything else must match
          const [a, b] = placeholders(v).map((s) => s.replace(/(^|,)n(?=,|$)/, "").replace(/^,/, ""));
          if (a !== b) fail(`${name}: ${k} plural forms use different placeholders`);
        }
      }
      // French typography: a no-break space (not a plain one) before : ; ! ? » and after «
      if (name === "fr" && (/[^\s  ] [:;!?»]/.test(text(v)) || /« [^ ]/.test(text(v)))) fail(`fr: ${k} has a plain space before : ; ! ? » or after « (use \\u00a0)`);
      if (name === "vi" && /[ÀÂÊÔÇ]/.test(text(v)) && !/[ạảãấầẩẫậắằẳẵặẹẻẽếềểễệịỉĩọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹơưăđ]/i.test(text(v))) {
        fail(`vi: ${k} looks French: ${text(v)}`);
      }
    }
  }

  // keys used by the code exist; keys nobody uses are reported (they are dead translations)
  const used = new Set();
  const srcFiles = walk(join(root, "src")).filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes(`${sep}i18n${sep}`) && !f.endsWith(".d.ts"));
  for (const f of srcFiles) {
    const code = readFileSync(f, "utf8");
    for (const m of code.matchAll(/["'`]((?:[a-z][a-zA-Z0-9]*)(?:\.[a-zA-Z0-9_-]+)+)["'`]/g)) if (m[1] in en) used.add(m[1]);
    // dynamic keys: t(`settings.sound.${id}`) marks the whole prefix as used
    for (const m of code.matchAll(/`((?:[a-z][a-zA-Z0-9]*)(?:\.[a-zA-Z0-9_-]+)*\.)\$\{/g)) for (const k of Object.keys(en)) if (k.startsWith(m[1])) used.add(k);
  }
  const unused = Object.keys(en).filter((k) => !used.has(k));
  if (unused.length) fail(`${unused.length} unused key(s), e.g. ${unused.slice(0, 8).join(", ")}${unused.length > 8 ? ", …" : ""}`);

  // ---- behaviour of t(): interpolation, plurals in each language, pseudo-locale
  assert.equal(getLang(), "en");
  // English is the default for everyone: an unset, unknown or outdated setting is English even when the browser / OS language is Vietnamese or French
  Object.defineProperty(globalThis, "navigator", { value: { language: "vi-VN", languages: ["vi-VN", "fr-FR"] }, configurable: true });
  for (const unset of [undefined, null, "", "system", "de", "vi-VN", "FR", "klingon"]) assert.equal(resolveLang(unset), "en", String(unset));
  setLangPref(undefined);
  assert.equal(getLang(), "en", "no setting: English, not the language of the computer");
  setLangPref("system");
  assert.equal(getLang(), "en", "the old 'System default' value is English now");
  assert.equal(resolveLang("vi"), "vi");
  assert.equal(resolveLang("fr"), "fr");
  assert.equal(resolveLang("en"), "en");
  assert.equal(resolveLang("en-XA"), "en", "the pseudo-locale is not a real language");
  // the default of the setting is English, an invalid stored value is mapped back to it, and the Language row offers no "System default"
  const prefsSrc = readFileSync(join(root, "src/prefs.ts"), "utf8");
  assert.ok(prefsSrc.includes('  language: "en",\n'), "the default language is English");
  assert.ok(prefsSrc.includes('language: p.language === "vi" || p.language === "fr" || p.language === "en-XA" ? p.language : "en"'), "an invalid stored language is English");
  assert.ok(!/langSystem|System default/.test(readFileSync(join(root, "src/components/SettingsDialog.tsx"), "utf8")), "no System default option");
  assert.ok(!/navigator/.test(readFileSync(join(root, "src/i18n/index.ts"), "utf8").replace(/\/\/.*$/gm, "")), "the language of the computer is never read");
  assert.equal(pseudoize("Hi {name}!"), "[Ĥî {name}! ~~]");
  setLangPref("en-XA");
  assert.equal(getLang(), "en", "pseudo-locale is for dev builds only (not set here)");
  setLangPref("en");

  // ---- errors that come from the Rust side as codes (backend.<CODE>)
  assert.deepEqual(parseCoded("OUTBOX_SENDING: This message is being sent right now."), { code: "OUTBOX_SENDING", params: {}, text: "This message is being sent right now." });
  assert.deepEqual(parseCoded("PGP_NO_KEY|email=a%3Ab@c.d%7Cx: You have no PGP key for a:b@c.d|x.")?.params, { email: "a:b@c.d|x" });
  assert.equal(parseCoded("SMTP send failed: permanent error"), null, "an ordinary sentence is not a code");
  assert.equal(backendText("PGP_NO_KEY|email=ann@x.y: whatever"), "You have no PGP key for ann@x.y.");
  assert.equal(backendText("CAL_SEND_FAILED|v=saved|detail=boom: x"), "The event was saved, but the invitations weren't sent: boom");
  assert.equal(backendText("NOT_A_KNOWN_CODE: text"), null, "an unknown code keeps the backend's text");
  setLangPref("fr");
  assert.equal(backendText("OUTBOX_SENDING: This message is being sent right now."), "Ce message est en cours d’envoi.");
  setLangPref("vi");
  assert.equal(backendText("FILE_GONE: That file no longer exists."), "Tệp đó không còn tồn tại.");
  setLangPref("en");

  // every code the Rust code sends has a sentence (or is handled elsewhere); the English of the dictionary is what Rust says
  const rustDir = join(root, "src-tauri/src");
  const rust = walk(rustDir).filter((f) => f.endsWith(".rs") && !/tests?\.rs$|_tests|fake/.test(f)).map((f) => readFileSync(f, "utf8")).join("\n");
  const HANDLED_ELSEWHERE = new Set([
    "PGP_LOCKED", "PGP_MISSING_KEYS", "PGP_FAILED", "ATT_RISKY", // special shapes: store.ts friendlyError
    "CAL_READ_ONLY", "CAL_GONE", "CAL_ERROR", "CAL_CONFLICT", "CAL_NOT_SET_UP", "CAL_OFFLINE", "CAL_WRONG_ACCOUNT", "CAL_TIMEOUT", "CAL_PARTIAL",
    "CAL_DENIED", "CAL_BLOCKED", "CAL_AUTH", "CAL_CANCELLED", "CAL_BUSY", // calendar sync sentences: BACKEND_ERRORS in src/calendarSync.ts
  ]);
  // lines that build an error ("Err(", ok_or, map_err, coded(, a const) and are not tests
  const errLines = rust.split("\n").filter((l) => /Err\(|ok_or|map_err|coded\(|None =>|const [A-Z_]+: &str|^\s*"[A-Z][A-Z0-9_]+",$/.test(l) && !/assert|starts_with/.test(l)).join("\n");
  const rustCodes = new Set(
    [...errLines.matchAll(/"([A-Z][A-Z0-9_]{5,})[:|]/g)].map((m) => m[1])
      .concat([...errLines.matchAll(/coded\("([A-Z0-9_]+)"/g)].map((m) => m[1]))
      .concat([...errLines.matchAll(/^\s*"([A-Z][A-Z0-9_]+)",$/gm)].map((m) => m[1])),
  );
  for (const code of rustCodes) {
    if (HANDLED_ELSEWHERE.has(code)) continue;
    if (!Object.keys(en).some((k) => k === `backend.${code}` || k.startsWith(`backend.${code}.`))) fail(`Rust sends the code ${code} but the dictionary has no backend.${code}`);
  }
  for (const k of Object.keys(en)) {
    if (!k.startsWith("backend.")) continue;
    const code = k.slice("backend.".length).split(".")[0];
    if (!rustCodes.has(code)) fail(`${k}: no Rust code sends ${code}`);
  }
  // calendar sync sentences: each one the Rust code can say is recognised by a pattern of BACKEND_ERRORS (else it would stay English)
  const calRust = ["calsync/write.rs", "calsync/cmds.rs"].map((f) => readFileSync(join(rustDir, f), "utf8")).join("\n").split("\n").filter((l) => !/assert|starts_with/.test(l)).join("\n");
  for (const m of calRust.matchAll(/"(CAL_(?:OFFLINE|CONFLICT|GONE|READ_ONLY|AUTH|BUSY|NOT_SET_UP|DENIED|WRONG_ACCOUNT|PARTIAL|TIMEOUT|CANCELLED|BLOCKED|ERROR)): ([^"]+)"/g)) {
    const text = m[2].replace(/\{[^}]*\}/g, "X").replace(/\\"/g, '"');
    if (/^No .* OAuth client configured/.test(text)) continue; // developer text (build configuration), not translated
    if (!BACKEND_ERRORS.some((e) => e.re.test(text))) fail(`calendar sync sentence not covered by BACKEND_ERRORS: ${m[1]}: ${text}`);
  }
  // the Snooze tooltip must keep ending with the shortcut: App.tsx finds the button by it
  for (const [name, dict] of [["en", en], ["vi", vi], ["fr", fr]]) if (!String(dict["reading.head.snoozeTip"]).endsWith(" (s)")) fail(`${name}: reading.head.snoozeTip must end with " (s)"`);
}

// ------------------------------------------------------------------------------------------------ 2. hard-coded English lint
function walk(dir) {
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// files that never reach a user (dev mock data, the dictionaries themselves)
const SKIP = [/[\\/]i18n[\\/]/, /[\\/]devMock/, /[\\/]fakeMail\.ts$/, /[\\/]devDarkCheck\.ts$/, /\.d\.ts$/];
// words that stay as they are in every language
const KEEP = /^(?:Hey Look!?|IMAP|SMTP|POP3?|OAuth2?|OpenPGP|PGP|S\/MIME|TLS|SSL|STARTTLS|iCloud|Gmail|Outlook|Google|Microsoft|Yahoo|Fastmail|GitHub|GreenMail|Hotmail|Office 365|Microsoft 365|ICS|iCal|HTML|URL|SHA-?\d*|CSV|PDF|JSON|UTC|GMT|Tauri|macOS|Windows|Linux)$/;
const ATTRS = new Set(["title", "aria-label", "aria-description", "aria-roledescription", "aria-placeholder", "aria-valuetext", "placeholder", "alt", "label", "tooltip", "hint", "caption", "summary"]);
const PROPS = new Set(["label", "title", "body", "text", "message", "placeholder", "hint", "description", "tooltip", "subtitle", "caption", "heading", "closeLabel", "confirmLabel", "okLabel", "cancelLabel", "emptyText", "detail"]);
const CALLS = new Set(["showToast", "setStickyToast", "toast", "ask", "confirm", "alert", "notify", "setError", "setStatus", "setMsg", "setNote", "setNotice", "setHint"]);
const COMPARE = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);

/** Static text of a string-like node, or null. Template expressions: the literal parts joined (placeholders as "{}"). */
function staticText(n) {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.head.text + "{}" + n.templateSpans.map((s) => s.literal.text).join("{}");
  return null;
}
/** Does this text read as English UI text? (two words, or a capitalised word, containing letters) */
function looksLikeEnglish(s) {
  const x = s.replace(/\{\}/g, " ").replace(/&[a-z]+;|&#\d+;/gi, " ").trim();
  if (!/[A-Za-z]{2}/.test(x)) return false;
  if (KEEP.test(x)) return false;
  if (/^[a-z0-9_.:/#?&=%+@\-[\]*]+$/.test(x)) return false; // an id, url, css value, key
  if (/^(?:https?:|mailto:|\/|\.|#|[a-z]+:\/\/)/.test(x)) return false;
  const words = x.split(/\s+/).filter((w) => /[A-Za-z]{2}/.test(w));
  if (words.length >= 2) return true;
  return /^[A-Z][a-z]{2,}[a-z]*[.!?…:]?$/.test(x) && !KEEP.test(x.replace(/[.!?…:]$/, ""));
}

function lintFile(file) {
  const rel = relative(root, file).split(sep).join("/");
  const code = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = code.split(/\r?\n/);
  const found = [];
  const ok = (node) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
    return /i18n-ok/.test(lines[line] ?? "") || /i18n-ok/.test(lines[line - 1] ?? "") || /i18n-ok/.test(lines[sf.getLineAndCharacterOfPosition(node.getEnd()).line] ?? "");
  };
  const reported = new Set();
  const report = (node, what, s) => {
    if (ok(node) || reported.has(node.getStart(sf))) return;
    reported.add(node.getStart(sf));
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    found.push(`${rel}:${line}: ${what}: ${JSON.stringify(s.length > 70 ? s.slice(0, 70) + "…" : s)}`);
  };
  const insideT = (node) => {
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isCallExpression(p)) {
        const c = p.expression;
        const name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : "";
        if (name === "t" || name === "tx") return true;
      }
    }
    return false;
  };
  const strLits = (node, cb) => {
    const visit = (n) => {
      const s = staticText(n);
      if (s !== null) {
        const par = n.parent;
        const skip = (par && ts.isBinaryExpression(par) && COMPARE.has(par.operatorToken.kind)) || (par && ts.isCaseClause(par)) || (par && ts.isElementAccessExpression(par)) ||
          (par && ts.isCallExpression(par) && ts.isPropertyAccessExpression(par.expression) && /^(includes|startsWith|endsWith|indexOf|test|match|split|replace|replaceAll|has|get|set|add|delete|querySelector|getAttribute|setAttribute|classList)$/.test(par.expression.name.text));
        if (!skip && !insideT(n) && looksLikeEnglish(s)) cb(n, s);
        if (ts.isTemplateExpression(n)) n.templateSpans.forEach((sp) => visit(sp.expression));
        return;
      }
      if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) return; // walked on their own
      if (ts.isCallExpression(n)) {
        const c = n.expression;
        const name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : "";
        if (name === "t" || name === "tx") return; // a translated text: its arguments are keys and data
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
  };
  // any other sentence-like string (a variable, a return value, a ternary branch): a capitalised phrase of three words, or two words ending in punctuation
  const sentence = (txt) => {
    const x = txt.replace(/\{\}/g, " ").replace(/\s+/g, " ").trim();
    if (/^[EdMyHhmsaLQ ,.:\/\-']+$/.test(x)) return false; // a date-fns pattern
    return (/^[A-Z“‘(][A-Za-z’']+ [A-Za-z’']+ [A-Za-z’']+/.test(x) || /^[A-Za-z’']{2,} [A-Za-z’']{2,}.*[.!?…]$/.test(x)) && !KEEP.test(x);
  };
  const quietParent = (p) =>
    !p || ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isLiteralTypeNode(p) || ts.isExternalModuleReference(p) || ts.isTemplateSpan(p) ||
    (ts.isBinaryExpression(p) && COMPARE.has(p.operatorToken.kind)) || ts.isCaseClause(p) || ts.isElementAccessExpression(p) ||
    (ts.isJsxAttribute(p) && !ATTRS.has(p.name.getText(sf))) ||
    (ts.isPropertyAssignment(p) && /^(id|key|type|kind|href|url|className|class|selector|pattern|format)$/.test(p.name.getText(sf).replace(/^["']|["']$/g, ''))) ||
    (ts.isCallExpression(p) && /^(console|log|warn|error|RegExp|querySelector|querySelectorAll|matches|closest|includes|startsWith|endsWith|test|match|replace|replaceAll|split|import|require|join)$/.test(ts.isPropertyAccessExpression(p.expression) ? p.expression.name.text : ts.isIdentifier(p.expression) ? p.expression.text : "")) ||
    (ts.isNewExpression(p) && /^(RegExp|Error)$/.test(p.expression.getText(sf)));
  const walkNode = (n) => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) && !quietParent(n.parent) && !insideT(n)) {
      const txt = staticText(n);
      if (txt !== null && sentence(txt)) report(n, "text", txt);
    }
    if (ts.isJsxText(n)) {
      const x = n.text.replace(/&[a-z]+;|&#\d+;|\s+/gi, " ").trim();
      if (/[A-Za-z]{2}/.test(x) && !KEEP.test(x)) report(n, "JSX text", x);
    } else if (ts.isJsxAttribute(n) && ATTRS.has(n.name.getText(sf)) && n.initializer) {
      if (ts.isStringLiteral(n.initializer)) {
        if (looksLikeEnglish(n.initializer.text)) report(n.initializer, `attribute ${n.name.getText(sf)}`, n.initializer.text);
      } else strLits(n.initializer, (node, s) => report(node, `attribute ${n.name.getText(sf)}`, s));
    } else if (ts.isJsxExpression(n) && n.expression && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))) {
      strLits(n.expression, (node, s) => report(node, "JSX child", s));
    } else if (ts.isPropertyAssignment(n) && n.name && PROPS.has(n.name.getText(sf).replace(/^["']|["']$/g, ""))) {
      strLits(n.initializer, (node, s) => report(node, `property ${n.name.getText(sf)}`, s));
    } else if (ts.isCallExpression(n)) {
      const c = n.expression;
      const name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : "";
      if (CALLS.has(name)) for (const a of n.arguments.slice(0, 1)) strLits(a, (node, s) => report(node, `${name}()`, s));
    } else if (ts.isThrowStatement(n) && n.expression && ts.isNewExpression(n.expression)) {
      // thrown errors can reach a toast through friendlyError: their text is English unless it is a stable code
      for (const a of (n.expression.arguments ?? []).slice(0, 1)) strLits(a, (node, s) => report(node, "throw", s));
    }
    ts.forEachChild(n, walkNode);
  };
  walkNode(sf);
  return found;
}

const lintFiles = walk(join(root, "src")).filter((f) => /\.(ts|tsx)$/.test(f) && !SKIP.some((r) => r.test(f)));
const lint = lintFiles.flatMap(lintFile);
if (lint.length) {
  fail(`${lint.length} hard-coded English text(s) in the UI code (use t("area.key"); a deliberate exception gets a comment "i18n-ok: why"):\n  ` +
    lint.slice(0, args.has("--list") ? 100000 : 60).join("\n  ") + (lint.length > 60 && !args.has("--list") ? `\n  … ${lint.length - 60} more (--list shows all)` : ""));
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`ok - test-i18n (${Object.keys(en).length} keys in en, vi, fr; ${lintFiles.length} source files linted)`);
