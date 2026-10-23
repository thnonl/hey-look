// The APT repository on the website and in the workflows (WP15, spec-107-wp15-apt.md REQ-15.10, 15.13, 15.15). Run: node scripts/test-site-apt.mjs
//   - all 8 download pages carry the "Install with APT" block (<details id="apt"> in the Linux card, between the .rpm row and "Notes for Linux")
//     exactly as scripts/lib/site-apt.mjs builds it: the agreed text of the language (no English in a translated page), the five commands byte for
//     byte, five copy boxes with the page's own "Copy" label, the key fingerprint
//   - docs/apt/ holds exactly the armoured key, the binary key (the same single key) and heylook.sources (its exact text); the fingerprint on every
//     page is the fingerprint of the key file (needs gpg: CI has it; without gpg this part is skipped with a notice)
//   - docs/robots.txt blocks /apt/
//   - the workflows: every `uses:` is pinned by a full SHA, the container images of the install test by digest, pages.yml runs this test
//   - THE PLACEHOLDER KEY (DEC-020, DEC-001): until the owner's real signing key is committed, docs/apt carries a throw-away key with the UID
//     "Hey Look! APT test (throwaway)". That is a FAILURE here, in every mode (the website and a release must not go with a fingerprint nobody
//     can sign with). Only the exact value APT_ALLOW_PLACEHOLDER_KEY=1 turns this ONE check into a ::warning:: line; every other check stays strict.
//     Where the variable is set: release.yml, job node-tests, on every run that is not a tag push (so branch runs and dry runs are green with the
//     warning and a tag run fails). pages.yml and node-tests.txt never set it (scripts/test-apt-placeholder-guard.mjs keeps it that way).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LANGS } from "./generate-site-languages.mjs";
import { COMMANDS, KEYRING_PATH, PLACEHOLDER_UID, REAL_UID, SOURCES_FILE, TEXTS, aptBlock, groupFingerprint } from "./lib/site-apt.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const errors = [];
const notes = [];
const warnings = [];
const fail = (where, msg) => errors.push(`${where}: ${msg}`);

// ---------- the key files (gpg) ----------
// (the key goes in through stdin: no path for gpg to misread, whichever shell or system runs this)
function showKeys(file) {
  const r = spawnSync("gpg", ["--batch", "--no-tty", "--show-keys", "--with-colons"], { input: fs.readFileSync(path.join(root, file)) });
  r.stdout = r.stdout?.toString("utf8") ?? "";
  r.stderr = r.stderr?.toString("utf8") ?? "";
  if (r.error || r.status === null) return null; // no gpg
  if (r.status !== 0) return { error: r.stderr.trim() || `gpg exit ${r.status}` };
  const keys = [];
  let cur = null;
  for (const l of r.stdout.split("\n")) {
    const f = l.split(":");
    if (f[0] === "pub") keys.push((cur = { fpr: "", uids: [], algo: f[3], bits: f[2], caps: f[11], expires: f[6] }));
    else if (f[0] === "fpr" && cur && !cur.fpr) cur.fpr = f[9];
    else if (f[0] === "uid" && cur) cur.uids.push(f[9]);
    else if ((f[0] === "sub" || f[0] === "ssb") && cur) cur.subkeys = (cur.subkeys ?? 0) + 1;
  }
  return { keys };
}

let keyFpr = null; // the fingerprint of docs/apt/heylook-archive-keyring.asc
let placeholder = false;
const apt = fs.readdirSync(path.join(root, "docs/apt")).sort();
if (JSON.stringify(apt) !== JSON.stringify(["heylook-archive-keyring.asc", "heylook-archive-keyring.gpg", "heylook.sources"])) fail("docs/apt", `holds ${JSON.stringify(apt)}, expected the two key files and heylook.sources`);
if (fs.existsSync(path.join(root, "docs/apt/heylook.sources")) && read("docs/apt/heylook.sources") !== SOURCES_FILE) fail("docs/apt/heylook.sources", `is not the agreed deb822 text:\n${SOURCES_FILE}`);
if (fs.existsSync(path.join(root, "docs/apt/heylook-archive-keyring.gpg"))) {
  const asc = showKeys("docs/apt/heylook-archive-keyring.asc");
  const bin = showKeys("docs/apt/heylook-archive-keyring.gpg");
  if (asc === null || bin === null) {
    notes.push("gpg is not installed: the key files and the fingerprints on the pages were not compared (CI has gpg)");
  } else if (asc.error || bin.error) {
    fail("docs/apt", `gpg cannot read a key file: ${asc.error ?? bin.error}`);
  } else {
    if (asc.keys.length !== 1 || bin.keys.length !== 1) fail("docs/apt", `each key file holds exactly one key (asc ${asc.keys.length}, gpg ${bin.keys.length})`);
    else {
      const [a] = asc.keys;
      const [b] = bin.keys;
      if (a.fpr !== b.fpr) fail("docs/apt", `the armoured key (${a.fpr}) and the binary key (${b.fpr}) are not the same key`);
      if (a.algo !== "1" || a.bits !== "4096") fail("docs/apt", `the key is RSA 4096 (algorithm 1, 4096 bits), this one is algorithm ${a.algo}, ${a.bits} bits`);
      if (a.expires) fail("docs/apt", "the key expires: it must not (users download it once)");
      if (!/s/i.test(a.caps ?? "")) fail("docs/apt", `the key cannot sign (capabilities '${a.caps}')`);
      if (a.subkeys) fail("docs/apt", "the key has subkeys: the signing key is the primary key only");
      keyFpr = a.fpr;
      placeholder = a.uids.some((u) => u.includes("throwaway"));
      const uidOk = placeholder ? a.uids.includes(PLACEHOLDER_UID) : a.uids.length === 1 && a.uids[0] === REAL_UID;
      if (!uidOk) fail("docs/apt", `the key UID is ${JSON.stringify(a.uids)}, expected exactly "${REAL_UID}" (or the placeholder "${PLACEHOLDER_UID}")`);
      if (placeholder) {
        const msg = `docs/apt holds the throw-away key (${a.fpr}, UID "${PLACEHOLDER_UID}"), not the owner's signing key. Replace heylook-archive-keyring.asc/.gpg and the fingerprint on the 8 download pages (spec-107-wp15-apt.md section 12) before the website or a tag run uses them.`;
        if (process.env.APT_ALLOW_PLACEHOLDER_KEY === "1") warnings.push(`APT signing key is the throw-away placeholder (DEC-001): tag runs and Pages deploys fail until the real key is committed`);
        else fail("docs/apt", msg);
      }
    }
  }
}

// ---------- the download pages ----------
const decode = (s) => s.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const fprOnPages = new Map();
for (const l of LANGS) {
  const lang = l.hreflang; // en, vi, fr, zh-Hans, es, ja, de, ru
  const rel = l.dir ? `docs/${l.dir}/download.html` : "docs/download.html";
  const where = rel;
  if (!fs.existsSync(path.join(root, rel))) { fail(where, "missing"); continue; }
  const html = read(rel);
  const open = html.indexOf('<details id="apt">');
  if (open < 0) { fail(where, 'no <details id="apt"> block'); continue; }
  if (html.indexOf('<details id="apt">', open + 1) >= 0) fail(where, "the APT block is there twice");
  const close = html.indexOf("</details>", open) + "</details>".length;
  const block = html.slice(open, close);
  // the fingerprint the page shows
  const m = /<code>((?:[0-9A-F]{4} ){9}[0-9A-F]{4})<\/code>/.exec(block);
  if (!m) { fail(where, "no fingerprint of 10 groups of 4 hex digits in <code>"); continue; }
  const shown = m[1].replace(/ /g, "");
  fprOnPages.set(lang, shown);
  if (keyFpr && shown !== keyFpr) fail(where, `the fingerprint on the page (${groupFingerprint(shown)}) is not the one of docs/apt/heylook-archive-keyring.asc (${groupFingerprint(keyFpr)})`);
  // the button label is the page's own "Copy" (the macOS box)
  const copy = /<code>xattr[^<]*<\/code><button class="btn btn-ghost btn-sm" type="button">([^<]*)<\/button>/.exec(html)?.[1];
  if (!copy) { fail(where, "the macOS copy box (the source of the page's Copy label) was not found"); continue; }
  const want = aptBlock(lang, shown, copy).trimStart(); // (the block is cut at its first tag, the indent before it is not part of it)
  if (block.replace(/\r/g, "") !== want) {
    // say which line differs
    const a = block.split("\n"), b = want.split("\n");
    const at = a.findIndex((x, i) => x !== b[i]);
    fail(where, `the APT block is not the agreed one (first difference at line ${at + 1}):\n      page: ${a[at] ?? "(missing)"}\n      want: ${b[at] ?? "(extra line)"}`);
  }
  // the five commands, as the clipboard gets them (the text of the <code> after decoding)
  const boxes = [...block.matchAll(/<div class="copy"><code>([^<]*)<\/code><button/g)].map((x) => decode(x[1]));
  if (JSON.stringify(boxes) !== JSON.stringify(COMMANDS)) fail(where, `the copy boxes hold ${JSON.stringify(boxes)}`);
  // the block sits in the Linux card, after the .rpm row and before "Notes for Linux"
  const card = html.slice(html.indexOf('id="card-linux"'), html.indexOf("</article>", html.indexOf('id="card-linux"')));
  const iRpm = card.indexOf('data-asset="lin-rpm"');
  const iApt = card.indexOf('<details id="apt">');
  const iNotes = card.indexOf("<details><summary>");
  if (!(iRpm >= 0 && iRpm < iApt && iApt >= 0 && iApt < iNotes)) fail(where, "the APT block is not in #card-linux between the .rpm row and the Linux notes");
  // a translated page has no English sentence in the block
  if (lang !== "en") {
    for (const [k, v] of Object.entries(TEXTS[lang])) if (v === TEXTS.en[k]) fail(where, `the text '${k}' is still English`);
  }
}
if (new Set(fprOnPages.values()).size > 1) fail("download pages", `the pages show different fingerprints: ${[...fprOnPages].map(([k, v]) => `${k} ${v}`).join(", ")}`);
if (fprOnPages.size !== LANGS.length) fail("download pages", `${fprOnPages.size} of ${LANGS.length} pages carry a fingerprint`);

// ---------- robots.txt ----------
if (!read("docs/robots.txt").split(/\r?\n/).map((x) => x.trim()).includes("Disallow: /apt/")) fail("docs/robots.txt", 'no "Disallow: /apt/"');

// ---------- the workflows ----------
for (const f of [".github/workflows/release.yml", ".github/workflows/pages.yml"]) {
  read(f).split("\n").forEach((line, i) => {
    const u = /^\s*(?:-\s*)?uses:\s*([^\s#]+)/.exec(line);
    if (u && !u[1].startsWith("./") && !/@[0-9a-f]{40}$/.test(u[1])) fail(`${f}:${i + 1}`, `'${u[1]}' is not pinned by a full SHA`);
  });
}
{
  const t = read(".github/scripts/apt-install-test.sh");
  const imgs = [...t.matchAll(/^IMG_\w+='([^']+)'/gm)].map((x) => x[1]);
  if (imgs.length !== 3) fail("apt-install-test.sh", `${imgs.length} images, expected 3 (ubuntu:22.04, ubuntu:24.04, debian:12)`);
  for (const i of imgs) if (!/^(ubuntu:2[24]\.04|debian:12)@sha256:[0-9a-f]{64}$/.test(i)) fail("apt-install-test.sh", `image '${i}' is not pinned by digest`);
  const pages = read(".github/workflows/pages.yml");
  const at = pages.indexOf("node scripts/test-site-apt.mjs");
  if (at < 0 || at > pages.indexOf("actions/upload-pages-artifact")) fail("pages.yml", "does not run scripts/test-site-apt.mjs before it uploads the site");
  const rel = read(".github/workflows/release.yml");
  for (const need of ["apt-repo.sh fetch", "apt-install-test.sh local", "apt-repo.sh publish-branch", "gh workflow run pages.yml --ref main", "name: apt-repo-dryrun"]) if (!rel.includes(need)) fail("release.yml", `no '${need}'`);
  if (!KEYRING_PATH.startsWith("/etc/apt/keyrings/")) fail("site-apt.mjs", "the key goes to /etc/apt/keyrings");
}

for (const n of notes) console.log(`NOTE: ${n}`);
for (const w of warnings) console.log(`::warning::${w}`);
if (errors.length) {
  console.error(`test-site-apt: ${errors.length} problem(s)`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(`ok - test-site-apt (${LANGS.length} download pages, 5 commands each, key ${keyFpr ?? "not read"})`);
