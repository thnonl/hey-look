#!/usr/bin/env node
// 1.0.11: a mail whose <img> has BOTH src and srcset (an airline newsletter, scripts/fixtures/newsletter-srcset.html) showed broken pictures after "Show pictures" / "Always show" / "Show all":
// the webview prefers srcset to src, so it fetched the remote candidates itself while the CSP (img-src data:) refused. Now no picture keeps a srcset (nor sizes), no <source> of a <picture> is left (but a dark-mode one, media with prefers-color-scheme, keeps ONE data: address: S5),
// and a picture with a srcset only is blocked and fetched through the backend by its first candidate. Checked in the dev preview (src/devMock.ts: fetches are `window.__remoteFetchCalls`).
//   S1 sanitizeHtml blocked / allowed on the fixture      S2 the box and "Show this picture" for each picture     S3 "Show pictures" (link)     S4 "Show all pictures in this message"
//   node scripts/test-picture-srcset-ui.mjs [--require-browser | --url=http://127.0.0.1:1420/]
import { readFileSync } from 'node:fs';
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-picture-srcset-ui', { vitePort0: 5760 });
H.net.stub = (url) => (/\.(png|jpg)$/.test(url) ? { status: 200, type: 'image/png', body: '' } : undefined);
const { evaluate, cdp } = H;
const failures = [];
let checks = 0;
let tag = '';
const ok = (c, m) => { checks++; if (!c) { failures.push(`[${tag}] ${m}`); console.error('FAIL', `[${tag}] ${m}`); } return !!c; };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const until = async (expr, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { let v = false; try { v = await evaluate(expr); } catch { /* between renders */ } if (v) return true; await sleep(40); } return false; };
const mouse = async (x, y, button = 'left') => {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: button === 'left' ? 1 : 2, clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 });
};

const MAIL = readFileSync(new URL('./fixtures/newsletter-srcset.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const ADDR = ['http://news.example.test/img/logo.png', 'https://news.example.test/img/top.jpg', 'https://news.example.test/img/wide.png', 'https://news.example.test/img/only.png'];
const FR = `document.querySelector('.rp-msg.open iframe.msg-frame')`;
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
// what the frame holds: every srcset / sizes / <source>, the pictures that show, the boxes
const frame = () => evaluate(`(() => { const d = ${FR}?.contentDocument; if (!d) return null; const imgs = [...d.querySelectorAll('img')]; return { srcsets: d.querySelectorAll('[srcset]').length, sizes: d.querySelectorAll('[sizes]').length, sources: d.querySelectorAll('source').length, boxes: d.querySelectorAll('.hl-bp[data-hl-pic]').length, shown: imgs.filter((i) => (i.getAttribute('src') || '').startsWith('data:image')).length, imgs: imgs.length, remoteSrc: imgs.filter((i) => /^(https?:)?\\/\\//.test(i.getAttribute('src') || '')).length }; })()`);
const calls = () => evaluate(`JSON.stringify(window.__remoteFetchCalls || [])`).then((s) => JSON.parse(s).flat());
const boxPoint = (i) => evaluate(`(() => { const f = ${FR}, d = f.contentDocument, b = d.querySelectorAll('.hl-bp[data-hl-pic]')[${i}]; b.scrollIntoView({ block: 'center' }); const q = b.getBoundingClientRect(), fr = f.getBoundingClientRect(); return [fr.left + q.left + Math.min(q.width / 2, 40), fr.top + q.top + Math.min(q.height / 2, 20)]; })()`);
const menuOpen = () => until(`!!document.querySelector('.ctx-menu [role=menuitem]')`, 3000);
const chooseRow = (startsWith) => evaluate(`(() => { const r = [...document.querySelectorAll('.ctx-menu [role=menuitem]')].find((e) => e.textContent.trim().startsWith(${JSON.stringify(startsWith)})); if (!r) return false; r.click(); return true; })()`);
const clickLink = (sel) => evaluate(`(() => { const b = document.querySelector('.rp-msg.open .notice ${sel}'); if (!b) return false; b.click(); return true; })()`);

try {
  await H.openApp('light&lang=en&nativemenu=off', 1280, 800);
  await evaluate(`window.__mockAddThread('sr1', 'Newsletter srcset', { fromName: 'Airline', fromEmail: 'news@airline.example', html: ${JSON.stringify(MAIL)}, auth: 'pass' }); window.__store.getState().setPrefs({ loadRemote: false }); window.__store.getState().refresh().then(() => 1)`);
  await sleep(300);

  // ======================================================================== S1: sanitizeHtml
  tag = 'sanitize';
  const san = await evaluate(`import('/src/util.ts').then((m) => { const f = (allow) => { const r = m.sanitizeHtml(${JSON.stringify(MAIL)}, allow); const d = new DOMParser().parseFromString(r.html, 'text/html'); return { blocked: r.blocked, srcsets: d.querySelectorAll('[srcset]').length, sizes: d.querySelectorAll('[sizes]').length, hl: [...d.querySelectorAll('img[data-hl-src]')].map((i) => i.getAttribute('data-hl-src')), srcs: [...d.querySelectorAll('img')].map((i) => i.getAttribute('src')) }; }; return JSON.stringify({ blocked: f(false), allowed: f(true) }); })`).then(JSON.parse);
  eq(san.blocked.srcsets + san.blocked.sizes, 0, 'blocked: no srcset / sizes left (leading white space or not)');
  eq(san.blocked.hl, ADDR, 'blocked: every picture, also the one with a srcset only (first candidate, // made https), keeps its address for "Show this picture"');
  eq(san.blocked.srcs, [null, null, null, null], 'blocked: no img keeps a remote src');
  ok(san.blocked.blocked >= 4, `blocked: counted (${san.blocked.blocked})`);
  eq(san.allowed.srcsets + san.allowed.sizes, 0, 'allowed: no srcset / sizes left');
  eq(san.allowed.srcs, ADDR, 'allowed: the src stays, the srcset-only picture takes its first candidate as src');

  // ======================================================================== S2: boxes and "Show this picture"
  tag = 'show-one';
  await open('sr1');
  let f = await frame();
  eq([f.boxes, f.shown, f.srcsets, f.sizes], [4, 0, 0, 0], `blocked: four boxes, nothing shown, nothing with srcset (${JSON.stringify(f)})`);
  for (const i of [3, 0]) {
    const [x, y] = await boxPoint(i);
    await mouse(x, y, 'right');
    await menuOpen();
    ok(await chooseRow('Show this picture'), `box ${i}: the entry is there`);
    ok(await until(`${FR}.contentDocument.querySelectorAll('img[src^="data:image"]').length === ${i === 3 ? 1 : 2}`, 4000), `box ${i}: the picture shows`);
  }
  f = await frame();
  eq([f.shown, f.boxes, f.srcsets, f.sizes, f.sources, f.remoteSrc], [2, 2, 0, 0, 0, 0], `two shown one by one, no srcset, no <source> (${JSON.stringify(f)})`);
  eq((await calls()).sort(), [ADDR[0], ADDR[3]].sort(), 'only the two addresses asked for were fetched, by their first candidate');

  // ======================================================================== S3: the "Show pictures" link
  tag = 'show-link';
  await open('sr1');
  ok(await clickLink('button.link:not([data-trust])'), 'the link is there');
  ok(await until(`${FR}.contentDocument.querySelectorAll('img[src^="data:image"]').length === 4`, 6000), 'all four pictures show');
  f = await frame();
  eq([f.shown, f.boxes, f.srcsets, f.sizes, f.sources, f.remoteSrc], [4, 0, 0, 0, 0, 0], `Show pictures: data: sources only, no srcset, no sizes, no <source> (${JSON.stringify(f)})`);
  eq((await calls()).slice().sort(), [ADDR[1], ADDR[2]].sort(), 'the two addresses not shown before were fetched through the backend, the other two came from the cache');

  // ======================================================================== S4: "Show all pictures in this message"
  tag = 'show-all';
  await open('sr1');
  const [x, y] = await boxPoint(1);
  await mouse(x, y, 'right');
  await menuOpen();
  ok(await chooseRow('Show all pictures in this message'), 'the entry is there');
  ok(await until(`${FR}.contentDocument.querySelectorAll('img[src^="data:image"]').length === 4`, 6000), 'Show all: all four pictures show');
  f = await frame();
  eq([f.shown, f.boxes, f.srcsets, f.sizes, f.sources, f.remoteSrc], [4, 0, 0, 0, 0, 0], `Show all: data: sources only, no srcset (${JSON.stringify(f)})`);
  // ======================================================================== S5: a dark-mode logo (<source media="(prefers-color-scheme: dark)">) keeps ONE data: address
  tag = 'dark-source';
  const DARK = '<p>logo</p><picture><source media="(prefers-color-scheme: dark)" srcset=" https://news.example.test/img/dark.png 1x, https://news.example.test/img/dark_2x.png 2x" sizes="100px"><source media="(min-width: 400px)" srcset="https://news.example.test/img/wide2.png"><img alt="Logo" width="120" height="40" src="https://news.example.test/img/light.png"></picture>';
  await evaluate(`window.__mockAddThread('sr2', 'Newsletter dark logo', { fromName: 'Shop', fromEmail: 'news@shop.example', html: ${JSON.stringify(DARK)}, auth: 'pass' }); window.__store.getState().refresh().then(() => 1)`);
  await sleep(300);
  const sanD = await evaluate(`import('/src/util.ts').then((m) => { const f = (allow) => { const d = new DOMParser().parseFromString(m.sanitizeHtml(${JSON.stringify(DARK)}, allow).html, 'text/html'); return [...d.querySelectorAll('source')].map((e) => [e.getAttribute('media'), e.getAttribute('srcset'), e.hasAttribute('sizes')]); }; return JSON.stringify({ blocked: f(false), allowed: f(true) }); })`).then((x) => JSON.parse(x));
  eq(sanD.blocked, [['(prefers-color-scheme: dark)', null, false], ['(min-width: 400px)', null, false]], 'sanitize blocked: no remote srcset on a source');
  eq(sanD.allowed, [['(prefers-color-scheme: dark)', 'https://news.example.test/img/dark.png', false], ['(min-width: 400px)', null, false]], 'sanitize allowed: one address, no descriptor, no sizes on the dark source; no srcset on any other');
  await open('sr2');
  const srcState = () => evaluate(`JSON.stringify([...${FR}.contentDocument.querySelectorAll('source')].map((e) => [e.getAttribute('data-hm-orig-media') || e.getAttribute('media'), (e.getAttribute('srcset') || '').slice(0, 10)]))`).then((x) => JSON.parse(x));
  eq((await srcState()).length, 0, 'blocked: no <source> in the frame (nothing the webview could pick and the CSP refuse)');
  ok(await clickLink('button.link:not([data-trust])'), 'S5: the Show pictures link is there');
  ok(await until(`${FR}.contentDocument.querySelectorAll('img[src^="data:image"]').length === 1`, 6000), 'S5: the picture shows');
  ok(await until(`${FR}.contentDocument.querySelectorAll('source').length === 1`, 3000), 'S5: one <source> is left');
  eq(await srcState(), [['(prefers-color-scheme: dark)', 'data:image']], 'shown: the dark source is kept with the data: address of the fetched picture, the width source is dropped');
  ok((await calls()).includes('https://news.example.test/img/dark.png'), 'the dark logo was fetched through the backend');
} catch (e) {
  failures.push(`[${tag}] ${e && e.stack ? e.stack : e}`);
  console.error(e);
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-picture-srcset-ui: FAILED (${failures.length})`); process.exit(1); }
console.log(`test-picture-srcset-ui: ok (${checks} checks)`);
process.exit(0);
