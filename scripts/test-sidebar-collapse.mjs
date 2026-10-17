#!/usr/bin/env node
// The side menu (folder pane) as a column of icons (v1.0.6): collapse / expand control, the automatic fold in a narrow window, the peek over the
// panes, the saved choice, the minimum widths of the list and the reading pane. The rules themselves (every mode x width) are in
// scripts/test-sidebar-state.mjs; this measures the real layout in the dev preview (src/devMock.ts has the mailboxes, folders and unread counts).
//
// Per combination it asserts:
//   auto      the menu is icons below 1100 px and in full from 1100 px, in both directions, at 960, 1099, 1100, 1280 and 1920; list >= 300 px and
//             reading pane >= 440 px wide, the three columns touch (no gap, no overlap), nothing sticks out of the window
//   peek      the pointer at rest on the icons (not before ~200 ms) opens the full menu OVER the list and the reading pane, which do not move by a
//             pixel; it closes when the pointer leaves, on Escape (the open conversation stays), after a folder was chosen (and does not come back
//             under the pointer); the keyboard focus coming in (Tab) opens it; a drag held over the icons opens it; the menu of a mailbox keeps it open
//   choice    the control saves "collapsed" / "expanded"; it survives a reload and a wider / narrower window; "expanded" without room for the panes
//             is icons plus a pinned overlay (the panes keep their minimums); Settings > Appearance has the three states and "Reset to automatic"
//   names     every icon has a tooltip and an accessible name (the mailbox: display name, address, unread count), the control says whether the menu is
//             open, no word of the menu is left in the icon column, no raw translation key shows
//   reorder   a mailbox can be moved in the icon column: Alt+Up / Alt+Down and its menu (key and right-click), focus stays on it
//   still     while the menu folds / opens, the columns glide without a jump (nothing moves vertically, the three columns stay in step, the width
//             goes one way only); with reduced motion the new layout is there at once
//
//   node scripts/test-sidebar-collapse.mjs                         en + de x 960x560, 1100x720, 1280x720, 1920x1080 x light + dark
//   node scripts/test-sidebar-collapse.mjs --quick                 en 960x560 light and de 1280x720 dark (what CI runs)
//   node scripts/test-sidebar-collapse.mjs --lang=en,de --size=960x560 --theme=dark --shots=<dir>   (PNGs: icons, open, peek)
//   node scripts/test-sidebar-collapse.mjs --url=http://127.0.0.1:1420/    use a dev server that is already running
//   node scripts/test-sidebar-collapse.mjs --require-browser       fail (instead of skipping) when no Chrome/Chromium/Edge is installed
import fs from 'node:fs';
import path from 'node:path';
import { arg, flag, inputs, ROOT, sleep, startHarness } from './cdp-harness.mjs';

const QUICK = flag('quick');
const SHOTS = arg('shots');
const CONFIGS = [];
if (QUICK) CONFIGS.push({ lang: 'en', w: 960, h: 560, theme: 'light' }, { lang: 'de', w: 1280, h: 720, theme: 'dark' });
else for (const lang of (arg('lang') || 'en,de').split(',')) for (const size of (arg('size') || '960x560,1100x720,1280x720,1920x1080').split(',')) for (const theme of (arg('theme') || 'light,dark').split(',')) CONFIGS.push({ lang, w: Number(size.split('x')[0]), h: Number(size.split('x')[1]), theme });

// the numbers of src/sidebarState.ts (checked below that they are still there)
const RAIL_W = 56, OPEN_W = 248, SPLITTER = 6, MIN_LIST = 300, MIN_READER = 440, BREAKPOINT = 1100;
const srcState = fs.readFileSync(path.join(ROOT, 'src/sidebarState.ts'), 'utf8');
for (const [name, v] of [['RAIL_W', RAIL_W], ['SPLITTER_W', SPLITTER], ['AUTO_COLLAPSE_BELOW', BREAKPOINT], ['MIN_READER_W', MIN_READER]]) {
  if (!new RegExp(`${name} = ${v};`).test(srcState)) { console.error(`test-sidebar-collapse: src/sidebarState.ts ${name} is no longer ${v}: update this test`); process.exit(1); }
}

const H = await startHarness('test-sidebar-collapse', { vitePort0: 5620, cdpPort0: 9620 });
const { evaluate, cdp } = H;
const failures = [];
let checks = 0;
let cfg = null;
const fail = (msg) => { const line = `[${cfg.lang} ${cfg.w}x${cfg.h} ${cfg.theme}] ${msg}`; failures.push(line); console.error('FAIL ' + line); };
const ok = (cond, msg) => { checks++; if (!cond) fail(msg); };
const near = (a, b, d = 1) => Math.abs(a - b) <= d;

// ---------- input ----------
const move = (x, y, buttons = 0) => cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons, button: buttons ? 'left' : 'none' });
// a key with its virtual key code (Chrome moves the focus on Tab only for a key that has one); modifiers: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift
const VK = { Tab: 9, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, ContextMenu: 93, Enter: 13 };
const press = async (key, modifiers = 0) => {
  const p = { key, code: key, windowsVirtualKeyCode: VK[key], nativeVirtualKeyCode: VK[key], modifiers };
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...p });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
};
const rightClick = async (selector) => {
  const [x, y] = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  await move(x, y);
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', clickCount: 1 });
};
const resize = async (w, h) => { await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }); await sleep(450); }; // (the columns glide for 200 ms)
/** Polls `expr` until it is true; returns the milliseconds it took, or -1. */
const until = async (expr, ms = 2500) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(expr)) return Date.now() - t0; await sleep(25); } return -1; };

// ---------- what is measured ----------
const STATE = `(() => {
  const R = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, r: r.right }; };
  const pane = document.querySelector('.folder-pane'), st = window.__store.getState();
  return { pref: st.prefs.sidebar, side: pane.dataset.sidebar, pane: R(pane), surf: R(pane.querySelector('.fp-surface')), list: R(document.querySelector('.msg-list')), reader: R(document.querySelector('.reading-region')),
    over: document.documentElement.scrollWidth - window.innerWidth, vw: window.innerWidth, scrollY: window.scrollY };
})()`;
const state = () => evaluate(STATE);
const sideIs = (s) => `document.querySelector('.folder-pane').dataset.sidebar === '${s}'`;

/** The layout in the three columns: the menu as wide as `side` says, the list and the reading pane next to it, at their minimums, filling the window. */
function layoutOk(label, s, side, w) {
  ok(s.side === side, `${label}: the menu is "${s.side}", want "${side}"`);
  const colW = side === 'open' ? OPEN_W : RAIL_W;
  ok(near(s.pane.w, colW), `${label}: the menu column is ${s.pane.w}px, want ${colW}`);
  ok(near(s.list.x, colW + SPLITTER), `${label}: the list starts at ${s.list.x}, want ${colW + SPLITTER} (a gap or an overlap)`);
  ok(near(s.reader.x, s.list.r + SPLITTER), `${label}: the reading pane starts at ${s.reader.x}, the list ends at ${s.list.r}`);
  ok(near(s.reader.r, w), `${label}: the reading pane ends at ${s.reader.r}, the window is ${w} wide`);
  ok(s.list.w >= MIN_LIST - 0.5, `${label}: the list is ${s.list.w}px wide (minimum ${MIN_LIST})`);
  ok(s.reader.w >= MIN_READER - 0.5, `${label}: the reading pane is ${s.reader.w}px wide (minimum ${MIN_READER})`);
  ok(s.over <= 0, `${label}: the page is ${s.over}px wider than the window`);
  ok(s.scrollY === 0, `${label}: the page scrolled`);
}

async function open(hash, w, h) {
  await H.openApp(hash, w, h);
  await evaluate(`window.__errs = []; addEventListener('error', (e) => window.__errs.push(String(e.message))); addEventListener('unhandledrejection', (e) => window.__errs.push(String(e.reason))); 1`);
  await sleep(300);
}

async function runConfig(c) {
  cfg = c;
  const tag = `${c.lang}-${c.w}x${c.h}-${c.theme}`;
  const io = inputs(H, SHOTS, tag);
  const base = `${c.theme}&lang=${c.lang}`;
  // the saved settings of the preview live in localStorage with `#persist`: start from none
  await open(base, c.w, c.h);
  await evaluate(`localStorage.removeItem('hl-mock-settings'); 1`);
  await open(`${base}&persist`, c.w, c.h);
  ok((await evaluate(`document.documentElement.lang`)) === c.lang, `the page is not in ${c.lang}`);
  ok((await state()).pref === 'auto', 'the default is automatic');

  // ===== 1. automatic: the breakpoint, in both directions =====
  for (const w of [960, 1099, 1100, 1280, 1920, 1099, 960, 1920]) {
    await resize(w, c.h);
    const s = await state();
    layoutOk(`auto ${w}`, s, w < BREAKPOINT ? 'rail' : 'open', w);
    ok(s.pref === 'auto', `auto ${w}: resizing the window changed the saved choice to ${s.pref}`);
  }

  // ===== 1b. the control stays at the top while the folder list scrolls (BUG-B2 of the v1.0.6 final QA), icons and full menu =====
  for (const w of [960, 1280]) {
    await resize(w, 360); // (short: the list of folders overflows in both states)
    for (const mode of ['auto', 'expanded']) {
      // "expanded" at 960 is the pinned overlay, at 1280 the column; "auto" is the icons at 960 and the full menu at 1280
      await evaluate(`window.__store.getState().setPrefs({ sidebar: '${mode}' }); 1`);
      await sleep(450);
      const probe = `(() => { const sf = document.querySelector('.fp-surface'), t = document.querySelector('.fp-toggle'), a = sf.getBoundingClientRect(), b = t.getBoundingClientRect(); return { top: b.top - a.top, bottom: b.bottom - a.top, h: a.height, st: sf.scrollTop, over: sf.scrollHeight - sf.clientHeight, side: document.querySelector('.folder-pane').dataset.sidebar }; })()`;
      const b0 = await evaluate(probe);
      const label = `sticky control ${w} ${mode} (${b0.side})`;
      ok(b0.over > 320, `${label}: the folder list does not overflow enough to scroll 300px (${b0.over}px)`);
      await move(w < 1100 && b0.side === 'rail' ? 28 : 120, 200);
      await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 28, y: 200, deltaX: 0, deltaY: 300 });
      await sleep(350);
      const b1 = await evaluate(probe);
      ok(b1.st > 100, `${label}: the folder list did not scroll (scrollTop ${b1.st})`);
      ok(near(b1.top, b0.top, 0.5) && b1.top >= 0 && b1.bottom <= b1.h, `${label}: the control moved from y=${b0.top} to y=${b1.top} while the list scrolled (surface ${b1.h}px)`);
      ok(await evaluate(`(() => { const t = document.querySelector('.fp-toggle'), r = t.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return e === t || t.contains(e); })()`), `${label}: something covers the control after scrolling`);
      await io.shot(`sticky-${w}-${mode}`);
      await evaluate(`document.querySelector('.fp-surface').scrollTop = 0; 1`);
    }
    await move(700, 300);
    await evaluate(`window.__store.getState().setPrefs({ sidebar: 'auto' }); 1`);
  }
  await resize(c.w, c.h);

  // ===== 2. what the icon column holds, names and tooltips =====
  await resize(960, c.h);
  await evaluate(`window.__store.getState().setView('inbox', 'a1'); 1`);
  await sleep(250);
  const names = await evaluate(`(() => {
    const pane = document.querySelector('.folder-pane'), a = (e) => ({ title: e.getAttribute('title') || '', label: e.getAttribute('aria-label') || '', text: (e.textContent || '').trim(), shown: !!(e.offsetWidth || e.offsetHeight) });
    const accounts = window.__store.getState().accounts;
    return {
      toggle: (() => { const t = pane.querySelector('.fp-toggle'); return { ...a(t), expanded: t.getAttribute('aria-expanded') }; })(),
      avatars: [...pane.querySelectorAll('.fp-avatar')].map((e) => ({ ...a(e), pip: (e.querySelector('.fp-pip') || {}).textContent || '', id: e.closest('[data-reorder-id]').dataset.reorderId })),
      rows: [...pane.querySelectorAll('.fp-row')].map((e) => ({ ...a(e), icon: !!e.querySelector('.fp-ico svg'), word: !!(e.querySelector('.fp-lbl') && e.querySelector('.fp-lbl').offsetWidth), star: !!e.querySelector('.fp-star'), group: (e.closest('[data-reorder-id]') || {}).dataset?.reorderId || '' })),
      accounts: accounts.map((x) => ({ id: x.id, email: x.email, name: x.displayName })),
      modules: [...pane.querySelectorAll('.fp-modules button')].map((e) => ({ ...a(e), word: !!(e.querySelector('.fp-mlbl') && e.querySelector('.fp-mlbl').offsetWidth) })),
      text: pane.innerText,
    };
  })()`);
  ok(names.toggle.expanded === 'false', 'the control of the icon column does not say "not expanded"');
  ok(names.toggle.label && !/^mail\./.test(names.toggle.label), `the control has no name (${names.toggle.label})`);
  ok(/(Ctrl|Cmd)\+B/.test(names.toggle.title) && names.toggle.title.startsWith(names.toggle.label), `the control's tooltip is "${names.toggle.title}"`);
  ok(names.avatars.length === names.accounts.length && names.avatars.length >= 2, `${names.avatars.length} mailboxes in the icon column for ${names.accounts.length} accounts`);
  for (const av of names.avatars) {
    const acc = names.accounts.find((x) => x.id === av.id);
    ok(av.title && av.label, `mailbox ${av.id} has no tooltip / name`);
    ok(av.title.includes(acc.email) || av.title === acc.email, `the tooltip of ${acc.email} lacks the address: "${av.title}"`);
    if (acc.name && acc.name.toLowerCase() !== acc.email.toLowerCase()) ok(av.title.includes(acc.name) && av.label.includes(acc.name), `the display name "${acc.name}" is not in the tooltip / name of ${acc.email}`);
    ok(av.text === '' || av.text === av.pip, `the mailbox ${acc.email} shows words in the icon column: "${av.text}"`);
  }
  const unreadAcc = names.avatars.find((x) => x.pip);
  ok(!!unreadAcc && /\d/.test(unreadAcc.title) && /\d/.test(unreadAcc.label), 'an unread count is not in the tooltip / name of a mailbox that has unread mail');
  ok(names.rows.length > 8, `${names.rows.length} folder icons`);
  for (const r of names.rows) {
    ok(r.title && r.label, `a folder icon without tooltip / name (${r.title}|${r.label})`);
    ok(r.icon && !r.word && !r.star, `a folder icon shows words or a star: ${JSON.stringify(r)}`);
    ok(r.title.replace(/\n/g, ', ') === r.label, `tooltip "${r.title}" and name "${r.label}" differ`);
  }
  const mine = names.rows.filter((r) => r.group === 'a1');
  ok(mine.length === 8, `${mine.length} folders of the selected mailbox in the icon column (6 standard, 2 custom)`);
  ok(mine.some((r) => /Very long folder name/.test(r.title)), 'the full name of a custom folder is not its tooltip');
  ok(!names.rows.some((r) => r.group && r.group !== 'a1'), 'folders of a mailbox that is not selected are in the icon column');
  ok(names.modules.length === 2 && names.modules.every((m) => m.title && m.label && !m.word), 'the Mail / Calendar buttons show words or have no name');
  ok(!/\bmail\.side\.|\bsettings\./.test(names.text), `a translation key shows: ${names.text.slice(0, 80)}`);
  ok(names.text.replace(/\s+/g, '') === '' || names.text.replace(/\s+/g, '').length < 12, `words in the icon column: "${names.text.replace(/\s+/g, ' ').slice(0, 60)}"`);
  await io.shot('rail');

  // ===== 3. the peek =====
  await evaluate(`(async () => { const st = window.__store.getState(); await st.setView('inbox', null); const id = window.__store.getState().threads[0].threadId; await window.__store.getState().openMail(id); })()`);
  await sleep(400);
  const before = await state();
  const selected = await evaluate(`window.__store.getState().selected`);
  ok(!!selected, 'no conversation is open for the peek test');
  await move(700, 400); // elsewhere first
  await sleep(150);
  await move(28, 300);
  await sleep(90);
  ok((await evaluate(sideIs('rail'))), 'the menu opened before the pointer had rested on the icons');
  const tOpen = await until(sideIs('peek'));
  ok(tOpen >= 0, 'the pointer at rest on the icons did not open the menu');
  await sleep(250); // (the menu slides in)
  const peek = await state();
  ok(near(peek.surf.w, OPEN_W), `the peek is ${peek.surf.w}px wide, want ${OPEN_W}`);
  ok(near(peek.surf.x, 0) && peek.surf.r > peek.list.x + 40, `the peek does not lie over the list (menu ${peek.surf.x}..${peek.surf.r}, list from ${peek.list.x})`);
  ok(near(peek.pane.w, RAIL_W), `the menu column changed to ${peek.pane.w}px in the peek`);
  for (const k of ['list', 'reader']) for (const f of ['x', 'y', 'w', 'h']) ok(near(peek[k][f], before[k][f], 0.5), `the peek moved the ${k} (${f}: ${before[k][f]} -> ${peek[k][f]})`);
  ok(await evaluate(`(() => { const e = document.elementFromPoint(150, 300); return !!e && !!e.closest('.folder-pane'); })()`), 'the peek is not on top of the list');
  ok(await evaluate(`document.querySelectorAll('.folder-pane .fp-lbl').length > 5 && [...document.querySelectorAll('.folder-pane .fp-lbl')].some((e) => e.offsetWidth > 0)`), 'the peek shows no words');
  await io.shot('peek');
  await move(700, 400);
  ok((await until(sideIs('rail'), 1500)) >= 0, 'the peek stayed open after the pointer left');
  // Escape
  await move(28, 300);
  ok((await until(sideIs('peek'))) >= 0, 'the peek did not open again');
  const why = await evaluate(`JSON.stringify({ own: [...document.querySelectorAll('.modal, .ctx-menu, .dd-fixed')].map((e) => e.className), active: document.activeElement.outerHTML.slice(0, 80) })`);
  await press('Escape');
  ok((await until(sideIs('rail'), 600)) >= 0, `Escape did not close the peek ${why}`);
  ok((await evaluate(`window.__store.getState().selected`)) === selected, 'Escape in the peek closed the open conversation');
  await sleep(500);
  ok(await evaluate(sideIs('rail')), 'the peek came back under the pointer after Escape');
  // choosing a folder closes it, and it does not come back under the pointer
  await move(700, 400);
  await sleep(300);
  await move(28, 300);
  ok((await until(sideIs('peek'))) >= 0, 'the peek did not open for the folder test');
  await io.click('.folder-pane .fp-row[aria-selected="false"]');
  ok((await until(sideIs('rail'), 800)) >= 0, 'the peek stayed open after a folder was chosen');
  await sleep(500);
  ok(await evaluate(sideIs('rail')), 'the peek came back under the pointer after a folder was chosen');
  // the keyboard
  await move(700, 400);
  await sleep(400);
  await evaluate(`(() => { const b = [...document.querySelectorAll('.ribbon-row button:not(:disabled)')].pop(); b.focus(); })()`);
  let inPane = false;
  for (let i = 0; i < 8 && !inPane; i++) { await press('Tab'); inPane = await evaluate(`!!document.activeElement.closest('.folder-pane')`); }
  ok(inPane, 'Tab never reached the side menu');
  ok((await until(sideIs('peek'), 600)) >= 0, 'the keyboard focus coming into the icons did not open the menu');
  ok(await evaluate(`document.activeElement.classList.contains('fp-toggle')`), 'the first stop of the side menu is not its control');
  await press('Escape');
  ok((await until(sideIs('rail'), 600)) >= 0, 'Escape did not close the peek that the keyboard opened');
  ok(await evaluate(`!!document.activeElement.closest('.folder-pane')`), 'Escape took the focus out of the side menu');
  await press('Tab', 8); // Shift+Tab from its first stop leaves it
  ok(!(await evaluate(`!!document.activeElement.closest('.folder-pane')`)), 'Tab never left the side menu');
  await sleep(300);
  ok(await evaluate(sideIs('rail')), 'the menu stayed open after the focus left it');
  // a drag held over the icons (what a message dragged onto a folder does): the menu opens after a moment, closes when the drag leaves
  await evaluate(`(() => { const p = document.querySelector('.folder-pane'); p.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true })); })()`);
  await sleep(150);
  ok(await evaluate(sideIs('rail')), 'a drag opened the menu at once');
  ok((await until(sideIs('peek'), 1500)) >= 0, 'a drag held over the icons did not open the menu');
  await evaluate(`document.querySelector('.folder-pane').dispatchEvent(new DragEvent('dragleave', { bubbles: true, relatedTarget: document.body }))`);
  ok((await until(sideIs('rail'), 1500)) >= 0, 'the menu stayed open after the drag left');
  // a folder icon is a drop target of its own: it is on top at its own place and a drag over it reaches the pane
  const target = await evaluate(`(() => { const e = document.querySelector('.folder-pane .fp-row'); const r = e.getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { hit: !!t && e.contains(t), w: r.width, h: r.height }; })()`);
  ok(target.hit && target.w >= 32 && target.h >= 30, `a folder icon is not a usable target: ${JSON.stringify(target)}`);
  await move(700, 400);
  await sleep(300);

  // ===== 4. the mailbox menu and the order in the icon column =====
  const order = () => evaluate(`window.__store.getState().accounts.map((a) => a.id).join()`);
  const o0 = await order();
  await evaluate(`document.querySelector('[data-reorder-id="a2"] [data-reorder-focus]').focus(); 1`);
  await press('ArrowUp', 1); // Alt+Up
  await sleep(250);
  const o1 = await order();
  ok(o1 !== o0 && o1.startsWith('a2,a1'), `Alt+Up in the icon column did not move the mailbox (${o0} -> ${o1})`);
  ok(await evaluate(`document.activeElement.closest('[data-reorder-id]')?.dataset.reorderId === 'a2' && document.activeElement.hasAttribute('data-reorder-focus')`), 'the focus left the mailbox that was moved');
  await press('ArrowDown', 1);
  await sleep(250);
  ok((await order()) === o0, 'Alt+Down did not move the mailbox back');
  await press('ContextMenu');
  ok((await until(`document.querySelectorAll('.ctx-menu [role=menuitem], .ctx-menu .menu-row').length >= 2`, 1500)) >= 0, 'the menu key on a mailbox opened no menu');
  ok(await evaluate(sideIs('peek')), 'the menu of a mailbox closed the peek');
  await press('Escape');
  await sleep(250);
  ok(await evaluate(`!document.querySelector('.ctx-menu')`), 'Escape did not close the mailbox menu');
  ok(await evaluate(`!!document.activeElement.closest('.folder-pane')`), 'the focus did not return to the mailbox after its menu');
  await evaluate(`document.activeElement.blur(); 1`);
  await move(700, 400);
  await sleep(400);
  await rightClick('[data-reorder-id="a3"] .fp-avatar');
  ok((await until(`document.querySelectorAll('.ctx-menu .menu-row, .ctx-menu [role=menuitem]').length >= 2`, 1500)) >= 0, 'a right-click on a mailbox opened no menu');
  if (!(await evaluate(`!!document.querySelector('.ctx-menu')`))) throw new Error('no mailbox menu to use');
  const item = await evaluate(`(() => { const e = [...document.querySelectorAll('.ctx-menu .menu-row, .ctx-menu [role=menuitem]')][0]; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  await move(item[0], item[1]);
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: item[0], y: item[1], button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: item[0], y: item[1], button: 'left', clickCount: 1 });
  await sleep(300);
  const o2 = await order();
  ok(o2.indexOf('a3') < o0.indexOf('a3'), `"Move up" of the mailbox menu did not move it (${o0} -> ${o2})`);
  await move(700, 400);
  await sleep(400);
  ok(await evaluate(sideIs('rail')), 'the peek stayed open after the mailbox menu was used and the pointer left');
  // moving by the pointer: grip + drag
  const grip = await evaluate(`(() => { const g = document.querySelector('[data-reorder-id="a5"] .reorder-grip'); g.scrollIntoView({ block: 'nearest' }); const r = g.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  await move(grip[0], grip[1]);
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: grip[0], y: grip[1], button: 'left', buttons: 1, clickCount: 1 });
  await move(grip[0], grip[1] - 30, 1);
  await move(grip[0], grip[1] - 120, 1);
  await sleep(120);
  const dragging = await evaluate(`({ line: !!document.querySelector('.reorder-line'), ghost: !!document.querySelector('.reorder-ghost'), side: document.querySelector('.folder-pane').dataset.sidebar })`);
  ok(dragging.ghost, 'dragging a mailbox by its grip shows no preview');
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: grip[0], y: grip[1] - 120, button: 'left', clickCount: 1 });
  await sleep(250);
  ok((await order()) !== o2, 'dragging a mailbox by its grip in the icon column did not move it');
  await move(700, 400);
  await sleep(400);

  // ===== 5. the calendar's icon column =====
  await evaluate(`window.__store.getState().setModule('calendar'); 1`);
  ok((await until(`document.querySelectorAll('.folder-pane .fp-cal').length > 0`, 2500)) >= 0, 'the calendar has no icons in the icon column');
  const cals = await evaluate(`[...document.querySelectorAll('.folder-pane .fp-cal')].map((e) => ({ title: e.title, label: e.getAttribute('aria-label'), pressed: e.getAttribute('aria-pressed') }))`);
  ok(cals.every((x) => x.title && x.label && (x.pressed === 'true' || x.pressed === 'false')), 'a calendar icon has no name or no state');
  await io.click('.folder-pane .fp-cal');
  await sleep(300);
  ok((await evaluate(`document.querySelector('.folder-pane .fp-cal').getAttribute('aria-pressed')`)) !== cals[0].pressed, 'a click on a calendar icon did not show / hide it');
  await io.click('.folder-pane .fp-cal');
  await evaluate(`window.__store.getState().setModule('mail'); 1`);
  await sleep(300);

  // ===== 6. the saved choice =====
  await move(700, 400);
  await resize(1280, c.h);
  layoutOk('1280', await state(), 'open', 1280);
  // the control folds it; the three columns glide without a jump (the start of the sampler is before the click)
  const sample = async (action) => {
    await evaluate(`(() => { window.__s = []; const t0 = performance.now(); const tick = () => { const p = document.querySelector('.folder-pane').getBoundingClientRect(), l = document.querySelector('.msg-list').getBoundingClientRect(), r = document.querySelector('.reading-region').getBoundingClientRect(); window.__s.push([performance.now() - t0, p.width, l.left, l.top, r.left, r.top, document.documentElement.scrollWidth - innerWidth, window.scrollY]); if (performance.now() - t0 < 900) requestAnimationFrame(tick); }; tick(); })()`);
    await sleep(60);
    await action();
    await sleep(900);
    return evaluate(`window.__s`);
  };
  const steady = (label, s, from, to, glides) => {
    ok(s.length > 5, `${label}: only ${s.length} frames sampled`);
    ok(s.every((f) => near(f[3], s[0][3], 0.5) && near(f[5], s[0][5], 0.5)), `${label}: the list or the reading pane moved vertically`);
    ok(s.every((f) => near(f[2], f[1] + SPLITTER, 1)), `${label}: the list is not next to the menu in every frame`);
    ok(s.every((f) => f[6] <= 0 && f[7] === 0), `${label}: the page grew wider than the window / scrolled`);
    const ws = s.map((f) => f[1]);
    ok(near(ws[0], from) && near(ws[ws.length - 1], to), `${label}: the menu went ${ws[0]} -> ${ws[ws.length - 1]}, want ${from} -> ${to}`);
    const dir = Math.sign(to - from);
    ok(ws.every((x, i) => i === 0 || (x - ws[i - 1]) * dir >= -0.5), `${label}: the menu width does not go one way only`);
    ok(ws.every((x) => x >= Math.min(from, to) - 0.5 && x <= Math.max(from, to) + 0.5), `${label}: the menu width overshoots`);
    const distinct = new Set(ws.map((x) => Math.round(x))).size;
    ok(glides ? distinct >= 4 : distinct <= 3, `${label}: ${distinct} different widths on the way (${glides ? 'it should glide' : 'it should be at once'})`);
    const done = s.find((f) => near(f[1], to, 0.5));
    ok(done && done[0] < 500, `${label}: not at its width after 500 ms`);
  };
  steady('fold', await sample(() => io.click('.fp-toggle')), OPEN_W, RAIL_W, true);
  let s = await state();
  ok(s.pref === 'collapsed', `the control saved "${s.pref}", want collapsed`);
  layoutOk('collapsed 1280', s, 'rail', 1280);
  ok(near(s.reader.w, 1280 - RAIL_W - 2 * SPLITTER - s.list.w), 'the reading pane did not get the freed width');
  ok((await evaluate(`document.querySelector('.fp-toggle').getAttribute('aria-expanded')`)) === 'false', 'the control says "expanded" while the menu is icons');
  await io.shot('collapsed');
  // it is kept: a restart, and a much wider / narrower window
  await open(`${base}&persist`, 1280, c.h);
  s = await state();
  ok(s.pref === 'collapsed', `after a restart the choice is "${s.pref}"`);
  layoutOk('restart collapsed', s, 'rail', 1280);
  await resize(1920, c.h);
  layoutOk('collapsed 1920', await state(), 'rail', 1920);
  // the setting of the menu is one global setting, in the stored preferences
  ok((await evaluate(`JSON.parse(localStorage.getItem('hl-mock-settings')).prefs`)).includes('"sidebar":"collapsed"'), 'the choice is not in the stored preferences');
  steady('open', await sample(() => io.click('.fp-toggle')), RAIL_W, OPEN_W, true);
  s = await state();
  ok(s.pref === 'expanded', `the control saved "${s.pref}", want expanded`);
  layoutOk('expanded 1920', s, 'open', 1920);
  await io.shot('open');
  await open(`${base}&persist`, 1280, c.h);
  s = await state();
  ok(s.pref === 'expanded', `after a restart the choice is "${s.pref}"`);
  layoutOk('restart expanded', s, 'open', 1280);
  // "expanded" in a window with no room: icons, and the panes keep their minimums; the control opens the menu over them and keeps it there
  await resize(1000, c.h);
  s = await state();
  layoutOk('expanded 1000', s, 'rail', 1000);
  ok(s.pref === 'expanded', 'a narrow window changed the choice "expanded"');
  await move(700, 400);
  await io.click('.fp-toggle');
  ok((await until(sideIs('peek'), 800)) >= 0, 'the control did not open the menu over the panes when there is no room');
  const pinned = await state();
  ok(pinned.pref === 'expanded' && near(pinned.surf.w, OPEN_W), 'the pinned menu has the wrong size or changed the choice');
  for (const k of ['list', 'reader']) ok(near(pinned[k].x, s[k].x, 0.5) && near(pinned[k].w, s[k].w, 0.5), `the pinned menu moved the ${k}`);
  await move(700, 400);
  await sleep(700);
  ok(await evaluate(sideIs('peek')), 'the pinned menu closed when the pointer left');
  await press('Escape');
  ok((await until(sideIs('rail'), 800)) >= 0, 'Escape did not close the pinned menu');
  await io.click('.fp-toggle');
  ok((await until(sideIs('peek'), 800)) >= 0, 'the control did not open the pinned menu a second time');
  await move(700, 500);
  await io.click('.msg-list');
  ok((await until(sideIs('rail'), 800)) >= 0, 'a click outside did not close the pinned menu');
  // Settings > Appearance: the three states and Reset to automatic
  await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'appearance' }); 1`);
  ok((await until(`!!document.querySelector('.settings-body select option[value="collapsed"]')`, 3000)) >= 0, 'Settings > Appearance has no side menu choice');
  const opts = await evaluate(`(() => { const sel = [...document.querySelectorAll('.settings-body select')].find((x) => x.querySelector('option[value="collapsed"]')); return { values: [...sel.options].map((o) => o.value), texts: [...sel.options].map((o) => o.textContent), value: sel.value, reset: !!sel.closest('.set-ctl').querySelector('button.link'), label: sel.getAttribute('aria-label') }; })()`);
  ok(opts.values.join() === 'auto,expanded,collapsed' && opts.value === 'expanded', `the side menu choice is ${JSON.stringify(opts)}`);
  ok(opts.texts.every((x) => x && !/^settings\./.test(x)), 'a choice of the side menu has no text');
  ok(opts.reset && !!opts.label, 'no Reset to automatic next to a manual choice (or no name on the choice)');
  await io.click('.settings-body .set-ctl button.link');
  await sleep(200);
  ok((await state()).pref === 'auto', 'Reset to automatic did not set automatic');
  ok(!(await evaluate(`!![...document.querySelectorAll('.settings-body .set-ctl')].find((c) => c.querySelector('select option[value="collapsed"]') && c.querySelector('button.link'))`)), 'Reset to automatic stays after it was used');
  await evaluate(`window.__store.getState().setDialog(null); 1`);
  await sleep(200);
  for (const [w, side] of [[1280, 'open'], [960, 'rail']]) { await resize(w, c.h); layoutOk(`reset ${w}`, await state(), side, w); }
  // reduced motion: the new layout is there at once
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await resize(1280, c.h);
  await sleep(100);
  const rm = await sample(() => io.click('.fp-toggle'));
  steady('fold (reduced motion)', rm, OPEN_W, RAIL_W, false);
  await cdp('Emulation.setEmulatedMedia', { features: [] });
  // ===== 7. the splitters keep the reading pane at its minimum; with the reading pane below there is room for the open menu at 960 =====
  await evaluate(`window.__store.getState().setPrefs({ sidebar: 'auto', folderW: 248, listW: 392 }); document.activeElement.blur(); 1`);
  await resize(1100, c.h);
  layoutOk('1100 again', await state(), 'open', 1100);
  await evaluate(`document.querySelectorAll('.splitter[role=separator]')[0].focus(); 1`);
  for (let i = 0; i < 6; i++) await press('ArrowRight');
  await sleep(300);
  s = await state();
  ok(s.side === 'open' && near(s.pane.w, 256, 0.5) && near(s.list.x, s.pane.w + SPLITTER), `the menu splitter stopped at ${s.pane.w}px (want 256: the reading pane keeps ${MIN_READER})`);
  ok(s.pane.w <= 256.5 && s.reader.w >= MIN_READER - 0.5, `the menu splitter squeezed the reading pane: menu ${s.pane.w}, reading pane ${s.reader.w}`);
  await evaluate(`document.querySelectorAll('.splitter[role=separator]')[1].focus(); 1`);
  for (let i = 0; i < 10; i++) await press('ArrowRight');
  await sleep(300);
  s = await state();
  ok(s.reader.w >= MIN_READER - 0.5 && s.side === 'open', `the list splitter squeezed the reading pane: list ${s.list.w}, reading pane ${s.reader.w}, menu "${s.side}"`);
  await evaluate(`window.__store.getState().setPrefs({ folderW: 248, listW: 392, readingPane: 'bottom', sidebar: 'expanded' }); document.activeElement.blur(); 1`);
  await resize(960, c.h);
  s = await state();
  ok(s.side === 'open' && near(s.pane.w, OPEN_W) && s.over <= 0, `reading pane below, expanded at 960: menu "${s.side}" ${s.pane.w}px`);
  ok(near(s.list.x, OPEN_W + SPLITTER) && near(s.list.r, 960), `reading pane below: the list is ${s.list.x}..${s.list.r}`);
  await evaluate(`window.__store.getState().setPrefs({ readingPane: 'right', sidebar: 'auto' }); 1`);
  await resize(1280, c.h);
  // the shortcut: Ctrl+B in the list folds / opens it, not in a field
  await evaluate(`window.__store.getState().setPrefs({ sidebar: 'auto' }); document.activeElement.blur(); 1`);
  await resize(1280, c.h);
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66, modifiers: 2 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66, modifiers: 2 });
  await sleep(450);
  ok((await state()).pref === 'collapsed', `Ctrl+B did not fold the menu (${(await state()).pref})`);
  await evaluate(`document.querySelector('#search-input').focus(); 1`);
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66, modifiers: 2 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66, modifiers: 2 });
  await sleep(300);
  ok((await state()).pref === 'collapsed', 'Ctrl+B in the search box changed the menu');
  const errs = await evaluate(`window.__errs`);
  ok(errs.length === 0, `errors in the page: ${errs.join(' | ')}`);
  console.log(`  ok ${tag}`);
}

const t0 = Date.now();
try { for (const c of CONFIGS) await runConfig(c); }
catch (e) { failures.push(`crashed${cfg ? ` [${cfg.lang} ${cfg.w}x${cfg.h} ${cfg.theme}]` : ''}: ${e.stack || e}`); }
finally { await H.shutdown(); }
const secs = ((Date.now() - t0) / 1000).toFixed(0);
if (failures.length) { console.error(`test-sidebar-collapse: FAILED (${CONFIGS.length} configurations, ${checks} checks, ${secs}s)\n\n  ` + [...new Set(failures)].join('\n  ')); process.exit(1); }
console.log(`test-sidebar-collapse: ok (${CONFIGS.map((c) => `${c.lang} ${c.w}x${c.h} ${c.theme}`).join(', ')}; ${checks} checks, ${secs}s)`);
