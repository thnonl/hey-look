// No native webview right-click menu in a release build (v1.0.6): the allow / deny decision, the link filter, the app's text menu (Copy, Select all, Copy email
// address), read-only and disabled fields, the keyboard way to the same menu, and that the listeners are installed from the entry file and handle the editable
// case. Rules of src/contextPolicy.ts; the listeners are src/contextGuard.ts, the menu is src/components/GuardMenuHost.tsx.
// Run: node --experimental-strip-types scripts/test-context-guard.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decideContextMenu, emailAtOffset, fieldKind, INTERACTIVE, isEditableNode, nativeMenuWanted, PLUGIN_HOST, safeLinkHref, SELECT_SCOPE } from "../src/contextPolicy.ts";
import { isContextMenuKey } from "../src/contextMenu.ts";

const probe = (over = {}) => ({ dev: false, field: "none", locked: false, link: null, email: null, selection: false, onText: false, ...over });

// release build: everything is swallowed unless the app has a menu for it
assert.equal(decideContextMenu(probe()), "block", "plain click (a button, a picture, empty space): nothing");
assert.equal(decideContextMenu(probe({ selection: true })), "text", "selected text: the app's text menu (Copy)");
assert.equal(decideContextMenu(probe({ onText: true })), "text", "text without a selection: the text menu too (Select all; Copy greyed)");
assert.equal(decideContextMenu(probe({ email: "a@b.com" })), "text", "an address (a recipient chip): the text menu with Copy email address");
assert.equal(decideContextMenu(probe({ link: "https://example.com/" })), "link", "a link: the app's link menu");
assert.equal(decideContextMenu(probe({ link: "https://example.com/", selection: true })), "link", "a link with selected text: the link menu (which also has Copy)");
assert.equal(decideContextMenu(probe({ link: "mailto:a@b.com", onText: true })), "link", "a mailto link is a link first");
// editable fields keep the native menu (spelling suggestions, Paste)
assert.equal(decideContextMenu(probe({ field: "editable" })), "native");
assert.equal(decideContextMenu(probe({ field: "editable", selection: true })), "native", "selected text inside a field: still the field's menu");
assert.equal(decideContextMenu(probe({ field: "editable", onText: true, email: "a@b.com", link: "https://x.y/" })), "native", "nothing of the app's gets in front of a field's own menu");
// read-only and disabled fields
assert.equal(decideContextMenu(probe({ field: "readonly" })), "text", "a read-only field: Copy / Select all of the field");
assert.equal(decideContextMenu(probe({ field: "readonly", selection: true })), "text");
assert.equal(decideContextMenu(probe({ field: "secret" })), "block", "a read-only password field never reaches the clipboard");
assert.equal(decideContextMenu(probe({ field: "secret", selection: true })), "block");
assert.equal(decideContextMenu(probe({ field: "disabled" })), "block", "a disabled control: nothing");
assert.equal(decideContextMenu(probe({ field: "disabled", onText: true, selection: true })), "block");
// content that must not be copied (confidential mail) has no menu at all, whatever else is under the pointer
for (const over of [{ onText: true }, { selection: true }, { link: "https://x.y/" }, { email: "a@b.com" }, { field: "readonly" }])
  assert.equal(decideContextMenu(probe({ locked: true, ...over })), "block", `locked ${JSON.stringify(over)}`);
// development and debug builds: always native, so Inspect works
for (const over of [{}, { selection: true }, { link: "https://x.y/" }, { field: "editable" }, { field: "readonly" }, { field: "disabled" }, { onText: true }, { locked: true }])
  assert.equal(decideContextMenu(probe({ dev: true, ...over })), "native", JSON.stringify(over));

// a document the engine draws itself (a PDF in its viewer) keeps the engine's menu: Rotate, Print, Save as
assert.equal(decideContextMenu(probe({ plugin: true })), "native");
assert.equal(decideContextMenu(probe({ plugin: true, onText: true, selection: true })), "native");
assert.equal(decideContextMenu(probe({ plugin: true, locked: true })), "block", "confidential mail has no menu, a plugin in it included");
assert.equal(decideContextMenu(probe({ plugin: false, onText: true })), "text");
for (const s of ["object", "embed", "iframe.pv-pdf"]) assert.ok(PLUGIN_HOST.includes(s), `plugin host: ${s}`);

// whether the native menu stays everywhere (D-036): Vite's dev mode keeps it, a built app never does unless a debug build is asked with #nativemenu=on
const nm = (hash, dev, debugBuild) => nativeMenuWanted(hash, dev, debugBuild);
assert.equal(nm("", true, false), true, "dev preview: native (Inspect)");
assert.equal(nm("#lang=en", true, true), true, "tauri dev: native");
assert.equal(nm("#nativemenu=off", true, true), false, "dev with the release switch");
assert.equal(nm("#lang=en&nativemenu=off", true, false), false);
assert.equal(nm("#nativemenu=on", true, false), true);
assert.equal(nm("", false, true), false, "a built DEBUG app (the QA builds): the release behaviour by default, so QA sees what ships");
assert.equal(nm("#lang=en", false, true), false);
assert.equal(nm("#nativemenu=off", false, true), false);
assert.equal(nm("#nativemenu=on", false, true), true, "a debug build can ask for Inspect");
assert.equal(nm("#a=1&nativemenu=on&b=2", false, true), true);
assert.equal(nm("#nativemenu=on", false, false), false, "a release build ignores the switch");
assert.equal(nm("", false, false), false);
assert.equal(nm("#xnativemenu=on", false, true), false, "only the exact switch");
assert.equal(nm("#nativemenu=onn", false, true), false);

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

// the fields people write in (Compose Subject, To, Cc, Bcc, the search box, every setting, the body): all of them keep the engine's menu
for (const t of [undefined, "", "text", "TEXT", "search", "email", "url", "tel", "password", "number"]) assert.equal(fieldKind({ tag: "INPUT", type: t }), "editable", `input type ${t}`);
assert.equal(fieldKind({ tag: "input", type: "text", isContentEditable: false, readOnly: false, disabled: false }), "editable", "what the probe passes for the Subject box");
assert.equal(fieldKind({ tag: "DIV", isContentEditable: true, readOnly: undefined, disabled: false }), "editable", "the ProseMirror body: a div that is contenteditable");
assert.equal(fieldKind({ tag: "P", isContentEditable: true }), "editable", "a paragraph inside the editable body (the click lands on the child)");
assert.equal(fieldKind({ tag: "SPAN", isContentEditable: false }), "none", "a label next to a field is not a field");

// the kind of control: editable, read-only, secret, disabled
const fk = (over) => fieldKind({ tag: "INPUT", type: "text", ...over });
assert.equal(fk({}), "editable");
assert.equal(fk({ tag: "TEXTAREA", type: "textarea" }), "editable");
assert.equal(fk({ tag: "DIV", type: undefined, isContentEditable: true }), "editable");
assert.equal(fk({ readOnly: true }), "readonly");
assert.equal(fk({ tag: "TEXTAREA", type: "textarea", readOnly: true }), "readonly");
assert.equal(fk({ type: "search", readOnly: true }), "readonly");
assert.equal(fk({ type: "password", readOnly: true }), "secret", "a read-only password is never copyable");
assert.equal(fk({ type: "password" }), "editable", "a password field one types in keeps the native menu (Paste)");
assert.equal(fk({ disabled: true }), "disabled");
assert.equal(fk({ disabled: true, readOnly: true }), "disabled");
assert.equal(fk({ tag: "BUTTON", type: "submit", disabled: true }), "disabled", "a disabled button");
assert.equal(fk({ tag: "SELECT", type: "select-one", disabled: true }), "disabled", "a disabled select");
assert.equal(fk({ tag: "BUTTON", type: "submit" }), "none");
assert.equal(fk({ tag: "SELECT", type: "select-one" }), "none", "an enabled select: no field, no text: swallowed");
assert.equal(fk({ type: "checkbox" }), "none");
assert.equal(fk({ tag: "DIV", type: undefined, isContentEditable: true, readOnly: true }), "editable", "readonly means nothing on contenteditable");

// an address written in the text
assert.equal(emailAtOffset("To: ann@example.com, bob@example.org", 8), "ann@example.com");
assert.equal(emailAtOffset("To: ann@example.com, bob@example.org", 4), "ann@example.com", "the first letter");
assert.equal(emailAtOffset("To: ann@example.com, bob@example.org", 18), "ann@example.com", "at the end of the word (the caret sits after the last letter)");
assert.equal(emailAtOffset("To: ann@example.com, bob@example.org", 28), "bob@example.org");
assert.equal(emailAtOffset("Linh Tran <linh@example.com>", 20), "linh@example.com", "inside angle brackets");
assert.equal(emailAtOffset("Linh Tran <linh@example.com>", 2), null, "on the name");
assert.equal(emailAtOffset("Linh Tran <linh@example.com>", 9), null, "on the space before the bracket");
assert.equal(emailAtOffset("write to (ann@example.com).", 14), "ann@example.com", "parentheses");
assert.equal(emailAtOffset("write to ann@example.com.", 14), "ann@example.com", "a full stop after it");
assert.equal(emailAtOffset("mail: mailto:ann@example.com", 20), "ann@example.com", "a mailto: prefix is dropped");
assert.equal(emailAtOffset("first.last+tag@sub.example.co.uk is fine", 5), "first.last+tag@sub.example.co.uk");
assert.equal(emailAtOffset("a@b", 1), null, "no dot after the @");
assert.equal(emailAtOffset("@example.com", 3), null, "nothing before the @");
assert.equal(emailAtOffset("price is 5 @ noon", 9), null, "a lone @");
assert.equal(emailAtOffset("", 0), null);
assert.equal(emailAtOffset("ann@example.com", 99), null, "offset past the end");

// the ContextMenu key and Shift+F10 (and nothing else) ask for the menu
const key = (over) => ({ key: "", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...over });
assert.equal(isContextMenuKey(key({ key: "ContextMenu" })), true);
assert.equal(isContextMenuKey(key({ key: "F10", shiftKey: true })), true);
assert.equal(isContextMenuKey(key({ key: "F10" })), false);
assert.equal(isContextMenuKey(key({ key: "F10", shiftKey: true, ctrlKey: true })), false);
assert.equal(isContextMenuKey(key({ key: "a", shiftKey: true })), false);

// where "Select all" reaches, and what is no text target
for (const s of ["[role=dialog]", ".rp-msg", ".summary", ".toast", ".popover", "section", "aside", "[data-select-scope]", ".sig-block"]) assert.ok(SELECT_SCOPE.includes(s), `scope: ${s}`);
for (const s of ["button", "select", "input", "textarea", "[role=button]", "[role=tab]", "[role=menuitem]", "[role=option]", "[role=treeitem]"]) assert.ok(INTERACTIVE.includes(s), `interactive: ${s}`);

// the wiring
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const main = read("src/main.tsx");
assert.match(main, /import \{ installContextGuard \} from "\.\/contextGuard"/);
assert.match(main, /installContextGuard\(\);/, "the entry file installs the listener, before the app is drawn");
assert.ok(main.indexOf("installContextGuard();") < main.indexOf("ReactDOM.createRoot("), "installed before the first render");
assert.match(main, /<GuardMenuHost \/>/, "the menu is mounted once for every window: the main window and the pop-outs");
assert.ok(main.indexOf("<GuardMenuHost />") > main.indexOf("ReactDOM.createRoot("), "inside the render call");
for (const f of ["src/App.tsx", "src/popout/ReaderView.tsx", "src/popout/ComposeView.tsx"]) assert.doesNotMatch(read(f), /GuardMenuHost/, `and not a second time in ${f} (two menus would open: D-036, the reader window showed two)`);
assert.match(main, /if \(route\.kind !== "main"\) await loadPlatform\(\);/, "a secondary window has no init(): it reads the system itself (debug build, macOS / Linux clipboard)");
assert.ok(main.indexOf("loadPlatform()") < main.indexOf("installContextGuard();"), "read before the first right-click can come");
const guard = read("src/contextGuard.ts");
assert.match(guard, /window\.addEventListener\("contextmenu", onContext, true\)/, "one window listener, capture phase");
assert.match(guard, /doc\.addEventListener\("contextmenu", onContext, true\)/, "and the same for a message's frame");
assert.match(guard, /window\.addEventListener\("keydown", onKey, true\)/, "the ContextMenu key / Shift+F10 in the window");
assert.match(guard, /doc\.addEventListener\("keydown", onKey, true\)/, "and in a message's frame");
assert.match(guard, /fieldKind\(/, "the field case is decided by contextPolicy");
assert.match(guard, /decideContextMenu\(\{ dev: false, field: p\.field, locked: p\.locked, link: p\.href, email: p\.email, selection: p\.text\.length > 0, onText: p\.onText \|\| p\.subject !== null, plugin: p\.plugin \}\)/, "the decision function is the one tested here (mouse)");
assert.match(guard, /decideContextMenu\(\{ dev: false, field: p\.field, locked: p\.locked, link: p\.href, email: p\.email, selection: p\.text\.length > 0, onText: p\.subject !== null \}\)/, "and the keyboard asks the same question");
assert.match(guard, /if \(nativeMenuStays\(\)\) return;/, "dev / debug builds keep the native menu");
assert.match(guard, /import\.meta\.env\.DEV/, "the dev detection is Vite's");
assert.match(guard, /nativeMenuWanted\(window\.location\.hash, import\.meta\.env\.DEV, usePlatform\.getState\(\)\.testData !== null\)/, "a debug build of the app is told by the backend's test-data folder; the rule is nativeMenuWanted (tested above)");
assert.match(read("src/contextPolicy.ts"), /nativemenu=\(on\|off\)/, "the switches: =off in the dev preview, =on in a debug build");
assert.match(guard, /catch \{[^}]*isEditableTarget\(e\.target\)[^}]*preventDefault\(\)/, "a probe that throws fails closed (no engine menu) except in a field that takes text");
assert.match(guard, /closest\("\[data-own-menu\]"\)/, "the app's own menus answer their click themselves");
assert.match(guard, /closest\("\.confidential, \[data-no-copy\]"\)/, "confidential mail (outside its frame) has no menu");
// the one-way: swallowing happens before anything else
assert.match(guard, /e\.preventDefault\(\);\s*\n\s*if \(p\.own \|\| policy === "block" \|\| isKeyEcho\(keyAt, Date\.now\(\)\)\) return;/, "swallowed first, then the app's menu if there is one (and not twice for one key press)");
assert.match(guard, /if \(policy === "native" \|\| p\.own\) return;/, "a field answers its own key, the mail list answers its own");
// the screens
assert.match(read("src/components/ReadingPane.tsx"), /lockedNow\.current \? guardFrameQuitKey\(doc\) : guardFrame\(frame, doc, \{ search: true \}\)/, "the message frame has it (and its selection can be searched for), confidential mail has no menu at all (only the Ctrl+Q handler, D-112)");
// W8.1: Copy subject and Search mail for the selection - in the reading areas only, never for locked content, never in an attachment preview
assert.match(read("src/components/ReadingPane.tsx"), /<h2 data-subject=\{subjectText\(summ\.subject\)\}>/, "the subject heading of the reading pane is marked");
assert.match(read("src/popout/ReaderView.tsx"), /data-subject=\{title\}/, "and the one of a reader window");
assert.match(guard, /closest\("\[data-subject\]"\)\?\.getAttribute\("data-subject"\)/, "the probe reads the mark");
assert.match(guard, /inMessageFrame \|\| !!el\?\.closest\("\.reading-pane, \[data-mail-search\]"\)/, "the search is offered in the message frame, the reading pane and a reader window's message area only");
assert.match(guard, /search: p\.searchArea && p\.text \? selectionQuery\(p\.text\) : null/, "and only with text selected");
assert.match(guard, /decideContextMenu\(\{ dev: false, field: p\.field, locked: p\.locked, [^}]*onText: p\.onText \|\| p\.subject !== null/, "the subject heading is text to the menu (a reader window's title is draggable)");
assert.match(read("src/components/Attachments.tsx"), /guardFrame\(f, f\.contentDocument\)/, "the frame of an attachment preview has no search entry");
const hostSrc = read("src/components/GuardMenuHost.tsx");
assert.match(hostSrc, /t\("mail\.ctx\.searchSelection", \{ text: selectionLabel\(menu\.search\) \}\)/, "the entry names the words, cut to 30 characters");
assert.match(hostSrc, /\(searchVia\.run \?\? searchMailHere\)\(menu\.search!\)/, "the main window searches itself, a reader window asks the main page");
assert.match(hostSrc, /t\("mail\.ctx\.copySubject"\)/, "Copy subject uses the key of the row menu");
assert.match(hostSrc, /t\("reading\.msg\.copied"\)[\s\S]*?: fail\(\)/, "Copied on success, mail.ctx.copyFailed on failure");
const textBranch = hostSrc.slice(hostSrc.indexOf("...subject,"));
assert.ok(textBranch.indexOf("common.copy") > 0 && textBranch.indexOf("mail.ctx.selectAll") > textBranch.indexOf("common.copy"), "Copy subject comes first, then Copy and Select all");
assert.ok(textBranch.lastIndexOf("...search,") > textBranch.indexOf("mail.ctx.selectAll"), "the search entry comes after Select all, below a divider");
assert.match(read("src/searchSelection.ts"), /setSearch\(query, true\)/, "the search is remembered (the recent searches of W13.4)");
assert.match(read("src/popout/readerBridge.ts"), /const search = \(query: string\) => void askMain\("search", \{ text: query \}\);\s*answerVia\.mailto = mailto;\s*searchVia\.run = search;/, "a reader window asks the main page");
assert.match(read("src/components/ReadingPane.tsx"), /className="rp-from ellipsis" data-email=\{m\.fromEmail\}/, "the sender of a message in the reader");
assert.match(read("src/components/RecipientField.tsx"), /data-email=\{EMAIL\.test\(bareAddress\(v\)\) \? bareAddress\(v\) : undefined\}/, "a recipient chip in Compose");
assert.match(read("src/components/ListContextMenu.tsx"), /"data-own-menu"/);
assert.match(read("src/components/AccountReorder.tsx"), /"data-own-menu"/);
// links are opened by the reading pane's own click path (look-alike warning, safe external opener); the webview never navigates
assert.match(guard, /open: \(\) => a\.click\(\)/);
const host = read("src/components/GuardMenuHost.tsx");
assert.doesNotMatch(host, /window\.open|location\.href|navigate/);
// the menu: entries, keyboard, and the words in every language
assert.match(host, /keyboard=\{menu\.keyboard\}/, "opened by a key: the first entry has the focus");
for (const k of ["mail.ctx.copyEmail", "mail.ctx.selectAll", "mail.ctx.textMenu", "common.copy", "mail.link.copy"]) assert.match(host, new RegExp(`t\\("${k.replace(".", "\\.")}"\\)`), `uses ${k}`);
assert.match(host, /disabled: !menu\.text/, "Copy is greyed, and stays in the menu, when nothing is selected");
const en = read("src/i18n/ns/mail.ts") + "\n";
for (const k of ["mail.ctx.copyEmail", "mail.ctx.selectAll", "mail.ctx.textMenu"]) {
  assert.equal(en.split(`"${k}"`).length - 1, 1, `${k}: English in the namespace`);
  for (const l of ["vi", "fr", "de", "es", "ja", "ru", "zh-Hans"]) assert.match(read(`src/i18n/locales/${l}/mail.ts`), new RegExp(`"${k.replace(".", "\\.")}": "[^"]+"`), `${k} in ${l}`);
}
// nothing turned spell checking off where people write
assert.doesNotMatch(read("src/components/Compose.tsx") + read("src/components/RichEditor.tsx"), /spellcheck\s*[=:]\s*\{?\s*["']?false/i, "the compose body keeps its spell checking, so its native menu is kept");

console.log("context menu guard rules: ok");
