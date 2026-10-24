// W4.1 kit (macOS leak procedure, spec-107-wp4.md "QA steps - Mac"; also the control run of AC-4.1.1 and the Linux smoke AC-4.1.8).
// Node 22+, no dependencies. NOT part of the repo.
//
//   node mac-leak.mjs <data folder | test-bridge.json | port:token> [--mode=compose|reader|mixed|stress|all] [--cycles=20] [--warmup=3] [--out=leak-result.json]
//
// The app is a DEBUG build started with HEYLOOK_TEST_BRIDGE=0 (and its own HEYLOOK_DATA_DIR); quit Safari, Mail and other WebKit apps first
// (they run com.apple.WebKit.WebContent processes too). The first row of the Inbox must be a conversation (the reader cycles press Enter on it).
// For every mode it prints a table: baseline / after / delta / delta per cycle for
//   nsapp.total, nsapp.titled, footprintBytes (macOS) or rssBytes, privateBytes (Windows), webviewWindows,
//   window-server windows of the app pid (CGWindowList all / on screen only; macOS, through osascript JXA), WebContent processes (macOS pgrep; 30 s later again).
// PASS (spec AC-4.1.2 to AC-4.1.5): nsapp.total, nsapp.titled and the window-server counts equal the baseline, footprint growth < 0.2 MB per cycle,
// WebContent count back to the baseline within 30 s. On the control build (no tao patch) the same run must show nsapp.total / titled growing by about
// the number of cycles (AC-4.1.1); if it does not, the measurement is wrong, not the fix.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const where = argv.find((a) => !a.startsWith("--"));
const opt = (name, dflt) => (argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${dflt}`).split("=").slice(1).join("=");
if (!where) {
  console.error("usage: node mac-leak.mjs <data folder | test-bridge.json | port:token> [--mode=all] [--cycles=20] [--warmup=3] [--out=file.json]");
  process.exit(2);
}
const MODE = opt("mode", "all");
const CYCLES = Number(opt("cycles", 20));
const WARMUP = Number(opt("warmup", 3));
const OUT = opt("out", "leak-result.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- bridge client (a copy of the few lines of scripts/test-bridge-client.mjs) -------------------------------------------------------------
function connection(w) {
  if (/^\d+:[0-9a-f]{64}$/.test(w)) return { port: Number(w.split(":")[0]), token: w.split(":")[1] };
  const file = fs.existsSync(w) && fs.statSync(w).isFile() ? w : path.join(w, "test-bridge.json");
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  return { port: j.port, token: j.token, pid: j.pid };
}
const conn = connection(where);
async function call(method, p, body) {
  const res = await fetch(`http://127.0.0.1:${conn.port}${p}`, {
    method,
    headers: body === undefined ? { Authorization: `Bearer ${conn.token}` } : { Authorization: `Bearer ${conn.token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${p}: HTTP ${res.status} ${JSON.stringify(json)}`);
  return json;
}
const windows = () => call("GET", "/windows");
const native = () => call("GET", "/native");
const key = (window, k, mods = {}) => call("POST", "/key", { window, key: k, ...mods });
const evalIn = async (window, js) => {
  const r = await call("POST", "/eval", { window, js });
  if (r && r.ok === false) throw new Error(`eval in ${window}: ${r.error}`);
  return r?.value;
};
const MAC = process.platform === "darwin";
const META = MAC ? { meta: true } : { ctrl: true }; // Cmd+W on a Mac, Ctrl+W elsewhere

// ---- measurements -----------------------------------------------------------------------------------------------------------------------
function windowServer(pid) {
  if (!MAC) return null;
  const jxa = `ObjC.import('CoreGraphics'); ObjC.import('Foundation');
function count(opt){ const l = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(opt, $.kCGNullWindowID))); return l.filter(w => w.kCGWindowOwnerPID === ${pid}).length; }
JSON.stringify({ all: count($.kCGWindowListOptionAll), onScreen: count($.kCGWindowListOptionOnScreenOnly) });`;
  try {
    return JSON.parse(execFileSync("osascript", ["-l", "JavaScript", "-e", jxa], { encoding: "utf8" }).trim());
  } catch (e) {
    return { error: String(e.message).slice(0, 120) };
  }
}
function webContentProcesses() {
  if (!MAC) return null;
  try {
    return Number(execFileSync("sh", ["-c", "pgrep -f com.apple.WebKit.WebContent | wc -l"], { encoding: "utf8" }).trim());
  } catch {
    return null;
  }
}
async function measure() {
  const n = await native();
  return { native: n, ws: windowServer(n.pid), webContent: webContentProcesses(), windows: (await windows()).map((w) => w.label) };
}
const flat = (m) => ({
  "nsapp.total": m.native.nsapp?.total ?? null,
  "nsapp.titled": m.native.nsapp?.titled ?? null,
  "webviewWindows": m.native.webviewWindows,
  "footprintMB": m.native.footprintBytes == null ? null : m.native.footprintBytes / 1048576,
  "rssMB": m.native.rssBytes == null ? null : m.native.rssBytes / 1048576,
  "privateMB": m.native.privateBytes == null ? null : m.native.privateBytes / 1048576,
  "ws.all": m.ws?.all ?? null,
  "ws.onScreen": m.ws?.onScreen ?? null,
  "webContent": m.webContent,
});

// ---- cycles ----------------------------------------------------------------------------------------------------------------------------
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout (${ms} ms): ${what}`);
    await sleep(100);
  }
}
const secondary = async () => (await windows()).filter((w) => w.label !== "main");
async function newWindow(kind, before, open) {
  await open();
  return waitFor(async () => (await secondary()).find((w) => w.label.startsWith(`${kind}-`) && !before.has(w.label) && w.visible), 8000, `a visible ${kind} window`);
}
async function goneWindow(label) {
  await waitFor(async () => !(await windows()).some((w) => w.label === label), 6000, `${label} gone from /windows`);
  await sleep(1000);
}
async function composeCycle(how = "page") {
  const before = new Set((await secondary()).map((w) => w.label));
  const w = await newWindow("compose", before, () => key("main", "C", { shift: true }));
  if (how === "discard") {
    // text, then Cmd+W: the "unsaved changes" question, then Discard
    await evalIn(w.label, "const e=document.querySelector('.ProseMirror,[contenteditable=true]'); if(e){e.focus(); document.execCommand('insertText',false,'leak test');} return !!e;");
    await sleep(300);
    await key(w.label, "w", META);
    await sleep(500);
    await evalIn(w.label, "const b=[...document.querySelectorAll('button')].find(b=>/discard/i.test(b.textContent)); if(!b) throw new Error('no Discard button'); b.click(); return 1;");
  } else {
    await key(w.label, "w", META);
  }
  await goneWindow(w.label);
}
async function readerCycle(how = "native") {
  const before = new Set((await secondary()).map((w) => w.label));
  const w = await newWindow("reader", before, async () => {
    await evalIn("main", "const r=document.querySelector('.ml-row'); if(!r) throw new Error('no list row'); r.click(); r.focus(); return 1;");
    await sleep(150);
    await key("main", "Enter", { shift: true });
  });
  await sleep(300);
  if (how === "esc") await key(w.label, "Escape");
  else await evalIn("main", `return window.__TAURI_INTERNALS__.invoke('popout_close', { label: ${JSON.stringify(w.label)} })`);
  await goneWindow(w.label);
}
async function stressCycle(i) {
  // quick: open and close at once; half of them closed before the page said ready
  const before = new Set((await secondary()).map((w) => w.label));
  await key("main", "C", { shift: true });
  const early = i % 2 === 0;
  const w = await waitFor(async () => (await secondary()).find((x) => !before.has(x.label)), 4000, "the window to exist");
  if (!early) await waitFor(async () => (await secondary()).find((x) => x.label === w.label && x.visible), 4000, "visible");
  await evalIn("main", `return window.__TAURI_INTERNALS__.invoke('popout_close', { label: ${JSON.stringify(w.label)} })`).catch(() => {});
  await goneWindow(w.label);
}

function table(title, base, after, cycles) {
  const rows = [];
  for (const k of Object.keys(base)) {
    if (base[k] == null && after[k] == null) continue;
    const d = after[k] - base[k];
    rows.push(`| ${k} | ${fmt(base[k])} | ${fmt(after[k])} | ${fmt(d)} | ${fmt(d / cycles)} |`);
  }
  return `### ${title}\n| measure | baseline | after | delta | delta per cycle |\n|---|---|---|---|---|\n${rows.join("\n")}\n`;
}
const fmt = (v) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : String(v));

async function run(mode, cycles) {
  const doCycle = async (i) => {
    if (mode === "compose") return composeCycle("page");
    if (mode === "reader") return readerCycle("native");
    if (mode === "stress") return stressCycle(i);
    return i % 2 === 0 ? composeCycle("discard") : readerCycle("esc"); // mixed
  };
  console.log(`\n== ${mode}: warm-up ${WARMUP}, then ${cycles} cycles ==`);
  for (let i = 0; i < WARMUP; i++) await doCycle(i);
  await sleep(10000);
  const base = await measure();
  for (let i = 0; i < cycles; i++) {
    await doCycle(i);
    if ((i + 1) % 5 === 0) console.log(`  ${i + 1}/${cycles}`);
  }
  await sleep(10000);
  const after = await measure();
  let late = after;
  if (MAC) {
    await sleep(30000);
    late = await measure();
  }
  const f0 = flat(base), f1 = flat(after), f2 = flat(late);
  console.log(table(`${mode} (${cycles} cycles)`, f0, f1, cycles));
  const growthMB = f0.footprintMB != null ? f1.footprintMB - f0.footprintMB : f0.rssMB != null ? f1.rssMB - f0.rssMB : null;
  const verdict = {
    mode,
    cycles,
    "nsapp.total": f1["nsapp.total"] == null ? "n/a" : f1["nsapp.total"] === f0["nsapp.total"] ? "PASS" : `FAIL (+${f1["nsapp.total"] - f0["nsapp.total"]})`,
    "nsapp.titled": f1["nsapp.titled"] == null ? "n/a" : f1["nsapp.titled"] === f0["nsapp.titled"] ? "PASS" : `FAIL (+${f1["nsapp.titled"] - f0["nsapp.titled"]})`,
    "windowServer": f1["ws.all"] == null ? "n/a" : f1["ws.all"] === f0["ws.all"] && f1["ws.onScreen"] === f0["ws.onScreen"] ? "PASS" : `FAIL (all ${f1["ws.all"] - f0["ws.all"]}, onScreen ${f1["ws.onScreen"] - f0["ws.onScreen"]})`,
    "webviewWindows": f1.webviewWindows === f0.webviewWindows ? "PASS" : `FAIL (+${f1.webviewWindows - f0.webviewWindows})`,
    "memoryPerCycleMB": growthMB == null ? "n/a" : Number((growthMB / cycles).toFixed(3)),
    "memory": growthMB == null ? "n/a" : growthMB / cycles < 0.2 ? "PASS" : "FAIL",
    "webContentAfter30s": f2.webContent == null ? "n/a" : f2.webContent === f0.webContent ? "PASS" : `FAIL (${f2.webContent} vs ${f0.webContent})`,
  };
  console.log(JSON.stringify(verdict));
  return { mode, base, after, late, verdict };
}

const modes = MODE === "all" ? ["compose", "reader", "mixed"] : [MODE];
const results = [];
console.log(`platform ${process.platform}; pid ${(await native()).pid}`);
if (MAC) console.log(`sw_vers: ${execFileSync("sw_vers", { encoding: "utf8" }).replace(/\n/g, "; ")} chip: ${execFileSync("uname", ["-m"], { encoding: "utf8" }).trim()}`);
for (const m of modes) results.push(await run(m, m === "stress" ? 100 : CYCLES));
if (MODE === "all") results.push(await run("stress", 100));
fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(`\nwritten ${OUT}. Attach 2 cycles of startup.log ("gone (verified)" / "closed", "N window(s) left in the app: main", the sweep lines "retain count", "NSApp lists").`);
const bad = results.filter((r) => Object.values(r.verdict).some((v) => typeof v === "string" && v.startsWith("FAIL")));
process.exit(bad.length ? 1 : 0);
