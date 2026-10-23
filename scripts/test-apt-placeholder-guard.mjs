// Source guard for the throw-away APT key gate (DEC-020, DEC-001). Run: node scripts/test-apt-placeholder-guard.mjs
// Until the owner's real signing key is committed, docs/apt holds a throw-away key and scripts/test-site-apt.mjs fails on it. Exactly one place may turn
// that one check into a warning: the node-tests job of release.yml, and only on runs that are not a tag push. This test keeps it that way:
//   - pages.yml does not contain APT_ALLOW_PLACEHOLDER_KEY at all (a Pages deploy is always strict, the site never goes live with the throw-away key)
//   - .github/node-tests.txt does not contain it (no command line carries it inline)
//   - release.yml contains it exactly once, as the env of the job node-tests, with exactly the agreed expression ('0' on a tag push, '1' otherwise)
//   - no other file of .github/ (workflows, scripts, actions) sets it, and no repository variable or secret of that name is read
//   - scripts/test-site-apt.mjs honours only the exact value "1"
//   - the run of test-site-apt.mjs ends the same with "0", "true", "yes" and an empty value as without the variable (none of them downgrades the check)
// DEC-022 (the site is dormant until the branch `apt` exists) adds the same kind of lock for the second variable, APT_SITE:
//   - in pages.yml every non-comment line that names APT_SITE is exactly `APT_SITE: ${{ steps.aptbranch.outputs.present == 'true' && 'on' || 'off' }}`
//     (at least three: the checks, the build, the check of the built site), and pages.yml has no `inputs:`, no `inputs.`, no `vars.`, no `secrets.`
//   - no other file of .github/ (release.yml, the scripts, node-tests.txt) names APT_SITE outside a comment
//   - scripts/build-site.mjs turns the block on only with `process.env.APT_SITE === 'on'`; test-site-apt.mjs knows only "on" and "off"
//   - with APT_SITE=on the throw-away key fails also when APT_ALLOW_PLACEHOLDER_KEY=1 is set (a run, while the key is the throw-away one)
// The check is a function of the file texts, so it is proven on scratch copies too (a pages.yml with the variable must fail it).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "APT_ALLOW_PLACEHOLDER_KEY";
const EXPR = "${{ (github.event_name == 'push' && github.ref_type == 'tag') && '0' || '1' }}";

/** The problems of a set of file texts { pages, nodeTests, release, siteApt, others: {path: text} }. */
export function problems({ pages, nodeTests, release, siteApt, siteBuild = "", others = {} }) {
  const out = [];
  // ---- APT_SITE (DEC-022)
  const code = (text) => text.split("\n").filter((l) => !/^\s*#/.test(l));
  const siteLines = code(pages).filter((l) => /APT_SITE\s*[:=]/.test(l)); // (assignments; a step that only READS "$APT_SITE" is fine)
  const SITE_LINE = /^\s+APT_SITE: \$\{\{ steps\.aptbranch\.outputs\.present == 'true' && 'on' \|\| 'off' \}\}\s*$/;
  for (const l of siteLines) if (!SITE_LINE.test(l)) out.push(`pages.yml sets APT_SITE as '${l.trim()}': only from the branch check (steps.aptbranch.outputs.present == 'true' && 'on' || 'off')`);
  if (siteLines.length < 3) out.push(`pages.yml names APT_SITE ${siteLines.length} times, expected the checks, the build and the check of the built site (3)`);
  for (const bad of [/^\s*inputs:/m, /\binputs\./, /\bvars\./, /\bsecrets\./, /github\.event\.inputs/]) if (bad.test(code(pages).join("\n"))) out.push(`pages.yml uses ${bad}: nothing but the branch check may decide whether the site carries the APT repository`);
  if (code(release).some((l) => l.includes("APT_SITE")) || code(nodeTests).some((l) => l.includes("APT_SITE"))) out.push("release.yml or node-tests.txt names APT_SITE");
  for (const [file, text] of Object.entries(others)) if (code(text).some((l) => l.includes("APT_SITE"))) out.push(`${file} names APT_SITE`);
  if (siteBuild && !/const APT_ON = process\.env\.APT_SITE === 'on';/.test(siteBuild)) out.push("build-site.mjs does not switch the block on with exactly process.env.APT_SITE === 'on'");
  if (siteBuild && (siteBuild.match(/APT_ON\s*=/g) ?? []).length !== 1) out.push("build-site.mjs assigns APT_ON more than once");
  if (pages.includes(NAME)) out.push(`pages.yml contains ${NAME}: a Pages deploy must always be strict`);
  if (nodeTests.includes(NAME)) out.push(`.github/node-tests.txt contains ${NAME}: no command may carry it`);
  for (const [file, text] of Object.entries(others)) if (text.includes(NAME)) out.push(`${file} contains ${NAME}`);
  const lines = release.split("\n");
  const at = lines.map((l, i) => (l.includes(NAME) ? i : -1)).filter((i) => i >= 0);
  if (at.length !== 1) out.push(`release.yml contains ${NAME} ${at.length} times, expected exactly once`);
  else {
    const line = lines[at[0]];
    if (line.trim() !== `${NAME}: ${EXPR}`) out.push(`release.yml sets it as '${line.trim()}', expected '${NAME}: ${EXPR}'`);
    // which job and which key: the nearest job header above, and an `env:` line directly above the variable
    let job = null;
    for (let i = at[0]; i >= 0; i--) { const m = /^  ([\w-]+):\s*$/.exec(lines[i]); if (m) { job = m[1]; break; } }
    if (job !== "node-tests") out.push(`release.yml sets it in the job '${job}', expected node-tests`);
    let k = at[0] - 1;
    while (k >= 0 && /^\s*#/.test(lines[k])) k--;
    if (!/^    env:\s*$/.test(lines[k] ?? "")) out.push("release.yml: the variable is not directly under the job-level 'env:' of node-tests (a step-level or a repository-wide setting is not allowed)");
  }
  if (!/process\.env\.APT_ALLOW_PLACEHOLDER_KEY === "1"/.test(siteApt)) out.push('test-site-apt.mjs does not compare the variable with the exact value "1"');
  if (/process\.env\.APT_ALLOW_PLACEHOLDER_KEY\s*(!==|!=|==)[^=]/.test(siteApt) || /Boolean\(process\.env\.APT_ALLOW/.test(siteApt)) out.push("test-site-apt.mjs reads the variable loosely");
  return out;
}

const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
function listFiles(dir) {
  const res = [];
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) res.push(...listFiles(rel));
    else res.push(rel);
  }
  return res;
}

const real = {
  pages: read(".github/workflows/pages.yml"),
  nodeTests: read(".github/node-tests.txt"),
  release: read(".github/workflows/release.yml"),
  siteApt: read("scripts/test-site-apt.mjs"),
  siteBuild: read("scripts/build-site.mjs"),
  others: Object.fromEntries(
    listFiles(".github")
      .filter((f) => !/^\.github\/(workflows\/(pages|release)\.yml|node-tests\.txt)$/.test(f) && /\.(ya?ml|sh|cjs|mjs|json|md|txt)$/.test(f))
      .map((f) => [f, read(f)]),
  ),
};

const errors = [...problems(real)];

// proof that the guard bites: scratch copies with the variable put where it must not be
const mutations = [
  ["pages.yml with the variable", { ...real, pages: real.pages + `\n      env:\n        ${NAME}: "1"\n` }],
  ["node-tests.txt with an inline variable", { ...real, nodeTests: real.nodeTests.replace("node scripts/test-site-apt.mjs", `${NAME}=1 node scripts/test-site-apt.mjs`) + `${NAME}=1\n` }],
  ["release.yml with the variable always on", { ...real, release: real.release.replace(EXPR, "'1'") }],
  ["release.yml with the variable in a second job", { ...real, release: real.release + `\n    env:\n      ${NAME}: "1"\n` }],
  ["release.yml without the variable", { ...real, release: real.release.replace(new RegExp(`.*${NAME}.*\\n`), "") }],
  ["release.yml with the variable in a step", { ...real, release: real.release.replace("    env:\n      # DEC-020", "    # DEC-020").replace(`      ${NAME}:`, `        ${NAME}:`) }],
  ["pages.yml with APT_SITE always on", { ...real, pages: real.pages.replace("APT_SITE: ${{ steps.aptbranch.outputs.present == 'true' && 'on' || 'off' }}", "APT_SITE: on") }],
  ["pages.yml with APT_SITE from an input", { ...real, pages: real.pages.replace("APT_SITE: ${{ steps.aptbranch.outputs.present == 'true' && 'on' || 'off' }}", "APT_SITE: ${{ github.event.inputs.apt || 'off' }}") }],
  ["pages.yml with a workflow_dispatch input", { ...real, pages: real.pages.replace("  workflow_dispatch:\n", "  workflow_dispatch:\n    inputs:\n      apt:\n        default: off\n") }],
  ["pages.yml with APT_SITE from a repository variable", { ...real, pages: real.pages + "\n        APT_SITE: ${{ vars.APT_SITE }}\n" }],
  ["pages.yml without APT_SITE in the build", { ...real, pages: real.pages.replace(/(Build and optimize production site\n)\s+env:\n\s+APT_SITE: [^\n]*\n/, "$1") }],
  ["release.yml that sets APT_SITE", { ...real, release: real.release + "\n      APT_SITE: on\n" }],
  ["a script that sets APT_SITE", { ...real, others: { ...real.others, ".github/scripts/y.sh": "export APT_SITE=on\n" } }],
  ["build-site.mjs that switches on by default", { ...real, siteBuild: real.siteBuild.replace("process.env.APT_SITE === 'on'", "process.env.APT_SITE !== 'off'") }],
  ["a script that sets it", { ...real, others: { ...real.others, ".github/scripts/x.sh": `export ${NAME}=1\n` } }],
  ["test-site-apt.mjs that takes any value", { ...real, siteApt: real.siteApt.replace('process.env.APT_ALLOW_PLACEHOLDER_KEY === "1"', "process.env.APT_ALLOW_PLACEHOLDER_KEY") }],
];
for (const [name, files] of mutations) if (problems(files).length === 0) errors.push(`the guard did not notice: ${name}`);

// a value other than "1" does not downgrade: the run ends as without the variable
const run = (value) => {
  const env = { ...process.env };
  delete env[NAME];
  delete env.APT_SITE;
  if (value !== undefined) env[NAME] = value;
  const r = spawnSync(process.execPath, [path.join(root, "scripts/test-site-apt.mjs")], { env, encoding: "utf8" });
  return r.status;
};
const base = run(undefined);
for (const v of ["0", "true", "yes", "", " 1", "1 "]) if (run(v) !== base) errors.push(`test-site-apt.mjs ends differently with ${NAME}="${v}" (${run(v)}) than without (${base})`);
// with APT_SITE=on the variable is ignored: same end with and without it (and while the key is the throw-away one, that end is a failure)
const runOn = (allow) => {
  const env = { ...process.env, APT_SITE: "on" };
  delete env[NAME];
  if (allow !== undefined) env[NAME] = allow;
  return spawnSync(process.execPath, [path.join(root, "scripts/test-site-apt.mjs")], { env, encoding: "utf8" });
};
const onBase = runOn(undefined);
const onAllowed = runOn("1");
if (onAllowed.status !== onBase.status) errors.push(`APT_SITE=on: the run ends differently with ${NAME}=1 (${onAllowed.status}) than without (${onBase.status}): it must be ignored in this mode`);
if (base !== 0 && onBase.status === 0) errors.push("APT_SITE=on passes although the run without it fails (the throw-away key must fail hard in this mode)");

if (errors.length) {
  console.error(`test-apt-placeholder-guard: ${errors.length} problem(s)`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(`ok - test-apt-placeholder-guard (pages.yml, node-tests.txt and ${Object.keys(real.others).length} other .github files do not set ${NAME}; release.yml sets it once, in node-tests, '0' on a tag push; ${mutations.length} mutations noticed; 6 other values behave like no variable)`);
