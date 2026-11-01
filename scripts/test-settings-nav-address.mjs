#!/usr/bin/env node
// 1.0.12: a long mailbox address in the Settings list on the left ends in an ellipsis with the whole address in its tooltip (title), in all 8 languages; it was clipped without one.
// The dev preview with the mock backend: the first account gets a long address, Settings is opened on the Mailboxes list.
//   node scripts/test-settings-nav-address.mjs [--require-browser | --url=http://127.0.0.1:1420/] [--langs=en,de]
import { arg, languageJs, sleep, startHarness } from './cdp-harness.mjs';

const ALL = ['en', 'vi', 'fr', 'zh-Hans', 'es', 'ja', 'de', 'ru'];
const LANGS = arg('langs') ? arg('langs').split(',') : ALL;
const LONG = 'a.very.long.mailbox.address.for.the.settings.list@subdomain.example-company-name.international';
const H = await startHarness('test-settings-nav-address', { vitePort0: 5182 });
const { evaluate } = H;
const failures = [];
let checks = 0;
const ok = (c, m) => { checks++; if (!c) { failures.push(m); console.error('FAIL', m); } };
const until = async (expr, ms = 10000) => { for (let t0 = Date.now(); Date.now() - t0 < ms; await sleep(50)) { let v = false; try { v = await evaluate(`!!(${expr})`); } catch { /* between renders */ } if (v) return true; } return false; };
const PROBE = `JSON.stringify([...document.querySelectorAll('.settings-nav .nav-acct > button')].map((b) => { const s = [...b.querySelectorAll('span')].find((x) => x.textContent.includes('@')); const c = s && getComputedStyle(s); return s ? { text: s.textContent, title: s.getAttribute('title'), sw: s.scrollWidth, cw: s.clientWidth, ell: c.textOverflow, ov: c.overflow, btnOver: b.scrollWidth > b.clientWidth + 1 } : null; }).filter(Boolean))`;
try {
  await H.openApp('lang=en&light&nativemenu=off', 1280, 800);
  await until(`window.__store.getState().loaded === true`, 20000);
  for (const lang of LANGS) {
    await evaluate(languageJs(lang));
    await until(`document.documentElement.lang === ${JSON.stringify(lang)}`, 25000);
    await evaluate(`(() => { const s = window.__store.getState(); window.__store.setState({ accounts: s.accounts.map((a, i) => (i === 0 ? { ...a, email: ${JSON.stringify(LONG)} } : a)) }); s.setDialog({ type: 'settings', tab: 'general', nonce: Date.now() }); return 1; })()`);
    ok(await until(`document.querySelector('.settings-nav .nav-acct')`), `${lang}: the Settings list shows the mailboxes`);
    await sleep(300);
    const rows = JSON.parse(await evaluate(PROBE));
    const long = rows.find((r) => r.text === LONG);
    ok(!!long, `${lang}: the long address is listed (${rows.map((r) => r.text).join(' | ')})`);
    if (long) {
      ok(long.sw > long.cw && long.ell === 'ellipsis' && long.ov === 'hidden', `${lang}: the long address ends in an ellipsis (scrollWidth ${long.sw}, clientWidth ${long.cw}, text-overflow ${long.ell}, overflow ${long.ov})`);
      ok(long.title === LONG, `${lang}: the tooltip has the whole address (${long.title})`);
      ok(!long.btnOver, `${lang}: the entry does not overflow its button`);
    }
    await evaluate(`window.__store.getState().setDialog(null); 1`);
    await sleep(150);
  }
} catch (e) {
  failures.push(String(e && e.stack ? e.stack : e));
  console.error(e);
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-settings-nav-address: FAILED (${failures.length})`); process.exit(1); }
console.log(`test-settings-nav-address: ok (${checks} checks)`);
process.exit(0);
