// 1.0.8 (owner, Windows 11, 1.0.6 -> 1.0.7 through the app's own update): "the setup finishes, the app opens a window that is completely WHITE, there is no
// taskbar button, and when I click the tray icon the window shows the UI". The new process of an update is started by the installer (NSIS RunAsUser, with the
// arguments of the old run: `/P /UPDATE /R /ARGS ...`) a moment after the old process ended (`std::process::exit(0)` inside the updater plugin), not by a person.
//
// What this test pins (static, runs in CI): the pieces of the fix that are about this road. What it does with --exe (a DEBUG build with its own identifier, Windows,
// a visible desktop; a QA-kit run, not part of CI): the relaunch is made the way the installer makes it, the old process is killed and the new one started
// 50 ms later with the same data folder (and, with --installer=<setup.exe>, through the real installer: `setup.exe /P /UPDATE /R /ARGS`), then the new window is
// brought to the front (the QA window only) and its pixels are read from the screen at 2, 5, 10 and 20 s: it must show a page (more than 3 colours, no colour on
// 95 % of the points), `startup.log` must open with the "started" line that says how the process was started, and the run must not have needed the error message.
//
//   node scripts/test-update-relaunch.mjs [--exe=<debug hey-look.exe>] [--rounds=3] [--delay=50] [--args=--minimized]
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (name, cond, detail = "") => {
  if (!cond) bad++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${!cond && detail ? ` -- ${detail}` : ""}`);
};

// ---- 1. static ---------------------------------------------------------------------------------------------------------------------------------
{
  const rs = read("src-tauri/src/startup.rs").replace(/\r/g, "");
  const code = rs.slice(0, rs.indexOf("#[cfg(test)]\nmod tests"));
  const upd = read("src-tauri/src/update.rs");
  const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
  ok("the Windows update installs passive (the installer starts the new version itself, with /R)", conf.plugins.updater.windows.installMode === "passive");
  ok("the update marker is written before the installer is started (the next start says it follows an install)", upd.includes("remember_install(&db, &current, &update.version, draft_saved);") && upd.indexOf("remember_install(&db, &current") < upd.indexOf(".install(&bytes)"));
  ok("the new process waits for the old run's web view processes before it makes a window (an installer relaunch starts it while they go away)", read("src-tauri/src/lib.rs").includes("webview_health::wait_for_previous_run();"));
  ok("the window is created hidden and shown by the ready report, never from setup", code.includes("window created hidden") && !read("src-tauri/src/lib.rs").slice(read("src-tauri/src/lib.rs").indexOf(".setup(|app| {"), read("src-tauri/src/lib.rs").indexOf(".on_window_event")).includes("show_main"));
  ok("every look of a show reads the screen, up to 30 s", code.includes("const LOOKS_MS: [u64; 6] = [300, 1000, 3000, 8000, 15000, 30000];") && code.includes("const SCREEN_LOOKS: usize = 6;"));
  ok("a window nobody can judge is re-asserted once, a window nobody found painted is looked at again at every show", code.includes("pub fn blind_reassert_due(") && code.includes("pub fn looks_wanted(") && read("src-tauri/src/shell.rs").includes("looks_wanted(was_hidden, was_minimized, crate::startup::paint_confirmed())"));
  ok("the log keeps the start of its run when it starts over, and its first line says how the process was started", code.includes("static HEAD: Mutex<Vec<String>>") && read("src-tauri/src/lib.rs").includes('startup::line("start", &startup::launch_description());'));
}

// ---- 2. a real debug build ---------------------------------------------------------------------------------------------------------------------
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const exe = arg("exe");
if (!exe) {
  console.log("SKIPPED the real-app part (pass --exe=<path of a DEBUG build with its own identifier>; Windows only)");
} else if (process.platform !== "win32") {
  console.log("SKIPPED the real-app part (Windows only)");
} else {
  const rounds = Number(arg("rounds") ?? 3);
  const delay = Number(arg("delay") ?? 50);
  const extra = arg("args") ? [arg("args")] : [];
  const PS = path.join(ROOT, "scripts", "lib", "window-pixels.ps1");
  const pixels = (pid) => {
    const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS, "-ProcessId", String(pid), "-Mode", "screen", "-Raise"], { encoding: "utf8", timeout: 30000 });
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
  const waitLog = async (dir, re, from, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (re.test(logOf(dir).slice(from))) return true;
      await sleep(200);
    }
    return false;
  };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hl-relaunch-"));
  const env = { ...process.env, HEYLOOK_TEST_BRIDGE: "0", HEYLOOK_DATA_DIR: dataDir };
  const started = [];
  process.on("exit", () => started.forEach((p) => spawnSync("taskkill", ["/PID", String(p), "/T", "/F"], { stdio: "ignore" })));
  for (let i = 1; i <= rounds; i++) {
    // the old run
    const old = spawn(exe, extra, { env, stdio: "ignore" });
    started.push(old.pid);
    const upBefore = logOf(dataDir).length;
    ok(`[round ${i}] the old run shows its window`, await waitLog(dataDir, /window shown, page ready/, upBefore, 60000));
    // the updater plugin ends the old process at once (process::exit(0)); the installer starts the new one a moment later, with the same arguments
    spawnSync("taskkill", ["/PID", String(old.pid), "/F"], { stdio: "ignore" });
    await sleep(delay);
    const from = logOf(dataDir).length;
    const fresh = spawn(exe, extra, { env, stdio: "ignore" });
    started.push(fresh.pid);
    const shown = await waitLog(dataDir, /window shown|giving up|error message/, from, 60000);
    ok(`[round ${i}] the new run shows its window`, shown, logOf(dataDir).slice(from).slice(-500));
    const looks = [];
    const t0 = Date.now();
    for (const at of [2000, 5000, 10000, 20000]) {
      await sleep(Math.max(0, at - (Date.now() - t0)));
      const p = pixels(fresh.pid);
      looks.push({ at, vis: p.visible, dom: p.dominantRatio, distinct: p.distinct, owned: p.owned });
    }
    const log = logOf(dataDir).slice(from);
    console.log(`[round ${i}] looks: ${JSON.stringify(looks)}`);
    const last = looks[looks.length - 1];
    ok(`[round ${i}] the window shows a page at the end (more than 3 colours, no colour on 95 % of the points)`, last.distinct > 3 && last.dom < 0.95, JSON.stringify(last));
    ok(`[round ${i}] the run says how it was started in its first line`, /^\[start \+\d+ ms\] Hey Look! \S+ started: pid \d+, program .*arguments \[/m.test(log), log.slice(0, 300));
    ok(`[round ${i}] no error message about the page was needed`, !/giving up|the app could not load its interface/.test(log), log.slice(-400));
    spawnSync("taskkill", ["/PID", String(fresh.pid), "/T", "/F"], { stdio: "ignore" });
    await sleep(3000);
  }
}
console.log(bad ? `${bad} FAILED` : "all ok");
process.exit(bad ? 1 : 0);
