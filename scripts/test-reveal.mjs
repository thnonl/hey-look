// "Show in folder" is never silent (W1.10, 1.0.7). Every reveal goes through revealSaved (src/reveal.ts); when the backend could not show the file, an error toast says
// which file and why, in the app language. The module is run as it is: its three imports (the api, the store, the i18n index) are swapped for fakes by a small loader hook.
// The Rust side (the folder fallback on Linux) is `cargo test --lib linuxopen`.
// Run: node --experimental-strip-types scripts/test-reveal.mjs
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

const ROOT = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), "utf8").replace(/\r\n/g, "\n");

// ---- the module with fake neighbours
const fake = (code) => "data:text/javascript," + encodeURIComponent(code);
const hooks = `
export async function resolve(specifier, context, next) {
  if (context.parentURL && context.parentURL.endsWith("/src/reveal.ts")) {
    if (specifier === "./api") return { url: ${JSON.stringify(fake("export const api = globalThis.__fakeApi;"))}, shortCircuit: true };
    if (specifier === "./store") return { url: ${JSON.stringify(fake("export const friendlyError = globalThis.__friendly; export const useStore = globalThis.__fakeStore;"))}, shortCircuit: true };
    if (specifier === "./i18n") return next(${JSON.stringify(new URL("src/i18n/index.ts", ROOT).href)}, context);
  }
  return next(specifier, context);
}`;
register(fake(hooks));

const { backendText } = await import("../src/backendErrors.ts");
const { setLangPref, t } = await import("../src/i18n/index.ts");
setLangPref("en");
const toasts = [];
globalThis.__fakeStore = { getState: () => ({ showToast: (text, undo, kind) => toasts.push({ text: typeof text === "function" ? text() : text, kind }) }) };
globalThis.__friendly = (e) => backendText(String(e instanceof Error ? e.message : e)) ?? String(e);
const calls = [];
let outcome = () => Promise.resolve();
globalThis.__fakeApi = { attachmentReveal: (p) => { calls.push(p); return outcome(); } };
const { revealSaved, fileNameOf } = await import("../src/reveal.ts");

// 1. the file name of either kind of path
assert.equal(fileNameOf("C:\\Users\\a\\Downloads\\report.pdf"), "report.pdf");
assert.equal(fileNameOf("/home/a/Downloads/report.pdf"), "report.pdf");
assert.equal(fileNameOf("report.pdf"), "report.pdf");

// 2. it worked: no toast
await revealSaved("/home/a/Downloads/report.pdf");
assert.deepEqual(calls, ["/home/a/Downloads/report.pdf"]);
assert.equal(toasts.length, 0, "a reveal that worked says nothing");

// 3. the file is gone: an error toast with the name and the text of the error in the app language
outcome = () => Promise.reject("FILE_GONE: That file no longer exists.");
await revealSaved("C:\\Users\\a\\Downloads\\report.pdf");
assert.equal(toasts.length, 1);
assert.equal(toasts[0].kind, "error");
assert.equal(toasts[0].text, "Couldn’t show report.pdf in its folder: That file no longer exists.");
// the text is made when it is shown: the language of that moment
setLangPref("de");
assert.equal(t("reading.att.couldntReveal", { name: "report.pdf", error: "x" }), "report.pdf konnte nicht im Ordner angezeigt werden: x");
toasts.length = 0;
await revealSaved("/tmp/Bericht.pdf");
assert.equal(toasts[0].text, "Bericht.pdf konnte nicht im Ordner angezeigt werden: Diese Datei existiert nicht mehr.");
setLangPref("en");

// 4. any other failure (the opener's own error) is shown as well
toasts.length = 0;
outcome = () => Promise.reject(new Error("no file manager on the bus"));
await revealSaved("/tmp/a.txt");
assert.equal(toasts.length, 1);
assert.match(toasts[0].text, /^Couldn’t show a\.txt in its folder: /);

// 5. all eight languages have the text with both values (no raw key)
for (const lang of ["en", "vi", "fr", "zh-Hans", "es", "ja", "de", "ru"]) {
  setLangPref(lang);
  const s = t("reading.att.couldntReveal", { name: "NAME", error: "ERR" });
  assert.ok(s.includes("NAME") && s.includes("ERR") && !s.includes("reading.att"), `${lang}: ${s}`);
}
setLangPref("fr");
assert.ok(t("reading.att.couldntReveal", { name: "N", error: "E" }).includes("\u00a0:"), "French: the no-break space before the colon");
setLangPref("en");

// 6. the wiring: only reveal.ts (and api.ts) call the backend, and every "Show in folder" goes through revealSaved
const walk = (dir) => readdirSync(new URL(`${dir}/`, ROOT)).flatMap((f) => {
  const rel = `${dir}/${f}`;
  return statSync(new URL(rel, ROOT)).isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(f) ? [rel] : [];
});
const direct = walk("src").filter((f) => /api\.attachmentReveal\(/.test(read(f)));
assert.deepEqual(direct, ["src/reveal.ts"], "api.attachmentReveal( appears only in src/reveal.ts");
assert.match(read("src/api.ts"), /attachmentReveal: \(path: string\) => invoke<void>\("attachment_reveal", \{ path \}\)/);
const att = read("src/components/Attachments.tsx");
assert.equal((att.match(/revealSaved\(/g) ?? []).length, 5, "the save toast, the after-save setting, the card icon, Save all and the plain saved toast");
assert.ok(!/attachmentReveal/.test(att), "no direct call left in Attachments.tsx");
assert.match(read("src/components/ReadingPane.tsx"), /revealSaved\(r\.saved\[0\]\)/);
// the backend: the Linux fallback opens the folder, Windows and macOS have none
const lib = read("src-tauri/src/lib.rs");
const cmd = lib.slice(lib.indexOf("async fn attachment_reveal"));
const body = cmd.slice(0, cmd.indexOf("\n}\n"));
assert.match(body, /#\[cfg\(target_os = "linux"\)\][\s\S]*linuxopen::reveal_fallback_dir\(&p\)[\s\S]*linuxopen::open\(&dir\.to_string_lossy\(\), false\)/, "Linux: the folder is opened when the file cannot be selected");
assert.ok(body.indexOf("reveal_item_in_dir") < body.indexOf("reveal_fallback_dir"), "the file manager is asked first");
console.log("reveal: all checks passed");
