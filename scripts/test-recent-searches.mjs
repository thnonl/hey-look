// 1.0.7 W13.4 (REQ-13.4.3, REQ-13.4.6, DEC-015): the list of recent searches and the wiring of the search panel, without a browser.
//   - src/recentSearches.ts: push (newest first, a repeat moves to the top, trimmed, empty ignored), the cap of 5, remove, and what is read from the stored preferences (damaged entries, more than 5);
//   - the store keeps 5 (setSearch) and has removeRecentSearch / clearRecentSearches; mergePrefs cleans the stored list;
//   - "Advanced search" is a chunk of its own: only lazyViews.tsx imports it, the search box does not, and the bundle budget keeps it lazy;
//   - the eight dictionaries have the three agreed texts.
// Run: node --experimental-strip-types scripts/test-recent-searches.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cleanRecent, MAX_RECENT, pushRecent, removeRecent } from "../src/recentSearches.ts";

const ROOT = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), "utf8").replace(/\r\n/g, "\n");

// ---- the list
assert.equal(MAX_RECENT, 5);
{
  let l = [];
  for (let i = 1; i <= 7; i++) l = pushRecent(l, `search ${i}`);
  assert.deepEqual(l, ["search 7", "search 6", "search 5", "search 4", "search 3"], "7 different searches leave the last 5, newest first");
  assert.deepEqual(pushRecent(l, "search 4"), ["search 4", "search 7", "search 6", "search 5", "search 3"], "a repeat moves to the top and is not listed twice");
  assert.deepEqual(pushRecent(l, "  search 9  ")[0], "search 9", "the text is trimmed");
  assert.equal(pushRecent(l, "   "), l, "an empty search is not remembered");
  assert.deepEqual(pushRecent([], "a"), ["a"]);
  assert.deepEqual(removeRecent(l, "search 6"), ["search 7", "search 5", "search 4", "search 3"], "remove takes one entry");
  assert.deepEqual(removeRecent(l, "nothing"), l);
}

// ---- what is read from the stored preferences (the older versions kept 8)
assert.deepEqual(cleanRecent(["1", "2", "3", "4", "5", "6", "7", "8"]), ["1", "2", "3", "4", "5"], "the older entries beyond 5 are dropped");
assert.deepEqual(cleanRecent(["a", " a ", "", 3, null, "b", { x: 1 }]), ["a", "b"], "text only, trimmed, each once");
assert.deepEqual(cleanRecent(undefined), []);
assert.deepEqual(cleanRecent("abc"), []);
assert.deepEqual(cleanRecent({ 0: "a" }), []);

// ---- the wiring (source checks)
const store = read("src/store.ts");
assert.ok(/pushRecent\(get\(\)\.prefs\.recentSearches, search\)/.test(store), "setSearch keeps the list with pushRecent");
assert.ok(!/slice\(0, 8\)/.test(store.slice(store.indexOf("setSearch: async"), store.indexOf("setSearchScope: async"))), "no 8 left in setSearch");
assert.ok(/removeRecentSearch: \(q\) =>/.test(store) && /clearRecentSearches: \(\) =>/.test(store), "the store removes one and clears all");
assert.ok(/recentSearches: cleanRecent\(p\.recentSearches\)/.test(read("src/prefs.ts")), "mergePrefs cleans the stored list");

// ---- Advanced search is lazy (DEC-015)
const box = read("src/components/SearchBox.tsx");
assert.ok(!/SearchAdvanced["']/.test(box.replace(/LazySearchAdvanced/g, "")), "the search box does not import SearchAdvanced");
assert.ok(/from "\.\.\/lazyViews"/.test(box) && /LazySearchAdvanced/.test(box));
const views = read("src/lazyViews.tsx");
assert.ok(/import\("\.\/components\/SearchAdvanced"\)/.test(views), "lazyViews.tsx is the one place that loads it");
for (const f of ["src/App.tsx", "src/components/SearchBox.tsx", "src/store.ts"]) assert.ok(!/import[^;]*components\/SearchAdvanced|import[^;]*\.\/SearchAdvanced/.test(read(f).replace(/import type[^;]*;/g, "")), `${f} has no static import of SearchAdvanced`);
const budget = JSON.parse(read("scripts/bundle-budget.json"));
const entry = budget.mustBeLazy.find((m) => m.module === "src/components/SearchAdvanced.tsx");
assert.ok(entry && entry.since === "1.0.7", "SearchAdvanced.tsx is in mustBeLazy (since 1.0.7)");

// ---- the texts (spec-107-wp13 section 3, keys 2 to 4)
const texts = {
  "app.search.advanced": { vi: "Tìm kiếm nâng cao", fr: "Recherche avancée", "zh-Hans": "高级搜索", es: "Búsqueda avanzada", ja: "詳細検索", de: "Erweiterte Suche", ru: "Расширенный поиск" },
  "app.search.removeRecent": { vi: "Xóa “{q}” khỏi tìm kiếm gần đây", fr: "Retirer « {q} » des recherches récentes", "zh-Hans": "从最近搜索中移除“{q}”", es: "Quitar “{q}” de las búsquedas recientes", ja: "「{q}」を最近の検索から削除", de: "„{q}“ aus letzten Suchen entfernen", ru: "Удалить «{q}» из недавних запросов" },
  "app.search.clearRecent": { vi: "Xóa tất cả", fr: "Tout effacer", "zh-Hans": "全部清除", es: "Borrar todo", ja: "すべてクリア", de: "Alle löschen", ru: "Очистить всё" },
};
const en = { "app.search.advanced": "Advanced search", "app.search.removeRecent": "Remove “{q}” from recent searches", "app.search.clearRecent": "Clear all" };
const ns = read("src/i18n/ns/app.ts");
for (const [k, v] of Object.entries(en)) assert.ok(ns.includes(`"${k}": ${JSON.stringify(v)}`), `en ${k}`);
for (const [k, byLang] of Object.entries(texts)) for (const [l, v] of Object.entries(byLang)) assert.ok(read(`src/i18n/locales/${l}/app.ts`).includes(`"${k}": ${JSON.stringify(v)}`), `${l} ${k}`);

console.log("test-recent-searches: ok");
