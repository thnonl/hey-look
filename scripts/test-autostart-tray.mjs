// 1.0.9 (owner, after 1.0.8: "the all-white window still happens when the app starts automatically with Windows ... autostart should start the app in tray mode: the
// window only appears when the user opens the app or opens it from the tray"). The autostart entry has carried `--minimized` since 1.0.0 and a start with it has been a
// tray start (hidden window, tray icon) since 1.0.7 (startgate.rs); this test pins that and the holes closed around it (src-tauri/src/autostart.rs): the entry is looked after,
// a test copy has its own entry, a second `--minimized` start does not bring the window up, a restart that a person is looking at keeps the window, a tray start checks that
// its icon is really there.
//
// 1.0.10 (owner decision): the start at Windows sign-in is a VISIBLE start by default. The entry is `"<exe>"` (no `--minimized`); the opt-in switch Settings > Notifications >
// "Start in the tray" (pref startInTray, default off) makes it `"<exe>" --minimized`, the 1.0.9 tray start. The entry is looked after in the form that matches the switch, so the
// `--minimized` entry of every install from 1.0.0 .. 1.0.9 is written again without the flag. A start without the flag shortly after the desktop shell began (a sign-in start) is
// gated like a tray start (startgate.rs), then shows its window.
//
// Static (runs in CI): the wiring in the sources. With --exe (a DEBUG build with its own identifier, Windows, a visible desktop; a QA-kit run, not part of CI): the real thing,
//   A  `--minimized` start: no visible window of the process and no taskbar button for 10 s, the tray icon confirmed in the log; a second `--minimized` start leaves the window
//      hidden; a second start without the flag shows it, painted (pixels from the screen at 2 and 5 s).
//   B  the note of a restart that a person was looking at (fresh: the window comes back; an hour old: it stays hidden).
//   D  the tray icon taken out of the notification area behind the icon library's back (HEYLOOK_TEST_TRAY=drop): the check finds it missing, asks for it again, the icon
//      comes back and the window stays hidden; with drop-always (asking does nothing) the check gives up after 15 s and the window is shown, not an invisible app.
//   E  the ghost (a hidden window that the compositor still draws white): the control run (parking off) sees it, the run with the look heals it; A needs it to stay away.
//   C  the autostart entry (a throw-away registry key, HEYLOOK_TEST_RUN_KEY, never the Run key Windows runs): with the switch off an entry of this exe in the old forms (path not
//      quoted, `--minimized`) is written again as `"<exe>"`; with the switch on (pref in the app's database) as `"<exe>" --minimized`; the right one and the entry of another
//      program are left alone; turning the switch on or off in a running app writes the entry at once.
//   G  (inside the C run) the sign-in switch as the page calls it (set_autostart): ON writes the current user's entry in the form of the tray switch and reads it back, OFF removes it;
//      a Run key that cannot be written is an error that names the entry and carries the Windows text (the Sandbox finding: the plugin's enable() wrote the machine-wide key of an
//      elevated run and said Ok while the switch showed on with no entry for the user)
//   F  the visible start at sign-in (a start without the flag, the shell told to be young: HEYLOOK_TEST_SHELL_AGE_S): the log says it is gated and why, the window is made after the
//      gate, shown and painted with a taskbar button, never parked, no tray check; with an old shell it is no gated start at all.
//
//   node scripts/test-autostart-tray.mjs [--exe=<debug hey-look.exe>] [--only=A,C,F]
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
  ok("the autostart entry has no flag on Windows (a visible start) and keeps the tray flag on macOS and on Linux with a tray host (none on Linux without one)", /let entry_args: &\[&str\] = if cfg!\(windows\) \{ &\[\] \} else \{ autostart::unix_entry_args\(cfg!\(target_os = "linux"\), tray_host\) \};/.test(run) && /tauri_plugin_autostart::Builder::new\(\)\.args\(entry_args\.iter\(\)\.copied\(\)\)/.test(run) && auto.includes('pub const TRAY_FLAG: &str = "--minimized";'));
  ok("the switch is the pref startInTray, off by default; the flag or (package task only) the switch makes a tray start", auto.includes('pub const TRAY_PREF: &str = "startInTray";') && auto.includes("crate::shell::pbool(prefs, TRAY_PREF, false)") && run.includes("autostart::tray_start(std::env::args().any(|a| a == autostart::TRAY_FLAG), pkg::started_by_startup_task(), &start_prefs)") && read("src/prefs.ts").includes("startInTray: false,"));
  ok("the entry is written without the flag unless the switch is on", auto.includes('if tray { format!("\\"{exe}\\" {TRAY_FLAG}") } else { format!("\\"{exe}\\"") }'));
  ok("a start without the flag just after the desktop shell began is gated, then shown (not a tray start)", gate.includes("sign_in_start(age)") && gate.includes("pub const SIGN_IN_SHELL_AGE: Duration = Duration::from_secs(180);") && gate.includes('format!("a start at sign-in ({})", describe_shell_age(age))') && run.includes("startgate::reason()"));
  ok("a copy that is not the owner's has its own entry name (a QA build never overwrites the installed app's entry)", run.includes("identity::isolated().then(identity::aumid)") && run.includes(".app_name(entry_name)"));
  ok("a start with the flag makes its window after the start gate and keeps it hidden until it is asked for", gate.includes("pub fn wanted(args: &[String], windows: bool)") && run.includes("startgate::defer(context.config_mut())") && code("src-tauri/src/startup.rs").includes("window stays hidden (tray start)"));
  ok("the tray icon is created before the gate waits, and a tray that cannot be created shows the window", run.indexOf("shell::setup_tray(") < run.indexOf("startgate::start(app.handle(), show_at_start)") && run.includes("let show_at_start = !minimized || !shell::tray_ready() || window_wanted;"));
  ok("an icon that the shell does not know is asked for again, and when it never comes the window is shown", gate.includes("autostart::tray_confirmed(") && gate.includes("show_at_start = true") && code("src-tauri/src/shell.rs").includes("pub fn tray_icon_present(") && auto.includes('"tray_icon_app"') && auto.includes('w!("TaskbarCreated")'));
  ok("a second start with the flag does not bring the window up, any other second start does", /autostart::is_tray_start\(&args\)[\s\S]{0,300}return;[\s\S]{0,200}shell::show_main\(app\)/.test(run));
  ok("the entry is looked at at every start, after the start-at-sign-in switch is turned on and when the tray switch changes, in the Windows registry only", run.includes("autostart::ensure_entry(autostart::start_in_tray(&start_prefs));") && /fn set_autostart[\s\S]{0,1200}autostart::set_entry\(enabled, autostart::start_in_tray\(/.test(lib) && /fn set_setting[\s\S]{0,1500}if now != before \{\s*autostart::ensure_entry\(now\);/.test(lib) && auto.includes("pub fn ensure_entry(_tray: bool) {}") && cargo.includes('"Win32_System_Registry"'));
  {
    // the looking after (every start, a change of the tray switch) never touches the Task Manager switch; only the person turning the sign-in switch ON in the app turns it on again (what the plugin did)
    const ensure = auto.slice(auto.indexOf("pub fn ensure_entry(tray: bool)"), auto.indexOf("pub fn ensure_entry(_tray: bool) {}"));
    ok("only this program's entry is written; the Task Manager switch (StartupApproved) is touched only by turning the sign-in switch ON", auto.includes("Plan::Other =>") && ensure.length > 100 && !/StartupApproved|approve\(/.test(ensure) && auto.includes("win::approve(name);") && (auto.match(/win::approve\(/g) || []).length === 1);
    // F2 (QA 1.0.10, Windows Sandbox): the plugin's enable() uses the machine-wide Run key when the app runs as an administrator and says Ok; on Windows the app writes the current user's key itself and reads it back
    const setEntry = auto.slice(auto.indexOf("pub fn set_entry("));
    ok("on Windows the sign-in switch is written to the current user's Run key by the app and read back; a refusal reaches the page as an error with the Windows text", /win::write_run_value_checked\([\s\S]{0,400}check_written\(/.test(setEntry) && setEntry.includes("Windows refused") && /fn set_autostart[\s\S]{0,1200}#\[cfg\(windows\)\]\s*\{[\s\S]{0,200}autostart::set_entry\(/.test(lib) && /RegCreateKeyExW\(HKEY_CURRENT_USER/.test(auto));
  }
  ok("a restart that a person is looking at leaves the note (the app's own restart, the update restart) and takes it back when the installer did not start", code("src-tauri/src/startup.rs").includes("crate::autostart::mark_window_wanted(dir, now)") && /if restart && crate::window_shown\(&app\)/.test(code("src-tauri/src/update.rs")) && code("src-tauri/src/update.rs").includes("clear_window_wanted"));
  const ghost = code("src-tauri/src/ghost.rs");
  ok("a tray start parks its window right after it is made (off every monitor), so the compositor's white ghost of a never-shown window is not on a screen", gate.includes("and_then(|b| b.focused(take_focus).build()).map(|_| ())") && gate.includes("crate::ghost::park(&app)") && gate.indexOf("crate::ghost::park(&app)") > gate.indexOf("WebviewWindowBuilder::from_config") && ghost.includes("pub const PARK_AT: f64 = -10_000.0;"));
  ok("F1: the window of a tray start is made without the focus (wry moves the web view's focus into a focused window, which made the hidden window the foreground window); a window that is shown at once keeps it", gate.includes("pub fn focus_at_creation(show_at_start: bool, requested: bool) -> bool {\n    show_at_start || requested\n}") && gate.includes("focus_at_creation(show_at_start, REQUESTED.load(Ordering::SeqCst))") && gate.indexOf("focus_at_creation(show_at_start, REQUESTED") > gate.indexOf("autostart::tray_confirmed("));
  const showMain = code("src-tauri/src/shell.rs");
  ok("every show of the main window gives a parked window its place back first", showMain.includes("crate::ghost::unpark(app);") && showMain.indexOf("crate::ghost::unpark(app);") < showMain.indexOf("let _ = w.show();", showMain.indexOf("pub fn show_main")) && showMain.indexOf("pub fn show_main") < showMain.indexOf("crate::ghost::unpark(app);"));
  ok("a hidden window is looked at (a tray start, and after the close button hid it): white desktop points at its place are a ghost, healed by parking, logged", ghost.includes("pub fn is_ghost(") && ghost.includes("healed by parking the window") && code("src-tauri/src/startup.rs").includes('crate::ghost::watch_hidden(app, "the tray start"') && lib.includes('ghost::watch_hidden(window.app_handle(), "the window was hidden"'));
  const dlg = read("src/components/SettingsDialog.tsx");
  ok("the switch \"Start in the tray\" sits under the start-at-sign-in switch, Windows only, greyed with a hint while that one is off; its label is short and in all 8 languages", /startInTrayOffered\(os, tray\)[\s\S]{0,400}disabled=\{!autostart\.enabled\}[\s\S]{0,100}setPrefs\(\{ startInTray: v \}\)/.test(dlg) && read("src/trayWords.ts").includes('os === "windows" && tray') && /settings\.tray\.startInTray": "Start in the tray"/.test(read("src/i18n/ns/settings.ts")) && ["de", "es", "fr", "ja", "ru", "vi", "zh-Hans"].every((l) => /settings\.tray\.startInTray": "[^"]{2,40}"/.test(read(`src/i18n/locales/${l}/settings.ts`))));
  ok("the old hint \"Starts minimized to the tray\" is gone on Windows (the start shows the window), Mac and Linux keep theirs", read("src/trayWords.ts").includes('startsMinimizedHint = (os: Os) => os !== "windows"') && dlg.includes("startsMinimizedHint(os) ? t(startsMinimizedKey(os)) : undefined"));
  ok("this test is in the CI list", read(".github/node-tests.txt").includes("node scripts/test-autostart-tray.mjs"));
}

// ---- 2. a real debug build ---------------------------------------------------------------------------------------------------------------------
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const exe = arg("exe");
/** `--only=C,F`: run these parts of the real-app run only (the E part reads the bare desktop and needs a screen that is mostly free; the others do not). */
const only = arg("only")?.split(",").map((x) => x.trim().toUpperCase());
const want = (k) => !only || only.includes(k);
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
    // (an app that restarted itself after a blank page is a new process: the kit exe is stopped by name, never the installed app's hey-look.exe)
    if (path.basename(exe).toLowerCase() !== "hey-look.exe") spawnSync("taskkill", ["/IM", path.basename(exe), "/T", "/F"], { stdio: "ignore" });
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
  if (want("A")) {
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
  if (!want("E")) {
    console.log("NOTE [E] not selected (--only)");
  } else if (locked) {
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
  for (const [what, age, shown] of want("B") ? [["fresh", 5, true], ["an hour old", 3600, false]] : []) {
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
  if (want("D")) {
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

  // the app's database of a data folder: the pref of the switch is the `prefs` row of the settings table (node:sqlite, Node 22.5+; the app ran once in this folder, so the table is there)
  const setPrefs = async (dir, prefs) => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(dir, "heylook.db"));
    db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('prefs', ?)").run(JSON.stringify(prefs));
    db.close();
  };

  // ---- C. the autostart entry ----
  if (want("C")) {
    const dir = newDir("c");
    let app = start(dir, ["--minimized"]);
    ok("[C] with no entry the log says so (and the state of the switch)", await waitLog(dir, /\[autostart \+\d+ ms\] no entry "[^"]+" in the Run key.*\(Start in the tray: off\)/, 0, 60000), logOf(dir).slice(0, 600));
    const name = logOf(dir).match(/no entry "([^"]+)" in the Run key/)?.[1];
    ok("[C] a test copy's entry is not named like the installed app's (\"Hey Look!\" alone)", !!name && name !== "Hey Look!" && name.startsWith("Hey Look! ["), String(name));
    await kill(app);
    if (name) {
      const tray = `"${exe}" --minimized`;
      const visible = `"${exe}"`;
      const other = String.raw`C:\Windows\System32\notepad.exe --minimized`;
      const cases = [
        // [what, switch, entry found, entry after, log]
        ["the entry of 1.0.9 (flag), switch off: the visible start", false, tray, visible, /was .*--minimized: written again as "[^"]+" \(Start in the tray: off\)/],
        ["the entry of 1.0.0 .. 1.0.8 (path not quoted, flag), switch off", false, `${exe} --minimized`, visible, /was .*: written again as/],
        ["the path not quoted, no flag, switch off", false, exe, visible, /was .*: written again as/],
        ["already visible, switch off", false, visible, visible, /entry "[^"]+" is "[^"]+" \(Start in the tray: off\)/],
        ["another program, switch off", false, other, other, /starts another program .*: left alone/],
        ["visible entry, switch ON: the tray start", true, visible, tray, /was .*: written again as .*--minimized \(Start in the tray: on\)/],
        ["already the tray entry, switch ON", true, tray, tray, /entry "[^"]+" is .*--minimized \(Start in the tray: on\)/],
        ["another program, switch ON", true, other, other, /starts another program .*: left alone/],
      ];
      for (const [what, on, seed, want, logRe] of cases) {
        await setPrefs(dir, { startInTray: on });
        reg("add", hkcu(RUN_KEY), "/v", name, "/t", "REG_SZ", "/d", seed, "/f");
        const from = logOf(dir).length;
        app = start(dir, ["--minimized"]); // (the entry is looked at before any window: a tray start does the same and keeps the run off the screen of whoever is working)
        ok(`[C] ${what}: the log says what was done`, await waitLog(dir, logRe, from, 60000), logOf(dir).slice(from).slice(0, 600));
        ok(`[C] ${what}: the entry is ${want === seed ? "unchanged" : `written as ${want}`}`, regValue(name) === want, String(regValue(name)));
        await kill(app);
      }
      // the switch turned on and off in a RUNNING app writes the entry at once (set_setting of the prefs blob, as the page does it)
      const ldir = newDir("cl"); // (a folder of its own: the test-bridge.json of a killed run would be stale)
      reg("add", hkcu(RUN_KEY), "/v", name, "/t", "REG_SZ", "/d", visible, "/f");
      const { connection, bridge } = await import("./test-bridge-client.mjs");
      app = start(ldir, ["--minimized"]); // (a tray start: the window stays hidden, so the run does not put a window on the screen of whoever is working)
      ok("[C live] the app is up", await waitLog(ldir, /page ready after \d+ ms, window stays hidden/, 0, 90000));
      const b = bridge(connection(ldir));
      const setPref = (v) => b.evalIn("main", `window.__TAURI_INTERNALS__.invoke("set_setting", { key: "prefs", value: JSON.stringify({ startInTray: ${v} }) }).then(() => "done")`);
      const from = logOf(ldir).length;
      await setPref(true);
      await sleep(800);
      ok("[C live] the switch ON writes the tray entry at once", regValue(name) === tray && /was .*: written again as .*--minimized \(Start in the tray: on\)/.test(logOf(ldir).slice(from)), `${regValue(name)} | ${logOf(ldir).slice(from).slice(-300)}`);
      await setPref(false);
      await sleep(800);
      ok("[C live] the switch OFF writes the visible entry at once", regValue(name) === visible, String(regValue(name)));
      reg("delete", hkcu(RUN_KEY), "/v", name, "/f");
      await setPref(true);
      await sleep(800);
      ok("[C live] with no entry (start at sign-in off) the switch writes nothing", regValue(name) === null, String(regValue(name)));
      // G (F2): the sign-in switch itself (set_autostart, as the page calls it) writes the current user's entry in the form of the tray switch and removes it
      await setPref(false);
      await sleep(300);
      const sw = (on) => b.evalIn("main", `window.__TAURI_INTERNALS__.invoke("set_autostart", { enabled: ${on} }).then(() => "ok", (e) => "ERR " + e)`);
      ok("[G live] the sign-in switch ON writes the visible entry and reads it back", (await sw(true)) === "ok" && regValue(name) === visible, String(regValue(name)));
      await setPref(true);
      await sleep(800);
      ok("[G live] the tray switch then makes it the tray entry", regValue(name) === tray, String(regValue(name)));
      ok("[G live] the sign-in switch OFF removes the entry", (await sw(false)) === "ok" && regValue(name) === null, String(regValue(name)));
      ok("[G live] the sign-in switch ON with the tray switch on writes the tray entry", (await sw(true)) === "ok" && regValue(name) === tray, String(regValue(name)));
      ok("[G live] the log says the switch was turned on and the entry read back", /the switch was turned on \(Start in the tray: on\): the entry was read back/.test(logOf(ldir)), logOf(ldir).slice(-500));
      await kill(app);
      // G: a Run key that cannot be written (here a key name over 255 characters) is an error with the Windows text, not a switch that says on with no entry
      const edir = newDir("ce");
      const badKey = String.raw`Software\thnonl\HeyLookTest109\Bad` + process.pid + "\\" + "x".repeat(300);
      app = start(edir, ["--minimized"], { HEYLOOK_TEST_RUN_KEY: badKey });
      ok("[G error] the app is up", await waitLog(edir, /page ready after \d+ ms, window stays hidden/, 0, 90000));
      const be = bridge(connection(edir));
      const res = await be.evalIn("main", `window.__TAURI_INTERNALS__.invoke("set_autostart", { enabled: true }).then(() => "ok", (e) => "ERR " + e)`);
      ok("[G error] a refused write is an error that names the entry and carries the Windows text", /^ERR The start at sign-in could not be turned on: Windows refused to write the entry "[^"]+" \(.+\)\.$/.test(String(res)), String(res));
      ok("[G error] the log says it", /the switch was turned on \(Start in the tray: off\): could not be done/.test(logOf(edir)), logOf(edir).slice(-400));
      await kill(app);
      // the entry of the installed app was never part of this
      const real = reg("query", String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, "/v", name);
      ok("[C] nothing was written to the Run key Windows runs", real.status !== 0);
    }
  }

  // ---- F. the visible start at sign-in ----
  for (const [what, env, gated] of !want("F") ? [] : [["the shell is young (20 s)", { HEYLOOK_TEST_SHELL_AGE_S: "20" }, true], ["no taskbar yet", { HEYLOOK_TEST_SHELL_AGE_S: "none" }, true], ["the shell is old (a start by hand)", { HEYLOOK_TEST_SHELL_AGE_S: "86400" }, false]]) {
    const dir = newDir("f");
    const before = locked ? null : whiteDesktop();
    const app = start(dir, [], env);
    ok(`[F ${what}] the window is shown (a visible start)`, await waitLog(dir, /window shown, page ready/, 0, 90000) && /window created hidden \(show at start: true\)/.test(logOf(dir)), logOf(dir).slice(-800));
    const log = logOf(dir);
    if (gated) {
      ok(`[F ${what}] the log says the start is gated and why`, /\[gate \+\d+ ms\] this is a start at sign-in \((the desktop shell began 20 s ago|the taskbar window does not exist yet)\): the main window is made after the start gate/.test(log), log.slice(0, 900));
      ok(`[F ${what}] the gates were read and the window made after them`, /\[gate \+\d+ ms\] start gate: the window waits for the desktop/.test(log) && /all gates open after \d+ ms: making the window/.test(log) && /window made after the start gate/.test(log), log.slice(0, 1500));
    } else {
      ok(`[F ${what}] no gate: a normal start, the window of the config`, !/start gate: the window waits/.test(log) && !/this is a start at sign-in/.test(log), log.slice(0, 900));
    }
    ok(`[F ${what}] no tray check, no parking, no ghost look (those are for a tray start)`, !/\[tray \+/.test(log) && !/parked off-screen/.test(log) && !/\[ghost \+\d+ ms\] look/.test(log), log.slice(-800));
    await sleep(2500);
    const w = windows(app.pid);
    ok(`[F ${what}] the window is visible, on the screen, with a taskbar button`, w.mainVisible === true && w.taskbarButtons >= 1 && w.mainLeft > -5000, JSON.stringify(w).slice(0, 300));
    const p = pixels(app.pid);
    ok(`[F ${what}] it is painted (more than 3 colours, no colour on 95 % of the points; not white)`, p.visible === true && p.distinct > 3 && p.dominantRatio < 0.95, JSON.stringify({ vis: p.visible, dom: p.dominantRatio, distinct: p.distinct, owned: p.owned }));
    await kill(app);
    if (before) {
      const after = whiteDesktop();
      ok(`[F ${what}] after the app ended nothing white is left on the bare desktop (${newWhite(before, after)} new points)`, newWhite(before, after) === 0, JSON.stringify(after).slice(0, 200));
    }
  }
}
console.log(bad ? `${bad} FAILED` : "all ok");
process.exit(bad ? 1 : 0);
