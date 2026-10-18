// The side menu (v1.0.6): when it is shown in full and when as a column of icons (src/sidebarState.ts), what the control does, the key, and that
// the preference and the screens use them. The layout itself is measured by scripts/test-sidebar-collapse.mjs.
// Run: node --experimental-strip-types scripts/test-sidebar-state.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sidebarToggleKey } from "../src/composeKeys.ts";
import {
  AUTO_COLLAPSE_BELOW, MIN_READER_W, RAIL_W, SIDEBAR_MODES, SPLITTER_W, normalizeSidebar, sidebarControlOpen, sidebarFits, sidebarLayout, toggleSidebar,
} from "../src/sidebarState.ts";

const base = { folderW: 248, listW: 392, bottomPane: false };
const at = (mode, width, o = {}) => sidebarLayout({ ...base, ...o, mode, width });

// 1. the numbers: with the default widths the reading pane is left with 448 px at 1100, and 500 px next to the icons at the smallest window
assert.equal(AUTO_COLLAPSE_BELOW, 1100);
assert.equal(RAIL_W, 56);
assert.equal(1100 - 248 - 392 - 2 * SPLITTER_W, 448);
assert.ok(448 >= MIN_READER_W);
assert.equal(960 - RAIL_W - 392 - 2 * SPLITTER_W, 500, "the smallest window, menu as icons");
assert.ok(960 - 248 - 392 - 2 * SPLITTER_W < MIN_READER_W, "the smallest window with the open menu would squeeze the reading pane");

// 2. normalize: anything but the two manual states is automatic
assert.deepEqual(SIDEBAR_MODES, ["auto", "expanded", "collapsed"]);
for (const m of SIDEBAR_MODES) assert.equal(normalizeSidebar(m), m);
for (const v of [undefined, null, "", "AUTO", "open", 1, true, {}]) assert.equal(normalizeSidebar(v), "auto", `${String(v)} counts as auto`);

// 3. fits
assert.equal(sidebarFits({ ...base, width: 1100 }), true);
assert.equal(sidebarFits({ ...base, width: 1091 }), false, "439 px of reading pane");
assert.equal(sidebarFits({ ...base, width: 1092 }), true, "440 px of reading pane");
assert.equal(sidebarFits({ ...base, width: 960, bottomPane: true }), true, "reading pane below the list: only the menu shares the width");
assert.equal(sidebarFits({ ...base, width: 700, bottomPane: true }), true);
assert.equal(sidebarFits({ ...base, width: 690, bottomPane: true }), false);

// 4. auto: the breakpoint, in both directions, and the usual window sizes
for (const [w, folded] of [[960, true], [1000, true], [1099, true], [1100, false], [1280, false], [1440, false], [1920, false], [3840, false]]) {
  assert.deepEqual(at("auto", w), { collapsed: folded, squeezed: false }, `auto at ${w}`);
}
// a wider list or menu than the default folds it earlier than the breakpoint (the reading pane keeps its minimum)
assert.equal(at("auto", 1280, { listW: 520 }).collapsed, false, "1280 - 248 - 520 - 12 = 500");
assert.equal(at("auto", 1200, { listW: 520 }).collapsed, true, "420 px would be left");
assert.equal(at("auto", 1200, { folderW: 360 }).collapsed, true, "1200 - 360 - 392 - 12 = 436");
// the reading pane below: only the breakpoint counts
assert.equal(at("auto", 1100, { bottomPane: true }).collapsed, false);
assert.equal(at("auto", 1099, { bottomPane: true }).collapsed, true);

// 5. collapsed: always icons, whatever the width
for (const w of [960, 1100, 1920]) assert.deepEqual(at("collapsed", w), { collapsed: true, squeezed: false }, `collapsed at ${w}`);

// 6. expanded: open as long as the other panes keep their minimum; the width alone does not fold it, but the panes' room does ("squeezed")
for (const w of [1092, 1100, 1280, 1920]) assert.deepEqual(at("expanded", w), { collapsed: false, squeezed: false }, `expanded at ${w}`);
for (const w of [960, 1000, 1091]) assert.deepEqual(at("expanded", w), { collapsed: true, squeezed: true }, `expanded at ${w}: icons, the menu opens over the list`);
assert.deepEqual(at("expanded", 960, { bottomPane: true }), { collapsed: false, squeezed: false }, "960 with the reading pane below: room enough");

// 7. the other panes never fall below their minimum because of an open menu: every mode, every width, menu and list widths of the splitters
for (const mode of SIDEBAR_MODES) {
  for (let width = 900; width <= 2200; width += 7) {
    for (let folderW = 180; folderW <= 360; folderW += 20) {
      for (let listW = 300; listW <= 680; listW += 20) {
        const l = sidebarLayout({ mode, width, folderW, listW, bottomPane: false });
        if (!l.collapsed) assert.ok(width - folderW - listW - 2 * SPLITTER_W >= MIN_READER_W, `${mode} ${width} menu ${folderW} list ${listW}: reading pane ${width - folderW - listW - 12}`);
        assert.equal(l.squeezed, mode === "expanded" && l.collapsed, "squeezed is only 'expanded' without room");
      }
    }
  }
}
// auto does not flap: with the default widths, once the menu is open it stays open for every wider window (no jitter around the breakpoint)
{
  let open = false;
  for (let w = 900; w <= 2600; w++) {
    const o = !at("auto", w).collapsed;
    assert.ok(!open || o, `auto: open at ${w - 1}, folded at ${w}`);
    open = open || o;
  }
  assert.ok(open);
}
// the same width and the same inputs always give the same answer (the layout never depends on what was measured: no feedback loop)
assert.deepEqual(at("auto", 1234), at("auto", 1234));

// 8. the control (W1.6, 1.0.7): it follows what is on screen. The saved setting changes only where the menu can sit next to the list; in a narrow window the control shows and
// hides the menu as an overlay and leaves the setting alone. Rows of the table of the spec (input: the layout, whether the overlay is open):
//   full menu                 -> fold it, setting "collapsed"
//   icons, room               -> open in place, setting "expanded", the overlay closes (open or not)
//   icons, no room, overlay   -> close the overlay, setting unchanged
//   icons, no room, closed    -> open the overlay pinned, setting unchanged
const tg = (o, overlay = false) => toggleSidebar({ ...base, ...o }, overlay);
assert.deepEqual(tg({ mode: "auto", width: 1280 }), { mode: "collapsed", overlay: "none" });
assert.deepEqual(tg({ mode: "expanded", width: 1920 }), { mode: "collapsed", overlay: "none" });
assert.deepEqual(tg({ mode: "auto", width: 1920 }), { mode: "collapsed", overlay: "none" });
assert.deepEqual(tg({ mode: "auto", width: 1199 }), { mode: "collapsed", overlay: "none" }, "1199 is open in auto");
assert.deepEqual(tg({ mode: "collapsed", width: 1280 }), { mode: "expanded", overlay: "close" }, "icons by choice, room: open in place");
assert.deepEqual(tg({ mode: "auto", width: 1099 }), { mode: "expanded", overlay: "close" }, "icons at 1099 (447 px of reading pane when open): the menu opens in its place");
assert.deepEqual(tg({ mode: "auto", width: 1099 }, true), { mode: "expanded", overlay: "close" }, "a hover overlay with room: the menu opens in place and the overlay closes");
assert.deepEqual(tg({ mode: "auto", width: 960 }), { mode: "auto", overlay: "open" }, "no room: the setting stays automatic, the overlay opens pinned");
assert.deepEqual(tg({ mode: "auto", width: 1000 }), { mode: "auto", overlay: "open" }, "1000 x 700 (AC-1.6.1)");
assert.deepEqual(tg({ mode: "auto", width: 1000 }, true), { mode: "auto", overlay: "close" }, "the overlay is open: Ctrl+B closes it, the setting stays");
assert.deepEqual(tg({ mode: "expanded", width: 960 }), { mode: "expanded", overlay: "open" }, "squeezed: the setting stays, the overlay is pinned");
assert.deepEqual(tg({ mode: "expanded", width: 960 }, true), { mode: "expanded", overlay: "close" });
assert.deepEqual(tg({ mode: "collapsed", width: 960 }), { mode: "collapsed", overlay: "open" }, "folded by choice, no room: the overlay, the choice stays");
assert.deepEqual(tg({ mode: "collapsed", width: 960 }, true), { mode: "collapsed", overlay: "close" });
// the bottom reading pane shares the width with the list only: the full menu has room at 960 there
assert.deepEqual(toggleSidebar({ ...base, mode: "auto", width: 1000, bottomPane: true }, false), { mode: "expanded", overlay: "close" });
// Ctrl+B any number of times in a narrow window never changes the setting (the old control saved "expanded" and could never close the overlay)
{
  let m = "auto", open = false;
  for (let i = 0; i < 6; i++) {
    const r = toggleSidebar({ ...base, mode: m, width: 960 }, open);
    m = r.mode;
    open = r.overlay === "open" ? true : r.overlay === "close" ? false : open;
    assert.equal(open, i % 2 === 0, `press ${i + 1}: the overlay is ${i % 2 === 0 ? "open" : "closed"}`);
  }
  assert.equal(m, "auto");
}
// what the control shows (label "Collapse side menu", PanelLeftClose, aria-expanded true) while the full menu is on screen
assert.equal(sidebarControlOpen({ ...base, mode: "auto", width: 1400 }, false), true, "full menu");
assert.equal(sidebarControlOpen({ ...base, mode: "collapsed", width: 1400 }, false), false, "icons, room");
assert.equal(sidebarControlOpen({ ...base, mode: "collapsed", width: 1400 }, true), false, "a hover overlay with room: the control would open it in place");
assert.equal(sidebarControlOpen({ ...base, mode: "auto", width: 1000 }, false), false, "icons, no room, overlay closed");
assert.equal(sidebarControlOpen({ ...base, mode: "auto", width: 1000 }, true), true, "icons, no room, overlay open");

// 9. Ctrl/Cmd+B: not in a field, not in the message being written (Bold), not with a dialog open, not with AltGr, not with Shift / Alt
const ev = (key, mods = "") => ({ key, ctrlKey: mods.includes("c"), metaKey: mods.includes("m"), altKey: mods.includes("a"), shiftKey: mods.includes("s"), getModifierState: () => false });
const free = { inField: false, inCompose: false, modalOpen: false };
assert.equal(sidebarToggleKey(ev("b", "c"), free), true);
assert.equal(sidebarToggleKey(ev("B", "c"), free), true, "Caps Lock");
assert.equal(sidebarToggleKey(ev("b", "m"), free), true, "Cmd+B (Mac)");
assert.equal(sidebarToggleKey(ev("b", ""), free), false);
assert.equal(sidebarToggleKey(ev("b", "cs"), free), false, "Ctrl+Shift+B is Show Bcc");
assert.equal(sidebarToggleKey(ev("b", "ca"), free), false);
assert.equal(sidebarToggleKey(ev("b", "c"), { ...free, inField: true }), false);
assert.equal(sidebarToggleKey(ev("b", "c"), { ...free, inCompose: true }), false, "Bold");
assert.equal(sidebarToggleKey(ev("b", "c"), { ...free, modalOpen: true }), false);
assert.equal(sidebarToggleKey({ ...ev("b", "ca"), getModifierState: (k) => k === "AltGraph" }, free), false, "AltGr");

// 10. the setting and the screens: one global preference, "auto" by default, read back safely; the control, the key, the settings and the CI run use it
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const prefs = read("src/prefs.ts");
assert.match(prefs, /sidebar: SidebarMode;/);
assert.match(prefs, /sidebar: "auto",/, "the default is automatic");
assert.match(prefs, /sidebar: normalizeSidebar\(p\.sidebar\)/, "a stored value that is not one of the three is read as automatic");
assert.doesNotMatch(prefs, /accountPrefs\[[^\]]*\]\??\.sidebar/, "not a per-mailbox setting");
const app = read("src/App.tsx");
assert.match(app, /sidebarLayout\(\{ mode: prefs\.sidebar/);
assert.match(app, /sidebarToggleKey\(e,/);
const pane = read("src/components/FolderPane.tsx");
assert.match(pane, /aria-expanded=\{shown\}/, "the control says whether the menu is on screen");
assert.match(pane, /toggleSidebar\(sidebarInput\(\), peek\.open\)/, "the control asks the rule with the state of the overlay");
assert.match(read("src/useSidebar.ts"), /sidebarToggle: s\.sidebarToggle \+ 1/, "Ctrl+B asks the menu, which knows its overlay");
assert.match(pane, /Ctrl\+B/);
const settings = read("src/components/SettingsDialog.tsx");
for (const v of ["auto", "expanded", "collapsed"]) assert.match(settings, new RegExp(`<option value="${v}">`), `Settings > Appearance offers ${v}`);
assert.match(settings, /sideReset/, "Reset to automatic");
assert.match(settings, /\["Ctrl\+B", "settings\.keys\.sideMenu"\]/, "listed in Settings > Shortcuts");
// the tests run from the list the release workflow's node-tests job reads
const ci = read(".github/workflows/release.yml") + read(".github/node-tests.txt");
assert.match(ci, /test-sidebar-state\.mjs/);
assert.match(ci, /test-sidebar-collapse\.mjs --quick/);

console.log("ok - test-sidebar-state");
