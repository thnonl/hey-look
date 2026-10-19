// Who owns a key while the compose body has the focus (one key, one action) and AltGr never fires a shortcut.
//  D-1 Ctrl+Shift+B in the body did two things (block quote + Show Bcc); D-2 Ctrl+K in the body opened the command bar instead of a link;
//  D-6 Ctrl+Alt+digit / Ctrl+Alt+C (TipTap headings, code block) fired while typing AltGr characters; Ctrl+Enter also inserted a line break.
// Run: node --experimental-strip-types scripts/test-compose-keys.mjs
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { composeSwallowsAppKey, editorKeyHandlers, inEditable, isAltGraph, isHeadingKey, keyAction, moduleSwitchKey } from "../src/composeKeys.ts";

const ev = (key, mods = "", altGraphState = false) => ({
  key,
  ctrlKey: mods.includes("c"),
  metaKey: mods.includes("m"),
  altKey: mods.includes("a"),
  shiftKey: mods.includes("s"),
  getModifierState: (k) => k === "AltGraph" && altGraphState,
});
const body = { inEditor: true };
const other = { inEditor: false };

// --- D-2: Ctrl/Cmd+K -------------------------------------------------------------------------------------------------------------
assert.equal(keyAction(ev("k", "c"), body), "insert-link", "Ctrl+K in the body is the link UI");
assert.equal(keyAction(ev("K", "c"), body), "insert-link", "Caps Lock / uppercase key");
assert.equal(keyAction(ev("k", "m"), body), "insert-link", "Cmd+K in the body (Mac)");
assert.equal(keyAction(ev("k", "c"), other), "command-bar", "Ctrl+K in the list / other fields is the command bar");
assert.equal(keyAction(ev("k", "m"), other), "command-bar", "Cmd+K (Mac) outside the editor");
assert.equal(keyAction(ev("k", ""), body), "pass", "plain k is a letter");
assert.equal(keyAction(ev("k", ""), other), "pass", "plain k outside the editor is the list shortcut (previous), not ours");

// --- W2.14: Ctrl/Cmd+Shift+K is the command bar from anywhere, the body and the signature / template editors included ----------------
for (const m of ["cs", "ms"]) {
  assert.equal(keyAction(ev("K", m), body), "command-bar", `${m}+K in the body`);
  assert.equal(keyAction(ev("k", m), body), "command-bar", `${m}+k (Caps Lock off) in the body`);
  assert.equal(keyAction(ev("K", m), other), "command-bar", `${m}+K in a field / the list`);
}
assert.equal(keyAction(ev("k", "cas"), body), "editor-skip", "Ctrl+Alt+Shift+K is AltGr+Shift+K: it types its character");
assert.equal(keyAction(ev("K", "cas", true), body), "editor-skip", "AltGr+Shift+K (German / Polish layouts) in the body");
assert.equal(keyAction(ev("K", "cas", true), other), "pass", "AltGr+Shift+K elsewhere opens nothing");
assert.equal(keyAction(ev("K", "mas"), body), "editor-skip", "Cmd+Option+Shift+K on a Mac: the Cmd+Option guard");
assert.equal(keyAction(ev("k", "s"), body), "pass", "Shift+K is a capital letter");
assert.equal(keyAction(ev("k", "c"), body), "insert-link", "Ctrl+K keeps its two meanings: the link in an editor ...");
assert.equal(keyAction(ev("k", "c"), other), "command-bar", "... the command bar elsewhere (the To field too)");

// --- D-1: Ctrl/Cmd+Shift+B is the app's Show Bcc; the editor's block quote shortcut must not run ----------------------------------
assert.equal(keyAction(ev("B", "cs"), body), "editor-skip");
assert.equal(keyAction(ev("b", "cs"), body), "editor-skip");
assert.equal(keyAction(ev("B", "ms"), body), "editor-skip", "Cmd+Shift+B (Mac)");
assert.equal(keyAction(ev("b", "c"), body), "pass", "Ctrl+B stays Bold");
assert.equal(keyAction(ev("b", "m"), body), "pass", "Cmd+B stays Bold");
assert.equal(keyAction(ev("B", "cs"), other), "pass", "outside the editor the compose pane handler owns it");

// --- Ctrl+Enter is Send (the editor's hard break must not run), Ctrl+Shift+Enter is Send later ------------------------------------
for (const m of ["c", "m", "cs", "ms"]) assert.equal(keyAction(ev("Enter", m), body), "editor-skip", `Enter with ${m}`);
assert.equal(keyAction(ev("Enter", ""), body), "pass", "plain Enter is a new paragraph");
assert.equal(keyAction(ev("Enter", "s"), body), "pass", "Shift+Enter is a line break (editor)");

// --- D-6: AltGr (Ctrl+Alt on Windows, AltGraph modifier state) never fires an editor or app shortcut ------------------------------
const altGrChars = [["@", "q"], ["ć", "c"], ["²", "2"], ["³", "3"], ["\\", "ß"], ["{", "7"], ["[", "8"], ["]", "9"], ["}", "0"], ["|", "<"], ["~", "+"], ["€", "e"], ["ł", "l"], ["k", "k"], ["B", "b"]];
for (const [key] of altGrChars) {
  assert.equal(keyAction(ev(key, "ca", true), body), "editor-skip", `AltGr ${key} (Ctrl+Alt+AltGraph) in the editor`);
  assert.equal(keyAction(ev(key, "ca", false), body), "editor-skip", `AltGr ${key} (Ctrl+Alt only: the browser does not report AltGraph)`);
  assert.equal(keyAction(ev(key, "a", true), body), "editor-skip", `AltGraph state alone ${key}`);
  assert.equal(keyAction(ev(key, "cas", true), body), "editor-skip", `AltGr+Shift ${key}`);
  assert.equal(keyAction(ev(key, "ca", true), other), "pass", `AltGr ${key} outside the editor does nothing of ours`);
}
// the headings 4-6 / code block / paragraph defaults of TipTap (Mod-Alt-0, 4..6, Mod-Alt-C), also as real Ctrl+Alt and as Cmd+Option
for (const d of ["0", "4", "5", "6", "c", "C"]) {
  for (const m of ["ca", "ma"]) assert.equal(keyAction(ev(d, m), body), "editor-skip", `Mod-Alt-${d} (${m})`);
}
// Heading 1-3 (Ctrl+Alt+1..3, Cmd+Option+1..3): the editor keeps them, but only for the real digit and never when AltGr is down
for (const d of ["1", "2", "3"]) {
  for (const m of ["ca", "ma"]) assert.equal(keyAction(ev(d, m), body), "pass", `Mod-Alt-${d} (${m}) is a heading shortcut`);
  assert.equal(keyAction(ev(d, "ca", true), body), "editor-skip", `AltGr + ${d} (AltGraph state) is not`);
  assert.equal(keyAction(ev(d, "cas"), body), "editor-skip", `Ctrl+Alt+Shift+${d} is not`);
  assert.equal(keyAction(ev(d, "ca"), other), "pass", `outside the editor nothing of ours`);
}
// German AltGr+2 / AltGr+3 type ² and ³ (the key is the character, not the digit); a French digit row types symbols
for (const key of ["²", "³", "é", "\"", "&", "~", "#"]) assert.ok(!isHeadingKey(ev(key, "ca")), `${key} is not a heading shortcut`);
assert.ok(!isHeadingKey(ev("1", "c")) && !isHeadingKey(ev("1", "a")), "the digit alone or with one modifier is not");
assert.equal(keyAction(ev("k", "ca"), body), "editor-skip", "Ctrl+Alt+K is not the link shortcut");
assert.equal(keyAction(ev("k", "ca"), other), "pass", "Ctrl+Alt+K does not open the command bar");
assert.equal(keyAction(ev("k", "ca", true), other), "pass", "AltGr+K does not open the command bar");
assert.ok(isAltGraph(ev("q", "ca")) && isAltGraph(ev("q", "", true)) && !isAltGraph(ev("q", "c")) && !isAltGraph(ev("q", "ma")), "isAltGraph");
assert.ok(!isAltGraph({ key: "q", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }), "an event without getModifierState");

// --- the shortcuts that stay editor shortcuts ------------------------------------------------------------------------------------
const stay = [["i", "c"], ["u", "c"], ["z", "c"], ["y", "c"], ["z", "cs"], ["7", "cs"], ["8", "cs"], ["&", "cs"], ["*", "cs"], ["s", "cs"], ["e", "c"], ["a", "c"], ["Tab", ""], ["Backspace", "c"], ["Delete", "c"]];
for (const [k, m] of stay) assert.equal(keyAction(ev(k, m), body), "pass", `${m}+${k} remains with the editor`);
// the compose pane's own keys are not the editor's business
for (const [k, m] of [["c", "cs"], ["p", "cs"], ["e", "cs"], ["g", "cs"], ["1", "c"], ["Enter", "a"]]) assert.notEqual(keyAction(ev(k, m), body), "insert-link");

// --- editorKeyHandlers: ProseMirror hook ---------------------------------------------------------------------------------------
{
  let linked = 0;
  const h = editorKeyHandlers(() => linked++).keydown;
  const dom = (k, m, st = false) => ({ ...ev(k, m, st), prevented: false, preventDefault() { this.prevented = true; } });
  const k = dom("k", "c");
  assert.equal(h(null, k), true, "Ctrl+K handled");
  assert.ok(k.prevented && linked === 1, "Ctrl+K opens the link UI and stops the browser default");
  const alt = dom("@", "ca", true);
  assert.equal(h(null, alt), true, "AltGr: ProseMirror skips its keymaps");
  assert.equal(alt.prevented, false, "AltGr: the character is still typed (no preventDefault)");
  const bq = dom("B", "cs");
  assert.equal(h(null, bq), true);
  assert.equal(bq.prevented, false, "the pane handler, not the editor, prevents and acts");
  const bold = dom("b", "c");
  assert.equal(h(null, bold), false, "Ctrl+B is left to the editor");
  assert.equal(linked, 1);
  // Ctrl+Shift+K: the editor does not make a link and does not stop the key, which goes on to the page (App.tsx opens the command bar; a compose window has none
  // and types nothing: the key has no character)
  const bar = dom("K", "cs");
  assert.equal(h(null, bar), false, "Ctrl+Shift+K is not the editor's");
  assert.equal(bar.prevented, false);
  assert.equal(linked, 1, "no link UI");
}
assert.equal(inEditable(null), false);
assert.equal(inEditable({}), false, "not an element");

// --- source guards: wiring ---------------------------------------------------------------------------------------------------
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const compose = read("src/components/Compose.tsx");
const rich = read("src/components/RichEditor.tsx");
const app = read("src/App.tsx");
assert.match(compose, /handleDOMEvents: editorKeyHandlers\(/, "the compose body installs the key guard");
assert.match(rich, /handleDOMEvents: editorKeyHandlers\(/, "the signature / template editor installs the key guard");
assert.match(compose, /link: \{ open: \(\) => linkRef\.current\(\)/, "the toolbar link button and Ctrl+K share one link UI");
assert.match(rich, /link: \{ open: \(\) => linkRef\.current\(\)/, "the signature / template editor too");
assert.match(compose, /if \(isAltGraph\(e\)\) return;/, "the compose pane shortcuts ignore AltGr");
assert.match(app, /keyAction\(e, \{ inEditor: inEditable\(e\.target\) \}\)/, "the global Ctrl+K decision knows if an editor has the focus");
assert.doesNotMatch(app, /e\.key\.toLowerCase\(\) === "k"\) \{\s*e\.preventDefault\(\);\s*st\.setCommandOpen/, "no unconditional Ctrl+K command bar");
// W2.14: the global handler opens the command bar for the key and the bar gives the focus back where it was (the editor through TipTap: the selection is as it was)
assert.match(app, /if \(ka === "command-bar"\) \{\s*e\.preventDefault\(\);\s*st\.setCommandOpen\(true\);/, "App.tsx opens the command bar for the command-bar action, in or out of an editor");
const bar = read("src/components/CommandBar.tsx");
assert.match(bar, /const from = useRef<Element \| null>\(typeof document === "undefined" \? null : document\.activeElement\);/, "the bar remembers where the focus was");
assert.match(bar, /closest\("\.tiptap"\)/, "...and puts an editor back through TipTap");
assert.match(bar, /else if \(e\.key === "Escape"\) close\(\);/, "Esc gives the focus back");
// W2.13 / W2.14: Settings > Shortcuts lists the keys the compose pane and the app own. Every key of `keyAction` and of the compose pane handler has a row (the list below is that set).
const settings = read("src/components/SettingsDialog.tsx");
const rows = settings.slice(settings.indexOf("function ShortcutsTab()"), settings.indexOf("function ShortcutsTab()") + 6000);
for (const [keys, label] of [
  ["Ctrl+Shift+C / Ctrl+Shift+B", "settings.keys.addCcBcc"],  // W2.13: Show Cc / Bcc while writing
  ["Ctrl+Shift+K", "settings.keys.commandBarAnywhere"],          // W2.14
  ["Ctrl+K", "settings.keys.commandBar"],
  ["Ctrl+K", "settings.keys.insertLink"],
  ["Ctrl+Enter", "settings.keys.send"],
  ["Ctrl+Shift+Enter", "settings.keys.sendLater"],
  ["Ctrl+Shift+P", "settings.keys.insertPicture"],
  ["Ctrl+Shift+E", "settings.keys.encrypt"],
  ["Ctrl+Shift+G", "settings.keys.sign"],
  ["Ctrl+Shift+O", "settings.keys.popOutCompose"],
  ["Alt+F10", "settings.keys.focusToolbar"],
]) assert.ok(rows.includes(`["${keys}", "${label}"]`), `Settings > Shortcuts has no row ${keys} / ${label}`);
assert.ok(rows.indexOf('"settings.keys.sign"') < rows.indexOf('"settings.keys.addCcBcc"') && rows.indexOf('"settings.keys.addCcBcc"') - rows.indexOf('"settings.keys.sign"') < 80, "the Cc / Bcc row follows the Sign row");
assert.ok(rows.indexOf('"settings.keys.commandBar"') < rows.indexOf('"settings.keys.commandBarAnywhere"') && rows.indexOf('"settings.keys.commandBarAnywhere"') - rows.indexOf('"settings.keys.commandBar"') < 80, "the Ctrl+Shift+K row is next to the Ctrl+K command bar row");
// the keys the compose pane handler acts on are the ones with rows above
for (const re of [/key\.toLowerCase\(\) === "c" \|\| \(e\.key\.toLowerCase\(\) === "b"/, /e\.key\.toLowerCase\(\) === "g"/, /e\.key\.toLowerCase\(\) === "o"/]) assert.match(compose, re);
for (const l of ["en", "vi", "fr", "de", "es", "ja", "ru", "zh-Hans"]) {
  const f = ["en", "vi", "fr"].includes(l) ? "src/i18n/ns/settings.ts" : `src/i18n/locales/${l}/settings.ts`;
  const t = read(f);
  assert.ok(t.includes('"settings.keys.addCcBcc"') && t.includes('"settings.keys.commandBarAnywhere"'), `${l} has both texts`);
}
// Settings > Shortcuts keeps documenting Ctrl+K as the command bar; the Bcc tooltip documents Ctrl+Shift+B
assert.match(read("src/i18n/ns/compose.ts"), /"compose\.addBcc": "Add Bcc \(Ctrl\+Shift\+B\)"/);

// --- source guard: every TipTap default that collides is covered by the guard --------------------------------------------------
// Read the keymaps of the installed TipTap extensions: any Mod-Alt-* / Mod-Shift-b / Mod-Enter must be skipped by keyAction.
const tiptap = new URL("../node_modules/@tiptap/", import.meta.url);
if (existsSync(tiptap)) {
  const toEvent = (spec, meta) => {
    const parts = spec.split("-");
    const key = parts.pop();
    const has = (n) => parts.includes(n);
    return ev(key, `${meta ? "m" : "c"}${has("Alt") ? "a" : ""}${has("Shift") ? "s" : ""}`);
  };
  const specs = new Set();
  for (const dir of readdirSync(tiptap)) {
    const f = new URL(`${dir}/dist/index.js`, tiptap);
    if (!existsSync(f)) continue;
    for (const m of readFileSync(f, "utf8").matchAll(/["'`]((?:Mod|Shift|Alt|Ctrl)-[A-Za-z0-9${}._-]+)["'`]\s*[:\]]/g)) specs.add(m[1]);
  }
  // (Mod-Alt-1..3 are the exception: extensions.ts takes them over, isHeadingKey above)
  const collide = [...specs].filter((s) => /^Mod-Alt-/.test(s) || /^Mod-Shift-[bB]$/.test(s) || s === "Mod-Enter");
  assert.ok(collide.some((s) => s === "Mod-Shift-b") && collide.some((s) => s === "Mod-Enter") && collide.some((s) => s === "Mod-Alt-c" || s === "Mod-Alt-${level}"), `found the colliding TipTap defaults: ${collide}`);
  for (const spec of collide) {
    const keys = spec.includes("${level}") ? ["4", "5", "6"].map((l) => spec.replace("${level}", l)) : [spec];
    for (const s of keys) for (const meta of [false, true]) assert.equal(keyAction(toEvent(s, meta), body), "editor-skip", `TipTap ${s} (${meta ? "Cmd" : "Ctrl"}) must be skipped`);
  }
}
// --- A-24 (BUG-06): Ctrl+2 with the focus on a compose toolbar button blanked what was typed ------------------------------------------
// Cause: the global handler switched to the Calendar and Compose was unmounted / mounted again with its initial content. Two fixes: Compose
// stays mounted across the module switch (one place in the tree), and the compose pane is modal for the app's mailbox keys.
{
  const free = { inField: false, inCompose: false, modalOpen: false };
  const inPane = { ...free, inCompose: true };
  assert.equal(moduleSwitchKey(ev("1", "c"), free), "go-mail");
  assert.equal(moduleSwitchKey(ev("2", "c"), free), "go-calendar");
  assert.equal(moduleSwitchKey(ev("2", "m"), free), "go-calendar", "Cmd+2 (Mac)");
  assert.equal(moduleSwitchKey(ev("2", "c"), inPane), null, "focus on a compose toolbar / Attach / chip button: no module switch");
  assert.equal(moduleSwitchKey(ev("1", "c"), inPane), null);
  assert.equal(moduleSwitchKey(ev("2", "c"), { ...free, inField: true }), null, "in a field");
  assert.equal(moduleSwitchKey(ev("2", "c"), { ...free, modalOpen: true }), null, "a dialog is open");
  assert.equal(moduleSwitchKey(ev("2", ""), free), null, "plain 2 is a character");
  assert.equal(moduleSwitchKey(ev("2", "cs"), free), null);
  assert.equal(moduleSwitchKey(ev("2", "ca", true), free), null, "AltGr + 2 types a character");
  assert.equal(moduleSwitchKey(ev("3", "c"), free), null);

  const sw = (key, mods, ctx) => composeSwallowsAppKey(ev(key, mods), ctx);
  const open = { composeOpen: true, inCompose: false, module: "mail" };
  assert.equal(sw("c", "", { ...open, composeOpen: false }), false, "no compose: nothing is swallowed");
  assert.equal(sw("e", "", open), true, "archive is off while a message is open");
  assert.equal(sw("j", "", open), false, "j / k outside the pane still go on to the next conversation (F-21)");
  assert.equal(sw("k", "", open), false);
  assert.equal(sw("j", "c", open), true);
  assert.equal(sw("j", "", { ...open, module: "calendar" }), true, "j / k are mailbox keys only in Mail");
  for (const k of ["j", "k", "e", "c", "#", "Delete", "u", "p", "/"]) assert.equal(sw(k, "", { ...open, inCompose: true }), true, `${k} with the focus inside the compose pane`);
  assert.equal(sw("a", "c", { ...open, inCompose: true }), true, "Ctrl+A (select all conversations) from a compose button");

  // The regression itself: a model of the app's window handler (App.tsx) with the composer open and a toolbar button focused.
  const world = () => ({ module: "mail", composeMounts: 1, doc: "typed text", subject: "A-24 probe", handled: [] });
  const press = (w, e, ctx) => {
    const go = moduleSwitchKey(e, { inField: false, inCompose: ctx.inCompose, modalOpen: false });
    if (go) {
      w.module = go === "go-calendar" ? "calendar" : "mail";
      w.handled.push("module");
      return;
    }
    if (composeSwallowsAppKey(e, { composeOpen: true, inCompose: ctx.inCompose, module: w.module })) return;
    if (e.key === "e") w.handled.push("archive");
    if (e.key === "j" || e.key === "k") w.handled.push("next");
  };
  for (const [key, mods] of [["2", "c"], ["1", "c"], ["2", "m"], ["e", ""], ["j", ""], ["k", ""], ["c", ""], ["a", "c"], ["Delete", ""], ["Backspace", ""], ["#", ""]]) {
    const w = world();
    press(w, ev(key, mods), { inCompose: true });
    assert.deepEqual(w, world(), `${mods}+${key} with a compose toolbar button focused changes nothing (document, subject, module, composer)`);
  }
  const w = world();
  press(w, ev("2", "c"), { inCompose: false });
  assert.equal(w.module, "calendar", "from the list the shortcut still works ...");
  assert.equal(w.composeMounts, 1, "... and the composer is the same instance (see the source guard below)");
}
// Source guard: the composer sits in ONE place of the App tree, so a module switch cannot unmount it; the decisions above are what App.tsx uses.
assert.equal((app.match(/<Compose\b/g) ?? []).length, 1, "App.tsx renders <Compose> in exactly one place");
assert.match(app, /\(compose \|\| module === "mail"\) &&/, "the reading region (Compose or the reading pane) is the same element in Mail and Calendar");
assert.match(app, /moduleSwitchKey\(e, \{ inField: false, inCompose, modalOpen \}\)/);
assert.match(app, /composeSwallowsAppKey\(e, \{ composeOpen: !!st\.compose, inCompose, module: st\.module \}\)/);
assert.match(app, /tgt\.closest\("\.compose-pane"\)/, "inCompose = the focus is inside .compose-pane");
assert.match(compose, /className=\{`compose-pane /, "the pane the guard looks for exists in Compose");

// --- W2.24: Cmd+Option+Shift+V on a Mac is "Paste and Match Style": the editor's text-only paste must see it; every other Cmd+Option key stays blocked, and on Windows / Linux
// Ctrl+Alt+Shift+V stays blocked (it is AltGr+Shift+V and types its character)
{
  const code = (key, mods, c, altGraphState = false) => ({ ...ev(key, mods, altGraphState), code: c });
  const macBody = { inEditor: true, os: "macos" };
  const winBody = { inEditor: true, os: "windows" };
  const linuxBody = { inEditor: true, os: "linux" };
  assert.equal(keyAction(code("◊", "mas", "KeyV"), macBody), "paste-text", "Cmd+Option+Shift+V (the key reads \"◊\" with Option held)");
  assert.equal(keyAction(code("V", "mas", "KeyV"), macBody), "paste-text", "... or \"V\" where the layout reports the letter");
  assert.equal(keyAction(code("v", "mas", "KeyV"), macBody), "paste-text");
  assert.equal(keyAction(code("v", "mas", "KeyV", false), other), "pass", "outside an editor the key is not ours");
  assert.equal(keyAction(code("v", "mas", "KeyV"), { inEditor: true }), "editor-skip", "without an os (the app-level handler) nothing changes");
  assert.equal(keyAction(code("v", "ma", "KeyV"), macBody), "editor-skip", "Cmd+Option+V without Shift stays blocked");
  assert.equal(keyAction(code("c", "mas", "KeyC"), macBody), "editor-skip", "Cmd+Option+Shift+C stays blocked");
  assert.equal(keyAction(code("k", "mas", "KeyK"), macBody), "editor-skip", "Cmd+Option+Shift+K stays blocked");
  assert.equal(keyAction(code("v", "cmas", "KeyV"), macBody), "editor-skip", "with Ctrl as well it is not the paste key");
  assert.equal(keyAction(code("1", "ma", "Digit1"), macBody), "pass", "Cmd+Option+1 is still Heading 1");
  assert.equal(keyAction(code("2", "ma", "Digit2"), macBody), "pass");
  assert.equal(keyAction(code("v", "cas", "KeyV"), winBody), "editor-skip", "Ctrl+Alt+Shift+V on Windows (AltGr+Shift+V) stays blocked");
  assert.equal(keyAction(code("V", "cas", "KeyV", true), winBody), "editor-skip", "AltGr+Shift+V on a German layout types its character");
  assert.equal(keyAction(code("v", "cas", "KeyV"), linuxBody), "editor-skip", "and on Linux");
  assert.equal(keyAction(code("v", "mas", "KeyV"), winBody), "editor-skip", "a Meta+Alt+Shift+V on Windows is not the Mac key");
  assert.equal(keyAction(code("v", "mas", "KeyV"), linuxBody), "editor-skip");
  // the ProseMirror hook leaves the key to the paste handler on a Mac only
  const ed = (os) => editorKeyHandlers(() => undefined, () => os).keydown(null, { ...code("◊", "mas", "KeyV"), preventDefault() {} });
  assert.equal(ed("macos"), false, "mac: the hook does not skip it");
  assert.equal(ed("windows"), true, "windows: skipped");
  assert.equal(ed("linux"), true, "linux: skipped");
  assert.equal(editorKeyHandlers(() => undefined).keydown(null, { ...code("◊", "mas", "KeyV"), preventDefault() {} }), true, "no os given: skipped as before");
  // Settings > Shortcuts: the Paste text only row shows both keys on a Mac only (the label is the same)
  const settings = readFileSync(new URL("../src/components/SettingsDialog.tsx", import.meta.url), "utf8");
  assert.ok(settings.includes('[os === "macos" ? "Ctrl+Shift+V / Ctrl+Option+Shift+V" : "Ctrl+Shift+V", "settings.keys.pasteText"]'), "the key column of the Paste text only row");
}

console.log("compose-keys: all checks passed");
