#!/usr/bin/env node
// 1.0.7 W5.11 (DEC-026, AC-5.11.6) static guards for the macOS menu bar items and the local network reason:
//   - Info.plist has NSLocalNetworkUsageDescription (the agreed English text) and no NSBonjourServices; the 7 translations are macos/<lang>.lproj/InfoPlist.strings with the agreed texts, and
//     tauri.conf.json bundle.macOS.files puts each of them into Contents/Resources/<lang>.lproj/
//   - the page has no Cmd+P handler on macOS (the menu item owns the key: a second handler would print twice): the only `p` key handlers are the reader's Ctrl+P (not on macOS), the composer's
//     Ctrl+Shift+P and the Confidential guard that only stops the key
//   - the wiring: the command in the three places and in the capabilities of main and the reader / compose windows only, the page reports on every change, the menu events have listeners, the gear and
//     the menu item share one function
//   node --experimental-strip-types scripts/test-mac-menu.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let n = 0;
const check = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`FAIL ${name}: ${e.message}`); process.exitCode = 1; } };

// the texts agreed with the language specialists (spec-107-wp5.md, WP5f-mac)
const REASON = {
  en: 'Hey Look! uses the local network only to find your printers when you print.',
  vi: 'Hey Look! chỉ dùng mạng cục bộ để tìm máy in của bạn khi bạn in.',
  fr: 'Hey Look! utilise le réseau local uniquement pour trouver vos imprimantes lors de l’impression.',
  'zh-Hans': 'Hey Look!仅在您打印时使用本地网络来查找打印机。',
  es: 'Hey Look! usa la red local solo para encontrar tus impresoras cuando imprimes.',
  ja: 'Hey Look!は、プリントするときにプリンタを見つけるためだけにローカルネットワークを使用します。',
  de: 'Hey Look! verwendet das lokale Netzwerk nur, um beim Drucken Ihre Drucker zu finden.',
  ru: 'Hey Look! использует локальную сеть только для поиска ваших принтеров при печати.',
};

check('Info.plist: the reason text and no NSBonjourServices (REQ-5.11.5)', () => {
  const plist = read('src-tauri/Info.plist');
  assert.ok(plist.startsWith('<?xml') && plist.includes('<plist version="1.0">') && plist.trimEnd().endsWith('</plist>'), 'a property list');
  const m = /<key>NSLocalNetworkUsageDescription<\/key>\s*<string>([^<]*)<\/string>/.exec(plist);
  assert.ok(m, 'NSLocalNetworkUsageDescription');
  assert.equal(m[1], REASON.en);
  assert.ok(!plist.includes('NSBonjourServices'), 'Hey Look! browses no Bonjour service itself');
  assert.ok(/<key>CFBundleDevelopmentRegion<\/key>\s*<string>en<\/string>/.test(plist), 'English is the fallback of the localised files');
  assert.equal((plist.match(/<key>/g) ?? []).length, (plist.match(/<string>/g) ?? []).length, 'every key has one string');
});

check('the 7 translations are placed in Contents/Resources by bundle.macOS.files, and say the agreed texts', () => {
  const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
  const files = conf.bundle.macOS.files;
  for (const [lang, text] of Object.entries(REASON)) {
    if (lang === 'en') continue;
    const src = `macos/${lang}.lproj/InfoPlist.strings`;
    assert.equal(files[`Resources/${lang}.lproj/InfoPlist.strings`], src, `${lang}: placed`);
    const body = read(`src-tauri/${src}`);
    assert.ok(body.includes(`"NSLocalNetworkUsageDescription" = "${text}";`), `${lang}: the agreed text`);
    assert.ok(!body.includes('NSBonjourServices'), `${lang}: no Bonjour`);
    assert.ok(!/"[^"]*"\s*=\s*"[^"]*";[\s\S]*"[^"]*"\s*=\s*"[^"]*";/.test(body.replace(/\/\*[\s\S]*?\*\//g, '')), `${lang}: one entry`);
  }
  assert.equal(Object.keys(files).length, 7, 'nothing else is placed');
  assert.ok(!conf.bundle.macOS.infoPlist, 'the file src-tauri/Info.plist is the one Tauri merges by itself (next to tauri.conf.json)');
});

check('AC-5.11.6 the page has no Cmd+P handler on macOS: the menu item owns the key', () => {
  const files = [];
  const walk = (d) => { for (const f of fs.readdirSync(path.join(root, d), { withFileTypes: true })) { const p = `${d}/${f.name}`; if (f.isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f.name)) files.push(p); } };
  walk('src');
  const hits = [];
  for (const f of files) if (/\.toLowerCase\(\) === ["']p["']/.test(read(f))) hits.push(f);
  assert.deepEqual(hits.sort(), ['src/components/Compose.tsx', 'src/popout/readerLogic.ts', 'src/protect.ts'], 'the files with a `p` key test');
  // the reader: Ctrl+P prints, not on macOS
  assert.ok(read('src/popout/readerLogic.ts').includes('if (!ctx.mac && cmd && !e.altKey && !e.shiftKey && k.toLowerCase() === "p") return "print";'));
  // the composer: Ctrl/Cmd+Shift+P is its own key (a plain Cmd+P is not)
  assert.ok(/\.shiftKey && e\.key\.toLowerCase\(\) === "p"/.test(read('src/components/Compose.tsx')));
  // the Confidential guard only stops the key; it never prints
  const protect = read('src/protect.ts');
  assert.ok(/=== "p"\) \{\s*\n\s*e\.preventDefault\(\);/.test(protect) && !protect.includes('print('));
  // no page code prints on a key by itself
  for (const f of files) assert.ok(!/key[^\n]{0,80}["']p["'][^\n]{0,200}(printFrame|printOpenMessage|\.print\()/.test(read(f)), `${f} prints on a key`);
});

check('the wiring: command in the three places, the windows that may call it, the page reports, the events have listeners', () => {
  assert.ok(/macMenuState:\s*\(canPrint: boolean\) => invoke<void>\("mac_menu_state", \{ canPrint \}\)/.test(read('src/api.ts')));
  const lib = read('src-tauri/src/lib.rs');
  assert.ok(lib.includes('fn mac_menu_state(app: tauri::AppHandle, window: tauri::WebviewWindow, can_print: bool)') && /generate_handler!\[[\s\S]*?\bmac_menu_state,/.test(lib));
  assert.ok(read('src-tauri/build.rs').includes('"mac_menu_state"'));
  const caps = (f) => JSON.parse(read(`src-tauri/capabilities/${f}.json`)).permissions;
  assert.ok(caps('default').includes('allow-mac-menu-state') && caps('popout').includes('allow-mac-menu-state'));
  for (const f of ['settings', 'event', 'search', 'scheduled']) assert.ok(!caps(f).includes('allow-mac-menu-state'), `${f} cannot print`);
  const menu = read('src/macMenu.ts');
  assert.ok(menu.includes('listen("mac-print"') && menu.includes('listen("mac-help"') && menu.includes('listen("mac-open-settings"'));
  assert.ok(menu.includes('siteUrl("help.html")') && menu.includes('openUpdateLink('), 'Help: help.html of the language, the opener that tells a failure');
  assert.ok(/if \(printer\?\.can\) printer\.print\(\)/.test(menu), 'Print does nothing unless the window said it can');
  assert.ok(/if \(reported === can\) return;/.test(menu), 'told on a change only');
  assert.ok(read('src/main.tsx').includes('installMacMenu(route.kind === "main")'));
  assert.ok(read('src/components/ReadingPane.tsx').includes('useMacPrint(') && read('src/popout/ReaderView.tsx').includes('useMacPrint('));
  // the gear and the menu item are one function
  assert.ok(read('src/components/TopBar.tsx').includes('onClick={openSettingsLikeGear}') && menu.includes('export function openSettingsLikeGear'));
  // Windows and Linux: nothing is built there (the items are macOS code; the page only reports on a Mac)
  assert.ok(menu.includes('usePlatform((s) => s.os === "macos")'));
});

check('the menu code takes no unsafe shortcut (DEC-024: no manual release; the items are muda items)', () => {
  const shell = read('src-tauri/src/shell.rs');
  const code = shell.slice(0, shell.indexOf('#[cfg(test)]\nmod platform_tests'));
  for (const w of ['autorelease', 'CFRelease', 'objc_release', 'msg_send', '.release()']) assert.ok(!code.includes(w), `shell.rs uses ${w}`);
});

console.log(`${process.exitCode ? 'FAILED' : 'ok'} - test-mac-menu (${n} checks)`);
