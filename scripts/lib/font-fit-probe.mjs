#!/usr/bin/env node
// 1.0.12 font change (Source Sans 3 replaced Inter): where does text not fit? Opens the dev preview in a headless Chrome for each language and size,
// shows the main views (mail list + reading pane, Compose, Calendar, the tabs of Settings, the rule dialog) and prints JSON: per scene the elements whose text is
// cut (an ellipsis that fires, a box with overflow hidden / clip whose content is wider, or a wrapping one whose text is taller) and the elements that overflow the window.
// "cut" is not a bug by itself (a long subject is meant to end in an ellipsis): run it on two branches and compare the counts and the lists.
//   node scripts/lib/font-fit-probe.mjs [--lang=en,de,es,fr,ru,vi,zh-Hans,ja] [--size=960x560,1280x800] [--url=http://127.0.0.1:1420/]
import { arg, sleep, startHarness } from '../cdp-harness.mjs';

const LANGS = (arg('lang') || 'en,de,es,fr,ru,vi').split(',');
const SIZES = (arg('size') || '960x560,1280x800').split(',').map((s) => s.split('x').map(Number));
const TABS = ['general', 'appearance', 'tray', 'add-account', 'ai', 'shortcuts', 'about'];

/** Page side: the cut elements of what is on screen. */
const GEO = process.argv.includes('--geo');
const SCAN = `(() => {
  const GEO = ${GEO};
  const out = [], seen = new Set();
  const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const name = (e) => e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');
  for (const e of document.body.querySelectorAll('*')) {
    if (!vis(e) || e.closest('iframe, svg, [aria-hidden=true], .sr-only')) continue;
    const own = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    const cs = getComputedStyle(e);
    const clipX = cs.overflowX !== 'visible', clipY = cs.overflowY !== 'visible';
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
    if (own && clipX && e.scrollWidth > e.clientWidth + 1 && cs.overflowX !== 'auto' && cs.overflowX !== 'scroll') out.push({ k: cs.textOverflow === 'ellipsis' ? 'ellipsis' : 'cut-x', el: name(e), t: e.textContent.trim().slice(0, 40), sw: e.scrollWidth, cw: e.clientWidth });
    // (a one-line box (nowrap) always reports a scrollHeight above its height with Source Sans 3: the content area of the font is taller than the 17 px line; for those the INK matters, scripts/lib/font-ink-probe.mjs)
    else if (own && clipY && cs.whiteSpace !== 'nowrap' && e.scrollHeight > e.clientHeight + 3 && cs.overflowY !== 'auto' && cs.overflowY !== 'scroll') out.push({ k: 'cut-y', el: name(e), t: e.textContent.trim().slice(0, 40), sh: e.scrollHeight, ch: e.clientHeight });
    const r = e.getBoundingClientRect();
    if (own && r.right > innerWidth + 1 && !e.closest('.modal-body, .ml-body, [style*=transform]')) out.push({ k: 'off-window', el: name(e), t: e.textContent.trim().slice(0, 30), right: Math.round(r.right) });
  }
  const geo = {};
  if (GEO) for (const e of document.body.querySelectorAll('*')) {
    if (!vis(e) || e.closest('iframe, svg, [aria-hidden=true], .sr-only') || !e.className || typeof e.className !== 'string') continue;
    if (![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const r = e.getBoundingClientRect(), k = name(e); (geo[k] = geo[k] || []).push([Math.round(r.height * 10) / 10, Math.round(r.width * 10) / 10]);
  }
  const rows = out.filter((o) => { const key = o.k + o.el + o.t; if (seen.has(key)) return false; seen.add(key); return true; });
  return { geo, docOverflowX: document.documentElement.scrollWidth - innerWidth, n: rows.length, ellipsis: rows.filter((o) => o.k === 'ellipsis').length, cut: rows.filter((o) => o.k !== 'ellipsis').length, rows: rows.filter((o) => o.k !== 'ellipsis').slice(0, 25) };
})()`;

const H = await startHarness('font-fit-probe', { vitePort0: 5600 });
const { evaluate } = H;
const J = JSON.stringify;
const report = {};
try {
  for (const lang of LANGS) for (const [w, h] of SIZES) {
    const key = `${lang} ${w}x${h}`;
    const scenes = {};
    const scan = async (name) => { await sleep(350); scenes[name] = JSON.parse(J(await evaluate(SCAN))); };
    await H.openApp(`lang=${lang}`, w, h);
    await evaluate(`window.__mockAddThread('fp1', 'Quarterly report: the numbers for the whole team', {}); window.__store.getState().refresh().then(() => 1)`);
    await sleep(600);
    await scan('list');
    await evaluate(`document.querySelector('.ml-row')?.click(); 1`);
    await sleep(900);
    await scan('reading');
    await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: [], subject: 'Font check', bodyHtml: '<p>x</p>' }); 1`);
    await sleep(1200);
    await scan('compose');
    await evaluate(`window.__store.getState().closeCompose?.(); 1`);
    await H.openApp(`lang=${lang}`, w, h);
    await evaluate(`window.__store.getState().setModule('calendar'); 1`);
    await sleep(1200);
    await scan('calendar');
    for (const tab of TABS) {
      await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: ${J(tab)} }); 1`);
      await sleep(900);
      await scan('settings-' + tab);
    }
    await evaluate(`window.__store.getState().setDialog({ type: 'rule', source: { accountId: 'a1', folder: 'inbox', fromName: 'Deals', fromEmail: 'deals@shop.example', subject: 'Hi', text: 'hello', mine: false } }); 1`);
    await sleep(900);
    await scan('rule-dialog');
    report[key] = { totals: Object.fromEntries(Object.entries(scenes).map(([k, v]) => [k, { cut: v.cut, ellipsis: v.ellipsis, docOverflowX: v.docOverflowX }])), scenes };
  }
} finally {
  await H.shutdown();
}
console.log(J(report));
process.exit(0);
