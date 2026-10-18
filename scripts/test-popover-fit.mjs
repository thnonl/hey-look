#!/usr/bin/env node
// Every popover and menu of the compose pane stays inside the window, with ALL of its boxes (v1.0.6 QA round 3, BUG-R3-1: at a 960 x 560 window (viewport
// 946 x 552) the "Send later" popover measured y 189 - 593: its outer box was kept in the window and scrolled, but the dialog box inside it (the one that
// holds the presets, the date and time and the footer) ran 41 px past the bottom, with and without a picture, and its footer was cut).
//
// Real compose pane in the dev preview (src/devMock.ts), real clicks, a DOM measurement of every box. For each control of the compose bar and of the
// formatting row that opens something (every `[aria-haspopup]`), and for the rows of "More" that open a panel (Symbol, Emoji, ...), plus the Send later date
// and time pickers, the suggestions of To, the link popover and the alt text popover of a picture: the popover is opened and every box that appeared
// (`.popover`, `.dd-fixed`, `.menu`, `.fmt-pop`, `.suggest`, `[role=dialog]`, `[role=menu]`, `[role=listbox]`, `.sched-picker`, the grids) is measured:
//   - the box lies inside the window (top >= 0, bottom <= the height of the window, left >= 0, right <= its width);
//   - the outermost box is what is under its own pixels (nothing else covers it: the picture toolbar, the handles, a toast, the pane's bar);
//   - every control inside it can be reached: scrolled into its scroll box it lies whole inside the box and the window; the page itself never scrolled;
//   - a toast on show does not sit on it, a selected picture's toolbar and handles step aside.
// At 946 x 552 and 946 x 480 (a 960 x 560 window and a lower one) in the main window; the full run adds more sizes, dark theme, German (longer labels) and
// the compose window of its own.
//
//   node scripts/test-popover-fit.mjs --quick         the two sizes, English, light (what CI runs)
//   node scripts/test-popover-fit.mjs                 the full matrix
//   node scripts/test-popover-fit.mjs --shots=<dir>   a picture of each popover
//   node scripts/test-popover-fit.mjs --font="DejaVu Sans" | --css="..."   every font of the page replaced by this one / an extra style sheet for the run: the Linux
//                                                    runner has wider, taller fonts than the dev machine, and a popover that fits here must fit there (CI uses the runner's own;
//                                                    e.g. --css=".fld-grid button { height: 34px } .fld-times li { padding: 9px 12px }" for taller date and time panels)
//   node scripts/test-popover-fit.mjs --require-browser | --url=http://127.0.0.1:1420/
import fs from 'node:fs';
import path from 'node:path';
import { arg, flag, sleep, startHarness } from './cdp-harness.mjs';

const QUICK = flag('quick');
const SHOTS = arg('shots');
const FONT = arg('font');
const EXTRA_CSS = arg('css');
const H = await startHarness('test-popover-fit', { vitePort0: 5620, cdpPort0: 9620 });
const { evaluate, cdp } = H;
const failures = [];
let checks = 0;
const ok = (tag, cond, msg) => { checks++; if (!cond) { failures.push(`[${tag}] ${msg}`); console.error(`FAIL [${tag}] ${msg}`); } };
const press = async (key, code) => {
  const vk = { Tab: 9, Escape: 27 }[key];
  const p = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...p });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
};
const shot = async (tag, name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, `${tag}-${name}`.replace(/[^\w.-]+/g, '_') + '.png'), Buffer.from(r.data, 'base64')); };

// ---------- the combinations ----------
const CONFIGS = [];
const add = (c) => CONFIGS.push({ theme: 'light', lang: 'en', mode: 'main', ...c });
for (const [w, h] of [[946, 552], [946, 480]]) add({ w, h });
for (const [w, h] of [[946, 552], [946, 480]]) add({ w, h, mode: 'popout' }); // (the compose window: the whole width is the pane, so the roomy bar with Sign, Templates and Importance)
if (!QUICK) {
  for (const [w, h] of [[946, 552], [946, 480]]) { add({ w, h, theme: 'dark', lang: 'de' }); add({ w, h, mode: 'popout', theme: 'dark', lang: 'de' }); }
  for (const [w, h] of [[1266, 712], [1266, 400], [560, 440], [760, 480]]) add({ w, h, theme: 'dark', mode: w < 700 ? 'popout' : 'main' });
}

// ---------- the page side ----------
// what counts as a box of a popover; `fresh` = the ones that were not there before the click
const SEL = '.popover, .dd-fixed, .menu, .fmt-pop, .suggest, [role=dialog]:not(.modal), [role=menu], [role=listbox], .sched-picker, .fld-grid, .mini-month, .fld-times, .emoji-grid, .tbl-grid, .fmt-grid';
const PAGE = `(() => {
  window.__seen = new Set(document.querySelectorAll(${JSON.stringify(SEL)}));
  const shown = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  window.__boxes = () => [...document.querySelectorAll(${JSON.stringify(SEL)})].filter((e) => !window.__seen.has(e) && shown(e));
  window.__fit = () => {
    const vw = innerWidth, vh = innerHeight, boxes = window.__boxes();
    const R = (e) => { const r = e.getBoundingClientRect(); return { t: Math.round(r.top * 10) / 10, b: Math.round(r.bottom * 10) / 10, l: Math.round(r.left * 10) / 10, r: Math.round(r.right * 10) / 10 }; };
    const name = (e) => e.tagName.toLowerCase() + '.' + String(e.className).trim().split(/\\s+/).slice(0, 3).join('.') + (e.getAttribute('role') ? '[' + e.getAttribute('role') + ']' : '');
    const roots = boxes.filter((e) => !boxes.some((o) => o !== e && o.contains(e)));
    // (a box inside a box that scrolls is measured by the part that can be seen: the scroll box itself must lie in the window, what it holds is reached by scrolling, see unreachable)
    const seen = (e) => { const r = R(e); for (let a = e.parentElement; a; a = a.parentElement) { if (!boxes.includes(a) || !/auto|scroll/.test(getComputedStyle(a).overflowY)) continue; const p = a.getBoundingClientRect(); r.t = Math.max(r.t, p.top); r.b = Math.min(r.b, p.bottom); } return r; };
    const outside = boxes.map((e) => ({ name: name(e), ...seen(e) })).filter((r) => r.t < -0.5 || r.l < -0.5 || r.b > vh + 0.5 || r.r > vw + 0.5);
    // the outermost box is what is under its own pixels (three points along its top edge band and one near the bottom)
    const covered = roots.flatMap((e) => { const r = e.getBoundingClientRect(); const pts = [[r.left + r.width / 2, r.top + Math.min(14, r.height / 2)], [r.left + 12, r.top + Math.min(14, r.height / 2)], [r.right - 12, r.top + Math.min(14, r.height / 2)], [r.left + r.width / 2, r.bottom - 6]]; return pts.filter(([x, y]) => x >= 0 && y >= 0 && x <= vw && y <= vh && !(() => { const t = document.elementFromPoint(x, y); return !!t && e.contains(t); })()).map(([x, y]) => name(e) + ' at ' + Math.round(x) + ',' + Math.round(y) + ' under ' + (() => { const t = document.elementFromPoint(x, y); return t ? name(t) : 'nothing'; })()); });
    // every control reached by scrolling: whole inside its root and inside the window
    const unreachable = [];
    for (const root of roots) {
      const rr = () => root.getBoundingClientRect();
      for (const c of root.querySelectorAll('button, [role^=menuitem], input, select, textarea, a[href]')) {
        if (!shown(c) && !c.closest('[hidden]')) { if (c.getBoundingClientRect().height === 0) continue; }
        c.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const r = c.getBoundingClientRect(), p = rr();
        const inRoot = r.top >= p.top - 1 && r.bottom <= p.bottom + 1 && r.left >= p.left - 1 && r.right <= p.right + 1;
        const inWin = r.top >= -1 && r.bottom <= vh + 1;
        if (!inRoot || !inWin) unreachable.push(name(c) + ' "' + (c.textContent || c.getAttribute('aria-label') || '').trim().slice(0, 24) + '" ' + JSON.stringify(R(c)) + ' in ' + JSON.stringify(R(root)));
      }
    }
    return { n: boxes.length, names: boxes.map(name), outside, covered, unreachable: unreachable.slice(0, 6), pageScroll: document.scrollingElement.scrollTop + document.body.scrollTop, vw, vh };
  };
  return 1;
})()`;

async function open(cfg) {
  const hash = `lang=${cfg.lang}&aiset`;
  const init = `{ accountId: 'a1', to: ['alice@fabrikam.com', 'linh.tran@acme.example'], cc: ['bob@northwind.io'], subject: 'Re: Q4 contract call', isReply: true, inReplyTo: '<m1@x>', bodyHtml: '<p>Hello</p>' }`;
  if (cfg.mode === 'main') {
    await H.openApp(hash, cfg.w, cfg.h);
    await evaluate(`window.__store.getState().setPrefs({ theme: ${JSON.stringify(cfg.theme)} }); window.__store.setState({ aiConfigured: true }); window.__store.getState().openCompose(${init}); 1`);
  } else {
    await cdp('Emulation.setDeviceMetricsOverride', { width: cfg.w, height: cfg.h, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', { url: 'about:blank' });
    await cdp('Page.navigate', { url: `${H.base}?w=compose&mock=reply#${hash}` });
    await sleep(600);
    // the dev mock sets window.__store from a dynamic import: on a slow runner it is not there after a fixed pause
    await evaluate(`new Promise((ok, no) => { const t0 = Date.now(), t = setInterval(() => { if (window.__store) { clearInterval(t); ok(1); } else if (Date.now() - t0 > 20000) { clearInterval(t); no(new Error("window.__store never appeared")); } }, 100); })`);
    await evaluate(`window.__store.getState().setPrefs({ theme: ${JSON.stringify(cfg.theme)} }); 1`);
  }
  await evaluate(`new Promise((ok, no) => { const t0 = Date.now(), t = setInterval(() => { if (document.querySelector('.compose-pane .cp-editor .tiptap')?.editor) { clearInterval(t); ok(1); } else if (Date.now() - t0 > 15000) { clearInterval(t); no(new Error('compose did not start')); } }, 100); })`);
  await sleep(700);
  if (FONT || EXTRA_CSS) await evaluate(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify((FONT ? `*, *::before, *::after { font-family: ${FONT}, sans-serif !important; }` : '') + (EXTRA_CSS ?? ''))}; document.head.appendChild(s); return 1; })()`);
  await evaluate(PAGE);
}

/** Opens something with `openJs` (page code that clicks), measures every box, closes it with Escape. */
async function probe(cfg, label, openJs, { expect = 1, shotName = null, after = null, before = null } = {}) {
  const tag = `${cfg.mode} ${cfg.lang} ${cfg.w}x${cfg.h} ${cfg.theme} ${label}`;
  await evaluate(`window.__seen = new Set(document.querySelectorAll(${JSON.stringify(SEL)})); 1`);
  if (before) await before();
  const what = await evaluate(openJs);
  if (what === 'skip') return false;
  await sleep(420);
  const g = await evaluate(`window.__fit()`);
  if (flag('table')) console.log(`${tag}: ${g.n} boxes ${g.names.join(' ')}; outside ${g.outside.length}, covered ${g.covered.length}, unreachable ${g.unreachable.length}`);
  ok(tag, g.n >= expect, `nothing opened (${g.n} boxes)`);
  if (g.n >= expect) {
    ok(tag, g.outside.length === 0, `box(es) outside the ${g.vw} x ${g.vh} window: ${JSON.stringify(g.outside)}`);
    ok(tag, g.covered.length === 0, `covered by something else: ${g.covered.join('; ')}`);
    ok(tag, g.unreachable.length === 0, `controls that cannot be reached: ${g.unreachable.join('; ')}`);
    ok(tag, g.pageScroll === 0, `the page was scrolled by ${g.pageScroll}`);
    if (after) await after(tag, g);
    await shot(`${cfg.mode}-${cfg.lang}-${cfg.w}x${cfg.h}-${cfg.theme}`, shotName ?? label);
  }
  await press('Escape', 'Escape'); await sleep(200);
  // (a popover that was opened from a popover: a second Escape)
  if (await evaluate(`window.__boxes().length`)) { await press('Escape', 'Escape'); await sleep(200); }
  await evaluate(`document.querySelectorAll('.dd-fixed, .sched-pop').length ? (document.body.click(), 1) : 1`);
  await sleep(100);
  return true;
}

// every control of a bar that opens something, by index (the page is queried again each time: a bar re-renders)
const COUNT = (bar) => `document.querySelectorAll(${JSON.stringify(bar + ' [aria-haspopup]')}).length`;
const CLICK = (bar, i) => `(() => { const e = [...document.querySelectorAll(${JSON.stringify(bar + ' [aria-haspopup]')})][${i}]; if (!e) return 'skip'; e.scrollIntoView({ block: 'nearest' }); e.click(); return (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 30); })()`;
const NAME = (bar, i) => `(() => { const e = [...document.querySelectorAll(${JSON.stringify(bar + ' [aria-haspopup]')})][${i}]; return e ? (e.getAttribute('aria-label') || e.getAttribute('title') || e.textContent || '').trim().slice(0, 30) : ''; })()`;
const ROW = (start) => `(() => { const r = [...document.querySelectorAll('.dd-fixed [role^=menuitem]')].find((e) => e.textContent.trim().startsWith(${JSON.stringify(start)})); if (!r) return 'skip'; r.click(); return 1; })()`;

async function run(cfg) {
  await open(cfg);
  const tag = (s) => `${cfg.mode}-${cfg.w}x${cfg.h}`;
  // the bar of the message (Send later, More, Sign, Templates ...) and the formatting row: every control that opens something
  for (const bar of ['.cp-bar', '.fmt-tb']) {
    const n = await evaluate(COUNT(bar));
    ok(`${tag()} ${bar}`, n >= 1, `no control that opens something in ${bar}`);
    for (let i = 0; i < n; i++) {
      const name = await evaluate(NAME(bar, i));
      await evaluate(`document.querySelector('.cp-head').scrollTop = 0; 1`);
      const sendLater = bar === '.cp-bar' && /Send later|^$/.test(name) && i === 0;
      await probe(cfg, `${bar} ${i} ${name}`, CLICK(bar, i), {
        shotName: `${bar.replace('.', '')}-${i}-${name}`,
        // in a 960 x 560 window (viewport 946 x 552) the whole of Send later fits: the presets, the date and time, the footer, no scrolling (BUG-R3-1: "the footer text is cut")
        after: sendLater && cfg.lang === 'en' && cfg.h >= 552 ? async (t) => {
          const d = await evaluate(`(() => { const e = document.querySelector('.sched-picker'); return e ? [e.scrollHeight, e.clientHeight] : null; })()`);
          ok(t, !!d && d[0] <= d[1] + 1, `the Send later popover needs scrolling at ${cfg.h} px high: ${JSON.stringify(d)}`);
        } : null,
      });
    }
  }
  // the rows of the two "More" menus that open a panel on their own: Symbol, Emoji, Insert table, colours
  const moreOf = (bar) => bar === '.fmt-tb' ? `document.querySelector('.fmt-more').click()` : `document.querySelector('.cp-bar .rb.more')?.click()`;
  for (const row of ['Symbol', 'Emoji', 'Table', 'Font color', 'Highlight']) {
    await evaluate(`${moreOf('.fmt-tb')}; 1`); await sleep(300);
    const has = await evaluate(ROW(row));
    if (has === 'skip') { await press('Escape', 'Escape'); await sleep(150); continue; }
    await sleep(420);
    const g = await evaluate(`window.__fit()`);
    const t = `${cfg.mode} ${cfg.lang} ${cfg.w}x${cfg.h} ${cfg.theme} More > ${row}`;
    // (the menu closed and the panel stands: measure the panel only)
    ok(t, g.n >= 1 || row === 'Table', `nothing opened`);
    if (g.n >= 1) {
      ok(t, g.outside.length === 0, `box(es) outside the ${g.vw} x ${g.vh} window: ${JSON.stringify(g.outside)}`);
      ok(t, g.covered.length === 0, `covered: ${g.covered.join('; ')}`);
      ok(t, g.unreachable.length === 0, `controls that cannot be reached: ${g.unreachable.join('; ')}`);
      await shot(`${cfg.mode}-${cfg.lang}-${cfg.w}x${cfg.h}-${cfg.theme}`, `more-${row}`);
    }
    await press('Escape', 'Escape'); await sleep(200);
    if (await evaluate(`window.__boxes().length`)) { await press('Escape', 'Escape'); await sleep(200); }
    await evaluate(`window.__seen = new Set(document.querySelectorAll(${JSON.stringify(SEL)})); 1`);
  }
  // Send later: its date and time pickers (panels drawn on their own) and with a toast on show
  await evaluate(`document.querySelector('.cp-head').scrollTop = 0; document.querySelector('.split-caret').click(); 1`); await sleep(350);
  for (const which of ['date', 'time']) {
    await probe(cfg, `Send later > ${which} picker`, `(() => { const b = document.querySelector('.sched-picker .sched-fld.${which} .dt-pick'); if (!b) return 'skip'; b.click(); return 1; })()`, { shotName: `sendlater-${which}` });
    // (Escape closed the picker only; the popover under it is still there)
    if (!(await evaluate(`!!document.querySelector('.sched-pop')`))) { await evaluate(`document.querySelector('.split-caret').click(); 1`); await sleep(350); }
  }
  await evaluate(`document.querySelector('.sched-pop') && document.querySelector('.split-caret').click(); 1`); await sleep(250);
  // the suggestions of To
  await probe(cfg, 'To suggestions', `1`, { shotName: 'suggestions', before: async () => { await evaluate(`document.querySelector('.cp-fields .rcpt input').focus(); 1`); await cdp('Input.insertText', { text: 'li' }); } });
  await evaluate(`(() => { const i = document.querySelector('.cp-fields .rcpt input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); i.blur(); return 1; })()`);
  // the link popover (Ctrl+K in the body)
  await evaluate(`document.querySelector('.cp-editor .tiptap').focus(); 1`);
  await probe(cfg, 'Link popover', `(() => { document.querySelector('.cp-editor .tiptap').dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true })); return 1; })()`, { shotName: 'link' });
  // a picture: its toolbar and the alt text popover, then Send later with the picture selected and a toast
  const PNG = `(() => { const c = document.createElement('canvas'); c.width = 1400; c.height = 900; const g = c.getContext('2d'); g.fillStyle = '#3366aa'; g.fillRect(0, 0, 1400, 900); return c.toDataURL('image/png'); })()`;
  await evaluate(`(() => { const ed = document.querySelector('.cp-editor .tiptap').editor; ed.chain().focus().insertContent({ type: 'image', attrs: { src: ${PNG}, alt: '', width: 420 } }).run(); return 1; })()`);
  await sleep(500);
  await probe(cfg, 'Alt text popover', `(() => { const b = [...document.querySelectorAll('.img-tools .tool-btn')].find((x) => x.getAttribute('aria-haspopup') === 'dialog'); if (!b) return 'skip'; b.click(); return 1; })()`, { shotName: 'alt-text' });
  await evaluate(`(() => { const ed = document.querySelector('.cp-editor .tiptap').editor; let at = -1; ed.state.doc.descendants((n, p) => { if (at < 0 && n.type.name === 'image') at = p; }); ed.chain().focus().setNodeSelection(at).run(); window.__store.getState().showToast('Picture resized to 1.2 MB', () => {}, 'success'); document.querySelector('.cp-head').scrollTop = 0; return 1; })()`);
  await sleep(500);
  await probe(cfg, 'Send later with a picture and a toast', `(() => { document.querySelector('.split-caret').click(); return 1; })()`, {
    shotName: 'sendlater-picture-toast',
    after: async (tag, g) => {
      const x = await evaluate(`(() => { const pop = document.querySelector('.sched-pop'); const R = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; }; const T = document.querySelector('.toasts .toast'); const P = R(pop), t = T && R(T);
        const tools = document.querySelector('.img-tools-anchor'), hnd = document.querySelector('.pic-handles');
        return { overlapsToast: !!t && P.l < t.r && P.r > t.l && P.t < t.b && P.b > t.t, tools: !tools || getComputedStyle(tools).visibility === 'hidden', handles: !hnd || getComputedStyle(hnd).visibility === 'hidden' }; })()`);
      ok(tag, !x.overlapsToast, 'a toast sits on the popover');
      ok(tag, x.tools && x.handles, 'the picture toolbar / handles stay drawn under the popover');
    },
  });
}

try {
  for (const cfg of CONFIGS) {
    try { await run(cfg); } catch (e) { ok(`${cfg.mode} ${cfg.w}x${cfg.h}`, false, `threw: ${e.message}`); }
  }
} finally { await H.shutdown(); }
if (failures.length) { console.error(`test-popover-fit: ${failures.length} failure(s) in ${checks} checks`); for (const f of failures) console.error('  ' + f); process.exit(1); }
console.log(`test-popover-fit: ${CONFIGS.length} combinations, ${checks} checks passed`);
