// A toast made from a translation key must follow a language change on screen (1.0.6; the translate toasts did it in 1.0.5 through a function
// as the text). Three parts:
//  1. behaviour with a fake language switch: a toast whose text is a function is written again in the language in use each time it is drawn;
//     one made from a finished string keeps the old language (what this test exists to catch); an identical error made after the switch
//     still replaces the older one;
//  2. every toast that stays a while (an error, one with Undo or buttons, a sticky one such as the update and support toasts) is made from a
//     function, never from a string built at the moment of the call: the source of src/ is read with the TypeScript parser;
//  3. the wiring: the store builds the texts with `toastTexts`, the stack draws them with `toastText`.
// Run: node --experimental-strip-types scripts/test-toast-language.mjs
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { addToast, refreshed, toastText, toastTexts } from "../src/toastStack.ts";
import { LANGS, setLangPref, t } from "../src/i18n/index.ts";

const root = new URL("../", import.meta.url);

// ---- 1. a fake language switch ------------------------------------------------------------------------------------------------------
const SAMPLES = [
  ["errors.toast.failed", { error: "Server said no" }], // every error toast
  ["updates.available", { version: "1.0.7" }], // "new version available"
  ["updates.countdown", { version: "1.0.7", seconds: 4 }], // the restart countdown
  ["updates.action.restartNow", undefined], // its button
  ["app.nudge.text", undefined], // the support reminder
  ["compose.toast.draftSaved", undefined], // "Draft saved" ...
  ["common.edit", undefined], // ... with Edit
  ["mail.done.archived", undefined], // Archived ...
  ["common.undo", undefined], // ... with Undo
  ["compose.toast.sending", undefined], // the send / undo countdown
];
for (const [key, params] of SAMPLES) {
  setLangPref("en");
  const made = toastTexts(() => t(key, params)); // what the app does now
  const eager = toastTexts(t(key, params)); // what it did: a finished string
  const english = toastText(made);
  assert.equal(english, t(key, params), `${key}: drawn in English`);
  const seen = new Set([english]);
  for (const lang of LANGS.map((l) => l.code).filter((c) => c !== "en")) {
    setLangPref(lang);
    const now = t(key, params);
    assert.equal(toastText(made), now, `${key}: the toast drawn after the switch to ${lang} is in ${lang}`);
    assert.equal(toastText(eager), english, `${key}: (the old way keeps English: this is the bug)`);
    for (const v of Object.values(params ?? {})) assert.ok(toastText(made).includes(String(v)), `${key} ${lang}: the value ${v} is still in the text`);
    seen.add(now);
  }
  assert.ok(seen.size >= 4, `${key}: the eight languages give different texts (${seen.size})`);
  setLangPref("en");
  assert.equal(toastText(made), english, `${key}: and back`);
}
setLangPref("en");

// the same text made again after the switch is still "the same error": the older toast is written again before it is compared
{
  const make = () => ({ id: 0, kind: "error", ...toastTexts(() => t("errors.toast.failed", { error: "Server said no" })) });
  setLangPref("en");
  const older = { ...make(), id: 1 };
  setLangPref("de");
  const newer = { ...make(), id: 2 };
  assert.equal(addToast([older].map(refreshed), newer).length, 1, "one error, not two, whatever language it was first made in");
  assert.equal(addToast([older], newer).length, 2, "(without writing it again the older one would still be English)");
  assert.equal(refreshed(older).text, newer.text);
  // a plain string toast is left as it is
  const plain = { id: 3, kind: "info", ...toastTexts("Saved") };
  assert.equal(refreshed(plain), plain);
  assert.equal(toastText(plain), "Saved");
  setLangPref("en");
}

// ---- 2. every toast that stays a while is made from a function -----------------------------------------------------------------------
/** Offenders in one source text: toasts that stay (error / Undo / buttons / sticky) whose text, or button label, is built at the call. */
export function scan(source, fileName) {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const bad = [];
  // names declared in this file as `const name = () => ...`: a toast made from one of them is made from a function
  const fnNames = new Set();
  (function v(x) {
    if (ts.isVariableDeclaration(x) && ts.isIdentifier(x.name) && x.initializer && (ts.isArrowFunction(x.initializer) || ts.isFunctionExpression(x.initializer))) fnNames.add(x.name.text);
    ts.forEachChild(x, v);
  })(sf);
  const isFn = (n) => ts.isArrowFunction(n) || ts.isFunctionExpression(n);
  const plain = (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return true;
    // a template that only joins values (no call: no translation, no formatting)
    if (ts.isTemplateExpression(n)) return !n.templateSpans.some((s) => containsCall(s.expression));
    return false;
  };
  const containsCall = (n) => {
    let found = false;
    (function v(x) {
      if (found) return;
      if (ts.isCallExpression(x)) found = true;
      else ts.forEachChild(x, v);
    })(n);
    return found;
  };
  const where = (n) => `${fileName}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const okMarked = (n) => /i18n-ok/.test(source.split("\n")[sf.getLineAndCharacterOfPosition(n.getStart()).line] ?? "");
  const check = (n, what) => {
    if (isFn(n) || plain(n) || okMarked(n) || (ts.isIdentifier(n) && fnNames.has(n.text))) return;
    bad.push(`${where(n)} ${what} is built at the call: ${n.getText().replace(/\s+/g, " ").slice(0, 80)}`);
  };
  const labels = (arr, what) => {
    (function v(el) {
      if (ts.isObjectLiteralExpression(el)) {
        for (const p of el.properties) if (ts.isPropertyAssignment(p) && p.name.getText() === "label") check(p.initializer, `${what} label`);
        return;
      }
      ts.forEachChild(el, v);
    })(arr);
  };
  const spec = (obj, what) => {
    if (!ts.isObjectLiteralExpression(obj)) return;
    for (const p of obj.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const k = p.name.getText();
      if (k === "text" || k === "closeLabel") check(p.initializer, `${what} ${k}`);
      if (k === "actions") labels(p.initializer, what);
      if (k === "link") labels(p.initializer, `${what} link`);
    }
  };
  (function visit(n) {
    if (ts.isCallExpression(n)) {
      const c = n.expression;
      const name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : "";
      const args = n.arguments;
      if (name === "showToast" && args.length >= 1) {
        const [text, undo, kind, actions] = args;
        const short = kind && /^"(info|success)"$/.test(kind.getText());
        const hasUndo = undo && undo.getText() !== "undefined";
        if ((kind && !short) || hasUndo || actions) check(text, `showToast text (${kind ? kind.getText() : "no kind"}${hasUndo ? ", undo" : ""}${actions ? ", buttons" : ""})`);
        if (actions) labels(actions, "showToast");
      }
      // a move's "Archived" toast is made by act(): its 4th argument is that toast's text (which has Undo)
      if (name === "act" && args.length === 4) check(args[3], "act() label (the Undo toast)");
      if (name === "setStickyToast" && args[1]) spec(args[1], "sticky toast");
      if (name === "toast" && args[0]) spec(args[0], "sticky toast");
    }
    ts.forEachChild(n, visit);
  })(sf);
  return bad;
}

// the scanner finds what it is meant to (a test that cannot fail proves nothing)
{
  const flags = (src) => scan(src, "x.ts").length;
  assert.equal(flags(`showToast(t("a.b"), undefined, "error");`), 1, "an error toast from a string");
  assert.equal(flags(`showToast(() => t("a.b"), undefined, "error");`), 0);
  assert.equal(flags(`showToast(t("a.b"), undefined, "success");`), 0, "a short success toast is not one that stays");
  assert.equal(flags(`showToast(t("a.b"), () => undo(), "success");`), 1, "Undo");
  assert.equal(flags(`showToast(() => t("a.b"), undefined, "info", [{ label: t("c.d"), run }]);`), 1, "a button label");
  assert.equal(flags(`showToast(() => t("a.b"), undefined, "info", [{ label: () => t("c.d"), run }]);`), 0);
  assert.equal(flags(`st.showToast(msg, undefined, "error");`), 1, "a finished string in a variable");
  assert.equal(flags(`st.showToast(msg, undefined, "error"); // i18n-ok: from the backend`), 0);
  assert.equal(flags(`const msg = () => t("a.b"); st.showToast(msg, undefined, "error");`), 0, "a name that is a function in this file");
  assert.equal(flags(`const msg = t("a.b"); st.showToast(msg, undefined, "error");`), 1, "a name that is a finished string");
  assert.equal(flags(`useStore.getState().setStickyToast("k", { text: t("a.b"), closeLabel: () => t("common.close") });`), 1, "a sticky text");
  assert.equal(flags(`toast({ text: askText(v), actions: [{ label: () => t("x"), run }] });`), 1, "the update toasts' helper");
  assert.equal(flags(`act(ids, "archive", undefined, t("mail.done.archived"));`), 1, "Archived");
  assert.equal(flags(`act(ids, "archive", undefined, () => t("mail.done.archived"));`), 0);
  assert.equal(flags(`showToast(\`\${title} · \${line}\`, undefined, "info", [{ label: () => t("x"), run }]);`), 0, "a template that only joins names is not a translation");
}

const files = [];
(function walk(d) {
  for (const n of readdirSync(new URL(d, root))) {
    const rel = `${d}${n}`;
    if (statSync(new URL(rel, root)).isDirectory()) {
      if (n !== "i18n") walk(`${rel}/`);
    } else if (/\.(ts|tsx)$/.test(n) && !/^dev[A-Z]/.test(n) && !/devMock/.test(n)) files.push(rel);
  }
})("src/");
assert.ok(files.length > 50);
const offenders = files.flatMap((f) => scan(readFileSync(new URL(f, root), "utf8"), f));
assert.deepEqual(offenders, [], `toasts that keep the language they were made in:\n${offenders.join("\n")}`);

// ---- 3. the wiring ------------------------------------------------------------------------------------------------------------------
const read = (p) => readFileSync(new URL(p, root), "utf8").replace(/\r\n/g, "\n");
const store = read("src/store.ts");
assert.match(store, /showToast: \(text: Lazy,/, "showToast takes a function");
assert.match(store, /act: \(ids: string\[\], action: string, arg\?: string, label\?: Lazy[,)]/, "so does the text of an action's toast");
assert.match(store, /const \{ text: first, textFn \} = toastTexts\(text\);/);
assert.match(store, /\.map\(refreshed\), \{ id, text: first, textFn,/, "older toasts are written again before an identical error is looked for");
assert.match(store, /\.\.\.toastTexts\(spec\.text\)/, "the sticky ones too");
const overlays = read("src/components/overlays.tsx");
assert.match(overlays, /const shown = toastText\(t\);/, "the stack draws the text when it paints");
assert.ok(/useLang\(\)|useT\(\)/.test(overlays) || /tr\(/.test(overlays), "and repaints on a language switch");

console.log(`ok - test-toast-language (${files.length} files scanned, ${SAMPLES.length} samples x ${LANGS.length} languages)`);
