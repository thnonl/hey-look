#!/usr/bin/env node
// 1.0.12: every row of a long menu is reachable at any window size: Compose > More actions with Meeting on (the longest case, 14 rows in Russian) in the windows 1280x800,
// 1280x700 and 1024x640, in the 8 languages. The menu scrolls (it takes the room there is and is shaded where more rows wait); End / ArrowDown bring the last row into the menu box and into the window.
// Mac QA round 6: with ru and Meeting on the last row ("Write with AI") lay below the 60 % cap of the menu and a Mac, which draws no scroll bar at rest, showed no sign that the menu scrolls.
//   node scripts/test-menu-reach.mjs [--require-browser | --url=http://127.0.0.1:1420/] [--langs=ru,de]
import { arg, languageJs, sleep, startHarness } from './cdp-harness.mjs';

const ALL = ['en', 'vi', 'fr', 'zh-Hans', 'es', 'ja', 'de', 'ru'];
const LANGS = arg('langs') ? arg('langs').split(',') : ALL;
const SIZES = [[1280, 800], [1280, 700], [1024, 640]];
const H = await startHarness('test-menu-reach', { vitePort0: 5188 });
const { evaluate, cdp } = H;
const failures = [];
let checks = 0;
const ok = (c, m) => { checks++; if (!c) { failures.push(m); console.error('FAIL', m); } };
const until = async (expr, ms = 8000) => { for (let t0 = Date.now(); Date.now() - t0 < ms; await sleep(50)) { let v = false; try { v = await evaluate(`!!(${expr})`); } catch { /* between renders */ } if (v) return true; } return false; };
const mouse = async (p) => { await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p[0], y: p[1] }); await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: p[0], y: p[1], button: 'left', clickCount: 1 }); await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p[0], y: p[1], button: 'left', clickCount: 1 }); };
const key = async (k, vk) => { await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: vk }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: vk }); await sleep(60); };
// where the focused row is, against the menu box and the window
const STATE = `JSON.stringify((() => { const m = document.querySelector('.dd-fixed .menu'); const rows = [...document.querySelectorAll('.dd-fixed [role^=menuitem]:not(:disabled)')]; const f = document.activeElement; const i = rows.indexOf(f); const mr = m.getBoundingClientRect(); const fr = f.getBoundingClientRect(); return { n: rows.length, i, inMenu: fr.top >= mr.top - 0.5 && fr.bottom <= mr.bottom + 0.5, inWin: fr.top >= 0 && fr.bottom <= window.innerHeight, menuBottom: Math.round(mr.bottom), winH: window.innerHeight, tall: document.querySelector('.dd-fixed').hasAttribute('data-tall'), scrolls: m.scrollHeight > m.clientHeight + 1, menuInWin: mr.top >= 0 && mr.bottom <= window.innerHeight }; })())`;
try {
  for (const [w, h] of SIZES) {
    for (const lang of LANGS) {
      const tag = `${lang} ${w}x${h}`;
      await H.openApp('lang=en&light&nativemenu=off', w, h);
      await until(`window.__store.getState().loaded === true`, 20000);
      await sleep(1500);
      await evaluate(languageJs(lang));
      await until(`document.documentElement.lang === ${JSON.stringify(lang)}`, 25000);
      await sleep(1200);
      await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Hello', meeting: { on: true } }); 1`);
      ok(await until(`document.querySelector('.compose-pane .cp-bar .rb.more')`), `${tag}: compose is open`);
      await sleep(800);
      const p = await evaluate(`(() => { const b = document.querySelector('.compose-pane .cp-bar .rb.more'); if (!b) return null; const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
      if (!p) continue;
      await mouse(p);
      ok(await until(`document.querySelector('.dd-fixed .menu-row')`), `${tag}: the menu opened`);
      await sleep(300);
      // End: the last row
      await key('End', 35);
      let s = JSON.parse(await evaluate(STATE));
      ok(s.i === s.n - 1 && s.inMenu && s.inWin, `${tag}: End reaches the last row inside the menu and the window (${JSON.stringify(s)})`);
      ok(s.menuInWin, `${tag}: the menu is inside the window (${JSON.stringify(s)})`);
      if (s.scrolls) ok(s.tall, `${tag}: a menu that scrolls is shaded (data-tall)`);
      // Home, then ArrowDown all the way: every row on the way is reachable, the last included
      await key('Home', 36);
      let last = null;
      for (let k = 0; k < s.n; k++) { s = JSON.parse(await evaluate(STATE)); ok(s.inMenu && s.inWin, `${tag}: row ${s.i} is inside the menu and the window while walking down`); last = s; await key('ArrowDown', 40); }
      ok(last && last.i === last.n - 1, `${tag}: ArrowDown walked to the last row (${last && last.i}/${last && last.n})`);
      await key('Escape', 27);
    }
  }
} catch (e) {
  failures.push(String(e && e.stack ? e.stack : e));
  console.error(e);
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-menu-reach: FAILED (${failures.length})`); process.exit(1); }
console.log(`test-menu-reach: ok (${checks} checks)`);
process.exit(0);
