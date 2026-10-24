// W4.9 kit (spec-107-wp4.md, AC-4.9.1 to AC-4.9.4): is the Tauri ACL really applied to every secondary window, on this system?
// Node 22+, no dependencies. NOT part of the repo.
//
//   node acl.mjs <data folder | test-bridge.json | port:token> [--open] [--out=acl-result.json] [--platform=windows|macos|linux]
//
// The app is a DEBUG build started with HEYLOOK_TEST_BRIDGE=0 (own HEYLOOK_DATA_DIR, stub or throw-away mailboxes only).
// --open: opens a compose window (Shift+C in main) and a reader window (the first list row, Shift+Enter) first and closes them again at the end.
// Windows tested = every window of /windows whose label starts with compose- reader- event- search- scheduled- settings- (WP4c windows must be opened by hand
// before the run: "Open in new window" of the event dialog, of the search results, of the Scheduled view and of the Settings dialog).
//
// How it avoids doing harm: the calls carry NO valid arguments. Tauri checks the ACL first ("Command <name> not allowed by ACL" = refused), then the
// arguments ("invalid args ..." / "missing required key ..." = the command was REACHED, nothing ran). Commands without a required argument
// (quit_now, frontend_ready) are probed only in secondary windows, never in main (in main they would run). Exceptions with a real, harmless argument:
// thread_meta (reads a row) and set_setting (key "acl.probe", and "prefs" with its own current value, see below).
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const where = argv.find((a) => !a.startsWith("--"));
const opt = (name, dflt) => (argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${dflt}`).split("=").slice(1).join("=");
if (!where) {
  console.error("usage: node acl.mjs <data folder | test-bridge.json | port:token> [--open] [--out=acl-result.json] [--platform=...]");
  process.exit(2);
}
const OUT = opt("out", "acl-result.json");
const PLATFORM = opt("platform", { win32: "windows", darwin: "macos", linux: "linux" }[process.platform] ?? process.platform);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connection(w) {
  if (/^\d+:[0-9a-f]{64}$/.test(w)) return { port: Number(w.split(":")[0]), token: w.split(":")[1] };
  const file = fs.existsSync(w) && fs.statSync(w).isFile() ? w : path.join(w, "test-bridge.json");
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  return { port: j.port, token: j.token };
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
const key = (window, k, mods = {}) => call("POST", "/key", { window, key: k, ...mods });
/** Runs `invoke(cmd, args)` in the window; resolves to { outcome: "refused" | "reached" | "ran", text }. */
async function probe(window, cmd, args) {
  const js = `try { const v = await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)}); return { ok: true, v: JSON.stringify(v ?? null).slice(0, 120) }; } catch (e) { return { ok: false, e: String(e && e.message || e).slice(0, 300) }; }`;
  const r = await call("POST", "/eval", { window, js, timeoutMs: 15000 });
  if (r.ok === false) return { outcome: "error", text: r.error };
  const v = r.value;
  if (v.ok) return { outcome: "ran", text: v.v };
  if (/not allowed|not permitted|forbidden by|acl/i.test(v.e) && !/invalid args/i.test(v.e)) return { outcome: "refused", text: v.e };
  return { outcome: "reached", text: v.e };
}

// ---- the commands -------------------------------------------------------------------------------------------------------------------------
// AC-4.9.1 (every window kind): refused. `noArg` commands never run in main.
const DENIED = ["remove_account", "set_secret", "update_install", "quit_now", "thread_action", "popout_reply", "pgp_export_secret", "sends_flushed", "frontend_ready", "page_state", "page_pong", "quit_dialog", "quit_cancelled", "update_download", "queue_action", "frame_info", "save_rule", "set_autostart"];
const NO_ARG = new Set(["quit_now", "frontend_ready", "quit_cancelled", "frame_info"]); // would run in main
// the Settings window (settings-*) is allowed these (its own list); everything in DENIED stays refused for it except what is listed here
const SETTINGS_OWN = new Set(["remove_account", "set_secret", "pgp_export_secret", "save_rule", "set_autostart", "update_download"]);
// extra check AC-4.9.3: settings-* must be refused these
const SETTINGS_REFUSED = ["quit_now", "sends_flushed", "frontend_ready", "popout_reply"];
const KINDS = ["compose-", "reader-", "event-", "search-", "scheduled-", "settings-"];

const results = [];
const note = (window, cmd, expect, r) => {
  const pass = r.outcome === expect || (expect === "refused-or-ran" && (r.outcome === "refused" || r.outcome === "ran"));
  results.push({ platform: PLATFORM, window, command: cmd, expected: expect, outcome: r.outcome, pass, text: r.text });
  console.log(`${pass ? "ok  " : "FAIL"}  ${window.padEnd(12)} ${cmd.padEnd(18)} ${r.outcome.padEnd(8)} (expected ${expect}) ${r.outcome === "reached" || r.outcome === "refused" ? "- " + r.text.slice(0, 90) : ""}`);
};

const opened = [];
if (process.argv.includes("--open")) {
  await key("main", "C", { shift: true });
  await sleep(2500);
  await call("POST", "/eval", { window: "main", js: "const r=document.querySelector('.ml-row'); if(r){r.click(); r.focus();} return !!r;" });
  await sleep(200);
  await key("main", "Enter", { shift: true });
  await sleep(2500);
  opened.push(...(await windows()).filter((w) => w.label !== "main").map((w) => w.label));
}
const all = await windows();
const targets = all.filter((w) => KINDS.some((k) => w.label.startsWith(k)));
if (!targets.length) console.log("no secondary window is open: use --open or open one by hand");

// main keeps every command (AC-4.9.2): reached, never refused
for (const cmd of DENIED.filter((c) => !NO_ARG.has(c))) note("main", cmd, "reached", await probe("main", cmd, {}));
note("main", "thread_meta", "ran", await probe("main", "thread_meta", { threadId: "acl-probe-none" }));

for (const w of targets) {
  const settings = w.label.startsWith("settings-");
  for (const cmd of DENIED) {
    if (settings && SETTINGS_OWN.has(cmd) && !SETTINGS_REFUSED.includes(cmd)) {
      // allowed for the Settings window: reached (no valid args, nothing runs); no_arg ones are not in this set
      note(w.label, cmd, "reached", await probe(w.label, cmd, {}));
      continue;
    }
    note(w.label, cmd, "refused", await probe(w.label, cmd, {}));
  }
  if (!settings) note(w.label, "thread_meta", w.label.startsWith("compose-") || w.label.startsWith("reader-") ? "ran" : "refused-or-ran", await probe(w.label, "thread_meta", { threadId: "acl-probe-none" }));
  if (settings) {
    // set_setting: another key works, prefs is refused by the BACKEND (not the ACL): the text names the rule
    const cur = await probe("main", "get_setting", { key: "prefs" });
    note(w.label, "set_setting(other)", "ran", await probe(w.label, "set_setting", { key: "acl.probe", value: "1" }));
    const prefs = cur.outcome === "ran" ? JSON.parse(cur.text.length < 120 ? cur.text : "null") : null;
    const r = await probe(w.label, "set_setting", { key: "prefs", value: typeof prefs === "string" ? prefs : "{}" });
    results.push({ platform: PLATFORM, window: w.label, command: "set_setting(prefs)", expected: "backend refusal", outcome: r.outcome, pass: r.outcome === "reached" && /main/i.test(r.text), text: r.text });
    console.log(`${r.outcome === "reached" && /main/i.test(r.text) ? "ok  " : "FAIL"}  ${w.label.padEnd(12)} set_setting(prefs)   ${r.outcome} - ${r.text.slice(0, 100)}`);
  }
}
// the main window may write prefs (its own current value back)
const cur = await probe("main", "get_setting", { key: "prefs" });
console.log(`main get_setting(prefs): ${cur.outcome}`);

if (opened.length) {
  for (const l of opened) await call("POST", "/eval", { window: "main", js: `return window.__TAURI_INTERNALS__.invoke('popout_close', { label: ${JSON.stringify(l)} })` }).catch(() => {});
}
fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
// AC-4.9.4 table: window x command -> refused / reached
const labels = [...new Set(results.map((r) => r.window))];
const cmds = [...new Set(results.map((r) => r.command))];
console.log(`\n| command | ${labels.join(" | ")} |\n|---|${labels.map(() => "---").join("|")}|`);
for (const c of cmds) console.log(`| ${c} | ${labels.map((l) => results.find((r) => r.window === l && r.command === c)?.outcome ?? "-").join(" | ")} |`);
const bad = results.filter((r) => !r.pass && r.expected !== "refused-or-ran");
console.log(bad.length ? `\n${bad.length} unexpected result(s) on ${PLATFORM}` : `\nall ${results.length} results as expected on ${PLATFORM}`);
process.exit(bad.length ? 1 : 0);
