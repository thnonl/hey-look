#!/usr/bin/env node
// 1.0.7 W13.6 (REQ-13.6.1 to 13.6.6, AC-13.6.1 to 13.6.6): "Opening message…" while a mail opens. Real list, reading pane and reader window in the dev preview (src/devMock.ts: `window.__mockDelays.thread`
// makes the read of the conversation take that long, `#threaddelay=` does it for a page that is loaded with it; the fixtures are made in the page: scripts/lib/reply-fixtures.mjs). The probe is
// scripts/lib/open-mail-probe.mjs (the same one the Mac and Linux sessions run through the test bridge):
//   - a slow read (500 ms): the status block (role=status, aria-busy, ring + dots, "Opening message…") is on screen within 150 ms of the click and ends when the mail's frame is visible; the subject stays
//     where it is (no layout shift), the body area does not scroll, the list does;
//   - a quick read (no delay, a 20 KB mail): the status never shows (no flash); once shown it stays at least 300 ms (RULE-2);
//   - a heavy mail (500 KB / 2 MB): the status is on screen BEFORE the cleaning of the HTML starts (RULE-4: paint first), and no long task is over 200 ms;
//   - a newer selection replaces it at once (the heavy mail, then a small one: no status left behind); a second open of the same mail is quicker (the cleaned HTML is kept);
//   - reduced motion: the dots instead of the ring; the reader window shows the status until the frame is visible, never a blank body;
//   - the show / hide rule as a table (src/statusHold.ts), the 20 s safety end and the wiring as source guards.
//   node scripts/test-open-loading.mjs [--require-browser]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, arg, sleep, startHarness } from './cdp-harness.mjs';
import { CALIBRATE } from './lib/reply-open-probe.mjs';
import { FIXTURES, IDS } from './lib/reply-fixtures.mjs';
import { PROBE_INSTALL, PROBE_PRESS, PROBE_READ, fill } from './lib/open-mail-probe.mjs';

const H = await startHarness('test-open-loading', { vitePort0: 5300 });
const { evaluate, cdp } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); } };
const fn = (body) => `(() => { ${body} })()`;
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between two renders */ } await sleep(40); } return false; };
/** Opens `id` with the read taking `thread` ms and returns what the probe saw. */
const open = async (id, thread, settle = 700) => {
  await evaluate(`window.__store.getState().select(null); window.__mockDelays = { thread: ${thread} }; 1`);
  await sleep(500);
  await evaluate(fn(PROBE_INSTALL));
  await evaluate(fn(fill(PROBE_PRESS, id)));
  assert.ok(await waitFor(`window.__openMail.frame !== null`, 30000), `the frame of ${id} never showed`);
  await sleep(settle);
  const r = await evaluate(fn(PROBE_READ));
  await evaluate(`window.__openMail.stop(); 1`);
  return r;
};

// How fast this page runs (the median of CALIBRATE, never below 1, at most 8, like scripts/test-reply-feedback.mjs): the status timer (100 ms) and the render that follows it take that much longer on a slow
// runner, so a read that must be clearly slower than the timer is sized by it. `--throttle=N` tries a slow computer (CDP CPU throttling): only the RULE-2 case sizes itself by the scale (it passes at 4x); the other cases keep their fixed budgets, which are for a normal computer.
const CPU_REF = 48;
let scale = 1;

try {
  if (arg('throttle')) await cdp('Emulation.setCPUThrottlingRate', { rate: Number(arg('throttle')) });
  await H.openApp('lang=en', 1280, 800);
  scale = Math.min(Math.max(1, (await evaluate(CALIBRATE)).cpu / CPU_REF), 8);
  console.log(`test-open-loading: scale ${scale.toFixed(2)}`);
  await evaluate(FIXTURES);
  await evaluate(`window.__store.getState().refresh().then(() => 1)`);
  await evaluate(`window.__store.getState().setView('inbox', window.__store.getState().accounts[0].id); 1`);
  await sleep(500);

  await check('a slow read: the status is up within 150 ms, has the right shape, and ends when the frame is visible (AC-13.6.2)', async () => {
    const r = await open(IDS.small, 500);
    // (100 ms timer + render; the dev build is slower than the 150 ms of the release, which the kit probe measures)
    assert.ok(r.statusMs !== null && r.statusMs >= 90 && r.statusMs <= 220, `statusMs ${r.statusMs}`);
    assert.equal(r.statusText.replace(/[·\s]+/g, ' ').trim(), 'Opening message…');
    assert.equal(r.statusBusy, true, 'role=status + aria-busy while it works');
    assert.ok(r.frameMs >= 500, `the frame came at ${r.frameMs}, after the read`);
    assert.ok(r.statusGoneMs !== null && r.statusGoneMs >= r.frameMs && r.statusGoneMs - r.frameMs < 400, `statusGoneMs ${r.statusGoneMs} vs frame ${r.frameMs}`);
    assert.equal(r.statusLeft, false, 'nothing left behind');
    assert.equal(r.bodyOpening, true, 'the body area does not scroll while the block covers it');
    assert.deepEqual(r.headBox, r.headAfter, 'the subject did not move (RULE-6)');
  });

  await check('the status stays at least 300 ms once shown (RULE-2)', async () => {
    // a read clearly slower than the 100 ms timer on this machine (not a boundary race: 150 ms against the timer), but quicker than the status's own 300 ms, so that the minimum is what keeps it up
    const read = Math.round(100 * scale + 160);
    const r = await open(IDS.small, read, 700 + Math.round(400 * scale));
    assert.ok(r.statusMs !== null, `a ${read} ms read shows the status (the frame came at ${r.frameMs})`);
    assert.ok(r.frameMs >= read, `the frame came at ${r.frameMs}, before the ${read} ms read was over`);
    assert.ok(r.statusGoneMs !== null && r.statusGoneMs - r.statusMs >= 290, `shown from ${r.statusMs} to ${r.statusGoneMs}: ${r.statusGoneMs - r.statusMs} ms (the frame at ${r.frameMs})`);
  });

  await check('a quick read never shows it (AC-13.6.1)', async () => {
    const r = await open(IDS.small, 0);
    assert.ok(r.statusMs === null || r.frameMs > 100, `the status flashed (frame at ${r.frameMs})`);
    assert.ok(r.frameMs !== null && r.frameMs < 500, `frameMs ${r.frameMs}`);
    const p = await open(IDS.plain, 0);
    assert.ok(p.statusMs === null || p.frameMs > 100, `a plain text mail that was there at ${p.frameMs} ms flashed the status at ${p.statusMs}`);
  });

  await check('the list scrolls while it opens (AC-13.6.2)', async () => {
    await evaluate(`window.__store.getState().select(null); window.__mockDelays = { thread: 800 }; document.querySelector('.ml-body').scrollTop = 0; window.__store.getState().select(${JSON.stringify(IDS.small)}); 1`);
    await sleep(300);
    assert.equal(await evaluate(`!!document.querySelector('.rp-opening')`), true, 'the status is up');
    await evaluate(`document.querySelector('.ml-body').scrollTop = 120; 1`);
    await sleep(100);
    assert.ok((await evaluate(`document.querySelector('.ml-body').scrollTop`)) > 50, 'the list did not scroll');
    assert.equal(await evaluate(`(() => { const b = document.querySelector('.rp-body'); return getComputedStyle(b).overflowY; })()`), 'hidden');
    await waitFor(`!document.querySelector('.rp-opening')`, 5000);
  });

  await check('a heavy mail: the status is up before the HTML is cleaned (paint first), the wait of the page stays short, the cleaned HTML is kept (RULE-4)', async () => {
    const r = await open(IDS.big, 0);
    assert.ok(r.statusMs !== null, 'a 500 KB mail shows the status at once');
    assert.ok(r.marks.cleanAt !== null && r.statusMs <= r.marks.cleanAt, `the status (${r.statusMs}) is not before the cleaning (${r.marks.cleanAt})`);
    assert.ok(r.longTaskMax === null || r.longTaskMax < 200, `a long task of ${r.longTaskMax} ms`);
    assert.ok(r.gapMax < 400, `the page waited ${r.gapMax} ms`);
    const h = await open(IDS.huge, 0);
    assert.ok(h.statusMs !== null && h.statusMs <= h.marks.cleanAt, `2 MB: status ${h.statusMs}, cleaning ${h.marks.cleanAt}`);
    assert.ok(h.longTaskMax === null || h.longTaskMax < 300, `2 MB: a long task of ${h.longTaskMax} ms`); // (RULE-4 says 200 ms on the release exe; the dev build is unoptimised, the kit probe measures the exe)
    // the second time the cleaned HTML is there: no cleaning (the frame itself still has to load and measure)
    const again = await open(IDS.huge, 0);
    assert.equal(again.marks.cleanMs, null, 'the cleaning ran again');
  });

  await check('a newer selection replaces it: the big mail, then at once a small one, leaves no status behind (AC-13.6.4)', async () => {
    await evaluate(`window.__store.getState().select(null); window.__mockDelays = { thread: 400 }; 1`);
    await sleep(400);
    await evaluate(`window.__store.getState().select(${JSON.stringify(IDS.huge)}); 1`);
    await sleep(250); // (the status of the big one is up)
    await evaluate(`window.__mockDelays = { thread: 0 }; window.__store.getState().select(${JSON.stringify(IDS.att)}); 1`);
    assert.ok(await waitFor(`!!document.querySelector('.rp-msg.open .msg-frame') && getComputedStyle(document.querySelector('.rp-msg.open .msg-frame')).visibility !== 'hidden'`, 8000), 'the small mail did not show');
    await sleep(700);
    assert.equal(await evaluate(`!!document.querySelector('.rp-opening')`), false, 'a status was left behind');
    assert.equal(await evaluate(`window.__store.getState().selected`), IDS.att);
    assert.match(await evaluate(`document.querySelector('.rp-head h2').textContent`), /three attachments/i);
  });

  await check('a read that fails ends the status at once and says why (RULE-5), it does not wait for the safety end', async () => {
    await evaluate(`window.__store.getState().select(null); window.__mockDelays = { thread: 300, threadFail: true }; 1`);
    await sleep(300);
    const tl = await evaluate(`new Promise((ok) => { const t0 = performance.now(); const out = { status: null, gone: null, toast: null }; window.__store.getState().select(${JSON.stringify(IDS.small)}); const iv = setInterval(() => { const t = Math.round(performance.now() - t0); const s = !!document.querySelector('.rp-opening'); if (s && out.status === null) out.status = t; if (out.status !== null && !s && out.gone === null) out.gone = t; if (out.toast === null && [...document.querySelectorAll('.toasts .toast.error')].some((e) => /could not be read/.test(e.textContent))) out.toast = t; if (t > 2500) { clearInterval(iv); ok(out); } }, 15); })`);
    await evaluate(`window.__mockDelays = {}; 1`);
    assert.ok(tl.toast !== null && tl.toast >= 280 && tl.toast < 700, `the error toast at ${tl.toast}`);
    assert.ok(tl.status !== null && tl.gone !== null && tl.gone < 1500, `the status was up from ${tl.status} to ${tl.gone}: it must end with the error, not at 20 s`);
  });

  await check('reduced motion: the dots, not the ring (AC-13.6.6)', async () => {
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await evaluate(`window.__store.getState().select(null); window.__mockDelays = { thread: 900 }; window.__store.getState().select(${JSON.stringify(IDS.small)}); 1`);
    await sleep(350);
    const css = await evaluate(`(() => { const b = document.querySelector('.rp-opening'); if (!b) return null; return { ring: getComputedStyle(b.querySelector('.busy-ring')).display, dots: getComputedStyle(b.querySelector('.busy-dots')).display, role: b.getAttribute('role') }; })()`);
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    assert.deepEqual(css && [css.ring, css.dots !== 'none', css.role], ['none', true, 'status'], JSON.stringify(css));
    await waitFor(`!document.querySelector('.rp-opening')`, 5000);
  });

  await check('dark theme: the block uses the pane colours (readable)', async () => {
    await evaluate(`window.__store.getState().setPrefs({ theme: 'dark' }); window.__store.getState().select(null); window.__mockDelays = { thread: 900 }; window.__store.getState().select(${JSON.stringify(IDS.small)}); 1`);
    await sleep(350);
    const c = await evaluate(`(() => { const b = document.querySelector('.rp-opening'); if (!b) return null; const bg = getComputedStyle(b).backgroundColor, pane = getComputedStyle(document.querySelector('.reading-pane')).backgroundColor; const fg = getComputedStyle(b.querySelector('p')).color; return { bg, pane, fg }; })()`);
    assert.ok(c, 'no status');
    assert.notEqual(c.bg, c.fg, 'text differs from the block');
    assert.ok(c.bg !== 'rgba(0, 0, 0, 0)', 'the block covers what is under it');
    await evaluate(`window.__store.getState().setPrefs({ theme: 'light' }); 1`);
    await waitFor(`!document.querySelector('.rp-opening')`, 5000);
  });

  // ---- the reader window: the status is there from the start until the frame is visible; there is never a blank body (AC-13.6.3)
  await check('the reader window shows "Opening message…" until the frame of the mail is visible, with no blank moment (AC-13.6.3)', async () => {
    await cdp('Page.navigate', { url: 'about:blank' });
    await cdp('Page.navigate', { url: `${H.base}?w=reader&thread=nl1#lang=en&threaddelay=700` });
    await evaluate(`new Promise((ok) => { const t0 = Date.now(); const t = setInterval(() => { if (document.querySelector('.reader-win') || Date.now() - t0 > 15000) { clearInterval(t); ok(1); } }, 20); })`);
    const seen = await evaluate(`new Promise((ok) => {
      const out = { samples: 0, blank: 0, status: 0, frame: 0, texts: new Set() };
      const t0 = Date.now();
      const iv = setInterval(() => {
        out.samples++;
        const st = document.querySelector('.reader-state[role=status], .rp-opening');
        const f = document.querySelector('.rp-msg.open .msg-frame');
        const shown = f && getComputedStyle(f).visibility !== 'hidden';
        if (st) { out.status++; out.texts.add(st.textContent.replace(/[·\\s]+/g, ' ').trim()); }
        if (shown) out.frame++;
        if (!st && !shown && document.querySelector('.rp-body') && out.frame === 0 && Date.now() - t0 > 100) out.blank++;
        if (out.frame > 10 || Date.now() - t0 > 12000) { clearInterval(iv); out.texts = [...out.texts]; ok(out); }
      }, 15);
    })`);
    assert.ok(seen.frame > 0, 'the mail never showed');
    assert.ok(seen.status > 10, `the status was seen only ${seen.status} times`);
    assert.deepEqual(seen.texts, ['Opening message…']);
    assert.equal(seen.blank, 0, `${seen.blank} samples had a body with neither the status nor the mail`);
  });
} finally {
  await H.shutdown();
}

// ---- the rule as a table, the safety end and the wiring
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
await check('the wiring: delay, minimum, safety end, paint first, the cleaned-HTML cache, the keyed block', async () => {
  const s = read('src/openStatus.tsx');
  assert.ok(/OPEN_SAFETY_MS = 20_000/.test(s) && /setGaveUp\(true\)/.test(s), 'the 20 s safety end (RULE-5)');
  assert.ok(/HEAVY_HTML = 120_000/.test(s), 'the heavy threshold');
  assert.ok(/after = 100, min = 300/.test(s), 'the pane: 100 ms, 300 ms');
  const rp = read('src/components/ReadingPane.tsx');
  assert.ok(/<RpBody key=\{selected\} pending=\{opening\}/.test(rp), 'the block is keyed by the conversation: a newer selection replaces it at once');
  assert.ok(/<AfterPaint wait=\{isHeavy\(m\) && !isCleaned\(m,/.test(rp) && /requestAnimationFrame\(\(\) => setTimeout\(fin, 0\)\)/.test(rp), 'heavy HTML is cleaned after the paint');
  assert.ok(/CLEANED_MAX = 20/.test(rp), 'the last 20 cleaned bodies are kept');
  assert.ok(/announceFrame\(frame, m\.id\)/.test(rp), 'the first measurement ends the status');
  const reader = read('src/popout/ReaderView.tsx');
  assert.ok(/<RpBody pending=\{opening\} heavy=\{isHeavy\(last\)\} after=\{0\} min=\{0\}/.test(reader), 'the reader window keeps the status until the frame is visible');
  const st = read('src/store.ts');
  assert.ok(/hlMark\("open:thread:start"\)/.test(st), 'the read of the conversation is marked');
  // the marks cost nothing without the switch
  assert.ok(/if \(\(window as unknown as \{ __hlMarks\?: boolean \}\)\.__hlMarks\) performance\.mark\(name\)/.test(read('src/perfMarks.ts')));
});

if (failures.length) { console.error(`test-open-loading: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-open-loading: ok');
