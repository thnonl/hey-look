// QA-only stub on 127.0.0.1 for the 1.0.7 WP6 round (lineage: test-builds\bridge\qa\stub.mjs r10..r20). No real mailbox, nothing leaves the machine.
// WP6 additions (admin HTTP on 19873, see README.md): per-folder UIDVALIDITY and /renumber, capability switches uidplus / move / gmail (UID EXPUNGE, MOVE, X-GM-RAW),
// /markdeleted (a foreign \Deleted mark), appendDelay, SEARCH with TEXT / FROM / TO / CC / SUBJECT / BODY / HEADER / OR / NOT / SINCE / BEFORE / flags and literals,
// BODYSTRUCTURE with attachments, SMTP holdAfterData / dropAfter250 and the Message-ID log (/msgids), /seedmany and /fixture (the kit mails).
// IMAP over TLS on 19993 with seeded messages and per-message \Seen state; SMTP over TLS on 19465 (greeting/auth only, no delivery used);
// admin HTTP on 127.0.0.1:19980 (state, STORE delay, folder add/remove, reseed, log). Stop it by PID only.
import tls from "node:tls";
import http from "node:http";
import { readFileSync, appendFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";

const DIR = "E:/hey-mail/e2e-v107-wp6";
const CERT_DIR = "E:/hey-mail/test-builds/bridge/qa";
const LOG = DIR + "/stub-wp6.log";
const opts = { key: readFileSync(CERT_DIR + "/stub-key.pem"), cert: readFileSync(CERT_DIR + "/stub-cert.pem") };
const IMAP_PORT = 19871, SMTP_PORT = 19872, ADMIN_PORT = 19873;

let appendSeq = 0;
const cfg = { appendFail: false, minDelay: 0, maxDelay: 0, listDelay: 0, allowCreate: true, failStore: false, failMove: false, uidplus: true, move: true, gmail: false, appendDelay: 0, maxConnections: 0, searchDelay: 0 };
const caps = () => `IMAP4rev1 AUTH=PLAIN AUTH=LOGIN IDLE${cfg.uidplus ? " UIDPLUS" : ""}${cfg.move ? " MOVE" : ""}${cfg.gmail ? " X-GM-EXT-1" : ""}`;
const msgIds = []; // every Message-ID the SMTP side received, in order
const loggedIn = new Set(); // connection ids that are logged in (maxConnections)
let connSeq = 0;
const idlers = new Map(); // IDLE sessions: id -> {s, sel, tag}; used to push '* N EXISTS' on inject
const log = (line) => { const l = `${new Date().toISOString()} ${line}`; appendFileSync(LOG, l + "\n"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let folders = new Map();
let nextUid = 100;
let uidValidity = 1;
const special = { Sent: "\\Sent", Drafts: "\\Drafts", Trash: "\\Trash", Junk: "\\Junk" };

function mk(uid, subj, seen) {
  const raw = `From: QA Sender <qa-sender@example.test>\r\nTo: qa-r11@example.test\r\nSubject: ${subj}\r\nDate: Thu, 15 Oct 2026 10:${String(uid % 60).padStart(2, "0")}:00 +0000\r\nMessage-ID: <r11-${uid}-${uidValidity}@example.test>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBody of ${subj}. QA stub mail, not real.\r\n`;
  return { uid, seen, flagged: false, deleted: false, subj, raw: Buffer.from(raw, "utf8") };
}
function seed() {
  folders = new Map();
  const inbox = [];
  for (let i = 1; i <= 8; i++) inbox.push(mk(i, `QA r13 unread ${String(i).padStart(2, "0")}`, false));
  for (let i = 9; i <= 10; i++) inbox.push(mk(i, `QA r13 read ${i}`, true));
  folders.set("INBOX", { msgs: inbox });
  for (const f of ["Sent", "Drafts", "Trash"]) folders.set(f, { msgs: [] });
  // Archive is deliberately absent (missing-folder case); the admin endpoint can add it
  nextUid = 100;
  uidValidity++;
}
seed();

const vOf = (name) => (folders.get(name) && folders.get(name).validity) || uidValidity; // UIDVALIDITY per folder (/renumber changes one)
const flagsOf = (m) => [m.seen ? "\\Seen" : null, m.flagged ? "\\Flagged" : null, m.deleted ? "\\Deleted" : null].filter(Boolean).join(" ");
const maxUidOf = (f) => f.msgs.reduce((mx, m) => Math.max(mx, m.uid), 0);

// parse "1:*,5,7:9" into a predicate; "*" resolves to max
function parseSet(s, max) {
  const ranges = [];
  for (const part of s.split(",")) {
    const [a, b] = part.split(":");
    const lo = a === "*" ? max : parseInt(a, 10);
    const hi = b === undefined ? lo : b === "*" ? max : parseInt(b, 10);
    ranges.push([Math.min(lo, hi), Math.max(lo, hi)]);
  }
  return (n) => ranges.some(([lo, hi]) => n >= lo && n <= hi);
}

function headerOf(raw) {
  const i = raw.indexOf("\r\n\r\n");
  return i >= 0 ? raw.subarray(0, i + 4) : raw;
}

// ---- SEARCH criteria (WP6): strings in quotes (a literal is turned into a quoted string by the reader), parentheses, OR, NOT, flags, dates, UID sets, X-GM-RAW
function tokenizeSearch(s) {
  const t = []; let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === " ") { i++; continue; }
    if (c === '"') {
      let j = i + 1, o = "";
      while (j < s.length && s[j] !== '"') { if (s[j] === "\\" && j + 1 < s.length) { o += s[j + 1]; j += 2; } else { o += s[j]; j++; } }
      t.push({ q: o }); i = j + 1;
    } else if (c === "(" || c === ")") { t.push({ p: c }); i++; }
    else { let j = i; while (j < s.length && s[j] !== " " && s[j] !== "(" && s[j] !== ")") j++; t.push({ a: s.slice(i, j) }); i = j; }
  }
  return t;
}
const text8 = (b) => b.toString("utf8").toLowerCase();
const unfolded = (x) => headerOf(x.raw).toString("utf8").replace(/\r\n[ \t]+/g, " ");
function fieldOf(x, name) {
  const want = name.toLowerCase();
  return unfolded(x).split("\r\n").filter((ln) => { const k = ln.indexOf(":"); return k > 0 && ln.slice(0, k).toLowerCase() === want; }).map((ln) => ln.slice(ln.indexOf(":") + 1)).join(" ").toLowerCase();
}
const bodyOf = (x) => { const i = x.raw.indexOf("\r\n\r\n"); return i >= 0 ? x.raw.subarray(i + 4) : Buffer.alloc(0); };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function dayOf(str) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(str); if (!m) throw new Error("bad date " + str);
  const mon = MONTHS.indexOf(m[2].toLowerCase()); if (mon < 0) throw new Error("bad month " + str);
  return Date.UTC(Number(m[3]), mon, Number(m[1]));
}
const sentAt = (x) => { const d = Date.parse(fieldOf(x, "date")); return Number.isNaN(d) ? 0 : d; };
function gmailRaw(q) {
  const terms = q.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  const tests = terms.map((term) => {
    const m = /^(-?)(from|to|cc|subject|has|is|after|before):(.*)$/i.exec(term);
    const v = (m ? m[3] : term).replace(/^"|"$/g, "").toLowerCase();
    let f;
    if (!m) f = (e) => text8(e.x.raw).includes(v);
    else if (m[2].toLowerCase() === "has") f = (e) => v !== "attachment" || /content-disposition:\s*attachment/i.test(e.x.raw.toString("latin1"));
    else if (m[2].toLowerCase() === "is") f = (e) => (v === "unread" ? !e.x.seen : v === "read" ? e.x.seen : v === "starred" ? e.x.flagged : true);
    else if (m[2].toLowerCase() === "after") f = (e) => sentAt(e.x) >= Date.parse(v.replace(/\//g, "-"));
    else if (m[2].toLowerCase() === "before") f = (e) => sentAt(e.x) < Date.parse(v.replace(/\//g, "-"));
    else f = (e) => fieldOf(e.x, m[2]).includes(v);
    return m && m[1] === "-" ? (e) => !f(e) : f;
  });
  return (e) => tests.every((f) => f(e));
}
function parseCriteria(args, maxUid, count) {
  const t = tokenizeSearch(args); let i = 0;
  const str = () => { const k = t[i++]; if (!k || k.p) throw new Error("string expected"); return k.q !== undefined ? k.q : k.a; };
  const key = () => {
    const k = t[i++]; if (!k) throw new Error("criterion expected");
    if (k.p === "(") { const parts = []; while (t[i] && t[i].p !== ")") parts.push(key()); i++; return (e) => parts.every((f) => f(e)); }
    if (k.q !== undefined || k.p) throw new Error("unexpected token");
    const w = k.a.toUpperCase();
    switch (w) {
      case "ALL": return () => true;
      case "CHARSET": str(); return () => true;
      case "UID": { const set = parseSet(str(), maxUid); return (e) => set(e.x.uid); }
      case "SEEN": return (e) => e.x.seen;
      case "UNSEEN": return (e) => !e.x.seen;
      case "FLAGGED": return (e) => e.x.flagged;
      case "UNFLAGGED": return (e) => !e.x.flagged;
      case "DELETED": return (e) => e.x.deleted;
      case "UNDELETED": return (e) => !e.x.deleted;
      case "TEXT": { const v = str().toLowerCase(); return (e) => text8(e.x.raw).includes(v); }
      case "BODY": { const v = str().toLowerCase(); return (e) => text8(bodyOf(e.x)).includes(v); }
      case "SUBJECT": case "FROM": case "TO": case "CC": case "BCC": { const v = str().toLowerCase(); return (e) => fieldOf(e.x, w).includes(v); }
      case "HEADER": { const f = str(); const v = str().toLowerCase(); return (e) => fieldOf(e.x, f).includes(v); }
      case "SINCE": { const d = dayOf(str()); return (e) => sentAt(e.x) >= d; }
      case "BEFORE": { const d = dayOf(str()); return (e) => sentAt(e.x) < d; }
      case "ON": { const d = dayOf(str()); return (e) => sentAt(e.x) >= d && sentAt(e.x) < d + 86400000; }
      case "LARGER": { const n = Number(str()); return (e) => e.x.raw.length > n; }
      case "SMALLER": { const n = Number(str()); return (e) => e.x.raw.length < n; }
      case "OR": { const a = key(), b = key(); return (e) => a(e) || b(e); }
      case "NOT": { const a = key(); return (e) => !a(e); }
      case "X-GM-RAW": { if (!cfg.gmail) throw new Error("X-GM-RAW needs gmail=1"); return gmailRaw(str()); }
      default:
        if (/^[0-9*:,]+$/.test(k.a)) { const set = parseSet(k.a, count); return (e) => set(e.seq); }
        throw new Error("unknown criterion " + k.a);
    }
  };
  const all = []; while (i < t.length) all.push(key());
  return (e) => all.every((f) => f(e));
}

// BODYSTRUCTURE: one text part, or text + one part per `Content-Disposition: attachment; filename="..."` of a multipart/mixed message
function structureOf(x) {
  const head = headerOf(x.raw).toString("latin1");
  if (/content-type:\s*multipart\/mixed/i.test(head)) {
    const names = [...x.raw.toString("latin1").matchAll(/Content-Disposition:\s*attachment;\s*filename="([^"]+)"/gi)].map((m) => m[1]);
    const att = names.map((n) => `("APPLICATION" "OCTET-STREAM" ("NAME" "${n}") NIL NIL "BASE64" 100 NIL ("ATTACHMENT" ("FILENAME" "${n}")) NIL)`).join("");
    return `(("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" 20 1)${att} "MIXED")`;
  }
  return `("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" ${x.raw.length} 3)`;
}

function renumberFolder(name) {
  const f = folders.get(name);
  if (!f) return null;
  const before = vOf(name);
  f.msgs.reverse();
  f.msgs.forEach((m, i) => { m.uid = i + 1; });
  f.validity = before + 1;
  if (nextUid <= f.msgs.length) nextUid = f.msgs.length + 1;
  log(`ADMIN renumber ${name}: UIDVALIDITY ${before} -> ${f.validity}, ${f.msgs.length} message(s) renumbered from 1 in reverse`);
  return { folder: name, validity: f.validity, uids: f.msgs.map((m) => [m.uid, m.subj]) };
}

// a connection: one IMAP session; commands run one after the other (a STORE may be delayed by cfg)
function serve(s) {
  const id = ++connSeq;
  let selected = null;
  let buf = Buffer.alloc(0);
  let idling = null;
  let pendingLit = null; // {prefix, need, bytes}
  let cmdLit = null; // a literal inside a command other than APPEND: {tag, text, need, phase: "bytes" | "tail"}
  let chain = Promise.resolve();
  const write = (x) => { if (!s.destroyed) s.write(x); };
  s.write(`* OK [CAPABILITY ${caps()}] QA stub WP6 ready\r\n`);
  s.on("error", () => {});
  s.on("close", () => { idlers.delete(id); loggedIn.delete(id); log(`c${id} closed`); });
  log(`c${id} connected`);

  const send = (tag, cmd) => { chain = chain.then(() => handle(tag, cmd)).catch((e) => { log(`c${id} ERROR ${e && e.stack}`); write(`${tag} BAD internal\r\n`); }); };

  async function handle(tag, line) {
    const m = /^(\S+)\s*(.*)$/.exec(line);
    if (!m) return write(`${tag} BAD\r\n`);
    const cmdRaw = m[1];
    let rest = m[2];
    let cmd = cmdRaw.toUpperCase();
    let byUid = false;
    if (cmd === "UID") { byUid = true; const m2 = /^(\S+)\s*(.*)$/.exec(rest); cmd = (m2 ? m2[1] : "").toUpperCase(); rest = m2 ? m2[2] : ""; }
    log(`c${id} C ${tag} ${byUid ? "UID " : ""}${cmd} ${cmd === "LOGIN" ? "<redacted>" : rest.slice(0, 160)}`);
    switch (cmd) {
      case "CAPABILITY": return write(`* CAPABILITY ${caps()}\r\n${tag} OK done\r\n`);
      case "LOGIN": {
        // maxConnections=<n>: a server that allows n logged-in connections per user; the next one is refused (AC-6.6.4)
        if (cfg.maxConnections > 0 && loggedIn.size >= cfg.maxConnections) { log(`c${id} LOGIN refused: ${loggedIn.size} connections already (maxConnections=${cfg.maxConnections})`); return write(`${tag} NO [UNAVAILABLE] Too many simultaneous connections\r\n`); }
        loggedIn.add(id);
        return write(`${tag} OK [CAPABILITY ${caps()}] LOGIN completed\r\n`);
      }
      case "AUTHENTICATE": return write(`${tag} OK [CAPABILITY ${caps()}] AUTHENTICATE completed\r\n`);
      case "ID": return write(`* ID NIL\r\n${tag} OK done\r\n`);
      case "ENABLE": return write(`* ENABLED\r\n${tag} OK done\r\n`);
      case "NAMESPACE": return write(`* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK done\r\n`);
      case "NOOP": case "CHECK": return write(`${tag} OK done\r\n`);
      case "CLOSE": selected = null; return write(`${tag} OK closed\r\n`);
      case "LIST": case "LSUB": { if (cmd === "LIST" && cfg.listDelay) { log(`c${id} LIST delayed ${cfg.listDelay}ms (QA cfg)`); await sleep(cfg.listDelay); }
        let out = "";
        for (const name of folders.keys()) {
          const attr = special[name] ? `\\HasNoChildren ${special[name]}` : "\\HasNoChildren";
          out += `* ${cmd} (${attr}) "/" "${name}"\r\n`;
        }
        return write(out + `${tag} OK done\r\n`);
      }
      case "SUBSCRIBE": case "UNSUBSCRIBE": return write(`${tag} OK done\r\n`);
      case "CREATE": {
        const name = rest.replace(/^"|"$/g, "");
        // QA r16: createDelay (ms) holds the refusal back, so the app has already moved on when it arrives
        if (cfg.createDelay) { log(`c${id} CREATE delayed ${cfg.createDelay}ms (QA cfg)`); await sleep(cfg.createDelay); }
        if (!cfg.allowCreate) { log(`c${id} CREATE refused (allowCreate=0)`); return write(`${tag} NO [CANNOT] create refused by QA stub\r\n`); }
        if (!folders.has(name)) folders.set(name, { msgs: [] });
        return write(`${tag} OK created\r\n`);
      }
      case "STATUS": {
        const name = rest.replace(/^"|"\s*\(.*$/g, "").replace(/^"/, "");
        const f = folders.get(name);
        if (!f) return write(`${tag} NO no such mailbox\r\n`);
        const unseen = f.msgs.filter((x) => !x.seen).length;
        return write(`* STATUS "${name}" (MESSAGES ${f.msgs.length} UNSEEN ${unseen} UIDNEXT ${nextUid} UIDVALIDITY ${vOf(name)})\r\n${tag} OK done\r\n`);
      }
      case "SELECT": case "EXAMINE": {
        const name = rest.replace(/^"|"$/g, "");
        const f = folders.get(name);
        if (!f) return write(`${tag} NO [NONEXISTENT] Mailbox doesn't exist\r\n`);
        selected = name;
        const ro = cmd === "EXAMINE" ? "READ-ONLY" : "READ-WRITE";
        return write(`* ${f.msgs.length} EXISTS\r\n* 0 RECENT\r\n* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] ok\r\n* OK [UIDVALIDITY ${vOf(name)}] ok\r\n* OK [UIDNEXT ${nextUid}] ok\r\n${tag} OK [${ro}] ${cmd} completed\r\n`);
      }
      case "IDLE": { idling = tag; idlers.set(id, { s, sel: () => selected, tag: () => idling }); return write("+ idling\r\n"); }
      case "LOGOUT": { write(`* BYE bye\r\n${tag} OK logout\r\n`); s.end(); return; }
      case "APPEND": {
        // APPEND "folder" (flags) {n}  -> literal follows
        const mm = /^"?([^"\s]+)"?\s*(?:\(([^)]*)\)\s*)?(?:"[^"]*"\s*)?\{(\d+)\}$/.exec(rest);
        if (!mm) return write(`${tag} BAD\r\n`);
        pendingLit = { tag, folder: mm[1], flags: mm[2] || "", need: parseInt(mm[3], 10), bytes: Buffer.alloc(0) };
        return write("+ go ahead\r\n");
      }
      case "EXPUNGE": {
        const f = folders.get(selected); if (!f) return write(`${tag} BAD no mailbox\r\n`);
        // UID EXPUNGE <set> (UIDPLUS) removes only the \Deleted messages whose UID is in the set; a plain EXPUNGE removes every \Deleted one, a foreign mark included
        if (byUid && !cfg.uidplus) return write(`${tag} BAD UID EXPUNGE is not supported (uidplus=0)\r\n`);
        const inSet = byUid ? parseSet(rest.trim(), maxUidOf(f)) : () => true;
        let out = ""; let removed = 0; const keep = []; const gone = [];
        f.msgs.forEach((x, i) => { if (x.deleted && inSet(x.uid)) { out += `* ${i + 1 - removed} EXPUNGE\r\n`; removed++; gone.push(x.uid); } else keep.push(x); });
        f.msgs = keep;
        log(`c${id} ${byUid ? "UID " : ""}EXPUNGE removed uids=${gone.join(",")} folder=${selected}`);
        return write(out + `${tag} OK expunged\r\n`);
      }
      case "SEARCH": case "FETCH": case "STORE": case "MOVE": case "COPY": {
        if (!selected && cmd !== "SEARCH") return write(`${tag} BAD no mailbox selected\r\n`);
        return doSelected(tag, cmd, rest, byUid);
      }
      default:
        log(`c${id} UNKNOWN ${cmd}`);
        return write(`${tag} BAD unknown command ${cmd}\r\n`);
    }

    async function doSelected(tag2, c2, args, uidMode) {
      const f = folders.get(selected);
      if (!f) return write(`${tag2} NO no mailbox\r\n`);
      const max = uidMode ? maxUidOf(f) : f.msgs.length;
      if (c2 === "SEARCH") {
        // WP6: a real criteria evaluator (strings in quotes, literals already turned into quotes by the reader). A criterion the stub does not know answers BAD, so a test never passes on a wrong guess.
        let list = f.msgs.map((x, i) => ({ x, n: uidMode ? x.uid : i + 1, seq: i + 1 }));
        let test;
        try { test = parseCriteria(args, maxUidOf(f), f.msgs.length); } catch (e) { log(`c${id} SEARCH not understood: ${e.message} :: ${args.slice(0, 200)}`); return write(`${tag2} BAD ${e.message}\r\n`); }
        if (cfg.searchDelay) await sleep(cfg.searchDelay);
        list = list.filter((e) => test(e));
        log(`c${id} SEARCH ${list.length} hit(s) in ${selected}`);
        return write(`* SEARCH${list.map((e) => " " + e.n).join("")}\r\n${tag2} OK SEARCH done\r\n`);
      }
      if (c2 === "FETCH") {
        const mm = /^(\S+)\s+(.*)$/.exec(args);
        if (!mm) return write(`${tag2} BAD\r\n`);
        const pred = parseSet(mm[1], max);
        const items = mm[2].toUpperCase();
        const wantUid = uidMode || /\bUID\b/.test(items);
        const wantFlags = /\bFLAGS\b/.test(items);
        const wantDate = /INTERNALDATE/.test(items);
        const wantSize = /RFC822\.SIZE/.test(items);
        const wantBody = /BODY(?:\.PEEK)?\[\]|RFC822(?!\.)/.test(items);
        const wantHeader = /BODY(?:\.PEEK)?\[HEADER/.test(items);
        const wantStruct = /BODYSTRUCTURE/.test(items);
        const wantEnv = /ENVELOPE/.test(items);
        let out = []; let count = 0;
        for (let i = 0; i < f.msgs.length; i++) {
          const x = f.msgs[i]; const n = uidMode ? x.uid : i + 1;
          if (!pred(n)) continue;
          count++;
          const attrs = [];
          if (wantUid) attrs.push(`UID ${x.uid}`);
          if (wantFlags) attrs.push(`FLAGS (${flagsOf(x)})`);
          if (wantDate) attrs.push(`INTERNALDATE "15-Oct-2026 10:00:00 +0000"`);
          if (wantSize) attrs.push(`RFC822.SIZE ${x.raw.length}`);
          if (wantStruct) attrs.push(`BODYSTRUCTURE ${structureOf(x)}`);
          if (wantEnv) attrs.push(`ENVELOPE (NIL "${x.subj}" (("QA Sender" NIL "qa-sender" "example.test")) NIL NIL (("QA" NIL "qa-r11" "example.test")) NIL NIL NIL "<r10-${x.uid}@example.test>")`);
          const pieces = [`* ${n} FETCH (`];
          let first = true;
          const sep = () => { if (!first) pieces.push(" "); first = false; };
          for (const a of attrs) { sep(); pieces.push(a); }
          if (wantBody) { sep(); pieces.push(`BODY[] {${x.raw.length}}\r\n`, x.raw); }
          else if (wantHeader) { const h = headerOf(x.raw); sep(); pieces.push(`BODY[HEADER] {${h.length}}\r\n`, h); }
          pieces.push(")\r\n");
          out.push(Buffer.concat(pieces.map((p) => (typeof p === "string" ? Buffer.from(p, "utf8") : p))));
        }
        const body = Buffer.concat(out);
        if (!s.destroyed) { s.write(body); s.write(`${tag2} OK FETCH completed\r\n`); }
        return;
      }
      if (c2 === "STORE") {
        const mm = /^(\S+)\s+([+-]?FLAGS(?:\.SILENT)?)\s+\((.*)\)\s*$/i.exec(args);
        if (!mm) return write(`${tag2} BAD STORE syntax\r\n`);
        if (cfg.failStore) { log(`c${id} STORE refused (failStore)`); return write(`${tag2} NO STORE refused by QA stub\r\n`); }
        const mode = mm[2].toUpperCase(); const silent = mode.endsWith(".SILENT"); const base = mode.replace(".SILENT", "");
        const flags = mm[3].trim().split(/\s+/).filter(Boolean);
        const pred = parseSet(mm[1], max);
        const d = cfg.minDelay + Math.random() * Math.max(0, cfg.maxDelay - cfg.minDelay);
        if (d > 0) await sleep(d);
        const changed = []; let touched = [];
        f.msgs.forEach((x, i) => {
          const n = uidMode ? x.uid : i + 1;
          if (!pred(n)) return;
          touched.push(x.uid);
          if (base === "FLAGS") { x.seen = flags.includes("\\Seen"); x.flagged = flags.includes("\\Flagged"); x.deleted = flags.includes("\\Deleted"); }
          else {
            const on = base === "+FLAGS";
            if (flags.includes("\\Seen")) x.seen = on;
            if (flags.includes("\\Flagged")) x.flagged = on;
            if (flags.includes("\\Deleted")) x.deleted = on;
          }
          changed.push({ n, x });
        });
        log(`c${id} APPLIED STORE ${uidMode ? "UID " : ""}${mm[1]} ${mode} (${flags.join(" ")}) folder=${selected} uids=${touched.join(",")} delay=${Math.round(d)}ms seen=${changed.map((c) => c.x.uid + ":" + (c.x.seen ? 1 : 0)).join(",")}`);
        if (!silent && !s.destroyed) {
          for (const { n, x } of changed) write(`* ${n} FETCH (${uidMode ? "UID " + x.uid + " " : ""}FLAGS (${flagsOf(x)}))\r\n`);
        }
        return write(`${tag2} OK STORE completed\r\n`);
      }
      if (c2 === "MOVE" || c2 === "COPY") {
        const mm = /^(\S+)\s+"?([^"]+)"?\s*$/.exec(args);
        if (!mm) return write(`${tag2} BAD\r\n`);
        // QA r16: moveDelay (ms) holds the MOVE back (a slow server); with failMove the refusal arrives late
        if (cfg.moveDelay && c2 === "MOVE") { log(`c${id} MOVE delayed ${cfg.moveDelay}ms (QA cfg)`); await sleep(cfg.moveDelay); }
        if (c2 === "MOVE" && !cfg.move) { log(`c${id} MOVE refused as unknown (move=0)`); return write(`${tag2} BAD unknown command MOVE\r\n`); }
        if (cfg.failMove) return write(`${tag2} NO [CANNOT] move refused by QA stub\r\n`);
        const dest = folders.get(mm[2]);
        if (!dest) return write(`${tag2} NO [TRYCREATE] Mailbox doesn't exist: ${mm[2]}\r\n`);
        const pred = parseSet(mm[1], max);
        const moving = [];
        f.msgs.forEach((x, i) => { const n = uidMode ? x.uid : i + 1; if (pred(n)) moving.push(x); });
        for (const x of moving) dest.msgs.push({ ...x, uid: nextUid++, raw: x.raw, deleted: false });
        log(`c${id} ${c2} ${mm[1]} from ${selected} to ${mm[2]} count=${moving.length}`);
        if (c2 === "MOVE") {
          let out = ""; let removed = 0; const keep = [];
          f.msgs.forEach((x, i) => { if (moving.includes(x)) { out += `* ${i + 1 - removed} EXPUNGE\r\n`; removed++; } else keep.push(x); });
          f.msgs = keep;
          return write(out + `${tag2} OK MOVE completed\r\n`);
        }
        return write(`${tag2} OK COPY completed\r\n`);
      }
      return write(`${tag2} BAD\r\n`);
    }
  }

  s.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (pendingLit) {
        if (buf.length < pendingLit.need + 2) return; // wait for literal + CRLF of command tail (approx)
        const lit = buf.subarray(0, pendingLit.need);
        buf = buf.subarray(pendingLit.need);
        const endIdx = buf.indexOf("\r\n");
        if (endIdx < 0) return;
        buf = buf.subarray(endIdx + 2);
        const p = pendingLit; pendingLit = null;
        const f = folders.get(p.folder);
        if (!f) { send(p.tag, "__NOFOLDER__"); continue; }
        if (cfg.appendFail) { log(`c${id} APPEND refused (appendFail) folder=${p.folder}`); write(`${p.tag} NO [CANNOT] append refused by QA stub\r\n`); continue; }
        const aSeq = ++appendSeq; const uidA = nextUid++;
        const folderSafe = p.folder.replace(/[^A-Za-z0-9]/g, "_");
        const litCopy = Buffer.from(lit);
        const finishAppend = () => {
          writeFileSync(`${CAP}/append-${folderSafe}-${aSeq}.eml`, litCopy);
          writeFileSync(`${CAP}/append-${folderSafe}-${aSeq}.json`, JSON.stringify({ seq: aSeq, folder: p.folder, flags: p.flags, bytes: litCopy.length, at: new Date().toISOString() }, null, 1));
          const subjA = (/^Subject:\s*(.*)$/im.exec(litCopy.toString("utf8")) || [])[1] || "appended";
          f.msgs.push({ uid: uidA, seen: /\\Seen/i.test(p.flags), flagged: false, deleted: false, subj: subjA, raw: litCopy });
          log(`c${id} APPENDED ${litCopy.length} bytes to ${p.folder} uid=${uidA}`);
          write(`${p.tag} OK ${cfg.uidplus ? `[APPENDUID ${vOf(p.folder)} ${uidA}] ` : ""}APPEND completed\r\n`);
        };
        // appendDelay (ms): the message is stored and answered only after the delay (a slow Sent copy; kill the app while it waits)
        if (cfg.appendDelay > 0) { log(`c${id} APPEND to ${p.folder} held ${cfg.appendDelay}ms (QA cfg)`); setTimeout(finishAppend, cfg.appendDelay); } else finishAppend();
        continue;
      }
      if (cmdLit) {
        if (cmdLit.phase === "bytes") {
          if (buf.length < cmdLit.need) return;
          const val = buf.subarray(0, cmdLit.need).toString("utf8"); buf = buf.subarray(cmdLit.need);
          cmdLit.text += ` "${val.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
          cmdLit.phase = "tail";
        }
        const e = buf.indexOf("\r\n"); if (e < 0) return;
        const tail = buf.subarray(0, e).toString("utf8"); buf = buf.subarray(e + 2);
        const more = /\{(\d+)\+?\}$/.exec(tail);
        if (more) { cmdLit.text += tail.replace(/\s*\{\d+\+?\}$/, ""); cmdLit.need = parseInt(more[1], 10); cmdLit.phase = "bytes"; if (!/\+\}$/.test(tail)) write("+ ready\r\n"); continue; }
        const done = cmdLit; cmdLit = null;
        send(done.tag, done.text + tail);
        continue;
      }
      if (idling !== null) {
        const i = buf.indexOf("\r\n"); if (i < 0) return;
        const line = buf.subarray(0, i).toString("utf8"); buf = buf.subarray(i + 2);
        if (/^DONE/i.test(line)) { idlers.delete(id); write(`${idling} OK IDLE terminated\r\n`); idling = null; }
        continue;
      }
      const i = buf.indexOf("\r\n"); if (i < 0) return;
      const line = buf.subarray(0, i).toString("utf8");
      buf = buf.subarray(i + 2);
      const lit = /\{(\d+)\+?\}$/.exec(line);
      if (lit && !/^DONE/i.test(line)) {
        const tagm0 = /^(\S+)\s+(.*)$/.exec(line);
        // a literal inside any other command (SEARCH with a UTF-8 string): collected into the command text as a quoted string
        if (tagm0 && !/^APPEND\b/i.test(tagm0[2])) {
          cmdLit = { tag: tagm0[1], text: tagm0[2].replace(/\s*\{\d+\+?\}$/, ""), need: parseInt(lit[1], 10), phase: "bytes" };
          if (!/\+\}$/.test(line)) write("+ ready\r\n");
          continue;
        }
        // client literal (APPEND): read it in the next loop iteration
        const tagm = /^(\S+)\s+(.*)$/.exec(line);
        pendingLit = { tag: tagm[1], folder: (/^APPEND\s+"?([^"\s]+)"?/i.exec(tagm[2]) || [])[1] || "INBOX", flags: (/\(([^)]*)\)/.exec(tagm[2]) || [])[1] || "", need: parseInt(lit[1], 10) };
        write("+ go ahead\r\n");
        continue;
      }
      const tm = /^(\S+)\s+(.*)$/.exec(line);
      if (!tm) { write("* BAD\r\n"); continue; }
      send(tm[1], tm[2]);
    }
  });
}

// WP6 kit mails. Each returns {subj, raw}.
function fixtureMail(which, q) {
  const head = (subj) => `From: WP6 Kit <wp6-kit@example.test>\r\nTo: qa-r11@example.test\r\nSubject: ${subj}\r\nDate: Mon, 19 Oct 2026 09:00:00 +0000\r\nMessage-ID: <wp6-${which}-${Date.now()}@example.test>\r\nMIME-Version: 1.0\r\n`;
  const html = (subj, body) => ({ subj, raw: head(subj) + `Content-Type: text/html; charset=utf-8\r\n\r\n<html><body>${body}</body></html>\r\n` });
  if (which === "links") {
    // the 10 links of AC-6.14.1 and what the app has to do (README.md has the same table)
    const L = [
      ["l1", "https://www.bank.test", "https://bank.test/login", "no warning"],
      ["l2", "bank.test", "https://login.bank.test", "no warning (sub-domain)"],
      ["l3", "paypal.test", "https://paypal.test.evil.test", "warning L1, target paypal.test.evil.test"],
      ["l4", "support@bank.test", "https://evil.test", "warning L2"],
      ["l5", "Click here", "https://xn--pple-43d.test", "warning L3, target xn--pple-43d.test"],
      ["l6", "Click here", "https://bank.test@evil.test/", "warning L4, target evil.test"],
      ["l7", "Visit shop.test for more", "https://tracker.test/r?u=1", "no warning (text in a sentence)"],
      ["l8", "https://shop.test/sale", "https://shop.test/sale?utm=1", "no warning (same host)"],
      ["l9", "Read more", "https://news.test/a", "no warning (plain words)"],
      ["l10", "Write to us", "mailto:info@bank.test", "no warning (mailto)"],
    ];
    return html("WP6 links kit", "<p>Ten links for the link warning.</p>" + L.map(([id, t, h, w]) => `<p><a id="${id}" href="${h}">${t}</a> <small>${id}: ${w}</small></p>`).join(""));
  }
  const lines = {
    nfd: ["Xem thư này trên trình duyệt", "Ưu đãi lớn cho khách hàng thân thiết, số lượng có hạn."],
    pt: ["Ver este e-mail no navegador", "Promoção de verão começa hoje com descontos em tudo."],
    ko: ["브라우저에서 보기", "여름 세일이 오늘부터 시작됩니다. 모든 상품 할인."],
  };
  if (lines[which]) {
    const [boiler, real] = lines[which];
    const b = which === "nfd" ? boiler.normalize("NFD") : boiler; // NFD as macOS Mail / some newsletter tools write Vietnamese
    const r = which === "nfd" ? real.normalize("NFD") : real;
    return html(`WP6 ${which} newsletter`, `<p><a href="https://view.example.test/x?id=1">${b}</a></p><p>${r}</p>`);
  }
  if (which === "attach") {
    const names = (q.get("names") || "a.txt,install.command,x.AppImage,a.webloc,y.deb,a.pdf").split(",");
    const bnd = "wp6-bnd-" + Date.now();
    let raw = head("WP6 attachments") + `Content-Type: multipart/mixed; boundary="${bnd}"\r\n\r\n--${bnd}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nFiles for the open warning and the saved folder name.\r\n`;
    for (const n of names) raw += `--${bnd}\r\nContent-Type: application/octet-stream; name="${n}"\r\nContent-Disposition: attachment; filename="${n}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from("QA file " + n + "\r\n").toString("base64")}\r\n`;
    return { subj: "WP6 attachments", raw: raw + `--${bnd}--\r\n` };
  }
  return null;
}

// QA r14: a long body for inject&long=1 (about 12 KB of plain text)
function longBody() { let s = ""; for (let i = 1; i <= 60; i++) s += "Paragraph " + i + ": QA r14 long-mail test text for the translation feature. The quick brown fox keeps running past the fence while the stub answers slowly. QA stub mail, not real.\r\n\r\n"; return s; }
const imap = tls.createServer(opts, serve);
imap.on("error", (e) => log("imap server error " + e.message));

// SMTP (QA r17): implicit TLS on SMTP_PORT. Every DATA is saved unchanged (dot-stuffing removed) to cap/smtp-<seq>.eml,
// with the envelope in cap/smtp-<seq>.json. Fault mode via admin /mode?smtp=<m>:
// ok | refuse | auth535 | rcpt550:<addr> | data552 | data421 | silent | dropmid | slow:<ms> | size:<bytes>
// /mode?eight=1&utf8=1 changes the EHLO extensions (8BITMIME, SMTPUTF8).
const smtpCfg = { mode: "ok", eight: false, utf8: false, reject552: false, holdAfterData: 0, dropAfter250: false }; // QA r20: reject552=1 answers 552 at the end of DATA whatever SIZE says
let smtpSeq = 0, smtpConn = 0;
const CAP = DIR + "/cap";
mkdirSync(CAP, { recursive: true });

const smtp = tls.createServer(opts, (s) => {
  const sid = ++smtpConn;
  const mode = smtpCfg.mode;
  if (mode === "refuse") { log(`SMTP c${sid} refuse: connection closed at once`); s.destroy(); return; }
  if (mode === "silent") { log(`SMTP c${sid} silent: no greeting, connection held`); return; }
  const slowMs = (() => { const m = /^slow:(\d+)$/.exec(mode); return m ? Number(m[1]) : 0; })();
  const out = (t) => {
    if (s.destroyed) return;
    if (slowMs) setTimeout(() => { if (!s.destroyed) s.write(t); }, slowMs);
    else s.write(t);
  };
  let rcpt = [], rejected = [], mailFrom = null, ehlo = null, authUser = null, authStep = 0;
  let inData = false, dbuf = Buffer.alloc(0), lbuf = Buffer.alloc(0);
  s.on("error", () => {});
  s.write("220 127.0.0.1 ESMTP QA stub r17\r\n");

  const finishData = (bytes) => {
    const unstuffed = Buffer.from(bytes.toString("latin1").replace(/\r\n\.\./g, "\r\n."), "latin1");
    const n = ++smtpSeq;
    const env = { seq: n, ehlo, mailFrom, rcptTo: rcpt.slice(), rejectedRcpt: rejected.slice(), authUser, mode, bytes: unstuffed.length, at: new Date().toISOString() };
    rcpt = []; rejected = []; mailFrom = null; inData = false;
    if (mode.startsWith("size:") && Number(mode.slice(5)) > 0 && unstuffed.length > Number(mode.slice(5))) {
      log(`SMTP c${sid} DATA ${unstuffed.length} bytes over SIZE ${mode.slice(5)} -> 552 (not saved)`);
      return out("552 5.3.4 Message size exceeds fixed limit (QA stub)\r\n");
    }
    writeFileSync(`${CAP}/smtp-${n}.eml`, unstuffed);
    writeFileSync(`${CAP}/smtp-${n}.json`, JSON.stringify(env, null, 1));
    log(`SMTP c${sid} DATA saved smtp-${n} bytes=${unstuffed.length} from=${env.mailFrom} rcpt=${env.rcptTo.join(",")}`);
    if (mode === "data552" || smtpCfg.reject552) return out("552 5.2.2 mailbox full (QA stub)\r\n");
    if (mode === "data421") return out("421 4.7.0 try again later (QA stub)\r\n");
    // WP6: the Message-ID log, and the two faults of the exactly-once tests: the 250 held back for holdAfterData ms (kill the app meanwhile), the connection closed right after the 250
    const mid = (/^Message-ID:\s*(<[^>]*>)/im.exec(unstuffed.toString("latin1")) || [])[1] || "";
    msgIds.push({ seq: n, messageId: mid, rcptTo: env.rcptTo, at: env.at });
    log(`SMTP c${sid} MESSAGE-ID ${mid} (smtp-${n})`);
    const accept = () => {
      out(`250 2.0.0 queued as QA${n}\r\n`);
      if (smtpCfg.dropAfter250) { log(`SMTP c${sid} dropAfter250: connection closed right after the 250`); setTimeout(() => s.destroy(), 0); }
    };
    if (smtpCfg.holdAfterData > 0) { log(`SMTP c${sid} the 250 for smtp-${n} is held ${smtpCfg.holdAfterData}ms (QA cfg)`); setTimeout(accept, smtpCfg.holdAfterData); } else accept();
  };

  const cmd = (line) => {
    const u = line.toUpperCase();
    if (/^(EHLO|HELO)\b/.test(u)) {
      ehlo = line.split(/\s+/)[1] || null;
      let t = "250-127.0.0.1 QA stub\r\n250-AUTH PLAIN LOGIN\r\n";
      if (smtpCfg.eight) t += "250-8BITMIME\r\n";
      if (smtpCfg.utf8) t += "250-SMTPUTF8\r\n";
      if (mode.startsWith("size:")) t += `250-SIZE ${mode.slice(5)}\r\n`;
      return out(t + "250 OK\r\n");
    }
    if (u.startsWith("AUTH PLAIN")) {
      const b64 = line.slice(10).trim();
      if (b64) { const d = Buffer.from(b64, "base64").toString("utf8").split("\0"); authUser = d[1] || null; }
      const ok = mode !== "auth535";
      log(`SMTP c${sid} AUTH PLAIN user=${authUser} result=${ok ? "235" : "535"}`);
      return out(ok ? "235 2.7.0 Authentication successful\r\n" : "535 5.7.8 Authentication credentials invalid (QA stub)\r\n");
    }
    if (u.startsWith("AUTH LOGIN")) { authStep = 1; return out("334 VXNlcm5hbWU6\r\n"); }
    if (authStep === 1) { authUser = Buffer.from(line, "base64").toString("utf8"); authStep = 2; return out("334 UGFzc3dvcmQ6\r\n"); }
    if (authStep === 2) {
      authStep = 0; const ok = mode !== "auth535";
      log(`SMTP c${sid} AUTH LOGIN user=${authUser} result=${ok ? "235" : "535"}`);
      return out(ok ? "235 2.7.0 Authentication successful\r\n" : "535 5.7.8 Authentication credentials invalid (QA stub)\r\n");
    }
    if (u.startsWith("MAIL FROM:")) {
      mailFrom = (/<([^>]*)>/.exec(line) || [])[1] ?? line.slice(10).trim();
      rcpt = []; rejected = [];
      return out("250 2.1.0 sender ok\r\n");
    }
    if (u.startsWith("RCPT TO:")) {
      const addr = (/<([^>]*)>/.exec(line) || [])[1] ?? line.slice(8).trim();
      const bad = mode.startsWith("rcpt550:") && mode.slice(8).toLowerCase() === addr.toLowerCase();
      if (bad) { rejected.push(addr); log(`SMTP c${sid} RCPT ${addr} -> 550 (rcpt550 mode)`); return out("550 5.1.1 user unknown (QA stub)\r\n"); }
      rcpt.push(addr);
      return out("250 2.1.5 recipient ok\r\n");
    }
    if (u === "DATA") {
      if (!rcpt.length) return out("503 5.5.1 need RCPT first\r\n");
      inData = true; dbuf = Buffer.from("\r\n");
      return out("354 end data with <CR><LF>.<CR><LF>\r\n");
    }
    if (u === "RSET") { rcpt = []; rejected = []; mailFrom = null; return out("250 ok\r\n"); }
    if (u === "NOOP") return out("250 ok\r\n");
    if (u === "QUIT") { out("221 bye\r\n"); s.end(); return; }
    return out("502 5.5.2 command not recognized\r\n");
  };

  const checkEnd = () => {
    const idx = dbuf.indexOf("\r\n.\r\n");
    if (idx < 0) return;
    const body = dbuf.subarray(2, idx + 2);
    const rest = dbuf.subarray(idx + 5);
    dbuf = Buffer.alloc(0);
    finishData(body);
    lbuf = Buffer.concat([lbuf, rest]);
    processLines();
  };

  const processLines = () => {
    while (!inData) {
      const i = lbuf.indexOf("\r\n"); if (i < 0) break;
      const line = lbuf.subarray(0, i).toString("utf8"); lbuf = lbuf.subarray(i + 2);
      cmd(line);
      if (inData && lbuf.length) { dbuf = Buffer.concat([dbuf, lbuf]); lbuf = Buffer.alloc(0); }
    }
    if (inData) checkEnd();
  };

  s.on("data", (d) => {
    if (inData) {
      dbuf = Buffer.concat([dbuf, d]);
      if (mode === "dropmid" && dbuf.length > 10240) { log(`SMTP c${sid} dropmid: connection closed after ${dbuf.length} bytes of DATA`); s.destroy(); return; }
      return checkEnd();
    }
    lbuf = Buffer.concat([lbuf, d]);
    processLines();
  });
});
smtp.on("error", (e) => log("smtp server error " + e.message));

// admin HTTP (127.0.0.1 only)
const admin = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o, null, 1)); };
  if (url.pathname === "/state") {
    const out = { uidValidity, nextUid, cfg, validity: Object.fromEntries([...folders.keys()].map((k) => [k, vOf(k)])), folders: {} };
    for (const [name, f] of folders) out.folders[name] = f.msgs.map((x, i) => ({ seq: i + 1, uid: x.uid, seen: x.seen, flagged: x.flagged, deleted: x.deleted, subj: x.subj }));
    return json(out);
  }
  if (url.pathname === "/cfg") {
    for (const k of ["minDelay", "maxDelay", "listDelay", "createDelay", "moveDelay", "appendDelay", "searchDelay"]) if (url.searchParams.has(k)) cfg[k] = Number(url.searchParams.get(k));
    for (const k of ["allowCreate", "failStore", "failMove", "uidplus", "move", "gmail"]) if (url.searchParams.has(k)) cfg[k] = url.searchParams.get(k) === "1";
    // the names of the spec (spec-107-wp6.md): refuseCreate=1, xgm=1, maxConnections=<n>, renumber=<folder>, markDeleted=<folder>:<uid>
    if (url.searchParams.has("refuseCreate")) cfg.allowCreate = url.searchParams.get("refuseCreate") !== "1";
    if (url.searchParams.has("xgm")) cfg.gmail = url.searchParams.get("xgm") === "1";
    if (url.searchParams.has("maxConnections")) cfg.maxConnections = Number(url.searchParams.get("maxConnections"));
    if (url.searchParams.has("renumber")) renumberFolder(url.searchParams.get("renumber"));
    if (url.searchParams.has("markDeleted")) {
      const [fname, uid] = url.searchParams.get("markDeleted").split(":");
      const m = (folders.get(fname) || { msgs: [] }).msgs.find((x) => x.uid === Number(uid));
      if (m) { m.deleted = true; log(`ADMIN markDeleted ${fname}:${uid}`); }
    }
    log("ADMIN cfg " + JSON.stringify(cfg));
    return json(cfg);
  }
  if (url.pathname === "/renumber") {
    // WP6 (AC-6.1.x): the folder gets a new UIDVALIDITY and its messages new UIDs, from 1, in the opposite order (so UID 15 names another message afterwards)
    const name = url.searchParams.get("folder") || "INBOX";
    const r = renumberFolder(name);
    return json(r || { error: "no such folder" });
  }
  if (url.pathname === "/markdeleted") {
    // WP6 (AC-6.1.5): a \Deleted mark set by another client (v=1, default) or taken off (v=0)
    const f = folders.get(url.searchParams.get("folder") || "INBOX");
    const m = f && f.msgs.find((x) => x.uid === Number(url.searchParams.get("uid")));
    if (!m) return json({ error: "no such uid" });
    m.deleted = url.searchParams.get("v") !== "0";
    log(`ADMIN markdeleted uid=${m.uid} -> ${m.deleted ? 1 : 0}`);
    return json({ uid: m.uid, deleted: m.deleted });
  }
  if (url.pathname === "/remove") {
    // WP6: another client deleted a message for good (no EXPUNGE seen by the app)
    const f = folders.get(url.searchParams.get("folder") || "INBOX");
    const uid = Number(url.searchParams.get("uid"));
    if (!f) return json({ error: "no such folder" });
    const before = f.msgs.length; f.msgs = f.msgs.filter((x) => x.uid !== uid);
    log(`ADMIN remove uid=${uid}`);
    return json({ removed: before - f.msgs.length });
  }
  if (url.pathname === "/seedmany") {
    // WP6 (AC-6.3.x, 6.7.x): n mails into a folder at once. subj=<prefix> (the number is added), from=, clear=1 empties it first, seen=0|1, days=<spread over n days, default n>
    const name = url.searchParams.get("folder") || "INBOX";
    const f = folders.get(name); if (!f) return json({ error: "no such folder" });
    const n = Math.min(20000, Number(url.searchParams.get("n") || 100));
    const prefix = url.searchParams.get("subj") || "WP6 mail";
    const from = url.searchParams.get("from") || "QA Many";
    const seen = url.searchParams.get("seen") !== "0";
    const spread = Number(url.searchParams.get("days") || n);
    if (url.searchParams.get("clear") === "1") f.msgs = [];
    const newest = Date.UTC(2026, 9, 20, 10, 0, 0);
    for (let i = 1; i <= n; i++) {
      const uid = nextUid++;
      const when = new Date(newest - Math.round((i / n) * spread * 86400000)).toUTCString().replace("GMT", "+0000");
      const raw = `From: ${from} <qa-many@example.test>\r\nTo: qa-r11@example.test\r\nSubject: ${prefix} ${i}\r\nDate: ${when}\r\nMessage-ID: <many-${uid}-${vOf(name)}@example.test>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBody of ${prefix} ${i}. QA stub mail, not real.\r\n`;
      f.msgs.push({ uid, seen, flagged: false, deleted: false, subj: `${prefix} ${i}`, raw: Buffer.from(raw, "utf8") });
    }
    log(`ADMIN seedmany ${n} into ${name} (now ${f.msgs.length})`);
    for (const [cid, ix] of idlers) if (ix.sel() === name && !ix.s.destroyed) ix.s.write(`* ${f.msgs.length} EXISTS\r\n`);
    return json({ folder: name, count: f.msgs.length });
  }
  if (url.pathname === "/fixture") {
    // WP6: the kit mails of the spec (links = AC-6.14.1, nfd / pt / ko = AC-6.13.1, attach = AC-6.8 / 6.15), delivered into folder= (default INBOX)
    const name = url.searchParams.get("folder") || "INBOX";
    const f = folders.get(name); if (!f) return json({ error: "no such folder" });
    const which = url.searchParams.get("name") || "links";
    const made = fixtureMail(which, url.searchParams);
    if (!made) return json({ error: "unknown fixture", known: ["links", "nfd", "pt", "ko", "attach"] });
    const uid = nextUid++;
    f.msgs.push({ uid, seen: false, flagged: false, deleted: false, subj: made.subj, raw: Buffer.from(made.raw, "utf8") });
    log(`ADMIN fixture ${which} uid=${uid} folder=${name}`);
    for (const [cid, ix] of idlers) if (ix.sel() === name && !ix.s.destroyed) ix.s.write(`* ${f.msgs.length} EXISTS\r\n`);
    return json({ uid, subj: made.subj });
  }
  if (url.pathname === "/msgids") return json(msgIds);
  if (url.pathname === "/seen") {
    const f = folders.get(url.searchParams.get("folder") || "INBOX");
    const uid = Number(url.searchParams.get("uid"));
    const m = f && f.msgs.find((x) => x.uid === uid);
    if (!m) return json({ error: "no such uid" });
    m.seen = url.searchParams.get("v") === "1";
    log(`ADMIN seen uid=${uid} -> ${m.seen ? 1 : 0}`);
    return json({ uid, seen: m.seen });
  }
  if (url.pathname === "/folder") {
    const name = url.searchParams.get("name"); const op = url.searchParams.get("op");
    if (op === "add") { if (!folders.has(name)) folders.set(name, { msgs: [] }); }
    else if (op === "del") folders.delete(name);
    log(`ADMIN folder ${op} ${name}`);
    return json({ folders: [...folders.keys()] });
  }
  if (url.pathname === "/inject") {
    // QA r13: deliver one new message into a folder; bulk=1 adds List-Unsubscribe; pushes '* N EXISTS' to IDLE sessions on that folder
    const name = url.searchParams.get("folder") || "INBOX";
    const f = folders.get(name);
    if (!f) return json({ error: "no such folder" });
    const subj = url.searchParams.get("subj") || "QA r13 new";
    const from = url.searchParams.get("from") || "QA Inject";
    const bulk = url.searchParams.get("bulk") === "1";
    const longOn = url.searchParams.get("long") === "1";
    const seen = url.searchParams.get("seen") === "1";
    const uid = nextUid++;
    const lu = bulk ? "List-Unsubscribe: <mailto:u@example.test>\r\n" : "";
    const raw = `From: ${from} <qa-inject@example.test>\r\nTo: qa-r11@example.test\r\nSubject: ${subj}\r\nDate: Fri, 16 Oct 2026 10:00:00 +0000\r\nMessage-ID: <r13-${uid}-${uidValidity}@example.test>\r\n${lu}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nQA r13 injected body ${uid}. QA stub mail, not real.\r\n${longOn ? longBody() : ""}`;
    f.msgs.push({ uid, seen, flagged: false, deleted: false, subj, raw: Buffer.from(raw, "utf8") });
    log(`ADMIN inject uid=${uid} folder=${name} bulk=${bulk ? 1 : 0} seen=${seen ? 1 : 0} subj=${subj}`);
    let pushed = 0;
    for (const [cid, ix] of idlers) {
      if (ix.sel() === name && !ix.s.destroyed) { ix.s.write(`* ${f.msgs.length} EXISTS\r\n`); pushed++; log(`c${cid} PUSH EXISTS ${f.msgs.length}`); }
    }
    return json({ uid, count: f.msgs.length, pushed });
  }
  if (url.pathname === "/injectraw" && req.method === "POST") {
    // QA r17: body = raw RFC 822 message (CRLF), folder=, seen=0|1. Pushes "* N EXISTS" to IDLE sessions on that folder.
    const chunks = []; req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      const name = url.searchParams.get("folder") || "INBOX";
      const f = folders.get(name);
      if (!f) return json({ error: "no such folder" });
      const raw = Buffer.concat(chunks);
      const uid = nextUid++;
      const seen = url.searchParams.get("seen") === "1";
      f.msgs.push({ uid, seen, flagged: false, deleted: false, subj: url.searchParams.get("subj") || "raw", raw });
      log(`ADMIN injectraw uid=${uid} folder=${name} bytes=${raw.length}`);
      for (const [cid, ix] of idlers) { if (ix.sel() === name && !ix.s.destroyed) ix.s.write(`* ${f.msgs.length} EXISTS\r\n`); }
      return json({ uid, count: f.msgs.length });
    });
    return;
  }
  if (url.pathname === "/mode") {
    // QA r17: fault injection. smtp=<mode> (see SMTP block), eight=0|1, utf8=0|1, appendfail=0|1
    if (url.searchParams.has("smtp")) smtpCfg.mode = url.searchParams.get("smtp");
    if (url.searchParams.has("eight")) smtpCfg.eight = url.searchParams.get("eight") === "1";
    if (url.searchParams.has("utf8")) smtpCfg.utf8 = url.searchParams.get("utf8") === "1";
    if (url.searchParams.has("reject552")) smtpCfg.reject552 = url.searchParams.get("reject552") === "1";
    if (url.searchParams.has("appendfail")) cfg.appendFail = url.searchParams.get("appendfail") === "1";
    if (url.searchParams.has("holdAfterData")) smtpCfg.holdAfterData = Number(url.searchParams.get("holdAfterData"));
    if (url.searchParams.has("dropAfter250")) smtpCfg.dropAfter250 = url.searchParams.get("dropAfter250") === "1";
    log("ADMIN mode " + JSON.stringify({ smtp: smtpCfg, appendFail: cfg.appendFail }));
    return json({ smtp: smtpCfg, appendFail: cfg.appendFail, smtpSent: smtpSeq, appended: appendSeq });
  }
  if (url.pathname === "/caplist") return json(readdirSync(CAP).sort());
  if (url.pathname === "/reseed") { seed(); log("ADMIN reseed (uidValidity " + uidValidity + ")"); return json({ uidValidity }); }
  if (url.pathname === "/log") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end(existsSync(LOG) ? readFileSync(LOG, "utf8") : "");
  }
  res.writeHead(404); res.end("no");
});

imap.listen(IMAP_PORT, "127.0.0.1", () => log(`imap stub on ${IMAP_PORT}`));
smtp.listen(SMTP_PORT, "127.0.0.1", () => log(`smtp stub on ${SMTP_PORT}`));
admin.listen(ADMIN_PORT, "127.0.0.1", () => log(`admin on ${ADMIN_PORT}`));

