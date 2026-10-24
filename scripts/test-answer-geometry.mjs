#!/usr/bin/env node
// Reply, Reply all and Forward: nothing moves between the shell and the filled message (W13.13, D-067: on Linux the To box went from w564@x382 to w870@x76 when the message was filled in, because the list column
// glided away AFTER the shell was drawn). A page sampler records, on every animation frame from the press to 500 ms after the fill, the boxes of the pane, the To row, the Subject row, the body and the
// Send button; every frame must be within 1 px of the final one (x, y, width, height). Real list, pane and compose in the dev preview (the mock backend, scripts/lib/reply-fixtures.mjs), and the compose
// window (?w=compose) with a shell and a handed-over message; 960 x 560 and 1280 x 800.
// One thing is allowed to appear at the fill: the security strip of a person who has an OpenPGP key ("Encrypt turned itself off: no key for ..."), which depends on the recipients and so cannot be
// known by the shell. It sits under the Subject row, inside the header box: the header box may grow by at most the strip (all of it, or less when the header is as high as it may be and scrolls), the
// boxes under the header move by exactly that, and every header ROW (From, To, Cc, Bcc, Subject; one box each, so a row that wraps counts) stays where it was (REQ-13.13.12).
// The rows with many or long recipients wrap, and how many lines they take depends on the font of the machine: a case with five long addresses wraps everywhere, and the same cases run
// again with a wide font (monospace) so a machine whose fonts are narrow still sees the wrap (the CI runner of Linux has wider fonts than the PC this was written on, 1.0.7 fix47).
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
    if (p) window.__geo.frames.push({ t: performance.now(), prep: p.classList.contains('preparing'), pane: rect(p), rows: [...p.querySelectorAll('.cp-fields > .cf-field, .cp-fields > .cf-links')].map(rect), fmt: rect(p.querySelector('.cp-fmt')), head: rect(p.querySelector('.cp-head')), sec: p.querySelector('.sec-strip')?.getBoundingClientRect().height ?? 0, capped: (() => { const h = p.querySelector('.cp-head'); return !!h && h.scrollHeight > h.clientHeight + 1; })(), body: rect(p.querySelector('.cp-editor')), send: rect(p.querySelector('.split-btn .btn.primary')) });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return 1;
})()`;

/**
 * The worst distance (px) of any frame from the last one, per box; and how many frames were shell frames. The header box is compared by what the strip allows (see the top): its height may
 * differ from the last frame's by the height the strip has in the last frame and not in this one (`head` is the part of the difference that the strip does not explain), the boxes under it
 * are moved by the difference that was measured before they are compared, the rows are compared as they are.
 */
async function moved() {
  await evaluate('window.__geo.stop = true; 1');
  return evaluate(`(() => {
    const frames = window.__geo.frames; const last = frames[frames.length - 1]; const worst = { pane: 0, head: 0, rows: 0, fmt: 0, body: 0, send: 0 };
    const dist = (a, b) => (a && b ? Math.max(...a.map((v, i) => Math.abs(v - b[i]))) : 0);
    for (const fr of frames) {
      const grew = last.head[3] - fr.head[3]; const strip = last.sec - fr.sec; // (the header box grew by 'grew' px, the strip by 'strip' px)
      const lo = Math.min(0, strip), hi = Math.max(0, strip);
      worst.head = Math.max(worst.head, dist(fr.head.slice(0, 3), last.head.slice(0, 3)), grew < lo ? lo - grew : grew > hi ? grew - hi : 0);
      worst.pane = Math.max(worst.pane, dist(fr.pane, last.pane));
      worst.send = Math.max(worst.send, dist(fr.send, last.send));
      worst.rows = Math.max(worst.rows, fr.rows.length !== last.rows.length ? 999 : Math.max(0, ...fr.rows.map((r, i) => dist(r, last.rows[i]))));
      const under = (r, tall) => r && [r[0], r[1] + grew, r[2], r[3] - (tall ? grew : 0)]; // (what the header box pushes down: the formatting bar and the body, which gives up the height)
      worst.fmt = Math.max(worst.fmt, dist(under(fr.fmt), last.fmt));
      worst.body = Math.max(worst.body, dist(under(fr.body, true), last.body));
    }
    return { worst, frames: frames.length, shellFrames: frames.filter((x) => x.prep).length, last, first: frames[0] };
  })()`);
}
const assertStill = (m, what) => {
  assert.ok(m.shellFrames >= 1, `${what}: no frame of the shell was recorded (${m.frames} frames)`);
  for (const [k, v] of Object.entries(m.worst)) assert.ok(v <= 1, `${what}: the ${k} box moved ${Math.round(v * 10) / 10} px between the shell and the filled message (last ${JSON.stringify(k === 'rows' ? m.last.rows : m.last[k])}, first ${JSON.stringify(k === 'rows' ? m.first.rows : m.first[k])})`);
};

async function openMessage(id) {
  await evaluate(`window.__store.getState().openCompose(null, { restore: false }); 1`);
  await sleep(200);
  await evaluate(`window.__store.getState().select(${JSON.stringify(id)}); 1`);
  assert.ok(await waitFor(`!!document.querySelector('.rp-msg.open button')`, 20000), `the message ${id} did not open`);
  await sleep(400);
}
const press = (label) => evaluate(`(() => { const b = [...document.querySelectorAll('.rp-msg.open button')].find((x) => (x.getAttribute('aria-label') || x.textContent).trim().toLowerCase().startsWith(${JSON.stringify(label.toLowerCase())})); if (!b) return false; b.click(); return true; })()`);

// five long addresses in To and four in Cc: the rows wrap in any font (a message of its own, so the other tests of the fixtures see the same list as before)
const MANY = 'fx-many';
const addMany = `(() => { const to = ['alexandra.montgomery-whitfield@example.com', 'bartholomew.fitzgerald-ramsay@example.com', 'christopher.wolfeschlegelstein@example.com', 'dominique.van-der-westhuizen@example.com'];
  const cc = ['evangeline.kowalczyk-nakamura@example.com', 'ferdinand.oyelaran-papadopoulos@example.com', 'guinevere.abernathy-lindqvist@example.com'];
  window.__mockAddThread('${MANY}', 'Fixture many long recipients', { fromName: 'Linh Tran', fromEmail: 'linh@example.com', to: to.join(','), cc: cc.join(','), html: '<div><p>A short message for the rows that wrap.</p></div>' }); return 1; })()`;
const WIDE = `(() => { const s = document.createElement('style'); s.id = 'wide-font'; s.textContent = '* { font-family: monospace !important; }'; document.head.appendChild(s); return 1; })()`;
const NARROW = `(() => { document.getElementById('wide-font')?.remove(); return 1; })()`;

try {
  for (const [w, h] of [[960, 560], [1280, 800]]) {
    await H.openApp('lang=en', w, h);
    assert.ok(await evaluate(FIXTURES), 'the fixtures were not added');
    assert.ok(await evaluate(addMany), 'the fixture with many recipients was not added');
    await evaluate(`window.__store.getState().refresh().then(() => 1)`);
    // (a Reply all with Cc recipients has the Cc and Bcc rows in the shell, a forward with an Auto Bcc has them too: REQ-13.13.12, nothing appears at the fill)
    const cases = [['Reply', IDS.big, '', false], ['Reply all', IDS.big, '', false], ['Forward', IDS.small, '', false], ['Reply all', IDS.cc, '', false], ['Forward', IDS.small, 'audit@example.com', false],
      ['Reply all', MANY, '', false], ['Reply all', IDS.cc, '', true], ['Forward', IDS.small, 'audit@example.com', true], ['Reply all', MANY, '', true]];
    for (const [label, id, pref, wide] of cases) {
      await check(`${label}${id === IDS.cc ? ' with Cc' : id === MANY ? ' with many recipients' : ''}${pref ? ' with an Auto Bcc' : ''}${wide ? ' in a wide font' : ''} in the pane at ${w} x ${h}`, async () => {
        await evaluate(wide ? WIDE : NARROW);
        await evaluate(`window.__store.getState().setPrefs({ autoBcc: ${JSON.stringify(pref)} }); 1`);
        await openMessage(id);
        // headers take 600 ms: the shell is on screen for a while; the fill comes after
        await evaluate(`window.__mockDelays = { replyHeaders: 600, quote: 10 }; window.__attachmentCalls = []; window.__replyHeaderCalls = []; 1`);
        await evaluate(SAMPLER);
        assert.ok(await press(label), `no ${label} button`);
        assert.ok(await waitFor(`!!document.querySelector('.compose-pane.preparing')`, 5000), 'no shell');
        assert.ok(await waitFor(`!document.querySelector('.compose-pane.preparing') && !!document.querySelector('.compose-pane .quote-block')`, 12000), 'the message never filled in');
        await sleep(600);
        assertStill(await moved(), `${label} ${id} ${pref}${wide ? ' wide' : ''} ${w}x${h}`);
        if (id === IDS.cc || id === MANY || pref) assert.equal(await evaluate(`document.querySelectorAll('.compose-pane .cp-fields .cf-field.rcpt').length`), 3, 'the Cc and Bcc rows are there');
      });
    }
  }
  await evaluate(`window.__store.getState().setPrefs({ autoBcc: '' }); 1`);
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
