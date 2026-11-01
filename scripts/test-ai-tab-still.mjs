// Settings > AI Assistant must stand still while it is used (no browser needed; scripts/test-ai-tab-layout.mjs measures the real layout).
// It used to jump: "Loading models..." / the error / "no models" were rows inserted between the Model field and Save on every keystroke
// in Base URL and API key, "Remove the saved key" was inserted under the key box after Save, a model list arriving swapped the Model
// text box for a <select> under someone who was typing in it, and removing the key left the focus on nothing. Source check of
// AiTab in src/components/SettingsDialog.tsx and of src/App.css: the structure that cannot move.
// Run: node --experimental-strip-types scripts/test-ai-tab-still.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const tsx = read("../src/components/SettingsDialog.tsx");
const css = read("../src/App.css");

const start = tsx.indexOf("function AiTab()");
const tab = tsx.slice(start, tsx.indexOf("\nfunction KeyRow(", start));
assert.ok(tab.length > 500, "AiTab found");
const form = tab.slice(tab.indexOf('<div className="form">'));

// 1. the form's direct children come and go never: the only conditionals are inside the key field's label line and the Model control's own swap
const nested = form
  .replace(/<div className="field">[\s\S]*?<\/div>\n\s*<input ref=\{keyRef\}[^\n]*\n\s*<\/div>/, "<FIELD/>")
  .replace(/<div className="ai-actions">[\s\S]*?<\/div>\n\s*<\/div>/, "<ACTIONS/>");
assert.ok(nested.includes("<FIELD/>") && nested.includes("<ACTIONS/>"), "the key field and the Save + status group are wrapped in one element each");
const direct = nested.slice(0, nested.indexOf("</div>\n    </div>")); // the children of .form
const conditionals = direct.split("\n").filter((l) => /^ {8}\{/.test(l) && /&&|\?/.test(l) && !/^ {8}\{\/\*/.test(l));
assert.deepEqual(conditionals.map((l) => l.trim().slice(0, 12)), ["{asList ? ("], "the only conditional child of the form is the Model control (list or text box)");

// 2. no message row is rendered conditionally: the status element is always there, after Save, and says nothing when there is nothing to say
assert.equal((tab.match(/role="status"/g) || []).length, 1, "one live region (not one per message)");
assert.doesNotMatch(tab, /modelsState === "(loading|error|idle)" &&\s*<div/, "no message row is inserted for Loading / error / no models");
assert.match(tab, /<div className="ai-actions">\s*<button className="btn primary"[^\n]*\n\s*<div className=\{\`ai-status small \$\{saveErr \? "bad" : "muted"\}\`\} role="status"[^\n]*>\{status\}<\/div>\s*<\/div>/, "Save, then the status slot (the slot is under the button: nothing above it can move)");
assert.match(tab, /const status = saveErr \? saveErr\n\s*: modelsState === "invalid" \? t\("backend\.AI_MODELS_URL_BAD"\)\n\s*: modelsState === "loading" \? [^\n]*\n\s*: modelsState === "error" \? [^\n]*\n\s*: models\.length === 0 && v\.ai_endpoint\.trim\(\) \? t\("settings\.ai\.noModels"\) : "";/, "the messages (a failed save, an invalid list URL, loading, error, no models) are texts of one slot");
// 2b. (W8.11; the place changed in 1.0.7 fix53) Advanced sits between Model and Save, so that what Save stores is above Save: a <details> that is always there (closed unless a list URL is saved); opening it moves Save and the status slot down and nothing above it
assert.ok(tab.indexOf('<details className="advanced"') < tab.indexOf('<div className="ai-actions">'), "Advanced comes before Save and the status slot");
assert.ok(tab.indexOf('<details className="advanced"') > tab.indexOf('id="set-aiModel"'), "Advanced comes after the Model control");
assert.equal((tab.match(/<details /g) || []).length, 1, "one disclosure");
assert.match(tab, /<details className="advanced" open=\{advOpen\} onToggle=\{\(e\) => setAdvOpen\(e\.currentTarget\.open\)\}>/, "it is controlled: closed on load unless a list URL is saved, and it opens when the person opens it");
assert.match(tab, /setAdvOpen\(!!u\?\.trim\(\)\);/, "it opens by itself only for a saved list URL");
assert.match(tab.slice(tab.indexOf("</details>")), /^<\/details>\n        <div className="ai-actions">[\s\S]*?<\/div>\n        <\/div>\n      <\/div>/, "Save and its status slot follow it, and are the last thing in the form");
assert.match(tab, /\{other && \(\s*<>\s*<div className="muted small"><ShieldAlert[\s\S]*?<Switch checked=\{sendKey\}/, "the warning and the switch are inside it, only for another server");
assert.doesNotMatch(tab.slice(tab.indexOf('<button className="btn primary"'), tab.indexOf("</button>", tab.indexOf('<button className="btn primary"'))), /disabled/, "Save is never disabled by the list");
assert.match(tab, /setModelsErr\(cutAtWord\(friendlyError\(e\), \d+\)\)/, "the error reason is cut so the two-line slot always shows the instruction after it");

// 3. "Remove the saved key" sits on the key label's line (appears after Save without moving anything), and gives the focus back to the key box
assert.match(tab, /<div className="field-head">\s*<label>\{t\("settings\.ai\.apiKey"\)\}<\/label>\s*\{hasKey && \(\s*<button className="link small" onClick=\{\(\) => void removeKey\(\)\}>/, "the link is in .field-head, next to the label");
assert.match(tab, /const removeKey = async \(\) => \{[\s\S]*?try \{\s*await api\.setSecret\("ai_key", ""\);\s*setHasKey\(false\);\s*keyRef\.current\?\.focus\(\);\s*\} catch/, "Remove the saved key gives the focus to the key box, and a failure is caught");
assert.doesNotMatch(form, /<input[^\n]*type="password"[^\n]*\/>\s*\{hasKey/, "no link row after the key box");

// 4. the Model control keeps its kind while it has focus (focus and caret stay; the list that arrives is adopted when focus leaves)
assert.match(tab, /const asList = modelFocused \? heldList : models\.length > 0;/, "the kind is held while the control has focus");
assert.match(tab, /onFocus: \(\) => \(setHeldList\(asList\), setModelFocused\(true\)\), onBlur: \(\) => setModelFocused\(false\)/, "focus / blur drive it");
assert.equal((tab.match(/\{\.\.\.modelFocus\}/g) || []).length, 2, "both the list and the text box report focus");
assert.doesNotMatch(form, /\bkey=\{(?!m\b)/, "no control is re-mounted by a changing key");

// 4b. a failed save is said in the slot (and keeps what was typed): the save is in a try, the boxes are only emptied after it worked, typing clears the message
assert.match(tab, /const save = async \(\) => \{\s*setSaveErr\(""\);\s*try \{[\s\S]*?\} catch \(e\) \{[\s\S]*?setSaveErr\(t\("settings\.ai\.saveFailed", \{ error: cutAtWord\(friendlyError\(e\), \d+\) \}\)\);/, "save() catches and says why in the slot");
assert.ok(tab.indexOf('await api.setSecret("ai_key", key.trim());') < tab.indexOf('setKey("");'), "the key box is emptied only after the key was stored");
assert.match(tab, /const edit = \(patch: Partial<typeof v>\) => \(setSaveErr\(""\), setV\(\{ \.\.\.v, \.\.\.patch \}\)\);/, "editing a field clears the save error");
assert.match(css, /\.ai-status\.bad \{ color: var\(--danger\); \}/, "the save error is red");

// 5. the CSS: a fixed-height slot, clamped, and a label line that is one flex row
assert.match(css, /\.ai-status \{[^}]*\bheight: 2\.8em;[^}]*line-height: 1\.4;[^}]*overflow: hidden;[^}]*-webkit-line-clamp: 2;/, "the slot is exactly two lines high and cuts, it never grows");
assert.match(css, /\.field-head \{[^}]*display: flex;[^}]*justify-content: space-between;/, "label left, action right, one line");
console.log("ok - test-ai-tab-still");
