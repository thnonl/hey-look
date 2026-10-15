#!/usr/bin/env node
// Checks that every updater signature (.sig) really belongs to the file it names, with the updater public key of tauri.conf.json.
// A file that changes after it was signed (Authenticode, stapling, a re-upload) would ship an update that every installed app rejects.
// Pure node (crypto), no minisign binary. Supports the minisign signature of the Tauri CLI (BLAKE2b-512 prehashed, "ED") and the
// legacy form ("Ed", the file itself is signed); the trusted comment (global signature) is checked too.
//
// Usage: verify-update-sigs.cjs [--conf src-tauri/tauri.conf.json | --pubkey <base64>] [--min N] <path>...
//   <path>: a .sig file, or a folder searched for *.sig (the signed file is the .sig name without ".sig", same folder).
//   --min N: fail when fewer than N signatures were checked (default 1: finding nothing is never a pass).
//   --selftest: run the built-in tests and exit.
// Exit 0 when every signature verifies, 1 otherwise (one line per file), 2 on a usage error.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

function edKey(raw32) {
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw32]), format: "der", type: "spki" });
}

// text of a minisign file: the Tauri files are base64 of the minisign text; a plain minisign text is accepted as well
function minisignText(content) {
  const t = String(content).trim();
  if (t.startsWith("untrusted comment:")) return t;
  const dec = Buffer.from(t, "base64").toString("utf8");
  if (!dec.startsWith("untrusted comment:")) throw new Error("not a minisign file (no 'untrusted comment' line)");
  return dec;
}

function parsePublicKey(content) {
  const lines = minisignText(content).split(/\r?\n/);
  const raw = Buffer.from((lines[1] || "").trim(), "base64");
  if (raw.length !== 42 || raw.toString("latin1", 0, 2) !== "Ed") throw new Error("bad public key (expected 42 bytes starting with 'Ed')");
  return { keyId: raw.subarray(2, 10), key: edKey(raw.subarray(10, 42)) };
}

function parseSignature(content) {
  const lines = minisignText(content).split(/\r?\n/);
  const raw = Buffer.from((lines[1] || "").trim(), "base64");
  const algo = raw.toString("latin1", 0, 2);
  if (raw.length !== 74 || (algo !== "Ed" && algo !== "ED")) throw new Error("bad signature line (expected 74 bytes starting with 'Ed' or 'ED')");
  const tc = lines[2] || "";
  if (!tc.startsWith("trusted comment: ")) throw new Error("no trusted comment line");
  const global = Buffer.from((lines[3] || "").trim(), "base64");
  if (global.length !== 64) throw new Error("bad global signature");
  return { prehashed: algo === "ED", keyId: raw.subarray(2, 10), sig: raw.subarray(10, 74), trusted: tc.slice("trusted comment: ".length), global };
}

function blake2b512(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("blake2b512");
    fs.createReadStream(file).on("data", (d) => h.update(d)).on("error", reject).on("end", () => resolve(h.digest()));
  });
}

// returns null when the signature is valid for the file, else the reason
async function verifyOne(pub, sigContent, file) {
  let s;
  try {
    s = parseSignature(sigContent);
  } catch (e) {
    return "signature file: " + e.message;
  }
  if (!s.keyId.equals(pub.keyId)) return "signed with another key (key id " + s.keyId.toString("hex") + ")";
  const msg = s.prehashed ? await blake2b512(file) : fs.readFileSync(file);
  if (!crypto.verify(null, msg, pub.key, s.sig)) return "the signature does not match the file (changed after it was signed?)";
  if (!crypto.verify(null, Buffer.concat([s.sig, Buffer.from(s.trusted, "utf8")]), pub.key, s.global)) return "the trusted comment is not signed by the key";
  return null;
}

function collect(p, out) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const n of fs.readdirSync(p).sort()) collect(path.join(p, n), out);
  } else if (p.endsWith(".sig")) {
    out.push(p);
  }
}

async function run(args) {
  let pubB64 = null, min = 1;
  const paths = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--conf") {
      const c = JSON.parse(fs.readFileSync(args[++i], "utf8"));
      pubB64 = c && c.plugins && c.plugins.updater && c.plugins.updater.pubkey;
    } else if (a === "--pubkey") pubB64 = args[++i];
    else if (a === "--min") min = Number(args[++i]);
    else if (a.startsWith("--")) { console.error("unknown option " + a); return 2; }
    else paths.push(a);
  }
  if (!pubB64 || !paths.length || !Number.isInteger(min) || min < 0) {
    console.error("usage: verify-update-sigs.cjs [--conf tauri.conf.json | --pubkey b64] [--min N] <path>...");
    return 2;
  }
  let pub;
  try {
    pub = parsePublicKey(pubB64);
  } catch (e) {
    console.error("updater public key: " + e.message);
    return 1;
  }
  const sigs = [];
  for (const p of paths) {
    if (!fs.existsSync(p)) { console.error("no such path: " + p); return 1; }
    collect(p, sigs);
  }
  let bad = 0;
  for (const sf of sigs) {
    const file = sf.slice(0, -4);
    if (!fs.existsSync(file)) { console.log("FAIL " + sf + ": the signed file '" + path.basename(file) + "' is missing"); bad++; continue; }
    const why = await verifyOne(pub, fs.readFileSync(sf, "utf8"), file);
    if (why) { console.log("FAIL " + file + ": " + why); bad++; } else console.log("ok   " + file);
  }
  if (sigs.length < min) { console.log("FAIL: found " + sigs.length + " signature(s), expected at least " + min); bad++; }
  console.log(bad ? bad + " problem(s)" : sigs.length + " update signature(s) verified");
  return bad ? 1 : 0;
}

// ---- self test: keys and signatures made here in the same format the Tauri CLI writes
function b64(s) { return Buffer.from(s, "utf8").toString("base64"); }

function makeKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(SPKI_ED25519.length);
  const keyId = crypto.randomBytes(8);
  const pubText = "untrusted comment: minisign public key: " + keyId.toString("hex").toUpperCase() + "\n" + Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64") + "\n";
  return { privateKey, keyId, pubB64: b64(pubText) };
}

function makeSig(k, data, { prehashed = true, trusted = "timestamp:1\tfile:x\tversion:1.0.0" } = {}) {
  const msg = prehashed ? crypto.createHash("blake2b512").update(data).digest() : data;
  const sig = crypto.sign(null, msg, k.privateKey);
  const global = crypto.sign(null, Buffer.concat([sig, Buffer.from(trusted)]), k.privateKey);
  const line = Buffer.concat([Buffer.from(prehashed ? "ED" : "Ed"), k.keyId, sig]).toString("base64");
  return b64("untrusted comment: signature from tauri secret key\n" + line + "\ntrusted comment: " + trusted + "\n" + global.toString("base64") + "\n");
}

async function selftest() {
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vus-"));
  let fails = 0;
  const t = (name, ok) => { console.log((ok ? "ok   " : "FAIL ") + name); if (!ok) fails++; };
  const k = makeKey(), other = makeKey();
  const pub = parsePublicKey(k.pubB64);
  const data = crypto.randomBytes(5000);
  const f = path.join(dir, "a-setup.exe");
  fs.writeFileSync(f, data);
  t("prehashed signature is valid", (await verifyOne(pub, makeSig(k, data), f)) === null);
  t("legacy signature is valid", (await verifyOne(pub, makeSig(k, data, { prehashed: false }), f)) === null);
  t("plain minisign text is accepted", (await verifyOne(pub, Buffer.from(makeSig(k, data), "base64").toString("utf8"), f)) === null);
  const sigGood = makeSig(k, data);
  fs.writeFileSync(f, Buffer.concat([data, Buffer.from([0])]));
  t("a changed file is rejected", (await verifyOne(pub, sigGood, f)) !== null);
  fs.writeFileSync(f, data);
  t("another key is rejected", (await verifyOne(pub, makeSig(other, data), f)) !== null);
  const text = Buffer.from(sigGood, "base64").toString("utf8");
  t("a changed trusted comment is rejected", (await verifyOne(pub, b64(text.replace("version:1.0.0", "version:9.9.9")), f)) !== null);
  t("garbage is rejected", (await verifyOne(pub, b64("hello"), f)) !== null);
  // the whole command: a folder, a missing file, --min
  fs.writeFileSync(f + ".sig", sigGood);
  const log = console.log; console.log = () => {};
  const r1 = await run(["--pubkey", k.pubB64, dir]);
  fs.writeFileSync(path.join(dir, "b.msi.sig"), sigGood);
  const r2 = await run(["--pubkey", k.pubB64, dir]);
  fs.unlinkSync(path.join(dir, "b.msi.sig"));
  const r3 = await run(["--pubkey", k.pubB64, "--min", "2", dir]);
  const r4 = await run(["--pubkey", k.pubB64, "--min", "1", fs.mkdtempSync(path.join(os.tmpdir(), "vus-empty-"))]);
  const r5 = await run(["--pubkey", other.pubB64, dir]);
  console.log = log;
  t("folder with one good signature passes", r1 === 0);
  t("a signature without its file fails", r2 === 1);
  t("--min 2 with one signature fails", r3 === 1);
  t("no signature at all fails", r4 === 1);
  t("the wrong public key fails", r5 === 1);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(fails ? fails + " self test(s) failed" : "self test ok");
  return fails ? 1 : 0;
}

const args = process.argv.slice(2);
(args[0] === "--selftest" ? selftest() : run(args)).then((c) => process.exit(c), (e) => { console.error(e && e.stack || e); process.exit(1); });
