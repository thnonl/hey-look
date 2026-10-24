// The mini toolbar on a mouse selection (spec-107-wp3.md W3.3): when it may show (REQ-3.3.1, the matrix), the box of a selection and its clip, the keys that keep it, and the wiring
// (the preference, the Settings row, the lazy component, Alt+F10, the link anchor). The placement itself is in test-popover-room.mjs.
// Run: node --experimental-strip-types scripts/test-mini-toolbar.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keyKeepsMini, miniShouldShow, selectionBox } from "../src/editor/miniRules.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(root, f), "utf8").replace(/\r\n/g, "\n");

const base = { enabled: true, source: "mouse", selection: "text", inOneLink: false, painterOn: false, composing: false, blocked: false };
const show = (o) => miniShouldShow({ ...base, ...o });

// ---- the matrix of REQ-3.3.1
assert.equal(show({}), true, "a mouse selection of text");
for (const source of ["touch", "pen", "key", null]) assert.equal(show({ source }), false, `a selection made by ${source} never shows it`);
for (const selection of ["empty", "node", "cells"]) assert.equal(show({ selection }), false, `${selection} selection`);
assert.equal(show({ inOneLink: true }), false, "entirely inside one link: the link bubble owns it");
assert.equal(show({ painterOn: true }), false, "the format painter is on");
assert.equal(show({ composing: true }), false, "an input method composes");
assert.equal(show({ blocked: true }), false, "a menu, palette or popover of the toolbar is open");
assert.equal(show({ enabled: false }), false, "the setting is off");
// every flag alone breaks it, and nothing but these flags matters
for (let bits = 0; bits < 64; bits++) {
  const o = { inOneLink: !!(bits & 1), painterOn: !!(bits & 2), composing: !!(bits & 4), blocked: !!(bits & 8), enabled: !(bits & 16), selection: bits & 32 ? "node" : "text" };
  assert.equal(show(o), bits === 0, JSON.stringify(o));
}

// ---- the box of a selection
const R = (left, top, right, bottom) => ({ left, top, right, bottom });
assert.deepEqual(selectionBox([R(10, 10, 50, 30)], null), R(10, 10, 50, 30));
assert.deepEqual(selectionBox([R(10, 10, 300, 30), R(10, 30, 120, 50)], null), R(10, 10, 300, 50), "several lines: the bounding box");
assert.deepEqual(selectionBox([R(10, 10, 50, 30), R(0, 0, 0, 0), R(5, 5, 5, 40)], null), R(10, 10, 50, 30), "rects with no size are not counted");
assert.equal(selectionBox([], null), null);
assert.equal(selectionBox([R(0, 0, 0, 20)], null), null);
// clipped to the visible part of the scroll area
assert.deepEqual(selectionBox([R(10, -200, 300, 900)], R(0, 100, 400, 500)), R(10, 100, 300, 500), "a long selection is cut to what is visible");
assert.equal(selectionBox([R(10, 600, 300, 640)], R(0, 100, 400, 500)), null, "a selection scrolled out of view has no box");
assert.deepEqual(selectionBox([R(10, 90, 80, 120)], R(0, 100, 400, 500)), R(10, 100, 80, 120), "half in view: the visible half");

// ---- the keys
const k = (key, o = {}) => keyKeepsMini({ key, ctrlKey: false, metaKey: false, altKey: false, ...o });
for (const m of ["Shift", "Control", "Alt", "Meta"]) assert.equal(k(m), true, `${m} alone`);
for (const x of ["b", "B", "i", "u"]) assert.equal(k(x, { ctrlKey: true }), true, `Ctrl+${x}`);
assert.equal(k("b", { metaKey: true }), true, "Cmd+B");
assert.equal(k("F10", { altKey: true }), true, "Alt+F10");
for (const x of ["a", "Enter", "Backspace", "Delete", "ArrowLeft", "ArrowRight", "Home", "End", "Tab", "z", "v", "x"]) assert.equal(k(x), false, `${x} changes the text or the selection`);
for (const x of ["a", "z", "v", "ArrowLeft", "Home"]) assert.equal(k(x, { ctrlKey: true }), false, `Ctrl+${x}: select all, undo, paste, word jump`);
assert.equal(k("F10"), false);

// ---- the wiring
{
  const prefs = read("src/prefs.ts");
  assert.ok(prefs.includes("miniToolbar: true,") && /miniToolbar: typeof p\.miniToolbar === "boolean" \? p\.miniToolbar : true/.test(prefs), "default on; a missing or non-boolean value reads on");
  const dlg = read("src/components/SettingsDialog.tsx");
  assert.ok(dlg.indexOf("<AutoFormatRow />") < dlg.indexOf("<MiniToolbarRow />") && /scope === null && <MiniToolbarRow/.test(dlg), "the row is right after the AutoFormat row, app level only");
  const bar = read("src/editor/FormatBar.tsx");
  assert.ok(/lazy\(\(\) => import\("\.\/MiniToolbar"\)/.test(bar), "the component is its own chunk");
  assert.ok(!/^import (?!type\b).*from "\.\/MiniToolbar"/m.test(bar), "and nothing imports it statically (a type import is erased)");
  const mini = read("src/editor/MiniToolbar.tsx");
  assert.ok(/aria-label=\{t\("compose\.mini\.toolbar"\)\}/.test(mini) && /role="toolbar"/.test(mini), "a toolbar with its own name");
  assert.ok(!/aria-live|role="status"/.test(mini), "it is not announced when it appears (no live region)");
  const link = read("src/components/LinkPopover.tsx");
  assert.ok(/open = useCallback\(\(at\?: /.test(link), "the link UI takes an optional anchor");
  const budget = JSON.parse(read("scripts/bundle-budget.json"));
  for (const m of ["src/editor/MiniToolbar.tsx", "src/editor/useMiniShow.ts", "src/editor/miniRules.ts"]) assert.ok(budget.mustBeLazy.some((x) => x.module === m && x.since === "1.0.7"), `${m} must stay lazy`);
}
console.log("test-mini-toolbar: ok");
