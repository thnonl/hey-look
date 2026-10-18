// A pop-out window that was closed can always be opened again (1.0.7 WP2a QA BUG-1: "popping out the same draft again fails with 'failed to send message
// to the webview', and then every pop-out fails until the app restarts").
//
// What was found: that error is not about the window that was asked for. It is what wry answers when the event loop of the app takes no more messages, and on
// Windows the loop listens at an internal top-level window of the class "Tao Thread Event Target". The QA helper that closed the pop-outs posted WM_CLOSE to
// EVERY window of the process (title not "Hey Look!"), so it destroyed that one too; every window call after that failed, on 1.0.6 as well. The same helper
// closing only the pop-out never fails. So the guards here are: (1) static: the registry and the log hint that the Rust tests (popout.rs) cover are still
// there; (2) with --exe=<a DEBUG build with its own identifier>: the real thing, through the test bridge. The same draft key is opened and closed N times
// (default 20) by each road a window ends by, and every open must create a NEW window (a label never used before), none may fail, and the log must not
// have a "could not be created" line. Without --exe the real part is skipped (as in test-test-bridge.mjs).
//   node scripts/test-popout-reopen.mjs [--exe=<hey-look.exe>] [--cycles=20] [--prove-cause]   (--prove-cause: Windows, last step, destroys that window on purpose)
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bridge, connection } from "./test-bridge-client.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (name, cond, detail = "") => {
  if (!cond) bad++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${!cond && detail ? ` -- ${detail}` : ""}`);
};

// ---- 1. static: what the Rust tests stand on is still there --------------------------------------------------------------------------------
{
  const rs = read("src-tauri/src/popout.rs");
  for (const t of ["a_closed_draft_window_can_be_opened_again_every_time", "a_window_that_could_not_be_created_holds_no_slot_and_no_key", "the_log_says_when_the_event_loop_itself_stopped_taking_messages", "a_window_on_its_way_out_frees_its_key_but_still_counts"]) {
    ok(`popout.rs has the test ${t}`, rs.includes(`fn ${t}(`));
  }
  const open = rs.slice(rs.indexOf("pub fn open("), rs.indexOf("fn creation_hint("));
  const failed = open.slice(open.indexOf("Err(e) => {"));
  ok("a window that could not be created is taken out of the registry before anything else", failed.indexOf("reg(app).remove(&label)") >= 0 && failed.indexOf("reg(app).remove(&label)") < failed.indexOf("could not be created"));
  ok("the log line of that failure carries the hint for the dead event loop", failed.includes("creation_hint(&e)") && rs.includes("failed to send message to the webview") && rs.includes("Tao Thread Event Target"));
  // the main page asks for the window; the window ends itself by popout_destroy (what the page does after Save / Discard); popout_close is the X
  const caps = read("src-tauri/capabilities/default.json") + read("src-tauri/capabilities/popout.json");
  ok("the capabilities let the main page open and close, the window end itself", ["popout_open", "popout_close", "popout_destroy"].every((c) => caps.includes(c)) || read("src-tauri/build.rs").includes("popout_destroy"));
}

// ---- 2. a real debug build -----------------------------------------------------------------------------------------------------------------
const exeArg = process.argv.find((a) => a.startsWith("--exe="));
const cyclesArg = process.argv.find((a) => a.startsWith("--cycles="));
const CYCLES = cyclesArg ? Number(cyclesArg.slice(9)) : 20;
if (!exeArg) {
  console.log("SKIPPED the real-app part (pass --exe=<path of a debug build with its own identifier>)");
} else {
  const exe = exeArg.slice(6);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hl-reopen-"));
  const child = spawn(exe, [], { env: { ...process.env, HEYLOOK_TEST_BRIDGE: "0", HEYLOOK_DATA_DIR: dataDir }, stdio: "ignore" });
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
    ok("the data folder tells where the bridge is", !!conn);
    if (conn) {
      const b = bridge(conn);
      for (let i = 0; i < 120; i++) {
        if ((await b.evalIn("main", "return typeof window.__TAURI_INTERNALS__").catch(() => null)) === "object") break;
        await sleep(250);
      }
      const invoke = (win, cmd, args) => b.evalIn(win, `return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})}).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: String(e) }))`, { timeoutMs: 30000 });
      const composeWindows = async () => (await b.list()).filter((w) => w.kind === "compose").map((w) => w.label);
      const waitFor = async (what, f, ms = 10000) => {
        for (let t = Date.now(); Date.now() - t < ms; ) {
          const v = await f();
          if (v) return v;
          await sleep(100);
        }
        throw new Error(`timed out: ${what}`);
      };
      const key = "draft:mid:reopen-test|<d1@heylook.test>";
      const seen = new Set();
      const failures = [];
      const roads = ["its page ends it (popout_destroy: Save / Discard / Send did it)", "the close request of the window (popout_close = the X)", "its page ends it (popout_destroy) right after it is ready"];
      for (let i = 0; i < CYCLES; i++) {
        const road = i % 3;
        try {
          const opened = await invoke("main", "popout_open", { kind: "compose", key, init: null, focusOnly: null });
          if (!opened.ok || opened.r.status !== "created") throw new Error(`open ${i}: ${JSON.stringify(opened)}`);
          const label = opened.r.label;
          if (seen.has(label)) throw new Error(`open ${i}: the label ${label} was used before`);
          seen.add(label);
          // asking again while it is open focuses it (one window per draft)
          const again = await invoke("main", "popout_open", { kind: "compose", key, init: null, focusOnly: null });
          if (!again.ok || again.r.status !== "focused" || again.r.label !== label) throw new Error(`open ${i}: a second ask gave ${JSON.stringify(again)}`);
          // its page is up (it answers), then it ends
          await waitFor(`${label} answers`, async () => (await b.evalIn(label, "return document.readyState").catch(() => null)) === "complete");
          if (road === 1) {
            const closed = await invoke("main", "popout_close", { label });
            if (!closed.ok || closed.r !== true) throw new Error(`open ${i}: popout_close ${JSON.stringify(closed)}`);
          } else {
            if (road === 0) await sleep(300);
            // (the call ends the window it runs in, so the answer may not get out: the bridge says "no window" or "failed before it could answer" when the window is gone before the page answered)
            const ended = await invoke(label, "popout_destroy", {}).catch((e) => (/no window|failed before it could answer/.test(e.message) ? { ok: true, r: true } : Promise.reject(e)));
            if (!ended.ok || ended.r !== true) throw new Error(`open ${i}: popout_destroy ${JSON.stringify(ended)}`);
          }
          await waitFor(`${label} is gone`, async () => !(await composeWindows()).includes(label));
          // (startup.log starts over at 32 KB, so it is read after every cycle and not once at the end)
          const lg = fs.readFileSync(path.join(dataDir, "startup.log"), "utf8");
          if (/could not be created|failed to send message to the webview|could not be hidden|destroy could not be scheduled/.test(lg)) throw new Error(`cycle ${i}: the log has a window failure: ${(lg.match(/.*(could not be created|failed to send message|could not be hidden|could not be scheduled).*/) ?? [""])[0]}`);
        } catch (e) {
          const tail = fs.readFileSync(path.join(dataDir, "startup.log"), "utf8").split(String.fromCharCode(10)).filter((l) => /popout/.test(l) && !/page says/.test(l)).slice(-14).join(" // ");
          failures.push(`cycle ${i} (${roads[road]}): ${e.message} [log: ${tail}]`);
          if (failures.length >= 3) break;
        }
      }
      ok(`${CYCLES} open - close - open cycles of the same draft key: every open made a new window, every close freed it`, failures.length === 0 && seen.size === CYCLES, failures.join(" | ") || `${seen.size} windows`);
      ok("no compose window is left", (await composeWindows()).length === 0);
      // The cause of the QA report, shown on purpose (Windows, --prove-cause; it ends the pop-outs of this run for good, so it is the last step): WM_CLOSE to the
      // event loop's own window makes every window call fail with the QA error, and nothing but a restart helps.
      if (process.argv.includes("--prove-cause") && process.platform === "win32") {
        const ps = `Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class W { public delegate bool P(IntPtr h, IntPtr l); [DllImport("user32.dll")] public static extern bool EnumWindows(P p, IntPtr l); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n); [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l); }
"@
$n = 0; [void][W]::EnumWindows({ param($h,$l) $p=[uint32]0; [void][W]::GetWindowThreadProcessId($h,[ref]$p); if ($p -eq ${child.pid}) { $c=New-Object System.Text.StringBuilder 256; [void][W]::GetClassName($h,$c,256); if ($c.ToString() -eq "Tao Thread Event Target") { [void][W]::PostMessage($h, 0x10, [IntPtr]::Zero, [IntPtr]::Zero); $script:n++ } } return $true }, [IntPtr]::Zero); $n`;
        const posted = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
        ok("WM_CLOSE was posted to the Tao event target window of the app", /^\s*1\s*$/.test(posted.stdout ?? ""), posted.stdout + posted.stderr);
        await sleep(1500);
        // (the bridge asks the event loop too, so its own answer is the error; a page that was already running would say the same for popout_open)
        const dead = await invoke("main", "popout_open", { kind: "compose", key, init: null, focusOnly: null }).catch((e) => ({ ok: false, e: e.message }));
        ok("then every window call fails with the QA error (the cause of QA BUG-1, not the closed draft)", !dead.ok && /failed to send message to the webview/.test(dead.e), JSON.stringify(dead));
      }
    }
  } finally {
    stop();
    await sleep(500);
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

console.log(bad ? `\n${bad} check(s) failed` : "\nall checks passed");
assert.equal(bad, 0);
