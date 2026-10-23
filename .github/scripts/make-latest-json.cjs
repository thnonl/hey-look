// Writes and checks the updater manifest `latest.json` of a release. No network access.
//
//   node make-latest-json.cjs generate --version 1.0.0 --assets assets.json --sigs <dir> --notes notes.md [--base-url <url>] > latest.json
//   node make-latest-json.cjs check latest.json --version 1.0.0 [--base-url <url>]
//
// assets.json: [{ "name": "HeyLook_1.0.0_windows_x64-setup.exe", "size": 123 }, ...] (the draft's assets)
// <dir>: one `<asset name>.sig` file per signed installer (the text of the .sig file)
// --base-url replaces https://github.com/thnonl/hey-look/releases/download/v<version>/ (local tests only).
// Exit code 0 = ok, 1 = problems (one line each on stderr).
const fs = require("fs");
const path = require("path");

const REPO_BASE = (v) => `https://github.com/thnonl/hey-look/releases/download/v${v}/`;

// updater platform key -> the installer it points to (asset name ends with)
const PLATFORMS = {
  "windows-x86_64-nsis": "-setup.exe",
  "windows-x86_64": "-setup.exe",
  "windows-x86_64-msi": ".msi",
  "darwin-aarch64-app": ".app.tar.gz",
  "darwin-x86_64-app": ".app.tar.gz",
  "darwin-aarch64": ".app.tar.gz",
  "darwin-x86_64": ".app.tar.gz",
  "linux-x86_64-appimage": ".AppImage",
  "linux-x86_64": ".AppImage",
  "linux-x86_64-deb": ".deb",
  "linux-x86_64-rpm": ".rpm",
};

const problems = [];
const problem = (m) => problems.push(m);

function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) o[argv[i].slice(2)] = argv[++i];
    else o._.push(argv[i]);
  }
  return o;
}

/** The signature text of a .sig file, minus a final newline only. */
const sigText = (s) => s.replace(/\r?\n$/, "");

/** A minisign signature file, base64 of its text: must be non-empty and carry a trusted comment that names the version. */
function signatureProblem(sig, version) {
  if (!sig || !sig.trim()) return "empty signature";
  if (!/^[A-Za-z0-9+/=\s]+$/.test(sig)) return "signature is not base64";
  let text;
  try {
    text = Buffer.from(sig, "base64").toString("utf8");
  } catch {
    return "signature is not base64";
  }
  const line = text.split(/\r?\n/).find((l) => l.startsWith("trusted comment:"));
  if (!line) return "signature has no trusted comment";
  if (!new RegExp(`(^|[^0-9.])${version.replace(/\./g, "\\.")}($|[^0-9.])`).test(line)) return `trusted comment does not mention version ${version}`;
  return null;
}

/** https://github.com/thnonl/hey-look/releases/download/v<version>/<file> (or `base` + file in local tests). */
function urlProblem(url, version, base) {
  if (base) return url.startsWith(base) && url.length > base.length && !url.slice(base.length).includes("/") ? null : `url is not under ${base}`;
  let u;
  try {
    u = new URL(url);
  } catch {
    return "url does not parse";
  }
  if (u.protocol !== "https:" || u.hostname !== "github.com" || u.username || u.password || u.port || u.search || u.hash) return "url is not a plain https://github.com link";
  if (/%2e/i.test(url) || url.includes("\\")) return "url hides a dot segment";
  const seg = u.pathname.split("/").slice(1);
  const ok =
    seg.length === 6 && seg[0] === "thnonl" && seg[1] === "hey-look" && seg[2] === "releases" && seg[3] === "download" && seg[4] === `v${version}` &&
    seg.every((s) => s && s !== "." && s !== "..");
  return ok ? null : "url is not .../thnonl/hey-look/releases/download/v<version>/<file>";
}

function generate(o) {
  const version = o.version;
  if (!version || !o.assets || !o.sigs || !o.notes) throw new Error("generate needs --version --assets --sigs --notes");
  const assets = JSON.parse(fs.readFileSync(o.assets, "utf8"));
  const base = o["base-url"];
  const prefix = base || REPO_BASE(version);
  const platforms = {};
  for (const [key, ext] of Object.entries(PLATFORMS)) {
    const found = assets.filter((a) => a.name.endsWith(ext) && !a.name.endsWith(`${ext}.sig`));
    if (found.length !== 1) {
      problem(`${key}: expected exactly one asset ending in '${ext}', found ${found.length}`);
      continue;
    }
    const a = found[0];
    const sigFile = path.join(o.sigs, `${a.name}.sig`);
    if (!fs.existsSync(sigFile)) {
      problem(`${key}: signature file ${a.name}.sig is missing`);
      continue;
    }
    const signature = sigText(fs.readFileSync(sigFile, "utf8"));
    const sp = signatureProblem(signature, version);
    if (sp) {
      problem(`${key}: ${a.name}.sig: ${sp}`);
      continue;
    }
    platforms[key] = { signature, url: prefix + a.name, size: a.size };
  }
  // nothing may be left over: every asset is a known installer, its signature, or the manifest itself
  for (const a of assets) {
    const known = Object.values(PLATFORMS).some((ext) => a.name.endsWith(ext) || a.name.endsWith(`${ext}.sig`)) || a.name.endsWith(".dmg");
    // (WP14 option B: the Store's offline installer is a release asset that the updater never uses; it is not in latest.json and no platform key points at it)
    if (!known && a.name !== "latest.json" && a.name !== `HeyLook_${version}_windows_x64_offline.exe`) problem(`unexpected asset: ${a.name}`);
  }
  if (problems.length) return null;
  const notes = fs.readFileSync(o.notes, "utf8").replace(/^\s+|\s+$/g, "");
  return { version, notes, pub_date: new Date().toISOString().replace(/\.\d+Z$/, "Z"), platforms };
}

function check(file, o) {
  const version = o.version;
  const base = o["base-url"];
  const text = fs.readFileSync(file, "utf8");
  if (Buffer.byteLength(text) >= 64 * 1024) problem("latest.json is 64 KB or more");
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    problem("latest.json is not valid JSON");
    return;
  }
  if (j.version !== version) problem(`version is '${j.version}', expected '${version}'`);
  const keys = Object.keys(j.platforms || {}).sort();
  const want = Object.keys(PLATFORMS).sort();
  for (const k of want) if (!keys.includes(k)) problem(`missing platform ${k}`);
  for (const k of keys) if (!want.includes(k)) problem(`unexpected platform ${k}`);
  for (const k of keys) {
    const p = j.platforms[k];
    if (!want.includes(k)) continue;
    const up = urlProblem(String(p.url), version, base);
    if (up) problem(`${k}: ${up}`);
    else if (!String(p.url).endsWith(PLATFORMS[k])) problem(`${k}: url does not end with ${PLATFORMS[k]}`);
    const sp = signatureProblem(p.signature, version);
    if (sp) problem(`${k}: ${sp}`);
    if (!Number.isInteger(p.size) || p.size <= 0) problem(`${k}: size is not a positive number`);
  }
  if (typeof j.notes !== "string") problem("notes is not a string");
  if (!j.pub_date || Number.isNaN(Date.parse(j.pub_date))) problem("pub_date is not a date");
}

const [mode, ...rest] = process.argv.slice(2);
const o = args(rest);
try {
  if (mode === "generate") {
    const out = generate(o);
    if (!problems.length) process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  } else if (mode === "check") {
    if (!o._[0] || !o.version) throw new Error("check needs <file> --version");
    check(o._[0], o);
  } else {
    throw new Error("usage: make-latest-json.cjs generate|check ...");
  }
} catch (e) {
  problem(e.message);
}
for (const m of problems) console.error(`problem: ${m}`);
process.exit(problems.length ? 1 : 0);
