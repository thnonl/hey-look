// The saved language is applied before the first render and before any toast (src/bootLang.ts, src/main.tsx).
// Run: node --experimental-strip-types scripts/test-boot-lang.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applySavedLanguage } from "../src/bootLang.ts";
import { getLang, setLangPref, t } from "../src/i18n/index.ts";

const read = (f) => readFileSync(fileURLToPath(new URL(`../${f}`, import.meta.url)), "utf8");
const prefs = (language) => async (key) => (key === "prefs" ? JSON.stringify({ theme: "dark", language }) : null);

// 1. a saved language is the language of the first sentence after the await, for every language of the registry
for (const code of ["vi", "fr", "ru", "ja", "de", "es", "zh-Hans"]) {
  setLangPref("en");
  await applySavedLanguage(prefs(code));
  assert.equal(getLang(), code);
  assert.notEqual(t("app.toast.actionFailed", { error: "x" }), "Failed: x", `${code}: the first toast text is not English`);
}

// 2. nothing saved: English; broken JSON or a backend that is not ready: whatever is set stays (English at start); an unknown or missing saved language is English; no exception
for (const [get, expected] of [
  [async () => null, "en"], [async () => "{not json", "ru"], [async () => { throw new Error("backend not ready"); }, "ru"],
  [prefs("klingon"), "en"], [prefs(undefined), "en"], [async () => "null", "en"], [prefs(42), "en"],
]) {
  setLangPref("ru");
  await applySavedLanguage(get);
  assert.equal(getLang(), expected);
}
setLangPref("en");

// 3. main.tsx waits for it before it renders; the settings are read through the same call store.init() uses
const main = read("src/main.tsx").replace(/\r\n/g, "\n");
const wait = main.indexOf("await applySavedLanguage(api.getSetting)");
const render = main.indexOf("ReactDOM.createRoot(");
assert.ok(wait > 0 && render > wait, "main.tsx awaits applySavedLanguage before ReactDOM.createRoot");
assert.ok(main.indexOf("installMock()") < wait, "the dev mock is installed before the language is read");
assert.ok(/api\.getSetting\("prefs"\)/.test(read("src/store.ts")), "store.init() reads the same setting");
console.log("ok - test-boot-lang");
