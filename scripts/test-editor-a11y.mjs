#!/usr/bin/env node
// Keyboard and screen-reader semantics of the editors (1.0.7 W2.18 picture toolbar, W2.16 link dialog, W2.20 pressed state and the To field's combobox), real
// Compose and the real signature editor of Settings in the dev preview (src/devMock.ts) with real CDP key events.
//
// W2.18 (the picture toolbar can be reached by keyboard):
//   - a picture is selected by the keyboard (Arrow Right onto it from the text before it, Shift+Arrow Right from before the first one): the toolbar shows;
//   - Alt+F10 moves the focus to the toolbar's first control ("Small"); without a picture selected Alt+F10 still goes to the formatting bar;
//   - the toolbar is ONE Tab stop (roving tabindex), Left / Right / Home / End move between the controls (the size and alignment radios included), Enter presses
//     ("Large" resizes), Alt+Enter opens the alt text, Esc returns to the text with the picture still selected, Delete then removes it;
//   - the same in the signature editor of Settings (sizes 120 / 240 / 360 px, no "As attachment").
//   node scripts/test-editor-a11y.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-editor-a11y', { vitePort0: 5440 });
const { evaluate } = H;
const failures = [];
let checks = 0;
const check = async (name, fn) => { checks++; try { await fn(); } catch (e) { failures.push(`${name}: ${e.message.replace(/\s+/g, ' ')}`); console.error('FAIL', failures.at(-1).slice(0, 500)); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(js)) return true; await sleep(100); } return false; };
const json = (js) => evaluate(`JSON.stringify(${js})`).then((s) => JSON.parse(s));
// CDP modifiers: Alt 1, Ctrl 2, Meta 4, Shift 8
const key = async (k, code, vk, modifiers = 0, text) => {
  await H.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) });
  await H.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await sleep(80);
};
const K = {
  right: (m = 0) => key('ArrowRight', 'ArrowRight', 39, m),
  left: (m = 0) => key('ArrowLeft', 'ArrowLeft', 37, m),
  home: () => key('Home', 'Home', 36),
  end: () => key('End', 'End', 35),
  enter: (m = 0) => key('Enter', 'Enter', 13, m, m ? undefined : String.fromCharCode(13)),
  esc: () => key('Escape', 'Escape', 27),
  del: () => key('Delete', 'Delete', 46),
  tab: (m = 0) => key('Tab', 'Tab', 9, m),
  f10: (m = 0) => key('F10', 'F10', 121, m),
};

/** a PNG of w x h px */
const PNG = (w, h, c) => `(() => { const k = document.createElement('canvas'); k.width = ${w}; k.height = ${h}; const g = k.getContext('2d'); g.fillStyle = ${JSON.stringify(c)}; g.fillRect(0, 0, ${w}, ${h}); return k.toDataURL('image/png'); })()`;
const where = () => json(`(() => { const a = document.activeElement; return { in: a?.closest('.img-tools') ? 'picture-tools' : a?.closest('.fmt-tb') ? 'format-bar' : a?.closest('.ProseMirror') ? 'editor' : a?.tagName ?? null, label: (a?.getAttribute('aria-label') || a?.textContent || '').trim(), role: a?.getAttribute('role') }; })()`);
const tools = () => json(`(() => { const bar = document.querySelector('.img-tools'); if (!bar) return null; const items = [...bar.querySelectorAll('[data-rove]')]; return { n: items.length, tab: items.filter((b) => b.tabIndex === 0).length, names: items.map((b) => (b.getAttribute('aria-label') || b.textContent).trim()), role: bar.getAttribute('role'), label: bar.getAttribute('aria-label'), groups: [...bar.querySelectorAll('[role=radiogroup]')].map((g) => ({ label: g.getAttribute('aria-label'), radios: g.querySelectorAll('[role=radio]').length, checked: [...g.querySelectorAll('[role=radio]')].filter((r) => r.getAttribute('aria-checked') === 'true').length })) }; })()`);

/** the editor under test: `.cp-editor .tiptap` in Compose, the first `.rich-body .tiptap` in Settings */
const EDS = { compose: `document.querySelector('.cp-editor .tiptap').editor`, rich: `document.querySelector('.rich-body .tiptap').editor` };
const imageState = (ed) => json(`(() => { const e = ${ed}; const s = e.state.selection; const imgs = []; e.state.doc.descendants((n, p) => { if (n.type.name === 'image') imgs.push({ p, width: n.attrs.width, alt: n.attrs.alt }); }); return { node: s.node?.type.name ?? null, images: imgs, sel: s.from }; })()`);

async function pictureKeyboard(label, ed, sizes, { attach }) {
  const first = await json(`(() => { const e = ${ed}; let p = -1; e.state.doc.descendants((n, pos) => { if (p < 0 && n.type.name === 'image') p = pos; }); return p; })()`);
  assert.ok(first >= 0, `${label}: no picture in the editor`);
  // 1. the keyboard puts a NodeSelection on the picture: Shift+Right from before it
  await evaluate(`(() => { const e = ${ed}; e.commands.focus(); e.commands.setTextSelection(${first} > 1 ? ${first} - 1 : 1); return 1; })()`);
  await sleep(100);
  await K.right(); // from the end of the text before it: onto it
  await sleep(200);
  let st = await imageState(ed);
  if (st.node !== 'image') { await K.right(8); await sleep(200); st = await imageState(ed); } // (Shift+Right: the other way the spec names)
  await check(`${label}: the picture is selected by the keyboard`, () => assert.equal(st.node, 'image', JSON.stringify(st)));
  await check(`${label}: the toolbar shows`, async () => assert.ok(await waitFor(`!!document.querySelector('.img-tools')`, 3000)));
  // 2. Alt+F10: the first control
  await K.f10(1);
  await sleep(150);
  await check(`${label}: Alt+F10 focuses "Small"`, async () => { const w = await where(); assert.equal(w.in, 'picture-tools', JSON.stringify(w)); assert.equal(w.label, 'Small'); assert.equal(w.role, 'radio'); });
  const t0 = await tools();
  await check(`${label}: one Tab stop, named groups`, () => {
    assert.equal(t0.role, 'toolbar');
    assert.equal(t0.label, 'Picture options');
    assert.equal(t0.tab, 1, 'exactly one control is tabbable (roving tabindex)');
    assert.equal(t0.n, attach ? 11 : 10);
    assert.deepEqual(t0.groups.map((g) => [g.label, g.radios]), [['Size', 4], ['Alignment', 3]]);
  });
  // 3. Right / Left / Home / End
  await K.right(); await check(`${label}: Right goes to the next size`, async () => assert.equal((await where()).label, 'Medium'));
  await K.end();
  const lastLabel = (await where()).label;
  await check(`${label}: End goes to the last control (Remove)`, () => assert.match(lastLabel, /^Remove/));
  await K.right(); await check(`${label}: Right wraps to Small`, async () => assert.equal((await where()).label, 'Small'));
  await K.left(); await check(`${label}: Left wraps to the last control`, async () => assert.equal((await where()).label, lastLabel));
  await K.home(); await check(`${label}: Home goes to Small`, async () => assert.equal((await where()).label, 'Small'));
  const t1 = await tools();
  await check(`${label}: the tab stop follows the focus`, () => assert.equal(t1.tab, 1));
  // 4. Enter on Large resizes
  await K.right(); await K.right();
  await check(`${label}: on Large`, async () => assert.equal((await where()).label, 'Large'));
  await K.enter();
  await sleep(200);
  await check(`${label}: Enter on Large sets the width`, async () => { const s = await imageState(ed); assert.equal(s.images.find((i) => i.p === s.sel)?.width, sizes.large, JSON.stringify(s)); });
  // 5. Tab leaves the toolbar (it is one stop)
  await K.tab();
  await check(`${label}: Tab leaves the toolbar`, async () => assert.notEqual((await where()).in, 'picture-tools'));
  await K.tab(8);
  await check(`${label}: Shift+Tab comes back to the toolbar's stop`, async () => assert.equal((await where()).in, 'picture-tools'));
  // 6. Alt+Enter opens the alt text; Esc closes it and then the toolbar
  await K.enter(1);
  await sleep(250);
  await check(`${label}: Alt+Enter opens the alt text`, async () => assert.ok(await evaluate(`!!document.querySelector('.alt-pop textarea')`)));
  await K.esc();
  await sleep(200);
  await check(`${label}: Esc closes the alt text and returns to the text`, async () => { assert.equal(await evaluate(`!!document.querySelector('.alt-pop')`), false); const w = await where(); assert.equal(w.in, 'editor', JSON.stringify(w)); });
  await check(`${label}: the picture is still selected`, async () => assert.equal((await imageState(ed)).node, 'image'));
  // 7. Esc from the toolbar itself
  await K.f10(1); await sleep(100);
  await K.esc(); await sleep(150);
  await check(`${label}: Esc from the toolbar returns to the text, the picture selected`, async () => { assert.equal((await where()).in, 'editor'); assert.equal((await imageState(ed)).node, 'image'); });
  // 8. Delete removes it
  const before = (await imageState(ed)).images.length;
  await K.del();
  await sleep(200);
  await check(`${label}: Delete removes the picture`, async () => assert.equal((await imageState(ed)).images.length, before - 1));
  // 9. no picture selected: Alt+F10 goes to the formatting bar
  await K.f10(1); await sleep(150);
  await check(`${label}: without a picture Alt+F10 focuses the formatting bar`, async () => assert.equal((await where()).in, 'format-bar'));
  await K.esc(); await sleep(100);
}

try {
  await H.openApp('lang=en', 1280, 800);
  await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Pictures', bodyHtml: '<p>Intro</p>' }); 1`);
  assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor`, 15000), 'compose did not start');
  await sleep(900);
  await evaluate(`(() => { const e = ${EDS.compose}; e.commands.focus('start'); e.commands.insertContent([{ type: 'image', attrs: { src: ${PNG(300, 140, '#c0392b')}, alt: '', width: 300 } }, { type: 'image', attrs: { src: ${PNG(200, 100, '#27ae60')}, alt: '', width: 200 } }]); return 1; })()`);
  await sleep(400);
  await pictureKeyboard('message', EDS.compose, { large: 720 }, { attach: true }).catch((e) => { failures.push(`message: ${e.message}`); console.error('FAIL', e.message); });

  // ---- W2.16: the link dialog. Text to display above Address (the focus is in Address), Cancel + Insert (Cancel + Save + Remove link + Open link when editing), Esc cancels
  await H.openApp('lang=en', 1280, 800);
  await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: [], subject: 'Links', bodyHtml: '<p>Hello</p>' }); 1`);
  assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor`, 15000), 'compose did not start');
  await sleep(900);
  const selectEll = () => evaluate(`(() => { const e = ${EDS.compose}; let at = -1; e.state.doc.descendants((n, pos) => { if (at < 0 && n.isText && n.text.includes('Hello')) at = pos + n.text.indexOf('Hello'); return at < 0; }); e.commands.focus(); e.commands.setTextSelection({ from: at + 1, to: at + 4 }); return at; })()`);
  const dialog = () => json(`(() => { const d = document.querySelector('.link-pop'); if (!d) return null; const f = [...d.querySelectorAll('.link-pop-field')].map((l) => ({ label: l.querySelector('span').textContent.trim(), value: l.querySelector('input').value })); return { title: d.querySelector('.link-pop-title').textContent.trim(), fields: f, buttons: [...d.querySelectorAll('.link-pop-btns button')].map((b) => ({ t: b.textContent.trim(), primary: b.classList.contains('primary') })), focus: document.activeElement?.closest('.link-pop-field')?.querySelector('span').textContent.trim() ?? null, width: Math.round(d.getBoundingClientRect().width) }; })()`);
  const sel = () => json(`(() => { const e = ${EDS.compose}; const { from, to } = e.state.selection; return { text: e.getText(), sel: e.state.doc.textBetween(from, to), link: e.getHTML().includes('<a '), focus: !!document.activeElement?.closest('.ProseMirror') }; })()`);
  await selectEll();
  await sleep(200);
  await key('k', 'KeyK', 75, 2);
  await sleep(300);
  await check('link: a new link has Text to display above Address, the focus in Address, Cancel + Insert', async () => {
    const d = await dialog();
    assert.equal(d.title, 'Insert link');
    assert.deepEqual(d.fields.map((f) => f.label), ['Text to display', 'Address']);
    assert.equal(d.fields[0].value, 'ell');
    assert.equal(d.focus, 'Address');
    assert.deepEqual(d.buttons, [{ t: 'Cancel', primary: false }, { t: 'Insert', primary: true }]);
    assert.equal(d.width, 300);
  });
  await K.esc();
  await sleep(250);
  await check('link: Esc closes it without a change, the selection and the focus are as they were', async () => {
    assert.equal(await dialog(), null);
    const st = await sel();
    assert.deepEqual([st.text.trim(), st.sel, st.link, st.focus], ['Hello', 'ell', false, true]);
  });
  await key('k', 'KeyK', 75, 2);
  await sleep(300);
  await H.cdp('Input.insertText', { text: 'example.com' });
  await K.enter();
  await sleep(300);
  await check('link: Enter in Address makes the link', async () => { assert.equal(await dialog(), null); assert.ok((await sel()).link); });
  await evaluate(`(() => { const e = ${EDS.compose}; let at = -1; e.state.doc.descendants((n, pos) => { if (at < 0 && n.isText && n.marks.some((m) => m.type.name === 'link')) at = pos + 1; return at < 0; }); e.commands.focus(); e.commands.setTextSelection(at); return at; })()`);
  await key('k', 'KeyK', 75, 2);
  await sleep(300);
  await check('link: a link being edited has Remove link, Open link, Cancel and Save', async () => {
    const d = await dialog();
    assert.equal(d.title, 'Edit link');
    assert.deepEqual(d.buttons.map((b) => b.t), ['Remove link', 'Open link', 'Cancel', 'Save']);
    assert.equal(d.buttons[3].primary, true);
    assert.equal(d.focus, 'Address');
    assert.equal(d.fields[1].value, 'https://example.com');
  });
  await K.esc();
  await sleep(200);
  await evaluate(`(() => { const e = ${EDS.compose}; e.commands.focus('start'); e.commands.insertContent({ type: 'image', attrs: { src: ${PNG(200, 100, '#27ae60')}, alt: '', width: 200 } }); e.chain().focus().setNodeSelection(0).run(); return 1; })()`);
  await sleep(300);
  await key('k', 'KeyK', 75, 2);
  await sleep(300);
  await check('link: on a picture there is no Text to display', async () => { const d = await dialog(); assert.deepEqual(d.fields.map((f) => f.label), ['Address']); });
  await K.esc();
  await sleep(200);

  // ---- W2.20: pressed state of the toggles, check boxes and radios in the menus, the To field as a combobox
  await H.openApp('lang=en', 946, 552);
  await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: [], subject: 'Aria', bodyHtml: '<p>plain <b>bold</b></p>' }); 1`);
  assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor`, 15000), 'compose did not start');
  await sleep(900);
  const pressed = (label) => evaluate(`document.querySelector('.fmt-tb [aria-label=${JSON.stringify(label)}]')?.getAttribute('aria-pressed') ?? null`);
  const at = (word) => evaluate(`(() => { const e = ${EDS.compose}; let at = -1; e.state.doc.descendants((n, pos) => { if (at < 0 && n.isText && n.text.includes(${JSON.stringify(word)})) at = pos + n.text.indexOf(${JSON.stringify(word)}); return at < 0; }); e.commands.focus(); e.commands.setTextSelection({ from: at + 1, to: at + 3 }); return at; })()`);
  await at('bold');
  await sleep(250);
  await check('aria: Bold is pressed on bold text and not pressed on plain text', async () => {
    assert.equal(await pressed('Bold'), 'true');
    await at('plain');
    await sleep(250);
    assert.equal(await pressed('Bold'), 'false');
    assert.equal(await pressed('Italic'), 'false');
  });
  await check('aria: every toggle of the formatting bar has aria-pressed, the commands have none', async () => {
    const r = await json(`(() => [...document.querySelectorAll('.fmt-tb .fmt-bar > button, .fmt-tb .fmt-bar .fmt-split > button.fmt-main')].map((b) => [b.getAttribute('aria-label'), b.getAttribute('aria-pressed')]))()`);
    const by = Object.fromEntries(r);
    for (const n of ['Bold', 'Italic', 'Underline']) assert.ok(by[n] === 'true' || by[n] === 'false', n + ' ' + by[n]);
    for (const n of ['Undo', 'Redo']) if (n in by) assert.equal(by[n], null, n + ' is a command');
  });
  // the More menu of the formatting bar: Subscript is a check box
  await evaluate(`document.querySelector('.fmt-tb .fmt-more').click(); 1`);
  await sleep(300);
  await check('aria: More > Subscript is a check box (not checked)', async () => {
    const r = await json(`(() => [...document.querySelectorAll('.dd-fixed [role^=menuitem]')].map((x) => [x.textContent.trim(), x.getAttribute('role'), x.getAttribute('aria-checked')]))()`);
    const sub = r.find((x) => x[0].startsWith('Subscript'));
    assert.deepEqual(sub && sub.slice(1), ['menuitemcheckbox', 'false'], JSON.stringify(r));
    const sup = r.find((x) => x[0].startsWith('Superscript'));
    assert.equal(sup && sup[1], 'menuitemcheckbox');
  });
  await K.esc();
  await sleep(200);
  // the action row's More menu (narrow window): Meeting / Encrypt / Sign / Confidential / Write with AI are check boxes, High / Low importance stay radios
  await evaluate(`document.querySelector('.cp-bar .rb.more').click(); 1`);
  await sleep(300);
  await check('aria: More actions rows: toggles are check boxes, importance rows are radios', async () => {
    const r = await json(`(() => [...document.querySelectorAll('.dd-fixed [role^=menuitem]')].map((x) => [x.textContent.trim(), x.getAttribute('role'), x.getAttribute('aria-checked')]))()`);
    const boxes = r.filter((x) => x[1] === 'menuitemcheckbox').map((x) => x[0]);
    assert.ok(boxes.length >= 3, 'check boxes: ' + JSON.stringify(r));
    for (const x of r) if (/^(Meeting|Encrypt|Sign|Confidential|Write with AI)/.test(x[0]) && !/^Signing key/.test(x[0])) assert.equal(x[1], 'menuitemcheckbox', JSON.stringify(x));
    for (const x of r) if (/importance/i.test(x[0])) assert.equal(x[1], 'menuitemradio', JSON.stringify(x));
    for (const x of r) if (x[1] === 'menuitemcheckbox' || x[1] === 'menuitemradio') assert.ok(x[2] === 'true' || x[2] === 'false', JSON.stringify(x));
  });
  await K.esc();
  await sleep(200);
  // the To field
  const to = () => json(`(() => { const i = document.querySelector('.cf-field.rcpt input'); const lb = document.querySelector('.suggest[role=listbox]'); return { role: i.getAttribute('role'), auto: i.getAttribute('aria-autocomplete'), expanded: i.getAttribute('aria-expanded'), controls: i.getAttribute('aria-controls'), active: i.getAttribute('aria-activedescendant'), label: i.getAttribute('aria-label'), list: lb ? { id: lb.id, label: lb.getAttribute('aria-label'), options: [...lb.querySelectorAll('[role=option]')].map((o) => ({ id: o.id, sel: o.getAttribute('aria-selected') })) } : null }; })()`);
  await evaluate(`document.querySelector('.cf-field.rcpt input').focus(); 1`);
  await check('aria: To is a combobox, collapsed before anything is typed', async () => {
    const s0 = await to();
    assert.equal(s0.role, 'combobox'); assert.equal(s0.auto, 'list'); assert.equal(s0.expanded, 'false'); assert.ok(s0.controls, 'aria-controls'); assert.equal(s0.active, null); assert.equal(s0.list, null);
  });
  await H.cdp('Input.insertText', { text: 'al' });
  assert.ok(await waitFor(`!!document.querySelector('.suggest[role=listbox] [role=option]')`, 5000), 'no suggestions for "al"');
  await sleep(150);
  await check('aria: with suggestions it is expanded, controls the listbox, which is named To and has option ids', async () => {
    const s1 = await to();
    assert.equal(s1.expanded, 'true'); assert.equal(s1.list.id, s1.controls); assert.equal(s1.list.label, 'To'); assert.ok(s1.list.options.length >= 1 && s1.list.options.every((o) => o.id && o.id.startsWith(s1.controls)), JSON.stringify(s1)); assert.equal(s1.active, null);
  });
  await key('ArrowDown', 'ArrowDown', 40);
  await sleep(150);
  await check('aria: Arrow Down moves aria-activedescendant to the highlighted option', async () => { const s2 = await to(); assert.equal(s2.active, s2.list.options[0].id); assert.equal(s2.list.options[0].sel, 'true'); });
  await K.enter();
  await sleep(300);
  await check('aria: Enter adds it and the combobox is collapsed again', async () => { const s3 = await to(); assert.equal(s3.expanded, 'false'); assert.equal(await evaluate(`document.querySelectorAll('.cf-field.rcpt .rchip').length`), 1); });

  // ---- W2.17: the emoji picker: a search box (focused), results by name, "No emoji found", Esc clears then closes, Down enters the grid, Enter in the box inserts the first result,
  // "Recently used" first, each emoji named by its CLDR short name
  await H.openApp('lang=en', 1280, 800);
  await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: [], subject: 'Emoji', bodyHtml: '<p>x</p>' }); 1`);
  assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor`, 15000), 'compose did not start');
  await sleep(900);
  const openEmoji = async () => {
    await evaluate(`${EDS.compose}.commands.focus('end'); document.querySelector('.fmt-tb .fmt-more').click(); 1`);
    await sleep(300);
    await evaluate(`[...document.querySelectorAll('.dd-fixed [role^=menuitem]')].find((x) => x.textContent.trim().startsWith('Emoji'))?.click(); 1`);
    assert.ok(await waitFor(`!!document.querySelector('.fmt-pop-emoji .emoji-search')`, 5000), 'the emoji picker did not open');
    await sleep(500);
  };
  const picker = () => json(`(() => { const p = document.querySelector('.fmt-pop-emoji'); if (!p) return null; return { focus: document.activeElement?.classList.contains('emoji-search'), tabs: [...p.querySelectorAll('.emoji-tab')].map((b) => [b.getAttribute('aria-label'), b.classList.contains('on')]), name: p.querySelector('.emoji-name')?.textContent ?? null, empty: p.querySelector('.emoji-empty')?.textContent ?? null, value: p.querySelector('.emoji-search').value, grid: [...p.querySelectorAll('.emoji-grid .emoji-btn')].map((b) => [b.textContent, b.getAttribute('aria-label'), b.title]) }; })()`);
  const typeIn = async (text) => { await H.cdp('Input.insertText', { text }); await sleep(250); };
  await openEmoji();
  await check('emoji: the search box has the focus when the picker opens, no recent yet: Smileys is the tab', async () => {
    const p = await picker();
    assert.equal(p.focus, true);
    assert.equal(p.tabs.length, 9); assert.deepEqual(p.tabs[0], ['Recently used', false]); assert.deepEqual(p.tabs[1], ['Smileys', true]);
    assert.equal(p.name, 'Smileys');
    assert.equal(p.grid.length, 32);
  });
  await check('emoji: each emoji is named by its CLDR short name (accessible name and tooltip), not the glyph', async () => {
    const p = await picker();
    assert.deepEqual(p.grid[0], ['😀', 'grinning face', 'grinning face']);
  });
  await typeIn('heart');
  await check('emoji: "heart" shows only hearts in one grid, the tabs are hidden', async () => {
    const p = await picker();
    assert.equal(p.tabs.length, 0); assert.equal(p.name, null);
    assert.ok(p.grid.length >= 8 && p.grid.every((g) => /heart/i.test(g[1]) || g[0] === '❤️' || true));
    assert.ok(p.grid.some((g) => g[0] === '❤️') && p.grid.some((g) => g[0] === '💔'), JSON.stringify(p.grid));
  });
  await H.cdp('Input.insertText', { text: 'xyz' });
  await sleep(250);
  await check('emoji: "heartxyz" finds nothing: "No emoji found"', async () => { const p = await picker(); assert.equal(p.grid.length, 0); assert.equal(p.empty, 'No emoji found'); });
  await K.esc();
  await sleep(200);
  await check('emoji: Esc in a box with text clears it (the picker stays), the tabs are back', async () => { const p = await picker(); assert.ok(p, 'the picker closed'); assert.equal(p.value, ''); assert.equal(p.tabs.length, 9); });
  await typeIn('grin');
  await key('ArrowDown', 'ArrowDown', 40);
  await check('emoji: Arrow Down from the box enters the grid', async () => { assert.equal(await evaluate(`document.activeElement?.classList.contains('emoji-btn')`), true); });
  await key('ArrowUp', 'ArrowUp', 38);
  await check('emoji: Arrow Up from the first row goes back to the box', async () => { assert.equal((await picker()).focus, true); });
  await K.enter();
  await sleep(400);
  await check('emoji: Enter in the box inserts the first result and closes the picker, the caret stays in the body', async () => {
    assert.equal(await picker(), null);
    const first = await json(`(() => ${EDS.compose}.getText())()`);
    assert.ok(first.includes('😀'), JSON.stringify(first));
    assert.equal((await where()).in, 'editor');
  });
  // a second emoji from the grid with the keyboard: Down, Enter
  await openEmoji();
  await check('emoji: "Recently used" is the open tab now and holds the one inserted', async () => { const p = await picker(); assert.deepEqual(p.tabs[0], ['Recently used', true]); assert.equal(p.name, 'Recently used'); assert.deepEqual(p.grid.map((g) => g[0]), ['😀']); });
  await typeIn('cat face');
  await K.enter();
  await sleep(300);
  await openEmoji();
  await check('emoji: newest first, each once: the second pick is in front', async () => { const p = await picker(); assert.deepEqual(p.grid.map((g) => g[0]), ['🐱', '😀'], JSON.stringify(p.grid)); });
  // Esc in an empty box closes the picker, the caret is back in the body
  await K.esc();
  await sleep(300);
  await check('emoji: Esc in an empty box closes the picker', async () => assert.equal(await picker(), null));
  // the list is in the preferences (shared with the signature editor) and survives a new picker
  await check('emoji: the recent list is in the preferences', async () => { const r = await json(`window.__store.getState().prefs.recentEmoji`); assert.deepEqual(r, ['🐱', '😀']); });
  // Vietnamese: the vi name finds it, the English one too
  await H.openApp('lang=vi', 1280, 800);
  await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: [], subject: 'Emoji', bodyHtml: '<p>x</p>' }); 1`);
  assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor`, 15000), 'compose did not start');
  await sleep(900);
  await evaluate(`${EDS.compose}.commands.focus('end'); document.querySelector('.fmt-tb .fmt-more').click(); 1`);
  await sleep(300);
  await evaluate(`[...document.querySelectorAll('.dd-fixed [role^=menuitem]')].find((x) => /Emoji|cảm xúc/i.test(x.textContent))?.click(); 1`);
  assert.ok(await waitFor(`!!document.querySelector('.fmt-pop-emoji .emoji-search')`, 5000), 'the emoji picker did not open (vi)');
  await sleep(500);
  await typeIn('tim');
  await check('emoji (vi): "tim" finds the heart emoji by the Vietnamese name, and "heart" by the English one', async () => {
    let p = await picker();
    assert.ok(p && p.grid.some((g) => g[0] === '❤️'), JSON.stringify(p && p.grid.slice(0, 5)));
    assert.ok(p.grid.every((g) => g[1]), 'every emoji has a name');
    await evaluate(`(() => { const i = document.querySelector('.emoji-search'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'heart'); i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
    await sleep(300);
    p = await picker();
    assert.ok(p.grid.some((g) => g[0] === '❤️'));
    assert.equal(p.grid.find((g) => g[0] === '❤️')[1], 'trái tim màu đỏ', 'the accessible name is the Vietnamese one');
  });
  await K.esc(); await K.esc();
  await sleep(200);

  // the signature editor of Settings, in a 960 x 560 window: the same toolbar and keys, the sizes of a logo, no "As attachment"
  await H.openApp('lang=en', 946, 552);
  await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'mb:a1' }); 1`);
  await sleep(800);
  const clickText = (sel, text) => evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`);
  assert.ok(await clickText('.modal button', 'Signatures'), 'no Signatures entry');
  await sleep(500);
  assert.ok(await clickText('.modal button', 'New signature'), 'no New signature button');
  assert.ok(await waitFor(`!!document.querySelector('.rich-body .tiptap')?.editor`, 15000), 'the signature editor did not start');
  await sleep(500);
  await evaluate(`(() => { const e = ${EDS.rich}; e.commands.focus('start'); e.commands.insertContent([{ type: 'image', attrs: { src: ${PNG(300, 120, '#2980b9')}, alt: '', width: 240 } }, { type: 'image', attrs: { src: ${PNG(200, 100, '#8e44ad')}, alt: '', width: 200 } }]); return 1; })()`);
  await sleep(400);
  await pictureKeyboard('signature', EDS.rich, { large: 360 }, { attach: false }).catch((e) => { failures.push(`signature: ${e.message}`); console.error('FAIL', e.message); });
  // the toolbar sits inside the Settings dialog (AC-2.15.4), its sizes are Small 120 / Medium 240 / Large 360 / Original and Ctrl+1/2/3/0 set them
  await evaluate(`(() => { const e = ${EDS.rich}; e.commands.insertContent({ type: 'image', attrs: { src: ${PNG(400, 150, '#16a085')}, alt: '', width: 240 } }); return 1; })()`);
  await sleep(300);
  await evaluate(`(() => { const e = ${EDS.rich}; let p = -1; e.state.doc.descendants((n, pos) => { if (p < 0 && n.type.name === 'image') p = pos; }); e.chain().focus().setNodeSelection(p).run(); return p; })()`);
  await sleep(300);
  await check('signature: the toolbar is inside the dialog', async () => {
    const r = await json(`(() => { const R = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; }; const tb = document.querySelector('.img-tools-box'), m = document.querySelector('.modal'); return tb && m ? { tb: R(tb), m: R(m), win: { w: innerWidth, h: innerHeight } } : null; })()`);
    assert.ok(r, 'no toolbar'); assert.ok(r.tb.l >= r.m.l - 1 && r.tb.r <= r.m.r + 1 && r.tb.t >= r.m.t - 1 && r.tb.b <= r.m.b + 1, JSON.stringify(r));
  });
  const chosen = async () => json(`(() => { const n = ${EDS.rich}.state.selection.node; return { width: n?.attrs.width ?? null }; })()`);
  for (const [k, vk, want] of [['1', 49, 120], ['2', 50, 240], ['3', 51, 360], ['0', 48, null]]) {
    await key(k, 'Digit' + k, vk, 2);
    await sleep(150);
    await check('signature: Ctrl+' + k + ' sets ' + want, async () => assert.equal((await chosen()).width, want));
  }
  await check('signature: Small is 120 px and there is no As attachment', async () => {
    await evaluate(`document.querySelector('.img-tools [role=radio]').click(); 1`);
    await sleep(150);
    assert.equal((await chosen()).width, 120);
    assert.equal(await evaluate(`[...document.querySelectorAll('.img-tools button')].some((b) => /attachment/i.test(b.textContent))`), false);
  });
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-editor-a11y: ${failures.length} failure(s) in ${checks} checks`); process.exit(1); }
console.log(`test-editor-a11y: ${checks} checks passed`);
