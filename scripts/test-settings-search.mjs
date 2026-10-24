#!/usr/bin/env node
// Search in Settings (1.0.7 W8.12) in the real page: the dev preview with real mouse and keyboard events (Chrome DevTools protocol).
//   (a) the walk of REQ-8.12.16: every page and section is opened and compared with the index the box searches (window.__settingsIndex, a dev seam): every rendered
//       row has a registered entry, every entry is rendered, the rendered label is the indexed one, the targets that are not a Row are there
//   (b) the jumps: the entry is the first result (or in the top group of the same label), Enter shows its page, the target is in the middle of the settings body, lit
//       (.set-hit) and holds the focus, and all of it within 300 ms (scaled by the machine); the results stay listed with the chosen one marked
//   (c) the keys: Ctrl+F / Cmd+F and / (AC-8.12.2), the Esc sequence (AC-8.12.7), an Enter of an input method (keyCode 229) does not jump, Escape never closes Settings with text
//   (d) ARIA: combobox / listbox / option, the live region 500 ms after the last change, "No settings found"
//   (e) stability: while typing, clearing, using the arrows, the dialog, its title bar, the box and everything in the settings body keep their rectangles
//   (f) the deep link `focus=loadRemote` is lit with reduced motion too, and a second request lights it again
//   (g) at 960x560 the placeholder, the empty state and a two-line label are not cut
//
//   node scripts/test-settings-search.mjs                   all 8 languages x Windows / macOS / Linux without a tray; every entry is jumped to in English on Windows
//   node scripts/test-settings-search.mjs --quick           en on Windows, ja on macOS, ru on Linux without a tray; 13 sample entries each (what CI runs)
//   node scripts/test-settings-search.mjs --lang=de --os=macos --shots=<dir>
//   node scripts/test-settings-search.mjs --lang=en --os=windows --ids=undoSend,pictures   only the jumps to those entries
//   node scripts/test-settings-search.mjs --url=http://127.0.0.1:1420/    use a dev server that is already running
//   node scripts/test-settings-search.mjs --require-browser   fail (instead of skipping) when no Chrome/Chromium/Edge is installed
import { fold } from '../src/settingsIndex.ts';
import { arg, flag, inputs, languageJs, sleep, startHarness } from './cdp-harness.mjs';
import { CALIBRATE } from './lib/reply-open-probe.mjs';

const QUICK = flag('quick');
const ALL = ['en', 'vi', 'fr', 'zh-Hans', 'es', 'ja', 'de', 'ru'];
const SYSTEMS = { windows: { os: 'windows' }, macos: { os: 'macos' }, linux: { os: 'linux', notray: true } };
const COMBOS = [];
if (QUICK) COMBOS.push({ lang: 'en', ...SYSTEMS.windows }, { lang: 'ja', ...SYSTEMS.macos }, { lang: 'ru', ...SYSTEMS.linux });
else for (const lang of (arg('lang') || ALL.join(',')).split(',')) for (const os of (arg('os') || 'windows,macos,linux').split(',')) COMBOS.push({ lang, ...SYSTEMS[os] });
const SHOTS = arg('shots');

const H = await startHarness('test-settings-search', { vitePort0: 5090, cdpPort0: 9090 });
const { evaluate, cdp } = H;
const { typeText, press, click, shot } = inputs(H, SHOTS, 'settings-search');
const failures = [];
let checks = 0;
let tag = '';
const fail = (msg) => failures.push(`[${tag}] ${msg}`);
const check = (cond, msg) => { checks++; if (!cond) fail(msg); return !!cond; };

// ---- timing: the jump is finished within 300 ms on a release build; this runs the dev preview on whatever machine, so the budget is scaled by a calibration of the page
const CPU_REF = 48; // ms of CALIBRATE's `cpu` on the development machine (Windows, 1x)
const HARD_CAP_MS = 1500;
let scale = 1;
const budget = (base) => Math.min(Math.round(base * scale), HARD_CAP_MS);
const waitFor = async (js, ms = 8000) => { ms *= Math.max(1, scale); const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between two renders */ } await sleep(30); } return false; };

const hashFor = (c) => `lang=${c.lang}&os=${c.os}${c.notray ? '&notray' : ''}`;
const BOX = '.settings-nav .set-search input';
const ctrlF = (c) => cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: c.os === 'macos' ? 4 : 2 }).then(() => cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', modifiers: c.os === 'macos' ? 4 : 2 }));
const paste = (text) => cdp('Input.insertText', { text });
const settingsOpen = (tab = 'general', extra = '') => evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: ${JSON.stringify(tab)}, nonce: Date.now() ${extra} }); 1`);
const boxState = () => evaluate(`(() => {
  const b = document.querySelector(${JSON.stringify(BOX)});
  if (!b) return null;
  return {
    value: b.value, focused: document.activeElement === b, expanded: b.getAttribute('aria-expanded'), ad: b.getAttribute('aria-activedescendant'), controls: b.getAttribute('aria-controls'),
    sel: [b.selectionStart, b.selectionEnd], role: b.getAttribute('role'), auto: b.getAttribute('aria-autocomplete'), type: b.type, label: b.getAttribute('aria-label'), placeholder: b.placeholder, title: b.title,
    keys: b.getAttribute('aria-keyshortcuts'), max: b.maxLength, spell: b.spellcheck, live: document.querySelector('.set-search [role=status]')?.textContent ?? null,
    opts: [...document.querySelectorAll('.set-opt')].map((o) => ({ id: o.id, label: o.querySelector('.set-opt-label').textContent, place: o.querySelector('.set-opt-place')?.textContent ?? '', name: o.getAttribute('aria-label'), sel: o.getAttribute('aria-selected'), role: o.getAttribute('role'), title: o.title })),
    list: (() => { const l = document.querySelector('.set-results'); return l ? { id: l.id, role: l.getAttribute('role'), label: l.getAttribute('aria-label') } : null; })(),
    none: document.querySelector('.set-none')?.textContent ?? null, navShown: !!document.querySelector('.settings-nav button.active'), modal: !!document.querySelector('.modal'),
    tab: document.querySelector('.settings-nav button.active')?.textContent.trim() ?? null,
  };
})()`);
const index = () => evaluate(`window.__settingsIndex`);

async function open(c) {
  await H.openApp(hashFor(c), c.w ?? 1280, c.h ?? 800);
  if (c.lang !== 'en') await evaluate(languageJs(c.lang));
  await settingsOpen('general');
  check(await waitFor(`!!document.querySelector(${JSON.stringify(BOX)}) && !!document.getElementById('set-pg-general') && !!window.__settingsIndex`), 'Settings did not open with the search box');
  check(!(await boxState()).focused, 'the box has the focus when Settings opens (REQ-8.12.1: it must not)');
}

/** Shows the page (and the section) of an entry the way a person does: the tab through the store, a section by its button. */
async function showPage(entries, tab, section) {
  await settingsOpen(tab);
  const head = tab.startsWith('mb:') ? 'pg-mb' : `pg-${tab}`;
  if (!await waitFor(`!!document.getElementById('set-${head}')`)) return false;
  if (section) {
    // (a mailbox has a section page for Profile, Calendar and Server only: the others are named by the place of their rows)
    const label = entries.find((e) => e.tab === tab && e.section === section && e.id === 'sec')?.label ?? entries.find((e) => e.tab === tab && e.section === section)?.places.slice(-1)[0];
    if (!label) return false;
    await evaluate(`[...document.querySelectorAll('.nav-sub button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})?.click(); 1`);
    return waitFor(`document.getElementById('set-sec')?.getAttribute('aria-label') === ${JSON.stringify(label)}`);
  }
  return true;
}

// ---------------------------------------------------------------------------------------------- (a) the walk
async function walk(c) {
  const entries = await index();
  const keys = [...new Set(entries.map((e) => `${e.tab}|${e.section ?? ''}`))];
  let pages = 0;
  for (const key of keys) {
    const [tab, section] = key.split('|');
    const here = entries.filter((e) => e.tab === tab && (e.section ?? '') === section);
    if (!await showPage(entries, tab, section || null)) { fail(`${key}: the page did not open`); continue; }
    pages++;
    await sleep(60);
    const dom = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('.settings-body .set-row')].map((r) => ({ id: r.id.replace(/^set-/, ''), skip: r.hasAttribute('data-search-skip'), label: (r.querySelector('.set-lbl > div') || r).textContent.trim() }));
      const nav = [...document.querySelectorAll('.settings-nav button')].map((b) => b.textContent.trim());
      const sub = [...document.querySelectorAll('.nav-sub button')].map((b) => b.textContent.trim());
      const text = (sel) => { const e = document.querySelector(sel); return e ? e.textContent.trim() : null; };
      return {
        rows, nav, sub, ids: Object.fromEntries(${JSON.stringify(here.map((e) => e.id))}.map((id) => [id, !!document.getElementById('set-' + id)])),
        group: Object.fromEntries(${JSON.stringify(here.filter((e) => e.kind === 'group').map((e) => e.id))}.map((id) => {
          const el = document.getElementById('set-' + id);
          if (!el) return [id, null];
          const h4 = el.querySelector('h4');
          if (el.tagName === 'BUTTON') return [id, el.textContent.trim()];
          if (el.tagName === 'INPUT' || el.tagName === 'SELECT') return [id, el.closest('.set-card-head')?.querySelector('h4')?.textContent.trim() || el.getAttribute('aria-label') || ''];
          return [id, h4 ? h4.textContent.trim() : el.textContent.trim()];
        })),
        region: document.getElementById('set-sec')?.getAttribute('aria-label') ?? null,
        h3: text('.settings-body h3'),
      };
    })()`);
    // (a setting that a mailbox can override has the same id as its All accounts row, which covers it: D-12.6)
    const covered = new Set(tab.startsWith('mb:') && tab !== 'mb:all' ? entries.filter((e) => e.tab === 'mb:all' && e.kind === 'row').map((e) => e.id) : []);
    const rowEntries = here.filter((e) => e.kind === 'row');
    // (the page of a mailbox with no section named shows one of its sections: its rows are compared under that section)
    const shownRows = (tab.startsWith('mb:') && !section ? [] : dom.rows).filter((r) => !r.skip && !covered.has(r.id));
    for (const r of shownRows) {
      const e = rowEntries.find((x) => x.id === r.id);
      if (!check(!!e, `${key}: the row "${r.label}" (${r.id || 'no id'}) is on the page but not in the index`)) continue;
      check(fold(r.label) === fold(e.label), `${key}: ${r.id}: the page says "${r.label}", the index "${e.label}"`);
    }
    for (const e of rowEntries) check(dom.rows.some((r) => r.id === e.id && !r.skip), `${key}: the index has ${e.id} ("${e.label}") but the page does not show it`);
    if (!(tab.startsWith('mb:') && !section)) check(shownRows.length === rowEntries.length, `${key}: ${shownRows.length} rows on the page, ${rowEntries.length} in the index`);
    for (const e of here) {
      check(dom.ids[e.id], `${key}: the target set-${e.id} is not on the page`);
      if (e.kind === 'group' && dom.group[e.id] !== null) check(fold(dom.group[e.id]).startsWith(fold(e.label)), `${key}: ${e.id}: the page says "${dom.group[e.id]}", the index "${e.label}"`);
      if (e.id === 'sec') check(fold(dom.region) === fold(e.label), `${key}: the section is "${dom.region}", the index "${e.label}"`);
      if (e.kind === 'page' && e.id !== 'sec') {
        const names = dom.nav.map(fold);
        check(names.some((n) => n.includes(fold(e.label))) || dom.h3 !== null && fold(dom.h3) === fold(e.label), `${key}: the page entry "${e.label}" is not in the navigation (${dom.nav.slice(0, 6)}...)`);
      }
    }
  }
  check(pages >= 20, `the walk visited ${pages} pages`);
  // every entry is the first result for its own label, in the page's own module (the same ranking the box uses)
  const bad = await evaluate(`import('/src/settingsIndex.ts').then((m) => { const idx = window.__settingsIndex, out = []; for (const e of idx) { const hits = m.searchSettings(idx, e.label, 200); const top = hits.filter((h) => h.tier === 1); if (!top.some((h) => h.entry.tab === e.tab && h.entry.id === e.id && h.entry.section === e.section)) out.push(e.label + ' (' + e.id + ')'); } return out; })`);
  check(bad.length === 0, `these entries are not in the top group for their own label: ${bad.slice(0, 5)}`);
}

// ---------------------------------------------------------------------------------------------- (b) the jumps
const INSTALL_HIT = `(() => {
  window.__hit = { t: null, enter: null, id: null };
  if (window.__hitObs) window.__hitObs.disconnect();
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter') window.__hit.enter = performance.now(); }, { capture: true, once: true });
  window.__hitObs = new MutationObserver((ms) => { for (const m of ms) if (m.target.classList && m.target.classList.contains('set-hit') && window.__hit.t === null) { window.__hit.t = performance.now(); window.__hit.id = m.target.id; } });
  window.__hitObs.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
  return 1;
})()`;

/** Types the label of `e`, goes to its option with the arrows, presses Enter, and checks what the jump did. */
async function jump(c, entries, e) {
  const label = `${e.label} (${e.id}${e.section ? ` ${e.section}` : ''}${e.tab.startsWith('mb:') ? ` ${e.tab}` : ''})`;
  // a page that is not the target's, so that the jump has to switch it
  const away = e.tab === 'about' ? 'general' : 'about';
  await settingsOpen(away);
  if (!await waitFor(`!!document.getElementById('set-pg-${away}')`)) return fail(`${label}: the other page did not open`);
  await ctrlF(c);
  await paste(e.label);
  const name = await evaluate(`import('/src/settingsIndex.ts').then((m) => m.optionName(${JSON.stringify(e)}))`);
  if (!await waitFor(`[...document.querySelectorAll('.set-opt')].some((o) => o.getAttribute('aria-label') === ${JSON.stringify(name)})`, 3000)) return fail(`${label}: no option "${name}" for its own label`);
  const st = await boxState();
  const at = st.opts.findIndex((o) => o.name === name);
  check(at >= 0 && st.opts.slice(0, at + 1).every((o) => fold(o.label) === fold(e.label)), `${label}: the option is ${at + 1}. and not in the top group of the same label (${st.opts.slice(0, 3).map((o) => o.label)})`);
  check(st.opts[at].place === e.line, `${label}: the place line is "${st.opts[at].place}", expected "${e.line}"`);
  check(st.opts[at].title === `${e.label}${e.line ? ` — ${e.line}` : ''}`, `${label}: the tooltip of the option is "${st.opts[at].title}"`);
  for (let i = 0; i <= at; i++) await press('ArrowDown', 'ArrowDown');
  check((await boxState()).opts[at].sel === 'true', `${label}: the option the arrows are on is not marked`);
  await evaluate(INSTALL_HIT);
  await press('Enter', 'Enter');
  if (!await waitFor(`window.__hit.t !== null`, 3000)) return fail(`${label}: nothing was lit up after Enter`);
  const ms = await evaluate(`window.__hit.t - window.__hit.enter`);
  check(ms <= budget(300), `${label}: the jump took ${Math.round(ms)} ms, the budget is ${budget(300)} ms (300 ms x scale ${scale.toFixed(2)})`);
  // (a page that was still drawing when it was centred - a list that is read - is centred again at its next frame: look after that)
  await evaluate(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 80))))`);
  const r = await evaluate(`(() => {
    const el = document.getElementById('set-${e.id}'), body = document.querySelector('.settings-body');
    if (!el) return null;
    const r = el.getBoundingClientRect(), b = body.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      hit: el.classList.contains('set-hit'), inBody: body.contains(el), focusIn: el.contains(document.activeElement), tall: r.height >= body.clientHeight,
      dy: Math.abs(r.top + r.height / 2 - (b.top + body.clientHeight / 2)), visible: r.top >= b.top - 1 && r.bottom <= b.bottom + 1 || r.height >= body.clientHeight && r.top <= b.top + 12 && r.bottom > b.top,
      atEdge: body.scrollTop <= 1 || body.scrollTop + body.clientHeight >= body.scrollHeight - 1, outline: cs.outlineStyle + ' ' + cs.outlineWidth, active: document.activeElement.tagName + '#' + document.activeElement.id,
      listed: document.querySelectorAll('.set-opt').length, sel: document.querySelectorAll('.set-opt[aria-selected=true]').length, query: document.querySelector(${JSON.stringify(BOX)}).value,
      tabindex: el.getAttribute('tabindex'), top: Math.round(r.top), bottom: Math.round(r.bottom), bodyTop: Math.round(b.top), bodyBottom: Math.round(b.bottom), scrollTop: body.scrollTop, scrollHeight: body.scrollHeight,
    };
  })()`);
  if (!check(!!r, `${label}: the target set-${e.id} is not on the page after the jump`)) return;
  check(r.hit, `${label}: the target is not lit`);
  check(r.inBody, `${label}: the target is not in the settings body`);
  check(r.focusIn, `${label}: the focus is not in the target (it is on ${r.active})`);
  check(r.visible && (r.dy <= 24 || r.atEdge || r.tall), `${label}: the target is not in the middle of the page (off by ${Math.round(r.dy)} px, scrolled to an edge: ${r.atEdge}; ${JSON.stringify(r)})`);
  check(r.outline.startsWith('solid') && !r.outline.endsWith(' 0px'), `${label}: the lit target has no outline (${r.outline})`);
  check(r.listed > 0 && r.sel === 1 && r.query === e.label, `${label}: the results must stay listed with the chosen one marked (${r.listed} options, ${r.sel} marked, text "${r.query}")`);
  if (e.inDetails) check(await evaluate(`document.getElementById('set-${e.id}').closest('details').open`), `${label}: the closed Advanced is open after the jump (AC-8.12.10)`);
  if (e.kind === 'page') check(r.tabindex === '-1', `${label}: a heading takes the focus with tabindex -1`);
  return r;
}

async function jumps(c) {
  const entries = await index();
  const some = [
    entries.find((e) => e.id === 'undoSend'), entries.find((e) => e.id === 'aiBaseUrl'), entries.find((e) => e.id === 'pg-ai'), entries.find((e) => e.id === 'theme'),
    entries.filter((e) => e.id === 'replyTo')[1], entries.find((e) => e.id === 'keepRunning'), entries.find((e) => e.id === 'pgpImport'), entries.find((e) => e.id === 'updateCheck'),
    entries.find((e) => e.id === 'calendar' && e.tab === 'mb:a2'), entries.find((e) => e.id === 'loadRemote'), entries.find((e) => e.id === 'sec' && e.section === 'server'),
    entries.find((e) => e.id === 'taskbarBadge') ?? entries.find((e) => e.id === 'autostart'), entries.find((e) => e.id === 'act-flag'), entries.find((e) => e.id === 'aiModelsUrl'),
  ].filter(Boolean);
  check(some.length >= 13, `${some.length} sample entries`);
  const only = arg('ids') ? arg('ids').split(',') : null; // (--ids=undoSend,pictures: only those entries, for a look at one jump)
  const list = only ? entries.filter((e) => only.includes(e.id)) : !QUICK && c.lang === 'en' && c.os === 'windows' ? entries : some;
  for (const e of list) await jump(c, entries, e);
  return list.length;
}

// ---------------------------------------------------------------------------------------------- (c) the keys, (d) ARIA
async function keys(c) {
  const entries = await index();
  // AC-8.12.2: Ctrl+F from a switch; the text is selected
  await settingsOpen('general');
  await waitFor(`!!document.getElementById('set-askWhere')`);
  await evaluate(`document.querySelector('#set-askWhere input').focus(); 1`);
  await ctrlF(c);
  check((await boxState()).focused, 'Ctrl+F (Cmd+F on a Mac) from a switch did not focus the box');
  check((await evaluate(`document.activeElement.type`)) === 'text', 'the box is type="text" (no native cancel button)');
  await paste('x');
  await settingsOpen('ai');
  await waitFor(`!!document.getElementById('set-aiBaseUrl')`);
  await evaluate(`document.getElementById('set-aiBaseUrl').focus(); 1`);
  await ctrlF(c);
  let st = await boxState();
  check(st.focused && st.value === 'x' && st.sel[0] === 0 && st.sel[1] === 1, `Ctrl+F from the Base URL: the box has the focus with "x" selected (${JSON.stringify([st.focused, st.value, st.sel])})`);
  // in the field itself: / is a letter
  await evaluate(`document.getElementById('set-aiBaseUrl').focus(); 1`);
  await typeText('/v1', 20);
  const v = await evaluate(`({ v: document.getElementById('set-aiBaseUrl').value, f: document.activeElement.id })`);
  check(v.v.endsWith('/v1') && v.f === 'set-aiBaseUrl', `/ in the Base URL field is typed there (value "${v.v}", focus ${v.f})`);
  // / on a button
  await evaluate(`document.querySelector('.settings-nav .set-search input').blur(); document.querySelector('.settings-body button, .settings-body .btn')?.focus(); 1`);
  await press('/', 'Slash');
  check((await boxState()).focused, '/ with the focus on a button did not focus the box');
  // Ctrl+F in the Command bar: nothing happens in Settings
  await evaluate(`document.getElementById('set-aiBaseUrl').focus(); window.__store.getState().setCommandOpen(true); 1`);
  await sleep(120);
  const before = await evaluate(`document.activeElement.tagName + '#' + document.activeElement.id + '.' + document.activeElement.className`);
  await ctrlF(c);
  check(!(await boxState()).focused, 'Ctrl+F with the Command bar open went to the Settings box');
  void before;
  await evaluate(`window.__store.getState().setCommandOpen(false); 1`);
  await sleep(60);

  // an Enter of an input method does not jump
  await settingsOpen('about');
  await waitFor(`!!document.getElementById('set-pg-about')`);
  await ctrlF(c);
  await paste('sound');
  await waitFor(`document.querySelectorAll('.set-opt').length > 1`);
  await evaluate(INSTALL_HIT);
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229 });
  await sleep(250);
  check((await evaluate(`window.__hit.t === null && !!document.getElementById('set-pg-about') && !document.querySelector('.set-hit')`)), 'an Enter of an input method (keyCode 229) jumped');

  // AC-8.12.7: arrows, Enter, Ctrl+F, Esc, Esc, Esc
  await evaluate(`document.querySelector(${JSON.stringify(BOX)}).blur(); document.querySelector('.settings-nav .set-opt')?.focus?.(); 1`);
  await ctrlF(c);
  check((await boxState()).value === 'sound', 'the text is still there');
  await press('ArrowDown', 'ArrowDown');
  const a1 = (await boxState()).ad;
  await press('ArrowDown', 'ArrowDown');
  const a2 = (await boxState()).ad;
  await press('ArrowUp', 'ArrowUp');
  const a3 = (await boxState()).ad;
  const optId = (n) => `${(a1 ?? '').replace(/-o\d+$/, '')}-o${n}`;
  check(a1 === optId(0) && a2 === optId(1) && a3 === optId(0), `the active option moves 0, 1, 0 (${a1}, ${a2}, ${a3})`);
  await evaluate(INSTALL_HIT);
  await press('Enter', 'Enter');
  check(await waitFor(`window.__hit.t !== null`, 3000), 'Enter on the active option did not jump');
  const jumped = await evaluate(`document.activeElement.id + '|' + document.activeElement.className + '|' + (document.activeElement.closest('[id^=set-]')?.id ?? '')`);
  await evaluate(`window.__before = document.activeElement; 1`);
  await ctrlF(c);
  check((await boxState()).focused, 'Ctrl+F after the jump did not return to the box');
  await press('Escape', 'Escape');
  st = await boxState();
  check(st.value === '' && st.navShown && st.focused && st.modal, `Esc with text clears it, shows the navigation and keeps the focus in the box (${JSON.stringify([st.value, st.navShown, st.focused, st.modal])})`);
  await press('Escape', 'Escape');
  st = await boxState();
  check(st.modal && !st.focused && await evaluate(`document.activeElement === window.__before`), `Esc with an empty box gives the focus back (modal ${st.modal}, box ${st.focused}, back ${await evaluate('document.activeElement === window.__before')}; the jump left it on ${jumped})`);
  await press('Escape', 'Escape');
  check(await waitFor(`!document.querySelector('.modal')`, 3000), 'the third Esc did not close Settings');

  // (d) ARIA, the live region, and no result
  await settingsOpen('general');
  await waitFor(`!!document.getElementById('set-pg-general')`);
  await ctrlF(c);
  st = await boxState();
  check(st.role === 'combobox' && st.auto === 'list' && st.expanded === 'false' && st.type === 'text' && st.max === 100 && st.spell === false, `the box: role, autocomplete, expanded, type, maxlength (${JSON.stringify([st.role, st.auto, st.expanded, st.type, st.max, st.spell])})`);
  check(st.keys === (c.os === 'macos' ? 'Meta+F /' : 'Control+F /'), `aria-keyshortcuts: ${st.keys}`);
  check(st.title.includes(c.os === 'macos' ? 'Cmd+F' : 'Ctrl+F'), `the tooltip names the key: ${st.title}`);
  check(st.label === st.placeholder && st.label.length > 3, `label and placeholder: "${st.label}" / "${st.placeholder}"`);
  await paste('theme');
  await waitFor(`document.querySelectorAll('.set-opt').length > 0`);
  st = await boxState();
  check(st.expanded === 'true' && st.list && st.list.role === 'listbox' && st.controls === st.list.id && st.opts.length > 0 && st.opts.every((o) => o.role === 'option' && (o.sel === 'true' || o.sel === 'false')), `the listbox: expanded, controls, options (${JSON.stringify([st.expanded, st.controls, st.list])})`);
  check(st.list?.label && st.list.label.length > 2, 'the listbox has a name');
  check(st.live === '', `the live region is silent while typing: "${st.live}"`);
  await sleep(380);
  check((await boxState()).live === '', 'and 380 ms after the last change');
  await sleep(450);
  const count = (await boxState()).live;
  check(/\d/.test(count) && count.length > 3, `the live region says the count 500 ms after the last change: "${count}"`);
  const n = (await boxState()).opts.length;
  check(count.includes(String(n)), `and the count is ${n}: "${count}"`);
  // no result
  await ctrlF(c);
  await paste('qqqzz');
  await waitFor(`!!document.querySelector('.set-none')`);
  st = await boxState();
  check(st.none && st.expanded === 'false' && st.opts.length === 0, `no result: the empty state shows (${st.none})`);
  const pageBefore = await evaluate(`document.querySelector('.settings-body h3')?.textContent`);
  await press('Enter', 'Enter');
  await sleep(150);
  check((await evaluate(`document.querySelector('.settings-body h3')?.textContent`)) === pageBefore && !(await evaluate(`!!document.querySelector('.set-hit')`)), 'Enter with no result did nothing');
  await sleep(500);
  const none = (await boxState()).live;
  check(none.length > 3 && none === (await boxState()).none.split(/(?<=\S)(?=[A-ZÀ-ÖА-Я])/)[0].trim() || none.length > 3, `the live region says "No settings found": "${none}"`);
  // case, accents, spaces
  if (c.lang === 'en') {
    for (const q of ['UNDO SÉND', 'undo  send', 'ndo sen']) {
      await ctrlF(c);
      await paste(q);
      await sleep(60);
      check((await boxState()).opts.some((o) => o.label === 'Undo send'), `"${q}" finds Undo send`);
    }
    await ctrlF(c);
    await paste('ai');
    await sleep(60);
    st = await boxState();
    check(st.opts[0]?.label === 'AI Assistant', `ai: AI Assistant first (${st.opts[0]?.label})`);
    // a language switch recomputes the list at once (AC-8.12.15)
    await ctrlF(c);
    await paste('language');
    await sleep(60);
    await evaluate(`(() => { const l = document.querySelector('.set-opt'); l.click(); return 1; })()`);
    await waitFor(`!!document.querySelector('#set-language select')`);
    await evaluate(languageJs('de'));
    await sleep(150);
    st = await boxState();
    // the English text may find nothing in German; whatever is listed is German, none of it is English
    check(st.opts.every((o) => !/^(Language|Reading pane)$/.test(o.label)), `no stale English label remains (${st.opts.map((o) => o.label)})`);
    await ctrlF(c);
    await paste('Sprache');
    await sleep(80);
    st = await boxState();
    check(st.opts.length > 0 && /Sprache/.test(st.opts[0].label), `after the switch to German the list is German: ${st.opts[0]?.label}`);
    await evaluate(languageJs('en'));
  }
  // fix51: German and Russian write KI-Assistent / ИИ-помощник; AI, the full-width ＡＩ and the local term all find the AI Assistant page
  if (c.lang === 'de' || c.lang === 'ru') {
    const aiLabel = await evaluate(`window.__settingsIndex.find((e) => e.id === 'pg-ai')?.label`);
    for (const q of ['AI', 'ＡＩ', c.lang === 'de' ? 'KI' : 'ИИ']) {
      await ctrlF(c);
      await paste(q);
      await sleep(60);
      st = await boxState();
      check(!!aiLabel && st.opts[0]?.label === aiLabel, `${c.lang}: "${q}" finds ${aiLabel} first (${st.opts[0]?.label})`);
    }
  }
  // Escape never closes Settings while the box holds text, and the clear button empties it
  await settingsOpen('general');
  await ctrlF(c);
  await paste('theme');
  await press('Escape', 'Escape');
  check(await evaluate(`!!document.querySelector('.modal')`), 'Esc with text closed Settings');
  await paste('theme');
  await click('.settings-nav .set-clear');
  st = await boxState();
  check(st.value === '' && st.focused, 'the clear button empties the box and keeps the focus there');
  void entries;
}

// ---------------------------------------------------------------------------------------------- (e) stability
const SAMPLER = `(() => {
  window.__st = { run: true, frames: [] };
  const R = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 10) / 10); };
  const tick = () => {
    if (!window.__st.run) return;
    const body = document.querySelector('.settings-body');
    if (body) window.__st.frames.push({ modal: R(document.querySelector('.modal')), head: R(document.querySelector('.modal-head')), box: R(document.querySelector('.set-search')), input: R(document.querySelector('.set-search input')), body: R(body), scroll: body.scrollTop, kids: [...body.querySelectorAll(':scope > div > *')].slice(0, 60).map(R) });
    requestAnimationFrame(tick);
  };
  tick();
  return 1;
})()`;
async function stability(c) {
  await settingsOpen('general');
  await waitFor(`!!document.getElementById('set-pg-general')`);
  await sleep(300);
  await evaluate(SAMPLER);
  await ctrlF(c);
  await typeText('sound when', 40);
  await press('ArrowDown', 'ArrowDown'); await press('ArrowDown', 'ArrowDown'); await press('ArrowUp', 'ArrowUp');
  await press('Escape', 'Escape');
  await typeText('qqq', 40);
  await press('Escape', 'Escape');
  await typeText('undo', 40);
  await click('.settings-nav .set-clear');
  await sleep(200);
  const frames = await evaluate(`(window.__st.run = false, window.__st.frames)`);
  check(frames.length > 20, `${frames.length} frames sampled`);
  const first = frames[0];
  const same = (a, b) => (Array.isArray(a) ? a.length === b.length && a.every((x, i) => same(x, b[i])) : a === null || b === null ? a === b : Math.abs(a - b) <= 0.5);
  let moved = null;
  for (const f of frames) for (const k of Object.keys(first)) if (!moved && !same(first[k], f[k])) moved = `${k}: ${JSON.stringify(first[k])} -> ${JSON.stringify(f[k])}`;
  check(!moved, `something moved while typing, clearing and using the arrows: ${moved}`);
}

// ---------------------------------------------------------------------------------------------- (f) the deep link with reduced motion
async function deepLink(c) {
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await evaluate(`window.__store.getState().setDialog(null); 1`);
  await settingsOpen('mb:all', `, focus: 'loadRemote'`);
  check(await waitFor(`!!document.getElementById('set-loadRemote')?.classList.contains('set-hit')`, 4000), 'the deep link focus=loadRemote did not light the row with reduced motion');
  const r = await evaluate(`(() => { const el = document.getElementById('set-loadRemote'); const cs = getComputedStyle(el); return { anim: cs.animationName, outline: cs.outlineStyle, bar: cs.boxShadow !== 'none', focus: el.contains(document.activeElement) }; })()`);
  check(r.anim === 'none' && r.outline === 'solid' && r.bar, `reduced motion: the highlight is static (animation ${r.anim}, outline ${r.outline}, bar ${r.bar})`);
  check(r.focus, 'the deep link moves the focus into the row');
  // the same request again lights it again
  await evaluate(`document.getElementById('set-loadRemote').classList.remove('set-hit'); 1`);
  await settingsOpen('mb:all', `, focus: 'loadRemote'`);
  check(await waitFor(`!!document.getElementById('set-loadRemote')?.classList.contains('set-hit')`, 4000), 'a second request for the same row did not light it again');
  // it goes after about 2.4 s
  const t0 = Date.now();
  check(await waitFor(`!document.getElementById('set-loadRemote')?.classList.contains('set-hit')`, 4500), 'the highlight stayed');
  const gone = Date.now() - t0;
  check(gone >= 1200 && gone <= 3600 * Math.max(1, scale), `the highlight went after ${gone + 80} ms more (about 2.4 s in all)`);
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  // and with motion: the animation runs
  await settingsOpen('mb:all', `, focus: 'maxDownload', section: undefined`);
  check(await waitFor(`!!document.getElementById('set-maxDownload')?.classList.contains('set-hit')`, 4000), 'the deep link focus=maxDownload did not light the row');
  const m = await evaluate(`getComputedStyle(document.getElementById('set-maxDownload')).animationName`);
  check(m === 'set-hit-fade', `with motion the highlight fades out (${m})`);
  void c;
}

// ---------------------------------------------------------------------------------------------- (g) a small window
async function small(c) {
  await H.openApp(hashFor(c), 960, 560);
  if (c.lang !== 'en') await evaluate(languageJs(c.lang));
  await settingsOpen('general');
  await waitFor(`!!document.querySelector(${JSON.stringify(BOX)}) && !!window.__settingsIndex`);
  const m = await evaluate(`(() => {
    const b = document.querySelector(${JSON.stringify(BOX)}), cs = getComputedStyle(b);
    const cv = document.createElement('canvas').getContext('2d'); const ph = getComputedStyle(b, '::placeholder'); cv.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + ph.fontSize + ' ' + cs.fontFamily; // (the placeholder has its own size)
    const room = b.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const modal = document.querySelector('.modal').getBoundingClientRect(), nav = document.querySelector('.settings-nav').getBoundingClientRect();
    return { text: cv.measureText(b.placeholder).width, room, fits: modal.bottom <= innerHeight + 1 && modal.right <= innerWidth + 1, navScrollW: document.querySelector('.settings-nav').scrollWidth, navW: nav.width };
  })()`);
  check(m.text <= m.room - 8, `the placeholder is cut or nearly: it needs ${Math.round(m.text)} px and the box has ${Math.round(m.room)} px (8 px to spare are wanted: another font may be wider)`);
  check(m.fits, 'the dialog does not fit the window');
  await ctrlF(c);
  await paste('qqqzz');
  await waitFor(`!!document.querySelector('.set-none')`);
  const e = await evaluate(`(() => { const n = document.querySelector('.set-none'), nav = document.querySelector('.settings-nav'); const r = n.getBoundingClientRect(), b = nav.getBoundingClientRect(); return { fits: r.right <= b.right + 0.5 && n.scrollWidth <= n.clientWidth + 1, h: n.scrollHeight - n.clientHeight }; })()`);
  check(e.fits && e.h <= 1, `the empty state is cut (${JSON.stringify(e)})`);
  await ctrlF(c);
  await paste('a');
  await sleep(80);
  const o = await evaluate(`(() => [...document.querySelectorAll('.set-opt')].slice(0, 50).map((x) => { const l = x.querySelector('.set-opt-label'), p = x.querySelector('.set-opt-place'); return { label: l.scrollHeight - l.clientHeight, lines: Math.round(l.clientHeight / parseFloat(getComputedStyle(l).lineHeight || 18)), place: p ? p.scrollWidth - p.clientWidth : 0, w: x.scrollWidth - x.clientWidth }; }))()`);
  check(o.every((x) => x.w <= 1), 'a result is wider than the column');
  check(o.every((x) => x.lines <= 2), 'a label has more than two lines');
  await shot('small');
}

// ---------------------------------------------------------------------------------------------- run
try {
  // (the first request of a language chunk can make a cold dev server optimise a dependency and reload the page once: that happens here, not in the middle of a check)
  for (let i = 0; i < 3; i++) {
    await H.openApp('lang=en', 1280, 800);
    try { await evaluate(`Promise.all(['de', 'ja', 'ru', 'vi', 'fr', 'es', 'zh-Hans'].map((l) => import('/src/i18n/lang-' + l + '.ts'))).then(() => 1)`); await sleep(1500); break; } catch { await sleep(1500); }
  }
  await H.openApp('lang=en', 1280, 800);
  const cal = await evaluate(CALIBRATE);
  scale = Math.min(Math.max(1, cal.cpu / CPU_REF), 8);
  console.log(`test-settings-search: the page runs the reference work in ${cal.cpu} ms (reference ${CPU_REF}): scale ${scale.toFixed(2)}, jump budget ${budget(300)} ms`);
  let n = 0;
  for (const c of COMBOS) {
    tag = `${c.lang} ${c.os}${c.notray ? ' no tray' : ''}`;
    await open(c);
    await walk(c);
    n += await jumps(c);
    if (c === COMBOS[0]) {
      await keys(c);
      await stability(c);
      await deepLink(c);
    } else if (c.os === 'macos') {
      // Cmd+F, not Ctrl+F, on a Mac
      await settingsOpen('general');
      await waitFor(`!!document.getElementById('set-askWhere')`);
      await evaluate(`document.querySelector('#set-askWhere input').focus(); 1`);
      await ctrlF(c);
      check((await boxState()).focused, 'Cmd+F did not focus the box on macOS');
      await evaluate(`document.querySelector('#set-askWhere input').focus(); 1`);
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 2 });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', modifiers: 2 });
      check(!(await boxState()).focused, 'Ctrl+F is not the key on macOS');
    }
    if (c.lang !== 'en' || c.os !== 'windows' || !QUICK) await small({ ...c });
    await shot(`${c.lang}-${c.os}`);
  }
  if (QUICK || COMBOS.length < 24) {
    // 960x560 in German, the longest placeholder (AC-8.12.1)
    tag = 'de windows 960x560';
    await small({ lang: 'de', ...SYSTEMS.windows });
  }
  console.log(`test-settings-search: ${checks} checks, ${n} jumps, ${COMBOS.length} combinations`);
} catch (e) {
  failures.push(`[${tag}] ${e.stack || e}`);
} finally {
  await H.shutdown();
}
if (failures.length) {
  console.error(`test-settings-search: FAILED (${failures.length})\n  ` + failures.slice(0, 40).join('\n  '));
  process.exit(1);
}
console.log('test-settings-search: ok');
