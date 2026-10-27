#!/usr/bin/env node
// 1.0.10: the app ships its own interface font (Inter, SIL OFL 1.1, public/fonts) so that text looks and wraps the same on Windows, macOS and Linux.
//   - static: the @font-face rules (family Inter, weights 400 to 700, font-display: block, one file per subset with its unicode-range), the files exist and are woff2,
//     the licence text ships next to them, index.html preloads the Latin file (crossorigin) and links the rules before the app's stylesheet, the CSP allows font-src 'self',
//     the root font stack starts with "Inter" and keeps the native stack and the CJK system fonts as the fallback, the message frame's own font is not Inter;
//   - served: the dev server answers the files with a font MIME type and a woff2 signature;
//   - in the page: document.fonts is loaded when the mail UI is on screen, `14px Inter` is available (Latin, Cyrillic, Vietnamese), the chrome (list, dialogs, composer UI)
//     is computed as Inter, and the body of a message in the reader and of the editor is not.
//   node scripts/test-font-bundle.mjs [--require-browser | --url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, sleep, startHarness } from './cdp-harness.mjs';

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

// ---- 1. static ----------------------------------------------------------------------------------------------------------------------------------------
const fontCss = read('public/fonts/fonts.css'), html = read('index.html'), app = read('src/App.css'), tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
const faces = [...fontCss.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);
ok(faces.length === 3, `three @font-face rules (latin, vietnamese, cyrillic): ${faces.length}`);
const seen = new Set();
for (const f of faces) {
  ok(/font-family:\s*"Inter"/.test(f), 'family Inter');
  ok(/font-weight:\s*400 700/.test(f), 'weights 400 to 700 (the range the CSS uses)');
  ok(/font-display:\s*block/.test(f), 'font-display: block (a local file: no flash of the fallback face)');
  ok(/unicode-range:\s*U\+/.test(f), 'a unicode-range per subset');
  const u = /url\(\/fonts\/([a-z-]+\.woff2)\)\s*format\("woff2"\)/.exec(f);
  ok(u, 'src is a woff2 file of /fonts/');
  seen.add(u[1]);
  const buf = fs.readFileSync(path.join(ROOT, 'public/fonts', u[1]));
  ok(buf.subarray(0, 4).toString('latin1') === 'wOF2', `${u[1]} is a woff2 file`);
  ok(buf.length > 3000 && buf.length < 40000, `${u[1]} size ${buf.length} B`);
}
ok(['inter-latin.woff2', 'inter-vietnamese.woff2', 'inter-cyrillic.woff2'].every((n) => seen.has(n)), `the three subsets: ${[...seen]}`);
ok(/SIL OPEN FONT LICENSE Version 1\.1/.test(read('public/fonts/OFL.txt')) && /Inter Project Authors/.test(read('public/fonts/OFL.txt')), 'the OFL text ships with the font');
ok(/Inter/.test(read('README.md')) && /SIL Open Font License/.test(read('README.md')), 'README names Inter and its licence');
ok(/ships its own font \(Inter\)/.test(read('CHANGELOG.md')), 'CHANGELOG has the 1.0.10 line');
{
  const pre = html.indexOf('<link rel="preload" href="/fonts/inter-latin.woff2" as="font" type="font/woff2" crossorigin />'), sheet = html.indexOf('<link rel="stylesheet" href="/fonts/fonts.css" />'), main = html.indexOf('<script type="module"');
  ok(pre > 0 && sheet > pre && sheet < main, 'index.html preloads the Latin file (crossorigin, as a font needs) and links the font rules before the app');
}
ok(/font-src 'self'/.test(tauri.app.security.csp), 'the CSP allows fonts from the app itself');
{
  const root = /--fs: 14px;\s*font-family:\s*([^;]+);/.exec(app);
  ok(root && root[1].startsWith('"Inter", "Segoe UI Variable Text"'), `the root stack starts with Inter and keeps the native one: ${root && root[1]}`);
  for (const lang of ['zh-Hans', 'ja']) {
    const m = new RegExp(`:root:lang\\(${lang}\\)[^{]*\\{ font-family: ([^;]+);`).exec(app);
    ok(m && m[1].startsWith('"Inter", ') && /"(Yu Gothic UI|Microsoft YaHei UI)"/.test(m[1]) && /"(Hiragino Sans|PingFang SC)"/.test(m[1]) && /"Noto Sans CJK (JP|SC)"/.test(m[1]), `${lang}: Inter first, the system CJK fonts as the fallback of each platform: ${m && m[1]}`);
  }
  ok(!/@font-face/.test(app), 'the rules live in public/fonts/fonts.css, not in the budgeted App.css');
  ok(/Consolas, Menlo/.test(app), 'the mono stack is as it was');
  ok(!/Inter/.test(read('src/mailFrameCss.ts')), 'the message frame keeps its own font');
}

// ---- 2. served + in the page -----------------------------------------------------------------------------------------------------------------------
const H = await startHarness('test-font-bundle', { vitePort0: 5500 });
const { evaluate } = H;
try {
  for (const f of ['inter-latin.woff2', 'inter-vietnamese.woff2', 'inter-cyrillic.woff2', 'fonts.css', 'OFL.txt']) {
    const r = await fetch(new URL(`fonts/${f}`, H.base));
    ok(r.status === 200, `${f}: HTTP ${r.status}`);
    const type = r.headers.get('content-type') || '';
    if (f.endsWith('.woff2')) {
      ok(/font\/woff2|application\/font-woff2|application\/octet-stream/.test(type), `${f}: MIME ${type}`);
      const b = Buffer.from(await r.arrayBuffer());
      ok(b.subarray(0, 4).toString('latin1') === 'wOF2', `${f}: served as woff2`);
    } else if (f.endsWith('.css')) ok(/text\/css/.test(type), `${f}: MIME ${type}`);
  }
  for (const lang of ['en', 'ru', 'vi']) {
    await H.openApp(`lang=${lang}`, 1280, 800);
    await evaluate(`window.__mockAddThread('fb1', 'Font check', {}); window.__store.getState().refresh().then(() => 1)`);
    await sleep(500);
    await evaluate(`document.querySelector('.ml-row')?.click(); 1`);
    await sleep(800);
    const r = JSON.parse(await evaluate(`(async () => {
      const sample = { en: 'Hello, world', ru: 'Привет, мир', vi: 'Xin chào, thế giới' }[${JSON.stringify(lang)}];
      const faces = [...document.fonts].filter((f) => f.family.replace(/"/g, '') === 'Inter');
      const chrome = document.querySelector('.ml-row') || document.body;
      const frame = document.querySelector('.rp-msg.open iframe.msg-frame');
      const frameFont = frame && frame.contentDocument ? getComputedStyle(frame.contentDocument.body).fontFamily : null;
      return JSON.stringify({
        status: document.fonts.status, faces: faces.length, loaded: faces.filter((f) => f.status === 'loaded').length, loadedRanges: faces.filter((f) => f.status === 'loaded').map((f) => f.unicodeRange),
        checkLatin: document.fonts.check('14px Inter', 'Hello'), checkSample: document.fonts.check('14px Inter', sample), checkBold: document.fonts.check('700 14px Inter', 'Hello'),
        chrome: getComputedStyle(chrome).fontFamily, root: getComputedStyle(document.documentElement).fontFamily, button: getComputedStyle(document.querySelector('button')).fontFamily,
        input: getComputedStyle(document.querySelector('input')).fontFamily, frameFont,
        entries: performance.getEntriesByType('resource').filter((e) => /inter-.*woff2/.test(e.name)).map((e) => e.name.split('/').pop()),
      });
    })()`));
    ok(r.status === 'loaded', `${lang}: document.fonts.status is loaded when the mail UI is on screen (${r.status})`);
    ok(r.faces === 3 && r.loaded >= 1, `${lang}: three Inter faces known, at least the Latin one loaded (${r.loaded}/${r.faces})`);
    ok(r.checkLatin && r.checkSample && r.checkBold, `${lang}: 14px Inter is available for the text (and at weight 700)`);
    ok(r.entries.includes('inter-latin.woff2'), `${lang}: the Latin file was fetched (${r.entries})`);
    if (lang === 'ru') ok(r.loadedRanges.some((u) => /U\+0?400/i.test(u)), 'ru: the Cyrillic file loaded for the text that needs it');
    if (lang === 'vi') ok(r.loadedRanges.some((u) => /U\+1ea0/i.test(u)), 'vi: the Vietnamese file loaded for the text that needs it');
    for (const k of ['chrome', 'root', 'button', 'input']) ok(/^"?Inter"?,/.test(r[k]), `${lang}: ${k} is computed as Inter (${r[k].slice(0, 40)})`);
    if (r.frameFont != null) ok(!/Inter/.test(r.frameFont), `${lang}: the body of the message keeps its own font (${r.frameFont})`);
  }
  // the editor's body is the person's choice of font (Calibri by default), not the interface font
  await H.openApp('lang=en', 1280, 800);
  await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: [], subject: 'F', bodyHtml: '<p>x</p>' }); 1`);
  for (let i = 0; i < 100 && !(await evaluate(`!!document.querySelector('.cp-editor .tiptap')`)); i++) await sleep(100);
  const ed = JSON.parse(await evaluate(`JSON.stringify({ body: getComputedStyle(document.querySelector('.cp-editor .tiptap')).fontFamily, ui: getComputedStyle(document.querySelector('.fmt-tb button')).fontFamily })`));
  ok(!/Inter/.test(ed.body), `the editor body keeps its own font (${ed.body})`);
  ok(/^"?Inter"?,/.test(ed.ui), `the composer's controls are Inter (${ed.ui.slice(0, 30)})`);
} finally {
  await H.shutdown();
}
console.log(`test-font-bundle: ok (${checks} checks)`);
process.exit(0);
