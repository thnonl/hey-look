// The website's dark-theme top bar (docs/assets/story.js darkTopBar, a 1:1 port of the app's src/topBarDark.ts, F-31) and the checks that
// hold it to the app's numbers. story.js is a browser script (an IIFE that finds nothing to do without the page), so it is run here in a vm with
// a stub window/document and the function is read from the HL object it publishes. Used by test-site-top-bar-dark.mjs and test-site-appearance.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs');

export function siteDarkTopBar() {
  const HL = {};
  const win = { HL, matchMedia: () => ({ matches: false }) };
  const doc = { documentElement: { getAttribute: () => null }, querySelector: () => null, querySelectorAll: () => [] };
  vm.runInNewContext(fs.readFileSync(path.join(DOCS, 'assets', 'story.js'), 'utf8'), { window: win, document: doc }, { filename: 'story.js' });
  assert.equal(typeof HL.darkTopBar, 'function', 'story.js must publish HL.darkTopBar');
  return (hex) => { const b = HL.darkTopBar(hex); return { start: b.start, end: b.end }; }; // plain objects: the vm has its own Object prototype
}

// ---- WCAG helpers: the app test's (scripts/test-top-bar-dark.mjs), independent of the code under test ----
export const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const lin = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
export const lumOf = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
export const contrast = (a, b) => { const x = lumOf(a), y = lumOf(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const over = (fg, alpha, bg) => bg.map((v, i) => v * (1 - alpha) + fg[i] * alpha);
const spread = (c) => Math.max(...c) - Math.min(...c);

export const DARK_TOP_MAX_LUM = 0.06;
export const PRESETS = { blue: '#0f6cbd', teal: '#0e7c86', green: '#1a7f4b', violet: '#6d4aff', rose: '#c2327d', orange: '#c4570c', slate: '#475569' };
export const EDGES = {
  white: '#ffffff', black: '#000000', red: '#ff0000', green: '#00ff00', blue: '#0000ff', midGrey: '#808080',
  yellow: '#ffff00', pastel: '#f3ecff', navy: '#0a1030', nearGrey: '#7c8087',
};
// what the app gives for the 7 presets (coder-v106-dark-header.md): the site must show exactly these bars
export const APP_BARS = {
  blue: ['#09243f', '#17324e'], teal: ['#05282c', '#14363a'], green: ['#022b15', '#123923'], violet: ['#201e3e', '#2d2c4d'],
  rose: ['#381525', '#472333'], orange: ['#391806', '#492614'], slate: ['#1a2330', '#27313f'],
};

/** Asserts the formula for the 7 presets + 10 edge colours with the app's numbers (luminance <= 0.06, text 7:1, muted 4.5:1, field/hover 4.5:1, tint). Returns report lines. */
export function checkFormula(darkTopBar = siteDarkTopBar()) {
  const FG = [255, 255, 255], MUTED = rgb('#a2a8b3'); // header text and the muted token of the dark theme
  const FIELD = 0.17, FIELD_H = 0.24, BTN_H = 0.18; // search field / hover overlays of white on the bar
  const NEUTRAL = new Set(['white', 'black', 'midGrey']);
  const rows = [];
  for (const [name, hex, preset] of [...Object.entries(PRESETS).map(([n, h]) => [n, h, true]), ...Object.entries(EDGES).map(([n, h]) => [n, h, false])]) { // (edge "green"/"blue" are not the presets of that name)
    const bar = darkTopBar(hex);
    assert.match(bar.start, /^#[0-9a-f]{6}$/, name);
    assert.match(bar.end, /^#[0-9a-f]{6}$/, name);
    let minFg = 99, minMuted = 99, minField = 99;
    for (const end of [bar.start, bar.end]) {
      const c = rgb(end);
      assert.ok(lumOf(c) <= DARK_TOP_MAX_LUM, `${name} ${end}: luminance ${lumOf(c).toFixed(4)} > ${DARK_TOP_MAX_LUM}`);
      minFg = Math.min(minFg, contrast(FG, c));
      minMuted = Math.min(minMuted, contrast(MUTED, c));
      for (const a of [FIELD, FIELD_H, BTN_H]) minField = Math.min(minField, contrast(FG, over(FG, a, c)));
    }
    assert.ok(minFg >= 7, `${name}: body text ${minFg.toFixed(2)} < 7`);
    assert.ok(minMuted >= 4.5, `${name}: secondary text ${minMuted.toFixed(2)} < 4.5`);
    assert.ok(minField >= 4.5, `${name}: text on field/hover ${minField.toFixed(2)} < 4.5`);
    assert.ok(lumOf(rgb(bar.start)) >= lumOf(rgb('#1b1c20')), `${name}: not lighter than the page`);
    assert.ok(lumOf(rgb(bar.end)) >= lumOf(rgb(bar.start)) - 1e-9, `${name}: gradient must not get darker towards the end`);
    const tint = spread(rgb(bar.end));
    if (preset || ['red', 'green', 'blue', 'yellow', 'navy'].includes(name)) assert.ok(tint >= 14, `${name}: tint too weak (${tint})`);
    if (NEUTRAL.has(name)) assert.ok(tint <= 2, `${name}: grey primary must give the neutral bar (${bar.end})`);
    if (preset) assert.deepEqual([bar.start, bar.end], APP_BARS[name], `${name}: the site's bar differs from the app's`);
    rows.push(`${name.padEnd(8)} ${hex}  ${bar.start} -> ${bar.end}  text ${minFg.toFixed(1)}  muted ${minMuted.toFixed(1)}  field ${minField.toFixed(1)}  tint ${tint}`);
  }
  assert.ok(spread(rgb(darkTopBar(EDGES.nearGrey).end)) < spread(rgb(darkTopBar(PRESETS.blue).end)), 'near-grey is weaker than a vivid colour');
  assert.equal(new Set(Object.values(PRESETS).map((h) => darkTopBar(h).end)).size, 7, 'the 7 presets give 7 different bars');
  assert.deepEqual(darkTopBar('#0f6cbd'), darkTopBar('#0F6CBD'), 'case-insensitive');
  assert.deepEqual(darkTopBar('#fff'), darkTopBar('#ffffff'), 'short form');
  return rows;
}
