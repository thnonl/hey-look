#!/usr/bin/env node
// The typing area of the compose body against the signature region (1.0.14 backlog: "the signature is bigger than the empty body, clicking to type
// lands on the signature"). Checks in the dev preview (src/devMock.ts), in the main window and as the compose window, small and large, new message
// and reply (quoted original), a short and a very long signature:
//   - the block above the signature has the class sig-above (signatureBody.ts) and is at least 60% of the visible height of the body view (Compose.tsx TYPING_SHARE)
//   - the signature is shown in full (no inner scroll, no height cap); a long one is reached by scrolling the whole body view
//   - a click in the empty typing area, and on the empty box under the content, puts the caret in the paragraph above the signature
//   - typing then goes to that paragraph; the signature text is unchanged
// Engine features: class decoration, min-height, max-height + overflow-y (no :has, no clamp). The PROBE below prints JSON; the QA session can run the
// same expression through the test bridge on a real Mac / Linux window that has a signature chosen.
//   node scripts/test-compose-body-area.mjs [--require-browser] [--url=http://127.0.0.1:1420/] [--shots=<dir>]
import { arg, inputs, sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-compose-body-area', { vitePort0: 5580, cdpPort0: 9580 });
const { evaluate, cdp } = H;
const { clickAt, typeText, shot } = inputs(H, arg('shots'), 'body-area');
const failures = [];
let checks = 0;
const ok = (tag, cond, msg) => { checks++; if (!cond) { failures.push(`[${tag}] ${msg}`); console.error(`FAIL [${tag}] ${msg}`); } };

const shortSig = '<p>Linh Tran</p><p>Acme</p>';
const longSig = Array.from({ length: 40 }, (_, i) => `<p>Signature line ${i + 1}, a long signature with a lot of text</p>`).join('');
const INIT = {
  new: `{ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Hello' }`,
  reply: `{ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Re: Hello', isReply: true, inReplyTo: '<m1@x>', bodyHtml: '<p>The quoted original</p><p>second line</p>' }`,
};
const PROBE = `(() => {
  const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { t: Math.round(b.top), b: Math.round(b.bottom), l: Math.round(b.left), r: Math.round(b.right), h: Math.round(b.height) }; };
  const tip = document.querySelector('.cp-editor .tiptap'), above = tip && tip.querySelector(':scope > .sig-above'), sig = tip && tip.querySelector('.sig-block'), body = sig && sig.querySelector('.sig-body');
  return { above: r(above), aboveIsP: !!above && above.tagName === 'P', sig: r(sig), sigBody: r(body), sigBodyScrolls: !!body && body.scrollHeight > body.clientHeight + 1, ed: r(document.querySelector('.cp-editor')), view: document.querySelector('.cp-editor').clientHeight, scrollable: (() => { const e = document.querySelector('.cp-editor'); return e.scrollHeight > e.clientHeight + 1; })() };
})()`;

async function open(cfg) {
  if (cfg.mode === 'main') {
    await H.openApp('lang=en&aiset', cfg.w, cfg.h);
    await evaluate(`window.__store.getState().openCompose(${INIT[cfg.kind]}); 1`);
  } else {
    await cdp('Emulation.setDeviceMetricsOverride', { width: cfg.w, height: cfg.h, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', { url: 'about:blank' });
    await cdp('Page.navigate', { url: `${H.base}?w=compose&mock=${cfg.kind}#lang=en&aiset` });
    await sleep(600);
  }
  await evaluate(`new Promise((ok, no) => { const t0 = Date.now(), t = setInterval(() => { if (document.querySelector('.compose-pane .cp-editor .tiptap .sig-block')) { clearInterval(t); ok(1); } else if (Date.now() - t0 > 15000) { clearInterval(t); no(new Error('compose did not start')); } }, 100); })`);
  await sleep(500);
  // the chosen signature, filled into the region like Compose.tsx does (the editor ignores mutations of it)
  await evaluate(`(() => { const b = document.querySelector('.sig-block'); b.querySelector('.sig-body').innerHTML = ${JSON.stringify(cfg.sig === 'long' ? longSig : shortSig)}; b.classList.remove('none'); return 1; })()`);
  await sleep(150);
}

// which top-level block of the document the caret is in
const CARET = `(() => { const s = getSelection(), tip = document.querySelector('.cp-editor .tiptap'); if (!s.anchorNode || !tip.contains(s.anchorNode)) return { in: 'outside', focused: document.activeElement === tip }; let n = s.anchorNode; while (n.parentNode !== tip) n = n.parentNode; return { in: n.classList && n.classList.contains('sig-above') ? 'sig-above' : n.classList && n.classList.contains('sig-block') ? 'signature' : n.tagName + '.' + n.className, focused: document.activeElement === tip }; })()`;

const CFGS = [];
for (const [w, h] of [[960, 560], [1280, 720], [1920, 1080]]) for (const kind of ['new', 'reply']) for (const sig of ['short', 'long']) CFGS.push({ mode: 'main', w, h, kind, sig });
for (const [w, h] of [[560, 440], [760, 680]]) for (const kind of ['new', 'reply']) for (const sig of ['short', 'long']) CFGS.push({ mode: 'popout', w, h, kind, sig });

for (const cfg of CFGS) {
  const tag = `${cfg.mode} ${cfg.w}x${cfg.h} ${cfg.kind} ${cfg.sig}-sig`;
  try { await open(cfg); } catch (e) { ok(tag, false, String(e)); continue; }
  const m = await evaluate(PROBE);
  console.log(tag, JSON.stringify({ above: m.above?.h, sig: m.sig?.h, sigBody: m.sigBody?.h, view: m.view }));
  ok(tag, m.aboveIsP, 'the paragraph above the signature has no sig-above class');
  ok(tag, m.above && m.above.h >= Math.floor(m.view * 0.6) - 1, `the typing area is ${m.above?.h} px, not at least 60% of the ${m.view} px view`);
  ok(tag, !m.sigBodyScrolls, 'the signature has an inner scroll');
  ok(tag, m.sigBody && m.sigBody.h >= 40, `the signature body is only ${m.sigBody?.h} px`);
  if (cfg.sig === 'long') {
    ok(tag, m.sigBody.h > 600, `a 40-line signature is cut at ${m.sigBody.h} px`);
    ok(tag, m.scrollable, 'the body view does not scroll for a long signature');
    const end = await evaluate(`(() => { const e = document.querySelector('.cp-editor'); e.scrollTop = e.scrollHeight; const sb = document.querySelector('.sig-body p:last-child').getBoundingClientRect(), v = e.getBoundingClientRect(); return sb.bottom <= v.bottom + 1 && sb.top >= v.top - 1; })()`);
    ok(tag, end, 'the last line of a long signature cannot be scrolled into view');
  }
  // a click in the empty typing area (its lower part)
  await evaluate(`document.querySelector('.cp-editor').scrollTop = 0; 1`);
  const a = (await evaluate(PROBE)).above;
  const y = Math.min(a.b - 10, m.ed.b - 8), x = Math.round((a.l + a.r) / 2);
  await evaluate(`document.activeElement && document.activeElement.blur(); 1`);
  await clickAt(x, y); await sleep(120);
  let c = await evaluate(CARET);
  ok(tag, c.in === 'sig-above' && c.focused, `a click in the empty typing area puts the caret in ${JSON.stringify(c)}`);
  // the empty box under the content (only when the pane is taller than the content)
  const m2 = await evaluate(PROBE);
  const lastBottom = await evaluate(`(() => { const k = [...document.querySelector('.cp-editor .tiptap').children].pop(); return Math.round(k.getBoundingClientRect().bottom); })()`);
  if (lastBottom + 12 < m2.ed.b - 4) {
    await evaluate(`document.activeElement.blur(); 1`);
    await clickAt(x, lastBottom + 8); await sleep(120);
    c = await evaluate(CARET);
    ok(tag, c.in === 'sig-above' && c.focused, `a click on the empty box under the content puts the caret in ${JSON.stringify(c)}`);
  }
  // typing goes to the paragraph above the signature; the signature is not touched
  await evaluate(`document.activeElement.blur(); 1`);
  await clickAt(x, y); await sleep(100);
  await typeText('Hi', 5); await sleep(100);
  const res = await evaluate(`(() => { const tip = document.querySelector('.cp-editor .tiptap'), a = tip.querySelector(':scope > .sig-above'); return { above: a && a.textContent, sig: tip.querySelector('.sig-body').textContent.slice(0, 13) }; })()`);
  ok(tag, res.above === 'Hi', `typed text went to: ${JSON.stringify(res)}`);
  ok(tag, res.sig === (cfg.sig === 'long' ? 'Signature lin' : 'Linh TranAcme'), `the signature changed: ${JSON.stringify(res)}`);
  if (cfg.w === 960 || cfg.mode === 'popout') await shot(tag.replace(/\W+/g, '-'));
}

// 60% is a minimum: a long body (about 80 lines, typed or pasted) grows the typing area past the view; no inner scroll, no clipping, the
// signature sits right below the last body line, and the whole editor scrolls as one so the last line and the signature can be reached
for (const cfg of [{ mode: 'main', w: 1280, h: 720, kind: 'new', sig: 'short' }, { mode: 'main', w: 960, h: 560, kind: 'reply', sig: 'long' }, { mode: 'popout', w: 760, h: 680, kind: 'new', sig: 'short' }]) {
  const tag = `long-body ${cfg.mode} ${cfg.w}x${cfg.h} ${cfg.kind} ${cfg.sig}-sig`;
  try { await open(cfg); } catch (e) { ok(tag, false, String(e)); continue; }
  const a0 = (await evaluate(PROBE)).above;
  await clickAt(Math.round((a0.l + a0.r) / 2), a0.t + 8); await sleep(120);
  const lines = Array.from({ length: 80 }, (_, i) => `<p>Body line ${i + 1}</p>`).join('');
  await evaluate(`document.execCommand('insertHTML', false, ${JSON.stringify(lines)}); 1`);
  await sleep(300);
  const g = await evaluate(`(() => {
    const e = document.querySelector('.cp-editor'), tip = e.querySelector('.tiptap'), sig = tip.querySelector('.sig-block'), above = tip.querySelector(':scope > .sig-above');
    const ps = [...tip.children].filter((k) => k !== sig && !k.closest('.sig-block')), lastBody = [...tip.querySelectorAll(':scope > p')].filter((p) => /^Body line/.test(p.textContent)).pop();
    const lb = lastBody && lastBody.getBoundingClientRect(), sb = sig.getBoundingClientRect();
    const total = [...tip.querySelectorAll(':scope > p')].filter((p) => /^Body line/.test(p.textContent)).length;
    e.scrollTop = e.scrollHeight;
    const v = e.getBoundingClientRect(), lb2 = lastBody.getBoundingClientRect(), sb2 = sig.getBoundingClientRect();
    return { view: e.clientHeight, lines: total, bodyBlocks: ps.length, scrollable: e.scrollHeight > e.clientHeight + 1, gap: Math.round(sb.top - lb.bottom), sigBottomReach: sb2.bottom <= v.bottom + 1, lastLineReach: lb2.top >= v.top - 1 && lb2.bottom <= v.bottom + 1 };
  })()`);
  const sc = await evaluate(`(() => { const tip = document.querySelector('.cp-editor .tiptap'); const above = tip.querySelector(':scope > .sig-above'); const bodyEls = [...tip.querySelectorAll(':scope > p')]; const h = bodyEls.reduce((a, p) => a + p.getBoundingClientRect().height, 0); return { bodyH: Math.round(h), tipScrolls: tip.scrollHeight > tip.clientHeight + 1, edScrolls: document.querySelector('.cp-editor').scrollHeight > document.querySelector('.cp-editor').clientHeight + 1 }; })()`);
  console.log(tag, JSON.stringify({ ...g, ...sc }));
  ok(tag, g.lines >= 80, `only ${g.lines} of 80 body lines were inserted`);
  ok(tag, sc.bodyH > g.view, `the body text is ${sc.bodyH} px, not past the ${g.view} px view`);
  ok(tag, !sc.tipScrolls, 'the body block has an inner scroll (scrollHeight > clientHeight)');
  ok(tag, g.scrollable, 'the editor does not scroll for a long body');
  ok(tag, g.gap >= 0 && g.gap <= 60, `the signature is ${g.gap} px below the last body line`);
  ok(tag, g.lastLineReach || g.sigBottomReach, 'neither the last body line nor the signature is reachable by scrolling');
  ok(tag, g.sigBottomReach, 'the signature bottom cannot be scrolled into view');
  const lr = await evaluate(`(() => { const e = document.querySelector('.cp-editor'); e.scrollTop = 0; return 1; })()`);
  const last = await evaluate(`(() => { const e = document.querySelector('.cp-editor'); const p = [...e.querySelectorAll('.tiptap > p')].filter((q) => /^Body line 80$/.test(q.textContent))[0]; p.scrollIntoView({ block: 'nearest' }); const b = p.getBoundingClientRect(), v = e.getBoundingClientRect(); return b.top >= v.top - 1 && b.bottom <= v.bottom + 1; })()`);
  ok(tag, last, 'the last body line cannot be scrolled into view');
}

await H.shutdown();
console.log(`${checks} checks, ${failures.length} failures`);
process.exit(failures.length ? 1 : 0);
