// No native webview right-click menu in a release build (v1.0.6): the allow / deny decision, the link filter, and that the listener is installed from the
// entry file and handles the editable case. Rules of src/contextPolicy.ts; the listener is src/contextGuard.ts.
// Run: node --experimental-strip-types scripts/test-context-guard.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decideContextMenu, isEditableNode, safeLinkHref } from "../src/contextPolicy.ts";

const probe = (over = {}) => ({ dev: false, editable: false, link: null, selection: false, ...over });

// release build: everything is swallowed unless the app has a menu for it
assert.equal(decideContextMenu(probe()), "block", "plain click: nothing");
assert.equal(decideContextMenu(probe({ selection: true })), "copy", "selected text: the app's Copy");
assert.equal(decideContextMenu(probe({ link: "https://example.com/" })), "link", "a link: the app's link menu");
assert.equal(decideContextMenu(probe({ link: "https://example.com/", selection: true })), "link", "a link with selected text: the link menu (which also has Copy)");
// editable fields keep the native menu (spelling suggestions, Paste)
assert.equal(decideContextMenu(probe({ editable: true })), "native");
assert.equal(decideContextMenu(probe({ editable: true, selection: true })), "native", "selected text inside a field: still the field's menu");
// development and debug builds: always native, so Inspect works
for (const over of [{}, { selection: true }, { link: "https://x.y/" }, { editable: true }]) assert.equal(decideContextMenu(probe({ dev: true, ...over })), "native", JSON.stringify(over));

// links the app offers to open
assert.equal(safeLinkHref("https://example.com/a?b=1"), "https://example.com/a?b=1");
assert.equal(safeLinkHref("HTTP://example.com"), "HTTP://example.com");
assert.equal(safeLinkHref(" mailto:a@b.com "), "mailto:a@b.com");
for (const bad of ["javascript:alert(1)", "data:text/html,<b>x</b>", "file:///C:/Windows/win.ini", "blob:https://x/1", "tel:+123", "ftp://x/y", "#top", "/relative", "", null, undefined])
  assert.equal(safeLinkHref(bad), null, String(bad));

// what counts as an editable field
const ed = (tag, type, isContentEditable) => isEditableNode({ tag, type, isContentEditable });
assert.equal(ed("INPUT", "text"), true);
assert.equal(ed("input", undefined), true, "an input without a type is text");
assert.equal(ed("INPUT", "search"), true);
assert.equal(ed("INPUT", "password"), true);
assert.equal(ed("TEXTAREA"), true);
assert.equal(ed("DIV", undefined, true), true, "contenteditable: the compose body");
assert.equal(ed("DIV", undefined, false), false);
assert.equal(ed("INPUT", "checkbox"), false);
assert.equal(ed("INPUT", "radio"), false);
assert.equal(ed("INPUT", "button"), false);
assert.equal(ed("INPUT", "range"), false);
assert.equal(ed("INPUT", "color"), false);
assert.equal(ed("BUTTON"), false);
assert.equal(ed("A"), false);

// the wiring
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const main = read("src/main.tsx");
assert.match(main, /import \{ installContextGuard \} from "\.\/contextGuard"/);
assert.match(main, /installContextGuard\(\);/, "the entry file installs the listener, before the app is drawn");
assert.ok(main.indexOf("installContextGuard();") < main.indexOf("ReactDOM.createRoot("), "installed before the first render");
const guard = read("src/contextGuard.ts");
assert.match(guard, /window\.addEventListener\("contextmenu", onContext, true\)/, "one window listener, capture phase");
assert.match(guard, /doc\.addEventListener\("contextmenu", onContext, true\)/, "and the same for a message's frame");
assert.match(guard, /isEditableNode\(/, "the editable case is decided by contextPolicy");
assert.match(guard, /decideContextMenu\(\{ dev: false, editable: p\.editable/, "the decision function is the one tested here");
assert.match(guard, /if \(nativeMenuStays\(\)\) return;/, "dev / debug builds keep the native menu");
assert.match(guard, /import\.meta\.env\.DEV/, "the dev detection is Vite's");
assert.match(guard, /usePlatform\.getState\(\)\.testData !== null/, "a debug build of the app is told by the backend's test-data folder");
assert.match(guard, /nativemenu=off/, "the dev preview can switch to release behaviour");
assert.match(guard, /closest\("\[data-own-menu\]"\)/, "the app's own menus answer their click themselves");
// the one-way: swallowing happens before anything else
assert.match(guard, /e\.preventDefault\(\);\s*\n\s*if \(p\.own \|\| policy === "block"\) return;/, "swallowed first, then the app's menu if there is one");
// the screens
assert.match(read("src/App.tsx"), /<GuardMenuHost \/>/);
assert.match(read("src/components/ReadingPane.tsx"), /lockedNow\.current \? undefined : guardFrame\(frame, doc\)/, "the message frame has it, confidential mail has no menu at all");
assert.match(read("src/components/ListContextMenu.tsx"), /"data-own-menu"/);
assert.match(read("src/components/AccountReorder.tsx"), /"data-own-menu"/);
// links are opened by the reading pane's own click path (look-alike warning, safe external opener); the webview never navigates
assert.match(guard, /open: \(\) => a\.click\(\)/);
assert.doesNotMatch(read("src/components/GuardMenuHost.tsx"), /window\.open|location\.href|navigate/);
// nothing turned spell checking off where people write
assert.doesNotMatch(read("src/components/Compose.tsx") + read("src/components/RichEditor.tsx"), /spellcheck\s*[=:]\s*\{?\s*["']?false/i, "the compose body keeps its spell checking, so its native menu is kept");

console.log("context menu guard rules: ok");
