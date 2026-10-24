// fix52 (D-110, D-111): APPENDs one mail per Confidential label fixture to a throw-away IMAP mailbox without TLS (GreenMail, the QA stub), or writes them as .eml files.
// Run:  node append-labels.mjs <host> <port> <user> <password> [folder=INBOX]
//       node append-labels.mjs --dry <outDir>          (only writes the .eml files; nothing is sent)
// Every subject starts with "LBL" + a number + YES or NO: YES = the mail must arrive Confidential (list shield, banner, Print / Forward off), NO = an ordinary mail.
// The shapes: raw 8-bit UTF-8 (raw), RFC 2047 B (b64), Q (q), folded over two lines (fold), whole msip_labels value encoded (whole), a header of its own (own),
// a character cut between two encoded words (cut), charsets (latin1, cp1251, sjis, eucjp, jis, gbk). Send them AFTER the update: only new mail is scanned.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const eB = (text, cs = "utf-8") => `=?${cs}?b?${b64(typeof text === "string" ? Buffer.from(text, "utf8") : text)}?=`;
const eQ = (text, cs = "utf-8") => `=?${cs}?q?${[...(typeof text === "string" ? Buffer.from(text, "utf8") : text)].map((c) => (/[0-9A-Za-z]/.test(String.fromCharCode(c)) ? String.fromCharCode(c) : "=" + c.toString(16).toUpperCase().padStart(2, "0"))).join("")}?=`;
const tail = "; MSIP_Label_1f2e_Method=Standard";
const purview = (v) => `msip_labels: MSIP_Label_1f2e_Enabled=true; MSIP_Label_1f2e_Name=${v}${tail}`;

// [yes?, language/name, [shape, header]]
const names = [
  [true, "fr Confidentiel", "Confidentiel"], [true, "fr Tres confidentiel", "Très confidentiel"], [true, "de Streng vertraulich", "Streng vertraulich"],
  [true, "es Altamente confidencial", "Altamente confidencial"], [true, "vi Tuyet mat", "Tuyệt mật"], [true, "vi Bao mat", "Bảo mật"], [true, "ru Konfidentsialno", "Конфиденциально"],
  [true, "ja shagaihi", "社外秘"], [true, "ja kimitsu", "機密"], [true, "zh jimi", "机密"], [true, "en Highly Confidential", "Highly Confidential"],
  [true, "en Confidential All Employees", "Confidential \\ All Employees"],
  [false, "en Never confidential", "Never confidential"], [false, "en Not confidential", "Not confidential"], [false, "en Public", "Public"], [false, "fr Non confidentiel", "Non confidentiel"],
  [false, "de Nicht vertraulich", "Nicht vertraulich"], [false, "de Nie vertraulich", "Nie vertraulich"], [false, "es No confidencial", "No confidencial"], [false, "es Nunca confidencial", "Nunca confidencial"],
  [false, "vi Khong bi mat", "Không bí mật"], [false, "ru Nesekretno", "Несекретно"], [false, "ru Nikogda ne sekretno", "Никогда не секретно"], [false, "ja hi-kimitsu", "非機密"], [false, "zh fei-jimi", "非机密"],
];
const fixtures = [];
for (const [yes, id, name] of names) {
  const half = [...name].slice(0, Math.ceil([...name].length / 2)).join("");
  const rest = name.slice(half.length);
  fixtures.push([yes, `${id} raw`, purview(name)]);
  fixtures.push([yes, `${id} b64`, purview(eB(name))]);
  fixtures.push([yes, `${id} q`, purview(eQ(name))]);
  fixtures.push([yes, `${id} fold`, `msip_labels: MSIP_Label_1f2e_Enabled=true;\r\n MSIP_Label_1f2e_Name=${eB(half)}\r\n ${eB(rest)};\r\n MSIP_Label_1f2e_Method=Standard`]);
  fixtures.push([yes, `${id} whole`, `msip_labels: ${eB(`MSIP_Label_1f2e_Enabled=true; MSIP_Label_1f2e_Name=${name}${tail}`)}`]);
  fixtures.push([yes, `${id} own`, `MSIP_Label_1f2e_Name: ${eB(name)}`]);
}
// a character cut between two encoded words
const cut = Buffer.from("Bảo mật");
fixtures.push([true, "vi Bao mat cut", `MSIP_Label_1f2e_Name: ${eB(cut.subarray(0, 2))}\r\n ${eB(cut.subarray(2))}`]);
// charsets
const cp1251 = Buffer.from([..."Конфиденциально"].map((c) => c.codePointAt(0) - 0x410 + 0xc0));
const gen = (id, cs, bytes, yes = true) => fixtures.push([yes, `${id} ${cs}`, purview(eQ(bytes, cs))]);
gen("fr Tres confidentiel", "iso-8859-1", Buffer.from("Tr\xe8s confidentiel", "latin1"));
gen("ru Konfidentsialno", "windows-1251", cp1251);
gen("ja kimitsu", "shift_jis", Buffer.from([0x8b, 0x40, 0x96, 0xa7]));
gen("ja kimitsu", "euc-jp", Buffer.from([0xb5, 0xa1, 0xcc, 0xa9]));
gen("ja kimitsu", "iso-2022-jp", Buffer.from("\x1b$B5!L)\x1b(B", "latin1"));
gen("zh jimi", "gb2312", Buffer.from([0xbb, 0xfa, 0xc3, 0xdc]));
gen("zh jimi", "gbk", Buffer.from([0xbb, 0xfa, 0xc3, 0xdc]));
gen("ja hi-kimitsu", "shift_jis", Buffer.from([0x94, 0xf1, 0x8b, 0x40, 0x96, 0xa7]), false);
gen("zh fei-jimi", "gbk", Buffer.from([0xb7, 0xc7, 0xbb, 0xfa, 0xc3, 0xdc]), false);

const build = (n, user, yes, id, header) =>
  Buffer.from(
    `MIME-Version: 1.0\r\nFrom: Label Fixtures <labels@heylook.qa>\r\nTo: ${user}\r\nSubject: LBL${String(n).padStart(3, "0")} ${yes ? "YES" : "NO"} ${id}\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <lbl-${n}-${Date.now()}@heylook.qa>\r\n${header}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\nLabel fixture ${n}: ${id}\r\n`,
    "utf8",
  );

if (process.argv[2] === "--dry") {
  const out = path.resolve(process.argv[3] ?? "labels-eml");
  fs.mkdirSync(out, { recursive: true });
  fixtures.forEach(([yes, id, header], i) => fs.writeFileSync(path.join(out, `lbl${String(i + 1).padStart(3, "0")}-${yes ? "yes" : "no"}.eml`), build(i + 1, "qa@heylook.qa", yes, id, header)));
  console.log(`${fixtures.length} files in ${out} (${fixtures.filter((f) => f[0]).length} YES, ${fixtures.filter((f) => !f[0]).length} NO)`);
  process.exit(0);
}

const [host, port, user, pass, folder = "INBOX"] = process.argv.slice(2);
if (!host || !port || !user || !pass) { console.error("usage: node append-labels.mjs <host> <port> <user> <password> [folder]  |  --dry <outDir>"); process.exit(2); }
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
for (const [yes, id, header] of fixtures) {
  n++;
  const message = build(n, user, yes, id, header);
  sock.write(`a${n} APPEND "${folder}" {${message.length}}\r\n`);
  await waitFor(/\+[^\r\n]*\r\n/);
  sock.write(message);
  sock.write("\r\n");
  await waitFor(new RegExp(`a${n} (OK|NO|BAD)[^\\r\\n]*\\r\\n`)).then((m) => { if (m[1] !== "OK") throw new Error(m[0]); });
}
console.log(`appended ${n} label mails to ${folder} of ${user}`);
sock.write("z LOGOUT\r\n");
sock.end();
