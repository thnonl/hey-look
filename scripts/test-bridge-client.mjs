// Client of the debug-only test bridge (src-tauri/src/testbridge/): drive and inspect the windows of a DEBUG build of Hey Look! from a script,
// the way the CDP tests do on Windows. Node 22+ (global fetch), no dependencies.
//
//   import { connection, bridge } from "./test-bridge-client.mjs";
//   const b = bridge(connection("<data folder>"));      // test-bridge.json, else startup.log, else stderr.log of that folder; or bridge({ port, token })
//   console.log(await b.list());
//   console.log(await b.evalIn("main", "document.title"));
//   await b.click("main", "button[aria-label='Compose']");
//   await b.snapshot("main", "main.png");
//
// The bridge is off unless the app was started with HEYLOOK_TEST_BRIDGE=<port|0>; it writes {port, token, pid, started} to test-bridge.json in the data
// folder (removed when the app ends cleanly) and logs "test bridge: listening on 127.0.0.1:<port>, token <hex>" to startup.log (kept when the log starts
// over at its size cap). See the README of the QA kit (E:\hey-mail\test-builds\bridge\README.md) for the protocol.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** `{ port, token }` from the last "test bridge: listening" line of a startup.log. */
export function fromStartupLog(logPath) {
  const text = fs.readFileSync(logPath, "utf8");
  const all = [...text.matchAll(/test bridge: listening on 127\.0\.0\.1:(\d+), token ([0-9a-f]{64})/g)];
  if (!all.length) throw new Error(`no "test bridge: listening" line in ${logPath} (was the app started with HEYLOOK_TEST_BRIDGE=0 ?)`);
  const m = all[all.length - 1];
  return { port: Number(m[1]), token: m[2] };
}

/** `{ port, token }` from a test-bridge.json (`{ port, token, pid, started }`). */
export function fromInfoFile(file) {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Number.isInteger(j.port) || !/^[0-9a-f]{64}$/.test(String(j.token))) throw new Error(`${file} has no port and token`);
  return { port: j.port, token: j.token, pid: j.pid, started: j.started };
}

/**
 * `{ port, token }` of the bridge of the app that uses the data folder `dir`: test-bridge.json first (written at start), then startup.log, then stderr.log
 * (the app prints the same line there; a launcher that redirects stderr keeps it). `where` may also be one of those files.
 */
export function connection(where) {
  if (fs.existsSync(where) && fs.statSync(where).isFile()) return /\.json$/i.test(where) ? fromInfoFile(where) : fromStartupLog(where);
  const tried = [];
  for (const [name, read] of [["test-bridge.json", fromInfoFile], ["startup.log", fromStartupLog], ["stderr.log", fromStartupLog]]) {
    const file = path.join(where, name);
    try {
      return read(file);
    } catch (e) {
      tried.push(`${name}: ${fs.existsSync(file) ? e.message : "not there"}`);
    }
  }
  throw new Error(`no test bridge found in ${where} (${tried.join("; ")}). Was the app started with HEYLOOK_TEST_BRIDGE=0 and HEYLOOK_DATA_DIR=${where} ?`);
}

export class BridgeError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** A client for `{ port, token }`. Every method throws `BridgeError` when the bridge refuses or the script fails (`ok: false`). */
export function bridge({ port, token, host = "127.0.0.1" }) {
  const base = `http://${host}:${port}`;
  const headers = { Authorization: `Bearer ${token}` };
  async function call(method, path, body) {
    const res = await fetch(base + path, { method, headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const type = res.headers.get("content-type") || "";
    if (type.startsWith("image/")) return Buffer.from(await res.arrayBuffer());
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new BridgeError(`${method} ${path}: HTTP ${res.status} ${json?.error ?? ""}`.trim(), res.status, json);
    if (json && json.ok === false) throw new BridgeError(`${method} ${path}: ${json.error}`, res.status, json);
    return json;
  }
  return {
    port,
    call,
    /** [{ label, title, visible, focused, x, y, width, height, logicalX, logicalY, logicalWidth, logicalHeight, scale, kind }] (x ... height: physical pixels; logical*: physical / scale) */
    list: () => call("GET", "/windows"),
    /** Runs `js` in the window. One expression (`document.title`) or the body of an async function (use `return`). Resolves to the value. */
    evalIn: async (window, js, { timeoutMs, awaitPromise } = {}) => (await call("POST", "/eval", { window, js, timeoutMs, awaitPromise })).value,
    /** Clicks the element at `selector` (centre, after scrolling to it), or at `{ x, y }` (CSS pixels). Resolves to what was hit: { target, x, y, overlay }. */
    click: (window, target, { button, double, index } = {}) => call("POST", "/click", { window, ...(typeof target === "string" ? { selector: target } : target), button, double, index }),
    /** Types `text` into the focused element, or into `selector` after focusing it. */
    type: (window, text, selector = null, { clear } = {}) => call("POST", "/type", { window, text, selector, clear }),
    /** Presses a key on the focused element: "Enter", "Tab", "Escape", "ArrowDown", "a" ... with { ctrl, shift, alt, meta }. */
    key: (window, key, mods = {}) => call("POST", "/key", { window, key, ...mods }),
    /** { last, entries: [{ n, t, level, text }] } of the console buffer after entry number `since`. */
    console: (window, since = 0) => call("GET", `/console?window=${encodeURIComponent(window)}&since=${since}`),
    /** { attempts, requested, outcome, tile, mainThread, platform } of the last macOS Dock badge request (see test-bridge.md). */
    badge: () => call("GET", "/badge"),
    /** { pid, rssBytes, footprintBytes, privateBytes, nsapp: { total, visible, titled } | null, webviewWindows } of the app process (null where a system has no such number; see test-bridge.md). */
    native: () => call("GET", "/native"),
    /** Saves a PNG of the window's web content to `file` and resolves to the bytes. */
    snapshot: async (window, file) => {
      const png = await call("GET", `/snapshot?window=${encodeURIComponent(window)}`);
      if (file) fs.writeFileSync(file, png);
      return png;
    },
  };
}

// command line: node test-bridge-client.mjs <data folder | test-bridge.json | startup.log | port:token> <list | eval WIN JS | click WIN SELECTOR | type WIN TEXT [SELECTOR] | key WIN KEY | console WIN [SINCE] | badge | native | snapshot WIN FILE>
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [where, cmd, ...rest] = process.argv.slice(2);
  if (where && cmd) {
    const conn = /^\d+:[0-9a-f]{64}$/.test(where) ? { port: Number(where.split(":")[0]), token: where.split(":")[1] } : connection(where);
    const b = bridge(conn);
    const show = (v) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
    try {
      if (cmd === "list") show(await b.list());
      else if (cmd === "eval") show(await b.evalIn(rest[0], rest[1]));
      else if (cmd === "click") show(await b.click(rest[0], rest[1]));
      else if (cmd === "type") show(await b.type(rest[0], rest[1], rest[2] ?? null));
      else if (cmd === "key") show(await b.key(rest[0], rest[1]));
      else if (cmd === "console") show(await b.console(rest[0], Number(rest[1] ?? 0)));
      else if (cmd === "badge") show(await b.badge());
      else if (cmd === "native") show(await b.native());
      else if (cmd === "snapshot") show(`${(await b.snapshot(rest[0], rest[1])).length} bytes -> ${rest[1]}`);
      else throw new Error(`unknown command ${cmd}`);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  }
}
