// Dark-theme top bar tint (src/topBarDark.ts): for the 7 presets and 10 edge-case custom colours the bar must be DARK
// (relative luminance <= limit), keep WCAG contrast of the header text (white, 7:1) and of the muted text token (4.5:1) on both
// gradient ends and on the search-field / hover overlays, be clearly tinted for vivid colours and neutral for near-grey ones.
// Also source checks: the CSS uses the variable, forced-colors / prefers-contrast fall back to the neutral bar, store.ts sets it.
// Run: node --experimental-strip-types scripts/test-top-bar-dark.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DARK_TOP_MAX_LUM, darkTopBar } from "../src/topBarDark.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

// ---- WCAG helpers (independent of the module under test) ----
const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const lin = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lumOf = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const contrast = (a, b) => { const x = lumOf(a), y = lumOf(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const over = (fg, alpha, bg) => bg.map((v, i) => v * (1 - alpha) + fg[i] * alpha); // fg at `alpha` painted on bg
// plain sRGB distance of the tint from the neutral bar of the same lightness (max channel spread)
const spread = (c) => Math.max(...c) - Math.min(...c);

// ---- tokens the header uses (src/App.css, dark): text #fff (--top-fg), muted #a2a8b3, field .17 / hover .24 / button hover .18 of white ----
const FG = [255, 255, 255], MUTED = rgb("#a2a8b3");
const FIELD = 0.17, FIELD_H = 0.24, BTN_H = 0.18;

const PRESETS = { blue: "#0f6cbd", teal: "#0e7c86", green: "#1a7f4b", violet: "#6d4aff", rose: "#c2327d", orange: "#c4570c", slate: "#475569" };
const EDGES = {
  white: "#ffffff", black: "#000000", red: "#ff0000", green: "#00ff00", blue: "#0000ff", midGrey: "#808080",
  yellow: "#ffff00", pastel: "#f3ecff", navy: "#0a1030", nearGrey: "#7c8087",
};
const NEUTRAL = new Set(["white", "black", "midGrey"]);

const rows = [];
for (const [name, hex] of [...Object.entries(PRESETS), ...Object.entries(EDGES)]) {
  const bar = darkTopBar(hex);
  assert.match(bar.start, /^#[0-9a-f]{6}$/, name);
  assert.match(bar.end, /^#[0-9a-f]{6}$/, name);
  let minFg = 99, minMuted = 99, minField = 99;
  for (const end of [bar.start, bar.end]) {
    const c = rgb(end);
    assert.ok(lumOf(c) <= DARK_TOP_MAX_LUM, `${name} ${end}: luminance ${lumOf(c).toFixed(4)} > ${DARK_TOP_MAX_LUM}`);
    minFg = Math.min(minFg, contrast(FG, c));
    minMuted = Math.min(minMuted, contrast(MUTED, c));
    for (const a of [FIELD, FIELD_H, BTN_H]) minField = Math.min(minField, contrast(FG, over(FG, a, c))); // text on the search field / hovered button
  }
  assert.ok(minFg >= 7, `${name}: body text ${minFg.toFixed(2)} < 7`);
  assert.ok(minMuted >= 4.5, `${name}: secondary text ${minMuted.toFixed(2)} < 4.5`);
  assert.ok(minField >= 4.5, `${name}: text on field/hover ${minField.toFixed(2)} < 4.5`);
  // the bar still reads as a bar on the dark surface: lighter than --bg (#1b1c20) at both ends
  assert.ok(lumOf(rgb(bar.start)) >= lumOf(rgb("#1b1c20")), `${name}: not lighter than the page`);
  assert.ok(lumOf(rgb(bar.end)) >= lumOf(rgb(bar.start)) - 1e-9, `${name}: gradient must not get darker towards the end`);
  const tint = spread(rgb(bar.end));
  if (name in PRESETS || ["red", "green", "blue", "yellow", "navy"].includes(name)) assert.ok(tint >= 14, `${name}: tint too weak (${tint})`);
  if (NEUTRAL.has(name)) assert.ok(tint <= 2, `${name}: grey primary must give the neutral bar (${bar.end})`);
  rows.push(`${name.padEnd(8)} ${hex}  ${bar.start} -> ${bar.end}  text ${minFg.toFixed(1)}  muted ${minMuted.toFixed(1)}  field ${minField.toFixed(1)}  tint ${tint}`);
}
// near-grey degrades gracefully: weaker than a vivid colour, stronger than a true grey
assert.ok(spread(rgb(darkTopBar(EDGES.nearGrey).end)) < spread(rgb(darkTopBar(PRESETS.blue).end)));
// presets are told apart from each other
const ends = Object.values(PRESETS).map((h) => darkTopBar(h).end);
assert.equal(new Set(ends).size, 7, "the 7 presets give 7 different bars");
// deterministic
assert.deepEqual(darkTopBar("#0f6cbd"), darkTopBar("#0F6CBD"));
console.log(rows.join("\n"));

// ---- wiring (source checks) ----
const css = read("src/App.css"), store = read("src/store.ts");
assert.match(store, /darkTopBar\(/, "store.applyPrefs computes the dark bar");
assert.match(store, /setProperty\("--top-dk-start", /, "store.applyPrefs publishes --top-dk-start");
assert.match(store, /setProperty\("--top-dk-end", /, "store.applyPrefs publishes --top-dk-end");
const darkBlocks = (css.match(/^ {2}:root:not\(\[data-theme="light"\]\) \{[^}]*\}|^:root\[data-theme="dark"\] \{[^}]*\}/gm) ?? []).filter((b) => b.includes("color-scheme: dark"));
assert.equal(darkBlocks.length, 2, "both dark blocks (system + explicit) found");
for (const b of darkBlocks) {
  assert.ok(b.includes("--top: linear-gradient(135deg, var(--top-dk-start, #25272d) 0%, var(--top-dk-end, #2d3038) 100%)"), "dark --top follows the primary colour");
  assert.ok(!/--top: linear-gradient\(135deg, #25272d/.test(b), "no hard-coded neutral bar left in the dark block");
}
assert.match(css, /@media \(forced-colors: active\), \(prefers-contrast: more\)/, "high-contrast media query");
const hc = css.slice(css.indexOf("@media (forced-colors: active), (prefers-contrast: more)"));
assert.match(hc, /--top: linear-gradient\(135deg, #25272d 0%, #2d3038 100%\)/, "high-contrast keeps the neutral dark bar");
console.log("top-bar-dark: all checks passed");
