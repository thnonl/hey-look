// The job graph of .github/workflows/release.yml around the node tests: which UI shards exist, and which jobs run (publish above all) for a
// tag push and for a dry run, with and without the input ui_tests. The real `run:` of the plan job is executed with bash, the real `needs`
// and `if:` of the jobs are evaluated with GitHub's rules (a job without a status function in its `if:` is skipped unless all its needs
// succeeded; a skipped need is not a success; a matrix job is as good as its worst leg).
// Run: node scripts/test-release-gates.mjs   (needs bash; skipped when there is none)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
const bash = process.platform === "win32" && existsSync(gitBash) ? gitBash : "bash";
if (spawnSync(bash, ["-c", "exit 0"]).status !== 0) {
  console.log("test-release-gates: SKIPPED, no bash");
  process.exit(0);
}
const posix = (p) => p.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, d) => (process.platform === "win32" ? `/${d.toLowerCase()}` : `${d}:`));

const yml = readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8").split("\n");

// --- the jobs: needs, if, and the plan script, read from the file (no YAML library in the repo) ---
const jobsAt = yml.findIndex((l) => l === "jobs:");
assert.ok(jobsAt > 0, "no jobs: line");
const jobs = {};
let cur = null;
for (let i = jobsAt + 1; i < yml.length; i++) {
  const l = yml[i];
  const j = /^  ([\w-]+):\s*$/.exec(l);
  if (j) {
    cur = jobs[j[1]] = { name: j[1], needs: [], cond: null, start: i };
    continue;
  }
  if (!cur) continue;
  const n = /^    needs:\s*(.*)$/.exec(l);
  if (n) cur.needs = n[1].replace(/[[\]]/g, "").split(",").map((s) => s.trim()).filter(Boolean);
  const c = /^    if:\s*(.*)$/.exec(l);
  if (c) cur.cond = c[1].trim().replace(/^\$\{\{\s*/, "").replace(/\s*\}\}$/, "");
}
for (const n of ["plan", "create-release", "node-tests", "rust-tests", "build", "sign-windows", "publish"]) assert.ok(jobs[n], `job ${n} not found`);

const planScript = (() => {
  const at = yml.findIndex((l, i) => i > jobs.plan.start && /^ {8}run: \|\s*$/.test(l));
  assert.ok(at > 0, "plan run: not found");
  const out = [];
  for (let i = at + 1; i < yml.length && (yml[i] === "" || yml[i].startsWith("          ")); i++) out.push(yml[i].slice(10));
  return out.join("\n");
})();

const dir = mkdtempSync(path.join(tmpdir(), "hl-release-gates-"));
const planFile = path.join(dir, "plan.sh");
writeFileSync(planFile, planScript);

// --- one run of the plan job ---
const runPlan = ({ event, platforms = "", testVersion = "", uiTests = "", signDry = "false", signpathVars = false }) => {
  const out = path.join(dir, "out.txt");
  writeFileSync(out, "");
  const r = spawnSync(bash, [posix(planFile)], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      EVENT: event,
      PLATFORMS: platforms,
      TEST_VERSION: testVersion,
      UI_TESTS: uiTests,
      SIGN_DRY_RUN: signDry,
      SP_ORG: signpathVars ? "o" : "",
      SP_PROJECT: signpathVars ? "p" : "",
      SP_POLICY: signpathVars ? "s" : "",
      REQUIRE_WIN: "",
      GITHUB_OUTPUT: posix(out),
    },
  });
  assert.equal(r.status, 0, `plan script failed: ${r.stdout}${r.stderr}`);
  const outputs = {};
  for (const l of readFileSync(out, "utf8").split("\n")) {
    const k = l.indexOf("=");
    if (k > 0) outputs[l.slice(0, k)] = l.slice(k + 1);
  }
  return outputs;
};

// --- GitHub's evaluation of the graph ---
const hasStatusFn = (c) => c !== null && /\b(cancelled|always|success|failure)\(\)/.test(c);
const evalCond = (cond, ctx) => {
  const js = cond
    .replace(/!cancelled\(\)/g, "true")
    .replace(/needs\.([\w-]+)\.outputs\.(\w+)/g, (_, j, k) => `N(${JSON.stringify(j)}).outputs[${JSON.stringify(k)}]`)
    .replace(/needs\.([\w-]+)\.result/g, (_, j) => `N(${JSON.stringify(j)}).result`)
    .replace(/github\.event_name/g, "EVENT")
    .replace(/ == /g, " === ")
    .replace(/ != /g, " !== ")
    .replace(/fromJSON\(/g, "JSON.parse(")
    .replace(/contains\(/g, "contains(");
  const N = (j) => {
    assert.ok(ctx.needs[j], `an if: uses needs.${j} that the job does not list in needs`);
    return ctx.needs[j];
  };
  const contains = (arr, v) => arr.includes(v);
  return Boolean(new Function("N", "EVENT", "contains", `return (${js});`)(N, ctx.event, contains));
};

// `fail` = names of jobs (or "node-tests:ui-c" legs) that fail when they run. Returns {result per job, legs of node-tests}.
const simulate = ({ event, plan, fail = [] }) => {
  const result = { plan: { result: "success", outputs: plan } };
  const legs = [];
  const order = ["plan", "create-release", "node-tests", "rust-tests", "build", "sign-windows", "publish"];
  for (const name of order.slice(1)) {
    const job = jobs[name];
    const needs = {};
    for (const n of job.needs) needs[n] = result[n] ?? assert.fail(`${name} needs ${n}, which is later in the order`);
    const ctx = { needs, event };
    const allOk = job.needs.every((n) => needs[n].result === "success");
    const run = hasStatusFn(job.cond) ? evalCond(job.cond, ctx) : allOk && (job.cond === null || evalCond(job.cond, ctx));
    if (!run) {
      result[name] = { result: "skipped", outputs: {} };
      continue;
    }
    if (name === "node-tests") {
      const shards = JSON.parse(plan.shards);
      const r = shards.map((s) => {
        legs.push(s);
        return fail.includes(`node-tests:${s}`) ? "failure" : "success";
      });
      result[name] = { result: r.includes("failure") ? "failure" : "success", outputs: {} };
    } else {
      result[name] = { result: fail.includes(name) ? "failure" : "success", outputs: {} };
    }
  }
  return { result: Object.fromEntries(Object.entries(result).map(([k, v]) => [k, v.result])), legs };
};

const UI = ["ui-a", "ui-b", "ui-c", "ui-d", "ui-e"];
const run = (opts) => simulate({ ...opts, plan: runPlan(opts) });
let n = 0;
const check = (label, fn) => {
  fn();
  n++;
};

// the shard names of the workflow and of the list are the same
check("shard names match the list", () => {
  const words = new Set(
    readFileSync(path.join(root, ".github/node-tests.txt"), "utf8")
      .split("\n")
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.slice(0, l.indexOf(" | "))),
  );
  assert.deepEqual([...words].sort(), ["static", ...UI]);
  assert.match(planScript, /ui_shards='ui-a ui-b ui-c ui-d ui-e'/);
});

// (a) a tag push with everything green publishes; all six shards ran
for (const signpathVars of [false, true]) {
  check(`(a) tag, all green, signpath vars ${signpathVars}`, () => {
    const r = run({ event: "push", signpathVars });
    assert.deepEqual(r.legs, ["static", ...UI]);
    assert.equal(r.result["node-tests"], "success");
    assert.equal(r.result.publish, "success");
    assert.equal(r.result["sign-windows"], signpathVars ? "success" : "skipped");
  });
}

// (b) a tag push with a failing shard (any of them, the static one too) or another failing job does not publish and does not sign
for (const shard of ["static", ...UI]) {
  for (const signpathVars of [false, true]) {
    check(`(b) tag, ${shard} fails`, () => {
      const r = run({ event: "push", fail: [`node-tests:${shard}`], signpathVars });
      assert.equal(r.result["node-tests"], "failure");
      assert.equal(r.result.publish, "skipped");
      assert.equal(r.result["sign-windows"], "skipped");
      assert.ok(r.legs.includes(shard));
    });
  }
}
for (const job of ["rust-tests", "build", "create-release"]) {
  check(`(b) tag, ${job} fails`, () => {
    assert.equal(run({ event: "push", fail: [job] }).result.publish, "skipped");
  });
}
check("(b) tag, sign-windows fails", () => {
  assert.equal(run({ event: "push", fail: ["sign-windows"], signpathVars: true }).result.publish, "skipped");
});
// a tag push whose plan lost the UI shards (a bad edit) still must not publish
check("(b) tag, plan says no UI tests", () => {
  const plan = { ...runPlan({ event: "push" }), ui_tests: "false", shards: '["static"]' };
  assert.equal(simulate({ event: "push", plan }).result.publish, "skipped");
});
// a tag push ignores the dry-run input
check("(b) tag run ignores ui_tests=false", () => {
  assert.deepEqual(run({ event: "push", uiTests: "false" }).legs, ["static", ...UI]);
});

// (c) a dry run without ui_tests: plan, static, Rust tests and the three builds; nothing else, nothing red, no publish
for (const uiTests of ["", "false"]) {
  check(`(c) dispatch, ui_tests="${uiTests}"`, () => {
    const r = run({ event: "workflow_dispatch", platforms: "all", uiTests });
    assert.deepEqual(r.legs, ["static"]);
    assert.deepEqual(r.result, {
      plan: "success",
      "create-release": "skipped",
      "node-tests": "success",
      "rust-tests": "success",
      build: "success",
      "sign-windows": "skipped",
      publish: "skipped",
    });
  });
}
check("(c) dispatch without UI tests: a failing static still shows red", () => {
  assert.equal(run({ event: "workflow_dispatch", platforms: "all", fail: ["node-tests:static"] }).result["node-tests"], "failure");
});
check("(c) dispatch, test build, no ui_tests", () => {
  const r = run({ event: "workflow_dispatch", platforms: "linux", testVersion: "0.9.0" });
  assert.deepEqual(r.legs, ["static"]);
  assert.equal(r.result.build, "success");
});
check("(c) dispatch for windows only: no node tests at all, as before", () => {
  const r = run({ event: "workflow_dispatch", platforms: "windows" });
  assert.deepEqual(r.legs, []);
  assert.equal(r.result["node-tests"], "skipped");
  assert.equal(r.result.build, "success");
});

// (d) a dry run with ui_tests=true is what a dry run was: static and all UI shards, never a publish
check("(d) dispatch, ui_tests=true", () => {
  const r = run({ event: "workflow_dispatch", platforms: "all", uiTests: "true" });
  assert.deepEqual(r.legs, ["static", ...UI]);
  assert.equal(r.result["node-tests"], "success");
  assert.equal(r.result.publish, "skipped");
  const bad = run({ event: "workflow_dispatch", platforms: "all", uiTests: "true", fail: ["node-tests:ui-d"] });
  assert.equal(bad.result["node-tests"], "failure");
  assert.equal(bad.result.publish, "skipped");
});
check("(d) dispatch asking for SignPath: signing follows the tests, with and without the UI shards", () => {
  const base = { event: "workflow_dispatch", platforms: "all", signDry: "true", signpathVars: true };
  assert.equal(run({ ...base }).result["sign-windows"], "success");
  assert.equal(run({ ...base, uiTests: "true" }).result["sign-windows"], "success");
  assert.equal(run({ ...base, fail: ["node-tests:static"] }).result["sign-windows"], "skipped");
  assert.equal(run({ ...base, uiTests: "true", fail: ["node-tests:ui-a"] }).result["sign-windows"], "skipped");
});

rmSync(dir, { recursive: true, force: true });
console.log(`test-release-gates: ok (${n} cases)`);
