#!/usr/bin/env node
// Sentences the website must not say any more, checked against every page of docs/ (no browser, no dependencies). Run:  node scripts/test-site-statements.mjs
//
// Each entry is a sentence (or clause) that an owner or release decision removed or replaced, in one language, copied from the page before the
// change: the statement about mobile apps, "more languages / a theme editor may come", "the translations are new and may contain mistakes", the old
// update-behaviour and update-check wording, the old app labels. The test reads the visible text of every page of that language (tags dropped,
// entities decoded, a no-break space is a space, whitespace collapsed) and fails when the sentence is back, in one language or in all of them.
// An entry may name the pages it is checked in (a clause such as "after a couple of hours" is still true on a page that has not been changed yet).
// A later work package that removes more statements (CalDAV "may come", "Search covers downloaded mail only", ...) adds its sentences to REMOVED.
import fs from 'node:fs';
import path from 'node:path';
import { LANGS, PAGES, DOCS } from './generate-site-languages.mjs';

const ENT = { nbsp: ' ', amp: '&', quot: '"', lt: '<', gt: '>', rsquo: '\u2019', lsquo: '\u2018', ldquo: '\u201c', rdquo: '\u201d', hellip: '\u2026', copy: '\u00a9', bdquo: '\u201e', mdash: '\u2014', ndash: '\u2013' };
export const plain = (src) => src
  .replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1>/g, '').replace(/<[^>]*>/g, '')
  .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENT[e.toLowerCase()] ?? m)))
  .replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();

// [language folder code, plain text that must not be on the page, optional list of pages (default: every page of that language)]
const REMOVED = [
  // W10.13: no statement about mobile apps (owner decision)
  {
    row: 'W10.13',
    items: [
      ['en', 'No mobile apps. Desktop only.'],
      ['vi', 'Không có ứng dụng di động. Chỉ dành cho máy tính.'],
      ['fr', 'Pas d’applications mobiles. Uniquement pour ordinateur.'],
      ['zh', '没有移动端应用。仅限桌面。'],
      ['es', 'Sin aplicaciones móviles. Solo escritorio.'],
      ['ja', 'モバイルアプリはありません。デスクトップ専用です。'],
      ['de', 'Keine Mobil-Apps. Nur Desktop.'],
      ['ru', 'Мобильных приложений нет. Только для компьютера.'],
    ],
  },
  // W10.14: no promise of more languages or of a theme editor (owner decision)
  {
    row: 'W10.14',
    items: [
      ['en', 'More languages than these eight may come in a later update.'],
      ['en', 'No full theme editor'],
      ['en', 'There is no full theme editor.'],
      ['vi', 'Nhiều ngôn ngữ hơn tám ngôn ngữ này có thể có trong một bản cập nhật sau này.'],
      ['vi', 'Không có trình chỉnh sửa giao diện đầy đủ'],
      ['vi', 'Không có trình chỉnh sửa giao diện đầy đủ.'],
      ['fr', 'D’autres langues que ces huit pourraient arriver dans une prochaine mise à jour.'],
      ['fr', 'Pas d’éditeur de thème complet'],
      ['fr', 'Il n’y a pas d’éditeur de thème complet.'],
      ['zh', '除这八种语言之外的更多语言，可能会在以后的更新中提供。'],
      ['zh', '没有完整的主题编辑器'],
      ['zh', '没有完整的主题编辑器。'],
      ['es', 'Más idiomas además de estos ocho podrían llegar en una actualización posterior.'],
      ['es', 'Sin un editor de temas completo'],
      ['es', 'No hay un editor de temas completo.'],
      ['ja', 'この8言語以外の言語は、今後のアップデートで追加される可能性があります。'],
      ['ja', '完全なテーマエディターはありません'],
      ['ja', '完全なテーマエディターはありません。'],
      ['de', 'Weitere Sprachen als diese acht kommen möglicherweise mit einem späteren Update.'],
      ['de', 'Kein vollständiger Design-Editor'],
      ['de', 'Einen vollständigen Design-Editor gibt es nicht.'],
      ['ru', 'Другие языки, кроме этих восьми, возможно, появятся в одном из следующих обновлений.'],
      ['ru', 'Полноценного редактора тем нет'],
      ['ru', 'Полноценного редактора тем нет.'],
    ],
  },
  // W10.6a: the translations were written with AI help and checked by language specialists; no "new / may contain mistakes" and no "more languages may come"
  {
    row: 'W10.6a',
    items: [
      ['en', 'The translations are new and may contain mistakes'],
      ['en', 'more languages may come in a later update', ['features.html']],
      ['en', 'more languages may come in a later update', ['help.html']],
      ['en', 'The translated texts are new and may contain mistakes'],
      ['vi', 'Các bản dịch còn mới và có thể có lỗi'],
      ['vi', 'có thể có thêm ngôn ngữ trong một bản cập nhật sau này', ['features.html']],
      ['vi', 'có thể có thêm ngôn ngữ trong một bản cập nhật sau này', ['help.html']],
      ['fr', 'Les traductions sont récentes et peuvent contenir des erreurs'],
      ['fr', 'd’autres langues pourraient arriver dans une prochaine mise à jour', ['features.html']],
      ['fr', 'd’autres langues pourraient arriver dans une prochaine mise à jour', ['help.html']],
      ['fr', 'Les textes traduits sont récents et peuvent contenir des erreurs'],
      ['zh', '译文是新的，可能有错误'],
      ['zh', '更多语言可能会在以后的更新中提供', ['features.html']],
      ['zh', '更多语言可能会在以后的更新中提供', ['help.html']],
      ['es', 'Las traducciones son nuevas y pueden contener errores'],
      ['es', 'podrían llegar más idiomas en una actualización posterior', ['features.html']],
      ['es', 'podrían llegar más idiomas en una actualización posterior', ['help.html']],
      ['es', 'Los textos traducidos son nuevos y pueden contener errores'],
      ['ja', '翻訳はまだ新しく、誤りが含まれる可能性があります'],
      ['ja', '今後のアップデートで言語が増える可能性があります', ['features.html']],
      ['ja', '今後のアップデートで対応言語が増える可能性があります', ['help.html']],
      ['ja', '翻訳は導入されたばかりで、誤りが含まれている可能性があります'],
      ['de', 'Die Übersetzungen sind neu und können Fehler enthalten'],
      ['de', 'weitere Sprachen kommen möglicherweise mit einem späteren Update', ['features.html']],
      ['de', 'weitere Sprachen kommen möglicherweise mit einem späteren Update', ['help.html']],
      ['de', 'Die übersetzten Texte sind neu und können Fehler enthalten'],
      ['ru', 'Переводы новые и могут содержать ошибки'],
      ['ru', 'другие языки, возможно, появятся в одном из следующих обновлений', ['features.html']],
      ['ru', 'другие языки, возможно, появятся в одном из следующих обновлений', ['help.html']],
      ['ru', 'Переведённые тексты новые и могут содержать ошибки'],
    ],
  },
];

const errors = [];
const fail = (msg) => errors.push(msg);
const lang = (code) => LANGS.find((l) => l.code === code);
const pagesOf = (l, only) => (only || [...PAGES, ...(l.dir ? [] : ['404'])].map((p) => p + '.html')).map((f) => path.join(DOCS, l.dir, f));
const cache = new Map();
const textOf = (f) => { if (!cache.has(f)) cache.set(f, plain(fs.readFileSync(f, 'utf8'))); return cache.get(f); };

let checks = 0;
for (const { row, items } of REMOVED) {
  const langs = new Set(items.map((i) => i[0]));
  for (const code of langs) if (!lang(code)) fail(`${row}: unknown language ${code}`);
  for (const [code, text, only] of items) {
    const l = lang(code);
    if (!l) continue;
    if (text !== plain(text)) fail(`${row} ${code}: the entry "${text}" is not in plain form (no tags or entities, single spaces)`);
    for (const f of pagesOf(l, only)) {
      if (!fs.existsSync(f)) { fail(`${row} ${code}: ${path.relative(DOCS, f)} does not exist`); continue; }
      checks++;
      if (textOf(f).includes(text)) fail(`${path.relative(DOCS, f).replace(/\\/g, '/')}: says again "${text}" (removed by ${row})`);
    }
  }
}

// no list item or list is left empty by a removal: the honest ledger of the home page (Partial / Not yet), in every language
for (const l of LANGS) {
  const f = path.join(DOCS, l.dir, 'index.html');
  const ledger = (/<section class="ledger"[\s\S]*?<\/section>/.exec(fs.readFileSync(f, 'utf8')) || [''])[0];
  if (!ledger) fail(`${path.relative(DOCS, f).replace(/\\/g, '/')}: the honest ledger section is missing`);
  else if (/<li\b[^>]*>\s*<\/li>/.test(ledger) || /<ul\b[^>]*>\s*<\/ul>/.test(ledger) || (ledger.match(/<li\b/g) || []).length < 4) fail(`${path.relative(DOCS, f).replace(/\\/g, '/')}: an empty bullet or an empty column in the honest ledger`);
}
// the README and the 1.0.7 section of the CHANGELOG say nothing about mobile apps either (owner decision: no statement, not even "no mobile apps")
{
  const root = path.join(DOCS, '..');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const log = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const sect = (/^## 1\.0\.7\b[\s\S]*?(?=^## |(?![\s\S]))/m.exec(log) || [''])[0];
  for (const [name, text] of [['README.md', readme], ['CHANGELOG.md (1.0.7)', sect]]) if (/\bmobile (apps?|clients?|versions?)\b|\bphone apps?\b|\bsmartphones?\b/i.test(text)) fail(`${name}: says something about mobile apps`);
}

if (errors.length) { console.error(errors.map((e) => 'FAIL ' + e).join('\n')); process.exit(1); }
console.log(`ok - test-site-statements (${REMOVED.reduce((n, r) => n + r.items.length, 0)} removed sentences in ${REMOVED.length} rows, ${checks} page checks, ${LANGS.length} languages)`);
