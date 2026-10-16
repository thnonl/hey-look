// Shared by scripts/test-i18n.mjs, i18n-status.mjs and i18n-export-tsv.mjs: the registry and every dictionary, by language code.
// English, Vietnamese and French live in src/i18n/{en,vi,fr}.ts (gathering the ns/*.ts files); every other language of the registry in
// src/i18n/locales/<code>/index.ts. Run the scripts with `node --experimental-strip-types`.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LANGUAGES } from "../../src/i18n/languages.ts";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export { LANGUAGES };
/** The languages that sit next to English inside src/i18n/ns/*.ts. */
export const INLINE = ["en", "vi", "fr"];

/** "zh-Hans" -> "zhHans": the name a locales/<code>/index.ts exports. */
export const ident = (code) => code.replace(/-(\w)/g, (_, x) => x.toUpperCase());
/** "zh-Hans" -> "zh_hans": the Rust module src-tauri/src/i18n/<name>.rs. */
export const rustMod = (code) => code.toLowerCase().replace(/-/g, "_");

/** Import the dictionary of one registry language; null when its file is missing or broken (the caller reports it). */
export async function loadDict(code) {
  const file = INLINE.includes(code) ? `src/i18n/${code}.ts` : `src/i18n/locales/${code}/index.ts`;
  try {
    const mod = await import(new URL(`../../${file}`, import.meta.url));
    return mod[ident(code)] ?? null;
  } catch {
    return null;
  }
}

/** { code: dictionary } for the whole registry (missing ones are left out). */
export async function loadDicts() {
  const out = {};
  for (const l of LANGUAGES) {
    const d = await loadDict(l.code);
    if (d) out[l.code] = d;
  }
  return out;
}

/** Every string a message holds (a plain string, or the forms of a plural), in order. */
export const formsOf = (m) => (typeof m === "string" ? [m] : Object.values(m));
/** All forms joined with a space (for "is it empty / identical" checks). */
export const textOf = (m) => formsOf(m).join(" ");
/** The sorted, distinct `{placeholders}` of a message, over all its forms. */
export const placeholdersOf = (m) => [...new Set(formsOf(m).flatMap((s) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1])))].sort();

/** Is this message the English one? A plural is English when each of its forms is the English form of that category (or "other"). */
export function sameAsEnglish(v, e) {
  if (typeof v === "string") return typeof e === "string" ? v === e : v === e.other;
  const ef = typeof e === "string" ? { other: e } : e;
  return Object.entries(v).every(([c, s]) => s === (ef[c] ?? ef.other));
}

/** Words and names that stay as they are in every language; a text made only of these (and placeholders / punctuation) is not "untranslated". */
export const KEEP_WORDS = new Set([
  "hey", "look", "imap", "smtp", "pop", "pop3", "oauth", "oauth2", "openpgp", "pgp", "gpg", "gnupg", "mime", "s/mime", "tls", "ssl", "starttls",
  "icloud", "gmail", "outlook", "google", "microsoft", "yahoo", "fastmail", "github", "hotmail", "office", "365", "exchange", "teams", "zoom",
  "ics", "ical", "html", "url", "uri", "sha", "csv", "pdf", "json", "utc", "gmt", "tauri", "macos", "windows", "linux", "dock", "api", "id", "ok",
  "ai", "dns", "ip", "bcc", "cc", "px", "kb", "mb", "gb", "b", "ascii", "rsa", "curve25519", "ed25519", "ecc", "caldav", "webdav", "http", "https",
  "ctrl", "alt", "shift", "esc", "enter", "tab", "del", "cmd", "fn", "ms", "app", "gpt", "tray",
]);

/**
 * True when an English text may be the same in every language: nothing left but placeholders, numbers, punctuation, keyboard shortcuts
 * and the KEEP_WORDS above ("Hey Look!", "IMAP", "{n} KB", "Ctrl+K"). Used by i18n-status.mjs for the "identical to English" count.
 */
export function mayStayEnglish(english) {
  const x = english.replace(/\{\w+\}/g, " ").replace(/[^\p{L}\p{N}/]+/gu, " ").trim();
  if (!x) return true;
  const words = x.split(/\s+/);
  return words.every((w) => !/\p{L}/u.test(w) || KEEP_WORDS.has(w.toLowerCase()) || /^[A-Z]$/.test(w) || /^[a-z]$/.test(w));
}

/**
 * Keys a language marks as "same as English on purpose": src/i18n/locales/<code>/keep.json (a JSON array of keys) for the languages with
 * their own folder, src/i18n/ns/keep.json (`{ "vi": [...], "fr": [...] }`) for the ones that live in ns/ next to English.
 */
export function keepList(code) {
  const f = INLINE.includes(code) ? join(root, "src/i18n/ns/keep.json") : join(root, "src/i18n/locales", code, "keep.json");
  if (!existsSync(f)) return new Set();
  try {
    const j = JSON.parse(readFileSync(f, "utf8"));
    return new Set(INLINE.includes(code) ? j[code] ?? [] : j);
  } catch {
    return new Set();
  }
}
