// 1.0.9 (owner, after 1.0.8: "the all-white window still happens when the app starts automatically with Windows ... autostart should start the app in tray mode: the
// window only appears when the user opens the app or opens it from the tray"). The autostart entry has carried `--minimized` since 1.0.0 and a start with it has been a
// tray start (hidden window, tray icon) since 1.0.7 (startgate.rs); this test pins that and the holes closed around it (src-tauri/src/autostart.rs): the entry is looked after,
// a test copy has its own entry, a second `--minimized` start does not bring the window up, a restart that a person is looking at keeps the window, a tray start checks that
// its icon is really there.
//
// Static (runs in CI): the wiring in the sources. With --exe (a DEBUG build with its own identifier, Windows, a visible desktop; a QA-kit run, not part of CI): the real thing,
//   A  `--minimized` start: no visible window of the process and no taskbar button for 10 s, the tray icon confirmed in the log; a second `--minimized` start leaves the window
//      hidden; a second start without the flag shows it, painted (pixels from the screen at 2 and 5 s).
//   B  the note of a restart that a person was looking at (fresh: the window comes back; an hour old: it stays hidden).
//   D  the tray icon taken out of the notification area behind the icon library's back (HEYLOOK_TEST_TRAY=drop): the check finds it missing, asks for it again, the icon
//      comes back and the window stays hidden; with drop-always (asking does nothing) the check gives up after 15 s and the window is shown, not an invisible app.
//   E  the ghost (a hidden window that the compositor still draws white): the control run (parking off) sees it, the run with the look heals it; A needs it to stay away.
//   C  the autostart entry (a throw-away registry key, HEYLOOK_TEST_RUN_KEY, never the Run key Windows runs): an entry of this exe in the old form (path not quoted) or
//      without the flag is written again as `"<exe>" --minimized`; the right one and the entry of another program are left alone.
//
//   node scripts/test-autostart-tray.mjs [--exe=<debug hey-look.exe>]
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r/g, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (name, cond, detail = "") => {
  if (!cond) bad++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${!cond && detail ? ` -- ${detail}` : ""}`);
};
/** The source of a Rust file without its test module. */
const code = (p) => {
  const s = read(p);
  const i = s.indexOf("#[cfg(test)]\nmod tests");
  return i < 0 ? s : s.slice(0, i);
};

// ---- 1. static ---------------------------------------------------------------------------------------------------------------------------------
{
  const lib = code("src-tauri/src/lib.rs");
  const run = lib.slice(lib.indexOf("pub fn run() {"));
  const gate = code("src-tauri/src/startgate.rs");
  const auto = code("src-tauri/src/autostart.rs");
  const cargo = read("src-tauri/Cargo.toml");
  ok("the autostart entry carries the tray flag, on every system", /tauri_plugin_autostart::Builder::new\(\)\.args\(\[autostart::TRAY_FLAG\]\)/.test(run) && auto.includes('pub const TRAY_FLAG: &str = "--minimized";'));
  ok("a copy that is not the owner's has its own entry name (a QA build never overwrites the installed app's entry)", run.includes("identity::isolated().then(identity::aumid)") && run.includes(".app_name(entry_name)"));
  ok("a start with the flag makes its window after the start gate and keeps it hidden until it is asked for", gate.includes("pub fn wanted(args: &[String], windows: bool)") && run.includes("startgate::defer(context.config_mut())") && code("src-tauri/src/startup.rs").includes("window stays hidden (tray start)"));
  ok("the tray icon is created before the gate waits, and a tray that cannot be created shows the window", run.indexOf("shell::setup_tray(") < run.indexOf("startgate::start(app.handle(), show_at_start)") && run.includes("let show_at_start = !minimized || !shell::tray_ready() || window_wanted;"));
  ok("an icon that the shell does not know is asked for again, and when it never comes the window is shown", gate.includes("autostart::tray_confirmed(") && gate.includes("show_at_start = true") && code("src-tauri/src/shell.rs").includes("pub fn tray_icon_present(") && auto.includes('"tray_icon_app"') && auto.includes('w!("TaskbarCreated")'));
  ok("a second start with the flag does not bring the window up, any other second start does", /autostart::is_tray_start\(&args\)[\s\S]{0,300}return;[\s\S]{0,200}shell::show_main\(app\)/.test(run));
  ok("the entry is looked at at every start and after the switch is turned on, in the Windows registry only", run.includes("autostart::ensure_entry();") && /fn set_autostart[\s\S]{0,600}autostart::ensure_entry\(\)/.test(lib) && auto.includes("pub fn ensure_entry() {}") && cargo.includes('"Win32_System_Registry"'));
  ok("only this program's entry is written; the Task Manager switch (StartupApproved) is not touched", auto.includes("Plan::Other =>") && !/StartupApproved/.test(auto.replace(/\/\/.*$/gm, "")));
  ok("a restart that a person is looking at leaves the note (the app's own restart, the update restart) and takes it back when the installer did not start", code("src-tauri/src/startup.rs").includes("crate::autostart::mark_window_wanted(dir, now)") && /if restart && crate::window_shown\(&app\)/.test(code("src-tauri/src/update.rs")) && code("src-tauri/src/update.rs").includes("clear_window_wanted"));
  const ghost = code("src-tauri/src/ghost.rs");
  ok("a tray start parks its window right after it is made (off every monitor), so the compositor's white ghost of a never-shown window is not on a screen", gate.includes("and_then(|b| b.build()).map(|_| ())") && gate.includes("crate::ghost::park(&app)") && gate.indexOf("crate::ghost::park(&app)") > gate.indexOf("WebviewWindowBuilder::from_config") && ghost.includes("pub const PARK_AT: f64 = -10_000.0;"));
  const showMain = code("src-tauri/src/shell.rs");
  ok("every show of the main window gives a parked window its place back first", showMain.includes("crate::ghost::unpark(app);") && showMain.indexOf("crate::ghost::unpark(app);") < showMain.indexOf("let _ = w.show();", showMain.indexOf("pub fn show_main")) && showMain.indexOf("pub fn show_main") < showMain.indexOf("crate::ghost::unpark(app);"));
  ok("a hidden window is looked at (a tray start, and after the close button hid it): white desktop points at its place are a ghost, healed by parking, logged", ghost.includes("pub fn is_ghost(") && ghost.includes("healed by parking the window") && code("src-tauri/src/startup.rs").includes('crate::ghost::watch_hidden(app, "the tray start"') && lib.includes('ghost::watch_hidden(window.app_handle(), "the window was hidden"'));
  ok("no new text: the hint under the switch is the existing one", /settings\.tray\.startsMinimized": "Starts minimized to the tray"/.test(read("src/i18n/ns/settings.ts")) && read("src/components/SettingsDialog.tsx").includes("t(startsMinimizedKey(os))"));
  ok("this test is in the CI list", read(".github/node-tests.txt").includes("node scripts/test-autostart-tray.mjs"));
}

// ---- 2. a real debug build ---------------------------------------------------------------------------------------------------------------------
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const exe = arg("exe");
if (!exe) {
  console.log("SKIPPED the real-app part (pass --exe=<path of a DEBUG build with its own identifier>; Windows only)");
} else if (process.platform !== "win32") {
  console.log("SKIPPED the real-app part (Windows only)");
} else {
  const PS = (f, args) => {
    const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, "scripts", "lib", f), ...args], { encoding: "utf8", timeout: 30000 });
    try {
      return JSON.parse(r.stdout.trim());
    } catch {
      return { error: (r.stdout + r.stderr).slice(0, 300) };
    }
  };
  const windows = (pid) => PS("tray-start-probe.ps1", ["-ProcessId", String(pid)]);
  // (locked desktop: PrintWindow asks the web view to render itself, which does not need the screen; the app's own looks of the log are screen reads and say "no verdict" then)
  const pixels = (pid) => ({ found: false, ...PS("window-pixels.ps1", ["-ProcessId", String(pid), "-Mode", locked ? "print" : "screen", "-Raise"]) });
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
  // a locked desktop (the lock screen, LogonUI.exe) shows no window of any program, so a read from the screen says nothing: the pixels are then read with PrintWindow
  const locked = spawnSync("tasklist", ["/FI", "IMAGENAME eq LogonUI.exe", "/NH"], { encoding: "utf8" }).stdout.includes("LogonUI.exe");
  if (locked) console.log("NOTE the desktop is locked (LogonUI.exe is running): the pixels are read with PrintWindow, not from the screen");
  const started = [];
  process.on("exit", () => started.forEach((p) => spawnSync("taskkill", ["/PID", String(p), "/T", "/F"], { stdio: "ignore" })));
  const kill = async (p) => {
    spawnSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" });
    await sleep(1500);
  };
  const RUN_KEY = String.raw`Software\thnonl\HeyLookTest109\Run` + process.pid; // (a key of its own per run: the test leaves no value that the next run would find)
  const hkcu = (sub) => "HKCU\\" + sub;
  const reg = (...a) => spawnSync("reg", a, { encoding: "utf8" });
  reg("add", hkcu(RUN_KEY), "/f"); // (a throw-away key: Windows never runs what is in it)
  const regValue = (name) => {
    const r = reg("query", hkcu(RUN_KEY), "/v", name);
    const m = r.stdout.match(/REG_SZ\s+(.*)\r?$/m);
    return m ? m[1].trim() : null;
  };
  const start = (dir, args, extraEnv = {}) => {
    const p = spawn(exe, args, { env: { ...process.env, HEYLOOK_TEST_BRIDGE: "0", HEYLOOK_DATA_DIR: dir, HEYLOOK_TEST_RUN_KEY: RUN_KEY, ...extraEnv }, stdio: "ignore" });
    started.push(p.pid);
    return p;
  };
  // the screen without a window of anyone: points of the bare desktop that are pure white (white-desktop.ps1); what a read before the app started had is not counted
  const whiteDesktop = () => PS("white-desktop.ps1", []);
  const newWhite = (before, after) => {
    const had = new Set(before.points ?? []);
    return (after.points ?? []).filter((p) => !had.has(p)).length;
  };
  const newDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `hl-autostart-${tag}-`));

  // ---- A. a tray start ----
  {
    const dir = newDir("a");
    const before = whiteDesktop();
    const app = start(dir, ["--minimized"]);
    ok("[A] the start says it is a tray start and the window stays hidden", await waitLog(dir, /window stays hidden \(tray start\)/, 0, 90000), logOf(dir).slice(-600));
    ok("[A] the tray icon is confirmed in the notification area", await waitLog(dir, /\[tray \+\d+ ms\] the icon is in the notification area/, 0, 30000), logOf(dir).slice(-600));
    for (const at of [0, 5000, 10000]) {
      if (at) await sleep(5000);
      const w = windows(app.pid);
      ok(`[A] ${at / 1000} s after the page is ready: no visible window of the process, no taskbar button, the hidden main window exists`, w.visibleCount === 0 && w.taskbarButtons === 0 && w.mainFound === true && w.mainVisible === false, JSON.stringify(w).slice(0, 400));
    }
    ok("[A] the window of the tray start was parked off-screen right after it was made", /\[ghost \+\d+ ms\] the window of a tray start is parked off-screen right after it was made \(moved\)/.test(logOf(dir)) && (windows(app.pid).mainLeft ?? 0) < -5000, JSON.stringify(windows(app.pid)).slice(0, 300));
    if (!locked) {
      const after = whiteDesktop();
      ok(`[A] 10 s after the start nothing new is drawn on the desktop (no white ghost of the hidden window: ${newWhite(before, after)} new white points of ${after.desktop})`, after.locked === false && after.desktop > 100 && newWhite(before, after) === 0, JSON.stringify(after).slice(0, 200));
      ok("[A] the ghost look of the app finds nothing to see (the window is not where the screen is)", /\[ghost \+\d+ ms\] look \d+ ms after the tray start: no point of the window's place shows the desktop/.test(logOf(dir)), logOf(dir).slice(-500));
    }
    // a second start that is itself a tray start
    const from = logOf(dir).length;
    start(dir, ["--minimized"]);
    ok("[A] a second --minimized start is handed over and answered with 'the window stays as it is'", await waitLog(dir, /a second --minimized start was handed to this instance: the window stays as it is/, from, 30000), logOf(dir).slice(from));
    await sleep(2000);
    const w2 = windows(app.pid);
    ok("[A] and the window is still hidden", w2.mainVisible === false && w2.visibleCount === 0, JSON.stringify(w2).slice(0, 300));
    // a second start of a person
    const from2 = logOf(dir).length;
    start(dir, []);
    ok("[A] a second start without the flag shows the window", await waitLog(dir, /a second start was handed to this instance: showing the window/, from2, 30000), logOf(dir).slice(from2));
    const t0 = Date.now();
    const looks = [];
    for (const at of [2000, 5000]) {
      await sleep(Math.max(0, at - (Date.now() - t0)));
      const p = pixels(app.pid);
      looks.push({ at, vis: p.visible, dom: p.dominantRatio, distinct: p.distinct, owned: p.owned });
    }
    console.log(`[A] looks: ${JSON.stringify(looks)}`);
    {
      const last = looks[looks.length - 1];
      ok("[A] the window is visible and painted (more than 3 colours, no colour on 95 % of the points)", last.vis === true && last.distinct > 3 && last.dom < 0.95, JSON.stringify(last));
      if (!locked) ok("[A] the app's own look found content", /native check at \d+ ms: .*screen: the window shows content/.test(logOf(dir).slice(from2)), logOf(dir).slice(from2).slice(-500));
    }
    await sleep(locked ? 2500 : 0);
    const shown = windows(app.pid);
    ok("[A] the window is visible with a taskbar button, back on the screen (not parked)", shown.mainVisible === true && shown.taskbarButtons >= 1 && shown.mainLeft > -5000, JSON.stringify(shown).slice(0, 300));
    ok("[A] the parked window got its place back before the show", /\[ghost \+\d+ ms\] the parked window gets its place back .* before it is shown, in \d+ ms/.test(logOf(dir)), logOf(dir).slice(-500));
    await kill(app);
  }

  // ---- E. the ghost itself: the control (parking off), and the look that heals it ----
  if (locked) {
    console.log("NOTE [E] NOT RUN: the lock screen is up, the desktop cannot be read");
  } else {
    for (const [what, mode] of [["control (HEYLOOK_TEST_GHOST=keep: no parking, no healing)", "keep"], ["look (HEYLOOK_TEST_GHOST=look: not parked at creation, the looks heal)", "look"]]) {
      const dir = newDir("e");
      const before = whiteDesktop();
      const app = start(dir, ["--minimized"], { HEYLOOK_TEST_GHOST: mode });
      ok(`[E ${mode}] the tray start keeps its window hidden`, await waitLog(dir, /window stays hidden \(tray start\)/, 0, 90000), logOf(dir).slice(-500));
      if (mode === "keep") {
        await sleep(6000);
        const after = whiteDesktop();
        const n = newWhite(before, after);
        ok(`[E keep] ${what}: the ghost is on the screen (${n} new white points, window hidden: ${windows(app.pid).mainVisible === false}), so the read can see it`, n > 30 && windows(app.pid).mainVisible === false, JSON.stringify(windows(app.pid)).slice(0, 300));
      } else {
        ok("[E look] a look of the app finds the ghost", await waitLog(dir, /\[ghost \+\d+ ms\] look \d+ ms after the tray start: GHOST: /, 0, 30000), logOf(dir).slice(-700));
        ok("[E look] and heals it by parking the window", await waitLog(dir, /\[ghost \+\d+ ms\] healed by parking the window \(moved\): /, 0, 30000), logOf(dir).slice(-700));
        await sleep(3000);
        const after = whiteDesktop();
        ok(`[E look] ${what}: nothing new is drawn after the heal (${newWhite(before, after)} new white points)`, newWhite(before, after) === 0 && (windows(app.pid).mainLeft ?? 0) < -5000, JSON.stringify(windows(app.pid)).slice(0, 300));
        const from = logOf(dir).length;
        start(dir, []);
        ok("[E look] a second start shows the healed window on the screen again", await waitLog(dir, /window shown|native check at/, from, 30000) && windows(app.pid).mainVisible === true && windows(app.pid).mainLeft > -5000, JSON.stringify(windows(app.pid)).slice(0, 300));
      }
      await kill(app);
    }
  }

  // ---- B. the note of a restart that a person was looking at ----
  for (const [what, age, shown] of [["fresh", 5, true], ["an hour old", 3600, false]]) {
    const dir = newDir("b");
    fs.writeFileSync(path.join(dir, "show-after-restart.txt"), String(Math.floor(Date.now() / 1000) - age));
    const app = start(dir, ["--minimized"]);
    if (shown) {
      ok(`[B] ${what} note: the window comes back although the start is a tray start`, await waitLog(dir, /window shown, page ready/, 0, 90000), logOf(dir).slice(-500));
      ok(`[B] ${what} note: the log says why`, /the run before this one was restarted while its window was on screen/.test(logOf(dir)));
      await sleep(1500);
      ok(`[B] ${what} note: the window is visible`, windows(app.pid).mainVisible === true);
    } else {
      ok(`[B] ${what} note: the window stays hidden`, await waitLog(dir, /window stays hidden \(tray start\)/, 0, 90000) && !/restarted while its window was on screen/.test(logOf(dir)), logOf(dir).slice(-500));
    }
    ok(`[B] ${what} note: the note is emptied, so only one start reads it`, fs.readFileSync(path.join(dir, "show-after-restart.txt"), "utf8") === "");
    await kill(app);
  }

  // ---- D. a tray icon the shell does not know ----
  {
    const dir = newDir("d1");
    const app = start(dir, ["--minimized"], { HEYLOOK_TEST_TRAY: "drop" });
    ok("[D] the icon is taken out of the notification area (test seam)", await waitLog(dir, /took the icon out of the notification area/, 0, 90000), logOf(dir).slice(-600));
    ok("[D] the check finds it missing and asks for it again", await waitLog(dir, /the icon is not in the notification area yet: asked it to register again \(its window found\)/, 0, 30000), logOf(dir).slice(-600));
    ok("[D] the icon is back (asked again once or twice) and the window stays hidden", await waitLog(dir, /the icon is in the notification area after \d+ ms \(asked again [1-4] times\): the window stays hidden/, 0, 30000), logOf(dir).slice(-600));
    await sleep(3000);
    const w = windows(app.pid);
    ok("[D] no visible window, no taskbar button", w.taskbarButtons === 0 && w.mainVisible === false, JSON.stringify(w).slice(0, 300));
    await kill(app);
    const dir2 = newDir("d2");
    const app2 = start(dir2, ["--minimized"], { HEYLOOK_TEST_TRAY: "drop-always" });
    ok("[D] an icon that never comes: the check gives up after 15 s", await waitLog(dir2, /the icon is NOT in the notification area after \d+ ms \(asked again 4 times\): the window is shown/, 0, 90000), logOf(dir2).slice(-700));
    ok("[D] and the window is shown (show at start: true), not an app nobody can see", await waitLog(dir2, /window shown, page ready/, 0, 60000) && /window created hidden \(show at start: true\)/.test(logOf(dir2)), logOf(dir2).slice(-700));
    await sleep(1500);
    ok("[D] it is on screen with a taskbar button", windows(app2.pid).taskbarButtons >= 1);
    await kill(app2);
  }

  // ---- C. the autostart entry ----
  {
    const dir = newDir("c");
    let app = start(dir, ["--minimized"]);
    ok("[C] with no entry the log says so", await waitLog(dir, /\[autostart \+\d+ ms\] no entry "[^"]+" in the Run key/, 0, 60000), logOf(dir).slice(0, 600));
    const name = logOf(dir).match(/no entry "([^"]+)" in the Run key/)?.[1];
    ok("[C] a test copy's entry is not named like the installed app's (\"Hey Look!\" alone)", !!name && name !== "Hey Look!" && name.startsWith("Hey Look! ["), String(name));
    await kill(app);
    if (name) {
      const good = `"${exe}" --minimized`;
      const cases = [
        ["the old form (path not quoted)", `${exe} --minimized`, good, /was .*: written again as/],
        ["no flag", `"${exe}"`, good, /was .*: written again as/],
        ["already right", good, good, /entry "[^"]+" is /],
        ["another program", String.raw`C:\Windows\System32\notepad.exe --minimized`, String.raw`C:\Windows\System32\notepad.exe --minimized`, /starts another program .*: left alone/],
      ];
      for (const [what, seed, want, logRe] of cases) {
        reg("add", hkcu(RUN_KEY), "/v", name, "/t", "REG_SZ", "/d", seed, "/f");
        const from = logOf(dir).length;
        app = start(dir, ["--minimized"]);
        ok(`[C] ${what}: the log says what was done`, await waitLog(dir, logRe, from, 60000), logOf(dir).slice(from).slice(0, 600));
        ok(`[C] ${what}: the entry is ${want === seed ? "unchanged" : "written as \"<exe>\" --minimized"}`, regValue(name) === want, String(regValue(name)));
        await kill(app);
      }
      // the entry of the installed app was never part of this
      const real = reg("query", String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, "/v", name);
      ok("[C] nothing was written to the Run key Windows runs", real.status !== 0);
    }
  }
}
console.log(bad ? `${bad} FAILED` : "all ok");
process.exit(bad ? 1 : 0);
