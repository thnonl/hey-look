// Scratch (never committed): memory per open/close cycle of secondary windows of a DEBUG build, through the test bridge.
//   node scripts/_memcycle.mjs --exe=<debug hey-look.exe> [--kind=reader|scheduled|search|compose] [--cycles=30] [--warmup=5]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { bridge, connection } from "./test-bridge-client.mjs";

const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) ?? `--${n}=${d}`).split("=").slice(1).join("=");
const exe = arg("exe", "");
const kind = arg("kind", "reader");
const cycles = Number(arg("cycles", 30));
const warmup = Number(arg("warmup", 5));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hl-mem-"));
const cdpPort = 9400 + Math.floor(Math.random() * 400);
const env = { ...process.env, HEYLOOK_TEST_BRIDGE: "0", HEYLOOK_DATA_DIR: dataDir };
if (process.platform === "win32") env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${cdpPort}`;
const child = spawn(exe, [], { env, stdio: "ignore" });
process.on("exit", () => {
  try {
    child.kill();
  } catch {
    /* gone */
  }
});
let conn = null;
for (let i = 0; i < 240 && !conn; i++) {
  try {
    conn = connection(dataDir);
  } catch {
    await sleep(250);
  }
}
if (!conn) throw new Error("no bridge");
const b = bridge(conn);
for (let i = 0; i < 120; i++) {
  const w = await b.list().catch(() => []);
  if (w.some((x) => x.label === "main")) break;
  await sleep(250);
}
await sleep(4000);
const invoke = (cmd, args = {}) => b.evalIn("main", `return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
const opens = {
  reader: () => invoke("popout_open", { kind: "reader", key: "fake-thread", init: { threadId: "fake-thread" }, focusOnly: null }),
  scheduled: () => invoke("popout_open", { kind: "scheduled", key: "scheduled", init: {}, focusOnly: null }),
  search: () => invoke("popout_open", { kind: "search", key: null, init: { search: "invoice", scope: "all", folder: "inbox", accountId: null, filter: "all" }, focusOnly: null }),
  compose: () => invoke("popout_open", { kind: "compose", key: null, init: { to: "", subject: "x", body: "" }, focusOnly: null }),
};
async function cycle() {
  const r = await opens[kind]();
  if (!r?.label) throw new Error("not opened: " + JSON.stringify(r));
  for (let t0 = Date.now(); Date.now() - t0 < 10000; ) {
    const w = (await b.list()).find((x) => x.label === r.label);
    if (w?.visible) break;
    await sleep(100);
  }
  await sleep(1200);
  await invoke("popout_close", { label: r.label }).catch(() => undefined);
  for (let t0 = Date.now(); Date.now() - t0 < 8000; ) {
    if (!(await b.list()).some((x) => x.label === r.label)) break;
    await sleep(100);
  }
  await sleep(500);
}
const mb = (n) => (n == null ? null : Math.round((n / 1048576) * 100) / 100);
const snap = async () => {
  const n = await b.native();
  return { private: mb(n.privateBytes), rss: mb(n.rssBytes), windows: n.webviewWindows };
};
try {
  for (let i = 0; i < warmup; i++) await cycle();
  await sleep(8000);
  const a = await snap();
  const series = [];
  for (let i = 0; i < cycles; i++) {
    await cycle();
    if ((i + 1) % 10 === 0) series.push(await snap());
  }
  await sleep(8000);
  const z = await snap();
  console.log(JSON.stringify({ kind, cycles, before: a, series, after: z, privatePerCycleMB: Math.round(((z.private - a.private) / cycles) * 1000) / 1000, rssPerCycleMB: Math.round(((z.rss - a.rss) / cycles) * 1000) / 1000 }));
} finally {
  try {
    child.kill();
  } catch {
    /* gone */
  }
}
