// QA BUG-L4: after a link that no program could open, the toast said "The link is copied to the clipboard" while the clipboard was
// never set on Linux (the copy was fire-and-forget through navigator.clipboard, whose answer was thrown away). Source check of the
// parts that make the claim true: the toast waits for the copy and only claims what happened, Linux copies through the backend
// (GTK clipboard, main thread), and the command exists and is registered.
// The texts are in the dictionary (src/i18n/ns/updates.ts): the source is checked for the keys, the English wording through en.
// Run: node --experimental-strip-types scripts/test-link-copy.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { en } from "../src/i18n/en.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const updates = read("src/updates.ts");
const open = read("src/open.ts");
const api = read("src/api.ts");
const lib = read("src-tauri/src/lib.rs");

// 1. the toast: the copy is awaited, "copied" only when it worked, the link is shown when it did not
const fn = updates.slice(updates.indexOf("export async function openUpdateLink"));
const body = fn.slice(0, fn.indexOf("\n}\n"));
assert.match(body, /const copied = await copyToClipboard\(url\)/, "waits for the copy");
assert.match(body, /copied \? t\("updates\.toast\.openFailedCopied"\)/, "REQ wording when it was copied");
assert.equal(en["updates.toast.openFailedCopied"], "Couldn’t open your browser. The link is copied to the clipboard.");
assert.match(body, /t\("updates\.toast\.openFailedNotCopied", \{ url:/, "otherwise the link is in the toast");
assert.match(en["updates.toast.openFailedNotCopied"], /couldn’t be copied\. The link: \{url\}/);
assert.ok(!/void navigator\.clipboard/.test(body), "no fire-and-forget copy");

// 2. Linux copies through the backend, the others through the page; both report the result
const copy = open.slice(open.indexOf("export async function copyToClipboard"));
assert.match(copy, /osNow\(\) === "linux"[\s\S]*await api\.copyText\(text\)[\s\S]*return true/, "Linux: backend copy");
assert.match(copy, /await navigator\.clipboard\.writeText\(text\)[\s\S]*return true[\s\S]*return false/, "the page's clipboard, true or false");
assert.match(api, /copyText: \(text: string\) => invoke<void>\("copy_text", \{ text \}\)/);

// 3. the backend command: registered, the GTK clipboard on the main thread, answer awaited
assert.match(lib, /^\s+copy_text,$/m, "registered as a command");
const cmd = lib.slice(lib.indexOf("async fn copy_text"));
const cmdBody = cmd.slice(0, cmd.indexOf("\n}\n"));
assert.match(cmdBody, /run_on_main_thread/);
assert.match(cmdBody, /gtk::Clipboard::get\(&gtk::gdk::SELECTION_CLIPBOARD\)/);
assert.match(cmdBody, /recv_timeout/, "the answer is awaited");
console.log("link-copy: all checks passed");
