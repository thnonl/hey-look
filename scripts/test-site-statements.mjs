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
  // W10.16 (WP10c, 1.0.7): statements that were true for 1.0.6 and are not true for 1.0.7 (the features Limits, the home ledger, the help pages):
  // Push covers only the Inbox, "macOS has no Print", "On Linux notifications have no buttons", PDF only on Windows, "Search covers downloaded mail only",
  // missing standard folders are not created, calendar sync "not CalDAV", one occurrence of a repeating event cannot be edited
  {
    row: 'W10.16',
    items: [
      ['en', 'Optional, per mailbox: your Google or Outlook calendars appear next to the local one, and changes go both ways.', ['features.html']],
      ['en', 'macOS has no Print.', ['features.html']],
      ['en', 'On Linux, notifications have no buttons, passwords need an unlocked keyring, and a Confidential message is not hidden from screen capture.', ['features.html']],
      ['en', 'Shown inside the app on Windows only;', ['features.html']],
      ['en', 'elsewhere they open in your default app.', ['features.html']],
      ['en', 'Push covers only the Inbox;', ['features.html']],
      ['en', 'Search covers downloaded mail only.', ['index.html', 'features.html']],
      ['en', 'Missing standard folders, such as Drafts, are not created.', ['features.html']],
      ['en', 'Sync covers Google and Microsoft only, not CalDAV.', ['features.html']],
      ['en', 'One occurrence of a repeating event cannot be edited.', ['features.html']],
      ['en', 'Calendar sync: Google and Microsoft only', ['index.html']],
      ['en', 'Syncing with a Google or Microsoft calendar is optional, per mailbox.', ['index.html']],
      ['en', 'Yes, for the Inbox, on servers that support push (IMAP IDLE), while Hey Look!', ['help.html']],
      ['en', 'Only what you use: your mail servers, Google or Microsoft sign-in and calendar, the server lookup when you add an account, GitHub for updates, your AI endpoint, images you allow and unsubscribe requests.', ['help.html']],
      ['vi', 'Tùy chọn, đặt riêng cho từng hộp thư: lịch Google hoặc Outlook của bạn hiện cạnh lịch trên máy, và thay đổi đi cả hai chiều.', ['features.html']],
      ['vi', 'macOS không có mục In.', ['features.html']],
      ['vi', 'Trên Linux, thông báo không có nút, mật khẩu cần keyring đã mở khóa, và thư mật không được ẩn khỏi việc chụp màn hình.', ['features.html']],
      ['vi', 'Chỉ hiển thị ngay trong ứng dụng trên Windows;', ['features.html']],
      ['vi', 'ở nơi khác chúng mở bằng ứng dụng mặc định của bạn.', ['features.html']],
      ['vi', 'Push chỉ áp dụng cho Hộp thư đến;', ['features.html']],
      ['vi', 'Tìm kiếm chỉ trong thư đã tải xuống.', ['index.html', 'features.html']],
      ['vi', 'Các thư mục chuẩn còn thiếu, như Thư nháp, sẽ không được tạo.', ['features.html']],
      ['vi', 'Đồng bộ chỉ hỗ trợ Google và Microsoft, không hỗ trợ CalDAV.', ['features.html']],
      ['vi', 'Không thể sửa riêng một lần xuất hiện của sự kiện lặp lại.', ['features.html']],
      ['vi', 'Lịch: chỉ đồng bộ với Google và Microsoft', ['index.html']],
      ['vi', 'Đồng bộ với lịch Google hoặc Microsoft là tùy chọn, đặt riêng cho từng hộp thư.', ['index.html']],
      ['vi', 'Có, với Hộp thư đến, trên máy chủ hỗ trợ push (IMAP IDLE), miễn là Hey Look!', ['help.html']],
      ['vi', 'Chỉ những gì bạn dùng: máy chủ thư của bạn, đăng nhập và lịch của Google hoặc Microsoft, việc dò máy chủ khi bạn thêm tài khoản, GitHub để cập nhật, điểm cuối AI của bạn, ảnh bạn cho phép tải và yêu cầu hủy đăng ký.', ['help.html']],
      ['fr', 'Facultative, boîte aux lettres par boîte aux lettres : vos calendriers Google ou Outlook s’affichent à côté du calendrier local, et les modifications vont dans les deux sens.', ['features.html']],
      ['fr', 'macOS n’a pas de menu Imprimer.', ['features.html']],
      ['fr', 'Sous Linux, les notifications n’ont pas de boutons, les mots de passe nécessitent un trousseau de clés déverrouillé, et un message Confidentiel n’est pas masqué de la capture d’écran.', ['features.html']],
      ['fr', 'Affichées dans l’application sous Windows uniquement ;', ['features.html']],
      ['fr', 'ailleurs, elles s’ouvrent dans votre application par défaut.', ['features.html']],
      ['fr', 'Le push ne couvre que la boîte de réception ;', ['features.html']],
      ['fr', 'La recherche ne couvre que le courrier téléchargé.', ['index.html', 'features.html']],
      ['fr', 'Les dossiers standard manquants, comme Brouillons, ne sont pas créés.', ['features.html']],
      ['fr', 'La synchronisation ne couvre que Google et Microsoft, pas CalDAV.', ['features.html']],
      ['fr', 'Une occurrence unique d’un événement récurrent ne peut pas être modifiée.', ['features.html']],
      ['fr', 'Synchronisation du calendrier : Google et Microsoft uniquement', ['index.html']],
      ['fr', 'La synchronisation avec un calendrier Google ou Microsoft est facultative, boîte aux lettres par boîte aux lettres.', ['index.html']],
      ['fr', 'Oui, pour la boîte de réception, sur les serveurs qui prennent en charge le push (IMAP IDLE), tant que Hey Look!', ['help.html']],
      ['fr', 'Seulement ce que vous utilisez : vos serveurs de messagerie, la connexion et le calendrier Google ou Microsoft, la recherche de serveur quand vous ajoutez un compte, GitHub pour les mises à jour, votre point de terminaison IA, les images que vous autorisez et les demandes de désabonnement.', ['help.html']],
      ['zh', '可选，按邮箱设置：您的Google或Outlook日历会显示在本地日历旁边，两边的更改互相同步。', ['features.html']],
      ['zh', 'macOS没有“打印”菜单。', ['features.html']],
      ['zh', '在Linux上，通知没有按钮，保存密码需要已解锁的密钥环，“机密”邮件也不会对屏幕截图隐藏。', ['features.html']],
      ['zh', '只有在Windows上才在应用内显示；', ['features.html']],
      ['zh', '其他系统用您的默认应用打开。', ['features.html']],
      ['zh', '缺少的标准文件夹（例如草稿）不会被创建。', ['features.html']],
      ['zh', '同步只支持Google和Microsoft，不支持CalDAV。', ['features.html']],
      ['zh', '无法编辑重复事件中单独的某一次。', ['features.html']],
      ['zh', '日历同步：仅限Google和Microsoft', ['index.html']],
      ['zh', '与Google或Microsoft日历同步是可选的，按邮箱分别设置。', ['index.html']],
      ['zh', '正在运行，收件箱的新邮件就会立即送达。', ['help.html']],
      ['zh', '只有您用到的部分：您的邮件服务器、Google或Microsoft的登录和日历、添加账户时的服务器查询、用于更新的GitHub、您的AI端点、您允许加载的图片，以及取消订阅请求。', ['help.html']],
      ['es', 'Opcional, por buzón: tus calendarios de Google u Outlook aparecen junto al local, y los cambios van en ambos sentidos.', ['features.html']],
      ['es', 'macOS no tiene Imprimir.', ['features.html']],
      ['es', 'En Linux, las notificaciones no tienen botones, las contraseñas necesitan un llavero desbloqueado y un mensaje Confidencial no se oculta de la captura de pantalla.', ['features.html']],
      ['es', 'Se muestran dentro de la aplicación solo en Windows;', ['features.html']],
      ['es', 'en los demás sistemas se abren en tu aplicación predeterminada.', ['features.html']],
      ['es', 'El push cubre solo la bandeja de entrada;', ['features.html']],
      ['es', 'La búsqueda solo abarca el correo descargado.', ['index.html', 'features.html']],
      ['es', 'Las carpetas estándar que faltan, como Borradores, no se crean.', ['features.html']],
      ['es', 'La sincronización cubre solo Google y Microsoft, no CalDAV.', ['features.html']],
      ['es', 'Una sola repetición de un evento periódico no se puede editar.', ['features.html']],
      ['es', 'Calendario: sincronización solo con Google y Microsoft', ['index.html']],
      ['es', 'La sincronización con un calendario de Google o Microsoft es opcional, por buzón.', ['index.html']],
      ['es', 'Sí, el de la bandeja de entrada, en los servidores compatibles con push (IMAP IDLE), mientras Hey Look!', ['help.html']],
      ['es', 'Solo lo que usas: tus servidores de correo, el inicio de sesión y el calendario de Google o Microsoft, la búsqueda de servidores al añadir una cuenta, GitHub para las actualizaciones, tu punto de conexión de IA, las imágenes que permites y las solicitudes de cancelación de suscripción.', ['help.html']],
      ['ja', 'GoogleまたはOutlookのカレンダーがローカルのカレンダーの隣に表示され、変更は双方向に反映されます。', ['features.html']],
      ['ja', 'macOSでは「印刷」がありません。', ['features.html']],
      ['ja', 'Linuxでは、通知にボタンがなく、パスワードの保存にはロック解除されたキーリングが必要で、「機密」メッセージは画面キャプチャから隠されません。', ['features.html']],
      ['ja', 'アプリ内で表示できるのはWindowsだけです。', ['features.html']],
      ['ja', 'それ以外では既定のアプリで開きます。', ['features.html']],
      ['ja', 'プッシュの対象は受信トレイのみで、ほかのフォルダーは一定の間隔で確認されます。', ['features.html']],
      ['ja', '検索の対象はダウンロード済みのメールのみです。', ['features.html']],
      ['ja', '下書きなどの標準フォルダーが存在しない場合は、作成されません。', ['features.html']],
      ['ja', '同期の対象はGoogleとMicrosoftのみで、CalDAVには対応していません。', ['features.html']],
      ['ja', '繰り返しの予定の1回分だけを編集することはできません。', ['features.html']],
      ['ja', 'カレンダー同期：GoogleとMicrosoftのみ', ['index.html']],
      ['ja', '検索対象はダウンロード済みのメールのみです。', ['index.html']],
      ['ja', 'GoogleまたはMicrosoftのカレンダーとの同期は任意で、メールボックスごとに設定します。', ['index.html']],
      ['ja', 'が起動している間、受信トレイの新着メールがすぐに届きます。', ['help.html']],
      ['ja', '実際に使うものだけです：お使いのメールサーバー、GoogleまたはMicrosoftのサインインとカレンダー、アカウント追加時のサーバー検索、アップデート用のGitHub、AIエンドポイント、許可した画像、登録解除のリクエスト。', ['help.html']],
      ['de', 'Optional, je Postfach: Ihre Google- oder Outlook-Kalender erscheinen neben dem lokalen, und Änderungen gehen in beide Richtungen.', ['features.html']],
      ['de', 'macOS hat keinen Menüeintrag Drucken.', ['features.html']],
      ['de', 'Unter Linux haben Benachrichtigungen keine Schaltflächen, Passwörter brauchen einen entsperrten Schlüsselbund, und eine vertrauliche Nachricht ist nicht vor Bildschirmaufnahmen verborgen.', ['features.html']],
      ['de', 'Nur unter Windows in der App angezeigt;', ['features.html']],
      ['de', 'sonst öffnen sie sich in Ihrer Standard-App.', ['features.html']],
      ['de', 'Push gilt nur für den Posteingang;', ['features.html']],
      ['de', 'Die Suche umfasst nur heruntergeladene E-Mails.', ['index.html', 'features.html']],
      ['de', 'Fehlende Standardordner, etwa Entwürfe, werden nicht angelegt.', ['features.html']],
      ['de', 'Die Synchronisierung umfasst nur Google und Microsoft, nicht CalDAV.', ['features.html']],
      ['de', 'Ein einzelnes Vorkommen eines wiederkehrenden Termins lässt sich nicht bearbeiten.', ['features.html']],
      ['de', 'Kalendersynchronisierung: nur Google und Microsoft', ['index.html']],
      ['de', 'Die Synchronisierung mit einem Google- oder Microsoft-Kalender ist optional, je Postfach.', ['index.html']],
      ['de', 'Ja, für den Posteingang, auf Servern mit Push (IMAP IDLE), solange Hey Look!', ['help.html']],
      ['de', 'Nur das, was Sie nutzen: Ihre Mailserver, die Anmeldung und der Kalender von Google oder Microsoft, die Serversuche beim Hinzufügen eines Kontos, GitHub für Updates, Ihr KI-Endpunkt, Bilder, die Sie erlauben, und Abbestell-Anfragen.', ['help.html']],
      ['ru', 'Необязательна и включается для каждого ящика отдельно: календари Google или Outlook появляются рядом с локальным, изменения идут в обе стороны.', ['features.html']],
      ['ru', 'В macOS нет пункта «Печать».', ['features.html']],
      ['ru', 'В Linux у уведомлений нет кнопок, для паролей нужно разблокированное хранилище ключей, а письмо с пометкой «Конфиденциально» не скрыто от снимков экрана.', ['features.html']],
      ['ru', 'Показываются внутри приложения только в Windows;', ['features.html']],
      ['ru', 'в остальных системах открываются в приложении по умолчанию.', ['features.html']],
      ['ru', 'Push охватывает только «Входящие»;', ['features.html']],
      ['ru', 'Поиск работает только по загруженной почте.', ['index.html', 'features.html']],
      ['ru', 'Отсутствующие стандартные папки, например «Черновики», не создаются.', ['features.html']],
      ['ru', 'Синхронизация охватывает только Google и Microsoft, без CalDAV.', ['features.html']],
      ['ru', 'Отдельный экземпляр повторяющегося события редактировать нельзя.', ['features.html']],
      ['ru', 'Календарь: синхронизация только с Google и Microsoft', ['index.html']],
      ['ru', 'Синхронизация с календарём Google или Microsoft необязательна и включается отдельно для каждого ящика.', ['index.html']],
      ['ru', 'Да, для папки «Входящие», на серверах с поддержкой push (IMAP IDLE), пока Hey Look!', ['help.html']],
      ['ru', 'Только то, чем вы пользуетесь: ваши почтовые серверы, вход и календарь Google или Microsoft, поиск настроек сервера при добавлении учётной записи, GitHub для обновлений, ваша конечная точка ИИ, разрешённые вами изображения и запросы на отписку.', ['help.html']],
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
  // the Google sign-in has no number of people on any page (owner 2026-10-26: the text about a limit on people is gone from the whole product): no 100 within 80 characters of "Google", in any language, and nothing like it in the README or CONTRIBUTING
  for (const l of LANGS) {
    for (const p of PAGES) {
      const f = path.join(DOCS, l.dir || '', p + '.html');
      if (!fs.existsSync(f)) continue;
      checks++;
      const m = /Google.{0,80}\b100\b|\b100\b.{0,80}Google|Google.{0,80}100[人名位个]|100[人名位个].{0,80}Google/.exec(textOf(f));
      if (m) fail(`${path.relative(DOCS, f).replace(/\\/g, '/')}: puts a number of people next to Google sign-in: "${m[0].slice(0, 100)}"`);
    }
  }
  {
    const root = path.join(DOCS, '..');
    for (const name of ['README.md', 'CONTRIBUTING.md']) {
      checks++;
      const text = fs.readFileSync(path.join(root, name), 'utf8');
      if (/limited to 100|first 100|100 (users|people)|100 test users/i.test(text)) fail(`${name}: puts a number of people on the Google sign-in`);
    }
  }
  // the README and the 1.0.10 section of the CHANGELOG say nothing about mobile apps either (owner decision: no statement, not even "no mobile apps")
  {
    const root = path.join(DOCS, '..');
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    const log = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const sect = (/^## 1\.0\.10\b[\s\S]*?(?=^## |(?![\s\S]))/m.exec(log) || [''])[0];
    for (const [name, text] of [['README.md', readme], ['CHANGELOG.md (1.0.10)', sect]]) if (/\bmobile (apps?|clients?|versions?)\b|\bphone apps?\b|\bsmartphones?\b/i.test(text)) fail(`${name}: says something about mobile apps`);
  }
  // macOS does have notifications (owner 2026-10-20, DEC-017): README, CONTRIBUTING, the release footer and the 1.0.10 section of the CHANGELOG do not say it has none
  {
    const root = path.join(DOCS, '..');
    const log = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const sect = (/^## 1\.0\.10\b[\s\S]*?(?=^## |(?![\s\S]))/m.exec(log) || [''])[0];
    const files =[['README.md', fs.readFileSync(path.join(root, 'README.md'), 'utf8')], ['CONTRIBUTING.md', fs.readFileSync(path.join(root, 'CONTRIBUTING.md'), 'utf8')],
      ['.github/release-footer.md', fs.readFileSync(path.join(root, '.github', 'release-footer.md'), 'utf8')], ['CHANGELOG.md (1.0.10)', sect]];
    for (const [name, text] of files) if (/cannot show native notifications|native notifications are not available|no native notifications|macOS has no notifications|macOS has no Print/i.test(text)) fail(`${name}: says macOS has no notifications or no Print`);
  }
  // (stays on the 1.0.9 section until the 1.0.10 QA reports exist: the release-prep commit moves it to 1.0.10 with the new statement)
  // 1.0.9 test statement (hotfix, Windows start-up code): tested on Windows 11 on real hardware; macOS and Linux were NOT run (their start flag, plugin and entry are unchanged, the shared
  // changes were only built there). Do not claim a Mac / Linux check here unless its QA report exists; when it does, say it in the three texts and relax the "not run" check below in the same commit.
  {
    const root = path.join(DOCS, '..');
    const log = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const sect = (/^## 1\.0\.9\b[\s\S]*?(?=^## |(?![\s\S]))/m.exec(log) || [''])[0];
    const files = [['README.md', fs.readFileSync(path.join(root, 'README.md'), 'utf8')], ['.github/release-footer.md', fs.readFileSync(path.join(root, '.github', 'release-footer.md'), 'utf8')], ['CHANGELOG.md (1.0.9)', sect]];
    for (const [name, text] of files) {
      checks++;
      if (!/changes of (this release|1\.0\.9) were tested on Windows 11 \(x64\) on real hardware/.test(text)) fail(`${name}: the 1.0.9 test statement (tested on Windows 11 (x64) on real hardware) is missing`);
      if (!/not run on macOS or Linux/.test(text)) fail(`${name}: no longer says the 1.0.9 changes were not run on macOS or Linux`);
      if (/MacBook|ARM virtual machine|checked on a Mac|WebKitGTK/i.test(text)) fail(`${name}: claims a Mac / Linux check of 1.0.9 (the WebKit checks were of 1.0.8): update this test together with the statement once the QA report exists`);
      if (!/Windows 10, Intel Macs and macOS 11 and 12/.test(text)) fail(`${name}: no longer says Windows 10, Intel Macs and macOS 11 and 12 were not tested`);
      if (/all (versions of )?macOS|every (version of )?macOS|all Linux (distributions|distros)/i.test(text)) fail(`${name}: claims more than was tested (all macOS versions / all Linux distributions)`);
    }
  }
  return { errors, checks };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { errors, checks } = findProblems();
  if (errors.length) { console.error(errors.map((e) => 'FAIL ' + e).join('\n')); process.exit(1); }
  console.log(`ok - test-site-statements (${REMOVED.reduce((n, r) => n + r.items.length, 0)} removed sentences in ${REMOVED.length} rows, ${checks} page checks, ${LANGS.length} languages)`);
}
