#!/usr/bin/env node
// The Microsoft Store version in the app (WP14 part 2, WA.3 / W14.5; AC-WA.3.1, AC-WA.3.2, AC-14.5.1..3): Settings > About of a package, the two hints of the autostart switch and the two
// new links, in the real page of the dev preview. The preview pretends with `#managed=msstore` and `#autostartlock=user|policy` (src/devMock.ts; the real app: HEYLOOK_SIMULATE_PACKAGED=1 and
// HEYLOOK_SIMULATE_AUTOSTART_LOCK in a debug build). In all 8 languages, at 960 x 560 and 1280 x 800, light and dark:
//   About, managed by the Store:  the dictionary text "Updates come from the Microsoft Store." and the Store form of the privacy text (not the GitHub form, not the apt/snap form), no "Check for
//                                 updates" button, no automatic-check switch, no raw key or entity; the four links (Website, Buy me a coffee, Source code, Privacy policy) lie inside the settings body
//   Notifications & tray:         autostart locked "user": the switch is disabled and the hint is settings.tray.autostartOffInWindows; locked "policy": settings.tray.autostartByPolicy;
//                                 not locked: the switch is enabled and the hint is the usual one (nothing else changed)
//   AI Assistant:                 the "Report a problem with AI content" link is there, fully inside the settings body
//   not managed:                  About still has the Check for updates button, the switch and the GitHub form of the privacy text (nothing else changed)
//   nothing is clipped: no horizontal scroll of the settings body, every text box is inside it
//   node --experimental-strip-types scripts/test-about-store.mjs [--require-browser] [--quick] [--url=http://127.0.0.1:1420/]
//   --quick  English, German and Japanese at 960 x 560 light and dark (what CI runs)
import { arg, flag, sleep, startHarness } from './cdp-harness.mjs';
import { loadDicts } from './lib/i18n-dicts.mjs';

const dicts = await loadDicts();
const LANGS = flag('quick') ? ['en', 'de', 'ja'] : ['en', 'vi', 'fr', 'zh-Hans', 'es', 'ja', 'de', 'ru'];
const SIZES = flag('quick') ? [[960, 560]] : [[960, 560], [1280, 800]];
const THEMES = ['light', 'dark'];

const H = await startHarness('test-about-store', { vitePort0: 5940 });
const { evaluate } = H;
const failures = [];
let checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failures.push(msg); console.error(`FAIL ${msg}`); } };

/** What the open Settings tab shows: the text, the buttons and switches of the Updates block, the links, the autostart row, boxes against the body. */
const READ = `(() => {
  const body = document.querySelector('.settings-body');
  const R = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
  const upd = document.querySelector('.settings .update-status');
  const updBtn = upd ? upd.querySelectorAll('button, .btn').length : null;
  const switches = [...document.querySelectorAll('.settings input[type="checkbox"]')];
  const links = [...document.querySelectorAll('.settings .about-link')].map((b) => ({ text: b.textContent.trim(), box: R(b) }));
  const rows = [...document.querySelectorAll('.settings .set-row')].map((r) => ({ label: r.querySelector('.set-lbl > div')?.textContent.trim() ?? '', hint: r.querySelector('.set-lbl .muted')?.textContent.trim() ?? null, sw: r.querySelector('input[type="checkbox"]') ? { disabled: r.querySelector('input[type="checkbox"]').disabled, checked: r.querySelector('input[type="checkbox"]').checked } : null, hintBox: r.querySelector('.set-lbl .muted') ? R(r.querySelector('.set-lbl .muted')) : null }));
  const report = [...document.querySelectorAll('.settings button.link')].map((b) => ({ text: b.textContent.trim(), box: R(b) }));
  const paras = [...document.querySelectorAll('.settings p.muted.small')].map((p) => ({ text: p.textContent.trim(), box: R(p) }));
  return { text: document.querySelector('.settings')?.innerText ?? '', updBtn, switches: switches.length, links, rows, report, paras, body: body ? R(body) : null, bodyScrollsX: body ? body.scrollWidth > body.clientWidth + 1 : null };
})()`;

const open = async (hash, theme, lang, w, h) => {
  await H.openApp(hash, w, h);
  await evaluate(`window.__store.getState().setPrefs({ theme: ${JSON.stringify(theme)}, language: ${JSON.stringify(lang)} }); 1`);
  let g = null;
  for (let i = 0; i < 60 && !(g && g.body && g.text.length > 30); i++) { await sleep(100); g = await evaluate(READ); }
  await sleep(150);
  return evaluate(READ);
};
const inside = (g, b) => b.l >= g.body.l - 0.5 && b.r <= g.body.r + 0.5;

try {
  for (const lang of LANGS) {
    const d = dicts[lang];
    for (const k of ['settings.about.updatesStore', 'settings.about.privacyStore', 'settings.about.privacyPolicy', 'settings.tray.autostartOffInWindows', 'settings.tray.autostartByPolicy', 'settings.ai.report']) ok(typeof d[k] === 'string' && d[k].length > 3, `${lang}: the dictionary has ${k}`);
    for (const [w, h] of SIZES) for (const theme of THEMES) {
      const tag = `${lang} ${w}x${h} ${theme}`;
      // ---- About, managed by the Store
      let g = await open(`settings=about&managed=msstore&lang=${lang}&os=windows`, theme, lang, w, h);
      ok(g.text.includes(d['settings.about.updatesStore']), `${tag}: About says the Store updates it`);
      ok(g.text.includes(d['settings.about.privacyStore']), `${tag}: About has the Store form of the privacy text`);
      ok(!g.text.includes(d['settings.about.privacy']), `${tag}: not the GitHub form of the privacy text`);
      ok(!/GitHub/.test(g.paras.map((p) => p.text).join(' ')), `${tag}: the Store form does not mention GitHub update checks`);
      ok(g.updBtn === 0, `${tag}: no button in the Updates block (${g.updBtn})`);
      ok(g.switches === 0, `${tag}: no automatic-check switch (${g.switches})`);
      ok(!/(?:settings|updates)\.[A-Za-z]+\.[A-Za-z]|\{|&amp;/.test(g.text), `${tag}: no raw key, placeholder or entity on the page (${(g.text.match(/.{0,40}((?:settings|updates)\.[A-Za-z]+\.[A-Za-z]|\{|&amp;).{0,40}/) || [''])[0]})`);
      ok(!g.bodyScrollsX, `${tag}: the settings body has no horizontal scroll`);
      ok(g.links.length === 4 && g.links[3].text === d['settings.about.privacyPolicy'], `${tag}: four links, the last one is "${d['settings.about.privacyPolicy']}" (${JSON.stringify(g.links.map((l) => l.text))})`);
      ok(g.links.every((l) => inside(g, l.box) && l.box.h < 60), `${tag}: the four links are inside the settings body, one or two lines`);
      ok(g.paras.every((p) => inside(g, p.box)), `${tag}: the paragraphs are inside the settings body`);
      // ---- Notifications & tray: the autostart row in its three states
      for (const [lock, hintKey, disabled] of [['user', 'settings.tray.autostartOffInWindows', true], ['policy', 'settings.tray.autostartByPolicy', true], ['none', 'settings.tray.startsMinimized', false]]) {
        const t = await open(`settings=tray&autostartlock=${lock}&managed=msstore&lang=${lang}&os=windows`, theme, lang, w, h);
        const row = t.rows.find((r) => r.label === d['settings.tray.autostartWindows']);
        ok(!!row, `${tag} ${lock}: the autostart row is there ("${d['settings.tray.autostartWindows']}")`);
        if (!row) continue;
        ok(row.hint === d[hintKey], `${tag} ${lock}: the hint is ${hintKey} (got ${JSON.stringify(row.hint)})`);
        ok(row.sw && row.sw.disabled === disabled, `${tag} ${lock}: the switch is ${disabled ? 'disabled' : 'enabled'}`);
        ok(row.hintBox && inside(t, row.hintBox) && !t.bodyScrollsX, `${tag} ${lock}: the hint is inside the settings body, no horizontal scroll`);
        ok(!/(?:settings|updates)\.[A-Za-z]+\.[A-Za-z]|\{/.test(t.text), `${tag} ${lock}: no raw key on the page`);
      }
      // ---- AI Assistant: the report link
      const a = await open(`settings=ai&lang=${lang}&os=windows`, theme, lang, w, h);
      const rep = a.report.find((b) => b.text === d['settings.ai.report']);
      ok(!!rep, `${tag}: the AI tab has the link "${d['settings.ai.report']}"`);
      ok(rep && inside(a, rep.box) && rep.box.h < 60, `${tag}: the link is inside the settings body, at most two lines (${rep && rep.box.h} px)`);
      ok(!a.bodyScrollsX, `${tag}: the AI tab has no horizontal scroll`);
    }
  }
  // ---- a copy that updates itself: nothing changed
  const n = await open('settings=about&lang=en&os=windows', 'light', 'en', 960, 560);
  ok(n.updBtn >= 1 && n.switches >= 1, `not managed: the Check for updates button (${n.updBtn}) and the switch (${n.switches}) are there`);
  ok(n.text.includes(dicts.en['settings.about.privacy']) && !n.text.includes(dicts.en['settings.about.updatesStore']), 'not managed: the GitHub form of the privacy text, no Store sentence');
  ok(n.links.length === 4, 'not managed: the four links too (the privacy policy link is for every copy)');
  if (arg('probe')) console.log(JSON.stringify(n.links));
} catch (e) {
  ok(false, `threw: ${e.message}`);
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-about-store: ${failures.length} failure(s) in ${checks} checks`); process.exit(1); }
console.log(`test-about-store: ${checks} checks passed`);
