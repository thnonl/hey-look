// The emoji picker's search and recently used list (1.0.7 W2.17): the names (Unicode CLDR annotations, src/editor/emojiNames/<lang>.json) cover every emoji of the
// picker in all 8 languages, the search finds by name and keyword in the UI language and English (accents ignored for Latin text, plain substrings for Chinese and
// Japanese), the recent list keeps 16 emoji, newest first, each once, and only emoji; and none of the names can get into the main bundle.
// Run: node --experimental-strip-types scripts/test-emoji-search.mjs
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_EMOJI, EMOJI_GROUPS } from "../src/editor/emojiData.ts";
import { emojiName, foldForSearch, searchEmoji } from "../src/editor/emojiSearch.ts";
import { RECENT_EMOJI_MAX, cleanRecentEmoji, pushRecentEmoji } from "../src/editor/recentEmoji.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(root, f), "utf8").replace(/\r\n/g, "\n");
const LANGS = ["en", "vi", "fr", "zh-Hans", "es", "ja", "de", "ru"];
const files = Object.fromEntries(LANGS.map((l) => [l, JSON.parse(read(`src/editor/emojiNames/${l}.json`))]));
const names = (l) => files[l].names;

// 1. every emoji of the picker has a name in all 8 files, the license is in each file's header, and nothing else is in there
assert.equal(ALL_EMOJI.length, 256);
assert.equal(new Set(ALL_EMOJI).size, 256, "no emoji twice in the picker");
assert.deepEqual(readdirSync(join(root, "src/editor/emojiNames")).sort(), LANGS.map((l) => `${l}.json`).sort());
for (const l of LANGS) {
  assert.match(files[l]._license, /Unicode License v3/, `${l}: the license is in the header`);
  assert.match(files[l]._source, /^CLDR \d+\.\d+\.\d+ annotations \(/, `${l}: the source release is named`);
  for (const e of ALL_EMOJI) {
    const n = names(l)[e];
    assert.ok(Array.isArray(n) && n.length >= 1 && n.every((x) => typeof x === "string" && x.trim() !== ""), `${l}: a name for ${e}`);
  }
  assert.equal(Object.keys(names(l)).length, 256, `${l}: exactly the 256 emoji`);
}
assert.equal(emojiName("😀", [names("en")]), "grinning face", "the accessible name in English");
assert.equal(emojiName("😀", [names("de"), names("en")]), "grinsendes Gesicht", "in the UI language first");
assert.equal(emojiName("😀", []), undefined);

// 2. searching
const en = [names("en")];
const find = (q, tables) => searchEmoji(q, ALL_EMOJI, tables);
const heart = find("heart", en);
assert.ok(heart.includes("❤️") && heart.includes("💔") && heart.includes("💙"), "hearts");
assert.ok(heart.length >= 8 && heart.length <= 30, `${heart.length} results for "heart"`);
for (const e of heart) assert.ok(names("en")[e].join(" ").toLowerCase().includes("heart"), `${e} is a heart emoji`);
assert.deepEqual(find("xyz", en), [], "no match");
assert.deepEqual(find("", en), [], "an empty box finds nothing (the tabs show)");
assert.deepEqual(find("   ", en), []);
assert.ok(find("HEART", en).includes("❤️"), "case does not matter");
assert.deepEqual(find("red heart", en).filter((e) => e === "❤️"), ["❤️"], "every word must match");
assert.ok(!find("red heart", en).includes("💙"), "blue heart is not a red heart");
// the order is the picker's own (categories in order)
const order = (list) => list.map((e) => ALL_EMOJI.indexOf(e));
assert.deepEqual(order(heart), [...order(heart)].sort((a, b) => a - b), "results come in category order");
// vietnamese: "tim" is in the name of ❤️, and the English word works too
const vi = [names("vi"), names("en")];
assert.ok(find("tim", vi).includes("❤️"), "vi: tim");
assert.ok(find("heart", vi).includes("❤️"), "vi: the English name also finds it");
assert.ok(find("tinh yeu", vi).includes("❤️"), "vi: accents ignored (tình yêu)");
assert.ok(find("tình yêu", vi).includes("❤️"), "vi: and typed with accents");
// french: cœur / coeur
const fr = [names("fr"), names("en")];
assert.ok(find("coeur", fr).includes("❤️") && find("cœur", fr).includes("❤️") && find("CŒUR", fr).includes("❤️"), "fr: coeur = cœur");
assert.ok(find("visage rieur", fr).includes("😀"), "fr: two words");
// german: umlauts and ß
const de = [names("de"), names("en")];
assert.ok(find("herz", de).includes("❤️"), "de: Herz");
assert.ok(find("fröhlich", de).includes("😀") && find("frohlich", de).includes("😀"), "de: ö = o");
// chinese and japanese: any substring, one character is enough
const ja = [names("ja"), names("en")];
assert.ok(find("猫", ja).includes("🐱"), "ja: 猫");
assert.ok(find("ハート", ja).includes("❤️"), "ja: ハート");
const zh = [names("zh-Hans"), names("en")];
assert.ok(find("猫", zh).includes("🐱"), "zh: 猫");
assert.ok(find("红心", zh).includes("❤️") && find("心", zh).includes("❤️"), "zh: a single character");
// russian: Cyrillic is not folded (й and и are different letters), but case is
const ru = [names("ru"), names("en")];
assert.ok(find("СЕРДЦЕ", ru).includes("❤️"), "ru: case");
assert.equal(foldForSearch("Йод"), "йод");
assert.equal(foldForSearch("Cœur Ça Ø"), "coeur ca o");
assert.equal(foldForSearch("ぱ"), "ぱ", "kana keep their marks");
// spanish accents
const es = [names("es"), names("en")];
assert.ok(find("corazon", es).includes("❤️") && find("corazón", es).includes("❤️"), "es: corazón");

// 3. recently used: newest first, each once, at most 16, only emoji
assert.equal(RECENT_EMOJI_MAX, 16);
assert.deepEqual(pushRecentEmoji([], "😀"), ["😀"]);
assert.deepEqual(pushRecentEmoji(["😀"], "👍"), ["👍", "😀"], "the newest first: 😀 then 👍 gives 👍, 😀");
assert.deepEqual(pushRecentEmoji(["👍", "😀", "🎉"], "😀"), ["😀", "👍", "🎉"], "an emoji used again moves up, it is not repeated");
const sixteen = ALL_EMOJI.slice(0, 16);
assert.deepEqual(pushRecentEmoji(sixteen, ALL_EMOJI[20]), [ALL_EMOJI[20], ...sixteen.slice(0, 15)], "the 17th pushes the oldest out");
assert.equal(pushRecentEmoji(sixteen, sixteen[15]).length, 16);
const known = new Set(ALL_EMOJI);
assert.deepEqual(cleanRecentEmoji(["😀", "😀", "👍"]), ["😀", "👍"], "duplicates leave");
assert.deepEqual(cleanRecentEmoji("😀"), [], "not a list");
assert.deepEqual(cleanRecentEmoji(null), []);
assert.deepEqual(cleanRecentEmoji(["😀", 5, null, "abc", "", "<script>", "👍", { a: 1 }]), ["😀", "👍"], "only emoji");
assert.deepEqual(cleanRecentEmoji(ALL_EMOJI.slice(0, 40)).length, 16, "at most 16");
assert.deepEqual(cleanRecentEmoji(["😀", "🦖", "👍"], known), ["😀", "👍"], "with the picker's list: only the emoji it knows");
assert.deepEqual(cleanRecentEmoji(["❤️", "✌️", "☀️", "♻️"], known), ["❤️", "✌️", "☀️", "♻️"], "variation-selector emoji are kept");
assert.ok(cleanRecentEmoji(EMOJI_GROUPS.flatMap((g) => g.emoji)).length === 16 && cleanRecentEmoji(ALL_EMOJI).every((e) => known.has(e)), "every emoji of the picker is accepted by the load-time check");

// 4. nothing of the names or the search is in the main bundle: only the lazy picker chunk imports them, preferences only the tiny recent list
const srcFiles = (dir) => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? srcFiles(`${dir}/${d.name}`) : d.name.endsWith(".ts") || d.name.endsWith(".tsx") ? [`${dir}/${d.name}`] : []));
const importers = (re) => srcFiles("src").filter((f) => re.test(read(f)) && !/emojiSearch\.ts$/.test(f)).sort();
assert.deepEqual(importers(/emojiNames\//), [], "no file imports the names JSON but emojiSearch.ts (a dynamic import per language)");
assert.deepEqual(importers(/from "\.\/emojiSearch"/), ["src/editor/insertUi.tsx"], "the search is only used by the lazy picker chunk");
assert.deepEqual(importers(/from "\.\/emojiData"/), ["src/editor/insertUi.tsx"], "the emoji list too");
const search = read("src/editor/emojiSearch.ts");
for (const l of LANGS) assert.ok(search.includes(`import("./emojiNames/${l}.json")`), `${l}.json is a dynamic import (a chunk of its own)`);
assert.ok(!/^import .*emojiNames/m.test(search), "no static import of a names file");
assert.ok(/import \{ cleanRecentEmoji \} from "\.\/editor\/recentEmoji"/.test(read("src/prefs.ts")) && !/\bimport\b[^\n]*\.\/(emojiData|emojiSearch)/.test(read("src/editor/recentEmoji.ts")), "preferences use only the tiny recent-emoji module");
const budget = JSON.parse(read("scripts/bundle-budget.json"));
for (const m of ["src/editor/emojiSearch.ts", "src/editor/emojiData.ts", ...LANGS.map((l) => `src/editor/emojiNames/${l}.json`)]) assert.ok(budget.mustBeLazy.some((x) => x.module === m), `${m} is in mustBeLazy of the bundle budget`);

// 5. the picker's wiring
const ui = read("src/editor/insertUi.tsx");
for (const k of ["compose.emoji.search", "compose.emoji.recent", "compose.emoji.noResults"]) assert.ok(ui.includes(`"${k}"`), `the picker uses ${k}`);
assert.ok(ui.includes('initialFocus="input.emoji-search"') && ui.includes("pushRecentEmoji(recent, glyph)"), "the box has the focus when the picker opens; an inserted emoji is remembered");
assert.ok(ui.includes("aria-label={nameOf(e)} title={nameOf(e)}"), "each emoji button is named by its CLDR short name (accessible name and tooltip)");

console.log("test-emoji-search: ok");
