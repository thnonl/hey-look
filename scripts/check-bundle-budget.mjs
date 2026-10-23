// Bundle budget gate (WP9a, W9.0). Builds the production frontend into a temporary folder and checks it against scripts/bundle-budget.json:
//   B1/B2 initial JavaScript (entry chunk + its static import closure = the tags of index.html), gzip level 9 and raw
//   B3    the largest language chunk (from WP9c)      B4 every other JavaScript chunk, gzip     B5 CSS, gzip
//   B6    modules that must stay out of the initial set (named with the importer chain if not)   B7 modules that must never be emitted
//
//   node scripts/check-bundle-budget.mjs                          build into a temp folder, measure, check
//   node scripts/check-bundle-budget.mjs --build-only --out=<dir> --modules=<json>   build into <dir>, write the module report, no check
//   node scripts/check-bundle-budget.mjs --dist=<dir> [--modules=<json>]            measure an existing build (module checks need the json)
//   --json=<file>       write the report        --baseline=<report.json>   print the change per measure
//   --budget=<file>     another budget file     --selftest                 run on scripts/fixtures/bundle/
// Exit 1 on any violation. KB are 1,000 bytes. Raising a budget = a change of bundle-budget.json with a `history` entry (see its "policy").
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.some((a) => a === `--${name}`);
const opt = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
};

const gz = (buf) => zlib.gzipSync(buf, { level: 9 }).length;
const fmt = (n) => n.toLocaleString("en-US");
const posix = (p) => p.split(path.sep).join("/");

// ---------- budget file ----------

const NUMERIC = ["initialJsGzip", "initialJsRaw", "langChunkGzip", "lazyChunkGzip", "cssGzip"];

/** Every budget value needs a reason; returns the list of problems (empty = valid). */
export function validateBudget(b) {
  const bad = [];
  for (const k of NUMERIC) {
    const v = b[k];
    if (v === undefined) bad.push(`${k}: missing`);
    else if (v === null) continue; // not in force yet (e.g. langChunkGzip before WP9c)
    else if (typeof v.bytes !== "number" || v.bytes <= 0) bad.push(`${k}: "bytes" must be a positive number`);
    if (v && typeof v.reason !== "string") bad.push(`${k}: no reason`);
    else if (v && !v.reason.trim()) bad.push(`${k}: empty reason`);
  }
  for (const [i, e] of (b.exceptions ?? []).entries()) {
    if (!e.match || typeof e.gzip !== "number") bad.push(`exceptions[${i}]: needs "match" and "gzip"`);
    if (!e.reason?.trim()) bad.push(`exceptions[${i}] (${e.match}): no reason`);
  }
  for (const [i, e] of (b.mustBeLazy ?? []).entries()) {
    if (!e.module) bad.push(`mustBeLazy[${i}]: needs "module"`);
    if (!e.reason?.trim()) bad.push(`mustBeLazy[${i}] (${e.module}): no reason`);
    if (!e.since?.trim()) bad.push(`mustBeLazy[${i}] (${e.module}): no "since"`);
  }
  for (const [i, e] of (b.neverShipped ?? []).entries()) {
    if (!e.module) bad.push(`neverShipped[${i}]: needs "module"`);
    if (!e.reason?.trim()) bad.push(`neverShipped[${i}] (${e.module}): no reason`);
  }
  for (const [i, e] of (b.history ?? []).entries()) {
    for (const f of ["date", "branch", "field", "reason"]) if (!e[f]) bad.push(`history[${i}]: no "${f}"`);
  }
  return bad;
}

function loadBudget(file) {
  const b = JSON.parse(fs.readFileSync(file, "utf8"));
  const bad = validateBudget(b);
  if (bad.length) {
    console.error(`budget file ${file} is not valid:\n  ` + bad.join("\n  "));
    process.exit(1);
  }
  return b;
}

// ---------- build (vite JS API) + the module recorder ----------

/** Module ids as repo-relative posix paths ("src/App.tsx", "node_modules/react-dom/..."); ids with a \0 prefix or a ?query are kept readable. */
function relId(id) {
  let s = id.replace(/^\0/, "");
  const q = s.indexOf("?");
  if (q > 0) s = s.slice(0, q);
  if (path.isAbsolute(s)) s = posix(path.relative(ROOT, s));
  return s.replace(/^(\.\.\/)+node_modules\//, "node_modules/"); // (a worktree with a node_modules junction to the main clone: the same ids as in the main clone and on CI)
}

async function buildInto(outDir) {
  const { build } = await import("vite");
  const report = { chunks: [], importers: {}, entryModules: [], html: "" };
  const recorder = {
    name: "bundle-budget-recorder",
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) {
        if (item.type === "asset") {
          if (item.fileName === "index.html") report.html = String(item.source);
          continue;
        }
        const modules = {};
        for (const [id, m] of Object.entries(item.modules ?? {})) {
          modules[relId(id)] = m.renderedLength ?? 0;
          const info = this.getModuleInfo?.(id);
          if (info) {
            report.importers[relId(id)] = [...new Set(info.importers.map(relId))];
            if (info.isEntry) report.entryModules.push(relId(id));
          }
        }
        report.chunks.push({
          file: item.fileName,
          isEntry: item.isEntry,
          imports: item.imports,
          dynamicImports: item.dynamicImports,
          modules,
        });
      }
    },
  };
  await build({
    root: ROOT,
    configFile: path.join(ROOT, "vite.config.ts"),
    logLevel: "error",
    plugins: [recorder],
    build: { outDir, emptyOutDir: true, copyPublicDir: false, reportCompressedSize: false },
  });
  return report;
}

// ---------- measuring ----------

/** js/css files named by index.html: <script type="module" src>, <link rel="modulepreload" href>, <link rel="stylesheet" href>; `publicJs`: the classic
 *  <script src> of files in public/ (the theme read of the start screen: not part of the bundle graph, but initial JavaScript all the same). */
export function htmlAssets(html) {
  const js = new Set();
  const css = new Set();
  const publicJs = new Set();
  for (const tag of html.match(/<(?:script|link)\b[^>]*>/gi) ?? []) {
    const url = /\b(?:src|href)="([^"]+)"/i.exec(tag)?.[1];
    if (!url || /^[a-z]+:\/\//i.test(url)) continue;
    const file = url.replace(/^\.?\/+/, "");
    if (/<script\b/i.test(tag) && /type="module"/i.test(tag)) js.add(file);
    else if (/<script\b/i.test(tag)) publicJs.add(file);
    else if (/rel="modulepreload"/i.test(tag)) js.add(file);
    else if (/rel="stylesheet"/i.test(tag)) css.add(file);
  }
  return { js: [...js], css: [...css], publicJs: [...publicJs] };
}

/** Static import closure of `entries` over `imports` (file names); unknown files are returned in `missing`. */
export function closure(entries, importsOf) {
  const seen = new Set();
  const missing = [];
  const walk = (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    const deps = importsOf(f);
    if (!deps) {
      missing.push(f);
      return;
    }
    deps.forEach(walk);
  };
  entries.forEach(walk);
  return { files: seen, missing };
}

const globRe = (g) => new RegExp("^" + g.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
const matches = (pattern, name) => (pattern.includes("*") ? globRe(pattern).test(name) : pattern === name);

/** Shortest static importer chain from an entry module down to `id`. */
function chain(id, report) {
  const entries = new Set(report.entryModules);
  const prev = new Map([[id, null]]);
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift();
    if (entries.has(cur)) {
      const out = [];
      for (let n = cur; n !== null; n = prev.get(n)) out.push(n);
      return out;
    }
    for (const imp of report.importers[cur] ?? []) {
      if (!prev.has(imp)) {
        prev.set(imp, cur);
        queue.push(imp);
      }
    }
  }
  return [id];
}

/** All measures of a build folder (+ module report). Pure over the files; used for the real build and for the fixtures. */
export function measure(dist, report) {
  const html = report?.html || fs.readFileSync(path.join(dist, "index.html"), "utf8");
  const tags = htmlAssets(html);
  // (the files of public/ are not copied into this build, `copyPublicDir: false`: what index.html names that is not in the build is read from public/)
  const read = (f) => fs.readFileSync(fs.existsSync(path.join(dist, f)) ? path.join(dist, f) : path.join(ROOT, "public", f));
  const m = { initial: [], css: [], lazy: [], errors: [], tagFiles: tags.js };

  let initialFiles = tags.js;
  if (report) {
    const byFile = new Map(report.chunks.map((c) => [c.file, c]));
    const entries = report.chunks.filter((c) => c.isEntry).map((c) => c.file);
    const { files, missing } = closure(entries, (f) => byFile.get(f)?.imports);
    const a = [...files].sort();
    const b = [...tags.js].sort();
    if (missing.length || a.join("|") !== b.join("|")) {
      m.errors.push(
        `the initial set differs between the bundle graph and index.html: graph-only [${a.filter((x) => !b.includes(x)).join(", ")}], html-only [${b.filter((x) => !a.includes(x)).join(", ")}]` +
          (missing.length ? `, missing chunks [${missing.join(", ")}]` : ""),
      );
    }
    initialFiles = [...files];
  }
  const initialSet = new Set(initialFiles);
  for (const f of [...initialFiles.sort(), ...(tags.publicJs ?? [])]) {
    const buf = read(f);
    m.initial.push({ file: f, raw: buf.length, gzip: gz(buf) });
  }
  for (const f of tags.css) {
    const buf = read(f);
    m.css.push({ file: f, raw: buf.length, gzip: gz(buf) });
  }
  const jsFiles = report ? report.chunks.map((c) => c.file) : fs.readdirSync(path.join(dist, "assets")).map((f) => `assets/${f}`).filter((f) => f.endsWith(".js"));
  for (const f of jsFiles) {
    if (initialSet.has(f)) continue;
    const buf = read(f);
    m.lazy.push({ file: f, raw: buf.length, gzip: gz(buf) });
  }
  m.initialRaw = m.initial.reduce((s, x) => s + x.raw, 0);
  m.initialGzip = m.initial.reduce((s, x) => s + x.gzip, 0);
  m.cssGzip = m.css.reduce((s, x) => s + x.gzip, 0);
  if (report) {
    const mods = [];
    for (const c of report.chunks) {
      if (!initialSet.has(c.file)) continue;
      for (const [id, bytes] of Object.entries(c.modules)) mods.push({ id, bytes, chunk: c.file });
    }
    m.topModules = mods.sort((x, y) => y.bytes - x.bytes).slice(0, 15);
    m.initialModules = new Set(mods.map((x) => x.id));
    m.allModules = new Map(report.chunks.flatMap((c) => Object.keys(c.modules).map((id) => [id, c.file])));
    m.report = report;
  }
  return m;
}

/** Violations and the budget table lines. */
export function check(m, budget) {
  const violations = [];
  const rows = [];
  const row = (label, value, limit) => {
    rows.push({ label, value, limit });
    if (limit != null && value > limit) violations.push(`${label} ${fmt(value)} B > ${fmt(limit)} B (+${fmt(value - limit)} B)`);
  };
  row("initial JS gzip", m.initialGzip, budget.initialJsGzip?.bytes ?? null);
  row("initial JS raw", m.initialRaw, budget.initialJsRaw?.bytes ?? null);
  row("CSS gzip", m.cssGzip, budget.cssGzip?.bytes ?? null);
  const lazyCap = budget.lazyChunkGzip?.bytes ?? null;
  for (const c of m.lazy) {
    const ex = (budget.exceptions ?? []).find((e) => matches(e.match, c.file) || matches(e.match, path.posix.basename(c.file)));
    const cap = ex ? ex.gzip : lazyCap;
    if (cap != null && c.gzip > cap) violations.push(`lazy chunk ${c.file} gzip ${fmt(c.gzip)} B > ${fmt(cap)} B (+${fmt(c.gzip - cap)} B)${ex ? ` (exception: ${ex.reason})` : ""}`);
  }
  const biggestLazy = [...m.lazy].sort((a, b) => b.gzip - a.gzip)[0];
  rows.push({ label: `largest lazy chunk gzip${biggestLazy ? ` (${path.posix.basename(biggestLazy.file)})` : ""}`, value: biggestLazy?.gzip ?? 0, limit: lazyCap });
  if (budget.langChunkGzip) {
    const langs = m.lazy.filter((c) => /(^|\/)(lang|locale)-/i.test(c.file));
    const worst = langs.sort((a, b) => b.gzip - a.gzip)[0];
    rows.push({ label: "largest language chunk gzip", value: worst?.gzip ?? 0, limit: budget.langChunkGzip.bytes });
    for (const c of langs) if (c.gzip > budget.langChunkGzip.bytes) violations.push(`language chunk ${c.file} gzip ${fmt(c.gzip)} B > ${fmt(budget.langChunkGzip.bytes)} B (+${fmt(c.gzip - budget.langChunkGzip.bytes)} B)`);
  } else rows.push({ label: "largest language chunk gzip", value: null, limit: null, note: "not in force (one i18n chunk until WP9c)" });
  m.errors.forEach((e) => violations.push(e));

  if (m.report) {
    for (const e of budget.mustBeLazy ?? []) {
      const hits = [...m.initialModules].filter((id) => matches(e.module, id));
      for (const id of hits) violations.push(`${id} must stay lazy (${e.reason}) but is in the initial set: ${chain(id, m.report).join(" -> ")}`);
    }
    for (const e of budget.neverShipped ?? []) {
      const hits = [...m.allModules].filter(([id]) => matches(e.module, id));
      for (const [id, file] of hits) violations.push(`${id} must never be shipped (${e.reason}) but is emitted in ${file}`);
    }
  }
  return { violations, rows };
}

function printReport(m, budget, res, baseline) {
  const w = Math.max(...m.initial.map((x) => x.file.length), 10);
  console.log("Initial JavaScript (entry + static imports = index.html):");
  console.log(`  ${"file".padEnd(w)}  ${"raw".padStart(10)}  ${"gzip".padStart(9)}`);
  for (const x of m.initial) console.log(`  ${x.file.padEnd(w)}  ${fmt(x.raw).padStart(10)}  ${fmt(x.gzip).padStart(9)}`);
  console.log(`  ${"total".padEnd(w)}  ${fmt(m.initialRaw).padStart(10)}  ${fmt(m.initialGzip).padStart(9)}  (${m.initial.length} files)`);
  if (m.topModules) {
    console.log("\n15 biggest modules of the initial set (rendered bytes):");
    for (const x of m.topModules) console.log(`  ${fmt(x.bytes).padStart(10)}  ${x.id}`);
  }
  console.log("\nBudgets:");
  for (const r of res.rows) {
    if (r.note) console.log(`  ${r.label.padEnd(52)} ${r.note}`);
    else if (r.limit == null) console.log(`  ${r.label.padEnd(52)} ${fmt(r.value).padStart(10)} B  (no limit)`);
    else console.log(`  ${r.label.padEnd(52)} ${fmt(r.value).padStart(10)} B  limit ${fmt(r.limit).padStart(10)} B  headroom ${fmt(r.limit - r.value).padStart(9)} B`);
  }
  if (!m.report) console.log("  (module checks - mustBeLazy, neverShipped, graph cross-check - skipped: no --modules report)");
  if (baseline) {
    console.log(`\nChange against the baseline (${baseline.label}):`);
    const d = (label, now, then, unit = " B") => console.log(`  ${label.padEnd(20)} ${fmt(then).padStart(10)} -> ${fmt(now).padStart(10)}  (${now - then >= 0 ? "+" : "-"}${fmt(Math.abs(now - then))}${unit})`);
    d("initial JS gzip", m.initialGzip, baseline.initialGzip);
    d("initial JS raw", m.initialRaw, baseline.initialRaw);
    d("CSS gzip", m.cssGzip, baseline.cssGzip);
    d("initial files", m.initial.length, baseline.initialFiles, "");
  }
  if (res.violations.length) {
    console.log("");
    for (const v of res.violations) console.log(`budget violation: ${v}`);
    console.log(`budget: FAILED (${res.violations.length})`);
  } else console.log("\nbudget: ok");
}

function summary(m, budget, res) {
  return {
    label: process.env.GITHUB_SHA?.slice(0, 7) || new Date().toISOString(),
    initialGzip: m.initialGzip,
    initialRaw: m.initialRaw,
    cssGzip: m.cssGzip,
    initialFiles: m.initial.length,
    initial: m.initial,
    css: m.css,
    lazy: m.lazy,
    budgets: res.rows,
    violations: res.violations,
  };
}

// ---------- selftest ----------

function selftest() {
  const FX = path.join(ROOT, "scripts", "fixtures", "bundle");
  let fails = 0;
  const t = (name, cond, extra = "") => {
    if (!cond) {
      fails++;
      console.error(`FAIL ${name} ${extra}`);
    } else console.log(`ok   ${name}`);
  };
  const budget = JSON.parse(fs.readFileSync(path.join(FX, "budget.json"), "utf8"));
  const report = JSON.parse(fs.readFileSync(path.join(FX, "modules.json"), "utf8"));
  t("fixture budget is valid", validateBudget(budget).length === 0, validateBudget(budget).join("; "));

  const tags = htmlAssets(fs.readFileSync(path.join(FX, "built", "index.html"), "utf8"));
  t("index.html: 3 modulepreload + 1 module script, 1 stylesheet", tags.js.length === 4 && tags.css.length === 1, JSON.stringify(tags));

  // the initial set and the sums are the ones computed by hand from the fixture files
  const m = measure(path.join(FX, "built"), report);
  const expectGz = ["assets/index-a.js", "assets/react-b.js", "assets/api-c.js", "assets/store-d.js"].reduce((s, f) => s + gz(fs.readFileSync(path.join(FX, "built", f))), 0);
  t("initial set = the 4 linked files", m.initial.map((x) => x.file).sort().join() === "assets/api-c.js,assets/index-a.js,assets/react-b.js,assets/store-d.js", m.initial.map((x) => x.file).join());
  t("gzip sum", m.initialGzip === expectGz, `${m.initialGzip} vs ${expectGz}`);
  t("raw sum", m.initialRaw === m.initial.reduce((s, x) => s + fs.statSync(path.join(FX, "built", x.file)).size, 0));
  t("lazy chunks are the other files", m.lazy.map((x) => x.file).sort().join() === "assets/dev-f.js,assets/editor-e.js", m.lazy.map((x) => x.file).join());
  t("clean fixture passes", check(m, budget).violations.length === 0, check(m, budget).violations.join("; "));

  const has = (violations, s) => violations.some((v) => v.includes(s));
  // each kind of violation
  const over = { ...budget, initialJsGzip: { ...budget.initialJsGzip, bytes: m.initialGzip - 100 }, initialJsRaw: { ...budget.initialJsRaw, bytes: m.initialRaw - 5 }, cssGzip: { ...budget.cssGzip, bytes: m.cssGzip - 1 } };
  const vOver = check(m, over).violations;
  t("B1 over the budget is named with the amount", has(vOver, `initial JS gzip ${fmt(m.initialGzip)} B > ${fmt(m.initialGzip - 100)} B (+100 B)`), vOver.join("; "));
  t("B2 over the budget", has(vOver, "initial JS raw"));
  t("B5 over the budget", has(vOver, "CSS gzip"));
  const vLazy = check(m, { ...budget, lazyChunkGzip: { bytes: 10, reason: "test" } }).violations;
  t("B4 lazy chunk over the cap", has(vLazy, "lazy chunk assets/editor-e.js"));
  const vEx = check(m, { ...budget, lazyChunkGzip: { bytes: 10, reason: "test" }, exceptions: [{ match: "editor-*.js", gzip: 1e6, reason: "test" }, { match: "assets/dev-f.js", gzip: 1e6, reason: "test" }] }).violations;
  t("B4 exception lifts the cap", vEx.length === 0, vEx.join("; "));
  const mod = { ...budget, mustBeLazy: [{ module: "src/editor/kitExtensions.ts", reason: "lazy since 1.0.5", since: "1.0.5" }, { module: "node_modules/prosemirror-*/*", reason: "test", since: "t" }] };
  const vLazyMod = check(m, mod).violations;
  t("B6 module in the initial set names the importer chain", has(vLazyMod, "src/editor/kitExtensions.ts must stay lazy") && has(vLazyMod, "src/main.tsx -> src/App.tsx -> src/editor/kitExtensions.ts"), vLazyMod.join("; "));
  t("B6 glob over node_modules is not hit by the lazy chunk", !has(vLazyMod, "prosemirror"), vLazyMod.join("; "));
  const vNever = check(m, { ...budget, neverShipped: [{ module: "src/devMock.ts", reason: "dev only" }] }).violations;
  t("B7 a never-shipped module in any chunk", has(vNever, "src/devMock.ts must never be shipped") && has(vNever, "assets/dev-f.js"), vNever.join("; "));
  // the graph and index.html must agree
  const skewed = { ...report, html: report.html.replace('<link rel="modulepreload" crossorigin href="/assets/store-d.js">', "") };
  t("graph/html mismatch is an error", measure(path.join(FX, "built"), skewed).errors.length === 1);
  // budget files without reasons
  const noReason = JSON.parse(JSON.stringify(budget));
  delete noReason.initialJsGzip.reason;
  t("a budget value without a reason is refused", validateBudget(noReason).some((x) => x.includes("initialJsGzip: no reason")));
  const noReason2 = JSON.parse(JSON.stringify(budget));
  noReason2.mustBeLazy[0].reason = "";
  t("a mustBeLazy entry without a reason is refused", validateBudget(noReason2).some((x) => x.includes("mustBeLazy[0]")));
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `--dist=${path.join(FX, "built")}`, `--modules=${path.join(FX, "modules.json")}`, `--budget=${path.join(FX, "budget-no-reason.json")}`], { encoding: "utf8" });
  t("the CLI exits 1 on a budget file without reasons", child.status === 1 && /no reason/.test(child.stderr), `${child.status} ${child.stderr}`);
  const ok = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `--dist=${path.join(FX, "built")}`, `--modules=${path.join(FX, "modules.json")}`, `--budget=${path.join(FX, "budget.json")}`], { encoding: "utf8" });
  t("the CLI prints budget: ok and exits 0 on the clean fixture", ok.status === 0 && /budget: ok/.test(ok.stdout), `${ok.status} ${ok.stdout.slice(-300)}`);
  const bad = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `--dist=${path.join(FX, "built")}`, `--modules=${path.join(FX, "modules.json")}`, `--budget=${path.join(FX, "budget-tight.json")}`], { encoding: "utf8" });
  t("the CLI exits 1 on a violation", bad.status === 1 && /budget: FAILED/.test(bad.stdout), `${bad.status} ${bad.stdout.slice(-300)}`);
  console.log(fails ? `\n${fails} selftest check(s) FAILED` : "\nselftest ok");
  process.exit(fails ? 1 : 0);
}

// ---------- main ----------

async function main() {
  if (flag("selftest")) return selftest();
  const budgetFile = opt("budget") ?? path.join(ROOT, "scripts", "bundle-budget.json");
  const budget = flag("build-only") ? null : loadBudget(budgetFile);

  let dist = opt("dist");
  let report = opt("modules") && fs.existsSync(opt("modules")) && !flag("build-only") ? JSON.parse(fs.readFileSync(opt("modules"), "utf8")) : undefined;
  let tmp;
  if (!dist) {
    dist = flag("build-only") ? path.resolve(opt("out") ?? "") : (tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heylook-bundle-")));
    if (flag("build-only") && !opt("out")) throw new Error("--build-only needs --out=<dir>");
    report = await buildInto(dist);
    if (opt("modules")) fs.writeFileSync(opt("modules"), JSON.stringify(report));
    if (flag("build-only")) {
      console.log(`built into ${dist}; module report ${opt("modules") ?? "(none: pass --modules=<json>)"}`);
      return;
    }
  }
  try {
    const m = measure(dist, report);
    const res = check(m, budget);
    const baseline = opt("baseline") ? JSON.parse(fs.readFileSync(opt("baseline"), "utf8")) : undefined;
    printReport(m, budget, res, baseline);
    if (opt("json")) fs.writeFileSync(opt("json"), JSON.stringify(summary(m, budget, res), null, 2));
    process.exitCode = res.violations.length ? 1 : 0;
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
