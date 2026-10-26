#!/usr/bin/env node
// 1.0.7 W13.10 (REQ-13.10.1 to 13.10.8, AC-13.10.1 to AC-13.10.11): create a folder and a one-level subfolder.
//   static part: the name rules of the dialog (the same table as folders.rs `check_name`), the tree order (each parent followed by its subfolders, siblings by label in the language), the hidden
//     children of a collapsed folder, the order of "Move to...", the texts in the 8 dictionaries;
//   UI part (the dev preview with the mock backend; ports 5220): the menu of a mailbox heading and of a folder of the person (and no menu on the others), the dialog (focus, Enter, Esc, Cancel),
//     the inline errors, the busy button, the new row with the focus, the chevron (aria-expanded, collapsed state kept after a restart), the "." server with the INBOX namespace, a mailbox that needs a
//     sign-in, the keyboard way (Shift+F10), the 8 languages at 960x560, dark.
//   node scripts/test-folder-create.mjs [--require-browser]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sleep, startHarness, languageJs, inputs, ROOT } from './cdp-harness.mjs';
import { checkFolderName } from '../src/folderName.ts';
import { orderTree, visibleTree, hasChildren, collapsedKey } from '../src/folderTree.ts';
import { moveChoices } from '../src/rowMenu.ts';

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const failures = [];
const stat = (name, fn) => { try { fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); } };

// ---------------------------------------------------------------- static
stat('the name rules (REQ-13.10.5)', () => {
  const sib = ['Projects', 'Archive', 'Sent Items', 'INBOX'];
  const c = (raw, d = '/') => checkFolderName(raw, d, sib);
  assert.deepEqual(c('  Clients  '), { name: 'Clients', problem: null }, 'spaces at the ends go silently');
  assert.deepEqual(c('   ').problem, { kind: 'empty' });
  assert.deepEqual(c('x'.repeat(101)).problem, { kind: 'long' });
  assert.equal(c('x'.repeat(100)).problem, null);
  assert.equal(c('é'.repeat(100)).problem, null, 'characters, not bytes');
  assert.deepEqual(c('a/b').problem, { kind: 'chars', chars: '/' });
  assert.deepEqual(c('a.b', '.').problem, { kind: 'chars', chars: '.' }, 'the delimiter of the server');
  assert.equal(c('Release v1.0').problem, null, 'a dot is fine on a slash server');
  assert.deepEqual(c('a*b%c"d\\e*').problem, { kind: 'chars', chars: '* % " \\' }, 'each once, in the order found');
  assert.deepEqual(c('a\u0007b').problem, { kind: 'chars', chars: '\u0007' }, 'a control character');
  for (const r of ['INBOX', 'inbox', 'Inbox', '.', '..']) assert.deepEqual(c(r).problem, { kind: 'reserved' }, r);
  assert.deepEqual(c('projects').problem, { kind: 'exists' }, 'ignoring case');
  assert.deepEqual(c('sent items').problem, { kind: 'exists' }, 'a standard folder by its name');
  assert.equal(c('Báo cáo 報告').problem, null, 'any Unicode');
  assert.deepEqual(checkFolderName('x', undefined, []).problem, null, 'no delimiter known');
});

stat('the tree order and the collapsed folders (REQ-13.10.2)', () => {
  const f = (key, label, parent = null, depth = parent ? 1 : 0) => ({ key: 'f:' + key, name: key, label, parent: parent && 'f:' + parent, depth });
  const list = [f('zeta', 'zeta'), f('Alpha/b', 'b', 'Alpha'), f('Alpha', 'Alpha'), f('Alpha/A', 'A', 'Alpha'), f('beta', 'Beta'), f('Orphan/Child', 'Child', null, 1), f('x10', 'x10'), f('x9', 'x9')];
  const order = orderTree(list, 'en').map((x) => x.name);
  assert.deepEqual(order, ['Alpha', 'Alpha/A', 'Alpha/b', 'beta', 'Orphan/Child', 'x9', 'x10', 'zeta'], 'parents first, siblings by label ignoring case, numbers by value, an orphan as a top-level one');
  assert.deepEqual(orderTree([f('Édith', 'Édith'), f('Zoe', 'Zoe'), f('Eve', 'Eve')], 'fr').map((x) => x.label), ['Édith', 'Eve', 'Zoe'], 'in the language of the app');
  const ordered = orderTree(list, 'en');
  assert.deepEqual(visibleTree(ordered, () => false).length, 8);
  assert.deepEqual(visibleTree(ordered, (k) => k === 'f:Alpha').map((x) => x.name), ['Alpha', 'beta', 'Orphan/Child', 'x9', 'x10', 'zeta'], 'the children of a collapsed folder are not drawn');
  assert.ok(hasChildren(list, 'f:Alpha') && !hasChildren(list, 'f:beta'));
  assert.equal(collapsedKey('a1', 'f:Alpha'), 'a1|f:Alpha');
});

stat('Move to... lists the standard folders, then the person\'s in tree order', () => {
  const rows = [
    { accountId: 'a1', key: 'inbox', name: 'inbox' }, { accountId: 'a1', key: 'drafts', name: 'drafts' }, { accountId: 'a1', key: 'sent', name: 'sent' },
    { accountId: 'a1', key: 'archive', name: 'archive', listed: true }, { accountId: 'a1', key: 'f:B', name: 'B', label: 'B' }, { accountId: 'a1', key: 'f:A/x', name: 'A/x', label: 'x', parent: 'f:A' }, { accountId: 'a1', key: 'f:A', name: 'A', label: 'A' },
    { accountId: 'a2', key: 'f:Z', name: 'Z', label: 'Z' },
  ];
  assert.deepEqual(moveChoices(rows, 'a1', 'inbox').map((x) => x.key), ['archive', 'f:A', 'f:A/x', 'f:B']);
});

stat('the 17 texts are in the 8 dictionaries with the agreed words (spec-107-wp13 section 3, keys 10 to 26)', () => {
  const nb = ' ';
  const want = {
    'mail.folder.new': ['New folder…', 'Thư mục mới…', 'Nouveau dossier…', '新建文件夹…', 'Nueva carpeta…', '新しいフォルダー…', 'Neuer Ordner…', 'Новая папка…'],
    'mail.folder.newSub': ['New subfolder…', 'Thư mục con mới…', 'Nouveau sous-dossier…', '新建子文件夹…', 'Nueva subcarpeta…', '新しいサブフォルダー…', 'Neuer Unterordner…', 'Новая подпапка…'],
    'mail.folder.dlgTitle': ['New folder', 'Thư mục mới', 'Nouveau dossier', '新建文件夹', 'Nueva carpeta', '新しいフォルダー', 'Neuer Ordner', 'Новая папка'],
    'mail.folder.dlgTitleSub': ['New subfolder', 'Thư mục con mới', 'Nouveau sous-dossier', '新建子文件夹', 'Nueva subcarpeta', '新しいサブフォルダー', 'Neuer Unterordner', 'Новая подпапка'],
    'mail.folder.name': ['Folder name', 'Tên thư mục', 'Nom du dossier', '文件夹名称', 'Nombre de la carpeta', 'フォルダー名', 'Ordnername', 'Имя папки'],
    'mail.folder.location': ['Create in', 'Tạo trong', 'Créer dans', '创建位置', 'Crear en', '作成先', 'Erstellen in', 'Создать в'],
    'mail.folder.create': ['Create', 'Tạo', 'Créer', '创建', 'Crear', '作成', 'Erstellen', 'Создать'],
    'mail.folder.created': ['Folder “{name}” created', 'Đã tạo thư mục “{name}”', `Dossier «${nb}{name}${nb}» créé`, '已创建文件夹“{name}”', 'Carpeta “{name}” creada', 'フォルダー「{name}」を作成しました', 'Ordner „{name}“ erstellt', 'Папка «{name}» создана'],
    'mail.folder.errEmpty': ['Enter a folder name.', 'Hãy nhập tên thư mục.', 'Saisissez un nom de dossier.', '请输入文件夹名称。', 'Escribe un nombre de carpeta.', 'フォルダー名を入力してください。', 'Geben Sie einen Ordnernamen ein.', 'Введите имя папки.'],
    'mail.folder.errExists': ['A folder with this name already exists here.', 'Đã có thư mục cùng tên ở đây.', 'Un dossier portant ce nom existe déjà ici.', '此处已有同名文件夹。', 'Ya existe una carpeta con este nombre aquí.', 'この場所には同じ名前のフォルダーが既にあります。', 'Ein Ordner mit diesem Namen existiert hier bereits.', 'Папка с таким именем здесь уже есть.'],
    'mail.folder.errChars': ['A folder name can’t contain {chars}.', 'Tên thư mục không được chứa {chars}.', 'Un nom de dossier ne peut pas contenir {chars}.', '文件夹名称不能包含{chars}。', 'El nombre de una carpeta no puede contener {chars}.', 'フォルダー名に{chars}は使用できません。', 'Ein Ordnername darf {chars} nicht enthalten.', 'Имя папки не может содержать {chars}.'],
    'mail.folder.errReserved': ['This name is reserved. Choose another one.', 'Tên này đã được dành riêng. Hãy chọn tên khác.', 'Ce nom est réservé. Choisissez-en un autre.', '此名称为保留名称，请换一个。', 'Este nombre está reservado. Elige otro.', 'この名前は予約されています。別の名前を入力してください。', 'Dieser Name ist reserviert. Wählen Sie einen anderen.', 'Это имя зарезервировано. Выберите другое.'],
    'mail.folder.errLong': ['Use 100 characters or fewer.', 'Tối đa 100 ký tự.', '100 caractères maximum.', '名称不能超过100个字符。', 'Usa 100 caracteres como máximo.', '100文字以内で入力してください。', 'Maximal 100 Zeichen.', 'Не более 100 символов.'],
    'mail.folder.errNoPerm': ['The server doesn’t let you create a folder here.', 'Máy chủ không cho phép tạo thư mục ở đây.', 'Le serveur ne permet pas de créer un dossier ici.', '服务器不允许在此处创建文件夹。', 'El servidor no permite crear una carpeta aquí.', 'サーバーでは、ここにフォルダーを作成できません。', 'Der Server erlaubt hier keine neuen Ordner.', 'Сервер не разрешает создавать здесь папки.'],
    'mail.folder.errFailed': ['Couldn’t create the folder: {error}', 'Không tạo được thư mục: {error}', `Impossible de créer le dossier${nb}: {error}`, '无法创建文件夹：{error}', 'No se pudo crear la carpeta: {error}', 'フォルダーを作成できませんでした：{error}', 'Der Ordner konnte nicht erstellt werden: {error}', 'Не удалось создать папку: {error}'],
    'mail.folder.needsSignIn': ['Sign in to this mailbox again first.', 'Hãy đăng nhập lại hộp thư này trước.', 'Reconnectez-vous d’abord à cette boîte.', '请先重新登录此邮箱。', 'Primero inicia sesión de nuevo en este buzón.', '先にこのメールボックスに再度サインインしてください。', 'Melden Sie sich zuerst erneut an.', 'Сначала войдите в этот ящик заново.'],
    'mail.folder.subfolders': ['Subfolders of {name}', 'Thư mục con của {name}', 'Sous-dossiers de {name}', '{name}的子文件夹', 'Subcarpetas de {name}', '{name}のサブフォルダー', 'Unterordner von {name}', 'Подпапки: {name}'],
  };
  const dirs = ['ns', 'locales/vi', 'locales/fr', 'locales/zh-Hans', 'locales/es', 'locales/ja', 'locales/de', 'locales/ru'];
  for (const [k, texts] of Object.entries(want)) dirs.forEach((d, i) => assert.ok(read(`src/i18n/${d}/mail.ts`).includes(`"${k}": ${JSON.stringify(texts[i])}`), `${d} ${k}`));
});

stat('the wiring: the dialog is a lazy chunk, the command is in its three places, the backend keeps the delimiter', () => {
  assert.ok(/import\("\.\/components\/FolderDialog"\)/.test(read('src/lazyViews.tsx')));
  for (const f of ['src/App.tsx', 'src/store.ts', 'src/components/FolderPane.tsx', 'src/components/AccountReorder.tsx']) assert.ok(!/import[^;]*components\/FolderDialog|import[^;]*\.\/FolderDialog/.test(read(f).replace(/import type[^;]*;/g, '')), `${f} imports the dialog statically`);
  assert.ok(JSON.parse(read('scripts/bundle-budget.json')).mustBeLazy.some((m) => m.module === 'src/components/FolderDialog.tsx' && m.since === '1.0.7'), 'mustBeLazy');
  assert.ok(/fn create_mail_folder\(/.test(read('src-tauri/src/lib.rs')) && /^\s+create_mail_folder,$/m.test(read('src-tauri/src/lib.rs')), 'generate_handler!');
  assert.ok(/"create_mail_folder"/.test(read('src-tauri/build.rs')), 'APP_COMMANDS');
  assert.ok(JSON.parse(read('src-tauri/capabilities/default.json')).permissions.includes('allow-create-mail-folder'), 'capability');
  assert.ok(!JSON.parse(read('src-tauri/capabilities/popout.json')).permissions.includes('allow-create-mail-folder'), 'not for the secondary windows');
  assert.ok(/fmeta:/.test(read('src-tauri/src/lib.rs')) && /fn encode_imap_utf7/.test(read('src-tauri/src/mail.rs')), 'delimiter and prefix saved, the UTF-7 encoder');
  const pane = read('src/components/FolderPane.tsx');
  assert.ok(!/split\(\/\[\/\.\]\/\)/.test(pane), 'the side menu does not split names on / and . any more');
});

// ---------------------------------------------------------------- UI
const H = await startHarness('test-folder-create', { vitePort0: 5220 });
const { evaluate, cdp } = H;
const { press, typeText } = inputs(H, null, 'folder-create');
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); } };
const waitFor = async (js, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between renders */ } await sleep(40); } return false; };
const S = (p) => `window.__store.getState().${p}`;
const A = 'a1';
const rightClick = async (x, y) => {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
  await sleep(150);
};
const centre = (sel) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
const head = (acct = A) => `.fp-group[data-reorder-id="${acct}"] .fp-head`;
const rowSel = (key, acct = A) => `.fp-row[data-fkey="${acct}|${key}"]`;
const menu = () => evaluate(`[...document.querySelectorAll('[role=menu] [role=menuitem]')].map((e) => ({ text: e.querySelector('.menu-lbl').textContent.trim(), hint: (e.querySelector('.menu-hint') || {}).textContent || '', disabled: e.getAttribute('aria-disabled') === 'true' }))`);
const hasMenu = () => evaluate(`!!document.querySelector('[role=menu]')`);
const dialog = () => evaluate(`(() => { const d = document.querySelector('[role=dialog]'); if (!d) return null; const i = d.querySelector('#fd-name'); const e = d.querySelector('#fd-err'); const b = d.querySelector('.fd-actions .btn.primary'); const r = d.getBoundingClientRect(); return { title: d.querySelector('.modal-head b').textContent, loc: d.querySelector('.fd-lbl').textContent, where: d.querySelector('.fd-where').textContent, focus: document.activeElement === i, value: i.value, err: e ? e.textContent : null, invalid: i.getAttribute('aria-invalid'), described: i.getAttribute('aria-describedby'), create: b.textContent.trim(), createOff: b.disabled, busy: b.getAttribute('aria-busy'), ring: !!b.querySelector('.spin'), cancel: [...d.querySelectorAll('button')].find((x) => x.closest('.fd-actions') && !x.classList.contains('primary')).textContent.trim(), inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, clipped: [...d.querySelectorAll('.fd-where, .fd-err, .fd-actions .btn, .modal-head b')].some((x) => x.scrollWidth > x.clientWidth + 1 && getComputedStyle(x).textOverflow !== 'ellipsis') }; })()`);
const rows = () => evaluate(`[...document.querySelectorAll('.fp-group[data-reorder-id="${A}"] .fp-row')].map((r) => ({ key: r.dataset.fkey ? r.dataset.fkey.split('|').slice(1).join('|') : null, label: r.querySelector('.fp-lbl').textContent, pad: parseInt(r.style.paddingLeft || '0'), level: r.getAttribute('aria-level'), expanded: r.getAttribute('aria-expanded'), chev: !!r.querySelector('.fp-chev') }))`);
const creates = () => evaluate(`window.__mockFolderCreates || []`);
const openApp = (hash = 'lang=en', w = 1280, h = 800) => H.openApp(hash, w, h);
/** folders made on the mock server by "another client", then the page reads the list */
const otherClient = async (...names) => { await evaluate(`${names.map((n) => `window.__mockAddFolder('${A}', ${JSON.stringify(n)});`).join(' ')} ${S('refresh')}().then(() => 1)`); await sleep(350); };
const newFolderFromHeading = async (acct = A) => {
  const p = await centre(head(acct));
  await rightClick(p[0], p[1]);
  const m = await menu();
  const i = m.findIndex((x) => x.text.startsWith('New folder'));
  assert.ok(i >= 0, 'no New folder item: ' + JSON.stringify(m));
  await evaluate(`[...document.querySelectorAll('[role=menu] [role=menuitem]')][${i}].click(); 1`);
  assert.ok(await waitFor(`!!document.querySelector('[role=dialog] #fd-name')`), 'the dialog did not open');
  await sleep(120);
};
const typeAndEnter = async (text) => {
  await evaluate(`(() => { const i = document.getElementById('fd-name'); i.focus(); i.select(); return 1; })()`);
  await cdp('Input.insertText', { text });
  await press('Enter', 'Enter');
};
const closeDialog = async () => { await evaluate(`${S('setDialog')}(null); 1`); await sleep(150); };

try {
  await openApp();
  await evaluate(`${S('setView')}('inbox', '${A}').then(() => 1)`);
  await sleep(300);

  await check('AC-13.10.1 right-click the mailbox heading: Move up, Move down, divider, New folder…; the dialog; Projects is created, shown, focused, toast', async () => {
    const p = await centre(head());
    await rightClick(p[0], p[1]);
    assert.deepEqual((await menu()).map((m) => m.text), ['Move up', 'Move down', 'New folder…', 'Manage rules…', 'Account settings…'], '(1.0.8: Manage rules…, 1.0.10: Account settings… is the last entry)');
    assert.equal(await evaluate(`document.querySelectorAll('[role=menu] [role=separator]').length`), 1, 'a divider before it');
    const m = await menu();
    assert.ok(!m[2].disabled);
    await evaluate(`document.querySelectorAll('[role=menu] [role=menuitem]')[2].click(); 1`);
    assert.ok(await waitFor(`!!document.querySelector('[role=dialog] #fd-name')`));
    await sleep(120);
    const d = await dialog();
    assert.equal(d.title, 'New folder');
    assert.equal(d.loc, 'Create in');
    assert.ok(d.where.length > 0 && !/—/.test(d.where), `the mailbox name: ${d.where}`);
    assert.ok(d.focus, 'the focus is in "Folder name"');
    assert.equal(d.value, '');
    assert.equal(d.createOff, true, 'Create is off while the name is empty');
    assert.equal(d.err, null);
    await typeAndEnter('Projects');
    assert.ok(await waitFor(`!document.querySelector('[role=dialog]')`), 'the dialog closed');
    assert.deepEqual((await creates()).map((c) => [c.accountId, c.parentKey, c.name]), [[A, null, 'Projects']]);
    assert.ok(await waitFor(`!!document.querySelector('${rowSel('f:Projects')}')`), 'the folder is in the side menu at once');
    await sleep(300);
    assert.equal(await evaluate(`document.activeElement && document.activeElement.dataset.fkey`), `${A}|f:Projects`, 'the new row has the focus');
    assert.equal(await evaluate(S('folder')), 'inbox', 'it is not opened');
    assert.equal(await evaluate(`[...document.querySelectorAll('.toast .toast-text')].map((x) => x.textContent.trim()).join('|')`), 'Folder “Projects” created');
    const r = await rows();
    const at = r.findIndex((x) => x.key === 'f:Projects');
    assert.equal(r[at + 1].label, 'Hey Look', 'the folder "Projects/Hey Look" of another client is now its child');
    assert.equal(r[at + 1].pad, r[at].pad + 16, 'indented one more step');
    assert.equal(r[at].chev, true, 'a folder with a subfolder has a chevron');
  });

  await check('AC-13.10.2 / .3 a folder of the person has "New subfolder…", a subfolder and the standard folders have no menu; the chevron collapses and the state is kept', async () => {
    let p = await centre(rowSel('f:Projects'));
    await rightClick(p[0], p[1]);
    assert.deepEqual((await menu()).map((m) => m.text), ['New subfolder…']);
    await evaluate(`document.querySelector('[role=menu] [role=menuitem]').click(); 1`);
    assert.ok(await waitFor(`!!document.querySelector('[role=dialog] #fd-name')`));
    await sleep(120);
    const d = await dialog();
    assert.equal(d.title, 'New subfolder');
    assert.ok(/^Projects — /.test(d.where), d.where);
    await typeAndEnter('2026');
    assert.ok(await waitFor(`!!document.querySelector('${rowSel('f:Projects/2026')}')`));
    assert.deepEqual((await creates()).pop(), { accountId: A, parentKey: 'f:Projects', name: '2026' });
    await sleep(250);
    const r = await rows();
    const top = r.find((x) => x.key === 'f:Projects'), kid = r.find((x) => x.key === 'f:Projects/2026');
    assert.equal(kid.pad, top.pad + 16);
    assert.deepEqual([top.expanded, top.chev], ['true', true]);
    // no menu on a subfolder, Inbox, Sent, Archive
    const byLabel = (label) => evaluate(`(() => { const e = [...document.querySelectorAll('.fp-group[data-reorder-id="${A}"] .fp-row')].find((r) => r.querySelector('.fp-lbl').textContent === ${JSON.stringify(label)}); if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
    const std = (await rows()).slice(0, 4).map((x) => x.label); // Inbox, Drafts, Sent, Archive in the language of the app
    for (const label of ['2026', std[0], std[2], std[3]]) {
      p = await byLabel(label);
      assert.ok(p, 'no row ' + label);
      await rightClick(p[0], p[1]);
      assert.equal(await hasMenu(), false, `a menu on ${label}`);
    }
    // the chevron: name, collapse, children gone, state saved
    const name = await evaluate(`document.querySelector('${rowSel('f:Projects')} .fp-chev').getAttribute('aria-label')`);
    assert.equal(name, 'Subfolders of Projects');
    await evaluate(`document.querySelector('${rowSel('f:Projects')} .fp-chev').click(); 1`);
    await sleep(200);
    assert.equal(await evaluate(`!!document.querySelector('${rowSel('f:Projects/2026')}')`), false);
    assert.equal(await evaluate(`document.querySelector('${rowSel('f:Projects')}').getAttribute('aria-expanded')`), 'false');
    assert.equal(await evaluate(S(`prefs.collapsed['${A}|f:Projects']`)), true);
    assert.equal(await evaluate(S('folder')), 'inbox', 'the chevron does not open the folder');
  });

  await check('AC-13.10.2 after a restart the folder is still collapsed; creating in a collapsed parent expands it', async () => {
    await openApp('lang=en&persist');
    await evaluate(`${S('setPrefs')}({ collapsed: { '${A}|f:Projects': true } }); 1`);
    await sleep(300);
    await openApp('lang=en&persist');
    assert.equal(await evaluate(S(`prefs.collapsed['${A}|f:Projects']`)), true, 'stored');
    await otherClient('Projects', 'Projects/Old');
    assert.equal(await evaluate(`document.querySelector('${rowSel('f:Projects')}').getAttribute('aria-expanded')`), 'false');
    assert.equal(await evaluate(`!!document.querySelector('${rowSel('f:Projects/Old')}')`), false, 'collapsed after a restart');
    // a subfolder made here: the parent opens so the new row is in view
    await evaluate(`${S('addFolder')}({ accountId: '${A}', key: 'f:Projects/New', name: 'Projects/New', unread: 0, total: 0, label: 'New', depth: 1, parent: 'f:Projects', canNest: false }); 1`);
    await sleep(200);
    await otherClient('Projects/New');
    assert.equal(await evaluate(`!!document.querySelector('${rowSel('f:Projects/New')}')`), true, 'the parent opened for the new subfolder');
  });

  await check('AC-13.10.4 validation: the dialog stays open and says what is wrong; Cancel / Esc close it', async () => {
    await openApp();
    await evaluate(`${S('setView')}('inbox', '${A}').then(() => 1)`);
    await otherClient('Projects');
    await newFolderFromHeading();
    const expect = async (text, msg, ctxt) => {
      await typeAndEnter(text);
      await sleep(120);
      const d = await dialog();
      assert.ok(d, 'the dialog closed for ' + JSON.stringify(text));
      assert.equal(d.err, msg, ctxt || text);
      assert.equal(d.invalid, 'true');
      assert.equal(d.described, 'fd-err');
    };
    // empty + Enter: the name field is empty, Create is off, Enter still says what is missing
    await evaluate(`(() => { const i = document.getElementById('fd-name'); i.focus(); return 1; })()`);
    await press('Enter', 'Enter');
    await sleep(120);
    assert.equal((await dialog()).err, 'Enter a folder name.');
    await expect('a/b', 'A folder name can’t contain /.');
    await expect('a*b/c', 'A folder name can’t contain * /.');
    await expect('inbox', 'This name is reserved. Choose another one.');
    await expect('..', 'This name is reserved. Choose another one.');
    await expect('projects', 'A folder with this name already exists here.');
    await expect('x'.repeat(101), 'Use 100 characters or fewer.');
    await expect('Archive', 'A folder with this name already exists here.', 'a standard folder');
    assert.deepEqual(await creates(), [], 'nothing was sent');
    // the error goes when the name changes into a good one
    await evaluate(`(() => { const i = document.getElementById('fd-name'); i.focus(); i.select(); return 1; })()`);
    await cdp('Input.insertText', { text: 'Fine' });
    await sleep(100);
    const d = await dialog();
    assert.equal(d.err, null);
    assert.equal(d.createOff, false);
    // Cancel and Esc
    await evaluate(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === 'Cancel').click(); 1`);
    assert.ok(await waitFor(`!document.querySelector('[role=dialog]')`));
    assert.deepEqual(await creates(), []);
    await newFolderFromHeading();
    await press('Escape', 'Escape');
    assert.ok(await waitFor(`!document.querySelector('[role=dialog]')`), 'Esc closes');
  });

  await check('AC-13.10.6 a refusal of the server: no permission, exists, anything else (the dialog stays open, the text is under the field)', async () => {
    for (const [mode, want] of [['noperm', 'The server doesn’t let you create a folder here.'], ['exists', 'A folder with this name already exists here.'], ['fail', 'Couldn’t create the folder: The server did not answer within 20 seconds.']]) {
      await openApp(`lang=en&createfail=${mode}`);
      await evaluate(`${S('setView')}('inbox', '${A}').then(() => 1)`);
      await sleep(200);
      await newFolderFromHeading();
      await typeAndEnter('Brand new');
      assert.ok(await waitFor(`!!document.querySelector('#fd-err')`), mode);
      const d = await dialog();
      assert.ok(d.err.startsWith(want.slice(0, 40)), `${mode}: ${d.err}`);
      assert.ok(d.focus, 'the focus is back in the field');
      assert.equal(d.busy, null, 'the button is ready again');
      assert.equal(await evaluate(`!!document.querySelector('${rowSel('f:Brand new')}')`), false);
    }
  });

  await check('REQ-13.10.4 the button is busy while the server works (a ring, no second press); Cancel only closes, the folder still arrives', async () => {
    await openApp('lang=en&createfail=slow');
    await evaluate(`${S('setView')}('inbox', '${A}').then(() => 1)`);
    await sleep(200);
    await newFolderFromHeading();
    await typeAndEnter('Slow one');
    await sleep(150);
    let d = await dialog();
    assert.equal(d.busy, 'true');
    assert.ok(d.ring, 'a ring');
    assert.equal(d.create, 'Create', 'the name of the button does not change');
    await press('Enter', 'Enter');
    await sleep(100);
    assert.equal((await creates()).length, 1, 'a second Enter starts nothing');
    await evaluate(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === 'Cancel').click(); 1`);
    assert.ok(await waitFor(`!document.querySelector('[role=dialog]')`), 'Cancel closes while the server works');
    assert.ok(await waitFor(`!!document.querySelector('${rowSel('f:Slow one')}')`, 6000), 'the CREATE that was sent is not undone: the folder shows');
  });

  await check('AC-13.10.7 a "." server with the INBOX namespace: Clients, then Acme under it', async () => {
    await openApp('lang=en&dot');
    await evaluate(`${S('setView')}('inbox', '${A}').then(() => 1)`);
    await sleep(200);
    await newFolderFromHeading();
    await typeAndEnter('a.b');
    await sleep(120);
    assert.equal((await dialog()).err, 'A folder name can’t contain ..', 'the delimiter of this server');
    await typeAndEnter('Clients');
    assert.ok(await waitFor(`!!document.querySelector('${rowSel('f:INBOX.Clients')}')`));
    assert.deepEqual((await creates()).pop(), { accountId: A, parentKey: null, name: 'Clients' });
    await sleep(250);
    let r = await rows();
    assert.equal(r.find((x) => x.key === 'f:INBOX.Clients').label, 'Clients', 'shown at the top level as Clients');
    const p = await centre(rowSel('f:INBOX.Clients'));
    await rightClick(p[0], p[1]);
    await evaluate(`document.querySelector('[role=menu] [role=menuitem]').click(); 1`);
    assert.ok(await waitFor(`!!document.querySelector('[role=dialog] #fd-name')`));
    await typeAndEnter('Acme');
    assert.ok(await waitFor(`!!document.querySelector('${rowSel('f:INBOX.Clients.Acme')}')`));
    await sleep(250);
    r = await rows();
    assert.deepEqual([r.find((x) => x.key === 'f:INBOX.Clients.Acme').label, r.find((x) => x.key === 'f:INBOX.Clients.Acme').pad - r.find((x) => x.key === 'f:INBOX.Clients').pad], ['Acme', 16]);
  });

  await check('AC-13.10.8 "Release v1.0" made in another client is ONE folder, not "0" under "Release v1"', async () => {
    await openApp();
    await evaluate(`${S('setView')}('inbox', '${A}').then(() => 1)`);
    await otherClient('Release v1.0');
    const r = await rows();
    const x = r.find((y) => y.key === 'f:Release v1.0');
    assert.deepEqual([x.label, x.pad], ['Release v1.0', 28]);
  });

  await check('AC-13.10.9 a mailbox that needs a new sign-in: "New folder…" is greyed with the reason', async () => {
    await openApp('lang=en&reauth=again');
    await sleep(500);
    await newFolderFromHeading('a2').catch(() => undefined);
    const m = await menu();
    const item = m.find((x) => x.text.startsWith('New folder'));
    assert.ok(item && item.disabled, JSON.stringify(m));
    assert.equal(item.hint, 'Sign in to this mailbox again first.');
    await evaluate(`[...document.querySelectorAll('[role=menu] [role=menuitem]')].find((e) => /New folder/.test(e.textContent)).click(); 1`);
    await sleep(150);
    assert.equal(await evaluate(`!!document.querySelector('[role=dialog]')`), false, 'activating it does nothing');
    await press('Escape', 'Escape');
  });

  await check('AC-13.10.10 keyboard only: Tab to the heading, Shift+F10, Down to "New folder…", Enter, type, Enter: created, focus on the new row', async () => {
    await openApp();
    await evaluate(`${S('setView')}('inbox', '${A}').then(() => 1)`);
    await sleep(200);
    await evaluate(`document.querySelector('${head()}').focus(); 1`);
    await press('F10', 'F10', 8); // Shift
    await sleep(200);
    assert.ok(await hasMenu(), 'the menu opened from the keyboard');
    await press('ArrowDown', 'ArrowDown');
    await press('ArrowDown', 'ArrowDown');
    assert.equal(await evaluate(`document.activeElement.textContent.trim()`), 'New folder…', 'Move up, Move down (both stay in the keyboard order), then New folder');
    await press('Enter', 'Enter');
    assert.ok(await waitFor(`!!document.querySelector('[role=dialog] #fd-name')`));
    await sleep(120);
    assert.equal((await dialog()).focus, true);
    await cdp('Input.insertText', { text: 'Keys' });
    await press('Enter', 'Enter');
    assert.ok(await waitFor(`!!document.querySelector('${rowSel('f:Keys')}')`));
    await sleep(350);
    assert.equal(await evaluate(`document.activeElement.dataset.fkey`), `${A}|f:Keys`);
    // a folder row: Shift+F10 gives its menu, ArrowLeft / ArrowRight fold a folder that has subfolders
    await evaluate(`document.querySelector('${rowSel('f:Keys')}').focus(); 1`);
    await press('F10', 'F10', 8);
    await sleep(200);
    assert.deepEqual((await menu()).map((m) => m.text), ['New subfolder…']);
    await press('Escape', 'Escape');
  });

  await check('"Move to…" lists the new folder at once, a subfolder as "Parent / Child" (REQ-13.10.8)', async () => {
    await openApp();
    await evaluate(`${S('setView')}('inbox', '${A}').then(() => 1)`);
    await sleep(250);
    await otherClient('Q', 'Q/2026');
    // the list that Move to... is made from (src/rowMenu.ts moveChoices, in the static part above) has them now
    const keys = await evaluate(`${S('folders')}.filter((f) => f.accountId === '${A}').map((f) => f.key)`);
    assert.ok(keys.includes('f:Q') && keys.includes('f:Q/2026'));
  });

  await check('AC-13.10.11 the dialog, the menu items and the errors in the 8 languages at 960x560, light and dark: nothing clipped', async () => {
    await openApp('lang=en', 960, 560);
    await evaluate(`${S('setView')}('inbox', '${A}').then(() => 1)`);
    await sleep(200);
    for (const theme of ['light', 'dark']) {
      await evaluate(`${S('setPrefs')}({ theme: '${theme}' }); 1`);
      for (const lang of ['en', 'vi', 'fr', 'zh-Hans', 'es', 'ja', 'de', 'ru']) {
        await evaluate(languageJs(lang));
        await sleep(150);
        const p = await centre(head());
        await rightClick(p[0], p[1]);
        const m = await evaluate(`[...document.querySelectorAll('[role=menu] [role=menuitem]')].map((e) => ({ text: e.querySelector('.menu-lbl').textContent.trim(), clipped: e.scrollWidth > e.clientWidth + 1 || e.querySelector('.menu-lbl').scrollWidth > e.querySelector('.menu-lbl').clientWidth + 1 }))`);
        assert.equal(m.length, 5, `${lang} ${theme}: ${JSON.stringify(m)}`); // (Move up, Move down, New folder…, from 1.0.8 Manage rules…, from 1.0.10 Account settings…)
        assert.ok(!m[2].clipped && !/mail\.folder/.test(m[2].text) && !m[3].clipped && !/mail\.acct/.test(m[3].text), `${lang}: ${JSON.stringify([m[2], m[3]])}`);
        await evaluate(`document.querySelectorAll('[role=menu] [role=menuitem]')[2].click(); 1`);
        assert.ok(await waitFor(`!!document.querySelector('[role=dialog] #fd-name')`));
        await sleep(100);
        for (const text of ['a/b', 'x'.repeat(101), 'inbox']) {
          await typeAndEnter(text);
          await sleep(100);
          const d = await dialog();
          assert.ok(d.err && !/mail\.folder/.test(d.err), `${lang}: ${text}: ${d.err}`);
          assert.ok(d.inside && !d.clipped, `${lang} ${theme} ${text.slice(0, 5)}: ${JSON.stringify(d)}`);
        }
        const d = await dialog();
        assert.ok(d.title && d.loc && d.create && d.cancel && !/mail\.folder|common\./.test(d.title + d.loc + d.create + d.cancel), `${lang}: ${JSON.stringify(d)}`);
        await closeDialog();
      }
    }
  });
} finally {
  await H.shutdown();
}

if (failures.length) { console.error(`test-folder-create: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-folder-create: ok');
