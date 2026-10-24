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
for (const n of ["plan", "create-release", "node-tests", "rust-tests", "rust-tests-windows", "build", "sign-windows", "store-exe", "publish", "apt-repo", "apt-repo-dryrun", "msix", "msix-check", "store-url", "store-submit", "store-submit-exe"]) assert.ok(jobs[n], `job ${n} not found`);

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
const runPlan = ({ event, platforms = "", testVersion = "", uiTests = "", signDry = "false", signpathVars = false, storeExe = "", storeSubmit = "", rehearse = "" }) => {
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
      REHEARSE: rehearse,
      SIGN_DRY_RUN: signDry,
      SP_ORG: signpathVars ? "o" : "",
      SP_PROJECT: signpathVars ? "p" : "",
      SP_POLICY: signpathVars ? "s" : "",
      REQUIRE_WIN: "",
      STORE_EXE: storeExe,
      STORE_SUBMIT: storeSubmit,
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
    .replace(/github\.event\.inputs\.test_version/g, "TV")
    .replace(/ == /g, " === ")
    .replace(/ != /g, " !== ")
    .replace(/fromJSON\(/g, "JSON.parse(")
    .replace(/contains\(/g, "contains(");
  const N = (j) => {
    assert.ok(ctx.needs[j], `an if: uses needs.${j} that the job does not list in needs`);
    return ctx.needs[j];
  };
  const contains = (arr, v) => arr.includes(v);
  return Boolean(new Function("N", "EVENT", "TV", "contains", `return (${js});`)(N, ctx.event, ctx.testVersion ?? "", contains));
};

// `fail` = names of jobs (or "node-tests:ui-c" legs) that fail when they run. Returns {result per job, legs of node-tests}.
// `outputs` = the outputs a job reports when it runs, e.g. { msix: { ready: "true" } }
const simulate = ({ event, plan, fail = [], testVersion = "", outputs = {} }) => {
  const result = { plan: { result: "success", outputs: plan } };
  const legs = [];
  const order = ["plan", "create-release", "node-tests", "rust-tests", "rust-tests-windows", "build", "sign-windows", "store-exe", "publish", "apt-repo", "apt-repo-dryrun", "msix", "msix-check", "store-url", "store-submit", "store-submit-exe"];
  for (const name of order.slice(1)) {
    const job = jobs[name];
    const needs = {};
    for (const n of job.needs) needs[n] = result[n] ?? assert.fail(`${name} needs ${n}, which is later in the order`);
    const ctx = { needs, event, testVersion };
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
      result[name] = { result: fail.includes(name) ? "failure" : "success", outputs: outputs[name] ?? {} };
    }
  }
  return { result: Object.fromEntries(Object.entries(result).map(([k, v]) => [k, v.result])), legs };
};

const UI = ["ui-a", "ui-b", "ui-c", "ui-d", "ui-e", "ui-f"];
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
  assert.match(planScript, /ui_shards='ui-a ui-b ui-c ui-d ui-e ui-f'/);
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
for (const job of ["rust-tests", "rust-tests-windows", "build", "create-release"]) {
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
      "rust-tests-windows": "success",
      build: "success",
      "sign-windows": "skipped",
      "store-exe": "skipped",
      publish: "skipped",
      "apt-repo": "skipped",
      "apt-repo-dryrun": "success",
      msix: "success",
      "msix-check": "success",
      "store-url": "skipped",
      "store-submit": "skipped",
      "store-submit-exe": "skipped",
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

// (e) WP15, the APT repository: the tag job needs the published release and no secret is reachable from a dry run; the dry-run job has its own throw-away key
check("(e) tag, all green: apt-repo runs after publish, the dry-run job does not", () => {
  const r = run({ event: "push" });
  assert.equal(r.result["apt-repo"], "success");
  assert.equal(r.result["apt-repo-dryrun"], "skipped");
});
check("(e) tag, publish fails: no APT repository is made", () => {
  assert.equal(run({ event: "push", fail: ["publish"] }).result["apt-repo"], "skipped");
  assert.equal(run({ event: "push", fail: ["node-tests:ui-a"] }).result["apt-repo"], "skipped");
});
check("(e) tag, apt-repo fails: the release stays published", () => {
  const r = run({ event: "push", fail: ["apt-repo"] });
  assert.equal(r.result.publish, "success");
  assert.equal(r.result["apt-repo"], "failure");
});
check("(e) dry run: the dry-run job needs a green build, never the tag job", () => {
  assert.equal(run({ event: "workflow_dispatch", platforms: "all", fail: ["build"] }).result["apt-repo-dryrun"], "skipped");
  assert.equal(run({ event: "workflow_dispatch", platforms: "linux" }).result["apt-repo-dryrun"], "success");
  assert.equal(run({ event: "workflow_dispatch", platforms: "windows" }).result["apt-repo-dryrun"], "skipped");
  assert.equal(run({ event: "workflow_dispatch", platforms: "linux", testVersion: "0.9.0" }).result["apt-repo-dryrun"], "skipped");
  assert.equal(run({ event: "workflow_dispatch", platforms: "all", uiTests: "true" }).result["apt-repo"], "skipped");
});
check("(e) secrets: only the tag job and only in its signing step; no Environment on the dry-run job", () => {
  const text = readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
  const block = (name) => {
    const head = `\n  ${name}:\n`;
    const at = text.indexOf(head);
    assert.ok(at >= 0, `${name} not found`);
    const next = text.slice(at + head.length).search(/\n  [a-z][\w-]*:\n/);
    return text.slice(at, next < 0 ? undefined : at + head.length + next);
  };
  const dry = block("apt-repo-dryrun");
  assert.ok(!/secrets\.(?!GITHUB_TOKEN)/.test(dry), "the dry-run job reads a secret");
  assert.ok(!/^    environment:/m.test(dry), "the dry-run job has an Environment");
  assert.match(dry, /^    permissions:\n      contents: read\n/m);
  const tag = block("apt-repo");
  assert.match(tag, /^    environment: release$/m);
  const keyLines = tag.split("\n").filter((l) => /secrets\.APT_SIGNING_/.test(l));
  assert.equal(keyLines.length, 2, "the two APT secrets are named once each");
  for (const l of keyLines) assert.match(l, /github\.event_name == 'push' && github\.ref_type == 'tag' && secrets\.APT_SIGNING_\w+ \|\| ''/, "a secret is read on a tag push only");
  // both are in the env of the Sign step, which is the only step with them
  const sign = tag.slice(tag.indexOf("- name: Sign\n"), tag.indexOf("- name: Remove the key"));
  assert.equal(sign.split("\n").filter((l) => /secrets\.APT_SIGNING_/.test(l)).length, 2, "both secrets sit in the Sign step");
  assert.ok(!/^\s*set -\w*x/m.test(tag + dry), "no set -x near a key");
});

// (f) WP14, the Microsoft Store. The MSIX package (option A) is built beside everything else and never holds the GitHub release back; everything that
// publishes (store-submit, option B: store-exe, store-url, store-submit-exe) exists only with its repository variable, exactly `true` (DEC-005).
const STORE_JOBS = ["store-exe", "store-url", "store-submit", "store-submit-exe"];
check("(f) tag, no Store variables: the package is built and checked, nothing that publishes runs, the release is published", () => {
  const r = run({ event: "push" });
  assert.equal(r.result.msix, "success");
  assert.equal(r.result["msix-check"], "success");
  assert.equal(r.result.publish, "success");
  for (const j of STORE_JOBS) assert.equal(r.result[j], "skipped", j);
});
check("(f) a failing package or install check never stops the GitHub release", () => {
  for (const job of ["msix", "msix-check"]) {
    const r = run({ event: "push", fail: [job] });
    assert.equal(r.result[job], "failure");
    assert.equal(r.result.publish, "success", `publish after ${job} failed`);
    assert.equal(r.result["apt-repo"], "success");
  }
  assert.equal(run({ event: "push", fail: ["msix"] }).result["msix-check"], "skipped");
});
check("(f) the package is made when Windows is built and it is not a test build", () => {
  assert.equal(run({ event: "workflow_dispatch", platforms: "windows" }).result.msix, "success");
  assert.equal(run({ event: "workflow_dispatch", platforms: "windows" }).result["msix-check"], "success");
  assert.equal(run({ event: "workflow_dispatch", platforms: "linux" }).result.msix, "skipped");
  assert.equal(run({ event: "workflow_dispatch", platforms: "macos" }).result.msix, "skipped");
  assert.equal(run({ event: "workflow_dispatch", platforms: "windows", testVersion: "0.9.0" }).result.msix, "skipped");
  assert.equal(run({ event: "workflow_dispatch", platforms: "windows,linux" }).result.msix, "success");
  assert.equal(run({ event: "workflow_dispatch", platforms: "all", fail: ["build"] }).result.msix, "skipped", "a failed build leaves nothing to pack");
});
check("(f) the variables switch on exactly the value true (plan job)", () => {
  for (const value of ["", "false", "TRUE", "True", "1", "yes", "true ", " true", "on"]) {
    const p = runPlan({ event: "push", storeExe: value, storeSubmit: value });
    assert.equal(p.store_exe, "false", `STORE_EXE='${value}'`);
    assert.equal(p.store_submit, "false", `STORE_SUBMIT='${value}'`);
    const r = run({ event: "push", storeExe: value, storeSubmit: value });
    for (const j of STORE_JOBS) assert.equal(r.result[j], "skipped", `${j} with '${value}'`);
  }
  const on = runPlan({ event: "push", storeExe: "true", storeSubmit: "true" });
  assert.equal(on.store_exe, "true");
  assert.equal(on.store_submit, "true");
  assert.equal(on.msix, "true");
});
check("(f) STORE_SUBMIT: tag runs only, never in a dry run", () => {
  assert.equal(runPlan({ event: "workflow_dispatch", platforms: "all", storeSubmit: "true" }).store_submit, "false");
  const r = run({ event: "workflow_dispatch", platforms: "all", storeSubmit: "true", storeExe: "true", outputs: { msix: { ready: "true" } } });
  assert.equal(r.result["store-submit"], "skipped");
  assert.equal(r.result["store-submit-exe"], "skipped");
  assert.equal(r.result["store-url"], "skipped");
});
check("(f) store-submit: published release, a package that passed the install check, an app with its packaged mode", () => {
  const base = { event: "push", storeSubmit: "true", outputs: { msix: { ready: "true" } } };
  assert.equal(run(base).result["store-submit"], "success");
  assert.equal(run({ ...base, outputs: { msix: { ready: "false" } } }).result["store-submit"], "skipped", "app without packaged mode");
  assert.equal(run({ ...base, outputs: {} }).result["store-submit"], "skipped");
  for (const job of ["msix", "msix-check", "publish"]) assert.equal(run({ ...base, fail: [job] }).result["store-submit"], "skipped", `${job} failed`);
  assert.equal(run({ ...base, fail: ["node-tests:ui-b"] }).result["store-submit"], "skipped");
  // STORE_SUBMIT alone does not build option B
  assert.equal(run(base).result["store-exe"], "skipped");
  assert.equal(run(base).result["store-submit-exe"], "skipped");
});
check("(f) option B: the offline installer is made before publish and the address is checked after it", () => {
  const base = { event: "push", storeExe: "true" };
  const r = run(base);
  assert.equal(r.result["store-exe"], "success");
  assert.equal(r.result.publish, "success");
  assert.equal(r.result["store-url"], "success");
  assert.equal(r.result["store-submit-exe"], "skipped", "needs STORE_SUBMIT too");
  assert.equal(run({ ...base, storeSubmit: "true" }).result["store-submit-exe"], "success");
  // the installer must be on the draft before the asset list is checked: a failed build stops the release, and the address is never checked
  const bad = run({ ...base, fail: ["store-exe"] });
  assert.equal(bad.result.publish, "skipped");
  assert.equal(bad.result["store-url"], "skipped");
  assert.equal(bad.result["apt-repo"], "skipped");
  // a failed address check leaves the release published
  const late = run({ ...base, storeSubmit: "true", fail: ["store-url"] });
  assert.equal(late.result.publish, "success");
  assert.equal(late.result["store-submit-exe"], "skipped");
  assert.equal(run({ ...base, fail: ["publish"] }).result["store-url"], "skipped");
});
check("(f) option B in a dry run: the installer is built and kept, nothing is published or checked", () => {
  const r = run({ event: "workflow_dispatch", platforms: "windows", storeExe: "true" });
  assert.equal(r.result["store-exe"], "success");
  assert.equal(r.result.publish, "skipped");
  assert.equal(r.result["store-url"], "skipped");
  assert.equal(run({ event: "workflow_dispatch", platforms: "linux", storeExe: "true" }).result["store-exe"], "skipped");
  assert.equal(run({ event: "workflow_dispatch", platforms: "windows", testVersion: "0.9.0", storeExe: "true" }).result["store-exe"], "skipped");
});
check("(f) the jobs that publish name their Environment, the others have none and read no secret", () => {
  const text = readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
  const block = (name) => {
    const head = `\n  ${name}:\n`;
    const at = text.indexOf(head);
    assert.ok(at >= 0, `${name} not found`);
    const next = text.slice(at + head.length).search(/\n  [a-z][\w-]*:\n/);
    return text.slice(at, next < 0 ? undefined : at + head.length + next);
  };
  for (const name of ["msix", "msix-check", "store-url"]) {
    const b = block(name);
    assert.ok(!/^    environment:/m.test(b), `${name} has an Environment`);
    assert.ok(!/secrets\.(?!GITHUB_TOKEN)/.test(b), `${name} reads a secret`);
  }
  for (const name of ["store-submit", "store-submit-exe"]) assert.match(block(name), /^    environment: store$/m, `${name} has no Environment store`);
  assert.match(block("store-exe"), /^    environment: \$\{\{ github\.event_name == 'push' && 'release' \|\| '' \}\}$/m, "store-exe reads the embedded client ids like the build job");
  // the Entra secrets sit only in the two steps that configure the CLI, one reference each per job
  for (const name of ["store-submit", "store-submit-exe"]) {
    const b = block(name);
    for (const s of ["AZURE_AD_TENANT_ID", "AZURE_AD_APPLICATION_CLIENT_ID", "AZURE_AD_APPLICATION_SECRET", "SELLER_ID"]) assert.equal(b.split(`secrets.${s}`).length - 1, 1, `${name}: secrets.${s} once`);
  }
});

// (f) WP11: the signing rehearsal and the Windows Rust tests
check("(f) rehearse_signing=true on a manual run: rehearsal on; a tag run and a test build ignore it", () => {
  assert.equal(runPlan({ event: "workflow_dispatch", platforms: "all", rehearse: "true" }).rehearse, "true");
  assert.equal(runPlan({ event: "workflow_dispatch", platforms: "all", rehearse: "false" }).rehearse, "false");
  assert.equal(runPlan({ event: "workflow_dispatch", platforms: "all" }).rehearse, "false");
  assert.equal(runPlan({ event: "push", rehearse: "true" }).rehearse, "false");
  assert.equal(runPlan({ event: "workflow_dispatch", platforms: "all", testVersion: "0.9.0", rehearse: "true" }).rehearse, "false");
});
check("(f) a rehearsal run builds, never publishes, and creates no release", () => {
  const r = run({ event: "workflow_dispatch", platforms: "all", rehearse: "true" });
  assert.equal(r.result.build, "success");
  assert.equal(r.result["create-release"], "skipped");
  assert.equal(r.result.publish, "skipped");
});
check("(f) the Windows Rust tests run when Windows is built, and a failure there blocks the tag run", () => {
  assert.equal(runPlan({ event: "workflow_dispatch", platforms: "windows" }).wintests, "true");
  assert.equal(runPlan({ event: "workflow_dispatch", platforms: "linux" }).wintests, "false");
  assert.equal(runPlan({ event: "push" }).wintests, "true");
  assert.equal(run({ event: "workflow_dispatch", platforms: "windows" }).result["rust-tests-windows"], "success");
  assert.equal(run({ event: "workflow_dispatch", platforms: "linux" }).result["rust-tests-windows"], "skipped");
  const bad = run({ event: "push", fail: ["rust-tests-windows"], signpathVars: true });
  assert.equal(bad.result.publish, "skipped");
  assert.equal(bad.result["sign-windows"], "skipped");
});

rmSync(dir, { recursive: true, force: true });
console.log(`test-release-gates: ok (${n} cases)`);
