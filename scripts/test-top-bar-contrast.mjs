// Light theme: the text and the placeholder of the search box on the top bar read at >= 4.5:1 against the search FIELD (the translucent field colour painted over the
// bar) at both ends of the bar's gradient and in between (W1.13 a, 1.0.7; topBar() in src/prefs.ts used to check the text against the bar only, not against the field over it).
// Colours tested, each the way the store applies them (store.ts applyPrefs: topBar(buttonAccent(accent))): the default accent, the 7 presets, the 10 mailbox colours,
// and a sweep of 72 hues x 3 lightnesses. The maths and topBar() are in src/topBarLight.ts (pure); the colour lists are read from src/prefs.ts.
// Run: node --experimental-strip-types scripts/test-top-bar-contrast.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buttonAccent, topBar } from "../src/topBarLight.ts";

// the colours come from src/prefs.ts (it cannot be imported by node: read its text)
const prefs = readFileSync(new URL("../src/prefs.ts", import.meta.url), "utf8");
const listOf = (block) => [...block.matchAll(/"(#[0-9a-fA-F]{6})"/g)].map((m) => m[1]);
const PRESETS = listOf(/export const ACCENT_PRESETS[\s\S]*?\n\];/.exec(prefs)[0]);
const PALETTE = listOf(/export const ACCOUNT_PALETTE = \[[\s\S]*?\];/.exec(prefs)[0]);
const DEFAULT_ACCENT = /accent: "(#[0-9a-fA-F]{6})"/.exec(/export const DEFAULT_PREFS[\s\S]*?\n\};/.exec(prefs)[0])[1];

// ---- WCAG helpers (independent of the module under test)
const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const lin = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const mix = (a, b, t) => a.map((v, i) => v * (1 - t) + b[i] * t);
/** "rgba(r,g,b,a)" painted over `bg` */
const paint = (rgba, bg) => {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(rgba);
  assert.ok(m, `not a colour: ${rgba}`);
  const a = m[4] === undefined ? 1 : Number(m[4]);
  return bg.map((v, i) => v * (1 - a) + Number(m[i + 1]) * a);
};
const hsl = (h, s, l) => {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${[f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;
};

const colours = new Map();
colours.set("default", DEFAULT_ACCENT);
PRESETS.forEach((hex, i) => colours.set(`preset ${i + 1} ${hex}`, hex));
PALETTE.forEach((hex, i) => colours.set(`mailbox colour ${i + 1}`, hex));
for (let h = 0; h < 360; h += 5) for (const l of [0.3, 0.5, 0.7]) colours.set(`hsl(${h},70%,${l * 100}%)`, hsl(h, 0.7, l));
assert.equal(PRESETS.length, 7);
assert.equal(PALETTE.length, 10);
assert.equal(colours.size, 1 + 7 + 10 + 72 * 3);

let worst = { r: 99, name: "" };
for (const [name, accent] of colours) {
  const bar = topBar(buttonAccent(accent));
  const ends = [...bar.bg.matchAll(/#[0-9a-f]{6}/gi)].map((m) => rgb(m[0]));
  assert.equal(ends.length, 2, `${name}: the bar is a gradient of two colours (${bar.bg})`);
  const fg = rgb(bar.fg);
  for (let t = 0; t <= 1.0001; t += 0.125) {
    const under = mix(ends[0], ends[1], t); // the bar under the field, from one end to the other
    for (const field of [bar.field, bar.fieldHover]) {
      const r = contrast(fg, paint(field, under));
      if (r < worst.r) worst = { r, name: `${name} (${accent}) ${field} at ${t}` };
      assert.ok(r >= 4.5, `${name} (${accent}): text ${bar.fg} on the search field ${field} over the bar at ${t.toFixed(3)} is ${r.toFixed(2)}:1, want >= 4.5`);
    }
    // the bar itself still carries the title and the icons
    const rb = contrast(fg, under);
    assert.ok(rb >= 4.5, `${name} (${accent}): ${bar.fg} on the bar at ${t.toFixed(3)} is ${rb.toFixed(2)}:1`);
  }
}
console.log(`ok - test-top-bar-contrast (${colours.size} colours, lowest ${worst.r.toFixed(2)}:1: ${worst.name})`);
