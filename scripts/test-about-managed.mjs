#!/usr/bin/env node
// Settings > About on a copy that is updated by apt (WP15, AC-15.17) or by the Snap Store: the version, who updates it, the privacy sentence, and neither
// the "Check for updates" button nor the automatic-check switch. The dev preview pretends the copy is managed with `#managed=apt` / `#managed=snap`
// (src/devMock.ts; the real app: HEYLOOK_TEST_MANAGED in a debug build). In all 8 languages, at 960 x 560 and 1280 x 800, light and dark:
//   - the sentence is the dictionary text (updates.managed.apt) with the command in a <code> element, "sudo apt update && sudo apt upgrade", and no
//     raw key, no "{command}" and no "&amp;" is on the page; the last sentence is the same as in updates.managed.snap (checked by the specialists)
//   - the page has no "Check for updates" button and no switch in the Updates block; a copy that is not managed still has both (nothing else changed)
//   - nothing is clipped: the sentence and the <code> lie inside the settings body, which has no horizontal scrollbar, and the <code> is not wider than
//     its paragraph; the line height of the sentence is one normal line (the <code> does not stretch it by more than 2 px)
//   node --experimental-strip-types scripts/test-about-managed.mjs [--require-browser] [--quick] [--url=http://127.0.0.1:1420/]
//   --quick  English, German and Japanese at 960 x 560 light and dark (what CI runs)
import { arg, flag, sleep, startHarness } from './cdp-harness.mjs';
import { loadDicts } from './lib/i18n-dicts.mjs';

const dicts = await loadDicts();
const LANGS = flag('quick') ? ['en', 'de', 'ja'] : ['en', 'vi', 'fr', 'zh-Hans', 'es', 'ja', 'de', 'ru'];
const SIZES = flag('quick') ? [[960, 560]] : [[960, 560], [1280, 800]];
const THEMES = ['light', 'dark'];
const COMMAND = 'sudo apt update && sudo apt upgrade';

const H = await startHarness('test-about-managed', { vitePort0: 5900 });
const { evaluate } = H;
const failures = [];
let checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failures.push(msg); console.error(`FAIL ${msg}`); } };

/** The About page as the test reads it. */
const READ = `(() => {
  const body = document.querySelector('.settings-body');
  const btn = [...document.querySelectorAll('.settings .update-status .btn, .settings .update-status button')];
  const sw = document.querySelectorAll('.settings [role="switch"], .settings input[type="checkbox"]').length;
  const ps = [...document.querySelectorAll('.settings p.muted.small')];
  const R = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
  const managed = ps.find((p) => p.querySelector('code') && /apt/.test(p.querySelector('code').textContent));
  const code = managed && managed.querySelector('code');
  // the height of one line of the sentence: a one-character range of its first text node
  let lh = 0;
  if (managed) { const tn = [...managed.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim()); if (tn) { const rg = document.createRange(); rg.setStart(tn, 0); rg.setEnd(tn, 1); lh = rg.getBoundingClientRect().height; } }
  return {
    text: document.querySelector('.settings')?.innerText ?? '',
    buttons: btn.length, switches: sw,
    para: managed ? managed.textContent : null, code: code ? code.textContent : null,
    paraBox: managed ? R(managed) : null, codeBox: code ? R(code) : null, body: body ? R(body) : null,
    bodyScrollsX: body ? body.scrollWidth > body.clientWidth + 1 : null, lineHeight: lh,
    paraFont: managed ? getComputedStyle(managed).fontFamily : null, codeFont: code ? getComputedStyle(code).fontFamily : null,
  };
})()`;

try {
  for (const lang of LANGS) {
    const d = dicts[lang];
    const snapText = d['updates.managed.snap'];
    const aptText = d['updates.managed.apt'];
    ok(typeof aptText === 'string' && aptText.includes('{command}'), `${lang}: the dictionary has updates.managed.apt with {command}`);
    // the last sentence is the one of the snap text (the specialists checked it), in every language
    const lastSentence = (s) => s.replace(/\{command\}/, '').split(/(?<=[.。])\s*/).filter(Boolean).at(-1);
    ok(lastSentence(aptText) === lastSentence(snapText), `${lang}: the last sentence of the apt text is the one of the snap text`);
    const [before, after] = aptText.split('{command}');
    for (const [w, h] of SIZES) for (const theme of THEMES) {
      const tag = `${lang} ${w}x${h} ${theme}`;
      await H.openApp(`settings=about&managed=apt&lang=${lang}&os=linux`, w, h);
      await evaluate(`window.__store.getState().setPrefs({ theme: ${JSON.stringify(theme)}, language: ${JSON.stringify(lang)} }); 1`);
      let g = null;
      for (let i = 0; i < 60 && !(g && g.para); i++) { await sleep(100); g = await evaluate(READ); }
      ok(g && g.para, `${tag}: the apt sentence is on the About page`);
      if (!g || !g.para) continue;
      ok(g.para === before + COMMAND + after, `${tag}: the sentence is the dictionary text with the command (got: ${g.para})`);
      ok(g.code === COMMAND, `${tag}: the command is in a <code> element (got ${JSON.stringify(g.code)})`);
      ok(!/\{command\}|updates\.managed|&amp;/.test(g.text), `${tag}: no raw key, placeholder or entity on the page`);
      ok(g.buttons === 0, `${tag}: no button in the Updates block (${g.buttons})`);
      ok(g.switches === 0, `${tag}: no automatic-check switch (${g.switches})`);
      ok(g.text.includes(d['settings.about.privacyManaged']), `${tag}: the privacy sentence of a managed copy is there`);
      ok(!g.bodyScrollsX, `${tag}: the settings body has no horizontal scroll`);
      const inside = (b) => b.l >= g.body.l - 0.5 && b.r <= g.body.r + 0.5;
      ok(inside(g.paraBox) && inside(g.codeBox), `${tag}: the sentence and the command are inside the settings body`);
      ok(g.codeBox.w <= g.paraBox.w + 0.5, `${tag}: the command is not wider than its paragraph (${g.codeBox.w} / ${g.paraBox.w})`);
      // the command is one line, or two when the paragraph is narrow and the line breaks at a space; never taller (the box has 1 px of padding)
      ok(g.lineHeight > 8 && g.codeBox.h <= 2 * g.lineHeight + 6, `${tag}: the <code> box (${g.codeBox.h} px) is at most two lines (a line is ${g.lineHeight} px)`);
      if (arg('probe')) console.log(JSON.stringify({ tag, para: g.paraFont, code: g.codeFont, paraBox: g.paraBox, codeBox: g.codeBox }));
    }
  }
  // the snap and an app that updates itself, once each (nothing else changed)
  await H.openApp('settings=about&managed=snap&lang=en&os=linux', 960, 560);
  let g = await evaluate(READ);
  for (let i = 0; i < 40 && !g.text.includes('Snap Store'); i++) { await sleep(100); g = await evaluate(READ); }
  ok(g.text.includes(dicts.en['updates.managed.snap']) && g.buttons === 0 && g.switches === 0, 'snap: the Snap Store sentence, no button, no switch');
  ok(!g.text.includes('apt update'), 'snap: the apt sentence is not shown');
  await H.openApp('settings=about&lang=en&os=linux', 960, 560);
  g = await evaluate(READ);
  for (let i = 0; i < 40 && !g.buttons; i++) { await sleep(100); g = await evaluate(READ); }
  ok(g.buttons >= 1 && g.switches >= 1, `not managed: the Check for updates button (${g.buttons}) and the automatic-check switch (${g.switches}) are there`);
  ok(!g.text.includes('apt update'), 'not managed: no apt sentence');
} catch (e) {
  ok(false, `threw: ${e.message}`);
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-about-managed: ${failures.length} failure(s) in ${checks} checks`); process.exit(1); }
console.log(`test-about-managed: ${checks} checks passed`);
