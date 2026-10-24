#!/usr/bin/env node
// W9.7: the theme tokens on an engine without color-mix() (src/colorFallback.ts). App.css builds a few custom properties of the theme with color-mix(); WebKit before Safari 16.2 (macOS 11 and 12 without a
// newer Safari) keeps the property but makes every var() of it invalid, so the dark theme lost its accent colour. The fallback computes the same tokens in sRGB and sets them as plain colours.
//   1. static: every custom property of App.css that uses color-mix() is computed by colorFallback.ts (or is listed here with its reason): adding one without the fallback fails;
//   2. the tokens computed with the seam on (localStorage["heylook.forceColorFallback"] = "1", dev preview only) equal the browser's own color-mix() values within 1 per channel,
//      Light and Dark, the default accent and the 7 presets;
//   3. an old engine, simulated (every color-mix( in the stylesheets renamed so that the browser drops it, as an engine that does not know the function does): without the fallback the tokens are
//      invalid (the control, so the simulation is real), with it they are valid and equal to the values of 2, and the top bar gradient is still a gradient.
//   node scripts/test-color-fallback.mjs [--require-browser]
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sleep, startHarness } from './cdp-harness.mjs';

const css = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8');
const src = readFileSync(new URL('../src/colorFallback.ts', import.meta.url), 'utf8');
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); } };

// custom properties that use color-mix( but need no token of their own, with the reason
const NOT_NEEDED = new Map([['--top', 'color-mix() only as the fallback of var(--top-lt), which applyPrefs (store.ts) always sets']]);

await check('every custom property of App.css that uses color-mix() is computed by colorFallback.ts', async () => {
  const names = new Set();
  for (const m of css.matchAll(/(--[a-z][\w-]*)\s*:\s*([^;{}]*)/g)) if (m[2].includes('color-mix(')) names.add(m[1]);
  assert.ok(names.size >= 4, `only ${names.size} custom properties found: the scan is broken`);
  const covered = new Set([...src.matchAll(/"(--[a-z][\w-]*)"/g)].map((m) => m[1]));
  const missing = [...names].filter((n) => !covered.has(n) && !NOT_NEEDED.has(n));
  assert.deepEqual(missing, [], `custom properties with color-mix() that colorFallback.ts does not compute: ${missing.join(', ')} (compute them there, or add them to NOT_NEEDED with a reason)`);
  for (const n of NOT_NEEDED.keys()) assert.ok(names.has(n), `NOT_NEEDED lists ${n}, which no longer uses color-mix(): remove it`);
});

const H = await startHarness('test-color-fallback', { vitePort0: 5100 });
const { evaluate } = H;
const TOKENS = { light: ['--accent', '--accent-hover', '--accent-soft', '--top-ring'], dark: ['--accent', '--accent-hover', '--accent-soft'] };
const PROBE = `window.__probeTokens = (names) => { const d = document.createElement('div'); document.body.appendChild(d); const out = {}; for (const n of names) { d.style.backgroundColor = ''; d.style.backgroundColor = 'var(' + n + ')'; out[n] = getComputedStyle(d).backgroundColor; } d.style.backgroundColor = ''; d.style.backgroundImage = 'var(--top)'; out['--top'] = getComputedStyle(d).backgroundImage.startsWith('linear-gradient') ? 'gradient' : getComputedStyle(d).backgroundImage; d.remove(); return out; }; 1`;
// (a colour made by color-mix() is reported as color(srgb r g b) with the channels in 0..1)
const rgb = (s) => {
  const c = /color\(srgb ([^)]*)\)/.exec(s);
  if (c) return c[1].split(/[\s/]+/).filter(Boolean).map((x, i) => (i < 3 ? parseFloat(x) * 255 : parseFloat(x)));
  return (/rgba?\(([^)]*)\)/.exec(s)?.[1] ?? '').split(',').map((x) => parseFloat(x));
};
const near = (a, b) => a.length >= 3 && b.length >= 3 && [0, 1, 2].every((i) => Math.abs(a[i] - b[i]) <= 1);

const openWith = async (force) => {
  await H.openApp('lang=en', 1280, 800);
  await evaluate(`localStorage.setItem('heylook.forceColorFallback', ${JSON.stringify(force ? '1' : '0')}); 1`);
  await evaluate('location.reload(); 1').catch(() => undefined);
  await sleep(1500);
  await H.openApp('lang=en', 1280, 800).catch(() => undefined);
  await evaluate(PROBE);
};
const values = async (themes, accents) => {
  const out = {};
  for (const theme of themes) {
    for (const accent of accents) {
      await evaluate(`window.__store.getState().setPrefs({ theme: ${JSON.stringify(theme)}, accent: ${JSON.stringify(accent)} }); 1`);
      await sleep(120);
      out[`${theme} ${accent}`] = await evaluate(`window.__probeTokens(${JSON.stringify(TOKENS[theme])})`);
    }
  }
  return out;
};

try {
  const presets = await (async () => { await H.openApp('lang=en', 1280, 800); return evaluate(`import('/src/prefs.ts').then((m) => [m.DEFAULT_PREFS.accent, ...m.ACCENT_PRESETS.map((p) => p[0])])`); })();
  assert.ok(presets.length >= 8, `${presets.length} accents (the default and the 7 presets)`);
  let modern;
  await check('the browser itself (color-mix() native, no seam): the reference values', async () => {
    await openWith(false);
    modern = await values(['light', 'dark'], presets);
    for (const [k, v] of Object.entries(modern)) for (const [n, c] of Object.entries(v)) if (n !== '--top') assert.ok(rgb(c).length >= 3 && rgb(c)[3] !== 0, `${k} ${n}: ${c} is not a colour`);
  });
  await check('the fallback computes the same tokens as color-mix() within 1 per channel (Light and Dark, 8 accents)', async () => {
    await openWith(true);
    assert.equal(await evaluate(`localStorage.getItem('heylook.forceColorFallback')`), '1');
    const mine = await values(['light', 'dark'], presets);
    for (const [k, v] of Object.entries(mine)) {
      for (const [n, c] of Object.entries(v)) {
        if (n === '--top') { assert.equal(c, 'gradient', `${k}: the top bar is not a gradient`); continue; }
        assert.ok(near(rgb(c), rgb(modern[k][n])), `${k} ${n}: fallback ${c}, color-mix() ${modern[k][n]}`);
      }
    }
    // the root carries the tokens as plain colours
    assert.match(await evaluate(`document.documentElement.style.getPropertyValue('--accent-hover')`), /^#[0-9a-f]{6}$/);
  });
  const SIMULATE = `(() => { let n = 0; const redo = (parent) => { for (let i = parent.cssRules.length - 1; i >= 0; i--) { const r = parent.cssRules[i];
      if (r.cssRules && r.cssRules.length && !(r instanceof CSSStyleRule && r.cssRules.length === 0)) redo(r);
      if (r.cssText.includes('color-mix(')) { const text = r.cssText.replace(/color-mix\\(/g, 'color-mixx('); try { parent.deleteRule(i); parent.insertRule(text, i); n++; } catch { /* not replaceable */ } } } };
    for (const sh of document.styleSheets) { try { redo(sh); } catch { /* a sheet we may not read */ } } return n; })()`;
  await check('an old engine, simulated, loses the tokens without the fallback (the control) and keeps them with it', async () => {
    await openWith(false);
    const renamed = await evaluate(SIMULATE);
    assert.ok(renamed > 10, `${renamed} rules renamed: the simulation did not take`);
    const lost = await values(['dark'], [presets[0]]);
    const k = `dark ${presets[0]}`;
    assert.ok(rgb(lost[k]['--accent']).join() !== rgb(modern[k]['--accent']).join() || rgb(lost[k]['--accent-hover']).join() !== rgb(modern[k]['--accent-hover']).join(), `without the fallback the simulated old engine still has the tokens: ${JSON.stringify(lost[k])}`);
    await openWith(true);
    await evaluate(SIMULATE);
    const kept = await values(['light', 'dark'], [presets[0], presets[3]]);
    for (const [key, v] of Object.entries(kept)) {
      for (const [n, c] of Object.entries(v)) {
        if (n === '--top') { assert.equal(c, 'gradient', `${key}: top bar`); continue; }
        const a = rgb(c);
        assert.ok(a.length >= 3 && a[3] !== 0, `${key} ${n}: ${c} is transparent`);
        assert.ok(near(a, rgb(modern[key][n])), `${key} ${n}: ${c} vs ${modern[key][n]}`);
      }
    }
  });
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(failures.map((f) => 'FAIL ' + f).join('\n')); process.exit(1); }
console.log('ok - test-color-fallback (every color-mix() custom property is covered, the tokens equal color-mix() within 1 per channel for 8 accents x 2 themes, a simulated old engine keeps them)');
