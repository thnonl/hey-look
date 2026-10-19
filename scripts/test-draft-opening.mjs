#!/usr/bin/env node
// 1.0.7 D-044 / REQ-13.7.1: a draft that takes time to open shows it at once. Real list and pane in the dev preview (src/devMock.ts: `window.__draftPartsDelay` makes the
// read of the draft's body and pictures take that long, like a 19 MB encrypted draft does):
//   - a click on the row of a draft: the row is `aria-busy="true"` with a ring in place of its date within one frame (checked at 100 ms), and the pane under the list shows
//     the status "Opening draft…" (role=status, aria-busy) within 150 ms of the click; the ring has the dots next to it for reduced motion (CSS hides one of them);
//   - while it opens the list scrolls and the page answers: a timer of 25 ms never waits more than 400 ms in the dev preview (nothing blocks the page; the kit's bigmeasure.mjs measures the real app);
//   - when the draft is in the editor the row and the pane are as before (no ring, no status), and a fast open (no delay) never shows the status (no flash);
//   - another click on the row while it opens does not open a second editor; a draft that cannot be opened leaves nothing busy behind;
//   - the 8 languages have the text; a draft that opens in its own window shows the status until the window is ready (ComposeView: a delayed flag).
//   node scripts/test-draft-opening.mjs [--require-browser]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, sleep, startHarness } from './cdp-harness.mjs';
import { fill, PROBE_INSTALL, PROBE_PRESS, PROBE_READ } from './lib/draft-open-probe.mjs';

const H = await startHarness('test-draft-opening', { vitePort0: 5950 });
const { evaluate, cdp } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(js)) return true; await sleep(40); } return false; };

try {
  await H.openApp('lang=en', 1280, 800);
  // a saved draft: the mock keeps it like the server does and lists it in Drafts
  const tid = await evaluate(`window.__TAURI_INTERNALS__.invoke('save_draft', { draft: { accountId: 'a1', to: ['alice@fabrikam.com'], cc: [], bcc: [], subject: 'Opening test draft', html: '<p>Body of the draft</p>', text: 'Body of the draft', references: [], attachments: [], inline: [] }, replaces: null }).then((r) => r.threadId)`);
  assert.ok(tid, 'no draft was made');
  await evaluate(`window.__store.getState().setView('drafts', null); 1`);
  assert.ok(await waitFor(`!!document.querySelector('[data-thread=${JSON.stringify(tid)}]')`), 'the draft has no row in Drafts');

  const row = `document.querySelector('.ml-row[data-thread=${JSON.stringify(tid)}]')`;
  const state = () => evaluate(`(() => { const r = ${row}; return { busy: r?.getAttribute('aria-busy') === 'true', ring: !!r?.querySelector('.date .busy-ring'), dots: !!r?.querySelector('.date .busy-dots'), dateText: r?.querySelector('.date')?.textContent ?? null, status: [...document.querySelectorAll('[role=status]')].some((e) => /Opening draft/.test(e.textContent || '')), statusBusy: [...document.querySelectorAll('[role=status][aria-busy=true]')].some((e) => /Opening draft/.test(e.textContent || '')), editor: !!document.querySelector('.cp-editor .tiptap')?.editor, key: window.__store.getState().composeKey, opening: window.__store.getState().openingDraft }; })()`);
  const closeEditor = async () => { await evaluate(`window.__store.getState().openCompose(null, { restore: false }); 1`); await sleep(400); };

  // ---- a slow open: 700 ms
  await check('before the click: no ring, no status', async () => {
    const s = await state();
    assert.equal(s.busy || s.ring || s.status, false);
    assert.ok(s.dateText && s.dateText.length > 0, 'the row has its date');
  });
  await check('a slow open shows the ring at once, the status within 150 ms, answers the page, and ends clean', async () => {
    await evaluate(`window.__draftPartsDelay = 700; window.__gaps = []; { let last = performance.now(); window.__iv = setInterval(() => { const n = performance.now(); window.__gaps.push(n - last); last = n; }, 25); }; window.__t0 = performance.now(); ${row}.click(); 1`);
    await sleep(100);
    const a = await state();
    assert.ok(a.busy && a.ring && a.dots, `100 ms after the click the row is not busy with a ring and the dots: ${JSON.stringify(a)}`);
    assert.equal(a.dateText?.replace(/[·\s]/g, ''), '', 'the ring takes the place of the date');
    await sleep(80);
    const b = await state();
    assert.ok(b.status && b.statusBusy, `180 ms after the click the pane shows no "Opening draft…" status: ${JSON.stringify(b)}`);
    assert.ok(b.busy && !b.editor, 'still opening');
    // the list scrolls and a timer is on time while it opens
    await evaluate(`document.querySelector('.ml-list, .msg-list [class*=virtual], .msg-list')?.scrollBy?.(0, 10); 1`);
    assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor`, 6000), 'the draft never opened');
    await sleep(150);
    const end = await state();
    assert.ok(!end.busy && !end.ring && !end.dots && end.dateText && end.dateText.length > 0, `the row is busy after the open: ${JSON.stringify(end)}`);
    assert.equal(end.opening, null, 'openingDraft was not cleared');
    const gap = await evaluate(`(() => { clearInterval(window.__iv); return Math.round(Math.max(...window.__gaps)); })()`);
    assert.ok(gap < 400, `the page was blocked for ${gap} ms while the draft opened`); // (the dev preview builds the editor unoptimised: the real app is measured by the kit's bigmeasure.mjs)
    // the status goes (it stays at least 300 ms once shown, the editor is over it by then)
    assert.ok(await waitFor(`![...document.querySelectorAll('[role=status]')].some((e) => /Opening draft/.test(e.textContent || ''))`, 2000), 'the status stayed');
  });

  // ---- a fast open: no flash
  await closeEditor();
  await check('a fast open never shows the status', async () => {
    await evaluate(`window.__draftPartsDelay = 0; ${row}.click(); window.__seen = false; window.__obs = new MutationObserver(() => { if ([...document.querySelectorAll('[role=status]')].some((e) => /Opening draft/.test(e.textContent || ''))) window.__seen = true; }); window.__obs.observe(document.body, { subtree: true, childList: true, characterData: true }); 1`);
    assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor`, 6000), 'the draft never opened');
    await sleep(500);
    assert.equal(await evaluate(`(window.__obs.disconnect(), window.__seen)`), false, 'the status flashed');
    const s = await state();
    assert.ok(!s.busy && !s.ring && s.opening === null, `busy after a fast open: ${JSON.stringify(s)}`);
  });

  // ---- another click while it opens: one editor
  await closeEditor();
  await check('another click on the row while it opens opens no second editor', async () => {
    const before = (await state()).key;
    await evaluate(`window.__draftPartsDelay = 500; ${row}.click(); 1`);
    await sleep(150);
    await evaluate(`${row}.click(); 1`);
    assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor`, 6000), 'the draft never opened');
    await sleep(700);
    const s = await state();
    assert.equal(s.key - before, 1, `the editor was opened ${s.key - before} times`);
    assert.ok(!s.busy && s.opening === null, `busy afterwards: ${JSON.stringify(s)}`);
    assert.equal(await evaluate(`document.querySelectorAll('.compose-pane').length`), 1);
  });

  // ---- a draft that cannot be opened: nothing stays busy
  await closeEditor();
  await check('a failed open leaves no ring and no status behind', async () => {
    await evaluate(`window.__draftPartsDelay = 300; window.__real = window.__real || null; 1`);
    // the thread is gone: the read finds nothing and the open ends without an editor
    await evaluate(`window.__mockGone && window.__mockGone.add(${JSON.stringify(tid)}); ${row}.click(); 1`);
    await sleep(1200);
    const s = await state();
    assert.ok(!s.busy && !s.ring && !s.status && s.opening === null && !s.editor, `something is busy after a failed open: ${JSON.stringify(s)}`);
    await evaluate(`window.__mockGone && window.__mockGone.delete(${JSON.stringify(tid)}); 1`);
  });

  // ---- the data of big pictures goes into the editor in the task that made it: the pictures have their data, the draft is not changed, nothing of the marker is left
  await closeEditor();
  await check('an opened draft with big pictures: the editor has the pictures with all their data and the draft is not dirty', async () => {
    const data = (n, seed) => { let x = seed, s = ''; const al = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; s += al[x % 64]; } return s; };
    const [a, b] = [data(4000, 11), data(6000, 22)];
    const body = `<p>Words</p><p><img src="data:image/png;base64,${a}" alt="one" data-name="one.png"></p><p>middle</p><p><img src="data:image/jpeg;base64,${b}" alt="two"></p><p><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="tiny"></p>`;
    await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Pictures draft', bodyHtml: ${JSON.stringify(body)}, replaces: 'm:a1:drafts:dtX' }); 1`);
    assert.ok(await waitFor(`document.querySelectorAll('.cp-editor img').length === 3`, 8000), 'the editor has no 3 pictures');
    await sleep(600);
    const r = await evaluate(`(() => { const imgs = [...document.querySelectorAll('.cp-editor img')].map((i) => i.getAttribute('src')); const html = document.querySelector('.cp-editor .tiptap').innerHTML; const st = window.__store.getState(); return { imgs, marker: /HLDETACHED/.test(html), dirty: st.composeDirty, names: [...document.querySelectorAll('.cp-editor img')].map((i) => i.getAttribute('data-name')) }; })()`);
    assert.deepEqual(r.imgs, [`data:image/png;base64,${a}`, `data:image/jpeg;base64,${b}`, 'data:image/gif;base64,R0lGODlhAQABAAAAACw='], 'the pictures have their own data, in their order');
    assert.equal(r.marker, false, 'a marker is left in the editor');
    assert.equal(r.dirty, false, 'restoring the pictures counted as an edit');
    assert.equal(r.names[0], 'one.png', 'the name of a picture is kept');
    // what the message sends is what was in the draft
    const built = await evaluate(`(async () => { const st = window.__store.getState(); await st.composeSaver?.({ quiet: true }); return window.__lastDraft; })()`);
    assert.ok(built && built.inline.length === 3 && built.inline[0].dataBase64 === a && built.inline[1].dataBase64 === b && !/HLDETACHED/.test(JSON.stringify(built)), 'the saved draft has the pictures: ' + JSON.stringify(built && built.inline && built.inline.map((i) => i.dataBase64.length)));
  });

  // ---- the probe the Mac and Linux sessions run through the test bridge (scripts/lib/draft-open-probe.mjs): the same page, the same numbers
  await closeEditor();
  await check('the draft-open probe reads the same thing from the page: ring, status, done, no wait over 500 ms, the row clean afterwards', async () => {
    const run = (body) => evaluate(`(async () => { const f = new (Object.getPrototypeOf(async function () {}).constructor)(${JSON.stringify(fill(body, 'Opening test draft', 0))}); return f(); })()`);
    await evaluate(`window.__draftPartsDelay = 600; 1`);
    const inst = await run(PROBE_INSTALL);
    assert.equal(inst.row, true, 'the probe found no row');
    assert.equal((await run(PROBE_PRESS)).pressed, true);
    assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor`, 6000), 'the draft never opened');
    await sleep(500);
    const r = await run(PROBE_READ);
    assert.ok(r.busyMs !== null && r.busyMs <= 150, `busyMs ${r.busyMs}`);
    assert.ok(r.statusMs !== null && r.statusMs <= 150 && /Opening draft/.test(r.statusText), `statusMs ${r.statusMs} ${r.statusText}`);
    assert.ok(r.subjectMs !== null && r.doneMs !== null && r.doneMs >= 550 && r.doneMs < 3000, `doneMs ${r.doneMs}`);
    assert.ok(r.gapMax < 500 && r.rowAfter && !r.rowAfter.busy && r.rowAfter.date.length > 0, JSON.stringify(r));
    await evaluate(`window.__draftOpen && window.__draftOpen.stop(); window.__draftPartsDelay = 0; 1`);
  });

  // ---- reduced motion: the dots, not the ring
  await check('reduced motion shows the dots and hides the ring (CSS)', async () => {
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await closeEditor();
    await evaluate(`window.__draftPartsDelay = 900; ${row}.click(); 1`);
    await sleep(300);
    const css = await evaluate(`(() => { const r = ${row}; const ring = r?.querySelector('.date .busy-ring'), dots = r?.querySelector('.date .busy-dots'); const p = [...document.querySelectorAll('[role=status]')].find((e) => /Opening draft/.test(e.textContent || '')); return { ring: ring && getComputedStyle(ring).display, dots: dots && getComputedStyle(dots).display, pRing: p && getComputedStyle(p.querySelector('.busy-ring')).display, pDots: p && getComputedStyle(p.querySelector('.busy-dots')).display }; })()`);
    assert.deepEqual([css.ring, css.dots, css.pRing, css.pDots === 'none'], ['none', 'inline', 'none', false], JSON.stringify(css)); // (in the pane the dots are a flex item: `block`)
    await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor`, 6000);
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  });
} finally {
  await H.shutdown();
}

// ---- the text, in every language; the wiring that cannot be seen in the preview
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
await check('compose.draft.opening is in all 8 languages, with the text the language specialists agreed', async () => {
  const want = { en: 'Opening draft…', vi: 'Đang mở thư nháp…', fr: 'Ouverture du brouillon…', 'zh-Hans': '正在打开草稿…', es: 'Abriendo borrador…', ja: '下書きを開いています…', de: 'Entwurf wird geöffnet…', ru: 'Открытие черновика…' };
  const ns = read('src/i18n/ns/compose.ts');
  const found = [...ns.matchAll(/"compose\.draft\.opening": "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(found, [want.en, want.vi, want.fr], 'en, vi, fr (src/i18n/ns/compose.ts)');
  for (const l of ['de', 'es', 'ja', 'ru', 'zh-Hans']) assert.ok(read(`src/i18n/locales/${l}/compose.ts`).includes(`"compose.draft.opening": "${want[l]}"`), l);
});
await check('the compose window shows the status until its Compose is ready', async () => {
  const v = read('src/popout/ComposeView.tsx');
  assert.ok(/useDelayedFlag\(!ready && isObj\(init\) && typeof init\.replaces === "string" && init\.replaces\.startsWith\("m:"\)\)/.test(v) && /draftBusy && !ready/.test(v) && /compose\.draft\.opening/.test(v), 'ComposeView');
  const c = read('src/components/Compose.tsx');
  assert.ok(/setOpeningDraft\(threadId\)[\s\S]{0,300}finally \{\s*if \(ringOwner === mine\) useStore\.getState\(\)\.setOpeningDraft\(null\)/.test(c), 'openDraftThread owns the ring and clears it in a finally');
});

if (failures.length) { console.error(`test-draft-opening: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-draft-opening: ok');
