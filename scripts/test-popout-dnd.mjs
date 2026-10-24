#!/usr/bin/env node
// W4.7 (drag and drop between the windows of the app), real components in the dev preview and a real browser drag (the mouse is pressed on the row / chip and moved, the page
// gets its own `dragstart`, the drag is taken over with `Input.setInterceptDrags` and delivered with `Input.dispatchDragEvent`, as in test-chip-drag.mjs). A drag between two
// windows cannot be made in a plain browser tab: those are QA rows (the source window is simulated here with the registry of the mock backend, src/devMock.ts `drag_*`).
//   - the rows of the list are draggable (not in Drafts); the drag data is a token in custom types and nothing else (no text, no file);
//   - a row dropped on the Archive of its mailbox leaves the list with "Archived" and Undo; three checked rows dropped on a folder of the person all move ("Moved to ...");
//   - the folders that do not accept (a virtual view, Drafts, the folder they are in, a folder of another mailbox, a heading) show nothing and a drop there does nothing;
//   - an attachment chip dragged onto its own message does nothing; a chip of ANOTHER message (a token the mock registry holds) dropped on the editor is attached there,
//     with its name, type and bytes; a mail dropped on a message, a file from outside dropped on a folder: nothing.
//   node scripts/test-popout-dnd.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-popout-dnd', { vitePort0: 5360, cdpPort0: 9360 });
const { evaluate, cdp, on } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${e.message.replace(/\s+/g, ' ')}`); console.error('FAIL', failures.at(-1).slice(0, 600)); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(js)) return true; await sleep(100); } return false; };
const json = (js) => evaluate(`(async () => JSON.stringify(await (${js})))()`).then((s) => JSON.parse(s));

const MAIL = 'application/x-heylook-mail', FILE = 'application/x-heylook-file', TOK = 'application/x-heylook-tok-';
const mouse = (type, x, y, extra = {}) => cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
await cdp('Input.setInterceptDrags', { enabled: true });
let lastDrag = null;
on((m) => { if (m.method === 'Input.dragIntercepted') lastDrag = m.params.data; });

const centre = (js) => evaluate(`(() => { const e = ${js}; if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
const rowBox = (id) => centre(`document.querySelector('.ml-row[data-thread="${id}"] .ml-main')`);
const folderBox = (acct, key) => centre(`document.querySelector('.fp-tree .fp-row[data-acct="${acct}"][data-key=${JSON.stringify(key)}]')`);
const hot = () => evaluate(`[...document.querySelectorAll('.fp-row.drop-hot')].map((r) => (r.dataset.acct ?? '') + '|' + r.dataset.key).join(',')`);

/** The mouse starts a drag on (x0, y0); resolves to what the page offered. */
async function begin([x0, y0]) {
  lastDrag = null;
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0 });
  await mouse('mousePressed', x0, y0);
  for (let i = 1; i <= 5 && !lastDrag; i++) { await mouse('mouseMoved', x0 + i * 4, y0 + i * 2); await sleep(60); }
  for (let t0 = Date.now(); !lastDrag && Date.now() - t0 < 3000;) await sleep(50);
  assert.ok(lastDrag, 'the browser did not start a drag (is it draggable?)');
  return lastDrag;
}
const to = async (offer, [x, y], type = 'dragOver') => { await cdp('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data: offer }); await cdp('Input.dispatchDragEvent', { type, x, y, data: offer }); await sleep(120); };
const drop = async (offer, [x, y]) => { await cdp('Input.dispatchDragEvent', { type: 'drop', x, y, data: offer }); await mouse('mouseReleased', x, y); await sleep(500); };
const cancel = async () => { await cdp('Input.dispatchDragEvent', { type: 'dragCancel', x: 5, y: 5, data: lastDrag ?? { items: [], dragOperationsMask: 1 } }).catch(() => undefined); await mouse('mouseReleased', 5, 5).catch(() => undefined); await sleep(200); };
/** a drag offer made by hand (the source is another window): the custom types, as the page of that window would have set them */
const offerOf = (kind, token) => ({ items: [{ mimeType: kind === 'mail' ? MAIL : FILE, data: token }, { mimeType: TOK + token, data: '1' }], dragOperationsMask: kind === 'mail' ? 16 : 1 }); // (the mask of Chromium: copy 1, move 16)
const register = (token, payload) => evaluate(`window.__TAURI_INTERNALS__.invoke('drag_begin', { token: ${JSON.stringify(token)}, payload: ${JSON.stringify(payload)} }).then(() => 1)`);

const threadsOf = (acct) => json(`window.__store.getState().threads.filter((t) => t.accountId === ${JSON.stringify(acct)} && t.folder === 'inbox').slice(0, 6).map((t) => ({ id: t.threadId, subject: t.subject }))`);
const toasts = () => json(`[...document.querySelectorAll('.toasts .toast')].map((t) => ({ text: t.querySelector('.toast-text')?.textContent ?? '', undo: !!t.querySelector('.toast-undo') }))`);
const has = (id) => evaluate(`window.__store.getState().threads.some((t) => t.threadId === ${JSON.stringify(id)})`);

try {
  await H.openApp('lang=en', 1280, 800);
  await evaluate(`window.__store.getState().setPrefs({ undoActionSeconds: 8 }); 1`);
  assert.ok(await waitFor(`document.querySelectorAll('.ml-row').length > 5`, 15000), 'no list');
  const a1 = await threadsOf('a1');
  assert.ok(a1.length >= 5, 'five conversations of the first mailbox');

  await check('the rows are draggable; none in Drafts (REQ-4.7.1)', async () => {
    assert.ok(await evaluate(`document.querySelectorAll('.ml-row[draggable="true"]').length`) > 5);
    await evaluate(`window.__store.getState().setView('drafts', null); 1`);
    await sleep(600);
    assert.equal(await evaluate(`document.querySelectorAll('.ml-row[draggable="true"]').length`), 0, 'a draft is edited, not moved');
    await evaluate(`window.__store.getState().setView('inbox', null); 1`);
    assert.ok(await waitFor(`document.querySelectorAll('.ml-row[draggable="true"]').length > 5`, 8000));
  });

  await check('one row onto the Archive of its mailbox: it leaves the list, "Archived" with Undo; Undo brings it back (AC-4.7.1)', async () => {
    const id = a1[0].id;
    const offer = await begin(await rowBox(id));
    const types = offer.items.map((i) => i.mimeType);
    assert.ok(types.includes(MAIL) && types.some((t) => t.startsWith(TOK)), `the offer carries the token types: ${types}`);
    assert.ok(!types.some((t) => /^text\//.test(t) || t === 'Files'), `nothing but the token leaves the page: ${types}`);
    await to(offer, await folderBox('a1', 'archive'));
    assert.equal(await hot(), 'a1|archive', 'the folder shows it accepts');
    await drop(offer, await folderBox('a1', 'archive'));
    assert.equal(await hot(), '', 'the highlight is gone');
    assert.ok(await waitFor(`!window.__store.getState().threads.some((t) => t.threadId === ${JSON.stringify(id)})`, 20000), 'the row did not leave the list');
    const t = await toasts();
    assert.ok(t.some((x) => /Archived/.test(x.text) && x.undo), JSON.stringify(t));
    await evaluate(`document.querySelector('.toasts .toast-undo').click(); 1`);
    assert.ok(await waitFor(`window.__store.getState().threads.some((t) => t.threadId === ${JSON.stringify(id)})`, 5000), 'Undo did not bring it back');
  });

  await check('three checked rows dragged by one of them onto a folder of the person: all three move, "Moved to ..." (AC-4.7.1)', async () => {
    const ids = a1.slice(1, 4).map((x) => x.id);
    await evaluate(`window.__store.setState({ checked: new Set(${JSON.stringify(ids)}) }); 1`);
    const offer = await begin(await rowBox(ids[1]));
    const target = await folderBox('a1', 'f:Projects/Hey Look');
    assert.ok(target, 'no folder of the person');
    await to(offer, target);
    assert.equal(await hot(), 'a1|f:Projects/Hey Look');
    await drop(offer, target);
    assert.ok(await waitFor(`${JSON.stringify(ids)}.every((id) => !window.__store.getState().threads.some((t) => t.threadId === id))`, 20000), 'not all three left the list');
    const t = await toasts();
    assert.ok(t.some((x) => /Moved to/.test(x.text) && x.undo), JSON.stringify(t));
    await evaluate(`document.querySelector('.toasts .toast-undo')?.click(); window.__store.setState({ checked: new Set() }); 1`);
    await sleep(500);
  });

  await check('folders that do not accept: no highlight, nothing moves (REQ-4.7.2, AC-4.7.2)', async () => {
    const id = a1[4].id;
    const offer = await begin(await rowBox(id));
    for (const [what, acct, key] of [['a virtual view', 'a1', 'unread'], ['Drafts', 'a1', 'drafts'], ['the folder it is in', 'a1', 'inbox'], ['a folder of another mailbox', 'a2', 'archive'], ['Sent', 'a1', 'sent']]) {
      const at = await folderBox(acct, key) ?? (key === 'unread' ? await centre(`[...document.querySelectorAll('.fp-tree .fp-row')].find((r) => r.textContent.startsWith('Unread'))`) : null);
      assert.ok(at, `no row for ${what}`);
      await to(offer, at);
      assert.equal(await hot(), '', `${what} must not show the drop look`);
    }
    await drop(offer, await folderBox('a2', 'archive'));
    assert.equal(await has(id), true, 'the row moved to a folder of another mailbox');
    assert.deepEqual((await toasts()).filter((x) => /Archived|Moved/.test(x.text)), [], 'no toast');
    await cancel();
  });

  await check('a drag that is not a conversation (a file from outside, a chip) is not accepted by a folder (AC-4.7.6)', async () => {
    const at = await folderBox('a1', 'archive');
    await cdp('Input.dispatchDragEvent', { type: 'dragEnter', x: at[0], y: at[1], data: { items: [], files: ['C:\\x\\report.pdf'], dragOperationsMask: 1 } });
    await cdp('Input.dispatchDragEvent', { type: 'dragOver', x: at[0], y: at[1], data: { items: [], files: ['C:\\x\\report.pdf'], dragOperationsMask: 1 } });
    await sleep(120);
    assert.equal(await hot(), '');
    const tok = 'file-token-1';
    await register(tok, { kind: 'file', name: 'a.pdf', mime: 'application/pdf', dataBase64: 'AAAA', from: 'compose-2', compose: 'other' });
    await to(offerOf('file', tok), at);
    assert.equal(await hot(), '', 'a chip is not a conversation');
    await cdp('Input.dispatchDragEvent', { type: 'dragCancel', x: at[0], y: at[1], data: offerOf('file', tok) }).catch(() => undefined);
  });

  await check('a conversation of another mailbox in the payload is refused at the drop even where the pointer showed the folder (REQ-4.7.2)', async () => {
    // a drag from a reader window: the registry holds the conversation (the window that began it is another one); the folder asks the registry on the drop
    const a2 = await threadsOf('a2');
    const tok = 'mail-token-1';
    await register(tok, { kind: 'mail', items: [{ threadId: a2[0].id, accountId: 'a2', folder: 'inbox' }], from: 'reader-3', view: 'inbox' });
    const at = await folderBox('a1', 'archive');
    await to(offerOf('mail', tok), at);
    assert.equal(await hot(), '', 'the registry says a2: a folder of a1 does not accept');
    await drop(offerOf('mail', tok), at);
    assert.equal(await has(a2[0].id), true);
  });

  await check('a conversation from another window (the registry has it): dropped on its mailbox\'s Archive it moves; the reader window it came from is closed (REQ-4.7.3)', async () => {
    const tok = 'mail-token-2';
    const id = (await threadsOf('a1'))[0].id;
    await register(tok, { kind: 'mail', items: [{ threadId: id, accountId: 'a1', folder: 'inbox' }], from: 'reader-3', view: 'inbox' });
    const at = await folderBox('a1', 'archive');
    await to(offerOf('mail', tok), at);
    assert.equal(await hot(), 'a1|archive');
    await evaluate(`window.__popoutCalls = []; 1`);
    await drop(offerOf('mail', tok), at);
    assert.ok(await waitFor(`!window.__store.getState().threads.some((t) => t.threadId === ${JSON.stringify(id)})`, 5000), 'the conversation did not move');
    assert.ok((await toasts()).some((x) => /Archived/.test(x.text) && x.undo));
    assert.ok(await json(`(window.__dragCalls || []).some((c) => c.cmd === 'drag_take' && c.token === ${JSON.stringify(tok)})`), 'the drop took the token once');
    await evaluate(`document.querySelector('.toasts .toast-undo')?.click(); 1`);
    await sleep(400);
  });

  // ---------- chips
  await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Chips', attachments: [{ filename: 'report.pdf', mime: 'application/pdf', dataBase64: btoa('%PDF-1.4 pretend bytes') }] }); 1`);
  assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor && document.querySelectorAll('.att-chip').length === 1`, 15000), 'compose did not start');
  await sleep(600);
  const attNames = () => json(`[...document.querySelectorAll('.att-chip .ellipsis')].map((e) => e.textContent.trim())`);

  await check('the chip is draggable; dragged onto its own message it does nothing, and the message does not show the drop look (REQ-4.7.4)', async () => {
    assert.equal(await evaluate(`document.querySelectorAll('.att-chip[draggable="true"]').length`), 1);
    const offer = await begin(await centre(`document.querySelector('.att-chip .ellipsis')`));
    const types = offer.items.map((i) => i.mimeType);
    assert.ok(types.includes(FILE) && types.some((t) => t.startsWith(TOK)) && !types.some((t) => /^text\//.test(t)), `types ${types}`);
    const at = await centre(`document.querySelector('.cp-editor')`);
    await to(offer, at);
    assert.equal(await evaluate(`document.querySelector('.compose-pane').classList.contains('chip-over')`), false, 'the message the chip came from takes no drop');
    await drop(offer, at);
    assert.deepEqual(await attNames(), ['report.pdf']);
  });

  await check('a chip of ANOTHER message dropped on the editor is attached there with its name and bytes (AC-4.7.4)', async () => {
    const tok = 'file-token-2';
    const bytes = 'second file, other message';
    await register(tok, { kind: 'file', name: 'budget.xlsx', mime: 'application/vnd.ms-excel', dataBase64: Buffer.from(bytes).toString('base64'), from: 'compose-7', compose: 'someone-else' });
    const at = await centre(`document.querySelector('.cp-editor')`);
    const o = offerOf('file', tok);
    await to(o, at);
    assert.equal(await evaluate(`document.querySelector('.compose-pane').classList.contains('chip-over')`), true, 'the pane shows it takes the chip');
    await drop(o, at);
    assert.ok(await waitFor(`document.querySelectorAll('.att-chip').length === 2`, 5000), 'not attached');
    assert.deepEqual(await attNames(), ['report.pdf', 'budget.xlsx']);
    assert.equal(await evaluate(`document.querySelector('.compose-pane').classList.contains('chip-over')`), false, 'the look is gone after the drop');
    const size = await evaluate(`document.querySelectorAll('.att-chip')[1].querySelector('.muted.small').textContent`);
    assert.ok(/\bB\b|KB/.test(size), `the size is shown: ${size}`);
  });

  await check('a conversation dropped on a message attaches nothing (forward as attachment is not a gesture)', async () => {
    const tok = 'mail-token-3';
    await register(tok, { kind: 'mail', items: [{ threadId: a1[0].id, accountId: 'a1', folder: 'inbox' }], from: 'main', view: 'inbox' });
    const at = await centre(`document.querySelector('.cp-editor')`);
    await to(offerOf('mail', tok), at);
    assert.equal(await evaluate(`document.querySelector('.compose-pane').classList.contains('chip-over')`), false);
    await drop(offerOf('mail', tok), at);
    assert.deepEqual(await attNames(), ['report.pdf', 'budget.xlsx']);
  });
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log('test-popout-dnd: ok');
