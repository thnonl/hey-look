// The fixture mails of the Reply / Forward timing (1.0.7 W13.13, spec-107-wp13e-feedback.md step 1): F-small 20 KB HTML, F-big 500 KB HTML with 30 remote pictures,
// F-huge 2 MB HTML with 40 inline (cid:) pictures, F-plain 1 MB of plain text, F-att a small mail with 3 attachments, F-cc a small mail with two other recipients and two Cc (Reply all has Cc rows). They are made inside the page
// (`window.__mockAddThread`, src/devMock.ts), so nothing big is stored in the repository. FIXTURES is the page script that adds them; the ids are in IDS.
export const IDS = { small: 'fx-small', big: 'fx-big', huge: 'fx-huge', plain: 'fx-plain', att: 'fx-att', cc: 'fx-cc' };

export const FIXTURES = `
(() => {
  const para = (i) => '<p>Paragraph ' + i + ': the quarterly figures were reviewed on Monday and the open points are listed below, with the owner of each one and the date it is due. ' + 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. '.repeat(3) + '</p>';
  const html = (bytes, extra) => { let s = '<div>'; let i = 0; while (s.length < bytes) s += para(i++) + (extra ? extra(i) : ''); return s + '</div>'; };
  const cidPics = (n) => Array.from({ length: n }, (_, i) => ({ index: i, name: 'pic' + i + '.png', mime: 'image/png', size: 2048, inline: true, cid: 'p' + i + '@fx', referenced: true }));
  const add = window.__mockAddThread;
  const common = { fromName: 'Linh Tran', fromEmail: 'linh@example.com' };
  add('fx-small', 'Fixture small 20 KB', { ...common, html: html(20 * 1024) });
  add('fx-cc', 'Fixture with Cc', { ...common, to: 'nam@example.com,bao@example.com', cc: 'chi@example.com,dung@example.com', html: html(20 * 1024) });
  add('fx-big', 'Fixture big 500 KB', { ...common, html: html(500 * 1024, (i) => (i % 40 === 0 ? '<p><img src="https://pictures.example.invalid/p' + i + '.png" width="120"></p>' : '')) });
  const pics = cidPics(40);
  add('fx-huge', 'Fixture huge 2 MB', { ...common, html: html(2 * 1024 * 1024, (i) => (i % 100 === 0 && i / 100 < 40 ? '<p><img src="cid:p' + (i / 100) + '@fx" width="120"></p>' : '')) .replace(/<\\/div>$/, pics.map((p) => '<img src="cid:' + p.cid + '" width="40">').join('') + '</div>'), attachments: pics });
  add('fx-plain', 'Fixture plain 1 MB', { ...common, html: null, text: Array.from({ length: 12000 }, (_, i) => 'Line ' + i + ': the quarterly figures were reviewed on Monday and the open points follow.').join('\\n') });
  add('fx-att', 'Fixture three attachments', { ...common, html: html(20 * 1024), attachments: [
    { index: 0, name: 'report.pdf', mime: 'application/pdf', size: 482113, inline: false, cid: null, referenced: false },
    { index: 1, name: 'figures.xlsx', mime: 'application/vnd.ms-excel', size: 51000, inline: false, cid: null, referenced: false },
    { index: 2, name: 'notes.txt', mime: 'text/plain', size: 120, inline: false, cid: null, referenced: false },
  ] });
  return Object.keys(window.__store.getState()).length > 0;
})()
`;
