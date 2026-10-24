#!/usr/bin/env node
// Settings > AI Assistant asks for the model list only when the request changed (W8.2; extended with the model list URL by W8.11), in the real page: the dev preview counts every
// (Port 5063, not the reserved 5060: Chrome refuses 5060 and 5061, the SIP ports, as unsafe.) `ai_list_models` of the page in `window.__aiModelsCalls` ({ endpoint, keySent }). Real keyboard input and real clicks.
//   AC-8.2.1  open the tab: 1 request; a typed key: 2 (the second with a key); Save: still 2 after 3 s, the toast, the list is still there
//   AC-8.2.2  Save again: still 2
//   AC-8.2.3  a trailing / added and taken back inside 600 ms: nothing; another Base URL: +1
//   AC-8.2.4  "Remove the saved key": +1, without a key
//   AC-8.2.5  close and reopen the tab: +1
//
//   node scripts/test-ai-models-once.mjs [--require-browser | --url=http://127.0.0.1:1420/]
import { inputs, sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-ai-models-once', { vitePort0: 5063, cdpPort0: 9063 });
const { evaluate, cdp } = H;
const { click, press } = inputs(H, null, 'ai-once');
const failures = [];
let checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failures.push(msg); console.error('FAIL', msg); } return !!cond; };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between renders */ } await sleep(40); } return false; };
const calls = () => evaluate(`(window.__aiModelsCalls || []).map((c) => c.endpoint + (c.keySent ? ' +key' : ''))`);
const count = async () => (await calls()).length;
const insert = (text) => cdp('Input.insertText', { text });
const focusField = (id) => evaluate(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.focus(); e.select && e.select(); return 1; })()`);
const settle = (ms = 1700) => sleep(ms); // (the 600 ms of rest and the 60 ms answer of the preview, with room for a slow machine)
const toasts = () => evaluate(`window.__store.getState().toasts.map((t) => t.textFn ? t.textFn() : t.text)`);

async function openAiTab() {
  await evaluate(`window.__store.getState().setDialog(null); 1`);
  await waitFor(`!document.querySelector('.modal')`);
  await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'ai', nonce: Date.now() }); 1`);
  await waitFor(`!!document.getElementById('set-aiBaseUrl')`);
}

try {
  await H.openApp('lang=en&modelsms=60', 1280, 800);
  await evaluate(`(async () => { const i = window.__TAURI_INTERNALS__.invoke; await i('set_setting', { key: 'ai_endpoint', value: 'https://ai.example.com/v1' }); await i('set_setting', { key: 'ai_model', value: 'gpt-4o' }); await i('set_secret', { name: 'ai_key', value: '' }); return 1; })()`);
  await evaluate(`window.__aiModelsCalls = []; 1`);

  // AC-8.2.1
  await openAiTab();
  await settle();
  ok((await count()) === 1, `opening the tab asks once (${JSON.stringify(await calls())})`);
  ok((await evaluate(`window.__aiModelsCalls[0].keySent`)) === false, 'the first request has no key');
  await focusField('set-aiKey');
  await insert('qa-key-1');
  await settle();
  ok((await count()) === 2 && (await evaluate(`window.__aiModelsCalls[1].keySent`)) === true, `a typed key: 2 requests, the second with a key (${JSON.stringify(await calls())})`);
  await click('.ai-actions .btn.primary');
  ok(await waitFor(`window.__store.getState().toasts.some((t) => (t.textFn ? t.textFn() : t.text) === 'AI Assistant settings saved')`, 4000), `the toast "AI Assistant settings saved" (${JSON.stringify(await toasts())})`);
  await sleep(3000);
  ok((await count()) === 2, `Save: still 2 after 3 s (${JSON.stringify(await calls())})`);
  ok(await evaluate(`!!document.getElementById('set-aiModel') && document.getElementById('set-aiModel').tagName === 'SELECT' && document.getElementById('set-aiModel').options.length > 1`), 'the model list is still there');
  ok(await evaluate(`document.getElementById('set-aiKey').value === ''`), 'the key box was emptied by Save');
  // AC-8.2.2
  await click('.ai-actions .btn.primary');
  await sleep(2500);
  ok((await count()) === 2, `AC-8.2.2: Save again: still 2 (${JSON.stringify(await calls())})`);
  // AC-8.2.3: a trailing / added and taken back inside the debounce
  await focusField('set-aiBaseUrl');
  await evaluate(`(() => { const e = document.getElementById('set-aiBaseUrl'); e.setSelectionRange(e.value.length, e.value.length); return 1; })()`);
  await insert('/');
  await press('Backspace', 'Backspace');
  await settle();
  ok((await count()) === 2, `AC-8.2.3: a trailing / added and taken back: nothing (${JSON.stringify(await calls())})`);
  await focusField('set-aiBaseUrl');
  await insert('https://ai2.example.com/v1');
  await settle();
  ok((await count()) === 3 && (await calls())[2].startsWith('https://ai2.example.com/v1'), `another Base URL: +1 (${JSON.stringify(await calls())})`);
  // letter by letter, quickly: one request when the typing rests
  await focusField('set-aiBaseUrl');
  for (const ch of 'https://ai3.example.com/v1') { await cdp('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }); await sleep(20); }
  await settle();
  ok((await count()) === 4, `typed letter by letter: one request (${JSON.stringify(await calls())})`);
  // AC-8.2.4
  await click('.field-head .link');
  await settle();
  ok((await count()) === 5 && (await evaluate(`window.__aiModelsCalls[4].keySent`)) === false, `AC-8.2.4: Remove the saved key: +1, without a key (${JSON.stringify(await calls())})`);
  // AC-8.2.5
  await openAiTab();
  await settle();
  ok((await count()) === 6, `AC-8.2.5: the tab opened again: +1 (${JSON.stringify(await calls())})`);
  console.log(`test-ai-models-once: ${checks} checks`);
} catch (e) {
  failures.push(e.stack || String(e));
} finally {
  await H.shutdown();
}
if (failures.length) {
  console.error(`test-ai-models-once: FAILED (${failures.length})\n  ` + failures.slice(0, 20).join('\n  '));
  process.exit(1);
}
console.log('test-ai-models-once: ok');
