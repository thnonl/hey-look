#!/usr/bin/env node
// A message that comes back into an editor keeps what the person had chosen (1.0.7 W2.7, W2.22 CF-14 / CF-18). Real compose pane in the dev preview:
//   - W2.7: the signature picker after Send + Undo is what it was before Send: Automatic (a mailbox with no default signature: `#nodefaultsig`), a named
//     signature (shown once, not twice), No signature, the default one; in the compose window too (the Undo of its "Sending..." card);
//   - W2.22 CF-14: `extractSignature` takes the first signature block that is not in a quote, so a forwarded Hey Look! signature stays text (1.0.7 forward,
//     a draft from before 1.0.6 whose forward is a plain div below the person's own signature, a new message with one signature);
//   - W2.22 CF-18: the message a reply answers survives Save draft and opening the draft again (the reference sent back to the server once it goes out).
//   node scripts/test-compose-restore.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-compose-restore', { vitePort0: 5600, cdpPort0: 9600 });
const { evaluate } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${e.message.replace(/\s+/g, ' ')}`); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(js)) return true; await sleep(100); } return false; };
const mod = (path) => `import(${JSON.stringify(path)})`;

const paneUp = () => evaluate(`!!document.querySelector('.cp-editor .tiptap')?.editor && !!document.querySelector('.sig-select')`);
/** the picker as the person sees it: its value, the text of the chosen option, how many signature regions and how often the signature text is in the editor */
const picker = () => evaluate(`(() => { const s = document.querySelector('.sig-select'); return s ? { value: s.value, shown: s.selectedOptions[0]?.textContent ?? '', regions: document.querySelectorAll('.cp-editor .sig-block').length, bodyText: document.querySelector('.cp-editor .sig-block .sig-body')?.innerText.trim() ?? null, nam: (document.querySelector('.cp-editor').innerText.match(/\\bNam\\b/g) ?? []).length } : null; })()`);
const choose = (value) => evaluate(`(() => { const s = document.querySelector('.sig-select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
const clickButton = (re) => evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => ${re}.test((x.getAttribute('aria-label') || x.textContent).trim())); if (!b) return false; b.click(); return true; })()`);

async function fresh(flags, init = { accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Restore test' }) {
  await H.openApp(`lang=en${flags}`, 1280, 800);
  await evaluate(`window.__store.getState().openCompose(${JSON.stringify(init)}); 1`);
  assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor && !!document.querySelector('.sig-select')`, 15000), 'compose did not start');
  await sleep(700);
  await evaluate(`document.querySelector('.cp-editor .tiptap').editor.commands.insertContent('Some words'); 1`);
  await sleep(300);
}
/** Send, then Undo on the "Sending..." toast: the message comes back in a new pane */
async function sendAndUndo() {
  assert.ok(await clickButton(/^Send$/), 'no Send button');
  assert.ok(await waitFor(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Undo')`, 6000), 'no Undo offer');
  await sleep(300);
  assert.ok(await clickButton(/^Undo$/), 'no Undo button');
  assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor && !!document.querySelector('.sig-select')`, 10000), 'the message did not come back');
  await sleep(900);
}

try {
  // ---------- W2.7: Automatic (a mailbox with no default signature)
  await fresh('&nodefaultsig');
  await check('a new message with no default signature shows Automatic', async () => {
    const p = await picker();
    assert.equal(p.value, '');
    assert.equal(p.shown, 'Automatic');
  });
  await sendAndUndo();
  await check('Send + Undo: the picker still shows Automatic (it was "No signature")', async () => {
    const p = await picker();
    assert.equal(p.value, '', JSON.stringify(p));
    assert.equal(p.shown, 'Automatic');
    assert.equal(p.regions, 1);
  });

  // ---------- W2.7: a named signature, shown once
  await fresh('&nodefaultsig');
  await choose('s2');
  await sleep(300);
  await sendAndUndo();
  await check('Send + Undo with a named signature: the same one is selected and shown once', async () => {
    const p = await picker();
    assert.equal(p.value, 's2', JSON.stringify(p));
    assert.equal(p.regions, 1);
    assert.equal(p.bodyText, 'Nam');
    assert.equal(p.nam, 1, 'the signature is in the editor once, not in the text as well');
  });
  // the body is the text again, once
  await check('the text came back as it was', async () => assert.match(await evaluate(`document.querySelector('.cp-editor .tiptap').editor.getText()`), /Some words/));

  // ---------- W2.7: No signature
  await fresh('&nodefaultsig');
  await choose('none');
  await sleep(300);
  await sendAndUndo();
  await check('Send + Undo with "No signature": No signature', async () => {
    const p = await picker();
    assert.equal(p.value, 'none', JSON.stringify(p));
    assert.equal(p.shown, 'No signature');
  });
  // sending again and undoing again keeps it (twice over)
  await sendAndUndo();
  await check('and a second round trip keeps it', async () => assert.equal((await picker()).value, 'none'));

  // ---------- W2.7: the default signature of the mailbox
  await fresh('');
  await check('with a default signature the picker starts on it', async () => assert.equal((await picker()).value, 's1'));
  await sendAndUndo();
  await check('Send + Undo: the default signature, once', async () => {
    const p = await picker();
    assert.equal(p.value, 's1', JSON.stringify(p));
    assert.equal(p.regions, 1);
  });

  // ---------- W2.7: a draft that is opened from Drafts keeps today's rule (the signature found in the stored text; none = No signature)
  await fresh('&nodefaultsig');
  await choose('s2');
  await sleep(200);
  await evaluate(`window.__store.getState().composeSaver({ quiet: true }); 1`);
  await sleep(800);
  await evaluate(`window.__store.getState().openCompose(null); 1`);
  await sleep(300);
  const tid = await evaluate(`${mod('/src/api.ts')}.then(async (m) => (await m.api.listThreads({ folder: 'drafts' }))[0]?.threadId)`);
  await evaluate(`${mod('/src/components/Compose.tsx')}.then((m) => m.openDraftThread(${JSON.stringify(tid)}, true))`);
  assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor && !!document.querySelector('.sig-select')`, 10000));
  await sleep(900);
  await check('a draft opened from Drafts: the signature found in its text is selected', async () => {
    const p = await picker();
    assert.equal(p.value, 's2', JSON.stringify(p));
    assert.equal(p.regions, 1);
  });

  // ---------- W2.7: the compose window (Undo on the card of the window)
  await H.openApp('lang=en&nodefaultsig', 1280, 800);
  await H.cdp('Page.navigate', { url: 'about:blank' });
  await H.cdp('Page.navigate', { url: `${H.base}?w=compose&mock=reply#lang=en&nodefaultsig` });
  assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor && !!document.querySelector('.sig-select')`, 15000), 'the compose window did not start');
  await sleep(900);
  await check('window: Automatic at the start (a reply with "no signature on replies" off or a mailbox without a default)', async () => assert.ok(['', 'none'].includes((await picker()).value)));
  await choose('s2');
  await sleep(300);
  await evaluate(`document.querySelector('.cp-editor .tiptap').editor.commands.insertContent('Some words'); 1`);
  assert.ok(await clickButton(/^Send$/), 'no Send in the window');
  await check('window: the Undo of the "Sending" card brings the message back with the same picker', async () => {
    assert.ok(await waitFor(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Undo')`, 6000), 'no Undo on the card');
    await sleep(300);
    assert.ok(await clickButton(/^Undo$/));
    assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor && !!document.querySelector('.sig-select')`, 10000));
    await sleep(900);
    const p = await picker();
    assert.equal(p.value, 's2', JSON.stringify(p));
    assert.equal(p.regions, 1);
  });

  // ---------- W2.22 CF-14: the signature region is the person's own, never a forwarded one
  const extracted = async (html) => evaluate(`${mod('/src/signature.ts')}.then((m) => { const r = m.extractSignature(${JSON.stringify(html)}); return { sig: r.sig, regions: r.html.split('data-sig-block').length - 1, text: r.html }; })`);
  const own = '<br><div class="sig">-- <br>Mine</div>';
  // (a) a 1.0.7 forward: the forwarded message sits in a quote block whose own signature is not the person's
  const fwd107 = `<p>FYI</p>${own}<br><div class="hl-quote"><div>---------- Forwarded message ----------<br>From: Ann</div><div><p>Original</p><div class="sig">-- <br>Other</div></div></div>`;
  // (b) a draft from before 1.0.6: the forward is a plain div (no hl-quote) below the person's signature
  const fwdOld = `<p>FYI</p>${own}<br><div>---------- Forwarded message ----------<br>From: Ann<br><p>Original</p><div class="sig">-- <br>Other</div></div>`;
  // (c) a new message with one signature
  const one = `<p>Hello</p>${own}`;
  for (const [name, html] of [['1.0.7 forward', fwd107], ['pre-1.0.6 forward', fwdOld], ['new message', one]]) {
    const r = await extracted(html);
    await check(`CF-14 ${name}: the region is the person's own signature`, async () => {
      assert.equal(r.sig, 'Mine');
      assert.equal(r.regions, 1);
      if (name !== 'new message') assert.ok(r.text.includes('Other'), 'the forwarded signature stays in the text');
    });
  }
  await check('CF-14: a signature inside a blockquote (a reply) is still not the person\'s', async () => {
    const r = await extracted(`<p>Thanks</p>${own}<br><div>On Mon wrote:</div><blockquote><div class="sig">-- <br>Theirs</div></blockquote>`);
    assert.equal(r.sig, 'Mine');
  });
  await check('CF-14: only a quoted signature, none of the person\'s: the region is empty', async () => {
    const r = await extracted(`<p>Thanks</p><br><div class="hl-quote"><div>On Mon wrote:</div><blockquote><div class="sig">-- <br>Theirs</div></blockquote></div>`);
    assert.equal(r.sig, null);
  });

  // ---------- W2.22 CF-18: the message a reply answers survives Save draft and opening the draft again
  const ans = { kind: 'answered', accountId: 'a1', messageId: '<orig@example.org>' };
  await fresh('&nodefaultsig', { accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Re: hi', isReply: true, inReplyTo: '<orig@example.org>', answers: ans });
  await evaluate(`window.__store.getState().composeSaver({ quiet: true }); 1`);
  await sleep(800);
  await check('CF-18: Save draft carries the reference', async () => assert.deepEqual(JSON.parse(await evaluate(`JSON.stringify(window.__lastDraft?.answers ?? null)`)), ans));
  await evaluate(`window.__store.getState().openCompose(null); 1`);
  await sleep(300);
  const tid2 = await evaluate(`${mod('/src/api.ts')}.then(async (m) => (await m.api.listThreads({ folder: 'drafts' }))[0]?.threadId)`);
  await evaluate(`window.__lastDraft = null; ${mod('/src/components/Compose.tsx')}.then((m) => m.openDraftThread(${JSON.stringify(tid2)}, true))`);
  assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor`, 10000));
  await sleep(700);
  await evaluate(`document.querySelector('.cp-editor .tiptap').editor.commands.insertContent(' more'); window.__store.getState().composeSaver({ quiet: true }); 1`);
  await sleep(800);
  await check('CF-18: the draft opened again and saved again still names the original', async () => assert.deepEqual(JSON.parse(await evaluate(`JSON.stringify(window.__lastDraft?.answers ?? null)`)), ans));

  // ---------- 1.0.7 WP2a fix 2 (QA retest BUG-1): a message that comes back with a named signature (failed send, Undo, a window, a restore) saves a draft WITH
  // that signature. Save draft built the draft from the signature it saw when the pane was drawn; a named signature is loaded after that, and nothing in the
  // save's dependency list changed when it arrived (the picker already held its id), so the draft was built without it. The signature text is the branded
  // one of the mock (s4): it must be in the saved draft once.
  const NOTE = 'A highlighted note in the signature';
  const saveAndRead = async () => {
    await evaluate(`window.__lastDraft = null; window.__store.getState().composeSaver({ quiet: true }); 1`);
    await sleep(900);
    return evaluate(`window.__lastDraft ? window.__lastDraft.html : ''`);
  };
  const noteCount = (html) => html.split(NOTE).length - 1;
  await fresh('&nodefaultsig');
  await choose('s4');
  await sleep(300);
  await check('control: a new message with a named signature saves it once', async () => assert.equal(noteCount(await saveAndRead()), 1));
  await sendAndUndo();
  await check('Send + Undo, then Save draft: the draft has the named signature once', async () => {
    assert.equal((await picker()).value, 's4');
    const html = await saveAndRead();
    assert.equal(noteCount(html), 1, html.slice(-300));
  });
  await fresh('&nodefaultsig', { accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Failed [smtpfail]' });
  await choose('s4');
  await sleep(300);
  assert.ok(await clickButton(/^Send$/), 'no Send button');
  const back = await waitFor(`document.body.innerText.includes('Send failed') && !!document.querySelector('.cp-editor .tiptap')?.editor && !!document.querySelector('.sig-select')`, 40000);
  await sleep(1200);
  await check('a failed send: Compose is back with the picker and the signature once', async () => {
    assert.ok(back, 'the message did not come back');
    const p = await picker();
    assert.equal(p.value, 's4', JSON.stringify(p));
    assert.equal(p.regions, 1);
  });
  await check('a failed send: the toast is a sentence with the server\'s words as the detail, not the raw text (retest UX-1)', async () => {
    const text = await evaluate(`document.body.innerText`);
    assert.match(text, /Send failed: The mail server did not accept the message\. Try again in a moment; if it keeps failing, check the outgoing server in Settings\. \(Details: response error: incomplete response\)/);
    assert.ok(!text.includes('SMTP send failed'), 'the raw text is shown');
  });
  await check('a failed send, then Save draft: the draft has the named signature once (it had none)', async () => {
    const html = await saveAndRead();
    assert.equal(noteCount(html), 1, html.slice(-300));
  });
  // a message that is opened again with the signature carried (the shape every reopen path hands over: initOf)
  await H.openApp('lang=en&nodefaultsig', 1280, 800);
  await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Restored', sigId: 's4', restore: { encrypt: 'auto', sign: false, attachKey: false }, bodyHtml: '<p>Body of the message</p><br><div class="sig">-- <br><p style="background:#fff3bf">' + ${JSON.stringify(NOTE)} + '</p></div>' }); 1`);
  assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor && !!document.querySelector('.sig-select')`, 15000));
  await sleep(900);
  await check('a restored message with a carried signature id: Save draft keeps the signature once', async () => {
    assert.equal((await picker()).value, 's4');
    assert.equal(noteCount(await saveAndRead()), 1);
  });
  // the compose window gets the same init from its opener
  await H.openApp('lang=en&nodefaultsig', 1280, 800);
  await H.cdp('Page.navigate', { url: 'about:blank' });
  await H.cdp('Page.navigate', { url: `${H.base}?w=compose&mock=sigrestore#lang=en&nodefaultsig` });
  assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor && !!document.querySelector('.sig-select')`, 15000), 'the compose window did not start');
  await sleep(1200);
  await check('the compose window of a moved message with a carried signature id: Save draft keeps the signature once', async () => {
    assert.equal((await picker()).value, 's4');
    assert.equal(noteCount(await saveAndRead()), 1);
  });
} finally { await H.shutdown(); }

if (failures.length) { console.error(`test-compose-restore: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-compose-restore: ok');
