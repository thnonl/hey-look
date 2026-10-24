// The colours of the native title bar of the secondary windows (src/captionColors.ts, W4.3 REQ-4.3.1 / 4.3.4): the right end of the main window's band in
// Light and in Dark, and a readable text colour on it. Pure maths plus source checks of how the main page hands them over.
// Run: node --experimental-strip-types scripts/test-caption-colors.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { captionColors, gradientT, readableCaption } from "../src/captionColors.ts";
import { darkTopBar } from "../src/topBarDark.ts";
import { buttonAccent, topBar } from "../src/topBarLight.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const lin = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lumOf = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const contrast = (a, b) => { const x = lumOf(rgb(a)), y = lumOf(rgb(b)); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
/** the last colour stop of the main page's own light gradient (what App.css --top ends with) */
const gradientEnd = (css) => css.match(/(#[0-9a-f]{6}) 100%\)$/)[1];

// ---- the default accent (#0f6cbd), the end of the band (the default of the function), white text
const def = captionColors("#0f6cbd");
assert.deepEqual(def.light, { bg: "#0f6cbd", fg: "#ffffff" }, "Light, default accent: the accent itself is the right end of the band");
assert.deepEqual(def.dark, { bg: darkTopBar("#0f6cbd").end, fg: "#ffffff" }, "Dark: the end of the dark band (--top-dk-end)");
assert.deepEqual(rgb(def.dark.bg), [23, 50, 78]);

// ---- where the minimize button sits on the 135deg gradient line of the 50 px band: the caption takes the band's colour THERE (AC-4.3.1, +-3 per channel)
assert.equal(gradientT(0, 0, 1280, 50), 0, "the top left corner");
assert.equal(gradientT(1280, 50, 1280, 50), 1, "the bottom right corner");
assert.ok(Math.abs(gradientT(1180, 25, 1280, 50) - 0.906) < 0.001, "x + y over width + height");
assert.equal(gradientT(5, 5, 0, 0), 1, "no box: the end");
assert.equal(gradientT(-50, -50, 100, 100), 0, "clamped");
{
  const start = rgb(topBar("#0f6cbd").bg.match(/#[0-9a-f]{6}/)[0]), end = rgb("#0f6cbd");
  const t = gradientT(1180, 25, 1280, 50);
  const c = rgb(captionColors("#0f6cbd", t).light.bg);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(c[i] - (start[i] + (end[i] - start[i]) * t)) <= 1, `channel ${i} is the gradient at t=${t}`);
  // a 960 px window: the caption is a little darker than at 1280 px, never lighter than the end
  const narrow = rgb(captionColors("#0f6cbd", gradientT(860, 25, 960, 50)).light.bg);
  assert.ok(narrow[1] <= end[1] && narrow[1] >= start[1] && narrow[2] <= end[2]);
  assert.deepEqual(captionColors("#0f6cbd", 1), def, "t = 1 is the end");
  assert.notDeepEqual(captionColors("#0f6cbd", 0.5), def);
  const dk0 = darkTopBar("#0f6cbd");
  assert.equal(captionColors("#0f6cbd", 0).dark.bg, dk0.start, "t = 0 is the start of the dark band");
}

// ---- the same end stop as the main page's band, for the presets, the edge cases and a sweep of hues
const PRESETS = ["#0f6cbd", "#0e7c86", "#1a7f4b", "#6d4aff", "#c2327d", "#c4570c", "#475569"];
const EDGES = ["#ffffff", "#000000", "#ff0000", "#00ff00", "#0000ff", "#808080", "#ffff00", "#f3ecff", "#0a1030", "#7c8087", "#fffacd"];
const sweep = [];
for (let h = 0; h < 360; h += 15) for (const [s, l] of [[0.9, 0.5], [0.5, 0.8], [0.7, 0.25]]) {
  const a = s * Math.min(l, 1 - l), f = (n) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  sweep.push("#" + [f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join(""));
}
for (const p of [...PRESETS, ...EDGES, ...sweep]) {
  const c = captionColors(p);
  const band = topBar(buttonAccent(p));
  assert.equal(c.light.bg, gradientEnd(band.bg), `${p}: Light = the right end of the light band`);
  assert.equal(c.dark.bg, darkTopBar(p).end, `${p}: Dark = the right end of the dark band`);
  // REQ-4.3.4: the text reads at 4.5:1 in both, in a colour of the band's own or black / white
  assert.ok(contrast(c.light.bg, c.light.fg) >= 4.5, `${p}: Light text ${c.light.fg} on ${c.light.bg} = ${contrast(c.light.bg, c.light.fg).toFixed(2)}`);
  assert.ok(contrast(c.dark.bg, c.dark.fg) >= 4.5, `${p}: Dark text ${c.dark.fg} on ${c.dark.bg}`);
  assert.equal(c.dark.fg, "#ffffff", `${p}: the dark band keeps white text (--top-fg)`);
  for (const v of [c.light.bg, c.light.fg, c.dark.bg, c.dark.fg]) assert.match(v, /^#[0-9a-f]{6}$/, `${p}: ${v} is #rrggbb (the backend takes nothing else)`);
}

// ---- a custom very light top bar colour: the caption text is dark and readable (AC-4.3.6)
for (const light of ["#ffffff", "#f5f5f5", "#fffacd", "#ffee00"]) {
  const c = captionColors(light);
  assert.ok(lumOf(rgb(c.light.fg)) < 0.1, `${light}: dark text on a light caption (${c.light.fg})`);
}
// the band's own text colour is kept when it reads; else black or white, whichever is higher (the fallback of REQ-4.3.4)
assert.equal(readableCaption("#0d60a7", "#ffffff"), "#ffffff");
assert.equal(readableCaption("#ffee00", "#0b1220"), "#0b1220", "a colour of the band's own that reads is kept");
assert.equal(readableCaption("#ffee00", "#ffffff"), "#000000", "white on yellow does not read: black");
assert.equal(readableCaption("#101010", "#202020"), "#ffffff", "dark on dark does not read: white");
assert.equal(readableCaption("#808080", "#7f7f7f"), "#000000", "mid grey: black has the higher contrast (5.3 against 3.9)");

// ---- how the main page hands them over: only the main page (store.ts), when the colours changed, through the one command
const store = read("src/store.ts");
assert.ok(store.includes("export function publishCaptionColors(p: Prefs)") && store.includes("if (key === captionSent) return;"), "only when the colours changed");
assert.equal((store.match(/publishCaptionColors\(prefs\);/g) ?? []).length, 2, "at the start and at every change of the preferences of the main page");
const apply = store.slice(store.indexOf("export function applyPrefs("), store.indexOf("let captionSent"));
assert.ok(!apply.includes("windowCaptionColors") && !apply.includes("publishCaptionColors"), "applyPrefs also runs in the secondary windows: they never send colours");
assert.ok(read("src/api.ts").includes('invoke<void>("window_caption_colors", { colors })'));
const lib = read("src-tauri/src/lib.rs"), build = read("src-tauri/build.rs");
assert.ok(lib.includes("wintheme::window_caption_colors,") && build.includes('"window_caption_colors"'), "registered and in the manifest");
assert.ok(JSON.parse(read("src-tauri/capabilities/default.json")).permissions.includes("allow-window-caption-colors"));
assert.ok(!JSON.parse(read("src-tauri/capabilities/popout.json")).permissions.includes("allow-window-caption-colors"), "a window never sets its own caption colour");
// the dev preview answers the command (no window system there)
console.log("ok - test-caption-colors");
