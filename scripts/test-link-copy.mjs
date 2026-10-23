// QA BUG-L4: after a link that no program could open, the toast said "The link is copied to the clipboard" while the clipboard was
// never set on Linux (the copy was fire-and-forget through navigator.clipboard, whose answer was thrown away). Source check of the
// parts that make the claim true: the toast waits for the copy and only claims what happened, Linux copies through the backend
// (GTK clipboard, main thread), and the command exists and is registered.
// The texts are in the dictionary (src/i18n/ns/updates.ts): the source is checked for the keys, the English wording through en.
// Run: node --experimental-strip-types scripts/test-link-copy.mjs
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { en } from "../src/i18n/en.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const updates = read("src/updates.ts");
const open = read("src/open.ts");
const api = read("src/api.ts");
const lib = read("src-tauri/src/lib.rs");

// 1. the toast: the copy is awaited, "copied" only when it worked, the link is shown when it did not
const fn = updates.slice(updates.indexOf("export async function openUpdateLink"));
const body = fn.slice(0, fn.indexOf("\n}\n"));
assert.match(body, /const copied = await copyToClipboard\(linkToCopy\(url\)\)/, "waits for the copy (of the address for a mailto link, of the link otherwise)");
const openFailed = read("src/openFailed.ts");
assert.match(openFailed, /copied \? \{ key: "updates\.toast\.openFailedCopied" \}/, "REQ wording when it was copied");
assert.equal(en["updates.toast.openFailedCopied"], "Couldn’t open your browser. The link is copied to the clipboard.");
assert.match(openFailed, /key: "updates\.toast\.openFailedNotCopied", vars: \{ url: cut\(url\) \}/, "otherwise the link is in the toast");
assert.match(en["updates.toast.openFailedNotCopied"], /couldn’t be copied\. The link: \{url\}/);
assert.ok(!/void navigator\.clipboard/.test(body), "no fire-and-forget copy");

// 2. Linux and macOS copy through the backend, then the page's clipboard, then the hidden text box (W1.11 REQ-1.11.2); Windows starts at the page's clipboard
const copy = open.slice(open.indexOf("export async function copyToClipboard"));
const iBackend = copy.indexOf("await api.copyText(text)");
const iPage = copy.indexOf("await navigator.clipboard.writeText(text)");
const iBox = copy.indexOf('document.execCommand("copy")');
assert.ok(iBackend > 0 && iBackend < iPage && iPage < iBox, "the three steps are in the order backend, page clipboard, text box");
assert.match(copy, /os === "linux" \|\| os === "macos"[\s\S]*await api\.copyText\(text\)[\s\S]*return true/, "Linux and macOS: backend copy first");
assert.match(copy, /await navigator\.clipboard\.writeText\(text\)[\s\S]*return true[\s\S]*return done[\s\S]*return false/, "the page's clipboard, then the text box, true or false");
assert.match(api, /copyText: \(text: string\) => invoke<void>\("copy_text", \{ text \}\)/);

// 2b. every copy button goes through copyToClipboard: navigator.clipboard.writeText is only in open.ts (the helper), protect.ts (clears the clipboard
// for Confidential mail, kept as it is) and devMock.ts (a comment and the recording wrapper of the dev preview)
const walk = (dir) => readdirSync(new URL(`../${dir}/`, import.meta.url)).flatMap((f) => {
  const rel = `${dir}/${f}`;
  return statSync(new URL(`../${rel}`, import.meta.url)).isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(f) ? [rel] : [];
});
const direct = walk("src").filter((f) => /clipboard\??\.writeText/.test(read(f)) && !["src/open.ts", "src/protect.ts", "src/devMock.ts"].includes(f));
assert.deepEqual(direct, [], `direct navigator.clipboard.writeText in: ${direct.join(", ")}`);
for (const [file, key] of [["src/components/Dialogs.tsx", "app.original.copied"], ["src/components/PgpDialogs.tsx", "pgp.copied"], ["src/components/PgpDialogs.tsx", "pgp.details.publicCopied"], ["src/components/ReadingPane.tsx", "reading.msg.copied"], ["src/popout/ReaderView.tsx", "reading.msg.copied"]]) {
  const src = read(file);
  const at = src.indexOf(`"${key}"`);
  const line = src.slice(src.lastIndexOf("\n", at), src.indexOf("\n", at));
  assert.match(line, /copyToClipboard/, `${file}: ${key} is said only after copyToClipboard`);
  assert.match(line, /\(ok\) => \(ok \?/, `${file}: ${key} only when copyToClipboard returned true`);
  assert.match(line, /mail\.ctx\.copyFailed/, `${file}: the error toast when it did not`);
}
assert.ok(!/async function copyText\(/.test(read("src/components/MessageList.tsx")), "MessageList has no copy of its own any more");
assert.match(read("src/components/MessageList.tsx"), /const copying = copyToClipboard\(q\)/);

// 3. the backend command: registered, the GTK clipboard on the main thread, answer awaited
assert.match(lib, /^\s+copy_text,$/m, "registered as a command");
const cmd = lib.slice(lib.indexOf("async fn copy_text"));
const cmdBody = cmd.slice(0, cmd.indexOf("\n}\n"));
assert.match(cmdBody, /run_on_main_thread/);
assert.match(cmdBody, /gtk::Clipboard::get\(&gtk::gdk::SELECTION_CLIPBOARD\)/);
assert.match(cmdBody, /recv_timeout/, "the answer is awaited");
// macOS (W1.11 REQ-1.11.3): its own branch, the general pasteboard through macclip::write, on the main thread, with the same 3 s limit
assert.match(cmdBody, /#\[cfg\(target_os = "macos"\)\]/, "copy_text has a macos branch");
const macBranch = cmdBody.slice(cmdBody.indexOf('#[cfg(target_os = "macos")]'));
assert.match(macBranch, /run_on_main_thread[\s\S]*macclip::write\(&text\)/, "macOS writes on the main thread");
assert.match(macBranch, /recv_timeout\(std::time::Duration::from_secs\(3\)\)/, "macOS: the same 3 s limit");
const mac = read("src-tauri/src/macclip.rs");
assert.match(mac, /pub fn write\(text: &str\) -> Result<\(\), String>/);
assert.match(mac, /clearContents/);
assert.match(mac, /setString: value, forType: kind/);
assert.match(mac, /public\.utf8-plain-text/);
console.log("link-copy: all checks passed");
