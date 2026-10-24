#!/usr/bin/env node
// 1.0.7 WP13f-3 (DEC-023, AC-13.13.16): a Reply / Reply all / Forward that is filled IN PLACE (the Compose and the editor made for the shell are kept) makes the same message as
// the Compose that is mounted fresh with the same content (today's path, which stays as the fallback of REQ-13.13.14). Ten fixtures in the dev preview (the mock backend,
// src/devMock.ts): reply, reply all with Cc, forward with 3 attachments, encrypted reply, confidential reply, Reply-To note, reply with the signature above the quote (Hey Look!
// always puts it above; there is no "below" setting), reply with "signature on replies" off, plain-text original, HTML original with a remote picture.
// For each: the answer is opened by the real button (shell, then the fill), a word is typed, Send is pressed and the draft handed to the outbox is read (`window.__sendCalls`:
// that is what the Rust side builds the MIME from, so equal drafts are equal MIME); then the SAME finished message (`store.compose`) is opened again with `openCompose` (a fresh
// mount: new Compose, new editor) and sent the same way. The two drafts must be equal (picture ids masked); the recipients, the Cc row, the signature and the quote must be there.
//   node scripts/test-reply-golden.mjs [--require-browser] [--out=drafts.json] [--ref=drafts.json]   (--out: writes the masked drafts; --ref: and compares them with the drafts another build wrote)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { arg, sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-reply-golden', { vitePort0: 5870 });
const { evaluate } = H;
const failures = [];
const out = {};
const waitFor = async (js, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between two renders */ } await sleep(30); } return false; };

const para = (n) => '<p>Paragraph ' + n + ': the quarterly figures were reviewed on Monday and the open points are listed below. Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>';
const FIXTURES = `(() => {
  const add = window.__mockAddThread;
  const html = ${JSON.stringify('<div>' + Array.from({ length: 12 }, (_, i) => para(i)).join('') + '</div>')};
  add('g-small', 'Golden small', { fromName: 'Linh Tran', fromEmail: 'linh@example.com', html });
  add('g-cc', 'Golden with Cc', { fromName: 'Linh Tran', fromEmail: 'linh@example.com', to: 'nam@example.com,bao@example.com', cc: 'chi@example.com,dung@example.com', html });
  add('g-att', 'Golden with attachments', { fromName: 'Linh Tran', fromEmail: 'linh@example.com', html, attachments: [
    { index: 0, name: 'report.pdf', mime: 'application/pdf', size: 482113, inline: false, cid: null, referenced: false },
    { index: 1, name: 'figures.xlsx', mime: 'application/vnd.ms-excel', size: 51000, inline: false, cid: null, referenced: false },
    { index: 2, name: 'notes.txt', mime: 'text/plain', size: 120, inline: false, cid: null, referenced: false } ] });
  add('g-plain', 'Golden plain text', { fromName: 'Linh Tran', fromEmail: 'linh@example.com', html: null, text: Array.from({ length: 30 }, (_, i) => 'Line ' + i + ': the open points follow, <b>not markup</b> & more.').join('\\n') });
  const pics = [0, 1, 2].map((i) => ({ index: i, name: 'pic' + i + '.png', mime: 'image/png', size: 2048, inline: true, cid: 'p' + i + '@g', referenced: true }));
  add('g-pics', 'Golden with pictures', { fromName: 'Linh Tran', fromEmail: 'linh@example.com', html: '<div><p>Pictures:</p>' + pics.map((p) => '<img src="cid:' + p.cid + '" width="40">').join('') + '</div>', attachments: pics });
  add('g-html', 'Golden rich HTML', { fromName: 'Linh Tran', fromEmail: 'linh@example.com', html: '<div style="font-family:Georgia"><h2>Plan</h2><table border="1"><tr><td>A</td><td>B</td></tr></table><p><img src="https://pictures.example.invalid/p.png" width="120"> <a href="https://example.com/x">link</a> <b>bold</b> <i>italic</i></p><ul><li>one</li><li>two</li></ul><blockquote>old quote</blockquote></div>' });
  return true;
})()`;

/** [name, thread, button, prefs to set first]. */
const CASES = [
  ['reply', 'g-small', 'Reply', {}],
  ['reply all with Cc', 'g-cc', 'Reply all', {}],
  ['forward with 3 attachments', 'g-att', 'Forward', {}],
  ['encrypted reply', 't8', 'Reply', {}],
  ['confidential reply', 'tconf', 'Reply', {}],
  ['Reply-To note', 'trt', 'Reply', {}],
  ['signature above the quote', 'g-small', 'Reply', { signatureOnReply: true }],
  ['no signature on replies', 'g-small', 'Reply', { signatureOnReply: false }],
  ['plain-text original', 'g-plain', 'Reply', {}],
  ['HTML original', 'g-html', 'Reply', {}],
  ['quote with pictures', 'g-pics', 'Reply all', {}],
];

// (picture ids are random; the date of the quoted message is the preview's clock: neither says anything about the message)
const mask = (v) => JSON.parse(JSON.stringify(v).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@heylook/g, 'CID@heylook').replace(/\d{1,2} [A-Z][a-z]{2} \d{4} \d{1,2}:\d{2}/g, 'DATE'));
const firstDiff = (a, b, path = '') => {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], `${path}.${k}`); if (d) return d; }
  return `${path}: ${JSON.stringify(a)?.slice(0, 300)}  !=  ${JSON.stringify(b)?.slice(0, 300)}`;
};
const paneReady = `(() => { const p = document.querySelector('.compose-pane'); return !!p && !p.classList.contains('preparing') && !!p.querySelector('.cp-editor .tiptap .quote-block') && !!document.querySelector('.sig-select') && document.querySelector('.sig-select').value !== ''; })()`;

/** What the pane shows besides the message itself: the rows and their chips, the size line, the signature picker, the toggles, the note and the strip. */
const paneFacts = () => evaluate(String.raw`(() => { const p = document.querySelector('.compose-pane'); const t = (e) => e.textContent.replace(/\s+/g, ' ').trim();
  return JSON.stringify({ rows: [...p.querySelectorAll('.cp-fields .cf-field')].map((f) => t(f.querySelector('label')) + ': ' + [...f.querySelectorAll('.chips > span')].map(t).join(' | ')), links: !!p.querySelector('.cf-links'), subject: p.querySelector('.cf-subject input').value,
    tail: t(p.querySelector('.cp-tail')), sig: p.querySelector('.sig-select')?.value, sigText: t(p.querySelector('.sig-body') || document.body).slice(0, 60), toggles: [...p.querySelectorAll('.cp-bar [aria-pressed]')].map((b) => t(b) + '=' + b.getAttribute('aria-pressed')),
    note: p.querySelector('.cf-replyto') ? t(p.querySelector('.cf-replyto')) : null, strip: p.querySelector('.sec-strip') ? p.querySelector('.sec-strip').className + ' ' + t(p.querySelector('.sec-strip')) : null, atts: [...p.querySelectorAll('.atts .att-chip')].map(t), classes: p.className.replace(/\s+/g, ' ').trim() }); })()`).then(JSON.parse);

/** Types a word in the body, presses Send and returns the draft the outbox was given (and what the pane showed just before). */
async function sendIt(encrypted) {
  // a forward starts without a recipient: one is typed (a comma ends the address)
  const chips = `document.querySelectorAll('.cf-field.rcpt .chips > span').length`;
  if (await evaluate(`${chips} === 0`)) {
    for (let i = 0; i < 3 && (await evaluate(`${chips} === 0`)); i++) {
      await evaluate(`document.querySelector('.cf-field.rcpt input').focus(); 1`);
      await H.cdp('Input.insertText', { text: 'qa@example.com,' });
      await waitFor(`${chips} > 0`, 1500);
    }
    assert.ok(await evaluate(`${chips} > 0`), 'the recipient was not typed');
  }
  await sleep(encrypted ? 1200 : 900); // (the key status of the recipients is asked 250 ms after a change and decides Encrypt "automatic"; a draft taken before it is there differs)
  const facts = await paneFacts();
  await evaluate(`(() => { window.__sendCalls = []; const ed = document.querySelector('.cp-editor .tiptap').editor; ed.chain().focus('start').insertContent('Thanks, noted.').run(); return 1; })()`);
  await sleep(100);
  assert.ok(await evaluate(`(() => { const b = document.querySelector('.cp-bar button.btn.primary'); if (!b || b.disabled) return false; b.click(); return true; })()`), 'no enabled Send button');
  assert.ok(await waitFor(`(window.__sendCalls || []).some((c) => c.cmd === 'hold')`, 8000), `the message was not handed to the outbox (toasts: ${await evaluate(`JSON.stringify(window.__store.getState().toasts.map((t) => typeof t.text === 'string' ? t.text : '?'))`)}; dialog: ${await evaluate(`JSON.stringify(window.__store.getState().dialog)`)})`);
  return { draft: mask(await evaluate(`(window.__sendCalls.find((c) => c.cmd === 'hold')).draft`)), facts };
}
async function closeAll() {
  await evaluate(`window.__store.getState().openCompose(null, { restore: false }); 1`);
  await sleep(150);
}

try {
  await H.openApp('lang=en', 1280, 800);
  assert.ok(await evaluate(FIXTURES), 'the fixtures were not added');
  await evaluate(`window.__store.getState().refresh().then(() => 1)`);
  for (const [name, thread, button, prefs] of CASES) {
    try {
      await closeAll();
      await evaluate(`window.__store.getState().setPrefs({ signatureOnReply: true, ...${JSON.stringify(prefs)} }); window.__mockDelays = { replyHeaders: 60, quote: 5 }; 1`);
      await evaluate(`window.__store.getState().select(${JSON.stringify(thread)}); 1`);
      assert.ok(await waitFor(`!!document.querySelector('.rp-msg.open button')`, 20000), 'the message did not open');
      await sleep(300);
      assert.ok(await evaluate(`(() => { const b = [...document.querySelectorAll('.rp-msg.open button')].find((x) => (x.getAttribute('aria-label') || x.textContent).trim() === ${JSON.stringify(button)}); if (!b) return false; b.click(); return true; })()`), `no ${button} button`);
      assert.ok(await waitFor(paneReady, 15000), 'the message never filled in');
      const full = await evaluate(`JSON.stringify(window.__store.getState().compose)`);
      const placed = await sendIt(name === 'encrypted reply');
      const inPlace = placed.draft;
      await closeAll();
      // the same finished message, mounted fresh (new Compose, new editor)
      await evaluate(`window.__store.getState().openCompose(JSON.parse(${JSON.stringify(full)})); 1`);
      assert.ok(await waitFor(paneReady, 15000), 'the fresh mount never showed the message');
      const again = await sendIt(name === 'encrypted reply');
      const d = firstDiff(inPlace, again.draft);
      assert.equal(d, null, `the filled-in message and the fresh mount differ at ${d}`);
      const df = firstDiff(placed.facts, again.facts);
      assert.equal(df, null, `what the pane shows differs between the filled-in message and the fresh mount at ${df}`);
      // what a person expects to find in it
      assert.ok(inPlace.html.includes('Thanks, noted.'), 'the typed word is in the message');
      assert.ok(/hl-quote|quote/.test(inPlace.html), 'the quote is in the message');
      if (name === 'reply all with Cc') assert.deepEqual(inPlace.cc, ['chi@example.com', 'dung@example.com'], 'the Cc recipients');
      if (name === 'forward with 3 attachments') assert.equal(inPlace.attachments.length, 3, 'the 3 files come along');
      if (name === 'quote with pictures') assert.ok(inPlace.html.includes('Pictures:'), 'the text of the original is quoted'); // (the mock's picture data is not a picture: what the quote does with the pictures is the same on both sides)
      if (name === 'Reply-To note') assert.ok(inPlace.to.some((x) => /support@acme/.test(x)), 'the answer goes to Reply-To');
      if (name === 'signature above the quote') assert.ok(inPlace.html.indexOf('Hey Look!') > 0 && inPlace.html.indexOf('Hey Look!') < inPlace.html.search(/hl-quote/), 'the signature is above the quote');
      if (name === 'no signature on replies') assert.ok(!inPlace.html.includes('Hey Look!'), 'no signature');
      if (name === 'confidential reply') assert.equal(inPlace.confidential, true, 'confidential');
      if (name === 'encrypted reply') assert.ok(inPlace.security?.encrypt, 'the answer to encrypted mail is encrypted');
      out[name] = inPlace;
      out[`${name} (pane)`] = placed.facts;
      console.log(`  ok  ${name}`);
    } catch (e) {
      failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ').slice(0, 900)}`);
      console.error('FAIL', failures.at(-1));
    }
  }
  if (arg('out')) fs.writeFileSync(arg('out'), JSON.stringify(out, null, 1));
  if (arg('ref')) {
    // the drafts another build made (--out of that build): the same now
    const ref = JSON.parse(fs.readFileSync(arg('ref'), 'utf8'));
    for (const [name, draft] of Object.entries(out)) { const d = firstDiff(ref[name], draft); if (d) { failures.push(`${name}: differs from the reference build at ${d}`); console.error('FAIL', failures.at(-1)); } }
  }
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-reply-golden: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-reply-golden: ok');
