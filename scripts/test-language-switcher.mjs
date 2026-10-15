// F-5: the language switcher. Reads the source (no browser): the top bar and the Welcome screen use the shared switcher, every control
// lists the languages from the registry (src/i18n/languages.ts), and the menu is the keyboard-operable shared one that does not close on blur.
// Run: node --experimental-strip-types scripts/test-language-switcher.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LANGUAGES } from "../src/i18n/languages.ts";
import { LANGS } from "../src/i18n/index.ts";

const read = (f) => readFileSync(fileURLToPath(new URL(`../${f}`, import.meta.url)), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const sw = strip(read("src/components/LanguageSwitcher.tsx"));
const top = strip(read("src/components/TopBar.tsx"));
const welcome = strip(read("src/components/Welcome.tsx"));
const settings = strip(read("src/components/SettingsDialog.tsx"));
const app = strip(read("src/App.tsx"));
const ui = strip(read("src/components/ui.tsx"));
const css = read("src/App.css");

// the eight languages that ship, in this order (English first), each in its own language; the header button shows the registry's short label
assert.deepEqual(LANGUAGES.map((l) => l.nativeName), ["English", "Tiếng Việt", "Français", "中文（简体）", "Español", "日本語", "Deutsch", "Русский"]);
assert.deepEqual(LANGS.map((l) => l.code), ["en", "vi", "fr", "zh-Hans", "es", "ja", "de", "ru"]);
assert.deepEqual(LANGS.map((l) => l.short), ["EN", "VI", "FR", "ZH", "ES", "JA", "DE", "RU"]);
assert.ok(!/toUpperCase()/.test(sw), "the header button label is the registry short label, not the code in capitals (zh-Hans would be ZH-HANS)");
assert.ok(LANGS.length > 5, "more than CHIPS_MAX languages: the Welcome screen uses the menu");

// header: the shared menu; the header is also the one of the Welcome screen (no account: same TopBar, no search / sync)
assert.ok(/<LanguageMenu\s*\/>/.test(top), "TopBar shows the shared LanguageMenu");
assert.ok(/<TopBar\s*\/>/.test(app) && /<Welcome\s*\/>/.test(app), "App draws the top bar and, with no account, the Welcome screen");
for (const block of top.match(/\{mail && \([\s\S]*?\s*\)\}/g) ?? []) assert.ok(!block.includes("<LanguageMenu"), "the language menu is not inside a mail-only block (it is needed with no account)");
// Welcome page: the shared chooser
assert.ok(/<LanguageChoice\s*\/>/.test(welcome), "Welcome shows the shared LanguageChoice");

// both switchers read the registry, set the same preference as Settings, and name nothing themselves
for (const [n, src] of [["LanguageSwitcher", sw], ["SettingsDialog", settings]]) assert.ok(/\bLANGS\b/.test(src), `${n} lists the languages from LANGS`);
assert.ok(/setPrefs\(\{ language/.test(sw), "the switcher sets prefs.language, like Settings > General > Language");
assert.ok(/prefs\.language/.test(settings), "Settings shows prefs.language (so both stay in sync)");
for (const l of LANGUAGES) for (const [n, src] of [["LanguageSwitcher", sw], ["TopBar", top], ["Welcome", welcome]]) assert.ok(!src.includes(`"${l.nativeName}"`) && !src.includes(`"${l.code}"`), `${n} must not hard-code ${l.nativeName}`);

// names are not translated and carry their own lang; the label of the control is
assert.ok(/nativeName/.test(sw) && /lang=\{l\.code\}/.test(sw), "language names are shown as written in the registry, with lang=");
assert.ok(/app\.top\.language\b/.test(sw) && /app\.top\.languageCurrent/.test(sw), "the control label is a translated key");

// a long list: the menu scrolls, has Arrow / Home / End and type-ahead; it closes on a press outside by contains(), not by blur (macOS / WebKit)
assert.ok(/CHIPS_MAX/.test(sw) && /LANGS\.length > CHIPS_MAX/.test(sw), "the Welcome chooser switches to a menu when there are many languages");
assert.ok(/<Dropdown\b/.test(sw), "the menu is the shared Dropdown");
for (const k of ["ArrowDown", "ArrowUp", "Home", "End", "Escape"]) assert.ok(ui.includes(`"${k}"`), `FloatingMenu handles ${k}`);
assert.ok(/type-ahead/.test(read("src/components/ui.tsx")) && /startsWith\(prefix\)/.test(ui), "FloatingMenu has type-ahead");
assert.ok(/addEventListener\("mousedown", down\)/.test(ui) && /\.contains\(n\)/.test(ui), "outside press closes the menu through contains() on the event target");
const menuCode = ui.slice(ui.indexOf("export function FloatingMenu"), ui.indexOf("export function Dropdown"));
assert.ok(!/onBlur|"blur"|focusout/.test(menuCode), "the menu never closes on blur");
assert.ok(/\.dd-fixed \.menu \{[^}]*max-height/.test(css), "the menu has a max-height (scrolls)");
assert.ok(/\.lang-code \{[^}]*max-width[^}]*text-overflow: ellipsis/.test(css), "the button label has a fixed maximum width and an ellipsis");
assert.ok(/\.topbar \.lang-btn:focus-visible/.test(css), "the button has a visible focus ring on the bar");
console.log("language-switcher: all checks passed");
