// Checks .github/node-tests.txt (the CI list of node tests, one "<shard> | <command>" per line) and prints the estimated time of each shard.
// Run: node scripts/check-shards.mjs
// Fails (exit 1) when a line has no shard or an unknown one (the known shards are `static` and the `ui_shards` of the plan job in
// .github/workflows/release.yml, so the list and the workflow cannot drift apart), when a command is listed twice (it would run twice),
// when a script a command names does not exist, or when a shard of the workflow has no command (run-node-tests.sh fails on an empty shard).
// Prints as NOTE only (never a failure): scripts/test-*.mjs that no shard runs. Some are meant that way (a QA kit that needs a built exe and a
// desktop, a library for other tests); a new test that was forgotten shows up here.
// The estimate uses .github/node-tests-times.json (seconds of the green run 39917754788); a command without a number gets the median of the UI
// commands. Each shard job also spends about 15 s on checkout, setup-node and npm ci, printed as "job" seconds.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");
const SETUP_SECONDS = 15;

const errors = [];
const notes = [];

// the shards the workflow runs: `static` always, the ui_shards of the plan job on a tag run or with ui_tests
const wf = read(".github/workflows/release.yml");
const uiLine = /^\s*ui_shards='([^']*)'\s*$/m.exec(wf);
if (!uiLine) errors.push("release.yml: the plan job has no line  ui_shards='ui-a ui-b ...'");
const uiShards = uiLine ? uiLine[1].split(/\s+/).filter(Boolean) : [];
const known = new Set(["static", ...uiShards]);

// the same reading as .github/scripts/run-node-tests.sh: "#" lines and empty lines are comments, the shard is the text before the first " | "
const entries = [];
read(".github/node-tests.txt")
  .split("\n")
  .forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    if (line === "" || line.startsWith("#")) return;
    const at = line.indexOf(" | ");
    if (at < 0) {
      errors.push(`node-tests.txt:${i + 1}: no "<shard> | <command>": ${line}`);
      return;
    }
    entries.push({ line: i + 1, shard: line.slice(0, at), cmd: line.slice(at + 3) });
  });

const seen = new Map();
for (const e of entries) {
  if (!known.has(e.shard)) errors.push(`node-tests.txt:${e.line}: unknown shard "${e.shard}" (known: ${[...known].join(", ")})`);
  if (seen.has(e.cmd)) errors.push(`node-tests.txt:${e.line}: the command is already on line ${seen.get(e.cmd)}: ${e.cmd}`);
  else seen.set(e.cmd, e.line);
  for (const f of e.cmd.match(/(?:\.github\/)?scripts\/[\w./-]+\.(?:mjs|cjs|sh)/g) ?? []) {
    if (!existsSync(path.join(root, f))) errors.push(`node-tests.txt:${e.line}: ${f} does not exist`);
  }
}
for (const s of known) if (!entries.some((e) => e.shard === s)) errors.push(`shard "${s}" has no command in node-tests.txt`);

const listed = new Set(entries.flatMap((e) => e.cmd.match(/scripts\/[\w.-]+\.mjs/g) ?? []).map((f) => f.slice("scripts/".length)));
const unlisted = readdirSync(path.join(root, "scripts")).filter((f) => /^test-.*\.mjs$/.test(f) && !listed.has(f));
if (unlisted.length) notes.push(`scripts/test-*.mjs that no shard runs: ${unlisted.join(", ")}`);

// estimate
const seconds = JSON.parse(read(".github/node-tests-times.json")).seconds ?? {};
const recordedUi = entries.filter((e) => e.shard !== "static" && seconds[e.cmd] !== undefined).map((e) => seconds[e.cmd]).sort((a, b) => a - b);
const median = recordedUi.length ? recordedUi[Math.floor(recordedUi.length / 2)] : 30;
const rows = [...known].map((shard) => {
  const mine = entries.filter((e) => e.shard === shard);
  const guessed = mine.filter((e) => seconds[e.cmd] === undefined);
  const sec = mine.reduce((sum, e) => sum + (seconds[e.cmd] ?? (shard === "static" ? 1 : median)), 0);
  return { shard, count: mine.length, sec, guessed: guessed.length };
});
for (const k of Object.keys(seconds)) if (!seen.has(k)) notes.push(`node-tests-times.json has a number for a command that is not listed: ${k}`);

console.log("shard   commands  tests(s)  job(s)  job(min)  no-number");
for (const r of rows) {
  console.log(`${r.shard.padEnd(7)} ${String(r.count).padStart(8)}  ${String(r.sec).padStart(8)}  ${String(r.sec + SETUP_SECONDS).padStart(6)}  ${((r.sec + SETUP_SECONDS) / 60).toFixed(1).padStart(8)}  ${String(r.guessed).padStart(9)}`);
}
const ui = rows.filter((r) => r.shard !== "static");
if (ui.length) {
  const longest = Math.max(...ui.map((r) => r.sec + SETUP_SECONDS));
  const mean = ui.reduce((s, r) => s + r.sec + SETUP_SECONDS, 0) / ui.length;
  console.log(`UI shards run in parallel: slowest ${(longest / 60).toFixed(1)} min, mean ${(mean / 60).toFixed(1)} min (a command without a number counts ${median} s)`);
  if (longest > mean * 1.25) notes.push(`the slowest UI shard (${longest} s) is more than 25% over the mean (${Math.round(mean)} s): move a command (the shard is the first word of its line)`);
}
for (const n of notes) console.log(`NOTE: ${n}`);
if (errors.length) {
  for (const e of errors) console.log(`ERROR: ${e}`);
  process.exit(1);
}
console.log(`check-shards: ok (${entries.length} commands in ${rows.length} shards)`);
