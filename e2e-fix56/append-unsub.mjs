// fix56 (review of the newsletter / unsubscribe phrase lists): APPENDs one mail per sample to a throw-away IMAP mailbox without TLS (GreenMail, the QA stub), or writes .eml files.
// Run:  node append-unsub.mjs [--all] <host> <port> <user> <password> [folder=INBOX]
//       node append-unsub.mjs [--all] --dry <outDir>          (only writes the .eml files; nothing is sent)
// Default = the 16 sample mails (UNS001-UNS016, 9 YES / 7 NO) of checklist section 56; --all = every wording in every spelling (173 mails, 123 YES / 50 NO).
// Every mail has NO List-Unsubscribe header and one HTML link; the subject is "UNS<nnn> YES|NO <lang> <kind> <link text>".
//   YES = the reading pane must show the notice "This looks like a newsletter. Unsubscribe" (`.unsub-link`) and the More menu must have Unsubscribe.
//   NO  = neither (an order / account / log-out wording, or a preferences-only link).
// kind: plain (precomposed text), nfd (the same text decomposed: macOS mail and some tools write Vietnamese like this), ascii (unaccented spelling), up (upper case),
//       ctx (German: the address names the newsletter, the text is the bare word). Send them AFTER installing the build: only new mail is scanned.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const nfd = (s) => s.normalize("NFD");
const strip = (s) => nfd(s).replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").replace(/ё/g, "е").replace(/Ё/g, "Е");
const OK = "https://t.heylook.qa/r/9a8b7c"; // an address with no word in it
// [lang, yes?, text, href?]
const S = [
  ["vi", true, "Hủy đăng ký"], ["vi", true, "Hủy nhận tin"], ["vi", true, "Ngừng nhận email"], ["vi", true, "Bỏ đăng kí"], ["vi", true, "Hủy theo dõi"],
  ["vi", false, "Hủy nhận hàng"], ["vi", false, "Ngừng nhận đơn"], ["vi", false, "Từ chối nhận hàng"],
  ["zh-Hans", true, "退订"], ["zh-Hans", true, "取消订阅"], ["zh-Hans", true, "不再接收此类邮件"], ["zh-Hans", true, "停止接收"], ["zh-Hans", true, "取消关注"],
  ["zh-Hans", false, "取消订单"], ["zh-Hans", false, "管理订阅"], ["zh-Hans", true, "退订房"],
  ["ja", true, "配信停止"], ["ja", true, "メール配信を停止する"], ["ja", true, "購読解除"], ["ja", true, "メルマガ解除"], ["ja", true, "受信停止"], ["ja", true, "配信中止"],
  ["ja", false, "キャンセル"], ["ja", false, "退会"], ["ja", false, "配信設定"],
  ["fr", true, "Se désabonner"], ["fr", true, "Désabonnez-vous"], ["fr", true, "Ne plus recevoir ces e-mails"], ["fr", true, "Annuler l’abonnement"], ["fr", true, "Se retirer de la liste"],
  ["fr", false, "Annuler la commande"], ["fr", false, "Gérer mes abonnements"],
  ["es", true, "Cancelar suscripción"], ["es", true, "Cancela tu suscripción"], ["es", true, "Darte de baja"], ["es", true, "Anular la suscripción"], ["es", true, "Desuscribirse"],
  ["es", false, "Cancelar el pedido"], ["es", false, "Gestionar preferencias"],
  ["de", true, "Abbestellen"], ["de", true, "Newsletter abmelden"], ["de", true, "Abo kündigen"], ["de", true, "Keine weiteren E-Mails"], ["de", true, "Vom Abo abmelden"],
  ["de", true, "Abmelden", "https://news.heylook.qa/newsletter/abmelden?t=1"],
  ["de", false, "Von allen Geräten abmelden", "https://account.heylook.qa/signout-all"], ["de", false, "Sitzung abmelden", "https://account.heylook.qa/abmelden"], ["de", false, "Abmelden"],
  ["ru", true, "Отписаться"], ["ru", true, "Отпишитесь"], ["ru", true, "Отказаться от подписки"], ["ru", true, "Отменить подписку"], ["ru", true, "Больше не получать письма"], ["ru", true, "Прекратить рассылку"],
  ["ru", false, "Отменить заказ"], ["ru", false, "Управление подпиской"],
];
const fixtures = [];
for (const [lang, yes, text, href] of S) {
  const h = href ?? OK;
  const kinds = [["plain", text]];
  if (!href) {
    kinds.push(["nfd", nfd(text)]);
    if (["vi", "fr", "es", "de"].includes(lang)) kinds.push(["ascii", strip(text)]);
    if (lang !== "ja" && lang !== "zh-Hans") kinds.push(["up", text.toUpperCase()]);
  }
  for (const [kind, t] of kinds) fixtures.push({ lang, yes, kind, text: t, text0: text, href: h });
}
const SHORT = [
  "vi|Hủy nhận tin|plain", "vi|Hủy đăng ký|nfd", "vi|Hủy nhận hàng|plain", "zh-Hans|不再接收此类邮件|plain", "zh-Hans|取消订单|plain", "ja|メルマガ解除|nfd", "ja|キャンセル|plain",
  "fr|Désabonnez-vous|ascii", "fr|Annuler la commande|plain", "es|Cancelar suscripción|ascii", "es|Cancelar el pedido|plain", "de|Abo kündigen|plain",
  "de|Von allen Geräten abmelden|plain", "de|Abmelden|plain", "ru|Отпишитесь|plain", "ru|Отменить заказ|plain",
];
const all = process.argv.includes("--all");
if (!all) {
  const keep = fixtures.filter((f) => SHORT.includes(f.lang + "|" + f.text0 + "|" + f.kind));
  fixtures.length = 0;
  fixtures.push(...SHORT.map((k) => keep.find((f) => f.lang + "|" + f.text0 + "|" + f.kind === k)));
}
const b64 = (s) => Buffer.from(s, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
const build = (n, user, f) => {
  const subject = `UNS${String(n).padStart(3, "0")} ${f.yes ? "YES" : "NO"} ${f.lang} ${f.kind} ${f.text}`;
  const html = `<html><body><p>Weekly digest</p><p><a href="https://t.heylook.qa/home">Home</a> | <a href="${f.href}">${f.text}</a></p></body></html>`;
  return Buffer.from(
    `MIME-Version: 1.0\r\nFrom: Phrase Fixtures <news@heylook.qa>\r\nTo: ${user}\r\nSubject: =?utf-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <uns-${n}-${Date.now()}@heylook.qa>\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(html)}\r\n`,
    "utf8",
  );
};
if (process.argv.includes("--dry")) {
  const out = path.resolve(process.argv.filter((a) => a !== "--all" && a !== "--dry")[2] ?? "unsub-eml");
  fs.mkdirSync(out, { recursive: true });
  fixtures.forEach((f, i) => fs.writeFileSync(path.join(out, `uns${String(i + 1).padStart(3, "0")}-${f.yes ? "yes" : "no"}.eml`), build(i + 1, "qa@heylook.qa", f)));
  console.log(`${fixtures.length} files in ${out} (${fixtures.filter((f) => f.yes).length} YES, ${fixtures.filter((f) => !f.yes).length} NO)`);
  process.exit(0);
}
const [host, port, user, pass, folder = "INBOX"] = process.argv.slice(2).filter((a) => a !== "--all");
if (!host || !port || !user || !pass) { console.error("usage: node append-unsub.mjs <host> <port> <user> <password> [folder]  |  --dry <outDir>"); process.exit(2); }
const sock = net.connect(Number(port), host);
let buf = "";
sock.on("data", (d) => { buf += d.toString("latin1"); });
const waitFor = (re) => new Promise((ok, no) => {
  const t = setTimeout(() => no(new Error(`no ${re} in ${buf.slice(-200)}`)), 60000);
  const tick = () => { const m = re.exec(buf); if (m) { clearTimeout(t); buf = buf.slice(m.index + m[0].length); ok(m); } else setTimeout(tick, 20); };
  tick();
});
await waitFor(/\* OK[^\r\n]*\r\n/);
sock.write(`a0 LOGIN "${user}" "${pass}"\r\n`);
await waitFor(/a0 (OK|NO|BAD)[^\r\n]*\r\n/).then((m) => { if (m[1] !== "OK") throw new Error(m[0]); });
let n = 0;
for (const f of fixtures) {
  n++;
  const message = build(n, user, f);
  sock.write(`a${n} APPEND "${folder}" {${message.length}}\r\n`);
  await waitFor(/\+[^\r\n]*\r\n/);
  sock.write(message);
  sock.write("\r\n");
  await waitFor(new RegExp(`a${n} (OK|NO|BAD)[^\r\n]*\r\n`)).then((m) => { if (m[1] !== "OK") throw new Error(m[0]); });
}
console.log(`appended ${n} mails to ${folder} of ${user}`);
sock.write("z LOGOUT\r\n");
sock.end();
