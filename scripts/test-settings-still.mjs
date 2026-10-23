// Settings > Add account and Settings > mailbox > Calendar must stand still while a sign-in runs and ends (no browser needed;
// scripts/test-settings-layout.mjs measures the real layout). The messages used to be rows of the form inserted above and below the button that
// starts the sign-in (the error, the "sign-in ended" notice, "Waiting for ...", a client-id hint that vanished at the first key), and the
// calendar's status block grew and shrank under Sync now. Source check of OAuthBlock, ImapForm and CalendarPanel in
// src/components/SettingsDialog.tsx and of src/App.css: the structure that cannot move.
// Run: node --experimental-strip-types scripts/test-settings-still.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const tsx = read("../src/components/SettingsDialog.tsx");
const css = read("../src/App.css");
const part = (from, to) => {
  const a = tsx.indexOf(from);
  assert.ok(a >= 0, `${from} found`);
  return tsx.slice(a, tsx.indexOf(to, a));
};
const oauth = part("function OAuthBlock(", "\n/** The sentence that says where the detected server settings came from");
const imap = part("function ImapForm(", "\nfunction AddAccountTab()");
const cal = part("function CalendarPanel(", "\n/** Per-mailbox PGP defaults.");

// 1. Add account (Google / Microsoft): the form has no message row; everything the sign-in says is in ONE slot under the card, in one conditional chain
const form = oauth.slice(oauth.indexOf('<div className="form">'), oauth.indexOf('{/* what the sign-in is doing'));
assert.doesNotMatch(form, /\{error &&|\{ended &&|\{busy && <SignInWaiting|role="status"|role="alert"/, "no message row inside the card");
assert.match(oauth, /<div className="signin-slot">\s*\{busy \? <SignInWaiting [^\n]*\n\s*: ended \? <SignInEnded [^\n]*\n\s*: error \? <div className="notice bad" role="alert">\{error\}<\/div>\n\s*: !fromEnv && !cid \? <div className="muted small" role="status">\{t\("settings\.add\.notAvailable"[^\n]*\n\s*: null\}\s*<\/div>/, "waiting, ended, error and the hint for a disabled button take turns in the slot");
assert.ok(oauth.indexOf('className="signin-slot"') > oauth.indexOf("</div>\n      {/* what the sign-in is doing"), "the slot is after the card, not in it");
assert.match(oauth, /if \(!document\.activeElement \|\| document\.activeElement === document\.body\) goBtn\.current\?\.focus\(\);/, "when the sign-in ends the focus goes back to the button that started it");
assert.match(oauth, /<button ref=\{goBtn\} className="btn primary"/, "the ref is on the sign-in button");

// 2. Add account (other account): the error is in the slot under the card, the focus goes back to the Add button
assert.doesNotMatch(imap.slice(0, imap.indexOf('<div className="signin-slot">')), /\{error &&/, "no error row above the Add button");
// (WP5f: while the add waits - for the server, or for a locked keyring - the same slot says Connecting... with a Cancel; the error takes its place when it ends)
assert.match(imap, /<div className="signin-slot">\s*\{error \? \(\s*<div className="notice bad" role="alert">\{error\}<\/div>\s*\) : busy \? \([\s\S]*?onClick=\{cancel\}[\s\S]*?\) : null\}\s*<\/div>/, "the error, or Connecting... with Cancel, is in the slot");
assert.doesNotMatch(imap.slice(0, imap.indexOf('<div className="signin-slot">')), /onClick=\{cancel\}/, "the Cancel is in the slot, not above the Add button");
assert.match(imap, /<button ref=\{addBtn\} className="btn primary" disabled=\{busy \|\| !email \|\| !pw\}/, "the Add button takes the focus back");

// 3. Calendar: one status slot, in one chain; the buttons and the list do not come and go with the consent
const slot = cal.slice(cal.indexOf('className="set-status"'), cal.indexOf("{src && src.calendars.length > 0 && ("));
assert.match(slot, /\{connecting \? \(\s*<SignInWaiting [\s\S]*?\) : ended \? \(\s*<SignInEnded [\s\S]*?\) : err \? \(\s*<div className="field-err" role="alert">\{err\}<\/div>\s*\) : line \? \(/, "waiting, ended, error and the sync status take turns in the one slot");
assert.doesNotMatch(cal.slice(cal.indexOf("</Row>")), /\{err && |\{ended && |!connecting && src/, "no message row after the slot, and the buttons / list do not hide while a consent waits");
assert.match(cal, /\{src && \(\s*<div className="row-inline set-actions">/, "the action row is there whenever the mailbox is connected");
assert.match(cal, /disabled=\{connecting\} onClick=\{\(\) => void connect\(\)\}/, "Allow again is off while the consent waits");
assert.match(cal, /\{src && src\.calendars\.length > 0 && \(/, "the calendar list stays while a consent waits");
assert.match(cal, /useEffect\(\(\) => \{\s*setErr\(null\);\s*setEnded\(null\);\s*\}, \[src\?\.status\]\);/, "an old message goes when the sync state moves on");
assert.match(cal, /const starter = document\.activeElement as HTMLElement \| null;[\s\S]*?opener\.current = starter;/, "the element that started the consent is remembered (taken before the question that comes first)");
assert.match(cal, /back\?\.focus\(\)/, "and gets the focus back when the consent ends");

// 4. the CSS: a slot of fixed minimum size (it holds the longest message in every language), no margin under the notice inside it, an action row of one height
assert.match(css, /\.signin-slot \{[^}]*\bmin-height: [\d.]+em;/, "the sign-in slot has a fixed minimum height");
assert.match(css, /\.set-status \{[^}]*\bmin-height: [\d.]+em;/, "the calendar status slot has a fixed minimum height");
assert.match(css, /\.signin-slot > \.notice, \.set-status > \.notice \{ margin-bottom: 0; \}/, "a notice in a slot adds no margin of its own");
assert.match(css, /\.set-actions \{[^}]*min-height: 33px;/, "the action row keeps the height of a primary button");
console.log("ok - test-settings-still");
