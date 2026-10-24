// The secondary windows in a REAL debug build of the app (W4.2, W4.6, W4.9), driven through the test bridge and, on Windows, through the WebView2 debugging port:
//   - every kind of window can be opened (popout_open from the main page), has its title, is listed by GET /windows with its kind, and the cap of 8 counts all kinds together;
//   - a window of a kind is refused the commands outside its capability (Tauri's ACL) and the main window reaches them (W4.9, the same calls as E:\hey-mail\e2e-v107-wp4\acl.mjs);
//   - set_setting("prefs") is refused from the Settings window and works from main (REQ-4.9.2), another key works from the Settings window;
//   - GET /native has the process numbers (W4.1 REQ-4.1.5);
//   - Windows: the page process of a window is crashed with Page.crash: the window is reloaded once (still listed, same label, main untouched), the second crash ends it (W4.2).
// The build must be a DEBUG build with its own identifier (a running Hey Look! would take the start), e.g. `npx tauri build --debug --no-bundle --config "{\"identifier\":\"thnonl.heylook.qa.wp4\"}"`.
// Without --exe the test is skipped (CI has no such build).
//   node scripts/test-popout-real.mjs --exe=<path of the debug hey-look.exe>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { bridge, connection } from "./test-bridge-client.mjs";

const exeArg = process.argv.find((a) => a.startsWith("--exe="));
if (!exeArg) {
  console.log("test-popout-real: SKIPPED (pass --exe=<path of a debug build with its own identifier>)");
  process.exit(0);
}
const exe = exeArg.slice(6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (name, cond, extra = "") => {
  if (cond) console.log(`ok    ${name}`);
  else {
    console.log(`FAIL  ${name} ${extra}`);
    bad++;
  }
};
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hl-real-"));
const cdpPort = 9400 + Math.floor(Math.random() * 400);
const env = { ...process.env, HEYLOOK_TEST_BRIDGE: "0", HEYLOOK_DATA_DIR: dataDir };
if (process.platform === "win32") env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${cdpPort}`;
const child = spawn(exe, [], { env, stdio: "ignore" });
const stop = () => {
  try {
    child.kill();
  } catch {
    /* gone */
  }
};
process.on("exit", stop);

try {
  let conn = null;
  for (let i = 0; i < 240 && !conn; i++) {
    try {
      conn = connection(dataDir);
    } catch {
      await sleep(250);
    }
  }
  ok("the bridge is up", !!conn);
  if (!conn) throw new Error("no bridge");
  const b = bridge(conn);
  for (let i = 0; i < 120; i++) {
    const w = await b.list().catch(() => []);
    if (w.some((x) => x.label === "main")) break;
    await sleep(250);
  }
  const invokeMain = (cmd, args = {}) => b.evalIn("main", `return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
  const wins = () => b.list();
  const waitWin = async (label, ms = 15000) => {
    for (let t0 = Date.now(); Date.now() - t0 < ms; ) {
      const w = (await wins()).find((x) => x.label === label);
      if (w) return w;
      await sleep(200);
    }
    return null;
  };

  // ---- /native
  const nat = await b.native();
  ok("/native has the process numbers", nat.pid === child.pid && nat.rssBytes > 1e6 && nat.webviewWindows >= 1, JSON.stringify(nat));

  // ---- every kind opens, with its title and kind
  const want = { scheduled: ["Scheduled", "scheduled-1"], settings: ["Settings", "settings-1"], search: ["Search results", "search-1"], event: [null, "event-1"] };
  const inits = { scheduled: {}, settings: { tab: "appearance" }, search: { search: "invoice", scope: "all", folder: "inbox", accountId: null, filter: "all" }, event: { init: { summary: "" } } };
  const keys = { scheduled: "scheduled", settings: "settings", search: null, event: null };
  for (const kind of Object.keys(want)) {
    const r = await invokeMain("popout_open", { kind, key: keys[kind], init: inits[kind], focusOnly: null });
    ok(`popout_open ${kind}: created`, r.status === "created" && r.label === want[kind][1], JSON.stringify(r));
    const w = await waitWin(want[kind][1]);
    ok(`${kind}: listed with its kind`, !!w && w.kind === kind, JSON.stringify(w));
    let title = "";
    for (let t0 = Date.now(); Date.now() - t0 < 15000; ) {
      title = (await wins()).find((x) => x.label === want[kind][1])?.title ?? "";
      if (title.endsWith("Hey Look!") && title !== "Hey Look!") break;
      await sleep(250);
    }
    ok(`${kind}: the title is "<title> - Hey Look!"`, /\S – Hey Look!$/.test(title) && (!want[kind][0] || title.startsWith(want[kind][0])), title);
  }
  // Settings and the Scheduled list exist once; asking again focuses
  const again = await invokeMain("popout_open", { kind: "settings", key: null, init: { tab: "ai" }, focusOnly: null });
  ok("Settings asked for again is focused, not made twice", again.status === "focused" && again.label === "settings-1", JSON.stringify(again));
  const again2 = await invokeMain("popout_open", { kind: "scheduled", key: null, init: {}, focusOnly: null });
  ok("the Scheduled list asked for again is focused", again2.status === "focused", JSON.stringify(again2));

  // ---- the cap of 8 counts every kind together
  let made = 0;
  for (let i = 0; i < 8; i++) {
    const r = await invokeMain("popout_open", { kind: "search", key: `k${i}`, init: { ...inits.search, search: `word${i}` }, focusOnly: null });
    if (r.status === "created") made++;
    else {
      ok("the cap of 8 counts all kinds together (refused with tooMany)", r.status === "tooMany" && made === 8 - 4, JSON.stringify({ r, made }));
      break;
    }
  }

  // ---- W4.9: the ACL and the prefs writer
  const probe = async (win, cmd, args) => {
    const r = await b.evalIn(win, `try { await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)}); return "ran"; } catch (e) { return String(e && e.message || e); }`);
    return /not allowed/i.test(r) && !/invalid args/i.test(r) ? "refused" : "reached: " + r.slice(0, 80);
  };
  for (const win of ["scheduled-1", "search-1", "event-1", "settings-1"]) {
    for (const cmd of ["quit_now", "sends_flushed", "thread_action", "popout_reply", "update_install", "pgp_export_secret"]) {
      if (win === "settings-1" && cmd === "pgp_export_secret") continue; // the Settings window's own
      ok(`${win}: ${cmd} is refused by the ACL`, (await probe(win, cmd, {})) === "refused");
    }
  }
  ok("main reaches remove_account (the ACL is not what refuses it elsewhere)", (await probe("main", "remove_account", {})).startsWith("reached"));
  ok("settings-1: set_setting of another key works", (await probe("settings-1", "set_setting", { key: "acl.probe", value: "1" })) !== "refused");
  const refused = await b.evalIn("settings-1", `try { await window.__TAURI_INTERNALS__.invoke("set_setting", { key: "prefs", value: "{}" }); return "wrote"; } catch (e) { return String(e && e.message || e); }`);
  ok("settings-1: set_setting(prefs) is refused by the backend", /only the main window writes prefs/.test(refused), refused);
  const cur = await invokeMain("get_setting", { key: "prefs" });
  const mainOk = await b.evalIn("main", `try { await window.__TAURI_INTERNALS__.invoke("set_setting", { key: "prefs", value: ${JSON.stringify(cur ?? "{}")} }); return "wrote"; } catch (e) { return String(e && e.message || e); }`);
  ok("main may write prefs", mainOk === "wrote", mainOk);

  // ---- W4.2 (Windows): the page process dies
  if (process.platform === "win32") {
    const targets = async () => (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).filter((t) => t.type === "page");
    const crash = async (urlPart) => {
      const t = (await targets()).find((x) => x.url.includes(urlPart));
      if (!t) return false;
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
      ws.send(JSON.stringify({ id: 1, method: "Page.crash" }));
      await sleep(300);
      try {
        ws.close();
      } catch {
        /* the page is gone */
      }
      return true;
    };
    const mainBefore = (await wins()).find((x) => x.label === "main");
    ok("a window to crash exists", !!(await waitWin("scheduled-1")));
    ok("Page.crash was sent to scheduled-1", await crash("w=scheduled"));
    await sleep(4000);
    let w1 = (await wins()).find((x) => x.label === "scheduled-1");
    ok("after the first death the window is reloaded (still there, same label)", !!w1);
    let drawn = false;
    for (let t0 = Date.now(); Date.now() - t0 < 15000 && !drawn; await sleep(300)) drawn = !!(await b.evalIn("scheduled-1", "return !!document.querySelector('[data-popout=scheduled]')").catch(() => false));
    ok("and shows its page again", drawn);
    ok("main was not reloaded", !!(await wins()).find((x) => x.label === "main") && (await b.evalIn("main", "return document.readyState")) === "complete" && mainBefore !== undefined);
    ok("Page.crash was sent again", await crash("w=scheduled"));
    let gone = false;
    for (let t0 = Date.now(); Date.now() - t0 < 15000 && !gone; await sleep(300)) gone = !(await wins()).some((x) => x.label === "scheduled-1");
    ok("the second death ends the window", gone);
    const log = fs.readFileSync(path.join(dataDir, "startup.log"), "utf8");
    ok("startup.log has the lines of W4.2", /scheduled-1: web view: render process exited/.test(log) && /scheduled-1: page process died: reloading/.test(log) && /scheduled-1: page process died again: closed/.test(log));
    ok("main is still there", !!(await wins()).find((x) => x.label === "main"));
  }
} catch (e) {
  console.log("FAIL  " + (e && e.message ? e.message : e));
  bad++;
} finally {
  stop();
  await sleep(500);
}
console.log(bad ? `\n${bad} check(s) failed` : "\nall checks passed");
process.exit(bad ? 1 : 0);
