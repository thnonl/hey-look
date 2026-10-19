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
import { fileURLToPath } from 'node:url';
import { LANGS, PAGES, DOCS } from './generate-site-languages.mjs';

const ENT = { nbsp: ' ', amp: '&', quot: '"', lt: '<', gt: '>', rsquo: '\u2019', lsquo: '\u2018', ldquo: '\u201c', rdquo: '\u201d', hellip: '\u2026', copy: '\u00a9', bdquo: '\u201e', mdash: '\u2014', ndash: '\u2013' };
export const plain = (src) => src
  .replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1>/g, '').replace(/<[^>]*>/g, '')
  .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENT[e.toLowerCase()] ?? m)))
  .replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();

// [language folder code, plain text that must not be on the page, optional list of pages (default: every page of that language)]
export const REMOVED = [
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
  // W10.1a: update behaviour: every system asks first, then only the .msi (administrator rights) and the .deb / .rpm (password) ask again
  {
    row: 'W10.1a',
    items: [
      ['en', 'Installs by itself on Windows; macOS and Linux need permission'],
      ['en', 'Updates: full on Windows; macOS and Linux need your permission'],
      ['vi', 'Windows tự cài đặt; macOS và Linux cần được cho phép'],
      ['vi', 'Cập nhật: đầy đủ trên Windows; macOS và Linux cần được bạn cho phép'],
      ['fr', 'Installation automatique sous Windows ; autorisation requise sous macOS et Linux'],
      ['fr', 'Mises à jour : complètes sous Windows ; macOS et Linux demandent votre autorisation'],
      ['zh', 'Windows上自动安装；macOS和Linux需要您的许可'],
      ['zh', '更新：Windows上可完整自动更新；macOS和Linux需要您的许可'],
      ['es', 'Se instala sola en Windows; macOS y Linux necesitan permiso'],
      ['es', 'Actualizaciones: completas en Windows; macOS y Linux necesitan tu permiso'],
      ['ja', 'Windowsは自動でインストール、macOSとLinuxは許可が必要'],
      ['ja', 'アップデート：Windowsでは自動でインストール、macOSとLinuxでは許可が必要です'],
      ['de', 'Unter Windows automatische Installation; macOS und Linux brauchen Ihre Erlaubnis'],
      ['de', 'Updates: vollständig unter Windows; unter macOS und Linux ist Ihre Erlaubnis nötig'],
      ['ru', 'В Windows устанавливается само; в macOS и Linux нужно разрешение'],
      ['ru', 'Обновления: в Windows работают полностью; в macOS и Linux нужно ваше разрешение'],
      ['en', 'On Windows it installs by itself; on macOS and Linux it needs your permission.', ['index.html']],
      ['vi', 'Trên Windows, bản cập nhật tự cài đặt; macOS và Linux cần được bạn cho phép.', ['index.html']],
      ['fr', 'Sous Windows, la mise à jour s’installe toute seule ; sous macOS et Linux, une autorisation est nécessaire.', ['index.html']],
      ['zh', 'Windows上会自动安装；macOS和Linux需要您的许可。', ['index.html']],
      ['es', 'En Windows la actualización se instala sola; macOS y Linux necesitan permiso.', ['index.html']],
      ['ja', 'Windowsでは自動でインストールされ、macOSとLinuxでは許可が必要です。', ['index.html']],
      ['de', 'Unter Windows installiert sich das Update von selbst; unter macOS und Linux ist Ihre Erlaubnis nötig.', ['index.html']],
      ['ru', 'В Windows обновление устанавливается само; в macOS и Linux нужно разрешение.', ['index.html']],
    ],
  },
  // W10.2a: update-check timing: at most every 2 hours, 15 minutes after a failure; no "a couple of hours"
  {
    row: 'W10.2a',
    items: [
      ['en', 'after a couple of hours', ['help.html']],
      ['vi', 'sau vài giờ', ['help.html']],
      ['fr', 'après quelques heures', ['help.html']],
      ['zh', '隔了几个小时重新回来时', ['help.html']],
      ['es', 'tras un par de horas', ['help.html']],
      ['ja', '数時間ぶりに前面に戻ったとき', ['help.html']],
      ['de', 'nach ein paar Stunden zurückkehrt', ['help.html']],
      ['ru', 'спустя пару часов', ['help.html']],
    ],
  },
  // W10.7a: app labels quoted on the help page, and the Vietnamese fragments
  {
    row: 'W10.7a',
    items: [
      ['en', '(Other email account, provider Gmail)', ['help.html']],
      ['en', 'Settings > Add account > Other email account', ['help.html']],
      ['vi', '(Tài khoản email khác, nhà cung cấp Gmail)', ['help.html']],
      ['vi', 'Cài đặt > Thêm tài khoản > Tài khoản email khác', ['help.html']],
      ['vi', 'Chủ nhật hoặc thứ Bảy', ['features.html']],
      ['vi', 'Open Hey Look!'],
      ['fr', '(Autre compte e-mail, fournisseur Gmail)', ['help.html']],
      ['fr', 'Paramètres > Ajouter un compte > Autre compte e-mail', ['help.html']],
      ['zh', '（其他电子邮件账户，服务商选Gmail）', ['help.html']],
      ['zh', '设置 > 添加账户 > 其他电子邮件账户', ['help.html']],
      ['es', '(Otra cuenta de correo, proveedor Gmail)', ['help.html']],
      ['es', 'Configuración > Añadir cuenta > Otra cuenta de correo', ['help.html']],
      ['ja', '（その他のメールアカウントでプロバイダーにGmailを選択）', ['help.html']],
      ['ja', 'その他のメールアカウント', ['help.html']],
      ['de', '(Anderes E-Mail-Konto, Anbieter Gmail)', ['help.html']],
      ['de', 'Einstellungen > Konto hinzufügen > Anderes E-Mail-Konto', ['help.html']],
    ],
  },
  // W10.3: L2: the stray Gmail callout on the Google API data use page
  {
    row: 'W10.3',
    items: [
      ['en', 'Sign in to Gmail quickly with your Google account.', ['google-data.html']],
      ['vi', 'Đăng nhập Gmail nhanh chóng bằng tài khoản Google của bạn.', ['google-data.html']],
      ['fr', 'Connectez-vous rapidement à Gmail avec votre compte Google.', ['google-data.html']],
      ['zh', '用您的Google账户快速登录Gmail。', ['google-data.html']],
      ['es', 'Inicia sesión en Gmail rápidamente con tu cuenta de Google.', ['google-data.html']],
      ['ja', 'Googleアカウントで、Gmailにすばやくサインインできます。', ['google-data.html']],
      ['de', 'Melden Sie sich mit Ihrem Google-Konto schnell bei Gmail an.', ['google-data.html']],
      ['ru', 'Быстро войдите в Gmail с помощью своей учётной записи Google.', ['google-data.html']],
    ],
  },
  // W10.1b: L3: security.html update sentence
  {
    row: 'W10.1b',
    items: [
      ['en', 'On Windows the update installs by itself; macOS and Linux need your permission.', ['security.html']],
      ['vi', 'Trên Windows, bản cập nhật tự cài đặt; macOS và Linux cần được bạn cho phép.', ['security.html']],
      ['fr', 'Sous Windows, la mise à jour s’installe toute seule ; macOS et Linux demandent votre autorisation.', ['security.html']],
      ['zh', 'Windows上会自动安装更新；macOS和Linux需要您的许可。', ['security.html']],
      ['es', 'En Windows la actualización se instala sola; macOS y Linux necesitan tu permiso.', ['security.html']],
      ['ja', 'Windowsではアップデートが自動でインストールされ、macOSとLinuxではユーザーの許可が必要です。', ['security.html']],
      ['de', 'Unter Windows installiert sich das Update von selbst; macOS und Linux brauchen Ihre Erlaubnis.', ['security.html']],
      ['ru', 'В Windows обновление устанавливается само; в macOS и Linux нужно ваше разрешение.', ['security.html']],
    ],
  },
  // W10.2c: L10: privacy.html github.com row, update-check timing
  {
    row: 'W10.2c',
    items: [
      ['en', 'when the window comes back after a couple of hours', ['privacy.html']],
      ['vi', 'khi cửa sổ quay lại sau vài giờ', ['privacy.html']],
      ['fr', 'quand la fenêtre revient après quelques heures', ['privacy.html']],
      ['zh', '窗口隔了几个小时重新回来时', ['privacy.html']],
      ['es', 'cuando vuelves a la ventana tras un par de horas', ['privacy.html']],
      ['ja', '数時間ぶりにウィンドウに戻ったとき', ['privacy.html']],
      ['de', 'wenn das Fenster nach ein paar Stunden zurückkehrt', ['privacy.html']],
      ['ru', 'при возвращении окна спустя пару часов', ['privacy.html']],
    ],
  },
  // W10.17: the Support page offers no bank transfer any more (owner decision 2026-10-19): the old bank card heading and the old thank-you letter that named it
  {
    row: 'W10.17',
    items: [
      ['en', 'Bank transfer (VietQR)', ['support.html']],
      ['vi', 'Chuyển khoản ngân hàng (VietQR)', ['support.html']],
      ['fr', 'Virement bancaire (VietQR)', ['support.html']],
      ['zh', '银行转账（VietQR）', ['support.html']],
      ['es', 'Transferencia bancaria (VietQR)', ['support.html']],
      ['ja', '銀行振込（VietQR）', ['support.html']],
      ['de', 'Banküberweisung (VietQR)', ['support.html']],
      ['ru', 'Банковский перевод (VietQR)', ['support.html']],
      ['en', 'Hey Look! is free and open source, and it will stay that way. If it saves you time, you can help with its upkeep, with a coffee through Ko-fi or by bank transfer. It is entirely optional and unlocks nothing. Thank you for using it.', ['support.html']],
      ['vi', 'Hey Look! miễn phí và mã nguồn mở, và sẽ luôn như vậy. Nếu ứng dụng giúp bạn tiết kiệm thời gian, bạn có thể góp phần duy trì nó, bằng một ly cà phê qua Ko-fi hoặc chuyển khoản ngân hàng. Việc này hoàn toàn tùy chọn và không mở khóa thêm gì. Cảm ơn bạn đã dùng Hey Look!', ['support.html']],
      ['fr', 'Hey Look! est gratuit et open source, et le restera. S’il vous fait gagner du temps, vous pouvez contribuer à sa maintenance, avec un café via Ko-fi ou par virement bancaire. C’est entièrement facultatif et ne débloque rien. Merci de l’utiliser.', ['support.html']],
      ['zh', 'Hey Look!免费且开源，并且会一直如此。如果它帮您省下了时间，您可以通过Ko-fi请我喝杯咖啡，或通过银行转账，帮忙维持它的日常运转。这完全出于自愿，也不会解锁任何功能。感谢您使用它。', ['support.html']],
      ['es', 'Hey Look! es gratis y de código abierto, y seguirá siéndolo. Si te ahorra tiempo, puedes ayudar a mantenerlo, con un café a través de Ko-fi o con una transferencia bancaria. Es totalmente opcional y no desbloquea nada. Gracias por usarlo.', ['support.html']],
      ['ja', 'Hey Look!は無料のオープンソースで、これからもそうあり続けます。時間の節約に役立っているなら、Ko-fiでコーヒー1杯分を贈るか銀行振込で、プロジェクトの維持を支援していただけます。支援はあくまで任意で、支援によって使える機能が増えることもありません。ご利用いただき、ありがとうございます。', ['support.html']],
      ['de', 'Hey Look! ist kostenlos und Open Source, und das wird so bleiben. Wenn es Ihnen Zeit spart, können Sie zu seiner Pflege beitragen, mit einem Kaffee über Ko-fi oder per Banküberweisung. Das ist völlig freiwillig und schaltet nichts frei. Danke, dass Sie es nutzen.', ['support.html']],
      ['ru', 'Hey Look! бесплатный и с открытым исходным кодом, и так останется. Если он экономит вам время, вы можете помочь с его поддержкой: чашкой кофе через Ko-fi или банковским переводом. Это совершенно необязательно и ничего не открывает. Спасибо, что пользуетесь им.', ['support.html']],
    ],
  },
  // W10.19: the privacy policy no longer says that the Support page shows a bank-transfer QR image (the image is gone; owner approved 2026-10-19)
  {
    row: 'W10.19',
    items: [
      ['en', 'The page also shows a bank-transfer QR image, which is a file on this site.', ['privacy.html']],
      ['vi', 'Trang này cũng hiển thị một ảnh mã QR chuyển khoản ngân hàng, vốn là một tệp trên trang web này.', ['privacy.html']],
      ['fr', 'La page affiche aussi une image QR de virement bancaire, qui est un fichier de ce site.', ['privacy.html']],
      ['zh', '该页面还显示一张银行转账二维码图片，它是本网站上的一个文件。', ['privacy.html']],
      ['es', 'La página también muestra una imagen QR de transferencia bancaria, que es un archivo de este sitio.', ['privacy.html']],
      ['ja', '支援ページには銀行振込用のQRコード画像も表示されますが、これはこのサイト上にあるファイルです。', ['privacy.html']],
      ['de', 'Die Seite zeigt außerdem ein QR-Bild für die Banküberweisung, das eine Datei auf dieser Website ist.', ['privacy.html']],
      ['ru', 'На странице также показано изображение QR-кода для банковского перевода — это файл на этом сайте.', ['privacy.html']],
    ],
  },
];

const lang = (code) => LANGS.find((l) => l.code === code);
const pagesOf = (l, only) => (only || [...PAGES, ...(l.dir ? [] : ['404'])].map((p) => p + '.html')).map((f) => path.join(DOCS, l.dir, f));

// The English app path written again, in parentheses, after the translated path ("Настройки > Почтовые ящики (Settings > Mailboxes)") is an English leftover (QA 1.0.7, AC-10.7a.1).
// A path that opens with the English word "Settings" has no place on a page of another language: the translated pages name the screens with the app's own labels of that language.
// The macOS "System Settings" (its own English name, followed by the local one) is the operating system's path, not the app's.
export const englishPathProblems = (html) => [...html.matchAll(/(?<!System )\bSettings\s*(?:&gt;|>)[^<]{0,50}/g)].map((m) => m[0]);

// Returns the list of problems. rows = the REMOVED rows to check (all by default); read(file) = the HTML of a page (the file by default; the mutation test hands in a page with a sentence put back).
export function findProblems({ rows = REMOVED, read = (f) => fs.readFileSync(f, 'utf8'), whole = true } = {}) {
  const errors = [];
  const fail = (msg) => errors.push(msg);
  const cache = new Map();
  const textOf = (f) => { if (!cache.has(f)) cache.set(f, plain(read(f))); return cache.get(f); };
  let checks = 0;
  for (const { row, items } of rows) {
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
  if (!whole) return { errors, checks };

  // no English "Settings > ..." path on a page of another language, in or out of parentheses (the help page, security, features, privacy, terms ... every page)
  for (const l of LANGS) {
    if (!l.dir) continue;
    for (const p of PAGES) {
      const f = path.join(DOCS, l.dir, p + '.html');
      for (const m of englishPathProblems(read(f))) fail(`${l.dir}/${p}.html: an English app path on a translated page: "${m.slice(0, 90)}"`);
      checks++;
    }
  }
  // no list item or list is left empty by a removal: the honest ledger of the home page (Partial / Not yet), in every language
  for (const l of LANGS) {
    const f = path.join(DOCS, l.dir, 'index.html');
    const ledger = (/<section class="ledger"[\s\S]*?<\/section>/.exec(read(f)) || [''])[0];
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
  return { errors, checks };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { errors, checks } = findProblems();
  if (errors.length) { console.error(errors.map((e) => 'FAIL ' + e).join('\n')); process.exit(1); }
  console.log(`ok - test-site-statements (${REMOVED.reduce((n, r) => n + r.items.length, 0)} removed sentences in ${REMOVED.length} rows, ${checks} page checks, ${LANGS.length} languages)`);
}
