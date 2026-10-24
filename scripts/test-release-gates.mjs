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
for (const n of ["plan", "create-release", "node-tests", "rust-tests", "rust-tests-windows", "audit", "build", "sign-windows", "store-exe", "publish", "apt-repo", "apt-repo-dryrun", "msix", "msix-check", "store-url", "store-submit", "store-submit-exe"]) assert.ok(jobs[n], `job ${n} not found`);

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
const runPlan = ({ event, platforms = "", testVersion = "", uiTests = "", signDry = "false", signpathVars = false, storeExe = "", storeSubmit = "", rehearse = "", aptPublish = "" }) => {
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
      APT_PUBLISH: aptPublish,
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
  const order = ["plan", "create-release", "node-tests", "rust-tests", "rust-tests-windows", "audit", "build", "sign-windows", "store-exe", "publish", "apt-repo", "apt-repo-dryrun", "msix", "msix-check", "store-url", "store-submit", "store-submit-exe"];
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
for (const job of ["rust-tests", "rust-tests-windows", "audit", "build", "create-release"]) {
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
      audit: "success",
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
check("(e) tag with APT_PUBLISH=true, all green: apt-repo runs after publish, the dry-run job does not", () => {
  const r = run({ event: "push", aptPublish: "true" });
  assert.equal(r.result["apt-repo"], "success");
  assert.equal(r.result["apt-repo-dryrun"], "skipped");
});
check("(e) tag with APT_PUBLISH=true, publish fails: no APT repository is made", () => {
  assert.equal(run({ event: "push", aptPublish: "true", fail: ["publish"] }).result["apt-repo"], "skipped");
  assert.equal(run({ event: "push", aptPublish: "true", fail: ["node-tests:ui-a"] }).result["apt-repo"], "skipped");
});
check("(e) tag with APT_PUBLISH=true, apt-repo fails: the release stays published", () => {
  const r = run({ event: "push", aptPublish: "true", fail: ["apt-repo"] });
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
    assert.equal(r.result["apt-repo"], "skipped", "APT is off by default (DEC-028)");
  }
  assert.equal(run({ event: "push", aptPublish: "true", fail: ["msix"] }).result["apt-repo"], "success");
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

// (g) DEC-028: v1.0.7 is released without the APT repository and without the Microsoft Store. A tag run with no repository variable set must go green end to end:
// every job that runs is green, publish is not held back by a skipped store job, nothing that waits for the owner (an Environment with reviewers, a key, Partner
// Center) and no step that fails on purpose (the throw-away APT key) is on that path.
const text = readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
const storesYml = readFileSync(path.join(root, ".github/workflows/linux-stores.yml"), "utf8");
const blockOf = (src, name) => {
  const head = `\n  ${name}:\n`;
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${name} not found`);
  const next = src.slice(at + head.length).search(/\n  [a-z][\w-]*:\n/);
  return src.slice(at, next < 0 ? undefined : at + head.length + next);
};
// the value the node-tests job gives APT_ALLOW_PLACEHOLDER_KEY, with the plan output of that run
const placeholderValue = (plan) => {
  const m = /^      APT_ALLOW_PLACEHOLDER_KEY: \$\{\{ (.*) \}\}$/m.exec(text);
  assert.ok(m, "the node-tests job does not set APT_ALLOW_PLACEHOLDER_KEY");
  assert.ok(/needs\.plan\.outputs\.apt_publish/.test(m[1]), "the value does not follow the plan output apt_publish");
  const js = m[1].replace(/needs\.plan\.outputs\.apt_publish/g, JSON.stringify(plan.apt_publish)).replace(/ == /g, " === ").replace(/ != /g, " !== ");
  return String(new Function(`return (${js});`)());
};
const siteAptWith = (value) => {
  const env = { ...process.env };
  delete env.APT_SITE;
  delete env.APT_ALLOW_PLACEHOLDER_KEY;
  if (value !== undefined) env.APT_ALLOW_PLACEHOLDER_KEY = value;
  return spawnSync(process.execPath, [path.join(root, "scripts/test-site-apt.mjs")], { env, encoding: "utf8" });
};
const bareSiteApt = siteAptWith(undefined); // (what the sources are like today: it fails while docs/apt holds the throw-away key)
check("(g) tag, no repository variable: every job that runs is green, publish runs, the store and APT jobs are skipped", () => {
  const plan = runPlan({ event: "push" });
  assert.equal(plan.apt_publish, "false");
  const r = run({ event: "push" });
  assert.equal(r.result.publish, "success");
  assert.equal(r.result.build, "success");
  assert.equal(r.result["sign-windows"], "skipped");
  for (const j of ["apt-repo", ...STORE_JOBS]) assert.equal(r.result[j], "skipped", j);
  // nothing is red, and what ran is exactly the jobs of the tag path
  const bad = Object.entries(r.result).filter(([, v]) => v !== "success" && v !== "skipped");
  assert.deepEqual(bad, [], "a job is not green");
  const ran = Object.entries(r.result).filter(([, v]) => v === "success").map(([k]) => k).sort();
  assert.deepEqual(ran, ["audit", "build", "create-release", "msix", "msix-check", "node-tests", "plan", "publish", "rust-tests", "rust-tests-windows"]);
});
check("(g) publish is not held back by the skipped store jobs, nor by a failing MSIX or APT dry-run check", () => {
  const needs = jobs.publish.needs;
  assert.ok(needs.includes("store-exe") && !needs.includes("store-url") && !needs.includes("store-submit") && !needs.includes("apt-repo"), `publish needs ${needs}`);
  assert.ok(!needs.some((n) => ["msix", "msix-check", "apt-repo-dryrun"].includes(n)), "publish needs a dry-run or package check");
  assert.match(jobs.publish.cond, /contains\(fromJSON\('\["success","skipped"\]'\), needs\.store-exe\.result\)/, "publish does not accept a skipped store-exe");
  for (const fail of [["msix"], ["msix-check"], ["msix", "msix-check"]]) assert.equal(run({ event: "push", fail }).result.publish, "success", fail.join());
  assert.equal(run({ event: "workflow_dispatch", platforms: "all", fail: ["apt-repo-dryrun", "msix", "msix-check"] }).result.publish, "skipped", "a dry run never publishes");
});
check("(g) APT_PUBLISH: only a tag push with exactly the value true turns the APT job on", () => {
  for (const value of ["", "false", "TRUE", "True", "1", "yes", "true ", " true", "on", "tru"]) {
    assert.equal(runPlan({ event: "push", aptPublish: value }).apt_publish, "false", `'${value}'`);
    assert.equal(run({ event: "push", aptPublish: value }).result["apt-repo"], "skipped", `'${value}'`);
  }
  assert.equal(runPlan({ event: "push", aptPublish: "true" }).apt_publish, "true");
  for (const platforms of ["all", "linux", "windows"]) {
    assert.equal(runPlan({ event: "workflow_dispatch", platforms, aptPublish: "true" }).apt_publish, "false", "a dry run never publishes");
    assert.equal(run({ event: "workflow_dispatch", platforms, aptPublish: "true" }).result["apt-repo"], "skipped");
  }
  // the Store variables and APT_PUBLISH are independent
  assert.equal(run({ event: "push", aptPublish: "true", storeSubmit: "true", outputs: { msix: { ready: "true" } } }).result["apt-repo"], "success");
  assert.equal(run({ event: "push", storeExe: "true" }).result["apt-repo"], "skipped");
});
check("(g) the placeholder-key check of the node tests: a tag run without APT passes with the throw-away key, a tag run with APT does not", () => {
  const off = runPlan({ event: "push" });
  const on = runPlan({ event: "push", aptPublish: "true" });
  assert.equal(placeholderValue(off), "1");
  assert.equal(placeholderValue(runPlan({ event: "workflow_dispatch", platforms: "all", aptPublish: "true" })), "1", "a dry run");
  assert.equal(placeholderValue(on), "0");
  // the real script, with the value the workflow would give
  const offRun = siteAptWith(placeholderValue(off));
  assert.equal(offRun.status, 0, `test-site-apt.mjs in a tag run without APT: ${(offRun.stderr || offRun.stdout).slice(0, 400)}`);
  const onRun = siteAptWith(placeholderValue(on));
  if (bareSiteApt.status !== 0) {
    assert.notEqual(onRun.status, 0, "a tag run that publishes the APT repository must fail on the throw-away key");
    assert.match(onRun.stderr, /throw-away/);
  } else assert.equal(onRun.status, 0, "(the real key is committed: both pass)");
});
check("(g) the secrets of the jobs that run in a tag run without variables are the ones the earlier tag runs used; no APT, Store or Snap secret", () => {
  const r = run({ event: "push" });
  const known = new Set(["GITHUB_TOKEN", "TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "APPLE_SIGNING_IDENTITY", "APPLE_API_ISSUER", "APPLE_API_KEY", "APPLE_API_PRIVATE_KEY", "APPLE_ID", "APPLE_PASSWORD"]);
  for (const [name, res] of Object.entries(r.result)) {
    if (res !== "success") continue;
    const code = blockOf(text, name).split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    for (const m of code.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) assert.ok(known.has(m[1]), `job ${name} (runs in a tag run without variables) reads secrets.${m[1]}`);
    // an Environment that needs a reviewer is only `store`; `release` has the tag rule only
    assert.ok(!/^    environment: store$/m.test(code), `job ${name} waits for the Environment store`);
  }
  // the jobs that read the APT, Store or Snap secrets are the ones that are skipped
  for (const j of ["apt-repo", "store-submit", "store-submit-exe"]) assert.equal(r.result[j], "skipped", j);
  // the snap of linux-stores.yml: built on a tag, uploaded only with SNAP_PUBLISH=true (the store login secret is read in that step only)
  const up = /      - name: Upload to the Snap Store \(candidate\)\n        if: (.*)\n/.exec(storesYml);
  assert.ok(up, "no upload step in linux-stores.yml");
  assert.ok(up[1].includes("vars.SNAP_PUBLISH == 'true'") && up[1].includes("github.event_name == 'push'"), up[1]);
  const code = storesYml.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.equal((code.match(/secrets\.SNAPCRAFT_STORE_CREDENTIALS/g) ?? []).length, 1);
  assert.equal((code.match(/vars\.SNAP_PUBLISH/g) ?? []).length, 1);
  const evalUp = (snap) => new Function("event", "refType", "snap", `return (${up[1].replace(/github\.event_name/g, "event").replace(/github\.ref_type/g, "refType").replace(/vars\.SNAP_PUBLISH/g, "snap").replace(/ == /g, " === ")});`)("push", "tag", snap);
  assert.equal(evalUp(""), false);
  assert.equal(evalUp(undefined), false);
  assert.equal(evalUp("TRUE"), false);
  assert.equal(evalUp("true"), true);
});
check("(g) the two variables are read nowhere else: APT_PUBLISH only in the plan job, SNAP_PUBLISH only in linux-stores.yml", () => {
  const lines = text.split("\n").filter((l) => !/^\s*#/.test(l));
  assert.equal(lines.filter((l) => /vars\.APT_PUBLISH/.test(l)).length, 1);
  assert.ok(blockOf(text, "plan").includes("vars.APT_PUBLISH"));
  assert.ok(!/SNAP_PUBLISH/.test(lines.join("\n")));
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
