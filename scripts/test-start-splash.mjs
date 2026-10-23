// 1.0.7 fix12 (owner: "can the app show a loading indicator in its own style instead of an empty white window?", D-057): the first frame of a slow start, in the real app.
//
// A DEBUG build with its own identifier (the test bridge and the delay are debug-only) and Windows (the pixel reader is scripts/lib/window-pixels.ps1). Without --exe it
// only checks the wiring and says SKIPPED for the rest. A QA-kit script, not part of .github/node-tests.txt: it needs a built debug exe, a desktop and a visible window.
//
//   node scripts/test-start-splash.mjs [--exe=<debug hey-look.exe>] [--theme=dark,light] [--seed=db|both|none] [--delay=9000] [--json]
//
// Per theme: a first run (throw-away data folder) stores the theme setting through the app's own `set_setting` (--seed=both also writes what applyPrefs keeps for the
// next start's page, localStorage["heylook.boot"]; db = the backend's setting only, so the page has to take the theme from the window; none = the OS theme), and ends.
// The second run is started with HEYLOOK_TEST_BOOT_DELAY_MS=<delay> (more than the 6 s ready wait): the window is created hidden, the page does not mount, after 6 s the
// window is shown WITHOUT a ready signal (startup.rs) with the start screen of index.html on it, and the page is loaded again (held again: the first two loads of the
// window are held, the third mounts at once). The script reads the screen (what the compositor shows) every 400 ms and asserts, for each theme:
//   * the window is not shown before the ready wait is over (nothing to see = nothing white to see);
//   * the first frame the window shows is the theme's ground, exactly (dark rgb 27,28,32 / light 255,255,255) on > 95 % of the points, and in the dark theme 0 % white;
//   * the logo is on the screen: the centre 72 x 72 of the client area has > 40 % of its pixels off the ground (a real screen shot of the window, not the DOM);
//   * startup.log says "the start screen" for the looks at 300 ms, 1 s and 3 s and runs no cure (re-assert, nudge, hide + show, reload by the watchdog, restart);
//   * after the page mounts the window shows content (more than 3 colours, no colour on 95 % of the points) and the DOM has no splash left.
// The first-frame numbers go to the output (and with --json to a JSON line) for the report.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bridge, connection } from "./test-bridge-client.mjs";
import { decodePng } from "./lib/paint-probe.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r/g, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (name, cond, detail = "") => {
  if (!cond) bad++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${!cond && detail ? ` -- ${detail}` : ""}`);
};

// ---- 1. static ------------------------------------------------------------------------------------------------------------------------------------
{
  const rs = read("src-tauri/src/startup.rs"), lib = read("src-tauri/src/lib.rs"), bg = read("src-tauri/src/bgcolor.rs"), main = read("src/main.tsx");
  ok("the delay switch is compiled in debug builds only", /#\[cfg\(debug_assertions\)\]\npub fn boot_delay_ms\(\)/.test(rs) && /#\[cfg\(debug_assertions\)\]\n    let builder = match startup::boot_delay_ms\(\)/.test(lib));
  ok("main.tsx holds the first loads back by the switch and nothing else", main.includes("__heylookBootDelay") && main.includes("heylook.bootDelayed"));
  ok("the main window takes the colour of the theme at the start of setup, a pop-out at creation, every theme change through wintheme::apply_all", bg.includes("bgcolor::apply(app.handle())") && bg.includes("for_new_window(app)") && bg.includes("crate::bgcolor::apply(app)"));
}

// ---- 2. a real debug build ------------------------------------------------------------------------------------------------------------------------
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const exe = arg("exe");
if (!exe) {
  console.log("SKIPPED the real-app part (pass --exe=<path of a DEBUG build with its own identifier>; Windows only)");
} else if (process.platform !== "win32") {
  console.log("SKIPPED the real-app part (Windows only: the pixel reader and the web view are WebView2)");
} else {
  const themes = (arg("theme") ?? "dark,light").split(",");
  const seed = arg("seed") ?? "both";
  const delay = Number(arg("delay") ?? 9000);
  const PS = path.join(ROOT, "scripts", "lib", "window-pixels.ps1");
  const pixels = (pid, save = "") => {
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS, "-ProcessId", String(pid), "-Mode", "screen"];
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
  const kill = async (child) => {
    try {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* gone */
    }
    await sleep(1500);
  };
  const results = [];
  for (const theme of themes) {
    const dark = theme === "dark";
    const ground = dark ? [27, 28, 32] : [255, 255, 255];
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `hl-splash-${theme}-`));
    const shot = path.join(dataDir, "first-frame.png");
    const env = { ...process.env, HEYLOOK_TEST_BRIDGE: "0", HEYLOOK_DATA_DIR: dataDir };
    const live = [];
    process.on("exit", () => live.forEach((c) => spawnSync("taskkill", ["/PID", String(c.pid), "/T", "/F"], { stdio: "ignore" })));
    try {
      // -- the first run stores the setting ---------------------------------------------------------------------------------------------------------
      if (seed !== "none") {
        const first = spawn(exe, [], { env, stdio: "ignore" });
        live.push(first);
        ok(`[${theme}] the first run is up`, await waitLog(dataDir, /the page reported itself ready/, 90000), logOf(dataDir).slice(-300));
        const b = bridge(connection(dataDir));
        const prefs = JSON.stringify({ theme });
        await b.evalIn("main", `await window.__TAURI_INTERNALS__.invoke('set_setting', { key: 'prefs', value: ${JSON.stringify(prefs)} }); ${seed === "both" ? `localStorage.setItem('heylook.boot', JSON.stringify({ theme: ${JSON.stringify(theme)}, accent: '#0f6cbd' }));` : ""} return 1;`);
        await sleep(500);
        await kill(first);
        fs.rmSync(path.join(dataDir, "test-bridge.json"), { force: true });
        fs.rmSync(path.join(dataDir, "startup.log"), { force: true }); // (the lines of the second run only: the waits below look for "ready")
      }
      // -- the slow start --------------------------------------------------------------------------------------------------------------------------
      const child = spawn(exe, [], { env: { ...env, HEYLOOK_TEST_BOOT_DELAY_MS: String(delay) }, stdio: "ignore" });
      live.push(child);
      const t0 = Date.now();
      const rows = [];
      let shown = null, firstShown = null, savedAt = null;
      while (Date.now() - t0 < 26000) {
        const p = pixels(child.pid);
        const t = Date.now() - t0;
        if (p.found && p.visible && !shown) {
          shown = t;
          firstShown = p;
          // the same instant again, saved as a picture
          pixels(child.pid, shot);
          savedAt = t;
        }
        rows.push({ t, vis: p.visible ? "v" : "-", rgb: p.dominantRgb, dom: p.dominantRatio, white: p.whiteRatio, distinct: p.distinct, owned: p.owned });
        if (/the page reported itself ready/.test(logOf(dataDir)) && t > 7000) {
          await sleep(1500);
          break;
        }
        await sleep(400);
      }
      const log = logOf(dataDir);
      console.log(`[${theme}] looks (ms after the start: visible / dominant colour / share / white share / distinct colours / points on the window):`);
      for (const r of rows.filter((_, i) => i % 3 === 0 || rows[i].t === shown)) console.log(`      ${String(r.t).padStart(6)}  ${r.vis}  ${r.rgb}  ${r.dom}  white ${r.white}  distinct ${r.distinct}  owned ${r.owned}`);
      for (const l of log.split("\n").filter((l) => /bgcolor|background colour|native check|window shown|no ready signal|reloading|ready|wintheme.*applied to|blank|cure|re-assert|nudg|hide \+ show/i.test(l))) console.log(`      log: ${l.slice(0, 260)}`);
      const sawBefore = rows.filter((r) => r.t < 4500 && r.vis === "v").length;
      ok(`[${theme}] the window is not shown while the page is still being waited for (first 4.5 s)`, sawBefore === 0, `${sawBefore} looks saw it`);
      ok(`[${theme}] the window is shown without a ready signal after the 6 s wait`, shown !== null && /window shown without a ready signal/.test(log), `shown at ${shown}`);
      if (firstShown) {
        const dominant = firstShown.dominantRgb?.split(",").map(Number) ?? [];
        ok(`[${theme}] the first frame is the ground of the theme, rgb ${ground} (read ${firstShown.dominantRgb}, ${firstShown.dominantRatio})`, dominant.join() === ground.join() && firstShown.dominantRatio >= 0.95, JSON.stringify(firstShown));
        if (dark) ok(`[${theme}] no white at all in the first frame of the dark theme (white share ${firstShown.whiteRatio})`, firstShown.whiteRatio === 0, JSON.stringify(firstShown));
        ok(`[${theme}] the first frame is the start screen, not a page: one colour on > 95 % of the points`, firstShown.dominantRatio >= 0.95);
        let logoShare = null;
        try {
          const img = decodePng(fs.readFileSync(shot));
          const cx = img.width >> 1, cy = img.height >> 1;
          let diff = 0, total = 0;
          for (let y = cy - 32; y < cy + 32; y++)
            for (let x = cx - 32; x < cx + 32; x++) {
              const o = (y * img.width + x) * img.channels;
              total++;
              if (Math.abs(img.data[o] - ground[0]) > 6 || Math.abs(img.data[o + 1] - ground[1]) > 6 || Math.abs(img.data[o + 2] - ground[2]) > 6) diff++;
            }
          logoShare = diff / total;
        } catch (e) {
          console.log(`      (the picture could not be read: ${e.message})`);
        }
        ok(`[${theme}] the logo is on the screen: the centre 64 x 64 of the window has ${logoShare === null ? "?" : Math.round(logoShare * 100)} % of its pixels off the ground (> 40 %)`, logoShare !== null && logoShare > 0.4);
        results.push({ theme, seed, firstFrame: { atMs: shown, rgb: firstShown.dominantRgb, share: firstShown.dominantRatio, white: firstShown.whiteRatio, distinct: firstShown.distinct, logoShare, client: [firstShown.clientW, firstShown.clientH] } });
      }
      ok(`[${theme}] the log says the looks found the start screen`, /native check at \d+ ms: .*one colour \(rgb [\d,]+ on \d+ % of the points, \d+ colours?\): the start screen/.test(log), log.split("\n").filter((l) => /native check/.test(l)).join("\n"));
      ok(`[${theme}] no cure ran while the page was starting`, !/blank window|still blank|re-asserting|changing the web view's size|hide \+ show \(attempt/.test(log), log.split("\n").filter((l) => /blank|cure|re-assert/.test(l)).join("\n"));
      ok(`[${theme}] the backend gave the window the colour of the theme at the start`, new RegExp(`background colour ${theme} on \\d+ windows \\(start\\)`).test(log), log.split("\n").filter((l) => /background colour/.test(l)).join("\n"));
      // -- after the mount -----------------------------------------------------------------------------------------------------------------------
      const mounted = await waitLog(dataDir, /the page reported itself ready/, 20000);
      ok(`[${theme}] the page mounts and reports itself`, mounted);
      if (mounted) {
        await sleep(1500);
        const p = pixels(child.pid);
        ok(`[${theme}] after the mount the window shows content (more than 3 colours, no colour on 95 % of the points)`, p.distinct > 3 && p.dominantRatio < 0.95, JSON.stringify(p));
        const dom = await bridge(connection(dataDir)).evalIn("main", "return { splash: document.querySelectorAll('.boot-splash').length, theme: document.documentElement.getAttribute('data-theme'), bg: getComputedStyle(document.documentElement).backgroundColor }");
        ok(`[${theme}] no splash is left in the page (data-theme ${dom.theme}, ground ${dom.bg})`, dom.splash === 0);
      }
      await kill(child);
    } finally {
      live.forEach((c) => spawnSync("taskkill", ["/PID", String(c.pid), "/T", "/F"], { stdio: "ignore" }));
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
  }
  if (process.argv.includes("--json")) console.log(JSON.stringify(results));
}
console.log(bad ? `${bad} FAILED` : "all ok");
process.exit(bad ? 1 : 0);
