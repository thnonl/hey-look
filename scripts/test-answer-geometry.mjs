#!/usr/bin/env node
// Reply, Reply all and Forward: nothing moves between the shell and the filled message (W13.13, D-067: on Linux the To box went from w564@x382 to w870@x76 when the message was filled in, because the list column
// glided away AFTER the shell was drawn). A page sampler records, on every animation frame from the press to 500 ms after the fill, the boxes of the pane, the To row, the Subject row, the body and the
// Send button; every frame must be within 1 px of the final one (x, y, width, height). Real list, pane and compose in the dev preview (the mock backend, scripts/lib/reply-fixtures.mjs), and the compose
// window (?w=compose) with a shell and a handed-over message; 960 x 560 and 1280 x 800.
// One thing is allowed to appear at the fill: the security strip of a person who has an OpenPGP key ("Encrypt turned itself off: no key for ..."), which depends on the recipients and so cannot be
// known by the shell; its height is taken out of the boxes below it before they are compared.
//   node scripts/test-answer-geometry.mjs [--require-browser]
import assert from 'node:assert/strict';
import { sleep, startHarness } from './cdp-harness.mjs';
import { FIXTURES, IDS } from './lib/reply-fixtures.mjs';

const H = await startHarness('test-answer-geometry', { vitePort0: 5845 });
const { evaluate, cdp } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); console.error('FAIL', failures.at(-1).slice(0, 700)); } };
const waitFor = async (js, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between two renders */ } await sleep(30); } return false; };

const SAMPLER = `(() => {
  const rect = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; };
  window.__geo = { frames: [], stop: false };
  const tick = () => {
    if (window.__geo.stop) return;
    const p = document.querySelector('.compose-pane');
    if (p) window.__geo.frames.push({ t: performance.now(), prep: p.classList.contains('preparing'), pane: rect(p), to: rect(p.querySelector('.cf-field.rcpt')), subject: rect(p.querySelector('.cf-subject')), fmt: rect(p.querySelector('.cp-fmt')), head: rect(p.querySelector('.cp-head')), sec: p.querySelector('.sec-strip')?.getBoundingClientRect().height ?? 0, body: rect(p.querySelector('.cp-editor')), send: rect(p.querySelector('.split-btn .btn.primary')) });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return 1;
})()`;

/** The worst distance (px) of any frame from the last one, per box; and how many frames were shell frames. */
async function moved() {
  await evaluate('window.__geo.stop = true; 1');
  return evaluate(`(() => {
    const f = window.__geo.frames.map((x) => ({ ...x, head: x.head && [x.head[0], x.head[1], x.head[2], x.head[3] - x.sec], fmt: x.fmt && [x.fmt[0], x.fmt[1] - x.sec, x.fmt[2], x.fmt[3]], body: x.body && [x.body[0], x.body[1] - x.sec, x.body[2], x.body[3] + x.sec] })); const last = f[f.length - 1]; const worst = {};
    for (const k of ['pane', 'head', 'to', 'subject', 'fmt', 'body', 'send']) {
      worst[k] = 0;
      for (const fr of f) { if (!fr[k] || !last[k]) continue; worst[k] = Math.max(worst[k], ...fr[k].map((v, i) => Math.abs(v - last[k][i]))); }
    }
    return { worst, frames: f.length, shellFrames: f.filter((x) => x.prep).length, last };
  })()`);
}
const assertStill = (m, what) => {
  assert.ok(m.shellFrames >= 1, `${what}: no frame of the shell was recorded (${m.frames} frames)`);
  for (const [k, v] of Object.entries(m.worst)) assert.ok(v <= 1, `${what}: the ${k} box moved ${Math.round(v * 10) / 10} px between the shell and the filled message (${JSON.stringify(m.last[k])})`);
};

async function openMessage(id) {
  await evaluate(`window.__store.getState().openCompose(null, { restore: false }); 1`);
  await sleep(200);
  await evaluate(`window.__store.getState().select(${JSON.stringify(id)}); 1`);
  assert.ok(await waitFor(`!!document.querySelector('.rp-msg.open button')`, 20000), `the message ${id} did not open`);
  await sleep(400);
}
const press = (label) => evaluate(`(() => { const b = [...document.querySelectorAll('.rp-msg.open button')].find((x) => (x.getAttribute('aria-label') || x.textContent).trim().toLowerCase().startsWith(${JSON.stringify(label.toLowerCase())})); if (!b) return false; b.click(); return true; })()`);

try {
  for (const [w, h] of [[960, 560], [1280, 800]]) {
    await H.openApp('lang=en', w, h);
    assert.ok(await evaluate(FIXTURES), 'the fixtures were not added');
    await evaluate(`window.__store.getState().refresh().then(() => 1)`);
    for (const [label, id] of [['Reply', IDS.big], ['Reply all', IDS.big], ['Forward', IDS.small]]) {
      await check(`${label} in the pane at ${w} x ${h}`, async () => {
        await openMessage(id);
        // headers take 600 ms: the shell is on screen for a while; the fill comes after
        await evaluate(`window.__mockDelays = { replyHeaders: 600, quote: 10 }; window.__attachmentCalls = []; window.__replyHeaderCalls = []; 1`);
        await evaluate(SAMPLER);
        assert.ok(await press(label), `no ${label} button`);
        assert.ok(await waitFor(`!!document.querySelector('.compose-pane.preparing')`, 5000), 'no shell');
        assert.ok(await waitFor(`!document.querySelector('.compose-pane.preparing') && !!document.querySelector('.compose-pane .quote-block')`, 12000), 'the message never filled in');
        await sleep(600);
        assertStill(await moved(), `${label} ${w}x${h}`);
      });
    }
  }
  // the compose window: the shell, then the message handed over
  for (const [w, h] of [[960, 560], [1280, 800]]) {
    await check(`the compose window at ${w} x ${h}`, async () => {
      await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await cdp('Page.navigate', { url: 'about:blank' });
      await cdp('Page.navigate', { url: `${H.base}?w=compose&mock=prepare#lang=en` });
      assert.ok(await waitFor(`!!document.querySelector('.popout-compose .compose-pane.preparing')`, 20000), 'no shell in the window');
      await evaluate(SAMPLER);
      await sleep(700);
      assert.ok(await waitFor(`(window.__popoutRequests || []).some((r) => r.kind === 'cw-fill-ready')`, 5000), 'the window did not ask for its message');
      const full = { accountId: 'a1', to: ['linh.tran@acme.example'], subject: 'Re: Q4 roadmap review', isReply: true, afterShell: true, inReplyTo: '<m1@acme.example>', bodyHtml: '<br><div class="hl-quote"><div>On Mon, Linh wrote:</div><blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex"><p>Could you review the milestones?</p></blockquote></div>' };
      await evaluate(`window.__mockEmit('popout-reply', { id: 'shell-fill', ok: true, data: ${JSON.stringify(full)}, error: null }); 1`);
      assert.ok(await waitFor(`!document.querySelector('.compose-pane.preparing') && !!document.querySelector('.compose-pane .quote-block')`, 8000), 'the window did not fill');
      await sleep(600);
      assertStill(await moved(), `the window ${w}x${h}`);
    });
  }
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-answer-geometry: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-answer-geometry: ok');
