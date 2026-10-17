// The website's Appearance preview carries the primary colour in the DARK top bar exactly like the app (F-31, src/topBarDark.ts).
// 1. the formula in docs/assets/story.js (darkTopBar) for the 7 presets + 10 edge colours: luminance <= 0.06, white text >= 7:1, muted >= 4.5:1,
//    text on the search field / hover overlays >= 4.5:1, tinted for vivid colours, neutral for grey ones, and the app's bars for the presets;
// 2. parity with the app's own function over a dense colour sweep (when this Node can run the .ts: Node >= 22.18 or --experimental-strip-types);
// 3. wiring in docs/assets/style.css and story.js (dark --a-top is built from the two ends, forced-colors / prefers-contrast: more are neutral,
//    light is untouched). The rendered result is measured in a browser by test-site-appearance.mjs.
// Run: node scripts/test-site-top-bar-dark.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DOCS, checkFormula, siteDarkTopBar } from './lib/site-top-bar.mjs';

const read = (p) => fs.readFileSync(path.join(DOCS, p), 'utf8').replace(/\r\n/g, '\n');
const darkTopBar = siteDarkTopBar();
console.log(checkFormula(darkTopBar).join('\n'));

// ---- parity with the app ----
let appFn = null;
try { appFn = (await import(pathToFileURL(path.join(DOCS, '..', 'src', 'topBarDark.ts')).href)).darkTopBar; } catch { /* old Node without type stripping */ }
if (appFn) {
  let n = 0;
  const hx = (v) => '#' + v.map((k) => k.toString(16).padStart(2, '0')).join('');
  for (let r = 0; r < 256; r += 15) for (let g = 0; g < 256; g += 15) for (let b = 0; b < 256; b += 15) { const c = hx([r, g, b]); assert.deepEqual(darkTopBar(c), appFn(c), `parity with the app for ${c}`); n++; }
  for (let i = 0; i < 2000; i++) { const c = hx([0, 0, 0].map(() => Math.floor(Math.random() * 256))); assert.deepEqual(darkTopBar(c), appFn(c), `parity with the app for ${c}`); n++; }
  console.log(`parity with src/topBarDark.ts: ${n} colours identical`);
} else console.log('parity with src/topBarDark.ts: skipped (this Node cannot import .ts; run with --experimental-strip-types)');

// ---- wiring ----
const css = read('assets/style.css'), js = read('assets/story.js');
const dark = (css.match(/^ {2}\.app:not\(\[data-theme="light"\]\) \{[^}]*\}|^\.app\[data-theme="dark"\] \{[^}]*\}/gm) ?? []).filter((b) => b.includes('--a-bg: #1b1c20'));
assert.equal(dark.length, 2, 'both dark .app blocks (system + explicit) found');
for (const b of dark) {
  assert.ok(b.includes('--a-top: linear-gradient(135deg, var(--a-top-dk-s, #25272d), var(--a-top-dk-e, #2d3038))'), 'dark --a-top follows the primary colour (neutral fallback)');
  assert.ok(!/--a-top: linear-gradient\(135deg, #25272d/.test(b), 'no hard-coded neutral bar left in a dark block');
}
assert.match(css, /@media \(prefers-color-scheme: dark\) and \(\(forced-colors: active\) or \(prefers-contrast: more\)\) \{\s*\.app:not\(\[data-theme="light"\]\) \{ --a-top: linear-gradient\(135deg, #25272d, #2d3038\); \}/, 'system dark + high contrast stays neutral');
assert.match(css, /@media \(forced-colors: active\), \(prefers-contrast: more\) \{\s*\.app\[data-theme="dark"\] \{ --a-top: linear-gradient\(135deg, #25272d, #2d3038\); \}/, 'explicit dark + high contrast stays neutral');
assert.match(js, /setProperty\('--a-top-dk-s', dk\.start\)/, 'the customiser publishes the start colour');
assert.match(js, /setProperty\('--a-top-dk-e', dk\.end\)/, 'the customiser publishes the end colour');
assert.match(js, /else \{ var tp = topSet\(S\.accent\);[^}]*setProperty\('--a-top', tp\.grad\)/, 'light keeps topSet()');
console.log('site-top-bar-dark: all checks passed');
