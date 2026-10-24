#!/usr/bin/env node
// 1.0.7 fix35 (Mac QA, WebKit: selecting a 2 MB mail again and again in the MAIN window grew the page by about the size of the mail per selection, 270 -> 308 MB in 20 selections, the DOM
// flat): the message frame is not navigated any more. Its document is written into a frame of its own (src/mailFrame.ts), one frame element per open mail, removed with it. What this
// test pins is the part Chromium shows too (the engine-specific part, the footprint of the WebContent process, is the Mac row WK-35.C):
//   - 20 selections that alternate between the 2 MB mail and a short mail (and the 500 KB one, the plain-text one) leave exactly ONE frame element in the page, and the counters of
//     `window.__mailFrame` say created - removed = live = 1;
//   - the session history of the page (`history.length`), the history of the frame (`contentWindow.history.length`) and the navigation entries of the performance timeline are
//     the same after the first selection and after the last one: nothing was navigated, nothing was added;
//   - the frame has no `srcdoc` and no `src` attribute (a 2 MB attribute value is a second copy of the mail), every selection wrote its document once, and the mail on the screen is the
//     one that was selected last (its text, not the text of an earlier one);
//   - a change of the language rebuilds the document in the SAME frame element (a write, not a new frame, not a navigation).
//   node scripts/test-mail-frame-history.mjs [--require-browser]
import assert from 'node:assert/strict';
import { languageJs, sleep, startHarness } from './cdp-harness.mjs';
import { FIXTURES, IDS } from './lib/reply-fixtures.mjs';

const H = await startHarness('test-mail-frame-history', { vitePort0: 6230 });
const { evaluate } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); } };
const waitFor = async (js, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between renders */ } await sleep(40); } return false; };
const SHOWN = (needle) => `(document.querySelector('.msg-frame')?.contentDocument?.body?.innerText ?? '').includes(${JSON.stringify(needle)})`;
const TITLES = { [IDS.huge]: 'Fixture huge 2 MB', [IDS.small]: 'Fixture small 20 KB', [IDS.big]: 'Fixture big 500 KB', [IDS.plain]: 'Fixture plain 1 MB' };
// a word that is in the body of each fixture and in no other (the fixtures share one paragraph text, so the line number tells them apart: the plain one starts with "Line 0:")
const BODY_MARK = { [IDS.huge]: 'Paragraph 0:', [IDS.small]: 'Paragraph 0:', [IDS.big]: 'Paragraph 0:', [IDS.plain]: 'Line 0:' };
const state = () => evaluate(`JSON.stringify({ frames: document.querySelectorAll('iframe').length, mail: window.__mailFrame, nav: performance.getEntriesByType('navigation').length, attrs: (() => { const f = document.querySelector('.msg-frame'); return f ? [f.hasAttribute('srcdoc'), f.hasAttribute('src')] : null; })() })`).then(JSON.parse);

try {
  await H.openApp('lang=en', 1280, 800);
  await evaluate(FIXTURES);
  await evaluate(`(async () => { await window.__store.getState().refresh(); return 1; })()`);

  await check('twenty selections alternating between big and small mails leave one frame, no history entry and no attribute copy of the mail', async () => {
    const order = [IDS.huge, IDS.small, IDS.huge, IDS.plain, IDS.huge, IDS.big];
    let first = null;
    for (let i = 0; i < 20; i++) {
      const id = order[i % order.length];
      await evaluate(`window.__store.getState().select(${JSON.stringify(id)}); 1`);
      assert.ok(await waitFor(SHOWN(BODY_MARK[id])), `selection ${i + 1} (${id}) did not show its mail`);
      // the subject of the pane is the selected one (the frame is not showing an earlier mail under a new subject)
      assert.ok(await waitFor(`document.body.innerText.includes(${JSON.stringify(TITLES[id])})`, 3000), `selection ${i + 1}: the subject ${TITLES[id]} is not in the pane`);
      await sleep(250);
      const s = await state();
      assert.equal(s.frames, 1, `selection ${i + 1}: ${s.frames} iframes in the page`);
      assert.equal(s.mail.live, 1, `selection ${i + 1}: ${s.mail.live} message frames`);
      assert.equal(s.mail.created - s.mail.removed, 1, `selection ${i + 1}: created ${s.mail.created}, removed ${s.mail.removed}`);
      assert.deepEqual(s.attrs, [false, false], `selection ${i + 1}: the frame carries srcdoc / src (${JSON.stringify(s.attrs)})`);
      assert.equal(s.mail.fallbacks, 0, 'a document had to be handed over as srcdoc');
      if (i === 0) first = s;
      else {
        assert.equal(s.mail.historyLength, first.mail.historyLength, `selection ${i + 1}: history.length ${first.mail.historyLength} -> ${s.mail.historyLength}`);
        assert.equal(s.mail.frameHistoryLength, first.mail.frameHistoryLength, `selection ${i + 1}: the frame's history.length ${first.mail.frameHistoryLength} -> ${s.mail.frameHistoryLength}`);
        assert.equal(s.nav, first.nav, `selection ${i + 1}: navigation entries ${first.nav} -> ${s.nav}`);
      }
    }
    const z = await state();
    assert.ok(z.mail.writes >= 20, `only ${z.mail.writes} documents were written for 20 selections`);
    assert.ok(z.mail.created >= 20, `only ${z.mail.created} frames were created for 20 selections (a frame per mail)`);
  });

  await check('a change of the language writes the document again in the same frame element', async () => {
    await evaluate(`window.__store.getState().select(${JSON.stringify(IDS.small)}); 1`);
    assert.ok(await waitFor(SHOWN('Paragraph 0:')));
    await sleep(500);
    await evaluate(`window.__frame0 = document.querySelector('.msg-frame'); 1`);
    const a = await state();
    await evaluate(languageJs('de')); // (waits until the language pack is loaded and applied)
    await sleep(300);
    const b = await state();
    assert.equal(await evaluate(`document.querySelector('.msg-frame') === window.__frame0`), true, 'a new frame element was made for a change of the language');
    assert.equal(b.mail.created, a.mail.created, 'a frame was created');
    assert.equal(b.mail.historyLength, a.mail.historyLength);
    assert.equal(b.mail.frameHistoryLength, a.mail.frameHistoryLength);
    assert.ok(await waitFor(SHOWN('Paragraph 0:')), 'the mail is gone after the change');
  });
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-mail-frame-history: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-mail-frame-history: ok');
