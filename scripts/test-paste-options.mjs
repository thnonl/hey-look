// The paste handling of the editors (spec-rich-text.md REQ-23, AC-38 .. AC-41): what each option gives (`editorHtml`), the format around the caret that Merge
// and Text only take (`inherit`, on the editor's real schema, no DOM), the paste default in the preferences, and the wiring of the plugin (the hooks, Esc, Ctrl
// alone, Ctrl+Shift+V) and of the texts. The plugin itself needs a browser: it was driven in the dev mock (the report of WP5c lists what).
// Run: node --experimental-strip-types scripts/test-paste-options.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSchema } from "@tiptap/core";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import { TextStyleKit } from "@tiptap/extension-text-style";
import StarterKit from "@tiptap/starter-kit";
import { Fragment, Slice } from "@tiptap/pm/model";
import { editorHtml } from "../src/editor/pasteClean.ts";
import { inherit } from "../src/editor/pasteMarks.ts";
import { BlockFormat } from "../src/editor/blockExtension.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(root, f), "utf8");
const BASE = { family: "Calibri,Carlito,Arial,sans-serif", size: 11 };

// ---- what each option gives
const word = '<p class=MsoNormal style="margin:0cm"><b>Bold</b> <span style="color:red;font-family:Arial">red</span><o:p></o:p></p><p>two</p><!--EndFragment-->';
assert.equal(editorHtml({ html: word, text: "Bold red\ntwo" }, "source", false, BASE), '<p><strong>Bold</strong> <span style="font-family:Arial;color:#FF0000">red</span></p><p>two</p>');
assert.equal(editorHtml({ html: word, text: "Bold red\ntwo" }, "merge", false, BASE), "<p><strong>Bold</strong> red</p><p>two</p>");
assert.equal(editorHtml({ html: word, text: "Bold red\ntwo" }, "text", false, BASE), "<p>Bold red</p><p>two</p>");
// Text only comes from the structure, the plain text is the fallback
assert.equal(editorHtml({ html: "<ul><li>a</li><li>b</li></ul>", text: "ignored" }, "text", false, BASE), "<p>- a</p><p>- b</p>");
assert.equal(editorHtml({ html: "<img src='https://x.test/a.png'>", text: "alt text" }, "source", false, BASE), "<p>alt text</p>", "nothing left of the HTML: the plain text");
assert.equal(editorHtml({ html: "<img src='https://x.test/a.png'>", text: "" }, "source", false, BASE), "");
// a copy made inside the editor is not touched (ProseMirror's own markers keep the shape of the slice)
const own = '<p data-pm-slice="1 1 []" style="color:red;font-size:30pt">x</p>';
assert.equal(editorHtml({ html: own, text: "x" }, "source", false, BASE), own);
assert.equal(editorHtml({ html: own, text: "x" }, "merge", false, BASE), own);
assert.equal(editorHtml({ html: own, text: "x" }, "text", false, BASE), "<p>x</p>");
// tables stay when the editor has them
assert.ok(editorHtml({ html: "<table><tr><td>a</td></tr></table>", text: "a" }, "source", true, BASE).startsWith("<table>"));
assert.ok(!editorHtml({ html: "<table><tr><td>a</td></tr></table>", text: "a" }, "source", false, BASE).includes("<table"));

// ---- the format around the caret
const schema = getSchema([StarterKit.configure({ strike: false, code: false, heading: { levels: [1, 2, 3] } }), Subscript, Superscript, TextStyleKit.configure({ lineHeight: false }), BlockFormat]);
const style = { type: "textStyle", attrs: { fontFamily: "Arial", fontSize: "14pt", color: "#0000FF" } };
const doc = schema.nodeFromJSON({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "styled", marks: [style, { type: "bold" }, { type: "link", attrs: { href: "https://x.test/" } }] }, { type: "text", text: "plain" }] }],
});
const at = (offset) => doc.resolve(1 + offset); // marks() at a position inside the first paragraph
const slice = new Slice(
  Fragment.from([
    schema.nodeFromJSON({ type: "paragraph", content: [{ type: "text", text: "own", marks: [{ type: "textStyle", attrs: { color: "#FF0000" } }] }, { type: "text", text: "bare" }] }),
  ]),
  0, 0,
);
const marksOf = (s) => {
  const out = {};
  s.content.firstChild.forEach((n) => (out[n.text] = n.marks.map((m) => m.type.name).sort().join("+")));
  return out;
};
assert.deepEqual(marksOf(inherit(slice, at(3).marks(), "source")), { own: "textStyle", bare: "" }, "Keep source takes nothing");
// inside "styled" (bold, link, font, size, colour)
assert.deepEqual(marksOf(inherit(slice, at(3).marks(), "merge")), { own: "textStyle", bare: "textStyle" }, "Merge: the font, size and colour around the caret only, and not over a text's own");
assert.deepEqual(marksOf(inherit(slice, at(3).marks(), "text")), { own: "bold+textStyle", bare: "bold+textStyle" }, "Text only: like typing there, but never a link");
// the caret in plain text: nothing to take
assert.deepEqual(marksOf(inherit(slice, at(8).marks(), "merge")), { own: "textStyle", bare: "" });
assert.deepEqual(marksOf(inherit(slice, at(8).marks(), "text")), { own: "textStyle", bare: "" });
const m = inherit(slice, at(3).marks(), "merge").content.firstChild.lastChild.marks[0];
assert.ok(m.attrs.fontFamily === "Arial" && m.attrs.fontSize === "14pt" && m.attrs.color === "#0000FF", "the whole text style of the caret");

// ---- the paste default in the preferences
const prefs = read("src/prefs.ts");
assert.ok(prefs.includes('pasteDefault: "source"'), "Keep source formatting is the default (spec REQ-23 a)");
assert.ok(/pasteDefault: p\.pasteDefault === "merge" \|\| p\.pasteDefault === "text" \? p\.pasteDefault : "source"/.test(prefs), "an unknown stored value is Keep source");

// ---- the wiring
const ext = read("src/editor/extensions.ts");
assert.ok(ext.includes("PasteHandling.configure({ getBase: o.getBase })"), "every editor of the shared extension set has the paste handling");
const plug = read("src/editor/pasteOptions.tsx");
for (const hook of ["transformPastedHTML", "clipboardTextParser", "transformPasted:", "handleKeyDown", 'paste: (_v, e) => begin(e, false)', 'drop: (_v, e) => begin(e, true)']) assert.ok(plug.includes(hook), `hook ${hook}`);
assert.ok(plug.includes('e.key !== "Escape"') && plug.includes("stopPropagation"), "Esc dismisses the button and does nothing else");
assert.ok(/isMod = .*"Control".*osNow\(\) === "macos" && e\.key === "Meta"/.test(plug), "Ctrl alone (Cmd on a Mac) opens the menu");
assert.ok(plug.includes("lone = isMod(e) ? lone || !e.repeat : false") && plug.includes("was && isMod(e)"), "only a Ctrl pressed and released alone, not the Ctrl of Ctrl+V");
assert.ok(plug.includes('mode: "text" as const, plain: true') && plug.includes("!current.plain"), "Ctrl+Shift+V is text only and has no button");
assert.ok(plug.includes("tr.getMeta(\"appendedTransaction\")") && plug.includes("return null; // typing or any other edit"), "typing or another edit hides the button, a transaction added by a plugin (autolink) does not");
assert.ok(plug.includes('aria-haspopup="menu"') && plug.includes("aria-label={t(\"compose.paste.options\")}") && plug.includes('role="status"'), "accessible name, popup, live announcement");
assert.ok(plug.includes("const asked = useRef(nonce)") && plug.includes("nonce !== asked.current"), "a new paste's button starts closed, whatever the count of the earlier Ctrl presses");
assert.ok(plug.includes("<FloatingMenu") && plug.includes("trigger={trigger}"), "the menu is the app's menu: arrows, Esc, focus back to the text");
const dlg = read("src/components/SettingsDialog.tsx");
assert.ok(dlg.includes("function PasteDefaultRow") && dlg.includes("{scope === null && <PasteDefaultRow />}") && dlg.includes('"settings.keys.pasteText"'), "Settings: the row and the shortcut");
assert.ok(read("src/components/Compose.tsx").includes("transformPastedHTML") && read("src/components/Compose.tsx").includes("cleanPastedHtml"), "Compose's own pass (remote pictures, the notice) still runs first");

// ---- the texts, in all 8 languages
const KEYS = ["compose.paste.picturesRemoved", "compose.paste.options", "compose.paste.optionsTip", "compose.paste.available", "compose.paste.keepSource", "compose.paste.merge", "compose.paste.textOnly", "settings.composing.paste", "settings.composing.pasteHint", "settings.keys.pasteText", "settings.keys.pasteOptions"];
const files = ["src/i18n/ns/compose.ts", "src/i18n/ns/settings.ts", ...["de", "es", "ja", "ru", "zh-Hans"].flatMap((l) => [`src/i18n/locales/${l}/compose.ts`, `src/i18n/locales/${l}/settings.ts`])];
const all = files.map(read).join("\n");
for (const k of KEYS) {
  const n = (all.match(new RegExp(`"${k.replace(/\./g, "\\.")}"`, "g")) ?? []).length;
  assert.equal(n, 8, `${k} is in ${n} of 8 languages`);
}
assert.ok(read("src/i18n/ns/compose.ts").includes("Some pictures couldn’t be pasted. Use Picture to insert them."), "AC-41 text");

console.log("test-paste-options: ok");
