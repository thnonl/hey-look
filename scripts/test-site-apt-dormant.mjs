// The website is dormant until the APT repository exists (DEC-022). Run: node scripts/test-site-apt-dormant.mjs
// Builds the site with scripts/build-site.mjs into scratch folders and proves, on the built files:
//   AC-DEC022.1  APT_SITE=off (also: not set, "ON", "1", "true", empty): no apt/ folder, no block, marker, id="apt", link or APT text in any page; the
//                8 download pages still have their Linux card; test-site-apt.mjs --built passes
//   AC-DEC022.3  mutations of the built site are found by `test-site-apt.mjs --built`, each naming its file: a link to /apt/ in help.html, a link to
//                #apt on the home page, a marker left on a translated download page, an apt/ folder, the English summary on a German page, an id="apt"
//   AC-DEC022.4  APT_SITE=on keeps the block on the 8 pages and docs/apt/ in the site (the --built check finds nothing missing); with the throw-away key
//                the run still fails, and ONLY because of the key (also with APT_ALLOW_PLACEHOLDER_KEY=1); a page that lost its block fails it
// The post-deploy checks (AC-DEC022.5, .6) look at the live site and are not part of this test.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TEXTS } from "./lib/site-apt.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hl-dormant-"));
const errors = [];
const ok = (cond, msg) => { if (!cond) errors.push(msg); };

const baseEnv = () => { const e = { ...process.env }; delete e.APT_SITE; delete e.APT_ALLOW_PLACEHOLDER_KEY; return e; };
const build = (name, aptSite) => {
  const out = path.join(tmp, name);
  const env = baseEnv();
  if (aptSite !== undefined) env.APT_SITE = aptSite;
  const r = spawnSync(process.execPath, [path.join(root, "scripts/build-site.mjs"), out], { env, encoding: "utf8" });
  if (r.status !== 0) errors.push(`build ${name} (APT_SITE=${JSON.stringify(aptSite)}) failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ")}`);
  return out;
};
const check = (dir, mode, extra = {}) => {
  const env = { ...baseEnv(), APT_SITE: mode, ...extra };
  const r = spawnSync(process.execPath, [path.join(root, "scripts/test-site-apt.mjs"), `--built=${dir}`], { env, encoding: "utf8" });
  return { status: r.status, text: `${r.stdout}\n${r.stderr}` };
};
const copy = (from, name) => { const to = path.join(tmp, name); fs.cpSync(from, to, { recursive: true }); return to; };
const edit = (dir, rel, fn) => { const f = path.join(dir, rel); fs.writeFileSync(f, fn(fs.readFileSync(f, "utf8"))); };

try {
  // ---- off: the default and every other value than "on"
  for (const v of [undefined, "off", "ON", "1", "true", ""]) {
    const dir = build(`off-${String(v)}`, v);
    const r = check(dir, "off");
    ok(r.status === 0, `a site built with APT_SITE=${JSON.stringify(v)} is not dormant: ${r.text.split("\n").filter((l) => l.trim()).slice(0, 4).join(" | ")}`);
    ok(!fs.existsSync(path.join(dir, "apt")), `APT_SITE=${JSON.stringify(v)}: the folder apt/ is in the built site`);
    for (const rel of ["download.html", "de/download.html", "zh/download.html"]) {
      const h = fs.readFileSync(path.join(dir, rel), "utf8");
      ok(h.includes('id="card-linux"') && h.includes('data-asset="lin-rpm"') && h.includes('<details><summary>'), `${rel}: the Linux card (rpm row, notes) is not there after the block was taken out`);
    }
  }
  const off = path.join(tmp, "off-undefined");

  // ---- mutations of a dormant site: each is found, naming the file
  const muts = [
    ["a link to /apt/ in help.html", "help.html", (h) => h.replace("</main>", '<p><a href="/apt/">apt</a></p></main>'), "help.html"],
    ["a link to #apt on the home page", "index.html", (h) => h.replace("</main>", '<p><a href="download.html#apt">apt</a></p></main>'), "index.html"],
    ["a relative link to apt/ in the privacy page", "privacy.html", (h) => h.replace("</main>", '<p><a href="apt/heylook.sources">s</a></p></main>'), "privacy.html"],
    ["a marker left on a translated download page", "fr/download.html", (h) => h.replace("</main>", "<!-- hl:apt-begin --></main>"), "fr/download.html"],
    ["an id=\"apt\" on a page", "ja/download.html", (h) => h.replace("</main>", '<details id="apt"></details></main>'), "ja/download.html"],
    ["the English summary on a German page", "de/download.html", (h) => h.replace("</main>", `<p>${TEXTS.en.summary}</p></main>`), "de/download.html"],
    ["the Russian summary on the English page", "download.html", (h) => h.replace("</main>", `<p>${TEXTS.ru.summary}</p></main>`), "download.html"],
    ["an APT command on the help page", "help.html", (h) => h.replace("</main>", "<p>sudo apt install hey-look</p></main>"), "help.html"],
  ];
  for (const [name, rel, fn, want] of muts) {
    const dir = copy(off, `mut-${name.replace(/\W+/g, "-")}`);
    edit(dir, rel, fn);
    const r = check(dir, "off");
    ok(r.status === 1 && r.text.includes(want), `dormant mutation not found (${name}): exit ${r.status}, ${r.text.trim().split("\n").slice(0, 3).join(" | ")}`);
  }
  {
    const dir = copy(off, "mut-apt-folder");
    fs.mkdirSync(path.join(dir, "apt"));
    fs.writeFileSync(path.join(dir, "apt", "heylook.sources"), "x");
    const r = check(dir, "off");
    ok(r.status === 1 && r.text.includes("apt/"), `an apt/ folder in a dormant site is not found: exit ${r.status}`);
  }

  // ---- on: the block and the files stay; with the throw-away key the run fails, and only because of the key
  const on = build("on", "on");
  for (const allow of [undefined, "1"]) {
    const r = check(on, "on", allow === undefined ? {} : { APT_ALLOW_PLACEHOLDER_KEY: allow });
    const lines = r.text.split("\n").filter((l) => /^\s+\S.*: /.test(l) && !/^test-site-apt/.test(l.trim()));
    if (r.status === 0) ok(true, "");
    else ok(r.status === 1 && lines.length === 1 && /throw-away/.test(lines[0]), `APT_SITE=on${allow ? " + APT_ALLOW_PLACEHOLDER_KEY=1" : ""}: expected nothing or only the throw-away key to fail, got: ${lines.join(" | ").slice(0, 300)}`);
  }
  ok(fs.existsSync(path.join(on, "apt", "heylook.sources")) && fs.existsSync(path.join(on, "apt", "heylook-archive-keyring.gpg")), "APT_SITE=on: docs/apt/ is not in the built site");
  {
    const dir = copy(on, "mut-on-lost-block");
    edit(dir, "es/download.html", (h) => h.replace(/<!-- hl:apt-begin -->[\s\S]*?<!-- hl:apt-end -->/, ""));
    const r = check(dir, "on");
    ok(r.status === 1 && r.text.includes("es/download.html"), `APT_SITE=on: a page without the block is not found (exit ${r.status})`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (errors.length) {
  console.error(`test-site-apt-dormant: ${errors.length} problem(s)`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log("ok - test-site-apt-dormant (6 off values build a dormant site, 9 mutations found, APT_SITE=on keeps block and files and fails only on the throw-away key)");
