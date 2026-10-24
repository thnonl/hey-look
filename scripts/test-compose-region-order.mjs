#!/usr/bin/env node
// The signature region keeps its place among the typed text when a message comes back into an editor (1.0.7 V107-R10A-1, compose-test-plan INV-5 / A-16 / A-19). Real compose pane in the
// dev preview. The oracle is the TipTap document (`editor.getJSON().content`: paragraph texts and node types in order) before and after:
//   - a failed send (the toast `Send failed ...`, the message comes back);
//   - Send + Undo;
//   - Save draft, then the saved draft opened again (the body the draft stored, as the Drafts folder gives it back);
// for a mailbox with NO signature (the region prints nothing: it used to leave no trace in the stored body, so a reopen put it at the END and text typed below it ended up above it) and
// for one with a signature; text typed ABOVE the region, BELOW it, and BOTH; and a reply (text above, the region above the quote, INV-4).
//   node scripts/test-compose-region-order.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-compose-region-order', { vitePort0: 5700 });
const { evaluate } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(js)) return true; await sleep(100); } return false; };
const UP = `!!document.querySelector('.cp-editor .tiptap')?.editor && !!document.querySelector('.sig-select')`;
const clickButton = (re) => evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => ${re}.test((x.getAttribute('aria-label') || x.textContent).trim())); if (!b) return false; b.click(); return true; })()`);

/** The document as the person has it: `p(text)` for a paragraph, the node type for the rest, in order (`sig` for the region). */
const shape = () => evaluate(`(() => { const c = document.querySelector('.cp-editor .tiptap').editor.getJSON().content; return c.map((n) => n.type === 'paragraph' ? 'p(' + (n.content ?? []).map((x) => x.text ?? x.type).join('') + ')' : n.type === 'signatureBlock' ? 'sig' : n.type).join(' | '); })()`);
const regions = () => evaluate(`document.querySelectorAll('.cp-editor .sig-block').length`);

const QUOTE = '<br><div class="hl-quote"><div>On Fri, 16 Oct 2026, Ann wrote:</div><blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex"><p>The quoted words</p></blockquote></div>';

/** A new message (or, with `quote`, a reply) in a fresh page; `sig`: the mailbox has its default signature. */
async function fresh(sig, { subject = 'Region order', quote = false, undo = 0 } = {}) {
  await H.openApp(`lang=en${sig ? '' : '&nodefaultsig'}`, 1280, 800);
  await evaluate(`window.__store.getState().setPrefs({ undoSeconds: ${undo} }); 1`);
  const init = { accountId: 'a1', to: ['alice@fabrikam.com'], subject, ...(quote ? { isReply: true, bodyHtml: QUOTE } : {}) };
  await evaluate(`window.__store.getState().openCompose(${JSON.stringify(init)}); 1`);
  assert.ok(await waitFor(UP, 15000), 'compose did not start');
  await sleep(700);
}
/** Types `above` into the paragraph above the region and `below` into the one under it (what a click there and typing does). */
async function typeText({ above, below }) {
  await evaluate(`(() => {
    const ed = document.querySelector('.cp-editor .tiptap').editor;
    if (${JSON.stringify(above)}) { ed.commands.setTextSelection(1); ed.commands.insertContent(${JSON.stringify(above)}); }
    if (${JSON.stringify(below)}) { ed.commands.focus('end'); ed.commands.insertContent(${JSON.stringify(below)}); }
    return 1; })()`);
  await sleep(300);
}
/** Save draft (what the Drafts folder will hold), then that draft opened again the way draftOpen.ts hands it to Compose. Returns the saved body. */
async function saveAndReopen() {
  await evaluate(`window.__lastDraft = null; window.__store.getState().composeSaver({ quiet: true }); 1`);
  await sleep(900);
  const html = await evaluate(`window.__lastDraft ? window.__lastDraft.html : ''`);
  assert.ok(html, 'Save draft did not save');
  await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Region order draft', bodyHtml: ${JSON.stringify(html)}, replaces: 'm:draft-1' }); 1`);
  await sleep(300);
  assert.ok(await waitFor(UP, 15000), 'the draft did not open');
  await sleep(900);
  return html;
}

const POSITIONS = [['above', { above: 'Top words' }], ['below', { below: 'Bottom words' }], ['above and below', { above: 'Top words', below: 'Bottom words' }]];

try {
  for (const sig of [false, true]) {
    for (const [where, text] of POSITIONS) {
      const tag = `${sig ? 'a signature' : 'NO signature'}, text ${where}`;
      // failed send, then Save draft and open it
      await fresh(sig, { subject: 'Failed [smtpfail]' });
      await typeText(text);
      const before = await shape();
      await check(`${tag}: the editor starts as expected`, async () => {
        assert.match(before, /sig/);
        for (const w of Object.values(text)) assert.ok(before.includes(w), before);
      });
      await check(`${tag}: a failed send brings the message back in the same order`, async () => {
        assert.ok(await clickButton(/^Send$/), 'no Send button');
        assert.ok(await waitFor(`document.body.innerText.includes('Send failed') && ${UP}`, 20000), 'the message did not come back');
        await sleep(1000);
        assert.equal(await shape(), before);
        assert.equal(await regions(), 1);
      });
      await check(`${tag}: Save draft + open the draft keeps the order`, async () => {
        const html = await saveAndReopen();
        if (!sig) assert.ok(html.includes('class="hl-region"'), 'the draft body has no mark of the region: ' + html.slice(-200));
        assert.equal(await shape(), before);
        assert.equal(await regions(), 1);
      });
      // Send + Undo
      await fresh(sig, { undo: 10 });
      await typeText(text);
      const before2 = await shape();
      await check(`${tag}: Send + Undo brings the message back in the same order`, async () => {
        assert.ok(await clickButton(/^Send$/), 'no Send button');
        assert.ok(await waitFor(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Undo')`, 8000), 'no Undo offer');
        await sleep(300);
        assert.ok(await clickButton(/^Undo$/), 'no Undo button');
        assert.ok(await waitFor(UP, 10000), 'the message did not come back');
        await sleep(900);
        assert.equal(await shape(), before2);
      });
    }
  }

  // a reply: text above the region, the region above the quote (INV-4), through Save draft and a failed send
  for (const sig of [false, true]) {
    const tag = `a reply, ${sig ? 'a signature' : 'NO signature'}`;
    await fresh(sig, { subject: 'Re: Failed [smtpfail]', quote: true });
    await typeText({ above: 'Reply words' });
    const before = await shape();
    await check(`${tag}: the region is above the quote`, async () => assert.match(before, /^p\(Reply words\) \| sig \| quoteBlock/));
    await check(`${tag}: a failed send brings it back in the same order`, async () => {
      assert.ok(await clickButton(/^Send$/), 'no Send button');
      assert.ok(await waitFor(`document.body.innerText.includes('Send failed') && ${UP}`, 20000), 'the message did not come back');
      await sleep(1000);
      assert.equal(await shape(), before);
    });
    await check(`${tag}: Save draft + open the draft keeps the order`, async () => {
      await saveAndReopen();
      assert.equal(await shape(), before);
    });
  }

  // an old draft (no mark, no signature): the region still opens at the end, or above the quote, as before
  await fresh(false);
  await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Old draft', bodyHtml: '<p>Old words</p>', replaces: 'm:old-1' }); 1`);
  await sleep(300);
  assert.ok(await waitFor(UP, 15000));
  await sleep(900);
  await check('a draft from before the mark (no signature, no mark): the region opens below the text', async () => assert.equal(await shape(), 'p(Old words) | sig | p()'));
} finally {
  await H.shutdown();
}

if (failures.length) {
  console.error(`test-compose-region-order: FAILED (${failures.length})\n  ` + failures.join('\n  '));
  process.exit(1);
}
console.log('test-compose-region-order: ok (a failed send, Send + Undo, Save draft + reopen; text above / below / both; no signature and a signature; a reply)');
