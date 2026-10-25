// 1.0.9 (QA 1.0.8): the list header of the folder "QA-1.0.8" said "8": the title was cut at every "." and "/" of the folder's key (`folderLabel`). The title is the folder's own label (the
// server's name after its last hierarchy delimiter, as the side menu shows it), a standard folder keeps its translated name. Source check; the page itself is checked by
// scripts/test-list-filter-loading.mjs (L7).
// Run: node scripts/test-folder-own-label.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const prefs = read("src/prefs.ts");
const fn = prefs.slice(prefs.indexOf("export function folderOwnLabel"), prefs.indexOf("export function folderTitle"));
assert.ok(fn.includes("if (ROLE_LABELS[key]) return t(ROLE_LABELS[key]);"), "a standard folder keeps its translated name");
assert.ok(fn.includes("return info?.label ?? folderLabel(key, info?.name);"), "its own label first, the old cut only without one");
const list = read("src/components/MessageList.tsx");
assert.ok(list.includes("const openName = folderOwnLabel(folder, folders.find((f) => f.key === folder && (!accountId || f.accountId === accountId)));"));
assert.ok(list.includes(": openName;") && list.includes("{ folder: openName }"), "the title and the search scope note use it");
assert.ok(!/folderLabel\(folder\)/.test(list), "no other spelling of the open folder's name in the list");
console.log("folder-own-label: all checks passed");
