#!/usr/bin/env node
// The compose pane at the smallest sizes (v1.0.6, macOS QA at 960 x 560): the rows of the header (Send / Discard, Attach / Picture / Meeting,
// Encrypt / Sign, Confidential, Save draft / Templates, Write with AI, From, To, Cc / Bcc ...) filled the whole pane, and the formatting row and the
// message body were pushed below the visible area; the pane did not scroll (it clips), Tab from To could not be followed, and the page itself was
// scrolled by the focus. Now the pane has three boxes (App.css `.cp-head`, `.cp-fmt` + `.cp-editor`, `.cp-tail`): the header scrolls and gives way,
// the formatting row never moves, the body keeps 180 px; in a pane below 600 x 480 px the actions are one row (Send, Discard, Attach as icons) plus "More actions".
//
// This opens the compose pane in the dev preview (src/devMock.ts; in the main window and as the compose window `?w=compose`) with every optional row
// switched on, in the matrix of window sizes, languages and themes, and asserts per combination: the formatting row is fully inside the pane and is
// what is under its own pixels; the body is at least 180 px high, inside the pane and what is under its own pixels; nothing sticks out of the pane
// (no scroll of the pane, of the page, no displacement); in a plain new message every field down to Subject is in view at 960 x 520; many recipients
// do not grow past their own box. The deep combinations also drive the keyboard (Tab from To reaches Subject, then the formatting row, then the body,
// always inside the pane, the field in view; Shift+Tab back), type into To / Subject / the body frame by frame (nothing moves), and open the popovers
// that live in the header (suggestions, Send later, More actions, the Sign menu): each fully inside the window and on top of what is under it.
//
//   node scripts/test-compose-fit.mjs                         the full matrix (about 5 minutes)
//   node scripts/test-compose-fit.mjs --quick                 four combinations (what CI runs)
//   node scripts/test-compose-fit.mjs --table                 also one line of measurements per combination
//   node scripts/test-compose-fit.mjs --gallery --shots=<dir> pictures of the worst case at 960 x 560 and 1280 x 720 (the checks still run)
//   node scripts/test-compose-fit.mjs --lang=en,de --size=960x560,1280x720 --shots=<dir>   (a part of the matrix; PNGs of every combination)
//   node scripts/test-compose-fit.mjs --url=http://127.0.0.1:1420/    use a dev server that is already running
//   node scripts/test-compose-fit.mjs --require-browser       fail (instead of skipping) when no Chrome/Chromium/Edge is installed
import fs from 'node:fs';
import path from 'node:path';
import { arg, flag, inputs, ROOT, sleep, startHarness } from './cdp-harness.mjs';

const QUICK = flag('quick');
const SHOTS = arg('shots');
// the minimum height of the body: composeFit.ts BODY_MIN (checked below that this is still the number there)
const BODY_MIN = 180;
const srcFit = fs.readFileSync(path.join(ROOT, 'src/composeFit.ts'), 'utf8');
if (!new RegExp(`BODY_MIN = ${BODY_MIN};`).test(srcFit)) { console.error(`test-compose-fit: src/composeFit.ts BODY_MIN is no longer ${BODY_MIN}: update this test`); process.exit(1); }

// ---------- the combinations ----------
// mode: 'main' = the pane in the main window (viewport w x h; the pane is the right column), 'popout' = the compose window (the pane is the whole viewport)
// scen: 'base' a plain new message, 'worst' every optional row on, 'many' thirty recipients in To and in Cc, 'meeting' a meeting invitation with the rest on
const CONFIGS = [];
const add = (c) => CONFIGS.push({ deep: false, ...c });
if (flag('gallery')) {
  // the pictures for the report (`--shots=<dir>`): the worst case (every row on) at the two sizes, English and German, light and dark, and the compose window
  for (const lang of ['en', 'de']) for (const [w, h] of [[960, 560], [1280, 720]]) for (const theme of ['light', 'dark']) add({ mode: 'main', lang, w, h, theme, scen: 'worst' });
  for (const lang of ['en', 'de']) for (const [w, h] of [[560, 440], [760, 680]]) for (const theme of ['light', 'dark']) add({ mode: 'popout', lang, w, h, theme, scen: 'worst' });
} else if (QUICK) {
  add({ mode: 'main', lang: 'en', w: 960, h: 530, theme: 'light', scen: 'worst', deep: true });
  add({ mode: 'main', lang: 'de', w: 1280, h: 720, theme: 'dark', scen: 'many' });
  add({ mode: 'main', lang: 'en', w: 960, h: 520, theme: 'dark', scen: 'base' });
  add({ mode: 'popout', lang: 'en', w: 560, h: 440, theme: 'light', scen: 'worst', deep: true });
} else {
  const langs = (arg('lang') || 'en,de,ru').split(',');
  const sizes = [[960, 560], [960, 532], [960, 520], [960, 480], [1280, 532], [1280, 720], [1920, 480], [1920, 1080]].filter(([w, h]) => !arg('size') || arg('size').split(',').includes(`${w}x${h}`));
  let n = 0;
  // (every row on in every language, since the longer labels of German and Russian wrap; the other scenarios in English)
  for (const lang of langs) for (const [w, h] of sizes) for (const scen of lang === 'en' ? ['base', 'worst', 'many', 'meeting'] : ['base', 'worst']) {
    n++;
    add({ mode: 'main', lang, w, h, theme: n % 2 ? 'light' : 'dark', scen, deep: lang === 'en' && scen === 'worst' && [[960, 520], [960, 560], [1280, 720], [1920, 480]].some(([a, b]) => a === w && b === h) });
  }
  for (const lang of langs) for (const [w, h] of [[560, 440], [760, 680], [560, 560]]) for (const scen of lang === 'en' ? ['base', 'worst', 'many'] : ['worst']) add({ mode: 'popout', lang, w, h, theme: scen === 'worst' ? 'dark' : 'light', scen, deep: lang === 'en' && scen === 'worst' });
}

const H = await startHarness('test-compose-fit', { vitePort0: 5560, cdpPort0: 9560 });
const { evaluate, cdp } = H;
const { typeText } = inputs(H, SHOTS, '');
// a key with its virtual key code (Chrome moves the focus on Tab only for a key that has one); `shift` = Shift held
const press = async (key, code, shift = false) => {
  const vk = { Tab: 9, Escape: 27 }[key];
  const p = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: shift ? 8 : 0 };
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...p });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
};
const failures = [];
let checks = 0;
const fail = (cfg, msg) => { const line = `[${cfg.mode} ${cfg.lang} ${cfg.w}x${cfg.h} ${cfg.theme} ${cfg.scen}] ${msg}`; failures.push(line); console.error('FAIL ' + line); };
const ok = (cfg, cond, msg) => { checks++; if (!cond) fail(cfg, msg); };

// ---------- what each scenario opens ----------
const quote = Array.from({ length: 30 }, (_, i) => `<p>Line ${i + 1} of a long quoted message that goes on and on and on.</p>`).join('');
const atts = [1, 2, 3].map((i) => ({ filename: `quarterly-report-with-a-long-name-${i}.pdf`, mime: 'application/pdf', dataBase64: 'AAAA' }));
const many = JSON.stringify(Array.from({ length: 30 }, (_, i) => `person${i}@example.com`));
const INIT = {
  base: `{ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Hello' }`,
  worst: `{ accountId: 'a1', to: ['alice@fabrikam.com', 'linh.tran@acme.example'], cc: ['bob@northwind.io'], bcc: ['carol@example.com'], subject: 'Re: Q4 contract call', isReply: true, inReplyTo: '<m1@x>', bodyHtml: ${JSON.stringify(quote)}, attachments: ${JSON.stringify(atts)} }`,
  many: `{ accountId: 'a1', to: ${many}, cc: ${many}, subject: 'Many recipients', attachments: ${JSON.stringify(atts)} }`,
  meeting: `{ accountId: 'a1', to: ['alice@fabrikam.com'], cc: ['bob@northwind.io'], subject: 'Q4 contract call', meeting: { on: true }, attachments: ${JSON.stringify(atts)} }`,
};
const EXTRAS = { base: [], worst: ['encrypt', 'sign', 'confidential', 'high', 'ai'], many: ['ai'], meeting: ['encrypt', 'sign', 'confidential', 'ai'] };

// press a header action wherever it is: a button of the row (a pane of 600 px or more) or a row of "More actions" (a small one)
const ACT = `(() => {
  const bar = document.querySelector('.cp-bar');
  const more = bar.querySelector('.rb.more');
  const pressed = [...bar.querySelectorAll('[aria-pressed]')];      // Meeting, Encrypt, Sign, Confidential, High, Low
  const ai = bar.querySelector('.grow').previousElementSibling;
  const roomy = { meeting: pressed[0], encrypt: pressed[1], sign: pressed[2], confidential: pressed[3], high: pressed[4], ai };
  return { more, roomy };
})()`;
async function act(name) {
  const compact = await evaluate(`!!document.querySelector('.cp-bar .rb.more')`);
  if (!compact) return evaluate(`(() => { const b = ({ meeting: 0, encrypt: 1, sign: 2, confidential: 3, high: 4 })[${JSON.stringify(name)}]; const bar = document.querySelector('.cp-bar'); const p = [...bar.querySelectorAll('[aria-pressed]')]; const el = ${JSON.stringify(name)} === 'ai' ? bar.querySelector('.grow').previousElementSibling : p[b]; el.click(); return 1; })()`);
  // More actions: the rows with a check state, in order: Meeting, Encrypt, Sign, Attach my public key, Confidential, High, Low, Write with AI
  const index = { meeting: 0, encrypt: 1, sign: 2, confidential: 4, high: 5, ai: 7 }[name];
  await evaluate(`document.querySelector('.cp-bar .rb.more').click()`);
  await sleep(120);
  await evaluate(`document.querySelectorAll('.dd-fixed [role=menuitemradio]')[${index}].click()`);
  await sleep(120);
}

// ---------- the page side ----------
const GEO = `(() => {
  const pane = document.querySelector('.compose-pane'); if (!pane) return null;
  const R = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
  const P = R(pane), head = pane.querySelector('.cp-head'), fmt = pane.querySelector('.cp-fmt'), ed = pane.querySelector('.cp-editor'), tail = pane.querySelector('.cp-tail');
  const hit = (el, box) => { if (!el || !box) return false; const x = box.l + Math.min(box.w / 2, 40), y = box.t + Math.min(box.h / 2, 12); const t = document.elementFromPoint(x, y); return !!t && el.contains(t); };
  const btn = fmt && fmt.querySelector('button');
  const inside = (b) => !!b && b.t >= P.t - 0.5 && b.b <= P.b + 0.5 && b.l >= P.l - 0.5 && b.r <= P.r + 0.5;
  const H = R(head), sub = R(pane.querySelector('.cf-subject'));
  const region = pane.parentElement, RR = R(region);
  const rc = [...pane.querySelectorAll('.cf-field.rcpt')].map((f) => R(f.querySelector('.chips')));
  return {
    pane: P, compact: pane.classList.contains('compact'), head: H, headScrolls: !!head && head.scrollHeight > head.clientHeight + 1, fmt: R(fmt), fmtIn: inside(R(fmt)), fmtHit: hit(btn, R(btn)),
    ed: R(ed), edIn: inside(R(ed)), edHit: hit(ed, R(ed)), tail: R(tail), subject: sub,
    subjectInHead: !!sub && !!H && sub.t >= H.t - 0.5 && sub.b <= H.b + 0.5,
    paneScroll: [pane.scrollHeight, pane.clientHeight], pageScroll: document.scrollingElement.scrollTop + document.body.scrollTop, displaced: Math.abs(P.t - RR.t) > 0.5 || Math.abs(P.b - RR.b) > 0.5 || Math.abs(P.l - RR.l) > 0.5,
    chips: rc.map((c) => c && c.h), more: !!pane.querySelector('.rb.more'), vw: innerWidth, vh: innerHeight,
    bar: R(pane.querySelector('.cp-bar')), aiBar: !!pane.querySelector('.cp-ai'),
  };
})()`;

async function open(cfg) {
  const hash = `lang=${cfg.lang}&aiset`;
  if (cfg.mode === 'main') {
    await H.openApp(hash, cfg.w, cfg.h);
    await evaluate(`window.__store.getState().setPrefs({ theme: ${JSON.stringify(cfg.theme)} }); window.__store.setState({ aiConfigured: true }); 1`);
    await evaluate(`window.__store.getState().openCompose(${INIT[cfg.scen]}); 1`);
  } else {
    // the compose window in a plain tab (the mock answers popout_init); the message comes from the same init as above through the mock's `reply` / `new` kinds,
    // the rest is set up below
    await cdp('Emulation.setDeviceMetricsOverride', { width: cfg.w, height: cfg.h, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', { url: 'about:blank' });
    await cdp('Page.navigate', { url: `${H.base}?w=compose&mock=${cfg.scen === 'base' ? 'new' : 'reply'}#${hash}` });
    await sleep(600);
    await evaluate(`new Promise((ok, no) => { const t0 = Date.now(), t = setInterval(() => { if (document.querySelector('.compose-pane .cp-editor .tiptap')) { clearInterval(t); ok(1); } else if (Date.now() - t0 > 15000) { clearInterval(t); no(new Error('compose window did not start')); } }, 100); })`);
    await evaluate(`window.__store.getState().setPrefs({ theme: ${JSON.stringify(cfg.theme)} }); window.__store.setState({ aiConfigured: true }); 1`);
    if (cfg.scen !== 'base') {
      // more recipients and the Cc / Bcc rows like the scenario of the main window: put into the fields (the window's message cannot be handed over)
      const addTo = async (i, text) => { await evaluate(`document.querySelectorAll('.cp-fields .rcpt input')[${i}].focus()`); await cdp('Input.insertText', { text }); await sleep(120); };
      await addTo(0, cfg.scen === 'many' ? JSON.parse(many).join(',') + ',' : 'alice@fabrikam.com,');
      await evaluate(`document.querySelector('.compose-pane').dispatchEvent(new KeyboardEvent('keydown', { key: 'C', ctrlKey: true, shiftKey: true, bubbles: true })); 1`);
      await sleep(150);
      await addTo(1, cfg.scen === 'many' ? JSON.parse(many).join(',') + ',' : 'bob@northwind.io,');
      if (cfg.scen === 'worst') await addTo(2, 'carol@example.com,');
    }
  }
  await sleep(900);
  await evaluate(`document.querySelector('.compose-pane') ? 1 : (() => { throw new Error('no compose pane'); })()`);
  for (const name of EXTRAS[cfg.scen]) { await act(name); await sleep(150); }
  if (cfg.mode === 'popout' && cfg.scen !== 'base') {
    // a few attachments: the file input of the pane
    await evaluate(`(() => { const dt = new DataTransfer(); for (const n of ['a-long-quarterly-report-name-1.pdf', 'a-long-quarterly-report-name-2.pdf', 'a-long-quarterly-report-name-3.pdf']) dt.items.add(new File(['x'], n, { type: 'application/pdf' })); const i = document.querySelector('.cp-bar input[type=file]'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
  }
  await sleep(500);
  // whatever focus did (the AI box takes it): the page and the pane start at the top
  await evaluate(`(() => { document.activeElement && document.activeElement.blur && 0; })()`);
}
async function typeInto(cfg, selector, text) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  await typeText(text, 8);
}
const tag = (cfg) => `${cfg.mode}-${cfg.lang}-${cfg.w}x${cfg.h}-${cfg.theme}-${cfg.scen}`;
const shot = async (cfg, name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, `${tag(cfg)}-${name}.png`), Buffer.from(r.data, 'base64')); };

function layout(cfg, g, when) {
  const w = `${when}: `;
  ok(cfg, !!g, `${w}no compose pane`);
  if (!g) return;
  ok(cfg, g.fmtIn, `${w}the formatting row is not inside the pane (${JSON.stringify(g.fmt)} in ${JSON.stringify(g.pane)})`);
  ok(cfg, g.fmtHit, `${w}the formatting row is covered by something else`);
  ok(cfg, g.edIn, `${w}the body is not inside the pane (${JSON.stringify(g.ed)} in ${JSON.stringify(g.pane)})`);
  ok(cfg, g.ed && g.ed.h >= BODY_MIN - 0.5, `${w}the body is ${g.ed && g.ed.h} px high, at least ${BODY_MIN} expected`);
  ok(cfg, g.edHit, `${w}the body is covered by something else`);
  ok(cfg, g.paneScroll[0] <= g.paneScroll[1] + 1, `${w}the pane overflows (${g.paneScroll[0]} > ${g.paneScroll[1]})`);
  ok(cfg, g.pageScroll === 0, `${w}the page was scrolled by ${g.pageScroll}`);
  ok(cfg, !g.displaced, `${w}the pane is displaced in its region`);
  ok(cfg, g.fmt && g.ed && g.fmt.b <= g.ed.t + 0.5, `${w}the formatting row is not above the body`);
  ok(cfg, g.compact === (g.pane.w < 600 || g.pane.h < 480), `${w}compact is ${g.compact} for a pane of ${g.pane.w} x ${g.pane.h}`);
  ok(cfg, g.more === g.compact, `${w}"More actions" is ${g.more ? 'there' : 'missing'} in a ${g.compact ? 'compact' : 'roomy'} pane`);
  // many recipients stay in a box of their own height (App.css .chips: 124 px, 64 px in a small pane)
  for (const h of g.chips) ok(cfg, h === null || h <= (g.compact ? 64 : 124) + 1, `${w}a recipient box grew to ${h} px`);
  // a small pane: the actions are ONE row (the longest names of Send are cut, not wrapped), so the row can stay put above the fields
  if (g.compact && g.bar) ok(cfg, g.bar.h <= 52, `${w}the action row is ${g.bar.h} px high: it wrapped`);
  // the tail (attachments) has a box of its own too
  if (g.tail) ok(cfg, g.tail.h <= (g.compact ? 46 : 132) + 1, `${w}the attachments box is ${g.tail.h} px`);
  // a plain new message: everything down to Subject is in view without scrolling the header (at the least window the pane is 378 px high)
  if (cfg.scen === 'base' && cfg.mode === 'main' && cfg.h >= 520) ok(cfg, g.subjectInHead, `${w}Subject is not in view in a plain new message`);
  if (cfg.scen === 'base' && cfg.mode === 'popout') ok(cfg, g.subjectInHead, `${w}Subject is not in view in a plain new message`);
}

// ---------- the deep checks: keyboard, typing, popovers ----------
const ACTIVE = `(() => { const a = document.activeElement; const pane = document.querySelector('.compose-pane'); const head = pane.querySelector('.cp-head'); const r = a.getBoundingClientRect(), h = head.getBoundingClientRect();
  return { tag: a.tagName, label: a.getAttribute('aria-label') || '', cls: String(a.className), inPane: pane.contains(a), inHead: head.contains(a), inFmt: !!a.closest('.cp-fmt'), inBody: !!a.closest('.cp-editor'), inHeadView: head.contains(a) ? (r.top >= h.top - 0.5 && r.bottom <= h.bottom + 0.5) : null, isSubject: !!a.closest('.cf-subject') && a.tagName === 'INPUT' }; })()`;
async function keyboard(cfg) {
  const to = '.cp-fields .rcpt input';
  // From the very top of the header: To -> Tab -> Subject (Cc and Bcc are not Tab stops), the field in view
  await evaluate(`document.querySelector('.cp-head').scrollTop = 0; document.querySelector(${JSON.stringify(to)}).focus(); 1`);
  await press('Tab', 'Tab');
  await sleep(120);
  let a = await evaluate(ACTIVE);
  ok(cfg, a.inPane, `Tab from To left the compose pane (now on ${a.tag} ${a.cls})`);
  // (the chips of Cc and Bcc have a Remove button each and the inputs are stops: walk at most 8 stops, each one in the pane and in view; with
  // thirty chips the rest of the walk is skipped: the last recipient box is focused and Tab must reach Subject from there)
  for (let i = 0; i < 8 && !a.isSubject && a.inPane; i++) {
    ok(cfg, a.inHeadView === true, `a Tab stop (${a.tag} ${a.label || a.cls}) is not in view in the header`);
    await press('Tab', 'Tab'); await sleep(100); a = await evaluate(ACTIVE);
  }
  if (!a.isSubject && a.inPane) {
    await evaluate(`[...document.querySelectorAll('.cp-fields .rcpt input')].pop().focus(); 1`);
    await press('Tab', 'Tab'); await sleep(100); a = await evaluate(ACTIVE);
  }
  ok(cfg, a.isSubject, `Tab from To did not reach Subject (stopped on ${a.tag} ${a.label || a.cls})`);
  ok(cfg, a.inHeadView === true, `Subject got the focus but is not in view in the header`);
  // Subject -> the formatting row (one stop) -> the body
  let stops = 0;
  const seen = [];
  while (stops < 4 && !a.inBody) { await press('Tab', 'Tab'); await sleep(100); a = await evaluate(ACTIVE); stops++; seen.push(`${a.tag}.${a.label || a.cls}`); ok(cfg, a.inPane, `Tab left the compose pane (now on ${a.tag} ${a.cls})`); }
  ok(cfg, a.inBody, `Tab from Subject did not reach the body within 4 stops (${seen.join(' > ')})`);
  ok(cfg, stops >= 2, `Tab from Subject went to the body without the formatting row (${stops} stop)`);
  // and back: Shift+Tab from the body goes to the formatting row, again to Subject
  await press('Tab', 'Tab', true); await sleep(100); a = await evaluate(ACTIVE);
  ok(cfg, a.inPane && a.inFmt, `Shift+Tab from the body did not reach the formatting row (now on ${a.tag} ${a.cls})`);
  const back = [];
  // (the links of the security strip, when there is one, sit between Subject and the formatting row: they are stops too)
  for (let i = 0; i < 6 && !a.isSubject; i++) { await press('Tab', 'Tab', true); await sleep(100); a = await evaluate(ACTIVE); back.push(`${a.tag}.${a.label || a.cls}`); ok(cfg, a.inPane && (a.inHeadView !== false), `Shift+Tab left the pane or went to a stop out of view (${back.join(' > ')})`); }
  ok(cfg, a.isSubject && a.inHeadView === true, `Shift+Tab from the formatting row did not reach Subject in view (${back.join(' > ')})`);
  // focus scrolls a field into view: the header scrolled to the bottom, then To focused
  await evaluate(`const h = document.querySelector('.cp-head'); h.scrollTop = h.scrollHeight; document.querySelector(${JSON.stringify(to)}).focus(); 1`);
  await sleep(100);
  a = await evaluate(ACTIVE);
  ok(cfg, a.inHeadView === true, `To was focused but is not in view in the header`);
}

async function typing(cfg) {
  // frame by frame: the formatting row, the body and the header do not move while typing (suggestions are a layer of their own)
  await evaluate(`(() => { const pane = document.querySelector('.compose-pane'); const R = (s) => { const e = pane.querySelector(s); const r = e.getBoundingClientRect(); return [r.top, r.height].map((n) => Math.round(n * 10) / 10).join(','); };
    window.__fitLog = new Set(); const tick = () => { window.__fitLog.add([R('.cp-head'), R('.cp-fmt'), R('.cp-editor'), R('.cp-tail'), document.querySelector('.cp-head').clientHeight].join('|')); requestAnimationFrame(tick); }; tick(); })()`);
  await sleep(100);
  await typeInto(cfg, '.cp-fields .rcpt input', 'li'); await sleep(250);
  const sug = await evaluate(`(() => { const s = document.querySelector('.suggest.pinned'); if (!s) return null; const r = s.getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 14)); return { l: r.left, t: r.top, r: r.right, b: r.bottom, hit: !!t && s.contains(t), vw: innerWidth, vh: innerHeight }; })()`);
  ok(cfg, !!sug, 'typing "li" in To showed no suggestions');
  if (sug) ok(cfg, sug.l >= -1 && sug.t >= -1 && sug.r <= sug.vw + 1 && sug.b <= sug.vh + 1 && sug.hit, `the suggestions are cut off or covered: ${JSON.stringify(sug)}`);
  await evaluate(`document.querySelector('.cp-fields .rcpt input').blur(); 1`);
  await typeInto(cfg, '.cf-subject input', ' typed subject text'); await sleep(100);
  await evaluate(`document.querySelector('.cp-editor .tiptap').focus(); 1`);
  await typeText('Typing in the body goes on and on and on, line after line. '.repeat(3), 6); await sleep(150);
  const frames = await evaluate(`[...window.__fitLog]`);
  ok(cfg, frames.length === 1, `the layout moved while typing (${frames.length} different states: ${frames.slice(0, 3).join(' ; ')})`);
}

async function popovers(cfg) {
  const inWindow = (what, o) => ok(cfg, !!o && o.l >= -1 && o.t >= -1 && o.r <= o.vw + 1 && o.b <= o.vh + 1 && o.hit, `${what} is cut off or covered: ${JSON.stringify(o)}`);
  const probe = (sel) => `(() => { const s = document.querySelector(${JSON.stringify(sel)}); if (!s) return null; const r = s.getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 14)); return { l: r.left, t: r.top, r: r.right, b: r.bottom, hit: !!t && s.contains(t), vw: innerWidth, vh: innerHeight }; })()`;
  // Send later by its key while the header is scrolled to the bottom (the button is out of view: the popover is placed inside the window, the button comes into view)
  await evaluate(`(() => { const hd = document.querySelector('.cp-head'); hd.scrollTop = hd.scrollHeight; document.querySelector('.compose-pane').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, shiftKey: true, bubbles: true })); })()`); await sleep(250);
  inWindow('the Send later popover opened by its key', await evaluate(probe('.sched-pop')));
  await evaluate(`document.querySelector('.split-caret').click(); 1`); await sleep(150);
  // Send later
  await evaluate(`document.querySelector('.cp-head').scrollTop = 0; document.querySelector('.split-caret').click(); 1`); await sleep(250);
  inWindow('the Send later popover', await evaluate(probe('.sched-pop')));
  await evaluate(`document.querySelector('.split-caret').click(); 1`); await sleep(150);
  // More actions (small pane) or the Sign menu (roomy)
  if (await evaluate(`!!document.querySelector('.cp-bar .rb.more')`)) {
    await evaluate(`document.querySelector('.cp-bar .rb.more').click(); 1`); await sleep(250);
    inWindow('More actions', await evaluate(probe('.dd-fixed')));
    const rows = await evaluate(`document.querySelectorAll('.dd-fixed [role^=menuitem]').length`);
    ok(cfg, rows >= 10, `More actions has ${rows} rows`);
    await press('Escape', 'Escape'); await sleep(150);
  } else {
    await evaluate(`document.querySelector('.cp-bar .rb.caret').click(); 1`); await sleep(250);
    inWindow('the Sign menu', await evaluate(probe('.dd-fixed')));
    await press('Escape', 'Escape'); await sleep(150);
  }
}

// ---------- run ----------
try {
  for (const cfg of CONFIGS) {
    try {
      await open(cfg);
      const g = await evaluate(GEO);
      if (flag('table') && g) console.log(`${tag(cfg)}: pane ${Math.round(g.pane.w)}x${Math.round(g.pane.h)} ${g.compact ? 'compact' : 'roomy'}; formatting row ${g.fmtIn && g.fmtHit ? 'in view' : 'NOT in view'} (y ${Math.round(g.fmt.t - g.pane.t)}); body ${Math.round(g.ed.h)} px${g.edIn && g.edHit ? '' : ' NOT in view'}; header ${g.head ? Math.round(g.head.h) + (g.headScrolls ? ' (scrolls)' : '') : 'n/a'}; page scrolled ${g.pageScroll}; pane overflow ${g.paneScroll[0] - g.paneScroll[1]}`);
      layout(cfg, g, 'start');
      await shot(cfg, 'start');
      if (cfg.deep) {
        await keyboard(cfg);
        await typing(cfg);
        await popovers(cfg);
        layout(cfg, await evaluate(GEO), 'after typing');
        await shot(cfg, 'end');
      }
      // the rows of "More actions" that are on show a dot on the button
      if (g && g.compact && EXTRAS[cfg.scen].length) ok(cfg, await evaluate(`!!document.querySelector('.cp-bar .rb.more .more-dot')`), 'More actions shows no dot although actions are on');
    } catch (e) { fail(cfg, `threw: ${e.message}`); }
  }
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-compose-fit: ${failures.length} failure(s) in ${checks} checks`); for (const f of failures) console.error('  ' + f); process.exit(1); }
console.log(`test-compose-fit: ${CONFIGS.length} combinations, ${checks} checks passed`);
