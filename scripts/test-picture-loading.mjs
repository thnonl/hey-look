#!/usr/bin/env node
// 1.0.12 UX-1: a hidden picture that is being shown says so (a spinner in the box from the click until the result) and a picture that could not be fetched is one failed box with Retry.
// Never a broken or empty <img> in between. In the dev preview (src/devMock.ts: the backend fetch of pictures answers after `window.__remoteFetchDelayMs`; an address that contains
// "unreachable" gets no picture, `window.__remoteFetchCalls` lists the calls).
//   P1 Show this picture (click): the box is loading within one frame, same size, no <img> without a picture before the result; the picture keeps its alt; the others are not touched
//   P2 the small box: spinner only, no text; the status line and the name of the box say it      P3 several boxes at once, each its own state (one fails, one shows)
//   P4 Show pictures (the notice link) and the automatic rule: loading boxes instead of src-less pictures, then the pictures; a failure: failed box with Retry
//   P5 failed: one state, Retry starts loading again (a second fetch)   P6 dark and light theme   P7 the reader window (pop-out)
//   node scripts/test-picture-loading.mjs [--require-browser | --url=http://127.0.0.1:1420/]
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-picture-loading', { vitePort0: 5760 });
const { evaluate, cdp } = H;
const SLOW_MS = 1200;
await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `window.__remoteFetchDelayMs = ${SLOW_MS};` });
const failures = [];
let checks = 0;
let tag = '';
const ok = (c, m) => { checks++; if (!c) { failures.push(`[${tag}] ${m}`); console.error('FAIL', `[${tag}] ${m}`); } return !!c; };
const until = async (expr, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { let v = false; try { v = await evaluate(expr); } catch { /* between renders */ } if (v) return true; await sleep(30); } return false; };

const u = (n) => `https://img.shop.example/${n}.png`;
const THREADS = [
  ['lA', 'Three', { fromName: 'Shop', fromEmail: 'three@shop.example', html: `<p>Look</p><img src="${u('a1')}" width="200" height="100" alt="one"><img src="${u('a2')}" width="200" height="100" alt="two"><img src="${u('a3')}" width="200" height="100" alt="three">`, auth: 'pass' }],
  ['lB', 'Three again', { fromName: 'Shop', fromEmail: 'again@shop.example', html: `<p>Look</p><img src="${u('b1')}" width="200" height="100" alt="one"><img src="${u('b2')}" width="200" height="100" alt="two"><img src="${u('b3')}" width="200" height="100" alt="three">`, auth: 'pass' }],
  ['lS', 'Sizes', { fromName: 'Shop', fromEmail: 'sizes@shop.example', html: `<p>Look</p><img src="${u('s1')}" width="120" height="40" alt="Logo"><img src="${u('s2')}" width="200" height="70" alt="Mid"><img src="${u('s3')}" width="300" height="120" alt="Wide">`, auth: 'pass' }],
  ['lF', 'One fails', { fromName: 'Shop', fromEmail: 'fail@shop.example', html: `<p>Look</p><img src="${u('f1')}" width="200" height="100" alt="good"><img src="${u('unreachable-f2')}" width="200" height="100" alt="bad"><img src="${u('unreachable-f3')}" width="200" height="70" alt="midbad">`, auth: 'pass' }],
  ['lW', 'Written to', { fromName: 'Friend', fromEmail: 'friend@example.org', html: `<p>Look</p><img src="${u('w1')}" width="200" height="100" alt="one"><img src="${u('unreachable-w2')}" width="200" height="100" alt="gone"><img src="${u('w3')}" alt="nosize"><img src="${u('w4')}" width="1" height="1">`, auth: 'pass', autoReason: 'wrote' }],
];
const FR = `document.querySelector('.rp-msg.open iframe.msg-frame')`;
const DOC = `${FR}.contentDocument`;
const addThreads = `${THREADS.map(([id, s, o]) => `window.__mockAddThread(${JSON.stringify(id)}, ${JSON.stringify(s)}, ${JSON.stringify(o)});`).join(' ')}`;
const start = async (theme = 'light') => {
  await H.openApp(`${theme}&lang=en&nativemenu=off`, 1280, 800);
  await evaluate(`${addThreads} window.__store.getState().setPrefs({ loadRemote: false${theme === 'dark' ? ", theme: 'dark', mailCanvas: 'dark'" : ''} }); window.__store.getState().refresh().then(() => 1)`);
  await sleep(400);
};
const open = async (id) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    await evaluate(`window.__store.getState().select(null); 1`);
    await sleep(80);
    if (attempt > 0) { await evaluate(`window.__store.getState().refresh().then(() => 1)`); await sleep(400); }
    await evaluate(`window.__remoteFetchCalls = []; window.__store.getState().select(${JSON.stringify(id)}); 1`);
    if (await until(`!!${FR}`, attempt === 2 ? 15000 : 6000)) { await sleep(500); return; }
  }
  ok(false, `${id}: the message did not open`);
};
// one sample of the frame: every box (state, size, text, icon), every picture (has it an address, is it a data: picture)
const SNAP = (doc) => `(() => { const d = ${doc}; if (!d) return null; const r = (e) => { const q = e.getBoundingClientRect(); return [Math.round(q.width), Math.round(q.height)]; };
  const vis = (e) => !!e && getComputedStyle(e).display !== 'none';
  return { boxes: [...d.querySelectorAll('.hl-bp')].map((b) => ({ state: b.getAttribute('data-state'), busy: b.getAttribute('aria-busy'), bad: b.classList.contains('bad'), size: r(b), tier: b.getAttribute('data-tier'), alt: b.getAttribute('data-img-alt'), label: b.getAttribute('aria-label'), role: b.getAttribute('role'), tab: b.getAttribute('tabindex'), focused: d.activeElement === b, spin: !!b.querySelector('.hl-spin'), main: vis(b.querySelector('.hl-bp-main')) ? b.querySelector('.hl-bp-main').textContent : null, hint: vis(b.querySelector('.hl-bp-hint')) ? b.querySelector('.hl-bp-hint').textContent : null, status: b.querySelector('.hl-bp-sr') ? b.querySelector('.hl-bp-sr').textContent : null })),
    imgs: [...d.images].map((i) => ({ src: (i.getAttribute('src') || '').slice(0, 10), alt: i.getAttribute('alt'), size: r(i), ok: i.complete && i.naturalWidth > 0, done: i.complete })) }; })()`;
const snap = (doc = DOC) => evaluate(SNAP(doc));
/** Runs `act`, then samples every 25 ms until `done(sample)`; returns all the samples (t: ms since the action). */
async function sample(act, done, ms = 7000, doc = DOC) {
  const out = [];
  const t0 = Date.now();
  await evaluate(act);
  while (Date.now() - t0 < ms) {
    let s = null; try { s = await snap(doc); } catch { /* a frame being rewritten */ }
    if (s) { s.t = Date.now() - t0; out.push(s); if (done(s)) break; }
    await sleep(25);
  }
  return out;
}
/** The invariant of the whole fetch: no picture without a picture in it (an <img> with no address, or a broken one) at any sample. */
const noBroken = (samples, what) => {
  // (a picture with a data: address that the engine has not decoded yet draws nothing for a frame or two - slow on WebKitGTK, OBS-L2 - and is no broken picture; the broken forms are no address, another address, or decoded to nothing)
  const bad = samples.filter((s) => s.imgs.some((i) => (i.src !== 'data:image' || (i.done && !i.ok)) && i.size[0] > 2 && i.size[1] > 2)); // (a one-pixel picture draws nothing either way)
  ok(bad.length === 0, `${what}: ${bad.length} samples had a picture without a picture in it (${JSON.stringify(bad[0] && bad[0].imgs)})`);
};
const clickBox = (i, doc = DOC) => `(() => { ${doc}.querySelectorAll('.hl-bp')[${i}].click(); return 1; })()`;
const clickAll = (doc = DOC) => `(() => { for (const b of ${doc}.querySelectorAll('.hl-bp')) b.click(); return 1; })()`;
const calls = () => evaluate(`JSON.stringify(window.__remoteFetchCalls || [])`).then(JSON.parse);

try {
  await start();

  // ======================================================================== P1 show one
  tag = 'show-one';
  await open('lA');
  const before = await snap();
  ok(before.boxes.length === 3 && before.boxes.every((b) => b.state === null), 'three idle boxes first');
  let s = await sample(clickBox(1), (x) => x.imgs.length > 0, 6000);
  noBroken(s, 'show one');
  ok(s[0].t < 250 && s[0].boxes[1].state === 'loading', `the box is loading at the first sample (${s[0].t} ms, ${s[0].boxes[1] && s[0].boxes[1].state})`);
  const L = s[0].boxes[1];
  ok(L.role === 'img' && L.tab === '-1', `loading box is no button and out of the tab order (${L.role}, tabindex ${L.tab})`);
  ok(L.tier === 'full' && L.busy === 'true' && L.spin && L.main === 'Showing picture…' && L.hint === null && L.status === 'Showing picture…', `loading box: ${JSON.stringify(L)}`);
  ok(/two/.test(L.label) && L.alt === 'two', `the alt text is kept in the name of the box (${L.label})`);
  ok(JSON.stringify(L.size) === JSON.stringify(before.boxes[1].size), `loading box keeps its size ${JSON.stringify(before.boxes[1].size)} (${JSON.stringify(L.size)})`);
  ok(s.slice(0, -1).every((x) => x.boxes.length === 3 && x.boxes[1].state === 'loading' && JSON.stringify(x.boxes[1].size) === JSON.stringify(L.size)), 'loading all the way, never another size or state');
  ok(s.slice(0, -1).every((x) => x.boxes[0].state === null && x.boxes[2].state === null), 'the other boxes are not touched');
  const last = s[s.length - 1];
  ok(last.imgs.length === 1 && last.imgs[0].alt === 'two' && last.imgs[0].ok && last.boxes.length === 2, `the picture replaces the box, alt kept (${JSON.stringify(last.imgs)})`);
  ok((await calls()).flat().length === 1, 'one fetch');

  // ======================================================================== P2 tiers
  tag = 'tiers';
  await open('lS');
  const sz = await snap();
  ok(sz.boxes.map((b) => b.tier).join() === 'small,mid,full', `tiers ${sz.boxes.map((b) => b.tier)}`);
  ok(sz.boxes[1].tier === 'mid', 'a mid box');
  s = await sample(clickAll(), (x) => x.imgs.length === 3, 6000);
  noBroken(s, 'tiers');
  const mid = s[1] || s[0];
  ok(mid.boxes.every((b) => b.state === 'loading' && b.spin && b.busy === 'true'), 'all three load at once, each with a spinner');
  ok(mid.boxes[0].main === null && mid.boxes[0].hint === null, 'small box: spinner only, no text');
  ok(mid.boxes[0].status === 'Showing picture…' && /Showing picture/.test(mid.boxes[0].label), 'small box: the status line and the name say it (screen reader)');
  ok(mid.boxes.every((b, i) => JSON.stringify(b.size) === JSON.stringify(sz.boxes[i].size)), 'no box changes its size');

  // ======================================================================== P3 several boxes, one fails
  tag = 'multi';
  await open('lF');
  s = await sample(clickAll(), (x) => x.imgs.length === 1 && x.boxes.length === 2 && x.boxes.every((b) => b.state === 'failed'), 6000);
  noBroken(s, 'multi');
  ok(s[0].boxes.length === 3 && s[0].boxes.every((b) => b.state === 'loading'), 'all three loading at the first sample');
  const fin = s[s.length - 1];
  ok(fin.imgs.length === 1 && fin.imgs[0].alt === 'good', 'the reachable picture shows');
  ok(fin.boxes.length === 2 && fin.boxes[0].state === 'failed' && fin.boxes[0].bad && fin.boxes[0].alt === 'bad', `the other one is failed: ${JSON.stringify(fin.boxes)}`);
  ok(fin.boxes[0].main === 'Couldn’t load this picture.' && fin.boxes[0].hint === 'Retry' && fin.boxes[0].busy === null && !fin.boxes[0].spin, `failed box says it and offers Retry (${fin.boxes[0].main} / ${fin.boxes[0].hint})`);
  ok(fin.boxes[1].tier === 'mid' && fin.boxes[1].main === null && fin.boxes[1].hint === 'Retry' && fin.boxes[1].state === 'failed', `a mid box that failed says Retry only (${JSON.stringify(fin.boxes[1])})`);
  ok(fin.boxes[0].role === 'button' && fin.boxes[0].tab === '0', `failed box is a button in the tab order (${fin.boxes[0].role}, ${fin.boxes[0].tab})`);
  ok(fin.boxes[0].role === 'button' && /Retry/.test(fin.boxes[0].label) && /bad/.test(fin.boxes[0].label), `failed box is a button named with the alt and Retry (${fin.boxes[0].label})`);

  // ======================================================================== P5 Retry
  tag = 'retry';
  await evaluate(`window.__remoteFetchCalls = []; 1`);
  s = await sample(clickBox(0), (x) => x.boxes[0] && x.boxes[0].state === 'failed' && x.t > 300, 6000);
  ok(s[0].boxes[0].state === 'loading' && s[0].boxes[0].spin && s[0].boxes[0].busy === 'true', `Retry: loading again at once (${s[0].boxes[0].state})`);
  ok(s.slice(0, -1).every((x) => x.boxes[0].state === 'loading') && s.every((x) => x.imgs.length === 1), 'Retry: loading all the way, nothing else changes');
  ok(s[s.length - 1].boxes[0].state === 'failed', 'Retry: failed again (the address is still unreachable)');
  ok((await calls()).flat().length === 1, 'Retry: a second fetch');
  // the focus stays on the box through loading and failed (Enter on a focused box, then on the failed one)
  await evaluate(`${DOC}.querySelector('.hl-bp').focus(); 1`);
  s = await sample(`${DOC}.querySelector('.hl-bp').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); 1`, (x) => x.boxes[0].state === 'failed' && x.t > 300, 6000);
  ok(s.every((x) => x.boxes[0].focused), 'the focused box keeps the keyboard focus while it loads and when it failed');
  ok(s[0].boxes[0].tab === '-1' && s[s.length - 1].boxes[0].tab === '0', 'tabindex -1 while loading, 0 again when failed');
  // Enter on the failed box retries too
  await evaluate(`${DOC}.querySelector('.hl-bp').focus(); ${DOC}.querySelector('.hl-bp').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); 1`);
  ok(await until(`${DOC}.querySelector('.hl-bp').getAttribute('data-state') === 'loading'`, 800), 'Enter on the failed box retries');
  await until(`${DOC}.querySelector('.hl-bp').getAttribute('data-state') === 'failed'`, 4000);

  // ======================================================================== P4 Show pictures (notice link)
  tag = 'show-all';
  await open('lB');
  s = await sample(`document.querySelector('.rp-msg.open .notice button.link:not([data-trust])').click(); 1`, (x) => x.imgs.length === 3 && x.imgs.every((i) => i.ok), 7000);
  noBroken(s, 'show pictures');
  ok(s[0].t < 300 && s[0].boxes.length === 3 && s[0].boxes.every((b) => b.state === 'loading' && b.spin && b.busy === 'true'), `after "Show pictures": three loading boxes at once (${JSON.stringify(s[0].boxes.map((b) => b.state))})`);
  ok(s[0].boxes.every((b) => b.size[0] === 200 && b.size[1] === 100), `at the size of the hidden boxes (${JSON.stringify(s[0].boxes.map((b) => b.size))})`);
  ok(s[0].boxes.every((b) => b.role === 'img' && b.label.includes(b.alt)), 'not buttons while loading, named with the alt');
  ok(s[s.length - 1].imgs.map((i) => i.alt).join() === 'one,two,three', 'the pictures come in with their alt text');

  // ======================================================================== P4b automatic rule: a failure on the way
  tag = 'auto';
  await open('lW');
  s = await sample(`1`, (x) => x.boxes.length === 1 && x.boxes[0].state === 'failed', 7000);
  noBroken(s, 'auto');
  ok(s[0].boxes.length === 3 && s[0].boxes.every((b) => b.state === 'loading'), `the rule: loading boxes from the first sample (${JSON.stringify(s[0].boxes.map((b) => b.state))})`);
  ok(s[0].imgs.length === 1, 'the one-pixel picture stays as it is');
  const af = s[s.length - 1];
  ok(af.boxes.length === 1 && af.boxes[0].state === 'failed' && af.boxes[0].alt === 'gone' && af.boxes[0].hint === 'Retry', `automatic: the unreachable one is failed with Retry (${JSON.stringify(af.boxes.map((b) => [b.state, b.alt, b.hint]))})`);
  ok(af.imgs.filter((i) => i.ok).length === 3, `the others show (${JSON.stringify(af.imgs)})`);
  s = await sample(clickBox(0), (x) => x.boxes[0] && x.boxes[0].state === 'failed' && x.t > 300, 6000);
  ok(s[0].boxes[0].state === 'loading', 'automatic: Retry on the failed box loads again');

  // ======================================================================== P6 themes
  tag = 'dark';
  await start('dark');
  await open('lF');
  await evaluate(clickBox(1));
  await sleep(200);
  const dl = await evaluate(`(() => { const b = ${DOC}.querySelector('.hl-bp[data-state=loading]'); const c = getComputedStyle(b); const sp = b.querySelector('.hl-spin'); return { bg: c.backgroundColor, color: c.color, spin: sp ? getComputedStyle(sp).borderLeftColor : null, dark: ${DOC}.documentElement.classList.contains('hm-dark') }; })()`);
  ok(dl.dark && dl.spin === 'rgb(169, 200, 240)' && dl.bg !== 'rgb(246, 247, 249)', `dark loading box: ${JSON.stringify(dl)}`);
  const hasFailed = `!!${DOC}.querySelector('.hl-bp[data-state=failed]')`;
  ok(await until(hasFailed, 4000), 'dark: failed');
  const failedColours = `(() => { const b = ${DOC}.querySelector('.hl-bp[data-state=failed]'); const c = getComputedStyle(b); return { border: c.borderTopColor, color: c.color, ico: getComputedStyle(b.querySelector('.hl-bp-ico')).color, hint: getComputedStyle(b.querySelector('.hl-bp-hint')).color }; })()`;
  const df = await evaluate(failedColours);
  ok(df.border === 'rgb(240, 120, 140)' && df.color === 'rgb(240, 120, 140)' && df.ico === 'rgb(240, 120, 140)' && df.hint === 'rgb(240, 120, 140)', `dark failed box is light red on the dark surface: ${JSON.stringify(df)}`);
  tag = 'light';
  await start('light');
  await open('lF');
  await evaluate(clickBox(1));
  ok(await until(hasFailed, 4000), 'light: failed');
  const lf = await evaluate(failedColours);
  ok(lf.border === 'rgb(196, 49, 75)' && lf.ico === 'rgb(196, 49, 75)', `light failed box: ${JSON.stringify(lf)}`);

  // ======================================================================== P7 the reader window (pop-out)
  tag = 'reader';
  await H.openApp('lang=en&persist', 1280, 900);
  await evaluate(`window.__store.getState().setPrefs({ loadRemote: false }); 1`);
  await sleep(400);
  await cdp('Page.navigate', { url: 'about:blank' });
  await cdp('Page.navigate', { url: `${H.base}?w=reader&thread=dk11#lang=en&persist` });
  const RF = `document.querySelector('iframe.msg-frame')`;
  const rdoc = `${RF}.contentDocument`;
  ok(await until(`!!${RF} && !!${rdoc} && ${rdoc}.querySelectorAll('.hl-bp').length > 0`, 12000), 'the reader window shows the hidden box');
  await sleep(800); // (the document is hooked: its clicks listened to)
  const rb = await snap(rdoc);
  // (the logo of this mail is inside a link: a click stays the link's, Enter shows the picture)
  s = await sample(`(() => { const b = ${rdoc}.querySelector('.hl-bp'); b.focus(); b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1; })()`, (x) => x.imgs.some((i) => i.ok), 7000, rdoc);
  noBroken(s, 'reader show one');
  ok(s[0].boxes[0].state === 'loading' && s[0].boxes[0].spin && JSON.stringify(s[0].boxes[0].size) === JSON.stringify(rb.boxes[0].size), `reader: loading box, same size (${JSON.stringify(s[0].boxes[0])})`);
  ok(s[s.length - 1].imgs.some((i) => i.ok), 'reader: the picture shows');
} catch (e) {
  failures.push(`[${tag}] ${e && e.stack ? e.stack : e}`);
  console.error(e);
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-picture-loading: FAILED (${failures.length})`); process.exit(1); }
console.log(`test-picture-loading: ok (${checks} checks)`);
process.exit(0);
