#!/usr/bin/env node
// 1.0.12 (owner): in Compact density the icon strip of a hovered / focused row sits at the right end of the SUBJECT line (where a preview would be), not in the sender line: the date stays, the subject
// keeps its place and gives way to the strip with its ellipsis, nothing overlaps the subject, and the row never changes its box. Long and short subjects, a long sender, ru / vi / de, light and dark.
//   node scripts/test-compact-hover.mjs [--require-browser | --url=http://127.0.0.1:1420/] [--langs=ru,vi,de]
import { arg, languageJs, sleep, startHarness } from './cdp-harness.mjs';

const LANGS = arg('langs') ? arg('langs').split(',') : ['ru', 'vi', 'de'];
const H = await startHarness('test-compact-hover', { vitePort0: 5195 });
const { evaluate, cdp } = H;
const failures = [];
let checks = 0;
const ok = (c, m) => { checks++; if (!c) { failures.push(m); console.error('FAIL', m); } };
const until = async (expr, ms = 8000) => { for (let t0 = Date.now(); Date.now() - t0 < ms; await sleep(50)) { let v = false; try { v = await evaluate(`!!(${expr})`); } catch { /* between renders */ } if (v) return true; } return false; };
const LONG = 'A very long subject line that goes on and on past the end of the row so that it must be cut by its ellipsis even in a wide window of the application, with more words after it';
const THREADS = [
  ['cL', LONG, { fromName: 'A sender with a really very long display name that does not fit its column at all', fromEmail: 'long@sender.example', html: '<p>x</p>', auth: 'pass' }],
  ['cS', 'Hi', { fromName: 'Bo', fromEmail: 'bo@sender.example', html: '<p>x</p>', auth: 'pass' }],
  ['cM', 'Quarterly numbers for the team', { fromName: 'Marketing Department', fromEmail: 'mkt@sender.example', html: '<p>x</p>', auth: 'pass' }],
];
const BOX = (id) => `(() => { const r = document.querySelector('.ml-row[data-thread="${id}"]'); if (!r) return null; const b = (e) => { if (!e) return null; const q = e.getBoundingClientRect(); return [q.left, q.top, q.right, q.bottom].map((n) => Math.round(n * 10) / 10); };
  const act = r.querySelector('.hover-actions'); const vis = (e) => !!e && getComputedStyle(e).display !== 'none';
  return JSON.stringify({ row: b(r), subject: b(r.querySelector('.subject')), subjectCut: r.querySelector('.subject').scrollWidth > r.querySelector('.subject').clientWidth, date: b(r.querySelector('.date')), dateShown: vis(r.querySelector('.date')), strip: vis(act) ? b(act) : null, top: b(r.querySelector('.ml-top')), who: b(r.querySelector('.who')) }); })()`;
const hit = (a, b) => a && b && a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const mouse = (x, y) => cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
try {
  await H.openApp('lang=en&nativemenu=off', 1280, 800);
  await until(`window.__store.getState().loaded === true`, 20000);
  await sleep(1500);
  await evaluate(THREADS.map(([id, s, o]) => `window.__mockAddThread(${JSON.stringify(id)}, ${JSON.stringify(s)}, ${JSON.stringify(o)});`).join(' ') + ' window.__store.getState().refresh().then(() => 1)');
  await sleep(600);
  for (const lang of LANGS) {
    await evaluate(languageJs(lang));
    await until(`document.documentElement.lang === ${JSON.stringify(lang)}`, 25000);
    await sleep(500);
    for (const theme of ['light', 'dark']) {
      await evaluate(`window.__store.getState().setPrefs({ theme: ${JSON.stringify(theme)}, density: 'compact' }); 1`);
      await sleep(500);
      for (const [id] of THREADS) {
        const tag = `${lang} ${theme} ${id}`;
        await mouse(5, 5); await evaluate(`document.activeElement && document.activeElement.blur(); document.querySelector('.ml-row[data-thread="${id}"]')?.scrollIntoView({ block: 'center' }); 1`); await sleep(250);
        const rest = JSON.parse(await evaluate(BOX(id)));
        ok(!!rest, `${tag}: the row is in the list`);
        if (!rest) continue;
        ok(rest.strip === null, `${tag}: no strip at rest`);
        // hover
        const at = [rest.row[0] + (rest.row[2] - rest.row[0]) * 0.5, (rest.row[1] + rest.row[3]) / 2];
        await mouse(at[0], at[1]); await sleep(250);
        const hov = JSON.parse(await evaluate(BOX(id)));
        ok(hov.strip !== null, `${tag}: the strip shows on hover`);
        ok(JSON.stringify(hov.row) === JSON.stringify(rest.row), `${tag}: the row box is the same hovered (${JSON.stringify(rest.row)} / ${JSON.stringify(hov.row)})`);
        ok(hov.strip && !hit(hov.strip, hov.subject), `${tag}: the strip does not touch the subject (${JSON.stringify(hov.strip)} / ${JSON.stringify(hov.subject)})`);
        ok(hov.strip && hov.strip[1] >= hov.row[1] - 1 && hov.strip[3] <= hov.row[3] + 1 && hov.strip[2] <= hov.row[2] + 1, `${tag}: the strip is inside the row`);
        ok(hov.strip && hov.top && !hit(hov.strip, hov.top), `${tag}: the strip is not in the sender line (${JSON.stringify(hov.strip)} / ${JSON.stringify(hov.top)})`);
        ok(hov.dateShown && JSON.stringify(hov.date) === JSON.stringify(rest.date), `${tag}: the date stays where it was`);
        ok(JSON.stringify(hov.who) === JSON.stringify(rest.who) && hov.subject[0] === rest.subject[0], `${tag}: the sender and the start of the subject keep their place`);
        // keyboard focus: the row itself, then the mouse away
        await mouse(5, 5); await sleep(200);
        await evaluate(`document.querySelector('.ml-row[data-thread="${id}"]').focus(); 1`); await sleep(250);
        const foc = JSON.parse(await evaluate(BOX(id)));
        ok(foc.strip !== null, `${tag}: the strip shows on keyboard focus`);
        ok(JSON.stringify(foc.row) === JSON.stringify(rest.row) && foc.strip && !hit(foc.strip, foc.subject) && foc.dateShown, `${tag}: focus: same row box, strip clear of the subject, date shown`);
      }
    }
  }
} catch (e) {
  failures.push(String(e && e.stack ? e.stack : e));
  console.error(e);
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-compact-hover: FAILED (${failures.length})`); process.exit(1); }
console.log(`test-compact-hover: ok (${checks} checks)`);
process.exit(0);
