// AutoFormat as you type (spec-107-wp3.md W3.2, AC-3.2.1 .. AC-3.2.9): the pure function for every pattern in the 8 languages, the contexts (opening / closing, apostrophe and the open single quote,
// French no-break space, the `--` rules, the exclusions), and the very plugin the editor uses on a real EditorState (a fake view with `state` / `dispatch`, as test-insert-group.mjs does):
// the replacement is made when the completing character is typed, Ctrl+Z right after it gives back the typed characters and a second one is the ordinary undo, Backspace does not
// restore, the switch, the Code style / inline code / link text, an input method, a selection, a language switch.
// Run: node --experimental-strip-types scripts/test-autoformat.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { history, undo } from "@tiptap/pm/history";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { QUOTE_STYLES, autoFormatFor, autoFormatKey, autoFormatPlugin, styleFor, undoAutoFormat } from "../src/editor/autoFormat.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(root, f), "utf8").replace(/\r\n/g, "\n");
const NB = " ";

/** Types a string through the pure function only: the text of one paragraph. */
function typed(lang, str, start = "") {
  let text = start;
  for (const ch of [...str]) {
    const e = autoFormatFor(text, ch, lang);
    text = e ? text.slice(0, text.length - e.del) + e.insert : text + ch;
  }
  return text;
}

// ---- AC-3.2.1 .. AC-3.2.3: English
assert.equal(typed("en", '"Hello" -- (c) ... '), "“Hello” – © … ", "AC-3.2.1");
assert.equal(typed("en", "don't"), "don’t", "an apostrophe");
assert.equal(typed("en", "'quoted'"), "‘quoted’", "single quotes");
assert.equal(typed("en", "-> "), "→ ");
assert.equal(typed("en", "--> "), "→ ");
assert.equal(typed("en", "<- "), "← ");
assert.equal(typed("en", "(r) "), "® ");
assert.equal(typed("en", "(tm) "), "™ ");
assert.equal(typed("en", "(C) (R) (TM) "), "(C) (R) (TM) ", "upper case stays: list labels");
assert.equal(typed("en", "(c)"), "©", "the completing character is part of the pattern, it is not kept");
assert.equal(typed("en", "wait... what"), "wait… what");
assert.equal(typed("en", "a.... b"), "a…. b", "a fourth dot is a dot");
assert.equal(typed("en", "(\"x\")"), "(“x”)", "a quote after a bracket opens, before a bracket closes");
assert.equal(typed("en", 'say "hi"'), "say “hi”");
assert.equal(typed("en", "x/\"y\""), "x/“y”", "a quote after / opens");
assert.equal(typed("en", "a –\"b"), "a –“b", "a quote after an en dash opens");
assert.equal(typed("en", "“\"b"), "““b", "after an opening quote of any language it opens");
assert.equal(typed("en", "a \"b"), "a “b", "after a no-break space it opens");

// ---- AC-3.2.9: every language gives exactly the characters of T-Q
const SAMPLE = "\"Test\" 'a' x -- y ";
const expected = {
  en: "“Test” ‘a’ x – y ",
  vi: "“Test” ‘a’ x – y ",
  fr: `«${NB}Test${NB}» ‘a’ x – y `,
  "zh-Hans": "“Test” ‘a’ x —— y ",
  es: "«Test» ‘a’ x — y ",
  ja: "“Test” ‘a’ x -- y ",
  de: "„Test“ ‚a‘ x – y ",
  ru: "«Test» ’a’ x — y ",
};
for (const [lang, want] of Object.entries(expected)) assert.equal(typed(lang, SAMPLE), want, `AC-3.2.9 ${lang}`);
for (const lang of Object.keys(expected)) assert.equal(typed(lang, "don't"), "don’t", `the apostrophe in ${lang}`);
assert.deepEqual(Object.keys(QUOTE_STYLES).sort(), Object.keys(expected).sort(), "T-Q covers the 8 languages and nothing else");
assert.equal(styleFor("en-XA"), QUOTE_STYLES.en, "the pseudo-locale is English");
assert.equal(styleFor("xx"), QUOTE_STYLES.en, "an unknown language is English");

// the open-single-quote rule: de ‚Wort‘ closes, geht's is an apostrophe
assert.equal(typed("de", "'Wort'"), "‚Wort‘");
assert.equal(typed("de", "es geht's"), "es geht’s");
assert.equal(typed("de", "'Das geht's nicht'"), "‚Das geht‘s nicht’", "the rule of the spec: the first apostrophe after the opening quote closes it, the last one is then an apostrophe (the ambiguity is the same in Word)");
assert.equal(typed("de", "'a' und geht's"), "‚a‘ und geht’s", "a closed quote is closed: the next one is an apostrophe");
assert.equal(typed("ru", "'x' it's"), "’x’ it’s", "Russian: ' is always the apostrophe");
// French: the guillemets bring the no-break space, a typed no-break space is not doubled
assert.equal(typed("fr", '"Oui"'), `«${NB}Oui${NB}»`);
assert.equal(typed("fr", `dit :${NB}"Oui"`), `dit :${NB}«${NB}Oui${NB}»`, "after a no-break space it opens");
assert.equal(typed("fr", `«${NB}Oui"`), `«${NB}Oui${NB}»`);

// ---- the `--` rules
assert.equal(typed("en", "-- "), "-- ", "-- at the start of a paragraph (a plain-text signature separator) stays");
assert.equal(typed("en", "  -- "), "  -- ", "only spaces before it: stays");
assert.equal(typed("en", "---"), "---", "--- stays (the Markdown rule makes the line)");
assert.equal(typed("en", "a---b"), "a---b");
assert.equal(typed("en", "a ---- b"), "a ---- b", "four hyphens stay");
assert.equal(typed("en", "a -- b"), "a – b");
assert.equal(typed("en", "a--b"), "a--b", "a letter right after the hyphens: not converted (qa--1@example.test must stay)");
assert.equal(typed("en", "qa--1@example.test"), "qa--1@example.test");
assert.equal(typed("en", "a--, b"), "a–, b", "punctuation after the hyphens converts");
assert.equal(typed("en", "a --\"b\""), "a –“b”", "the dash, then the quote typed behind it opens");
assert.equal(typed("en", "a --> b"), "a → b", "--> wins over the dash");
assert.equal(typed("ja", "a -- b"), "a -- b", "Japanese: no replacement");
assert.equal(typed("zh-Hans", "a -- b"), "a —— b");

// ---- exclusions: addresses and URLs
assert.equal(typed("en", "https://a.test/x--y... "), "https://a.test/x--y... ", "AC-3.2.5: a URL");
assert.equal(typed("en", "see www.a.test/a-- b"), "see www.a.test/a-- b", "www.");
assert.equal(typed("en", "mailto:a--b..."), "mailto:a--b...", "mailto:");
assert.equal(typed("en", 'user@x.test"'), 'user@x.test"', "a run with @");
assert.equal(typed("en", "http://x.test (c)"), "http://x.test ©", "the next word is not part of the URL run");
assert.equal(autoFormatFor("a --", " ", "en", { code: true }), null, "code");
assert.equal(autoFormatFor("a --", " ", "en", { link: true }), null, "link text");
assert.equal(autoFormatFor("", "ab", "en"), null, "only one typed character");
assert.equal(autoFormatFor("", "\u{1F600}", "en"), null, "an emoji is no trigger");
assert.equal(autoFormatFor("x", "a", "en"), null, "an ordinary letter");

// ---- the plugin on a real state
const schema = getSchema([StarterKit.configure({ strike: false, hardBreak: false, heading: { levels: [1, 2, 3] } })]);
const para = (text) => schema.node("paragraph", null, text ? [schema.text(text)] : []);
function editor({ lang = "en", on = true, doc = [para("")] } = {}) {
  const opts = { on, lang };
  const view = {
    composing: false,
    state: EditorState.create({ doc: schema.node("doc", null, doc), plugins: [history(), autoFormatPlugin({ enabled: () => opts.on, lang: () => opts.lang })] }),
    dispatch(tr) {
      this.state = this.state.apply(tr);
    },
  };
  const plugin = view.state.plugins.find((p) => p.spec.key === autoFormatKey);
  /** One keystroke: the plugin first, the default insertion when it declines (what ProseMirror does). */
  view.type = (str) => {
    for (const ch of [...str]) {
      const { from, to } = view.state.selection;
      if (!plugin.props.handleTextInput(view, from, to, ch)) view.dispatch(view.state.tr.insertText(ch, from, to));
    }
    return view;
  };
  view.text = () => view.state.doc.textBetween(0, view.state.doc.content.size, "\n", "\n");
  view.opts = opts;
  view.plugin = plugin;
  return view;
}

{
  const v = editor();
  v.type('"Hello" -- (c) ... ');
  assert.equal(v.text(), "“Hello” – © … ", "the plugin: AC-3.2.1");
  assert.equal(v.state.selection.from, v.state.doc.content.size - 1, "the caret is at the end");
}
// AC-3.2.4: Ctrl+Z right after a replacement gives back the typed text, the caret behind it, typing on does not convert it again; a second Ctrl+Z is the ordinary undo
{
  const v = editor();
  v.type("hi a -- ");
  assert.equal(v.text(), "hi a – ", "-- became the dash when the space was typed");
  assert.ok(undoAutoFormat(v), "Ctrl+Z is the replacement's undo");
  assert.equal(v.text(), "hi a -- ", "the typed characters are back: the hyphens and the space");
  assert.equal(v.state.selection.from, v.text().length + 1, "the caret is behind them");
  assert.equal(autoFormatKey.getState(v.state), null, "nothing left to undo that way");
  v.type("x");
  assert.equal(v.text(), "hi a -- x", "typing on does not convert the spot again");
  v.type(" -- ");
  assert.equal(v.text(), "hi a -- x – ", "a new pattern later still converts");
}
{
  // a second Ctrl+Z is the ordinary undo of the typing
  const v = editor();
  v.type("hi a -- ");
  assert.ok(undoAutoFormat(v));
  assert.equal(v.text(), "hi a -- ");
  assert.equal(undoAutoFormat(v), false, "the second press is not ours");
  undo(v.state, (tr) => v.dispatch(tr));
  assert.equal(v.text(), "", "the ordinary undo took the typing (one group)");
}
{
  // every pattern: Ctrl+Z gives back exactly what was typed
  for (const [str, converted] of [['"', "“"], ["a --", null], ["(c)", "©"], ["...", "…"], ["->", "→"], ["-->", "→"], ["<-", "←"], ["(tm)", "™"], ["don'", "don’"]]) {
    const v = editor();
    const typedStr = str === "a --" ? "a -- " : str;
    v.type(typedStr);
    if (converted) assert.equal(v.text(), converted, `${str} converted`);
    assert.ok(undoAutoFormat(v), `${str}: undo`);
    assert.equal(v.text(), typedStr, `${str}: Ctrl+Z gives the typed characters back`);
    assert.equal(v.state.selection.from, typedStr.length + 1, `${str}: the caret is behind them`);
  }
}
{
  // a click or a key between: Ctrl+Z is the history's, not ours
  const v = editor();
  v.type("a -- ");
  v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1)));
  assert.equal(undoAutoFormat(v), false, "the caret moved: not the very last thing");
  const w = editor();
  w.type("x -- ");
  w.type("y");
  assert.equal(undoAutoFormat(w), false, "a typed character after the replacement: not the very last thing");
}
{
  // Backspace does not restore: it deletes the character before the caret
  const v = editor();
  v.type("(c)");
  assert.equal(v.text(), "©");
  v.dispatch(v.state.tr.delete(v.state.selection.from - 1, v.state.selection.from));
  assert.equal(v.text(), "", "Backspace deletes the sign, it does not bring back (c)");
  assert.equal(undoAutoFormat(v), false);
}
{
  // the setting off: nothing anywhere; on again: it converts, no new editor needed
  const v = editor({ on: false });
  v.type('"x" -- (c) ... ');
  assert.equal(v.text(), '"x" -- (c) ... ', "AC-3.2.8: off");
  v.opts.on = true;
  v.type('"y" -- ');
  assert.equal(v.text(), '"x" -- (c) ... “y” – ', "on again, without reopening");
}
{
  // a language switch changes only new replacements
  const v = editor();
  v.type('"a" ');
  v.opts.lang = "de";
  v.type('"b"');
  assert.equal(v.text(), "“a” „b“", "text typed before a switch is unchanged, new text follows the new language");
}
{
  // not in the Code style
  const doc = [schema.node("codeBlock")];
  const v = editor({ doc });
  v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1)));
  v.type('"x" -- (c) ... ');
  assert.equal(v.text(), '"x" -- (c) ... ', "AC-3.2.5: the Code style");
}
{
  // not in inline code (a stored mark, and text that has the mark)
  const v = editor();
  v.dispatch(v.state.tr.setStoredMarks([schema.marks.code.create()]));
  v.type('"x" -- (c) ... ');
  assert.equal(v.text(), '"x" -- (c) ... ', "inline code");
}
{
  // not inside link text; after the link (not inclusive) it works
  const link = schema.marks.link.create({ href: "https://a.test" });
  const v = editor({ doc: [schema.node("paragraph", null, [schema.text("ab", [link])])] });
  v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 2)));
  v.type("(c)");
  assert.equal(v.text(), "a(c)b", "inside link text");
}
{
  // an input method: nothing while it composes and for a moment after
  const v = editor();
  v.composing = true;
  v.type("-- ");
  assert.equal(v.text(), "-- ", "view.composing");
  v.composing = false;
  v.plugin.props.handleDOMEvents.compositionstart();
  v.type("a -- ");
  v.plugin.props.handleDOMEvents.compositionend();
  assert.equal(v.text(), "-- a -- ", "composition events");
  v.type('"');
  assert.equal(v.text(), '-- a -- "', "right after compositionend: still nothing (the commit goes through the same path)");
  await new Promise((r) => setTimeout(r, 220));
  v.type("x \"");
  assert.equal(v.text(), '-- a -- "x “', "later it works again");
}
{
  // a selection that is replaced by typing is the editor's own business
  const v = editor({ doc: [para("a --")] });
  v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, 5)));
  v.type('"');
  assert.equal(v.text(), '"', "typing over a selection: the plain character");
}
{
  // a line break is a space for the opening quote
  const v = editor({ doc: [schema.node("paragraph", null, [schema.text("a"), schema.nodes.hardBreak ? schema.nodes.hardBreak.create() : schema.text("\n")])] });
  v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, v.state.doc.content.size - 1)));
  v.type('"b"');
  assert.ok(v.text().endsWith("“b”"), v.text());
}
{
  // a heading is text too; the replacement keeps the marks of the text it replaces
  const bold = schema.marks.bold.create();
  const v = editor({ doc: [schema.node("heading", { level: 1 }, [schema.text("a ", [bold])])] });
  v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 3)));
  v.type("(c)");
  const mark = v.state.doc.nodeAt(3 - 1)?.marks.some((m) => m.type.name === "bold");
  assert.equal(v.text(), "a ©");
  assert.ok(mark, "the sign is bold where the typed text was bold");
}

// ---- D-091: the first quote typed after focusing the body (Mac: "Hello" came out as H”ello”) - the opening / closing decision from every start of a paragraph
{
  const OPEN = { en: "“", de: "„", fr: "«" + NB, ja: "「" };
  // each context gives an OPENING quote, in the languages whose quote differs most
  const contexts = [
    ["the very first key after focus in an empty body", "", ""],
    ["a space", "word ", " "],
    ["after (", "(", "("],
    ["after a line break (a hard break counts as \n)", "line one\n", "\n"],
    ["after a no-break space", "a" + NB, NB],
    ["after an invisible zero-width space at the start (a marker left by a signature or a paste)", "\u200B", "\u200B"],
    ["after a zero-width non-joiner and a BOM", "\u200C\uFEFF", "\u200C\uFEFF"],
    ["after a direction mark", "\u200E", "\u200E"],
    ["after a word joiner behind a space", "x \u2060", "\u2060"],
  ];
  for (const [what, before] of contexts) {
    for (const lang of ["en", "de", "fr", "vi", "ru", "es"]) {
      const e = autoFormatFor(before, '"', lang);
      assert.ok(e && e.del === 0, `${what} (${lang}): a replacement`);
      assert.equal(e.insert, styleFor(lang).dOpen, `${what} (${lang}): an OPENING quote`);
    }
  }
  // the closing cases
  const closing = [["after a letter", "Hello"], ["after a digit", "x2"], ["after a full stop", "Hello."], ["after a closing bracket", "(a)"], ["after a letter with an invisible mark behind it", "Hello\u200B"], ["after a closing single quote", "‘a’"]];
  for (const [what, before] of closing) for (const lang of ["en", "de", "vi"]) assert.equal(autoFormatFor(before, '"', lang).insert, styleFor(lang).dClose, `${what} (${lang}): a CLOSING quote`);
  // the single quote: the same contexts
  assert.equal(autoFormatFor("", "'", "en").insert, "‘", "the first key: an opening single quote");
  assert.equal(autoFormatFor("\u200B", "'", "en").insert, "‘", "behind an invisible mark: an opening single quote");
  assert.equal(autoFormatFor("don", "'", "en").insert, "’", "an apostrophe in a word");
  assert.equal(autoFormatFor("Hello\u200B", "'", "en").insert, "’", "an invisible mark does not hide the letter before it");
  // the whole word, from every start
  for (const start of ["", " ", "(", "\n", "\u200B", "\u200B ", "line\n"]) assert.ok(typed("en", '"Hello"', start).endsWith("“Hello”"), `typed after ${JSON.stringify(start)}`);
  for (const lang of ["en", "de", "vi", "fr"]) {
    const o = styleFor(lang);
    assert.equal(typed(lang, '"Hello"'), o.dOpen + "Hello" + o.dClose, `${lang}: "Hello" from the first key`);
  }
  void OPEN;
}
// the same on a real state: the first key after a fresh editor (the focus), after Enter and a hard break, after a signature paragraph and its separator, behind an invisible character
{
  const sigDoc = [para("Body"), para("-- "), para("Ann Smith"), para("")];
  const cases = [
    ["a fresh empty body", { doc: [para("")] }, (v) => v],
    ["a body that starts with a zero-width space", { doc: [para("\u200B")] }, (v) => v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 2)))],
    ["the empty paragraph under the signature", { doc: sigDoc }, (v) => v.dispatch(v.state.tr.setSelection(TextSelection.atEnd(v.state.doc)))],
    ["the start of the paragraph of a signature separator", { doc: [para("Body"), para("-- x")] }, (v) => v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 7)))],
  ];
  for (const [what, o, place] of cases) {
    const v = editor(o);
    place(v);
    v.type('"Hello"');
    assert.ok(v.text().includes("“Hello”"), `${what}: ${JSON.stringify(v.text())}`);
  }
  // the very first key is handled with nothing before it, not with the text of the paragraph before: the plugin reads the paragraph of the caret only
  const v = editor({ doc: [para("Hello world"), para("")] });
  v.dispatch(v.state.tr.setSelection(TextSelection.atEnd(v.state.doc)));
  v.type('"');
  assert.equal(v.text(), "Hello world\n“", "after the previous paragraph's last letter: still an opening quote in the new paragraph");
  // after Enter in the middle of typing
  const w = editor();
  w.type("a");
  w.dispatch(w.state.tr.split(w.state.selection.from));
  w.type('"b"');
  assert.equal(w.text(), "a\n“b”");
  // the closing quote of a word typed in one go
  const x = editor();
  x.type('say "Hello" and "bye"');
  assert.equal(x.text(), "say “Hello” and “bye”");
}

// ---- the wiring
{
  const ext = read("src/editor/extensions.ts");
  assert.ok(/AutoFormat\(\{ enabled: \(\) => useStore\.getState\(\)\.prefs\.autoFormat !== false, lang: getLang \}\)/.test(ext), "baseExtensions has AutoFormat, read from the pref and the app language at every keystroke");
  const prefs = read("src/prefs.ts");
  assert.ok(prefs.includes("autoFormat: true,") && /autoFormat: typeof p\.autoFormat === "boolean" \? p\.autoFormat : true/.test(prefs), "default on; a missing or non-boolean value reads on");
  const dlg = read("src/components/SettingsDialog.tsx");
  assert.ok(/<AutoFormatRow \/>/.test(dlg) && dlg.indexOf("<PasteDefaultRow />") < dlg.indexOf("<AutoFormatRow />"), "the Settings row is right after \"When pasting from other apps\", app level only");
  assert.ok(/scope === null && <AutoFormatRow/.test(dlg), "not per mailbox");
  const src = read("src/editor/autoFormat.ts");
  assert.ok(!/@tiptap\/extension-typography|InputRule|inputRules/.test(src.replace(/\/\/.*$/gm, "")), "not built on input rules");
  assert.ok(!/from "\.\.\/(store|i18n)/.test(src), "the module needs no store: the options come from extensions.ts");
}
console.log("test-autoformat: ok");
