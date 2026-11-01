#!/usr/bin/env node
// 1.0.12: a hint row of a menu (a disabled row with no action: "No templates yet (Settings → Mailboxes → Templates)" in Compose > More actions) is not cut by an ellipsis in any of the 8
// languages, with Meeting off and on: the text wraps instead (the menu is at most 440 px wide). Linux/Mac QA round 5: the Russian text was 397 px in a 386 px label.
// The dev preview with the mock backend, a compose window of the main page with no templates saved.
//   node scripts/test-menu-hint-fit.mjs [--require-browser | --url=http://127.0.0.1:1420/] [--langs=ru,de]
import { arg, languageJs, sleep, startHarness } from './cdp-harness.mjs';
import { loadDict } from './lib/i18n-dicts.mjs';

const ALL = ['en', 'vi', 'fr', 'zh-Hans', 'es', 'ja', 'de', 'ru'];
const LANGS = arg('langs') ? arg('langs').split(',') : ALL;
const dicts = {};
for (const l of LANGS) dicts[l] = await loadDict(l);
const H = await startHarness('test-menu-hint-fit', { vitePort0: 5186 });
const { evaluate, cdp } = H;
const failures = [];
let checks = 0;
const ok = (c, m) => { checks++; if (!c) { failures.push(m); console.error('FAIL', m); } };
const until = async (expr, ms = 8000) => { for (let t0 = Date.now(); Date.now() - t0 < ms; await sleep(50)) { let v = false; try { v = await evaluate(`!!(${expr})`); } catch { /* between renders */ } if (v) return true; } return false; };
const click = async (sel) => {
  const p = await evaluate(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return null; const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  if (!p) return false;
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p[0], y: p[1] });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: p[0], y: p[1], button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p[0], y: p[1], button: 'left', clickCount: 1 });
  return true;
};
const ROWS = `JSON.stringify([...document.querySelectorAll('.dd-fixed .menu-row')].map((r) => { const l = r.querySelector('.menu-lbl'); return l ? { t: l.textContent.trim().slice(0, 60), sw: l.scrollWidth, cw: l.clientWidth, dis: r.disabled, wrap: getComputedStyle(l).whiteSpace } : null; }).filter(Boolean))`;
await cdp('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__mockNoTemplates = true;' });
try {
  for (const meeting of [false, true]) {
    for (const lang of LANGS) {
      await H.openApp('lang=en&light&nativemenu=off', 1280, 800);
      await until(`window.__store.getState().loaded === true`, 20000);
      await sleep(1500); // (the app reads its saved preferences after it is loaded: the language is set after that)
      await evaluate(languageJs(lang));
      await until(`document.documentElement.lang === ${JSON.stringify(lang)}`, 25000);
      ok(await until(`document.querySelector('html').lang === ${JSON.stringify(lang)}`, 25000), `${lang}: language set`);
      await sleep(1500);
      await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Hello'${meeting ? ", meeting: { on: true }" : ''} }); 1`);
      ok(await until(`document.querySelector('.compose-pane .cp-bar')`), `${lang}: compose is open`);
      await sleep(800);
      // the button with the three dots ("More actions") of the action row
      ok(await click('.compose-pane .cp-bar .rb.more'), `${lang}: the More actions button is in the row`);
      ok(await until(`document.querySelector('.dd-fixed .menu-row')`), `${lang}: the menu opened`);
      await sleep(250);
      const rows = JSON.parse(await evaluate(ROWS));
      const hint = rows.find((r) => r.t === dicts[lang]['compose.bar.noTemplates'].slice(0, 60).trim() || dicts[lang]['compose.bar.noTemplates'].startsWith(r.t));
      ok(!!hint && hint.dis, `${lang}${meeting ? ' meeting' : ''}: the "no templates yet" hint row is in the menu, in this language (${rows.map((r) => r.t).join(' | ').slice(0, 200)})`);
      if (process.env.VERBOSE) console.log(lang, meeting, JSON.stringify(rows.filter((r) => r.dis)));
      for (const r of rows) ok(r.sw <= r.cw, `${lang}${meeting ? ' meeting' : ''}: "${r.t}" is cut (scrollWidth ${r.sw} > clientWidth ${r.cw})`);
      await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    }
  }
} catch (e) {
  failures.push(String(e && e.stack ? e.stack : e));
  console.error(e);
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-menu-hint-fit: FAILED (${failures.length})`); process.exit(1); }
console.log(`test-menu-hint-fit: ok (${checks} checks)`);
process.exit(0);
