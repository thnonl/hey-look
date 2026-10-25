// D-057 (1.0.7): a window shown from the tray after a --minimized start must show the page, not a white window.
//
// What the owner saw (1.0.6, after a restart of the machine): the autostarted app (tray start) was opened from the tray 53 s later and the window was white
// for minutes, while startup.log said "the web view is running ... visible", "page state after show: visibility=visible, animation frames=true". Nothing in
// the process or the page's own report tells a web view that is not painted from one that is (the page reports `visible` and gets frames in the white
// window too), so the app now reads the PIXELS of the window from the screen a few hundred ms after every show from hidden (startup.rs `screen_probe`) and
// walks its cures when the area is one colour (re-assert, nudge, hide + show, reload, restart).
//
// This script is the real-app test. It needs a DEBUG build with its own identifier (the test bridge and the fault injection are debug-only) and Windows
// (the pixel reader is scripts/lib/window-pixels.ps1). Without --exe it only checks the static wiring and says SKIPPED for the rest. It is a QA-kit
// script, not part of .github/node-tests.txt: it needs a built debug exe, a desktop and a visible window (CI has the first, not the others).
//
//   node scripts/test-blank-after-show.mjs [--exe=<debug hey-look.exe>] [--variant=<name>[,<name>...]] [--wait=<s>] [--measure] [--json]
//
// Variants (each is one fresh start with `--minimized`, a throw-away data folder, a wait, then a second start that hands over to the running instance, which
// is what a tray click and a notification click also end in: shell::show_main):
//   plain          wait 30 s, show, expect a painted window at once; then the page is switched to the light theme and must still count as painted
//   gpu-off        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--disable-gpu
//   gpu-kill       the web view's GPU process is killed while the window is hidden
//   busy           all CPU cores busy for the first 40 s (the machine right after a login)
//   display-off    the display is switched off and on again while the window is hidden
//   start-minimized / start-hidden   the process is started with STARTUPINFO wShowWindow = minimized / hidden (the first ShowWindow call takes it)
//   inject1..4     HEYLOOK_TEST_BLANK_AFTER_SHOW=1/2/3/5: the web view is hidden for real after the show (the window shows one colour); the cure that is
//                  numbered must bring it back: 1 re-assert, 2 nudge (1 px), 3 hide + show, 5 reload (steps before are taken for real and undone by the fault)
// `--measure`: no assertions on the cure, only the numbers (the repro of D-057 on a build without the fix: the table of white ratios).
// A web view whose browser process crashes (RTSSHooks64.dll on the QA PC, see webview_health.rs) before the show is not a verdict: that variant is run again (3 tries).
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

// ---- 1. static: the pieces the real test stands on are there ----------------------------------------------------------------------------------
{
  const rs = read("src-tauri/src/startup.rs").replace(/\r/g, "");
  ok("startup.rs reads the screen after a show (Capture::Screen, BitBlt)", rs.includes("Capture::Screen => BitBlt("));
  ok("PrintWindow stays a diagnostic behind HEYLOOK_PIXEL_CHECK", rs.includes("HEYLOOK_PIXEL_CHECK") && rs.includes("Capture::Print => PrintWindow("));
  ok("the fault injection is compiled in Windows debug builds only", /#\[cfg\(all\(windows, debug_assertions\)\)\]\nmod fault \{[\s\S]*HEYLOOK_TEST_BLANK_AFTER_SHOW/.test(rs));
  ok("the cures are re-assert, nudge, hide + show, reload, restart", /Reassert[\s\S]*Nudge[\s\S]*HideShow[\s\S]*Reload[\s\S]*Restart/.test(rs.slice(rs.indexOf("pub enum Step"))));
  // fix12: index.html draws a start screen (one colour on > 95 % of the points), so one colour is a blank window only once the page of this load has reported itself
  ok("one colour before the page has reported itself is the start screen and is never cured (with_page_state, Paint::Starting)", rs.includes("pub fn with_page_state(") && rs.includes("Paint::Starting") && rs.split("with_page_state(j, page_is_up())").length - 1 >= 2 && /fn cure_needed[\s\S]*?seen == Paint::Blank/.test(rs));
  ok("the roads that load the page again clear the page-is-up flag, the ready report sets it", /fn reload_page\([^)]*\) \{\n    page_loading\(\);/.test(rs) && rs.includes("PAGE_UP.store(true, Ordering::SeqCst);"));
  const ps = read("scripts/lib/window-pixels.ps1");
  ok("the pixel reader leaves out points that another window covers", ps.includes("WindowFromPoint"));
  const shell = read("src-tauri/src/shell.rs").replace(/\r/g, "");
  const show = shell.slice(shell.indexOf("pub fn show_main"));
  ok("show_main looks at a window that was hidden or minimized, and at one on screen that no look has found painted", show.slice(0, show.indexOf("\n}\n")).includes("if crate::startup::looks_wanted(was_hidden, was_minimized, crate::startup::paint_confirmed()) {"));
  // 1.0.8 (owner: the white window after the in-app update to 1.0.7, cured by a tray click): every look reads the screen, a show of a window nobody found painted looks again,
  // the log keeps the start of its run when it starts over, and the first line says how the process was started
  ok("every look of a show reads the screen (the looks at 8, 15 and 30 s too)", rs.includes("const LOOKS_MS: [u64; 6] = [300, 1000, 3000, 8000, 15000, 30000];") && rs.includes("const SCREEN_LOOKS: usize = 6;"));
  ok("a look that found content confirms the paint, a new show clears it", rs.includes("PAINT_CONFIRMED.store(true, Ordering::SeqCst);") && rs.includes("PAINT_CONFIRMED.store(false, Ordering::SeqCst);"));
  ok("the log that starts over keeps the first lines of the run (also in a release build)", rs.includes("static HEAD: Mutex<Vec<String>>") && rs.includes("started over here: the lines above are the first lines of this run"));
  const lib = read("src-tauri/src/lib.rs");
  ok("the first line of the log says how the process was started (arguments, who started it, STARTUPINFO)", lib.includes('startup::line("start", &startup::launch_description());') && read("src-tauri/src/webview_health.rs").includes("GetStartupInfoW"));
}

// ---- 2. a real debug build -----------------------------------------------------------------------------------------------------------------
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const exe = arg("exe");
if (!exe) {
  console.log("SKIPPED the real-app part (pass --exe=<path of a DEBUG build with its own identifier>; Windows only)");
} else if (process.platform !== "win32") {
  console.log("SKIPPED the real-app part (Windows only: the pixel reader and the web view are WebView2)");
} else {
  const measureOnly = process.argv.includes("--measure");
  const variants = (arg("variant") ?? "plain,gpu-off,inject1,inject2,inject3,inject4").split(",");
  const waitS = Number(arg("wait") ?? 30);
  const PS = path.join(ROOT, "scripts", "lib", "window-pixels.ps1");
  const pixels = (pid, { mode = "screen", save = "" } = {}) => {
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS, "-ProcessId", String(pid), "-Mode", mode, "-Raise"]; // (-Raise also puts the QA window above the others, hidden or not: a window that another program covers has no verdict and no cure)
    if (save) args.push("-Save", save);
    const r = spawnSync("powershell", args, { encoding: "utf8", timeout: 30000 });
    try {
      return JSON.parse(r.stdout.trim());
    } catch {
      return { found: false, error: (r.stdout + r.stderr).slice(0, 300) };
    }
  };
  const logOf = (dir) => {
    try {
      return fs.readFileSync(path.join(dir, "startup.log"), "utf8");
    } catch {
      return "";
    }
  };
  const waitLog = async (dir, re, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (re.test(logOf(dir))) return true;
      await sleep(200);
    }
    return false;
  };
  const extra = {
    "gpu-off": { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--disable-gpu" },
    inject1: { HEYLOOK_TEST_BLANK_AFTER_SHOW: "1" },
    inject2: { HEYLOOK_TEST_BLANK_AFTER_SHOW: "2" },
    inject3: { HEYLOOK_TEST_BLANK_AFTER_SHOW: "3" },
    inject4: { HEYLOOK_TEST_BLANK_AFTER_SHOW: "5" },
  };
  const cureName = { inject1: /re-asserting the web view/, inject2: /changing the web view's size by 1 px/, inject3: /hide \+ show/, inject4: /reloading the page/ };
  const table = [];

  // one run of one variant; returns "crashed" when the browser process died before the show (not a verdict)
  const run = async (variant) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `hl-blank-${variant}-`));
    const env = { ...process.env, HEYLOOK_TEST_BRIDGE: "0", HEYLOOK_DATA_DIR: dataDir, ...(extra[variant] ?? {}) };
    const burners = [];
    if (variant === "busy") {
      for (let i = 0; i < os.cpus().length; i++) burners.push(spawn(process.execPath, ["-e", "const t=Date.now();while(Date.now()-t<40000){}"], { stdio: "ignore" }));
    }
    // the window style the process is started with (STARTUPINFO.wShowWindow): the first ShowWindow call of a process takes it instead of its own argument
    const style = { "start-minimized": "Minimized", "start-hidden": "Hidden" }[variant];
    let child;
    if (style) {
      const cmd = `(Start-Process -FilePath '${exe}' -ArgumentList '--minimized' -WindowStyle ${style} -PassThru).Id`;
      const r = spawnSync("powershell", ["-NoProfile", "-Command", cmd], { env, encoding: "utf8" });
      const pid = Number(r.stdout.trim());
      child = { pid, kill: () => spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }) };
    } else {
      child = spawn(exe, ["--minimized"], { env, stdio: "ignore" });
    }
    const stop = () => {
      for (const p of [child, ...burners]) {
        try {
          p.kill();
        } catch {
          /* gone */
        }
      }
    };
    process.on("exit", stop);
    try {
      const hidden = await waitLog(dataDir, /window stays hidden \(tray start\)/, 90000);
      ok(`[${variant}] the --minimized start keeps the window hidden`, hidden, logOf(dataDir).slice(-400));
      if (!hidden) return "failed";
      const before = pixels(child.pid);
      ok(`[${variant}] the hidden window is not visible`, before.found && before.visible === false, JSON.stringify(before));
      if (variant === "gpu-kill") {
        // the GPU process of THIS app's web view (a child of its browser process, found from the log line) dies while the window is hidden: a display driver
        // reset or a device loss while the app sat in the tray. The web view starts a new one by itself.
        const bp = /browser process (\d+):/.exec(logOf(dataDir))?.[1];
        const cmd = `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${Number(bp)}' | Where-Object { $_.CommandLine -match '--type=gpu-process' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; 'killed gpu process ' + $_.ProcessId }`;
        const k = spawnSync("powershell", ["-NoProfile", "-Command", cmd], { encoding: "utf8" });
        console.log(`[${variant}] browser process ${bp}: ${k.stdout.trim() || "no gpu process found " + k.stderr}`);
      }
      if (variant === "display-off") {
        // the display goes off and on while the window is hidden (the app sat in the tray over a display sleep)
        const d = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, "scripts", "lib", "display-power.ps1"), "-Seconds", "8"], { encoding: "utf8", timeout: 60000 });
        console.log(`[${variant}] ${d.stdout.trim()}`);
      }
      await sleep((variant === "plain" || variant.startsWith("inject") ? Math.min(waitS, 10) : waitS) * 1000);
      if (/web view: browser process exited/.test(logOf(dataDir))) return "crashed";
      // the way a tray click ends: shell::show_main. A second start hands over to this instance, which calls it.
      const second = spawn(exe, ["--minimized"], { env, stdio: "ignore" });
      await new Promise((r) => second.on("exit", r));
      const handed = await waitLog(dataDir, /a second start was handed to this instance/, 10000);
      if (!handed && /web view: browser process exited/.test(logOf(dataDir))) return "crashed";
      ok(`[${variant}] the second start was handed over`, handed);
      const t0 = Date.now();
      const looks = [];
      for (const at of [300, 1000, 2000, 4000, 7000, 12000, 16000]) {
        await sleep(Math.max(0, at - (Date.now() - t0)));
        const p = pixels(child.pid);
        looks.push({ at: Date.now() - t0, vis: `${p.visible ? "v" : "-"}${p.iconic ? "i" : "-"}${p.cloaked ? "c" : "-"} ${p.clientW}x${p.clientH}`, white: p.whiteRatio, dom: p.dominantRatio, rgb: p.dominantRgb, distinct: p.distinct, owned: p.owned, ms: p.ms });
      }
      const log = logOf(dataDir);
      if (/web view: browser process exited/.test(log) && !variant.startsWith("inject")) return "crashed";
      const last = looks[looks.length - 1];
      table.push({ variant, wait: waitS, looks, log: log.split("\n").filter((l) => /native check|blank|cure|re-assert|nudg|hide \+ show|page state|test fault|reload|restart/i.test(l)) });
      console.log(`[${variant}] looks (ms after the second start: [visible iconic cloaked, client size] white ratio / dominant colour share / colour / distinct colours / points on the window):`);
      for (const l of looks) console.log(`      ${String(l.at).padStart(6)}  [${l.vis}] white ${l.white}  dominant ${l.dom} (${l.rgb})  distinct ${l.distinct}  owned ${l.owned}  [${l.ms} ms]`);
      for (const l of table[table.length - 1].log) console.log(`      log: ${l.slice(0, 330)}`);
      if (!measureOnly) {
        ok(`[${variant}] the window shows a page at the end (more than 3 colours, no colour on 95 % of the points)`, last.distinct > 3 && last.dom < 0.95, JSON.stringify(last));
        if (variant.startsWith("inject")) {
          ok(`[${variant}] the fault is real: the first looks read one colour (white, 95 % or more)`, looks.slice(0, 2).some((l) => l.dom >= 0.95), JSON.stringify(looks.slice(0, 2)));
          ok(`[${variant}] the log says the window was blank (one colour only)`, /screen: one colour only/.test(log));
          ok(`[${variant}] the step that was meant to cure it ran`, cureName[variant].test(log), log.split("\n").slice(-14).join("\n"));
          ok(`[${variant}] the log says which step cured it`, /\(cured by: /.test(log) && /\(cured by: [^)]*\)/.exec(log)[0].length > 12, log.split("\n").slice(-10).join("\n"));
          // not later than the ladder allows: one step per 0.7 s look after the first cure at 1 s
          ok(`[${variant}] it was cured within 10 s of the show`, looks.filter((l) => l.at <= 10000 && l.dom < 0.95 && l.distinct > 3).length > 0, JSON.stringify(looks.map((l) => [l.at, l.dom])));
        } else {
          ok(`[${variant}] a healthy show runs no cure`, !/blank window|screen: one colour only|re-asserting|still blank/.test(log));
          ok(`[${variant}] every look at the screen found content`, (log.match(/screen: the window shows content/g) ?? []).length >= 2, log.split("\n").filter((l) => /native check/.test(l)).join("\n"));
        }
        if (variant === "plain") {
          // a real light screen is not mistaken for a blank one: the page is switched to the light theme through the test bridge
          const conn = connection(dataDir);
          const b = bridge(conn);
          await b.evalIn("main", "document.documentElement.setAttribute('data-theme','light'); return document.documentElement.getAttribute('data-theme')");
          await sleep(600);
          const p = pixels(child.pid);
          console.log(`[${variant}] light theme: dominant ${p.dominantRatio} (${p.dominantRgb}), white ${p.whiteRatio}, distinct ${p.distinct}, owned ${p.owned}`);
          ok(`[${variant}] the light theme is not taken for a blank window (no colour on 95 % of the points)`, p.dominantRatio < 0.95 && p.distinct > 3, JSON.stringify(p));
        }
      }
      return "done";
    } finally {
      stop();
      await sleep(1500);
      for (let i = 0; i < 5; i++) {
        try {
          fs.rmSync(dataDir, { recursive: true, force: true });
          break;
        } catch {
          await sleep(1000);
        }
      }
    }
  };
  for (const variant of variants) {
    let result = "crashed";
    for (let attempt = 1; attempt <= 3 && result === "crashed"; attempt++) {
      result = await run(variant);
      if (result === "crashed") console.log(`NOTE [${variant}] the browser process crashed before the show (attempt ${attempt} of 3): not a verdict`);
    }
    if (result === "crashed") ok(`[${variant}] ran to a verdict`, false, "the web view's browser process crashed in 3 of 3 tries");
  }
  if (process.argv.includes("--json")) console.log(JSON.stringify(table, null, 1));
}
console.log(bad ? `${bad} FAILED` : "all ok");
process.exit(bad ? 1 : 0);
