#!/usr/bin/env node
// 1.0.7 WP9d (W9.2, REQ-9.2.5): loading a part of the app on demand (src/lazyLoad.ts), in plain Node: one load at a time, a success is kept, a failure is retried once after 500 ms and then
// NOT remembered (the next try fetches again), the dev seam `#lazyfail` (here `globalThis.__heylookLazyFail`), the prefetch swallows a failure; and the source guards of the wiring:
// only src/lazyViews.tsx and src/popout/views.tsx / main.tsx start the big parts, the main chunk never imports them, the idle prefetch and the pointer / focus prefetch are installed.
//   node --experimental-strip-types scripts/test-lazy-load.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { LAZY_LOOK_MS, LAZY_RETRY_MS, failSeam, loadLazy, peekLazy, prefetchLazy, resetLazy, setLazyPause } from '../src/lazyLoad.ts';

const waits = [];
setLazyPause(async (ms) => { waits.push(ms); });
const fresh = () => { resetLazy(); waits.length = 0; globalThis.__heylookLazyFail = []; };

assert.equal(LAZY_RETRY_MS, 500, 'one retry after 500 ms (REQ-9.2.5)');
assert.equal(LAZY_LOOK_MS, 150, 'the loading look after 150 ms (REQ-9.2.4)');

// ---- a success: loaded once, kept, shared by two callers that ask at the same time
{
  fresh();
  let calls = 0;
  const importer = async () => { calls++; return { ok: calls }; };
  assert.equal(peekLazy('a'), undefined, 'nothing loaded yet: a view is not drawn in the same render');
  const [x, y] = await Promise.all([loadLazy('a', importer), loadLazy('a', importer)]);
  assert.equal(calls, 1, 'two callers at the same time share one import');
  assert.equal(x, y);
  assert.deepEqual(peekLazy('a'), { ok: 1 }, 'a loaded part is there for the next render (a prefetched editor opens in the same render)');
  await loadLazy('a', importer);
  assert.equal(calls, 1, 'a loaded part is not imported again');
  assert.deepEqual(waits, [], 'no waiting on the way of a success');
}

// ---- one failure: retried once after 500 ms, then it works
{
  fresh();
  let calls = 0;
  const m = await loadLazy('b', async () => { if (++calls === 1) throw new Error('network'); return 'second try'; });
  assert.equal(m, 'second try');
  assert.equal(calls, 2);
  assert.deepEqual(waits, [500], 'the retry came after 500 ms');
}

// ---- two failures: rejected after the retry, and NOT remembered: the next try imports again
{
  fresh();
  let calls = 0;
  const bad = async () => { calls++; throw new Error('gone'); };
  await assert.rejects(loadLazy('c', bad), /gone/);
  assert.equal(calls, 2, 'one try and one retry');
  assert.deepEqual(waits, [500]);
  assert.equal(peekLazy('c'), undefined, 'a failure leaves nothing behind');
  const m = await loadLazy('c', async () => { calls++; return 'now it works'; });
  assert.equal(m, 'now it works', 'the next try loads again');
  assert.equal(calls, 3);
}

// ---- a rejected load does not poison the callers that asked at the same time, and a later success is kept
{
  fresh();
  const bad = async () => { throw new Error('x'); };
  const r = await Promise.allSettled([loadLazy('d', bad), loadLazy('d', bad)]);
  assert.deepEqual(r.map((x) => x.status), ['rejected', 'rejected'], 'both callers get the failure');
  assert.equal(await loadLazy('d', async () => 7), 7);
  assert.equal(peekLazy('d'), 7);
}

// ---- the dev seam: every try of that part fails, the others are not touched; taking it away makes the next try work
{
  fresh();
  globalThis.__heylookLazyFail = ['settings'];
  assert.ok(failSeam('settings') && !failSeam('calendar'));
  let imported = 0;
  await assert.rejects(loadLazy('settings', async () => { imported++; return 1; }, 'settings'), /#lazyfail/);
  assert.equal(imported, 0, 'the seam fails before the import is tried');
  assert.deepEqual(waits, [500], 'the seam goes through the retry as a real failure does');
  assert.equal(await loadLazy('calendar', async () => 'cal', 'calendar'), 'cal', 'another part loads');
  globalThis.__heylookLazyFail = [];
  assert.equal(await loadLazy('settings', async () => { imported++; return 2; }, 'settings'), 2, 'the seam removed: the next try opens it');
  assert.equal(imported, 1);
}

// ---- prefetch: starts the load, never throws, a later real ask gets the result or the failure again
{
  fresh();
  let calls = 0;
  prefetchLazy('e', async () => { calls++; throw new Error('prefetch failed'); });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 2, 'the prefetch retried once and swallowed the failure');
  assert.equal(await loadLazy('e', async () => 'real ask'), 'real ask', 'a failed prefetch is not remembered');
  prefetchLazy('f', async () => 'ready');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(peekLazy('f'), 'ready', 'a prefetch that worked is there for the view');
}

// ---- the wiring (source guards)
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const walk = (dir) => readdirSync(new URL(`../${dir}/`, import.meta.url)).flatMap((f) => {
  const rel = `${dir}/${f}`;
  return statSync(new URL(`../${rel}`, import.meta.url)).isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(f) ? [rel] : [];
});
const src = walk('src').filter((f) => !f.startsWith('src/devMock'));
const BIG = ['components/Compose', 'components/RichEditor', 'components/SettingsDialog', 'components/Calendar', 'components/PgpDialogs', 'components/Dialogs', 'popout/ComposeView', 'popout/ReaderView', 'components/Updates'];
// 1. nothing imports a big part statically, and only lazyViews.tsx (and the part itself) starts it dynamically
for (const f of src) {
  const text = read(f);
  for (const big of BIG) {
    const name = big.split('/').pop();
    // static: import ... from "./Compose" / "../components/Compose" (the part's own file and the parts that live in the same chunk are the exceptions)
    const staticRe = new RegExp(`^import[^;]*from\\s+["'](?:\\./|\\.\\./|\\./components/|\\.\\./components/|\\./popout/|\\.\\./popout/)${name}["']`, 'm');
    if (!staticRe.test(text)) continue;
    const sameChunk = {
      'components/Compose': ['src/popout/ComposeView.tsx'], // the compose window's view is the editor's chunk-mate (it needs the editor to draw anything)
      'components/RichEditor': ['src/components/SettingsDialog.tsx'], // the signature editor is part of Settings
      'components/Updates': ['src/components/SettingsDialog.tsx'], // the updates block is part of Settings
    }[big] ?? [];
    assert.ok(sameChunk.includes(f), `${f} imports ${big} statically: the big parts are loaded by src/lazyViews.tsx only`);
  }
}
const views = read('src/lazyViews.tsx');
for (const imp of ['import("./components/Compose")', 'import("./components/SettingsDialog")', 'import("./components/Calendar")', 'import("./components/PgpDialogs")', 'import("./components/Dialogs")', 'import("./popout/ComposeView")', 'import("./popout/ReaderView")']) {
  assert.ok(views.includes(imp), `lazyViews.tsx starts ${imp}`);
}
// 2. App.tsx draws only the wrappers
const app = read('src/App.tsx');
for (const w of ['LazyCompose', 'LazySettings', 'LazyCalendarView', 'LazyEventDialog', 'LazyGenerateKeyDialog', 'LazyImportKeyDialog', 'LazyKeyDetailsDialog', 'LazyBulkCleaner', 'LazyShowOriginal']) assert.ok(app.includes(`<${w}`), `App.tsx draws <${w}>`);
// 3. the prefetch: idle after the first paint (requestIdleCallback, 2 s; WebKit has none: a timer), and the pointer / focus on a button that needs the editor
assert.ok(/requestIdleCallback\(prefetchEditor, \{ timeout: 2000 \}\)/.test(views) && /setTimeout\(prefetchEditor, 1000\)/.test(views), 'idle prefetch with the timer fallback');
assert.ok(views.includes('"pointerover"') && views.includes('"focusin"') && views.includes('[data-intent="editor"]'), 'pointer and focus prefetch');
assert.ok(app.includes('prefetchEditorWhenIdle()') && app.includes('installEditorIntent()'), 'App.tsx installs both once the app is up');
for (const [f, n] of [['src/components/ReadingPane.tsx', 6], ['src/components/Ribbon.tsx', 2]]) assert.ok((read(f).match(/data-intent=/g) ?? []).length >= n, `${f}: the Reply / New mail buttons carry data-intent="editor"`);
const main = read('src/main.tsx');
assert.ok(main.indexOf('prefetchComposeWindow()') > 0 && main.indexOf('prefetchComposeWindow()') < main.indexOf('applySavedLanguage('), 'the compose window asks for its view before React renders (and beside the language)');
// 4. the compose shell never waits for the editor: the frame is eager and carries the shell's classes
const frame = read('src/components/ComposeFrame.tsx');
assert.ok(frame.includes('preparing') && frame.includes('cp-prep') && frame.includes('cp-keep') && frame.includes('inert'), 'ComposeFrame draws the shell (REQ-13.13.9)');
assert.ok(!/from "\.\.\/editor\//.test(frame) && !frame.includes('@tiptap'), 'ComposeFrame needs nothing of the editor');
// 5. failure: the existing toast, nothing half open, no cached failure
const lazy = read('src/lazy.tsx');
assert.ok(lazy.includes('errors.toast.failed') && lazy.includes('friendlyError'), 'the failure toast is the existing one with the error text');
for (const k of ['closeDialog', 'openCompose(null', 'setModule("mail")', 'resolvePassphrase(false)']) assert.ok(views.includes(k), `lazyViews.tsx undoes the click: ${k}`);
console.log('lazy-load: ok');
