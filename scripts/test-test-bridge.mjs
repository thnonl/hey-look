// The debug-only test bridge (src-tauri/src/testbridge/), checked from the outside:
//  1. the sources keep it out of release builds (module and uses cfg(debug_assertions), no command / capability / setting names it, the
//     environment variable is named in one file, the release workflow searches the built app for it);
//  2. the client (scripts/test-bridge-client.mjs) sends what the protocol says (a small fake server);
//  3. with --exe=<path of a DEBUG build> (it must have its own identifier, e.g. thnonl.heylook.qa.bridge: the single-instance plug-in would
//     otherwise hand the start to a running Hey Look!): starts it with HEYLOOK_TEST_BRIDGE=0 and a throw-away HEYLOOK_DATA_DIR, reads the port and
//     token from startup.log and checks the endpoints and the guards. Without --exe this part is skipped.
//   node scripts/test-test-bridge.mjs [--exe=<hey-look.exe>]
// The Rust side (HTTP parsing, token / Host / Origin guards, routes, per-window lock, cfg guards) is `cargo test --lib testbridge` in src-tauri.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bridge, connection, fromStartupLog, BridgeError } from "./test-bridge-client.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const NAME = ["HEYLOOK", "TEST", "BRIDGE"].join("_");
let bad = 0;
const ok = (name, cond, extra = "") => {
  if (cond) console.log(`ok    ${name}`);
  else {
    console.log(`FAIL  ${name} ${extra}`);
    bad++;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1. sources ----------------------------------------------------------------------------------------------------------------------------
{
  const lib = read("src-tauri/src/lib.rs");
  ok("lib.rs declares the module for debug builds only", lib.includes("#[cfg(debug_assertions)]\nmod testbridge;\n") && lib.split("mod testbridge;").length === 2);
  // each line of lib.rs that names the module (comments aside) sits right after the attribute
  const lines = lib.split("\n");
  const first = lines.findIndex((l, i) => l.trim() === "#[cfg(test)]" && /^mod \w+ \{/.test((lines.slice(i + 1).find((x) => !x.trim().startsWith("#[")) || "").trim()));
  const code = lines.slice(0, first < 0 ? lines.length : first);
  const uses = code.map((l, i) => [l.split("//")[0], i]).filter(([l]) => l.includes("testbridge"));
  const gated = uses.every(([, i]) => {
    let j = i - 1;
    while (j >= 0 && code[j].trim().startsWith("//")) j--;
    return code[j].trim() === "#[cfg(debug_assertions)]";
  });
  ok("every use of the module in lib.rs is cfg(debug_assertions)", gated && uses.length === 3, `uses=${uses.length}`);
  const text = (p) => read(p).toLowerCase();
  for (const f of ["src-tauri/build.rs", "src-tauri/capabilities/default.json", "src-tauri/capabilities/popout.json", "src-tauri/tauri.conf.json", "src-tauri/tauri.no-updater.conf.json"]) {
    ok(`${f} does not mention the bridge`, !text(f).includes("bridge"));
  }
  const handler = lib.slice(lib.indexOf("tauri::generate_handler!["));
  ok("generate_handler! does not list a bridge command", !handler.slice(0, handler.indexOf("])")).toLowerCase().includes("bridge"));
  const dir = path.join(ROOT, "src-tauri/src/testbridge");
  const rs = fs.readdirSync(dir).filter((f) => f.endsWith(".rs"));
  const banned = ["#[tauri::" + "command]", "generate_" + "handler!", "invoke_" + "handler("];
  ok("the module registers no command", rs.every((f) => !banned.some((b) => fs.readFileSync(path.join(dir, f), "utf8").includes(b))));
  const holders = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(rs|ts|tsx|json|js)$/.test(e.name) && fs.readFileSync(p, "utf8").includes(NAME)) holders.push(path.relative(ROOT, p).replace(/\\/g, "/"));
    }
  };
  walk(path.join(ROOT, "src-tauri/src"));
  walk(path.join(ROOT, "src"));
  ok("only testbridge/mod.rs names the environment variable", holders.length === 1 && holders[0] === "src-tauri/src/testbridge/mod.rs", JSON.stringify(holders));
  const wf = read(".github/workflows/release.yml");
  ok("the release workflow searches the built app for the bridge", wf.includes("check-no-test-bridge.cjs") && wf.includes("No test bridge in the release app") && /profile == 'release'/.test(wf.slice(wf.indexOf("No test bridge in the release app"))));
  const r = spawnSync(process.execPath, [path.join(ROOT, ".github/scripts/check-no-test-bridge.cjs"), "--selftest"], { encoding: "utf8" });
  ok("check-no-test-bridge.cjs --selftest", r.status === 0, r.stdout + r.stderr);
}

// ---- 2. the client against a fake server -----------------------------------------------------------------------------------------------------
{
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, host: req.headers.host, body: body ? JSON.parse(body) : null });
      if (req.url.startsWith("/snapshot")) {
        res.writeHead(200, { "Content-Type": "image/png" });
        return res.end(Buffer.from("\x89PNGfake", "latin1"));
      }
      if (req.url === "/native") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ pid: 1, rssBytes: 2, footprintBytes: null, privateBytes: 3, nsapp: null, webviewWindows: 1 }));
      if (req.url === "/windows") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify([{ label: "main" }]));
      if (req.url === "/nope") return res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: "bad token" }));
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: req.url !== "/key", value: 42, error: "boom", target: { tag: "button" } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const token = "ab".repeat(32);
  const b = bridge({ port, token });
  ok("list", (await b.list())[0].label === "main");
  ok("native (debug-only /native, REQ-4.1.5)", (await b.native()).webviewWindows === 1 && seen.at(-1).url === "/native" && seen.at(-1).method === "GET");
  seen.pop();
  ok("evalIn returns the value", (await b.evalIn("reader-1", "1+1", { timeoutMs: 900 })) === 42);
  ok("click by selector", (await b.click("main", "#send", { double: true })).target.tag === "button");
  await b.click("main", { x: 5, y: 6 });
  await b.type("compose-2", "hi", "textarea");
  const err = await b.key("main", "Enter", { ctrl: true }).catch((e) => e);
  ok("ok:false becomes BridgeError", err instanceof BridgeError && /boom/.test(err.message));
  const tmp = path.join(os.tmpdir(), `bridge-test-${process.pid}.png`);
  ok("snapshot saves the PNG", (await b.snapshot("main", tmp)).subarray(0, 4).toString("latin1") === "\x89PNG" && fs.existsSync(tmp));
  fs.rmSync(tmp, { force: true });
  await b.console("main", 7);
  ok("every request carries the token and the loopback host", seen.every((s) => s.auth === `Bearer ${token}` && s.host === `127.0.0.1:${port}`));
  ok("paths and bodies", seen[1].url === "/eval" && seen[1].body.window === "reader-1" && seen[1].body.js === "1+1" && seen[1].body.timeoutMs === 900);
  ok("click bodies", seen[2].body.selector === "#send" && seen[2].body.double === true && seen[3].body.x === 5 && seen[3].body.y === 6 && seen[3].body.selector === undefined);
  ok("type body", seen[4].body.text === "hi" && seen[4].body.selector === "textarea" && seen[4].body.window === "compose-2");
  ok("key body", seen[5].body.key === "Enter" && seen[5].body.ctrl === true);
  ok("console query", seen.at(-1).url === "/console?window=main&since=7");
  const refused = await bridge({ port, token }).call("GET", "/nope").catch((e) => e);
  ok("an HTTP error becomes BridgeError with the status", refused instanceof BridgeError && refused.status === 401);
  const logFile = path.join(os.tmpdir(), `bridge-test-${process.pid}.log`);
  fs.writeFileSync(logFile, `[window +1 ms] other\n[bridge +5 ms] test bridge: listening on 127.0.0.1:4242, token ${"0f".repeat(32)}\n`);
  ok("fromStartupLog", JSON.stringify(fromStartupLog(logFile)) === JSON.stringify({ port: 4242, token: "0f".repeat(32) }));
  fs.rmSync(logFile, { force: true });
  // a data folder: test-bridge.json first, then startup.log, then stderr.log
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-dir-"));
  const tok = (c) => c.repeat(64);
  const threw = (f) => { try { f(); return null; } catch (e) { return e.message; } };
  ok("an empty folder says what was tried", /no test bridge found/.test(threw(() => connection(dir)) ?? "") && /test-bridge\.json: not there/.test(threw(() => connection(dir)) ?? ""));
  fs.writeFileSync(path.join(dir, "stderr.log"), `[bridge +9 ms] test bridge: listening on 127.0.0.1:3003, token ${tok("3")}\n`);
  ok("stderr.log is the last resort", JSON.stringify(connection(dir)) === JSON.stringify({ port: 3003, token: tok("3") }));
  fs.writeFileSync(path.join(dir, "startup.log"), `[window +1 ms] other\n[bridge +5 ms] test bridge: listening on 127.0.0.1:2002, token ${tok("2")}\n`);
  ok("startup.log comes before stderr.log", connection(dir).port === 2002);
  fs.writeFileSync(path.join(dir, "startup.log"), "[window +1 ms] the log was cut and has no bridge line\n");
  ok("a startup.log without the line falls through to stderr.log", connection(dir).port === 3003);
  fs.writeFileSync(path.join(dir, "test-bridge.json"), JSON.stringify({ port: 1001, token: tok("1"), pid: 4242, started: "2026-10-18T10:00:00+00:00" }));
  const c = connection(dir);
  ok("test-bridge.json comes first", c.port === 1001 && c.token === tok("1") && c.pid === 4242);
  ok("a file path works too", connection(path.join(dir, "test-bridge.json")).port === 1001 && connection(path.join(dir, "stderr.log")).port === 3003);
  fs.writeFileSync(path.join(dir, "test-bridge.json"), "{ not json");
  ok("a broken test-bridge.json falls through", connection(dir).port === 3003);
  fs.rmSync(dir, { recursive: true, force: true });
  server.close();
}

// ---- 3. a real debug build -------------------------------------------------------------------------------------------------------------------
const exeArg = process.argv.find((a) => a.startsWith("--exe="));
if (!exeArg) {
  console.log("SKIPPED the real-app part (pass --exe=<path of a debug build with its own identifier>)");
} else {
  const exe = exeArg.slice(6);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hl-bridge-"));
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
      const info = JSON.parse(fs.readFileSync(path.join(dataDir, "test-bridge.json"), "utf8"));
      ok("test-bridge.json has port, token, pid and start", info.port === conn.port && info.token === conn.token && Number.isInteger(info.pid) && info.pid > 0 && !Number.isNaN(Date.parse(info.started)));
      ok("startup.log has the listening line too", fromStartupLog(path.join(dataDir, "startup.log")).token === conn.token);
    }
    if (conn) {
      const b = bridge(conn);
      let wins = [];
      for (let i = 0; i < 120 && !wins.some((w) => w.label === "main"); i++) {
        wins = await b.list().catch(() => []);
        await sleep(250);
      }
      const nat = await b.native().catch((e) => e);
      ok("/native has the process numbers (REQ-4.1.5)", nat.pid === child.pid && nat.rssBytes > 1e6 && nat.webviewWindows >= 1 && "footprintBytes" in nat && "privateBytes" in nat && "nsapp" in nat, JSON.stringify(nat));
      ok("/native: private bytes on Windows, footprint and NSApp on macOS, null elsewhere", process.platform === "win32" ? nat.privateBytes > 1e6 && nat.footprintBytes === null && nat.nsapp === null : process.platform === "darwin" ? nat.footprintBytes > 1e6 && nat.nsapp.total >= 1 && nat.nsapp.titled >= 1 : nat.footprintBytes === null && nat.privateBytes === null && nat.nsapp === null, JSON.stringify(nat));
      ok("/windows lists main", wins.some((w) => w.label === "main" && w.kind === "main"));
      const main = wins.find((w) => w.label === "main");
      ok("/windows has the logical frame next to the physical one", !!main && Math.abs(main.logicalWidth * main.scale - main.width) <= main.scale && Math.abs(main.logicalHeight * main.scale - main.height) <= main.scale && [main.logicalX, main.logicalY].every(Number.isFinite), JSON.stringify(main));
      let title = null;
      for (let i = 0; i < 60 && !title; i++) {
        title = await b.evalIn("main", "document.title").catch(() => null);
        if (!title) await sleep(500);
      }
      ok("/eval reads document.title", typeof title === "string" && title.length > 0, String(title));
      ok("/eval awaits a promise", (await b.evalIn("main", "return await new Promise((r) => setTimeout(() => r(7), 100))")) === 7);
      ok("/eval reports a page error", await b.evalIn("main", "return nope.x").then(() => false, (e) => /ReferenceError/.test(e.message)));
      await b.evalIn("main", "console.log('bridge-test-line', {a: 1}); console.warn('careful')");
      const logs = await b.console("main", 0);
      ok("/console has what the page logged", logs.entries.some((e) => e.level === "log" && e.text.includes("bridge-test-line")) && logs.entries.some((e) => e.level === "warn"));
      const png = await b.snapshot("main", null);
      ok("/snapshot is a PNG", png.length > 1000 && png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), `${png.length} bytes`);
      const raw = (headers, p = "/windows") =>
        new Promise((resolve, reject) => {
          const req = http.request({ host: "127.0.0.1", port: conn.port, path: p, method: "GET", headers }, (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
          });
          req.on("error", reject);
          req.end();
        });
      ok("wrong token is 401", (await raw({ Host: `127.0.0.1:${conn.port}`, "X-Bridge-Token": "0".repeat(64) })) === 401);
      ok("no token is 401", (await raw({ Host: `127.0.0.1:${conn.port}` })) === 401);
      ok("wrong Host is 403", (await raw({ Host: `evil.example:${conn.port}`, "X-Bridge-Token": conn.token })) === 403);
      ok("an Origin is 403", (await raw({ Host: `127.0.0.1:${conn.port}`, Origin: "https://evil.example", "X-Bridge-Token": conn.token })) === 403);
      ok("the right headers are 200", (await raw({ Host: `localhost:${conn.port}`, Authorization: `Bearer ${conn.token}` })) === 200);
    }
  } finally {
    stop();
    await sleep(500);
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

console.log(bad ? `\n${bad} check(s) failed` : "\nall checks passed");
process.exit(bad ? 1 : 0);
