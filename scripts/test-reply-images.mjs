#!/usr/bin/env node
// 1.0.8: the pictures of the original that a Reply / Reply all / Forward quotes (owner bug: "when I reply to an email that contains images, all images fail to load").
//
// Before: the composer never requested a picture from the web, whatever the setting, so the quote of a GitHub Actions notification (five https pictures) showed five empty boxes with the
// alt text although the reading pane showed the pictures. Now the quote follows the reading pane's rule (Settings > Reading > Load remote content of the account):
//   - allowed: the backend fetches the pictures (api.fetchRemoteImages, the cache the reading pane fills too) and the quote draws the data: copies; the webview requests nothing
//     itself (the page is hermetic: scripts/lib/hermetic-net.mjs fails the test at exit when it does);
//   - not allowed (the default): a box of the size the mail gave (the reading pane's `hl-bp`), a note and "Load content" for this quote, which fetches them then; no backend call before;
//   - a picture that cannot be fetched stays a box (no note, no new call);
//   - the data: picture of the original is shown in both cases;
//   - the SENT message keeps the web address of every picture and carries no data: copy of it (the fetch is display only).
// Real Compose in the dev preview (src/devMock.ts, `fetch_remote_images`: every address answers except those with "unreachable"; `window.__remoteFetchCalls` lists the calls); the mail is
// scripts/fixtures/reply-images/github-actions.html (the owner's notification, condensed). The compose window (`?w=compose`) gets the same Compose and the same quote block; its capability
// grants fetch_remote_images (src-tauri/src/lib.rs capability_tests).
//   node scripts/test-reply-images.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sleep, startHarness } from './cdp-harness.mjs';
import { QUOTE_PROBE_JS } from './lib/reply-images-probe.mjs';

const H = await startHarness('test-reply-images', { vitePort0: 5890 });
const { evaluate } = H;
const failures = [];
// (with "Load remote content" on, the reading pane's frame may still ask for a picture itself while the backend fetch is on its way: that old fallback is answered here; what the test
// holds the QUOTE to is below: no web address in it, and no request at all while the rule says no)
H.net.stub = (url) => (/.png$/.test(url) ? { status: 200, type: 'image/png', body: '' } : undefined);
const check = async (name, fn) => { try { await fn(); console.log(`  ok  ${name}`); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ').slice(0, 900)}`); console.error('FAIL', failures.at(-1)); } };
const waitFor = async (js, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between two renders */ } await sleep(40); } return false; };

const GH = fs.readFileSync(new URL('./fixtures/reply-images/github-actions.html', import.meta.url), 'utf8');
const GH_URLS = [...GH.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
assert.equal(GH_URLS.length, 5, 'the fixture has five pictures');
const DATA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const MIXED = `<div><p>Mixed</p><img src="${DATA}" width="40" height="40" alt="inline"><img src="https://pictures.example.invalid/ok.png" width="60" height="30" alt="fine"><img src="https://pictures.example.invalid/unreachable.png" width="70" height="35" alt="gone"></div>`;

const FIXTURES = `(() => {
  const add = window.__mockAddThread;
  add('ri-gh', 'Run failed', { fromName: 'Nam Thai', fromEmail: 'notifications@github.com', html: ${JSON.stringify(GH)} });
  add('ri-mixed', 'Mixed pictures', { fromName: 'Linh Tran', fromEmail: 'linh@example.com', html: ${JSON.stringify(MIXED)} });
  return true;
})()`;

const quote = async () => JSON.parse(await evaluate(QUOTE_PROBE_JS));
const calls = async () => JSON.parse(await evaluate(`JSON.stringify(window.__remoteFetchCalls || [])`));
const paneReady = `(() => { const p = document.querySelector('.compose-pane'); return !!p && !p.classList.contains('preparing') && !!p.querySelector('.cp-editor .tiptap .quote-block') && !!p.querySelector('.quote-host')?.shadowRoot?.querySelector('.q > *'); })()`;

async function closeAll() {
  await evaluate(`window.__store.getState().openCompose(null, { restore: false }); 1`);
  await sleep(150);
}
/** Opens the mail and presses the answer button; resolves when the quote is in the editor. */
async function answer(thread, button, prefs = {}) {
  await closeAll();
  await evaluate(`window.__remoteFetchCalls = []; window.__store.getState().setPrefs({ loadRemote: false, ...${JSON.stringify(prefs)} }); window.__store.getState().select(${JSON.stringify(thread)}); 1`);
  assert.ok(await waitFor(`!!document.querySelector('.rp-msg.open button')`, 20000), 'the message did not open');
  await sleep(500);
  const reader = await calls(); // (the reading pane fetches the pictures itself when the rule allows)
  assert.ok(await evaluate(`(() => { const b = [...document.querySelectorAll('.rp-msg.open button')].find((x) => (x.getAttribute('aria-label') || x.textContent).trim() === ${JSON.stringify(button)}); if (!b) return false; b.click(); return true; })()`), `no ${button} button`);
  assert.ok(await waitFor(paneReady, 15000), 'the quote never showed');
  await sleep(600);
  return reader;
}
/** Sends the answer and returns the HTML of the draft the outbox was given. */
async function sentHtml() {
  const chips = `document.querySelectorAll('.cf-field.rcpt .chips > span').length`;
  if (await evaluate(`${chips} === 0`)) {
    for (let i = 0; i < 3 && (await evaluate(`${chips} === 0`)); i++) {
      await evaluate(`document.querySelector('.cf-field.rcpt input').focus(); 1`);
      await H.cdp('Input.insertText', { text: 'qa@example.com,' });
      await waitFor(`${chips} > 0`, 1500);
    }
  }
  await sleep(700);
  await evaluate(`(() => { window.__sendCalls = []; const ed = document.querySelector('.cp-editor .tiptap').editor; ed.chain().focus('start').insertContent('Thanks.').run(); return 1; })()`);
  await sleep(100);
  assert.ok(await evaluate(`(() => { const b = document.querySelector('.cp-bar button.btn.primary'); if (!b || b.disabled) return false; b.click(); return true; })()`), 'no enabled Send button');
  assert.ok(await waitFor(`(window.__sendCalls || []).some((c) => c.cmd === 'hold')`, 8000), 'the message was not handed to the outbox');
  return evaluate(`(window.__sendCalls.find((c) => c.cmd === 'hold')).draft.html`);
}
const keepsAddresses = (html, urls) => { for (const u of urls) assert.ok(html.includes(u), `the sent message lost ${u}`); assert.ok(!/src="data:image\/png;base64,[^"]{80,}"/.test(html.replace(DATA, '')), 'a fetched copy (data:) leaked into the sent message'); };

try {
  await H.openApp('lang=en', 1280, 800);
  assert.ok(await evaluate(FIXTURES), 'the fixtures were not added');
  await evaluate(`window.__store.getState().refresh().then(() => 1)`);

  // ---------- the rule does not allow (the default): boxes, a note, "Load content"
  for (const button of ['Reply', 'Reply all', 'Forward']) {
    await check(`${button}, remote pictures not allowed: five boxes of the sizes the mail gave, the note, no request`, async () => {
      H.net.reset();
      await answer('ri-gh', button);
      const q = await quote();
      assert.equal(q.imgs.length, 0, 'no <img> without an address');
      assert.deepEqual(q.boxes.map((b) => [b.w, b.h]), [[32, 48], [56, 56], [24, 24], [16, 16], [24, 24]], `boxes ${JSON.stringify(q.boxes)}`);
      assert.ok(q.boxes.every((b) => b.icon), 'every box has the reading pane icon');
      assert.deepEqual(q.boxes.map((b) => b.alt), ['GitHub', '', 'deploy', 'annotations for Pages / deploy', 'apt-live-check']);
      assert.match(q.note ?? '', /Pictures from the web are not shown/);
      assert.ok(q.load, 'a "Load content" button in the note');
      assert.equal(q.external, 0);
      assert.deepEqual(await calls(), [], 'nothing was fetched before the person asked');
      assert.deepEqual(H.net.requests, [], 'the page requested nothing from the network');
    });
  }
  await check('Load content: the five pictures are fetched once, drawn from data: copies, the note goes; the sent message keeps the https addresses', async () => {
    await answer('ri-gh', 'Reply');
    await evaluate(`document.querySelector('.compose-pane .quote-note button[data-act="load"]').click(); 1`);
    assert.ok(await waitFor(`(() => { const r = document.querySelector('.compose-pane .quote-host')?.shadowRoot; return !!r && r.querySelectorAll('img').length === 5; })()`, 8000), 'the pictures did not come in');
    const q = await quote();
    assert.ok(q.imgs.every((i) => i.data && i.loaded), `every picture is a loaded data: copy ${JSON.stringify(q.imgs)}`);
    assert.equal(q.boxes.length, 0);
    assert.equal(q.note, null, 'no note once they are shown');
    assert.equal(q.external, 0, 'the webview never holds an https address');
    const c = await calls();
    assert.equal(c.length, 1, `one backend call ${JSON.stringify(c)}`);
    assert.deepEqual(c[0].slice().sort(), GH_URLS.slice().sort());
    keepsAddresses(await sentHtml(), GH_URLS);
  });

  // ---------- the rule allows: the pictures are there without a click
  for (const button of ['Reply', 'Reply all', 'Forward']) {
    await check(`${button}, remote pictures allowed: the five pictures load on their own (data: copies), no note, the sent message keeps the addresses`, async () => {
      await answer('ri-gh', button, { loadRemote: true });
      assert.ok(await waitFor(`(() => { const r = document.querySelector('.compose-pane .quote-host')?.shadowRoot; return !!r && r.querySelectorAll('img').length === 5 && [...r.querySelectorAll('img')].every((i) => i.complete && i.naturalWidth > 0); })()`, 8000), 'the pictures did not load');
      const q = await quote();
      assert.equal(q.boxes.length, 0);
      assert.equal(q.note, null);
      assert.ok(!q.load);
      assert.equal(q.external, 0);
      keepsAddresses(await sentHtml(), GH_URLS);
    });
  }
  await check('the reading pane and the quote share the fetch: Reply after reading asks the backend for nothing more', async () => {
    await closeAll();
    // (a mail the cache has not seen: the reading pane fetches, then the Reply finds them in the cache)
    await evaluate(`window.__mockAddThread('ri-gh2', 'Run failed again', { fromName: 'Nam Thai', fromEmail: 'notifications@github.com', html: ${JSON.stringify(GH.replaceAll('githubassets.com/assets/', 'githubassets.com/assets/2-'))} }); window.__store.getState().refresh().then(() => 1)`);
    await sleep(300);
    const reader = (await answer('ri-gh2', 'Reply', { loadRemote: true })).length;
    assert.ok(await waitFor(`document.querySelector('.compose-pane .quote-host')?.shadowRoot?.querySelectorAll('img').length === 5`, 8000));
    const c = await calls();
    assert.equal(c.length, reader, `the Reply made no call of its own (reading pane: ${reader}, total: ${c.length})`);
  });
  await check('a per-account override wins over the global rule', async () => {
    await answer('ri-gh', 'Reply', { loadRemote: false, accountPrefs: { a1: { loadRemote: true } } });
    assert.ok(await waitFor(`document.querySelector('.compose-pane .quote-host')?.shadowRoot?.querySelectorAll('img').length === 5`, 8000), 'the override of the account was not followed');
    await evaluate(`window.__store.getState().setPrefs({ accountPrefs: {} }); 1`);
  });

  // ---------- a data: picture, a picture that loads and one that cannot
  await check('rule off: the data: picture shows, the web pictures are boxes', async () => {
    await answer('ri-mixed', 'Reply');
    const q = await quote();
    assert.equal(q.imgs.length, 1);
    assert.ok(q.imgs[0].data && q.imgs[0].loaded, 'the inline picture');
    assert.equal(q.boxes.length, 2);
    assert.ok(q.load);
  });
  await check('rule on: the data: picture and the fetched one show; the unreachable one stays a box without a note and is asked for once', async () => {
    const before = (await answer('ri-mixed', 'Reply', { loadRemote: true })).flat().filter((u) => u.includes('unreachable')).length; // (the reading pane asks for it itself, as often as it draws the mail)
    assert.ok(await waitFor(`document.querySelector('.compose-pane .quote-host')?.shadowRoot?.querySelectorAll('img').length === 2`, 8000), 'the pictures did not come in');
    await sleep(500);
    const q = await quote();
    assert.ok(q.imgs.every((i) => i.data && i.loaded));
    assert.deepEqual(q.boxes.map((b) => [b.alt, b.pending]), [['gone', false]]);
    assert.equal(q.note, null);
    const c = (await calls()).flat().filter((u) => u.includes('unreachable')).length - before;
    assert.ok(c <= 1, `the quote asked for the unreachable picture ${c} times`);
    keepsAddresses(await sentHtml(), ['https://pictures.example.invalid/ok.png', 'https://pictures.example.invalid/unreachable.png']);
  });

  // ---------- the compose window: the same Compose, the same quote
  await check('compose window (?w=compose): the same quote follows the rule', async () => {
    await answer('ri-gh', 'Reply');
    const full = await evaluate(`JSON.stringify(window.__store.getState().compose)`);
    await H.cdp('Page.navigate', { url: 'about:blank' });
    await H.cdp('Page.navigate', { url: `${H.base}?w=compose&mock=new#lang=en` });
    assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor`, 20000), 'the window did not start');
    await sleep(900);
    await evaluate(`window.__remoteFetchCalls = []; window.__store.getState().setPrefs({ loadRemote: true }); window.__store.getState().openCompose(JSON.parse(${JSON.stringify(full)})); 1`);
    assert.ok(await waitFor(paneReady, 15000), 'the quote never showed in the window');
    assert.ok(await waitFor(`document.querySelector('.compose-pane .quote-host')?.shadowRoot?.querySelectorAll('img').length === 5`, 8000), 'the pictures did not load in the window');
    assert.equal((await quote()).external, 0);
  });
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-reply-images: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-reply-images: ok');
