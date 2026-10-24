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
let tag = '';
const ok = (cond, msg) => { checks++; if (!cond) { failures.push((tag ? '[' + tag + '] ' : '') + msg); console.error('FAIL', msg); } return !!cond; };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between renders */ } await sleep(40); } return false; };
const calls = () => evaluate(`(window.__aiModelsCalls || []).map((c) => c.endpoint + (c.keySent ? ' +key' : ''))`);
const count = async () => (await calls()).length;
const insert = (text) => cdp('Input.insertText', { text });
const focusField = (id) => evaluate(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.focus(); e.select && e.select(); return 1; })()`);
const backspace = async () => { await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }); };
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
  const url0 = await evaluate(`document.getElementById('set-aiBaseUrl').value`);
  await insert('/');
  ok((await evaluate(`document.getElementById('set-aiBaseUrl').value`)) === url0 + '/', 'the / is typed');
  await backspace();
  ok((await evaluate(`document.getElementById('set-aiBaseUrl').value`)) === url0, 'and taken back');
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
  // ------------------------------------------------------------------ W8.11: the model list URL
  await evaluate(`(async () => { const i = window.__TAURI_INTERNALS__.invoke; await i('set_setting', { key: 'ai_endpoint', value: 'http://127.0.0.1:31841/v1' }); await i('set_setting', { key: 'ai_model', value: 'qa-stub-model' }); await i('set_setting', { key: 'ai_models_url', value: '' }); await i('set_setting', { key: 'ai_models_key_origin', value: '' }); await i('set_secret', { name: 'ai_key', value: 'qa-key-1' }); window.__aiModelsCalls = []; return 1; })()`);
  const last = () => evaluate(`window.__aiModelsCalls[window.__aiModelsCalls.length - 1]`);
  const rects = () => evaluate(`['set-aiBaseUrl', 'set-aiKey', 'set-aiModel'].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 10) / 10); }).concat([[...document.querySelectorAll('.ai-actions .btn, .ai-status')].map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 10) / 10); })]).concat([[document.querySelector('.modal').getBoundingClientRect().height, document.querySelector('.settings-body').scrollTop]])`);
  const setField = async (id, text) => { await focusField(id); await insert(text); };
  const models = () => evaluate(`(() => { const e = document.getElementById('set-aiModel'); return e.tagName === 'SELECT' ? [...e.options].map((o) => o.value).filter(Boolean) : null; })()`);
  const slot = () => evaluate(`document.querySelector('.ai-status').textContent`);
  const warning = () => evaluate(`(() => { const d = document.querySelector('details.advanced'); const w = [...d.querySelectorAll('.muted.small')].find((e) => e.textContent.includes('not the Base URL')); const sw = d.querySelector('.switch input'); return w ? { text: w.textContent, label: sw ? sw.closest('.switch').textContent : null, on: sw ? sw.checked : null } : null; })()`);
  const setting = (key) => evaluate(`window.__TAURI_INTERNALS__.invoke('get_setting', { key: ${JSON.stringify(key)} })`);
  tag = 'W8.11';

  // AC-8.11.1 (the place changed in fix53): Advanced sits between Model and Save, closed; opening it moves nothing above it, and Save with its status slot go down by what the disclosure grew
  await openAiTab();
  await settle();
  ok((await count()) === 1 && (await last()).url === 'http://127.0.0.1:31841/v1/models' && (await last()).keySent === true, `AC-8.11.1: the automatic request, as before (${JSON.stringify(await last())})`);
  ok(await evaluate(`(() => { const d = document.querySelector('.settings-body details.advanced'); return !!d && !d.open && d.parentElement.classList.contains('form') && d.previousElementSibling === document.getElementById('set-aiModel') && d.nextElementSibling === document.querySelector('.ai-actions') && d.nextElementSibling === d.parentElement.lastElementChild; })()`), 'Advanced is closed, right after Model and right before Save, and Save with its status slot are the last thing of the form');
  const before = await rects();
  const advH = () => evaluate(`document.querySelector('details.advanced').getBoundingClientRect().height`);
  const advBefore = await advH();
  let opened = null; // (the rects with Advanced open and empty)
  await click('details.advanced summary');
  ok(await waitFor(`document.querySelector('details.advanced').open`), 'Advanced opens');
  ok((await evaluate(`document.getElementById('set-aiModelsUrl').placeholder`)) === 'http://127.0.0.1:31841/v1/models', 'the placeholder is the automatic address');
  ok(await evaluate(`document.getElementById('set-aiModelsUrl').value === '' && document.getElementById('set-aiModelsUrlHint').textContent.startsWith('Leave empty')`), 'an empty box and the hint');
  {
    const after = opened = await rects(), grew = (await advH()) - advBefore;
    ok(JSON.stringify(after.slice(0, 3)) === JSON.stringify(before.slice(0, 3)), `Base URL, key and Model did not move when Advanced opened (${JSON.stringify(before.slice(0, 3))} / ${JSON.stringify(after.slice(0, 3))})`);
    ok(grew > 20 && after[3].every((r, i) => r[0] === before[3][i][0] && r[2] === before[3][i][2] && r[3] === before[3][i][3] && Math.abs(r[1] - before[3][i][1] - grew) <= 1), `Save and the status slot moved down by what Advanced grew (${grew} px: ${JSON.stringify(before[3])} / ${JSON.stringify(after[3])})`);
    ok(after[4][0] === before[4][0], `the dialog kept its height (${before[4][0]} / ${after[4][0]})`);
  }
  // AC-8.11.2
  await setField('set-aiModelsUrl', '/api/tags');
  await settle();
  ok((await count()) === 2 && (await last()).url === 'http://127.0.0.1:31841/api/tags' && (await last()).keySent === true, `AC-8.11.2: /api/tags: one request with the key (${JSON.stringify(await last())}, ${await count()} in all)`);
  ok((await models()).includes('llama3.2:latest') && (await models()).includes('qwen2.5:7b'), `Model lists the models of /api/tags (${JSON.stringify(await models())})`);
  ok((await warning()) === null, 'no warning for the same server');
  ok(JSON.stringify(await rects()) === JSON.stringify(opened), 'and nothing moved while typing (no warning yet: Advanced did not grow)');
  // AC-8.11.3
  await setField('set-aiModelsUrl', '/model/info');
  await settle();
  ok((await models()).includes('litellm-claude') && (await models()).includes('litellm-gpt'), `AC-8.11.3: /model/info lists litellm-claude and litellm-gpt (${JSON.stringify(await models())})`);
  await setField('set-aiModelsUrl', 'http://127.0.0.1:31841/openai/models?api-version=2024-10-21');
  await settle();
  ok((await last()).url === 'http://127.0.0.1:31841/openai/models?api-version=2024-10-21' && (await last()).keySent === true && (await models()).includes('azure-dep-1') && (await warning()) === null, `an absolute URL on the same server: its query, the key, azure-dep-1, no warning (${JSON.stringify(await last())})`);
  // AC-8.11.4: another server: the warning, the switch off, no key; the switch on: one more request with the key
  let n0 = await count();
  await setField('set-aiModelsUrl', 'http://127.0.0.1:31842/v1/models');
  await settle();
  const w = await warning();
  ok(w && w.text.startsWith('127.0.0.1:31842 is not the Base URL’s server. The API key is sent there only if you allow it.') && w.label === 'Send the API key to 127.0.0.1:31842' && w.on === false, `AC-8.11.4: the warning and the switch (off) (${JSON.stringify(w)})`);
  ok((await count()) === n0 + 1 && (await last()).keySent === false && (await last()).url === 'http://127.0.0.1:31842/v1/models', `one request, without the key (${JSON.stringify(await last())})`);
  ok(JSON.stringify((await rects()).slice(0, 3)) === JSON.stringify(before.slice(0, 3)), 'nothing above Advanced moved when the warning appeared (Save goes down by the warning)');
  n0 = await count();
  await click('details.advanced .switch');
  await settle();
  ok((await count()) === n0 + 1 && (await last()).keySent === true && (await models()).includes('gpt-4o'), `the switch on: one more request, with the key (${JSON.stringify(await last())})`);
  // AC-8.11.5: Save keeps the permission; reopening shows Advanced open with the switch on; another port turns it off
  n0 = await count();
  await click('.ai-actions .btn.primary');
  ok(await waitFor(`window.__store.getState().toasts.some((t) => (t.textFn ? t.textFn() : t.text) === 'AI Assistant settings saved')`, 4000), 'AC-8.11.5: Save: the toast');
  await sleep(3000);
  ok((await count()) === n0, `and no new request within 3 s (${await count()} / ${n0})`);
  ok((await setting('ai_models_url')) === 'http://127.0.0.1:31842/v1/models' && (await setting('ai_models_key_origin')) === 'http://127.0.0.1:31842', 'the list URL and the permission (an origin) are stored');
  n0 = await count();
  await openAiTab();
  await settle();
  ok((await evaluate(`document.querySelector('details.advanced').open && document.getElementById('set-aiModelsUrl').value === 'http://127.0.0.1:31842/v1/models'`)) && (await warning()).on === true, 'reopened: Advanced is open, the URL is there, the switch is on');
  ok((await count()) === n0 + 1 && (await last()).keySent === true, `and one request with the key (${JSON.stringify(await last())})`);
  await setField('set-aiModelsUrl', 'http://127.0.0.1:31843/v1/models');
  await settle();
  const w2 = await warning();
  ok(w2 && w2.label === 'Send the API key to 127.0.0.1:31843' && w2.on === false, `another port: the switch names it and is off (${JSON.stringify(w2)})`);
  ok((await last()).keySent === false && /Could not load the model list/.test(await slot()), `the slot says the list could not be loaded, no key went (${await slot()})`);
  // AC-8.11.8: invalid values: after 0.6 s the slot says so, nothing is asked, Model is a text box, Save works
  for (const bad of ['models', 'ftp://127.0.0.1/x', '//127.0.0.1:31841/v1/models', 'javascript:alert(1)']) {
    n0 = await count();
    await setField('set-aiModelsUrl', bad);
    await settle();
    ok((await slot()) === 'The model list URL must start with “https://”, “http://” or “/”.' && (await count()) === n0, `AC-8.11.8: "${bad}": the slot says so and nothing is asked (${await slot()})`);
  }
  ok((await evaluate(`document.getElementById('set-aiModel').tagName`)) === 'INPUT', 'Model is a text box');
  await evaluate(`window.__store.setState({ toasts: [] }); 1`);
  await click('.ai-actions .btn.primary');
  ok(await waitFor(`window.__store.getState().toasts.some((t) => (t.textFn ? t.textFn() : t.text) === 'AI Assistant settings saved')`, 4000), 'Save is not blocked by an invalid list URL');
  ok((await setting('ai_models_url')) === 'javascript:alert(1)' && (await setting('ai_models_key_origin')) === '', 'the value is stored as typed, and no permission');
  // AC-8.11.12: back to automatic
  n0 = await count();
  await focusField('set-aiModelsUrl');
  await backspace();
  await settle();
  ok((await count()) === n0 + 1 && (await last()).url === 'http://127.0.0.1:31841/v1/models', `AC-8.11.12: the field cleared: the automatic request (${JSON.stringify(await last())})`);
  // AC-8.11.13: letter by letter: one request; Save twice: none
  n0 = await count();
  await focusField('set-aiModelsUrl');
  for (const ch of '/api/tags') { await cdp('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }); await sleep(20); }
  await settle();
  ok((await count()) === n0 + 1, `AC-8.11.13: /api/tags typed quickly: one request (${(await count()) - n0})`);
  await click('.ai-actions .btn.primary');
  await sleep(2500);
  await click('.ai-actions .btn.primary');
  await sleep(2500);
  ok((await count()) === n0 + 1, 'Save twice: no request');
  tag = '';
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
