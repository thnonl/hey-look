// WP11 (W11.3, W11.8, W11.9, W11.11, W11.12): rules for the three workflows, read as text (no YAML parser, no network). Run: node scripts/test-release-workflow.mjs
//
//  (a) every `uses:` is pinned to a 40-hex commit SHA with a comment (`# v4.4.0`, or `# stable branch` for the Rust toolchain action), in release.yml, pages.yml
//      and linux-stores.yml;
//  (b) a production secret (anything but GITHUB_TOKEN) is read only behind `github.event_name == 'push'`: inline in the same expression, or in a step or a job
//      whose `if:` says so, or in a job of the Environment `store` (a reviewer approves every run; off unless a repository variable turns it on). A dry run
//      and a rehearsal therefore never see one;
//  (c) `environment:` is `release` only with the push expression (or in a job that runs on push only), or `store`, or `github-pages` (pages.yml);
//  (d) no `runs-on` uses a `-latest` label (the image must not change between the last dry run and the tag run);
//  (e) the `needs` of `sign-windows` and `publish` include node-tests, rust-tests and rust-tests-windows (and `audit` once that job exists);
//  (f) every shard of .github/node-tests.txt is a shard the plan job names (`static` and the `ui_shards` line), and every one of them has a command;
//  (g) the signing rehearsal (W11.3): the input exists, a tag run and a test build ignore it, the throw-away keys are masked and removed, the SHA-1 pin
//      (MAC_CERT_SHA1) is given to the signature check on tag runs only, and no rehearsal step reads a `secrets.` value.
// Each rule is also tried on a copy with one deliberate break and must fail there (the "mutations" below).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const WORKFLOWS = ['.github/workflows/release.yml', '.github/workflows/pages.yml', '.github/workflows/linux-stores.yml'];
const PUSH = "github.event_name == 'push'";

// jobs of a workflow: { name, text }
export function jobsOf(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start < 0) return [];
  const jobs = [];
  let cur = null;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^  ([A-Za-z0-9_-]+):\s*$/.exec(lines[i]);
    if (m) { cur = { name: m[1], lines: [] }; jobs.push(cur); continue; }
    if (cur) cur.lines.push(lines[i]);
  }
  return jobs.map((j) => ({ name: j.name, text: j.lines.join('\n') }));
}
// the step (text from "      - " to the next one) that holds line `at` of a job text
function stepAround(jobText, at) {
  const lines = jobText.split('\n');
  let s = at;
  while (s > 0 && !/^      - /.test(lines[s])) s--;
  let e = at + 1;
  while (e < lines.length && !/^      - /.test(lines[e])) e++;
  return lines.slice(s, e).join('\n');
}
const ifOf = (block) => (/^\s*(?:- )?if: (.*)$/m.exec(block.replace(/^      - /, '        ')) || [])[1] || '';
const jobIf = (jobText) => (/^    if: (.*)$/m.exec(jobText) || [])[1] || '';
const jobEnv = (jobText) => (/^    environment:[ \t]*(.*)$/m.exec(jobText) || [])[1];

export function check({ release, pages, stores, nodeTests }) {
  const errors = [];
  const fail = (m) => errors.push(m);
  const files = { 'release.yml': release, 'pages.yml': pages, 'linux-stores.yml': stores };

  // (a)
  for (const [f, t] of Object.entries(files)) {
    t.split('\n').forEach((line, i) => {
      const m = /^\s*(?:- )?uses:\s*(\S+)(.*)$/.exec(line);
      if (!m) return;
      if (m[1].startsWith('./')) return;
      if (!/@[0-9a-f]{40}$/.test(m[1])) fail(`(a) ${f}:${i + 1}: ${m[1]} is not pinned to a 40-hex SHA`);
      else if (!/^\s*#\s*(v\d|stable branch)/.test(m[2])) fail(`(a) ${f}:${i + 1}: ${m[1]} has no "# vX" comment`);
    });
  }

  // (b)
  for (const [f, t] of Object.entries(files)) {
    for (const job of jobsOf(t)) {
      const lines = job.text.split('\n');
      lines.forEach((line, i) => {
        if (/^\s*#/.test(line)) return;
        for (const m of line.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) {
          if (m[1] === 'GITHUB_TOKEN') continue;
          const before = line.slice(0, m.index);
          const inline = before.includes(PUSH);
          const step = ifOf(stepAround(job.text, i));
          const stepGated = step.includes(PUSH) || step.includes("github.ref_type == 'tag'");
          const jobGated = jobIf(job.text).includes(PUSH);
          const store = (jobEnv(job.text) || '').trim() === 'store';
          if (!(inline || stepGated || jobGated || store)) fail(`(b) ${f} job ${job.name}: secrets.${m[1]} is read without the push gate (line ${i + 1} of the job)`);
        }
      });
    }
  }

  // (c)
  for (const [f, t] of Object.entries(files)) {
    for (const job of jobsOf(t)) {
      const env = jobEnv(job.text);
      if (env === undefined) continue;
      const v = env.trim();
      const pushExpr = `\${{ ${PUSH} && 'release' || '' }}`;
      if (v === pushExpr || v === 'store' || v === 'github-pages') continue;
      if (v === 'release' && jobIf(job.text).includes(PUSH)) continue;
      if (v === "${{ github.event_name == 'push' && github.ref_type == 'tag' && 'release' || '' }}") continue;
      // a mapping form (name:/url:) on the next lines is the pages.yml deploy
      if (v === '' && /^\s+name: github-pages\s*$/m.test(job.text)) continue;
      fail(`(c) ${f} job ${job.name}: environment "${v}" is not the push expression, store or github-pages`);
    }
  }

  // (d)
  for (const [f, t] of Object.entries(files)) {
    t.split('\n').forEach((line, i) => { if (/^\s*runs-on:.*latest/.test(line)) fail(`(d) ${f}:${i + 1}: a -latest runner label: ${line.trim()}`); });
  }
  if (/"platform":"[a-z0-9.-]*latest"/.test(release)) fail('(d) release.yml: the plan job writes a -latest platform into the build matrix');

  // (e)
  const jobs = Object.fromEntries(jobsOf(release).map((j) => [j.name, j.text]));
  const needsOf = (name) => {
    const m = /^    needs:\s*\[([^\]]*)\]/m.exec(jobs[name] || '');
    return m ? m[1].split(',').map((s) => s.trim()) : [];
  };
  const want = ['node-tests', 'rust-tests', 'rust-tests-windows', ...(jobs.audit ? ['audit'] : [])];
  for (const j of ['sign-windows', 'publish']) {
    for (const n of want) if (!needsOf(j).includes(n)) fail(`(e) release.yml: job ${j} does not list ${n} in needs`);
  }
  if (!jobs['rust-tests-windows']) fail('(e) release.yml: no job rust-tests-windows');
  else if (!/runs-on: windows-/.test(jobs['rust-tests-windows'])) fail('(e) release.yml: rust-tests-windows does not run on Windows');
  // the result of the new job counts like the other Rust job in the two conditions
  for (const j of ['sign-windows', 'publish']) if (!jobIf(jobs[j] || '').includes('needs.rust-tests-windows.result')) fail(`(e) release.yml: the if of ${j} does not look at rust-tests-windows`);

  // (f)
  const ui = /^\s*ui_shards='([^']*)'\s*$/m.exec(release);
  if (!ui) fail("(f) release.yml: no ui_shards='...' line in the plan job");
  const shards = new Set(['static', ...((ui && ui[1].split(/\s+/).filter(Boolean)) || [])]);
  const used = new Map();
  for (const raw of nodeTests.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf(' | ');
    if (at < 0) { fail(`(f) node-tests.txt: no " | " in: ${line.slice(0, 60)}`); continue; }
    const s = line.slice(0, at);
    used.set(s, (used.get(s) || 0) + 1);
    if (!shards.has(s)) fail(`(f) node-tests.txt: the shard "${s}" is not run by the workflow`);
  }
  for (const s of shards) if (!used.get(s)) fail(`(f) the shard "${s}" of the workflow has no command in node-tests.txt`);

  // (g)
  if (!/^      rehearse_signing:\s*$/m.test(release)) fail('(g) release.yml: no input rehearse_signing');
  if (!/if \[ "\$EVENT" = "push" \]; then echo "::notice::rehearse_signing is ignored on a tag run"/.test(release)) fail('(g) release.yml: a tag run does not ignore rehearse_signing');
  if (!/elif \[ -n "\$TEST_VERSION" \]; then echo "::notice::rehearse_signing is ignored for a test build"/.test(release)) fail('(g) release.yml: a test build does not ignore rehearse_signing');
  const build = jobs.build || '';
  for (const step of build.split(/^      - /m).map((x) => x.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')).filter((s) => /Rehearsal/.test(s.split('\n')[0] + (/name: (.*)/.exec(s) || [])[0]))) {
    if (/secrets\./.test(step)) fail('(g) release.yml: a rehearsal step reads a secret');
    if (!/needs\.plan\.outputs\.rehearse == 'true'/.test(step)) fail('(g) release.yml: a rehearsal step runs without needs.plan.outputs.rehearse == true');
  }
  if (!/::add-mask::\$key/.test(build) || !/::add-mask::\$cert/.test(build) || !/::add-mask::\$pw/.test(build)) fail('(g) release.yml: the throw-away key, certificate or password is not masked');
  if (!/rm -f "\$RUNNER_TEMP"\/rehearse-\*/.test(build)) fail('(g) release.yml: no step removes the throw-away key material');
  if (!/EXPECT_SHA1: \$\{\{ github\.event_name == 'push' && env\.MAC_CERT_SHA1 \|\| '' \}\}/.test(build)) fail('(g) release.yml: MAC_CERT_SHA1 is not given to the signature check on tag runs only');
  if (!/^  MAC_CERT_SHA1: "[0-9a-f]{40}"$/m.test(release)) fail('(g) release.yml: MAC_CERT_SHA1 is not a 40-hex fingerprint');
  if (!/\*\*REHEARSAL: signed with throw-away keys\. Do not install these files\.\*\*/.test(build)) fail('(g) release.yml: the build summary of a rehearsal has no REHEARSAL line');
  const verify = read('.github/scripts/mac-verify-selfsigned.sh');
  if (!/the signing certificate changed \(SHA-1 \$leaf_sha1, expected \$expected_sha1\)/.test(verify)) fail('(g) mac-verify-selfsigned.sh: no SHA-1 pin with its error line');
  return errors;
}

const load = () => ({
  release: read('.github/workflows/release.yml'),
  pages: read('.github/workflows/pages.yml'),
  stores: read('.github/workflows/linux-stores.yml'),
  nodeTests: read('.github/node-tests.txt'),
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = load();
  const errors = check(base);
  assert.deepEqual(errors, [], errors.join('\n'));

  // mutations: one deliberate break each; every rule must notice
  const mut = (what, rule, fn) => {
    const copy = fn({ ...base });
    const found = check(copy).filter((e) => e.startsWith(`(${rule})`));
    assert.ok(found.length > 0, `mutation "${what}" was not caught by rule (${rule})`);
    return what;
  };
  const done = [
    mut('an unpinned action', 'a', (c) => ({ ...c, release: c.release.replace(/(uses: actions\/checkout)@[0-9a-f]{40}/, '$1@v4') })),
    mut('an action without a version comment', 'a', (c) => ({ ...c, pages: c.pages.replace(/(uses: [^\n]*@[0-9a-f]{40}) # [^\n]*/, '$1') })),
    mut('a secret without the push gate', 'b', (c) => ({ ...c, release: c.release.replace("github.event_name == 'push' && secrets.APPLE_CERTIFICATE ||", 'secrets.APPLE_CERTIFICATE ||') })),
    mut('an environment without the push expression', 'c', (c) => ({ ...c, release: c.release.replace("environment: ${{ github.event_name == 'push' && 'release' || '' }}", 'environment: release') })),
    mut('a -latest runner', 'd', (c) => ({ ...c, release: c.release.replace('runs-on: windows-2025-vs2026', 'runs-on: windows-latest') })),
    mut('a -latest platform in the matrix', 'd', (c) => ({ ...c, release: c.release.replace('"platform":"macos-26"', '"platform":"macos-latest"') })),
    mut('publish without rust-tests-windows', 'e', (c) => ({ ...c, release: c.release.replace('store-exe, node-tests, rust-tests, rust-tests-windows]', 'store-exe, node-tests, rust-tests]') })),
    mut('a shard with a typo in node-tests.txt', 'f', (c) => ({ ...c, nodeTests: c.nodeTests + 'ui-z | node scripts/x.mjs\n' })),
    mut('a workflow shard without a command', 'f', (c) => ({ ...c, nodeTests: c.nodeTests.replace(/^ui-e \|.*$/gm, '') })),
    mut('a rehearsal that is not ignored on tag runs', 'g', (c) => ({ ...c, release: c.release.replace('rehearse_signing is ignored on a tag run', 'x') })),
    mut('an unmasked throw-away key', 'g', (c) => ({ ...c, release: c.release.replace('echo "::add-mask::$key"', '') })),
    mut('the SHA-1 pin on dry runs too', 'g', (c) => ({ ...c, release: c.release.replace("github.event_name == 'push' && env.MAC_CERT_SHA1 || ''", 'env.MAC_CERT_SHA1') })),
  ];
  console.log(`ok - test-release-workflow (rules a-g on 3 workflows, ${done.length} mutations caught)`);
}
