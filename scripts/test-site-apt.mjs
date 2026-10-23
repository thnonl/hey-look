// The APT repository on the website and in the workflows (WP15, spec-107-wp15-apt.md REQ-15.10, 15.13, 15.15). Run: node scripts/test-site-apt.mjs [--built=_site]
// MODES (DEC-022): the environment variable APT_SITE says whether the site being built carries the repository. pages.yml sets it from one fact only
// (the branch `apt` exists: on, else off); nothing else may.
//   no APT_SITE   local and the static shard: the checks of the sources below; the throw-away key fails unless APT_ALLOW_PLACEHOLDER_KEY=1 (DEC-020)
//   APT_SITE=on   the same, and the throw-away key FAILS HARD (APT_ALLOW_PLACEHOLDER_KEY is ignored): a published branch `apt` with that key stops the deploy
//   APT_SITE=off  the same, but the throw-away key is not checked (the key files are not deployed), and with --built=_site the BUILT site must be
//                 dormant: no id="apt", no hl:apt- marker, no apt/ folder, no link to /apt/ or #apt, none of the 8 summary texts, none of the commands
//   --built=DIR   with APT_SITE=on: the built site has the block (one pair of markers, once) on each of the 8 download pages and the three files of apt/
// In every mode the sources are checked: each download page has exactly one pair <!-- hl:apt-begin --> ... <!-- hl:apt-end --> around the block, no other
// page has a marker, an id="apt", or a link to /apt/ or #apt.
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
import { APT_BEGIN, APT_END, COMMANDS, KEYRING_PATH, PLACEHOLDER_UID, REAL_UID, SOURCES_FILE, SUMMARIES, TEXTS, aptBlock, groupFingerprint } from "./lib/site-apt.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const errors = [];
const notes = [];
const warnings = [];
const fail = (where, msg) => errors.push(`${where}: ${msg}`);
const rawMode = process.env.APT_SITE;
if (rawMode !== undefined && rawMode !== "on" && rawMode !== "off") { console.error(`test-site-apt: APT_SITE is "${rawMode}", it must be on or off (or not set)`); process.exit(1); }
const mode = rawMode ?? "local";
const builtArg = process.argv.find((a) => a.startsWith("--built="));
const built = builtArg ? path.resolve(builtArg.slice("--built=".length)) : null;

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
      if (placeholder && mode === "off") {
        notes.push(`APT_SITE=off: the throw-away key (${a.fpr}) is not checked, the key files are not deployed`);
      } else if (placeholder) {
        const msg = `docs/apt holds the throw-away key (${a.fpr}, UID "${PLACEHOLDER_UID}"), not the owner's signing key. Replace heylook-archive-keyring.asc/.gpg and the fingerprint on the 8 download pages (spec-107-wp15-apt.md section 12) before the website or a tag run uses them.`;
        if (mode !== "on" && process.env.APT_ALLOW_PLACEHOLDER_KEY === "1") warnings.push(`APT signing key is the throw-away placeholder (DEC-001): tag runs and Pages deploys fail until the real key is committed`);
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
  const nBegin = html.split(APT_BEGIN).length - 1, nEnd = html.split(APT_END).length - 1;
  if (nBegin !== 1 || nEnd !== 1) { fail(where, `${nBegin} ${APT_BEGIN} and ${nEnd} ${APT_END} markers, expected exactly one pair around the APT block`); continue; }
  const open = html.indexOf(APT_BEGIN);
  const close = html.indexOf(APT_END) + APT_END.length;
  if (close <= open + APT_BEGIN.length) { fail(where, "the APT end marker comes before the begin marker"); continue; }
  const block = html.slice(open, close); // markers included
  if (!block.startsWith(`${APT_BEGIN}<details id="apt">`) || !block.endsWith(`</details>${APT_END}`)) { fail(where, "the markers do not wrap exactly one <details id=\"apt\"> element"); continue; }
  if (block.split("<details").length !== 2) fail(where, 'more than one <details> inside the markers');
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
  const iApt = card.indexOf(APT_BEGIN);
  const iNotes = card.indexOf("<details><summary>");
  if (!(iRpm >= 0 && iRpm < iApt && iApt >= 0 && iApt < iNotes)) fail(where, "the APT block is not in #card-linux between the .rpm row and the Linux notes");
  // a translated page has no English sentence in the block
  if (lang !== "en") {
    for (const [k, v] of Object.entries(TEXTS[lang])) if (v === TEXTS.en[k]) fail(where, `the text '${k}' is still English`);
  }
}
if (new Set(fprOnPages.values()).size > 1) fail("download pages", `the pages show different fingerprints: ${[...fprOnPages].map(([k, v]) => `${k} ${v}`).join(", ")}`);
if (fprOnPages.size !== LANGS.length) fail("download pages", `${fprOnPages.size} of ${LANGS.length} pages carry a fingerprint`);

// ---------- no other page mentions the block (DEC-022) ----------
const htmlOf = (dir) => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name.endsWith(".html")) out.push(f); } };
  walk(dir);
  return out;
};
const APT_LINK = /href\s*=\s*["'](?:(?:[^"']*\/)?apt\/|[^"']*#apt\b)/i; // apt/…, …/apt/…, …#apt
const isDownload = (rel) => /^(?:[a-z]{2}\/)?download\.html$/.test(rel);
for (const f of htmlOf(path.join(root, "docs"))) {
  const rel = path.relative(path.join(root, "docs"), f).replace(/\\/g, "/");
  let html = fs.readFileSync(f, "utf8");
  if (isDownload(rel)) {
    const a = html.indexOf(APT_BEGIN), z = html.indexOf(APT_END);
    if (a >= 0 && z > a) html = html.slice(0, a) + html.slice(z + APT_END.length); // (the block itself is checked above)
  } else if (html.includes("hl:apt-") || html.includes('id="apt"')) fail(`docs/${rel}`, "has an APT marker or id=\"apt\": only the 8 download pages have the block");
  if (APT_LINK.test(html)) fail(`docs/${rel}`, "links to /apt/ or #apt: nothing but the block itself may (the site is dormant until the repository exists)");
}

// ---------- the built site (--built=DIR) ----------
if (built) {
  if (!fs.existsSync(built)) fail("--built", `${built} does not exist`);
  else if (mode === "on") {
    for (const l of LANGS) {
      const rel = l.dir ? `${l.dir}/download.html` : "download.html";
      const f = path.join(built, rel);
      const html = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
      if (html.split(APT_BEGIN).length !== 2 || html.split('id="apt"').length !== 2) fail(`built ${rel}`, "APT_SITE=on: the page must carry the APT block exactly once");
    }
    for (const n of ["heylook-archive-keyring.asc", "heylook-archive-keyring.gpg", "heylook.sources"]) if (!fs.existsSync(path.join(built, "apt", n))) fail("built site", `APT_SITE=on: apt/${n} is missing`);
  } else if (mode === "off") {
    if (fs.existsSync(path.join(built, "apt"))) fail("built site", "APT_SITE=off: the folder apt/ is in the site");
    const summaries = SUMMARIES();
    for (const f of htmlOf(built)) {
      const rel = path.relative(built, f).replace(/\\/g, "/");
      const html = fs.readFileSync(f, "utf8");
      if (html.includes('id="apt"')) fail(`built ${rel}`, 'APT_SITE=off: has id="apt"');
      if (html.includes("hl:apt-")) fail(`built ${rel}`, "APT_SITE=off: has an hl:apt- marker");
      if (APT_LINK.test(html)) fail(`built ${rel}`, "APT_SITE=off: links to /apt/ or #apt");
      for (const t of summaries) if (html.includes(t)) fail(`built ${rel}`, `APT_SITE=off: has the APT summary text "${t}"`);
      if (html.includes("heylook-archive-keyring") || html.includes("apt install hey-look")) fail(`built ${rel}`, "APT_SITE=off: has an APT command");
    }
    for (const l of LANGS) if (!fs.existsSync(path.join(built, l.dir ? `${l.dir}/download.html` : "download.html"))) fail("built site", `the download page of ${l.hreflang} is missing`);
  } else fail("--built", "needs APT_SITE=on or APT_SITE=off (the check depends on it)");
}

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
  // DEC-022: the second call, on the built site, sits between the build and the upload
  const builtAt = pages.indexOf("node scripts/test-site-apt.mjs --built=_site");
  if (!(pages.indexOf("node scripts/build-site.mjs _site") < builtAt && builtAt < pages.indexOf("actions/upload-pages-artifact"))) fail("pages.yml", "does not check the built site (test-site-apt.mjs --built=_site) between the build and the upload");
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
console.log(`ok - test-site-apt (mode ${mode}${built ? `, built site ${mode === "off" ? "dormant" : "with the block"}` : ""}; ${LANGS.length} download pages, 5 commands each, key ${keyFpr ?? "not read"})`);
