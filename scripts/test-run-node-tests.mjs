// .github/scripts/run-node-tests.sh: the per-command time limit. A hung command is killed with everything it started and reported as
// "TIMEOUT: <command>" (a failure), the other commands of the shard still run, and the summary lines keep their format.
// Run: node scripts/test-run-node-tests.mjs   (needs bash; skipped when there is none)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// on Windows the `bash` of the PATH can be the WSL launcher: Git's bash is the one the repo's scripts are written for
const gitBash = "C:\Program Files\Git\bin\bash.exe";
const bash = process.platform === "win32" && existsSync(gitBash) ? gitBash : "bash";
if (spawnSync(bash, ["-c", "exit 0"]).status !== 0) {
  console.log("test-run-node-tests: SKIPPED, no bash");
  process.exit(0);
}

const dir = mkdtempSync(path.join(tmpdir(), "hl-run-node-tests-"));
const posix = (p) => p.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, d) => (process.platform === "win32" ? `/${d.toLowerCase()}` : `${d}:`));
const run = (lines, env = {}) => {
  const list = path.join(dir, "list.txt");
  writeFileSync(list, lines.join("\n") + "\n");
  const t0 = Date.now();
  const r = spawnSync(bash, [posix(path.join(root, ".github/scripts/run-node-tests.sh")), "t", posix(list)], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_TEST_KILL_GRACE: "1", ...env },
    timeout: 120000,
  });
  return { out: `${r.stdout}${r.stderr}`, code: r.status, seconds: (Date.now() - t0) / 1000 };
};
// a process of this test that is still alive (the marker numbers are unique to it); undefined when the system cannot say
const alive = (marker) => {
  const r = spawnSync(bash, ["-c", `ps -ef 2>/dev/null | grep -F '${marker}' | grep -v grep`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
};

try {
  // a hung command, a hung command with children, a failing one and a passing one: all four run, three are failures, nothing is left running
  const a = run(["t | echo fine-one", "t | sleep 391.337", "t | bash -c 'sleep 392.337 & sleep 393.337 & wait'", "t | exit 3", "# a comment", "other | exit 9"], { NODE_TEST_TIMEOUT: "2" });
  assert.equal(a.code, 1, a.out);
  assert.match(a.out, /::error::TIMEOUT: sleep 391\.337 \(killed after \d+s, limit 2s\)/, a.out);
  assert.match(a.out, /::error::TIMEOUT: bash -c 'sleep 392\.337 & sleep 393\.337 & wait' \(killed after \d+s, limit 2s\)/, a.out);
  assert.match(a.out, /::error::FAILED \(exit 3, \d+s\): exit 3/, a.out);
  assert.match(a.out, /shard t: 4 commands in \d+s, 3 failed/, a.out);
  assert.match(a.out, /::error::3 failed in shard t/, a.out);
  assert.match(a.out, / {2}FAILED: TIMEOUT: sleep 391\.337/, a.out);
  assert.match(a.out, / {2}FAILED: exit 3/, a.out);
  assert.ok(!/FAILED: echo fine-one/.test(a.out), "the passing command is not a failure");
  assert.ok(a.seconds < 40, `the limit did not end the hung commands (${a.seconds}s)`);
  for (const m of ["391.337", "392.337", "393.337"]) assert.equal(alive(m), "", `a process of the killed command is still running: ${m}`);

  // a command inside its limit is untouched, and the shard's own default applies without the variable
  const b = run(["t | sleep 1", "t | echo done"], { NODE_TEST_TIMEOUT: "20" });
  assert.equal(b.code, 0, b.out);
  assert.match(b.out, /shard t: 2 commands in \d+s, 0 failed/, b.out);
  assert.ok(!/TIMEOUT/.test(b.out), b.out);

  // a bad value is refused up front
  const c = run(["t | echo x"], { NODE_TEST_TIMEOUT: "soon" });
  assert.equal(c.code, 1, c.out);
  assert.match(c.out, /whole seconds/, c.out);

  // the per-shard defaults are in the script (static 300 s, the others 900 s = 15 minutes), above the slowest legitimate test of the recorded runs (290 s)
  const sh = (await import("node:fs")).readFileSync(path.join(root, ".github/scripts/run-node-tests.sh"), "utf8");
  assert.match(sh, /static\) default_limit=300 ;; \*\) default_limit=900/);
  console.log("test-run-node-tests: ok");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
