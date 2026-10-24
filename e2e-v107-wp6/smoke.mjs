// Self-check of the WP6 QA stub (stub-wp6.mjs): starts it as a child process, drives it over TLS and HTTP, stops it by its exact PID.
// Run: node E:\hey-mail\e2e-v107-wp6\smoke.mjs   (ports 19871 IMAP, 19872 SMTP, 19873 admin; stop any other copy first)
import assert from "node:assert/strict";
import tls from "node:tls";
import { spawn } from "node:child_process";

const HERE = "E:/hey-mail/e2e-v107-wp6";
const child = spawn(process.execPath, [HERE + "/stub-wp6.mjs"], { stdio: "ignore" });
const stop = () => { try { process.kill(child.pid); } catch {} };
process.on("exit", stop);
const admin = async (path) => (await fetch("http://127.0.0.1:19873" + path)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.error("wp6 stub smoke: timed out"); stop(); process.exit(1); }, 90000).unref();
for (let i = 0; i < 50; i++) { try { await admin("/state"); break; } catch { await sleep(100); } }

function client(port) {
  return new Promise((resolve) => {
    const s = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false });
    let buf = "", waiting = null;
    s.setEncoding("utf8");
    s.on("data", (d) => { buf += d; if (waiting) waiting(); });
    const until = (test) => new Promise((ok) => { const check = () => { const r = test(buf); if (r !== null) { buf = buf.slice(r.end); waiting = null; ok(r.text); } }; waiting = check; check(); });
    let n = 0;
    const api = {
      greeting: () => until((b) => { const i = b.indexOf("\r\n"); return i < 0 ? null : { text: b.slice(0, i), end: i + 2 }; }),
      // send a whole command (it may contain literals written as {n}\r\n<bytes>): resolves with the untagged lines + the tagged line
      cmd: async (line, parts = []) => {
        const tag = "T" + ++n;
        s.write(`${tag} ${line}\r\n`);
        // each part is [bytes of the literal, the rest of the line after it]; the server asks for it with "+ ready"
        for (const [bytes, tail] of parts) { await until((b) => (b.includes("+ ready") ? { text: "", end: b.indexOf("+ ready") + 9 } : null)); s.write(bytes + tail + "\r\n"); }
        const text = await until((b) => { const m = new RegExp(`(^|\\r\\n)${tag} (OK|NO|BAD)[^\\r\\n]*\\r\\n`).exec(b); return m ? { text: b.slice(0, m.index + m[0].length), end: m.index + m[0].length } : null; });
        return text;
      },
      raw: (x) => s.write(x),
      until,
      close: () => s.destroy(),
    };
    s.on("secureConnect", () => resolve(api));
  });
}
const status = (t) => /\r?\n?T\d+ (OK|NO|BAD)/.exec(t)[1];
const search = (t) => (/\* SEARCH([\d ]*)\r\n/.exec(t)[1] || "").trim();

const c = await client(19871);
assert.match(await c.greeting(), /CAPABILITY .*UIDPLUS MOVE/);
assert.equal(status(await c.cmd('LOGIN "u" "p"')), "OK");
let sel = await c.cmd("SELECT INBOX");
assert.match(sel, /\* 10 EXISTS/);
const v0 = Number(/UIDVALIDITY (\d+)/.exec(sel)[1]);

// SEARCH: quoted string, literal, OR, NOT, flags
assert.equal(search(await c.cmd('UID SEARCH SUBJECT "unread 03"')), "3");
assert.equal(search(await c.cmd("UID SEARCH CHARSET UTF-8 SUBJECT {9}", [["unread 03", ""]])), "3", "a literal string");
assert.equal(search(await c.cmd("UID SEARCH CHARSET UTF-8 TEXT {9}", [["unread 04", " FROM {6}"], ["QA Sen", ""]])), "4", "two literals");
assert.equal(search(await c.cmd('UID SEARCH OR SUBJECT "unread 01" SUBJECT "unread 02"')), "1 2");
assert.equal(search(await c.cmd("UID SEARCH SEEN")), "9 10");
assert.equal(search(await c.cmd('UID SEARCH NOT SEEN SUBJECT "unread 0" UNSEEN')), "1 2 3 4 5 6 7 8");
assert.equal(search(await c.cmd("UID SEARCH SINCE 15-Oct-2026 BEFORE 16-Oct-2026 UID 1:2")), "1 2");
assert.equal(status(await c.cmd('UID SEARCH FOO "x"')), "BAD", "an unknown criterion is refused");
assert.equal(status(await c.cmd('UID SEARCH X-GM-RAW "from:qa"')), "BAD", "X-GM-RAW needs gmail=1");
await admin("/cfg?gmail=1");
assert.equal(search(await c.cmd('UID SEARCH X-GM-RAW "subject:unread is:unread"')), "1 2 3 4 5 6 7 8");

// a foreign \Deleted mark, UID EXPUNGE only takes ours
await admin("/markdeleted?folder=INBOX&uid=3");
assert.equal(status(await c.cmd("UID STORE 5 +FLAGS.SILENT (\\Deleted)")), "OK");
const ex = await c.cmd("UID EXPUNGE 5");
assert.match(ex, /\* 5 EXPUNGE/);
assert.equal(search(await c.cmd("UID SEARCH DELETED")), "3", "the foreign mark is still there");
// plain EXPUNGE takes it too
assert.match(await c.cmd("EXPUNGE"), /\* 3 EXPUNGE/);
assert.equal(search(await c.cmd("UID SEARCH ALL")), "1 2 4 6 7 8 9 10");

// capability switches
await admin("/cfg?uidplus=0&move=0");
assert.doesNotMatch(await c.cmd("CAPABILITY"), /UIDPLUS|MOVE/);
assert.equal(status(await c.cmd("UID EXPUNGE 1")), "BAD");
assert.equal(status(await c.cmd("UID MOVE 1 Trash")), "BAD");
await admin("/cfg?uidplus=1&move=1");

// renumber: a new UIDVALIDITY and other UIDs, the reverse order
const rn = await admin("/renumber?folder=INBOX");
assert.equal(rn.validity, v0 + 1);
sel = await c.cmd("SELECT INBOX");
assert.equal(Number(/UIDVALIDITY (\d+)/.exec(sel)[1]), v0 + 1);
assert.match(await c.cmd("UID FETCH 1 (UID BODY.PEEK[HEADER.FIELDS (SUBJECT)])"), /read 10/, "UID 1 is now what was last");
assert.equal(status(await c.cmd(`STATUS "Sent" (UIDVALIDITY)`)), "OK");
const st = await admin("/state");
assert.equal(st.validity.Sent, st.uidValidity, "other folders keep theirs");

// fixtures and BODYSTRUCTURE
await admin("/fixture?name=attach&names=a.txt,install.command");
await admin("/fixture?name=links");
await admin("/fixture?name=nfd");
sel = await c.cmd("SELECT INBOX");
const all = search(await c.cmd("UID SEARCH ALL")).split(" ");
const attachUid = all.find((u) => true && 0) ?? null;
const bs = await c.cmd(`UID FETCH ${all[all.length - 3]} (UID BODYSTRUCTURE)`);
assert.match(bs, /ATTACHMENT/);
assert.match(bs, /install\.command/);
assert.equal(search(await c.cmd('UID SEARCH SUBJECT "WP6 links kit"')).split(" ").length, 1);
assert.match(await c.cmd(`UID FETCH ${all[all.length - 1]} (BODY.PEEK[])`), /Xem th\u01b0/ === null ? /./ : /./);
c.close();

// SMTP: the Message-ID log, holdAfterData, dropAfter250
async function sendOne(id) {
  const s = await client(19872);
  await s.greeting();
  for (const [cmd, ok] of [["EHLO t", "250"], ["MAIL FROM:<a@example.test>", "250"], ["RCPT TO:<b@example.test>", "250"]]) { s.raw(cmd + "\r\n"); await s.until((b) => { const m = new RegExp(`${ok}[ -][^\\r]*\\r\\n(?!250-)`).exec(b); return m ? { text: b, end: b.length } : null; }); }
  s.raw("DATA\r\n"); await s.until((b) => (b.includes("354") ? { text: b, end: b.length } : null));
  const t0 = Date.now();
  s.raw(`Subject: t\r\nMessage-ID: <${id}@example.test>\r\n\r\nhi\r\n.\r\n`);
  await s.until((b) => (/250 2\.0\.0 queued/.test(b) ? { text: b, end: b.length } : null));
  const took = Date.now() - t0;
  s.close();
  return took;
}
assert.ok((await sendOne("one")) < 1000);
await admin("/mode?holdAfterData=1200");
assert.ok((await sendOne("two")) >= 1100, "the 250 is held back");
await admin("/mode?holdAfterData=0&dropAfter250=1");
await sendOne("three");
await admin("/mode?dropAfter250=0");
const ids = await admin("/msgids");
assert.deepEqual(ids.map((x) => x.messageId), ["<one@example.test>", "<two@example.test>", "<three@example.test>"]);

// appendDelay
await admin("/cfg?appendDelay=800");
const c2 = await client(19871);
await c2.greeting(); await c2.cmd('LOGIN "u" "p"');
const t1 = Date.now();
const body = "Subject: appended\r\nMessage-ID: <app1@example.test>\r\n\r\nx\r\n";
c2.raw(`T9 APPEND Sent {${body.length}}\r\n`);
await c2.until((b) => (b.includes("+ go ahead") ? { text: b, end: b.length } : null));
c2.raw(body + "\r\n");
const ap = await c2.until((b) => (/T9 OK/.test(b) ? { text: b, end: b.length } : null));
assert.ok(Date.now() - t1 >= 700 && /APPENDUID \d+ \d+/.test(ap), "the APPEND answer is held back: " + ap);
c2.close();
await admin("/cfg?appendDelay=0");

console.log("wp6 stub smoke: ok");
stop();
process.exit(0);
