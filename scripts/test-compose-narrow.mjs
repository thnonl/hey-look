#!/usr/bin/env node
// The message pane is not squeezed next to the list in a narrow window (1.0.7 W2.26). At 960 px the inline Compose was 308 to 500 px wide next to the list column.
// Now, in the Mail module with the reading pane on the right, with a message open inline and the window narrower than 1100 px (the side menu's breakpoint), the list
// and its splitter are hidden (grid column 0, no Tab stop, `inert`) and Compose takes their width. The list is back with its saved width when the message closes, when
// the window is 1100 px or wider, or when the person asks for it (a folder pressed - also the current one -, a search started, Ctrl/Cmd+1).
//   Part 1 (static): the pure rule `listHiddenWhileComposing` and the wiring.
//   Part 2 (real Compose in the dev preview, a browser is needed): 946 x 552 and 1280 x 800 and the way back.
//   node scripts/test-compose-narrow.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AUTO_COLLAPSE_BELOW, listHiddenWhileComposing } from '../src/sidebarState.ts';
import { sleep, startHarness } from './cdp-harness.mjs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// ---------- part 1: the rule
{
  const base = { width: 960, readingPane: 'right', module: 'mail', composeOpen: true, listAsked: false };
  const hidden = (o) => listHiddenWhileComposing({ ...base, ...o });
  assert.equal(AUTO_COLLAPSE_BELOW, 1100, 'the breakpoint of the side menu is the one of this rule');
  assert.equal(hidden({}), true, 'a message open inline at 960 px: no list');
  assert.equal(hidden({ width: 946 }), true);
  assert.equal(hidden({ width: 1099 }), true);
  assert.equal(hidden({ width: 1100 }), false, '1100 px and wider: list and message side by side');
  assert.equal(hidden({ width: 1280 }), false);
  assert.equal(hidden({ composeOpen: false }), false, 'no message: the list');
  assert.equal(hidden({ readingPane: 'bottom' }), false, 'reading pane below: the message has the full width already');
  assert.equal(hidden({ module: 'calendar' }), false, 'not in the Calendar');
  assert.equal(hidden({ listAsked: true }), false, 'the person asked for the list');
  assert.equal(hidden({ width: 600 }), true, 'any narrower window');
  // the way the world changes: asked, then the message closes (the store clears the request), then a new message
  assert.equal(hidden({ listAsked: true, composeOpen: false }), false);
  assert.equal(hidden({ width: 1000, listAsked: false }), true, 'narrowed again: hidden again (the person did not ask)');
}

// ---------- part 1: the wiring
{
  const app = read('src/App.tsx');
  const store = read('src/store.ts');
  const css = read('src/App.css');
  const list = read('src/components/MessageList.tsx');
  assert.match(app, /const listHidden = listHiddenWhileComposing\(\{ width, readingPane, module, composeOpen: !!compose, listAsked \}\);/, 'App decides from the width, the setting, the module, the message and the request');
  assert.match(app, /\$\{listHidden \? "list-hidden" : ""\}/, 'the workspace gets the class');
  assert.match(app, /<MessageList hidden=\{listHidden\} \/>/);
  assert.match(list, /inert=\{hidden \|\| undefined\}/, 'the hidden list takes no Tab stop');
  assert.match(css, /\.workspace\.list-hidden \{ grid-template-columns: var\(--fw, 248px\) 6px 0 0 1fr; \}/, 'the column is 0, the saved --lw is not touched');
  assert.match(css, /\.workspace\.list-hidden > \.msg-list, \.workspace\.list-hidden > \.splitter\[data-which="list"\] \{[^}]*visibility: hidden/, 'hidden after the glide');
  assert.ok(/\.workspace \{ transition: grid-template-columns \.2s/.test(css), 'the existing grid transition is the animation');
  assert.ok(!/\.workspace\.list-hidden[^{]*\{[^}]*--lw/.test(css) && !app.includes('setPrefs({ listW: 0'), 'prefs.listW stays untouched');
  // the ways to ask for the list, and the ways it is let go
  assert.match(store, /listAsked: false,\n  askList: \(\) => set\(\{ listAsked: true \}\),/);
  assert.match(store, /set\(\{ compose, composeKey: get\(\)\.composeKey \+ 1, listAsked: false,/, 'closing a message or opening another clears the request');
  assert.match(store, /search: "", module: "mail", \.\.\.\(get\(\)\.compose \? \{ listAsked: true \} : \{\}\) \}\);/, 'a folder pressed (also the current one: setView runs for it)');
  assert.match(store, /\.\.\.\(search\.trim\(\) && get\(\)\.compose \? \{ listAsked: true \} : \{\}\) \}\);/, 'a search started');
  assert.match(app, /st\.askList\(\);/, 'Ctrl/Cmd+1');
}

// ---------- part 2: the real pane
const H = await startHarness('test-compose-narrow', { vitePort0: 5980, cdpPort0: 9980 });
const { evaluate } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${e.message.replace(/\s+/g, ' ')}`); console.error('FAIL', failures.at(-1).slice(0, 500)); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(js)) return true; await sleep(100); } return false; };
const json = (js) => evaluate(`JSON.stringify(${js})`).then((s) => JSON.parse(s));
const resize = (w, h) => H.cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
const geometry = () => json(`(() => { const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.left), w: Math.round(b.width), h: Math.round(b.height) }; }; const list = document.querySelector('.workspace > .msg-list'); const ws = document.querySelector('.workspace'); return { pane: r(document.querySelector('.compose-pane')), list: r(list), listInert: list?.hasAttribute('inert') ?? null, listVis: list ? getComputedStyle(list).visibility : null, hiddenClass: ws.classList.contains('list-hidden'), cols: getComputedStyle(ws).gridTemplateColumns, listW: window.__store.getState().prefs.listW, menu: r(document.querySelector('.folder-pane')) }; })()`);
const settle = async () => { await sleep(500); };
const openMail = async (extra = '') => {
  await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Narrow' ${extra}}); 1`);
  assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor`, 15000), 'compose did not start');
  await sleep(900);
};
const type = (text) => evaluate(`(() => { const ed = document.querySelector('.cp-editor .tiptap').editor; ed.commands.focus('end'); ed.commands.insertContent(${JSON.stringify(text)}); document.querySelector('.cp-editor .tiptap').setAttribute('data-marker', 'same'); return 1; })()`);
const bodyText = () => evaluate(`document.querySelector('.cp-editor .tiptap')?.editor.getText()`);
const press = async (k, code, vk, modifiers = 0) => {
  await H.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await H.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
};

try {
  // ---------- 946 x 552: auto menu (icons)
  await H.openApp('lang=en', 946, 552);
  const listW0 = await json(`window.__store.getState().prefs.listW`);
  const before = await geometry();
  assert.ok(before.list.w >= 300, `the list has its width before writing: ${JSON.stringify(before)}`);
  await openMail();
  await type(' text that stays');
  await settle();
  await check('946: the list is hidden, the pane is at least 560 px wide', async () => {
    const g = await geometry();
    assert.equal(g.hiddenClass, true);
    assert.ok(g.pane.w >= 560, `pane ${g.pane.w} px`);
    assert.equal(g.list.w, 0, JSON.stringify(g));
    assert.equal(g.listInert, true);
    assert.equal(g.listVis, 'hidden');
    assert.equal(g.listW, listW0, 'the saved width is untouched');
  });
  await check('946: Shift+Tab from the body never lands in the hidden list', async () => {
    await evaluate(`document.querySelector('.cp-editor .tiptap').editor.commands.focus(); 1`);
    for (let i = 0; i < 40; i++) {
      await press('Tab', 'Tab', 9, 8);
      const inList = await evaluate(`!!document.activeElement?.closest('.msg-list')`);
      assert.equal(inList, false, `step ${i}: the focus is in the hidden list`);
    }
    assert.equal(await evaluate(`document.querySelectorAll('.workspace > .msg-list button:not([disabled]), .workspace > .msg-list [tabindex]').length > 0 && [...document.querySelectorAll('.workspace > .msg-list button, .workspace > .msg-list [tabindex]')].some((e) => getComputedStyle(e).visibility !== 'hidden')`), false, 'something in the list could be focused');
  });
  // a folder pressed (the current one too): the list is next to the message, the text is kept and the editor is the same
  await evaluate(`document.querySelector('.fp-row.active, .fp-tree .fp-row')?.click(); 1`);
  await settle();
  await check('946: a press on a folder brings the list back next to the message; text and editor are kept', async () => {
    const g = await geometry();
    assert.equal(g.hiddenClass, false);
    assert.equal(g.listInert, false);
    assert.equal(g.listVis, 'visible');
    assert.equal(g.list.w, listW0, JSON.stringify(g));
    assert.match(await bodyText(), /text that stays/);
    assert.equal(await evaluate(`document.querySelector('.cp-editor .tiptap').getAttribute('data-marker')`), 'same');
  });
  // Discard: the list stays, the message is gone
  await evaluate(`window.__store.getState().openCompose(null, { restore: false }); 1`);
  await settle();
  await check('946: after the message is closed the list is there with its width', async () => {
    const g = await geometry();
    assert.equal(g.pane, null);
    assert.equal(g.list.w, listW0);
    assert.equal(g.hiddenClass, false);
  });
  // a new message: hidden again (the request was for the one before)
  await openMail();
  await settle();
  await check('946: a new message hides the list again', async () => assert.equal((await geometry()).hiddenClass, true));
  // Ctrl+1 asks for the list
  await press('1', 'Digit1', 49, 2);
  await settle();
  await check('946: Ctrl+1 brings the list back, the message stays', async () => {
    const g = await geometry();
    assert.equal(g.hiddenClass, false);
    assert.ok(g.pane);
  });
  await evaluate(`window.__store.getState().openCompose(null, { restore: false }); 1`);
  await openMail();
  await settle();
  // a search started
  await evaluate(`window.__store.getState().setSearch('budget'); 1`);
  await settle();
  await check('946: a search started brings the list back', async () => assert.equal((await geometry()).hiddenClass, false));
  await evaluate(`window.__store.getState().setSearch(''); window.__store.getState().openCompose(null, { restore: false }); 1`);
  await openMail();
  await settle();

  // ---------- the window grows to 1200 and narrows to 1000 again
  await check('946 -> 1200: the list shows next to the message; -> 1000: hidden again', async () => {
    await resize(1200, 800);
    await sleep(700);
    let g = await geometry();
    assert.equal(g.hiddenClass, false, `1200: ${JSON.stringify(g)}`);
    assert.ok(g.list.w >= 300 && g.pane.w >= 440, JSON.stringify(g));
    await resize(1000, 800);
    await sleep(700);
    g = await geometry();
    assert.equal(g.hiddenClass, true, `1000: ${JSON.stringify(g)}`);
    assert.ok(g.pane.w >= 560);
    assert.match(await bodyText(), /Narrow|^$|[\s\S]*/);
  });

  // ---------- the side menu pinned open: the pane is at least 560 px as well
  await evaluate(`window.__store.getState().setPrefs({ sidebar: 'expanded' }); 1`);
  await resize(960, 560);
  await sleep(700);
  await check('960 with the side menu pinned open: pane at least 560 px', async () => {
    const g = await geometry();
    assert.equal(g.hiddenClass, true);
    assert.ok(g.pane.w >= 560, JSON.stringify(g));
  });
  await evaluate(`window.__store.getState().setPrefs({ sidebar: 'auto' }); window.__store.getState().openCompose(null, { restore: false }); 1`);

  // ---------- 1280 x 800: no change (list and message side by side)
  await H.openApp('lang=en', 1280, 800);
  await openMail();
  await settle();
  await check('1280 x 800: list and message side by side (no change)', async () => {
    const g = await geometry();
    assert.equal(g.hiddenClass, false);
    assert.equal(g.listInert, false);
    assert.ok(g.list.w >= 300 && g.pane.w >= 440, JSON.stringify(g));
  });

  // ---------- reading pane below and the Calendar: no change
  await H.openApp('lang=en', 946, 552);
  await evaluate(`window.__store.getState().setPrefs({ readingPane: 'bottom' }); 1`);
  await openMail();
  await settle();
  await check('reading pane below: the list is not hidden', async () => assert.equal((await geometry()).hiddenClass, false));
  await evaluate(`window.__store.getState().openCompose(null, { restore: false }); window.__store.getState().setPrefs({ readingPane: 'right' }); 1`);
  await openMail();
  await evaluate(`window.__store.getState().setModule('calendar'); 1`);
  await settle();
  await check('the Calendar module: the list is not hidden by the rule', async () => assert.equal(await evaluate(`document.querySelector('.workspace').classList.contains('list-hidden')`), false));
} finally { await H.shutdown(); }

if (failures.length) { console.error(`test-compose-narrow: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-compose-narrow: ok');
