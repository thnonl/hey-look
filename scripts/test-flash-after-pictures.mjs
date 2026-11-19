#!/usr/bin/env node
// 1.0.20: a table newsletter whose pictures arrive one by one does not flash after the last picture is in, neither on its FIRST open nor when it is OPENED AGAIN within 60 s (the owner's
// "click again on a mail already viewed"). On the reopen a tracking pixel that failed a moment ago is not asked again (remoteImages RETRY_AFTER_MS), so no answer comes for it, and the backend's
// final answer (settledFor) used to change the HTML: the whole 5 MB frame was written a second time, 100-155 ms after the first (documentElement replaced, every picture created again, hm-pend
// back on the dark background). The frame must be left alone: no new document after the first writes, no picture created again, no hm-pend, no change of the body's background or colour, no
// change of the frame's height, no picture fading again; and the document the reopen ends with must be the one the first open ended with (the failed pixel gone, the failed box the same).
// Only `iframe.msg-frame` is sampled (the hidden dark scratch frame, data-hl-scratch, opens twice by design).
//   node scripts/test-flash-after-pictures.mjs [--require-browser | --url=http://127.0.0.1:1420/]
import fs from 'node:fs';
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-flash-after-pictures', { vitePort0: 5790 });
const { evaluate, cdp } = H;
await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `window.__remoteFetchDelayMs = 0;` });
const failures = [];
let checks = 0;
let tag = '';
const ok = (c, m) => { checks++; if (!c) { failures.push(`[${tag}] ${m}`); console.error('FAIL', `[${tag}] ${m}`); } return !!c; };

const slow = (ms, n) => `https://d1rr9ofe14xxx2.cloudfront.net/slow/${ms}/push/${n}.png`;
const html = `<table width="100%" bgcolor="#F3F3F3" cellpadding="0" cellspacing="0"><tr><td align="center">
<table width="600" bgcolor="#ffffff" cellpadding="0" cellspacing="0">
<tr><td bgcolor="#00b14f" style="padding:12px"><img src="https://image.mkt.grab.com/slow/200/logo.png" width="120" height="40" alt="Grab"></td></tr>
<tr><td style="padding:16px;color:#222;font-family:Arial">Your week with Grab</td></tr>
<tr><td bgcolor="#d9fcde" style="padding:16px;color:#111">${[0, 1, 2, 3].map((i) => `<img src="${slow(500 + i * 450, `metric${i + 1}`)}" width="48" height="48" alt="metric${i + 1}">`).join(' ')}</td></tr>
<tr><td style="padding:16px"><img src="https://image.mkt.grab.com/slow/900/hero.jpg" width="560" height="200" alt="hero"></td></tr>
<tr><td bgcolor="#d9fcde" style="padding:16px"><img src="${slow(2300, 'gmpromoicon')}" width="40" height="40" alt="gm"> <img src="${slow(2600, 'grpromoicon')}" width="40" height="40" alt="gr"> Promo</td></tr>
<tr><td style="padding:16px;color:#333"><img src="https://image.mkt.grab.com/unreachable/badge.png" width="200" height="60" alt="badge"> Footer text<img src="https://image.mkt.grab.com/unreachable/pixel.gif" width="1" height="1" alt=""></td></tr></table></td></tr></table>`;
const FR = `document.querySelector('.rp-msg.open iframe.msg-frame')`;
const DOC = `${FR}.contentDocument`;

// one sample: stamps on the document and the pictures tell a new document / a new picture; everything that could flash is counted from the moment the last picture was first seen
const PROBE = `(() => { const d = ${DOC}; if (!d || !d.documentElement || !d.body) return null; const t = Date.now(); const w = window.__fl = window.__fl || { docs: 0, born: {}, last: 0, ev: [] };
  const de = d.documentElement; if (!de.__flSeen) { de.__flSeen = 1; w.docs++; w.ev.push([t - (w.t0 || t), 'doc']); }
  const imgs = [...d.images].filter((i) => (i.getAttribute('src') || '').startsWith('data:'));
  let newest = 0; for (const i of imgs) { if (!i.__flSeen) { i.__flSeen = t; const k = i.getAttribute('alt'); w.born[k] = (w.born[k] || 0) + 1; w.last = t; w.ev.push([t - (w.t0 || t), 'img ' + k]); } }
  const cs = getComputedStyle(d.body); const rt = getComputedStyle(de);
  const st = { writes: window.__mailFrame.writes, pend: de.classList.contains('hm-pend'), bg: cs.backgroundColor + '|' + rt.backgroundColor, fg: cs.color, h: Math.round(d.body.getBoundingClientRect().height), fh: Math.round(${FR}.getBoundingClientRect().height),
    lows: imgs.filter((i) => t - i.__flSeen > 450 && parseFloat(getComputedStyle(i).opacity) < 1).length, lit: imgs.filter((i) => t - i.__flSeen > 450 && i.hasAttribute('data-hl-new')).length,
    cells: [...d.querySelectorAll('td[bgcolor]')].map((c) => getComputedStyle(c).backgroundColor).join(','), imgs: imgs.length };
  return { t, st, docs: w.docs, born: w.born, last: w.last }; })()`;

// Opens the mail (after `reset` of the window.__fl marks), samples the frame for 6.5 s. Everything that is a new document after `QUIET` ms is a rewrite once the pictures started to arrive
// (the first writes of an opening all happen before it).
const QUIET = 280;
// the document the frame ends with, without what differs by timing or by number only: every element as tag + its attributes (sorted; no fade mark, no data-hm number, the data: URIs shortened) + what the eye sees of it
function snapDoc(frameSel) {
  const d = document.querySelector(frameSel).contentDocument; const w = d.defaultView; const out = [d.documentElement.className.replace(/s*hm-pend/, '!pend')];
  for (const e of d.body.querySelectorAll('*')) {
    const a = [...e.attributes].filter((x) => x.name !== 'data-hm' && x.name !== 'data-hl-new').map((x) => x.name + '=' + x.value.replace(/data:image[/][a-z+]+;base64,[A-Za-z0-9+/=]+/g, 'D').replace(/opacity:[^;]*;?/g, '')).sort().join(' ');
    const c = w.getComputedStyle(e); out.push(e.tagName + ' ' + a + ' | ' + [c.color, c.backgroundColor, c.borderTopColor, c.filter, c.display].join(' / '));
  }
  return out.join(String.fromCharCode(10));
}
const SNAP = `(${snapDoc})('.rp-msg.open iframe.msg-frame')`;
const snaps = {};
async function open(label, expectPics, expectReopen = false) {
  tag = label;
  await evaluate(`window.__fl = { docs: 0, born: {}, last: 0, ev: [], t0: Date.now(), w0: window.__mailFrame.writes }; window.__store.getState().select('lG'); 1`);
  const series = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 6500) {
    let r = null; try { r = await evaluate(PROBE); } catch { /* a frame being written */ }
    if (r) series.push(r);
    await sleep(20);
  }
  ok(series.length > 50, `${series.length} samples`);
  const fin = series[series.length - 1];
  if (!fin) return;
  const ev = await evaluate('window.__fl.ev');
  const late = ev.filter(([t, k]) => k === 'doc' && t > QUIET);
  ok(fin.st.imgs === expectPics, `${expectPics} pictures are in (${fin.st.imgs})`);
  ok(late.length === 0, `no frame document written after ${QUIET} ms (${JSON.stringify(late)}); events ${JSON.stringify(ev)}`);
  // (the dev preview runs in React.StrictMode: its double effect writes the frame twice when the message is mounted, the production build once; a third write is a rewrite)
  const writes = fin.st.writes - (await evaluate('window.__fl.w0'));
  ok(writes <= 2, `the frame was written at most twice (StrictMode mount) while it opened and its pictures came (${writes} writes)`);
  if (!expectReopen) ok(Object.values(fin.born).every((n) => n === 1), `no picture created more than once (${JSON.stringify(fin.born)})`);
  const after = series.filter((s) => s.t > fin.last + 600);
  ok(after.length > 20, `${after.length} samples after the last arrival`);
  const base = after[0];
  const changed = (k) => after.filter((s) => JSON.stringify(s.st[k]) !== JSON.stringify(base.st[k])).length;
  for (const k of ['writes', 'pend', 'bg', 'fg', 'fh', 'cells', 'lows', 'lit']) ok(changed(k) === 0, `after the last arrival "${k}" never changes (${changed(k)} samples differ from ${JSON.stringify(base.st[k])})`);
  const pendSeen = series.filter((s) => s.t > fin.last && s.st.pend).length;
  ok(pendSeen === 0, `hm-pend is not on after the pictures are in (${pendSeen} samples)`);
  snaps[label] = await evaluate(SNAP);
  ok(!/data-hl-wait|data-hl-wsrc|hm-pend/.test(snaps[label]) && !/data-state=loading/.test(snaps[label]), `no waiting box and no waiting pixel is left`);
  ok(/data-state=failed/.test(snaps[label]) && !/pixel.gif/.test(snaps[label]), `the failed badge is a failed box and the failed pixel is gone`);
  console.log(label, JSON.stringify(ev), JSON.stringify({ writes, docs: fin.docs, late: late.length, born: fin.born, bg: base.st.bg, fh: base.st.fh }));
}

async function run(theme) {
  await H.openApp(`${theme}&lang=en&nativemenu=off`, 1280, 800);
  await evaluate(`window.__mockAddThread('lG', 'Grab newsletter', { fromName: 'Grab', fromEmail: 'news@mkt.grab.com', html: ${JSON.stringify(html)}, auth: 'pass', autoReason: 'wrote' }); window.__mockAddThread('lO', 'Other', { fromName: 'Other', fromEmail: 'o@example.org', html: '<p>Other</p>', auth: 'pass' }); window.__store.getState().setPrefs({ loadRemote: true${theme === 'dark' ? ", theme: 'dark', mailCanvas: 'dark'" : ''} }); window.__store.getState().refresh().then(() => 1)`);
  await sleep(500);
  await open(`${theme} first open`, 8);
  await evaluate(`window.__store.getState().select('lO'); 1`);
  await sleep(600);
  await open(`${theme} reopened`, 8, true);
  tag = `${theme} compare`;
  if (process.env.HL_DUMP) fs.writeFileSync(`${process.env.HL_DUMP}-${theme}-first.html`, snaps[`${theme} first open`]), fs.writeFileSync(`${process.env.HL_DUMP}-${theme}-reopen.html`, snaps[`${theme} reopened`]);
  ok(snaps[`${theme} reopened`] === snaps[`${theme} first open`], `the reopened mail ends with the same document as the first open (${snaps[`${theme} reopened`].length} / ${snaps[`${theme} first open`].length} chars)`);
}

// A picture that arrives in the few ms between the repaint timer of the pictures before it and the render that timer asked for: that render puts it in the frame in place and
// clears the arrivals, and the timer that picture started then bumped the version with nothing left to put in (the HTML only lost the "just arrived" marks): the effect took
// "nothing to patch" for "write the frame" (the owner's BUG-1: a whole mail written at +0.7 s on a busy main thread). The main thread is held for 100 ms across both timers, as the
// 3 MB of pictures of the real mail do. Each trial is a new mail (the pictures are not cached); the frame is written twice at most (StrictMode mount).
async function race(theme) {
  for (const b of [221, 229, 237]) {
    tag = `${theme} late picture ${b} ms`;
    const id = `rc${b}`;
    const img = (n, ms) => `<img src="https://h.example.net/${id}/slow/${ms}/${n}.png" width="48" height="48" alt="${n}">`;
    await evaluate(`window.__mockAddThread('${id}', 'Race ${b}', { fromName: 'Grab', fromEmail: 'news@mkt.grab.com', html: ${JSON.stringify(`<table><tr><td>${img('a', 80)} ${img('b', b)} ${img('c', 700)}</td></tr></table>`)}, auth: 'pass', autoReason: 'wrote' }); window.__store.getState().refresh().then(() => 1)`);
    await sleep(300);
    await evaluate(`window.__w0 = window.__mailFrame.writes; window.__store.getState().select('${id}'); setTimeout(() => { const e = performance.now() + 100; while (performance.now() < e); }, ${b - 10}); 1`);
    await sleep(1600);
    const writes = await evaluate('window.__mailFrame.writes - window.__w0');
    ok(await evaluate(`${DOC}.images.length`) === 3 && writes <= 2, `the frame was written at most twice (StrictMode mount) while three pictures came, the third ${b} ms in, behind a busy main thread (${writes} writes)`);
  }
}

try {
  await run('light');
  await race('light');
  await run('dark');
  await race('dark');
} catch (e) {
  failures.push(`[${tag}] ${e && e.stack ? e.stack : e}`);
  console.error(e);
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-flash-after-pictures: FAILED (${failures.length})`); process.exit(1); }
console.log(`test-flash-after-pictures: ok (${checks} checks)`);
