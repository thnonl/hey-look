// WP14 option B (the signed offline EXE installer for the Microsoft Store), OFF unless the repository variable STORE_EXE is `true` (DEC-005). Run:
//   node scripts/test-store-exe.mjs      (the scripts need bash, jq, curl and sha256sum; without them that part is SKIPPED and said so)
//   - the second Tauri configuration (src-tauri/tauri.store-exe.conf.json): offline WebView2 installer, no update artifacts; the normal configuration is untouched
//   - the release asset list: the offline installer is allowed exactly once and only with the flag; latest.json is the same with and without it
//   - .github/scripts/store-exe-assemble.sh against a fake `gh` and `curl`: the newest 3 PUBLISHED releases, every file checked against the digest and size
//     GitHub states, and every kind of mismatch (no digest, wrong bytes, wrong size, a url outside the release, a name of another version) stops it
//   - .github/scripts/store-url-check.sh against a local server: 200, no redirect, no Content-Encoding, the size, the sha256, robots.txt, waiting for a late deploy
//   - scripts/build-site.mjs: robots.txt gets `Disallow: /downloads/` only with STORE_EXE=on; docs/robots.txt itself never changes
//   - the workflow text: the jobs, their conditions, the asset name, that nothing is attached without the variable, pages.yml reads the variable in one form
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
let n = 0;
const check = (label, fn) => {
  try {
    fn();
  } catch (e) {
    e.message = `${label}: ${e.message}`;
    throw e;
  }
  n++;
};
const checkAsync = async (label, fn) => {
  try {
    await fn();
  } catch (e) {
    e.message = `${label}: ${e.message}`;
    throw e;
  }
  n++;
};

// ---- the configurations
check("tauri.store-exe.conf.json: offline installer, no update artifacts", () => {
  const c = JSON.parse(read("src-tauri/tauri.store-exe.conf.json"));
  assert.deepEqual(c, { bundle: { createUpdaterArtifacts: false, windows: { webviewInstallMode: { type: "offlineInstaller", silent: true } } } });
});
check("tauri.conf.json: the normal installers do not carry the WebView2 Runtime", () => {
  const c = JSON.parse(read("src-tauri/tauri.conf.json"));
  assert.equal(c.bundle.windows.webviewInstallMode, undefined, "no WebView2 install mode in the shipped configuration (the setup downloads WebView2 when it is missing; only the Store configuration of option B embeds it)");
  assert.equal(c.bundle.createUpdaterArtifacts, true);
});

// ---- latest.json is the same with the offline installer among the assets
check("latest.json: the offline installer is no asset of the updater", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hl-store-exe-json-"));
  const V = "1.0.7";
  const names = [`HeyLook_${V}_windows_x64-setup.exe`, `HeyLook_${V}_windows_x64.msi`, `HeyLook_${V}_darwin_universal.app.tar.gz`, `HeyLook_${V}_darwin_universal.dmg`, `HeyLook_${V}_linux_amd64.AppImage`, `HeyLook_${V}_linux_amd64.deb`, `HeyLook_${V}_linux_x86_64.rpm`];
  const sigs = path.join(dir, "sigs");
  fs.mkdirSync(sigs);
  const sig = Buffer.from(`untrusted comment: signature\nAAAA\ntrusted comment: timestamp:1\tfile:x\tversion:${V}\nBBBB\n`).toString("base64");
  for (const f of names.filter((x) => !x.endsWith(".dmg"))) fs.writeFileSync(path.join(sigs, `${f}.sig`), sig);
  fs.writeFileSync(path.join(dir, "notes.md"), "notes\n");
  const script = path.join(root, ".github/scripts/make-latest-json.cjs");
  const gen = (list) => {
    fs.writeFileSync(path.join(dir, "assets.json"), JSON.stringify(list.map((name, i) => ({ name, size: 1000 + i }))));
    const r = spawnSync("node", [script, "generate", "--version", V, "--assets", path.join(dir, "assets.json"), "--sigs", sigs, "--notes", path.join(dir, "notes.md")], { encoding: "utf8" });
    return r;
  };
  const without = gen(names);
  const withOffline = gen([...names, `HeyLook_${V}_windows_x64_offline.exe`]);
  assert.equal(without.status, 0, without.stderr);
  assert.equal(withOffline.status, 0, withOffline.stderr);
  const a = JSON.parse(without.stdout);
  const b = JSON.parse(withOffline.stdout);
  delete a.pub_date;
  delete b.pub_date;
  assert.deepEqual(b, a, "latest.json changed because of the offline installer");
  assert.ok(!JSON.stringify(b).includes("offline"), "latest.json names the offline installer");
  // any other odd asset (another version of the offline installer, a bare exe) is still refused
  for (const odd of ["HeyLook_1.0.8_windows_x64_offline.exe", `HeyLook_${V}_windows_x64_offline-setup.exe.extra`, "hey-look.exe"]) {
    const r = gen([...names, odd]);
    assert.notEqual(r.status, 0, `${odd} was accepted`);
    assert.match(r.stderr, /unexpected asset/);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- the workflow text
const yml = read(".github/workflows/release.yml");
const pages = read(".github/workflows/pages.yml");
const block = (name) => {
  const head = `\n  ${name}:\n`;
  const at = yml.indexOf(head);
  assert.ok(at >= 0, `job ${name} not found`);
  const next = yml.slice(at + head.length).search(/\n  [a-z][\w-]*:\n/);
  return yml.slice(at, next < 0 ? undefined : at + head.length + next);
};
check("workflow: store-exe builds the offline installer and names it as the asset list wants", () => {
  const b = block("store-exe");
  assert.match(b, /^    needs: \[plan, create-release\]$/m);
  assert.ok(b.includes("npx tauri build --bundles nsis --config src-tauri/tauri.store-exe.conf.json"));
  assert.ok(b.includes('$name = "HeyLook_${v}_windows_x64_offline.exe"'), "the asset name");
  assert.ok(!/-setup\.exe"/.test(b.replace(/\*-setup\.exe/g, "")), "the asset name must not end in -setup.exe");
  // tag runs attach it to the draft, a dry run only keeps it
  assert.match(b, /- name: Attach to the draft release\n        if: github\.event_name == 'push'\n/);
  assert.match(b, /- name: Keep the installer of a dry run\n        if: github\.event_name != 'push'\n/);
  assert.ok(b.includes("store-exe-dryrun"));
  // the build reads the embedded client ids like the release build: only on a tag push, from the Environment release
  for (const s of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"]) assert.ok(b.includes(`${s}: \${{ github.event_name == 'push' && secrets.${s} || '' }}`), s);
  assert.ok(!/TAURI_SIGNING_PRIVATE_KEY/.test(b), "the offline installer has no update signature, so the update key is not needed");
  // a normal installer is about 8 MB, an offline one about 135 MB
  assert.ok(b.includes("100MB"));
});
check("workflow: publish checks the asset list with the flag only when the plan says so", () => {
  const b = block("publish");
  assert.ok(b.includes("STORE_EXE: ${{ needs.plan.outputs.store_exe }}"));
  assert.equal((b.match(/--store-exe/g) ?? []).length, 2, "both asset-list checks");
  assert.ok(b.includes("store-exe") && /needs: \[[^\]]*store-exe/.test(b), "publish waits for store-exe");
});
check("workflow: store-url checks signature, digest and the live address, after publish only", () => {
  const b = block("store-url");
  assert.match(b, /^    needs: \[plan, publish, store-exe\]$/m);
  assert.ok(b.includes("github.event_name == 'push'") && b.includes("needs.plan.outputs.store_exe == 'true'"));
  assert.ok(b.includes("Get-AuthenticodeSignature") && b.includes("-ne 'Valid'"), "an unsigned installer is refused");
  assert.ok(b.includes("gh workflow run pages.yml --ref main") && b.includes("store-url-check.sh"));
  assert.match(b, /permissions:\n      contents: read\n      actions: write/);
});
check("workflow: nothing in the Store jobs is read without its variable", () => {
  for (const j of ["store-exe", "store-url", "store-submit-exe"]) assert.ok(block(j).includes("needs.plan.outputs.store_exe == 'true'"), `${j} is not gated by STORE_EXE`);
  for (const j of ["store-submit", "store-submit-exe"]) assert.ok(block(j).includes("needs.plan.outputs.store_submit == 'true'"), `${j} is not gated by STORE_SUBMIT`);
  // the variables are read in the plan job only (and, for the product ids and the identity, in the step that needs them)
  const used = [...yml.matchAll(/vars\.(STORE_\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(used)].sort(), ["STORE_EXE", "STORE_EXE_PRODUCT_ID", "STORE_PRODUCT_ID", "STORE_SUBMIT"]);
  assert.equal(used.filter((u) => u === "STORE_EXE").length, 1, "STORE_EXE is read once, by the plan job");
  assert.equal(used.filter((u) => u === "STORE_SUBMIT").length, 1, "STORE_SUBMIT is read once, by the plan job");
});
check("pages.yml: the Store installers only with STORE_EXE, one form of the variable", () => {
  const lines = pages.split("\n").filter((l) => /vars\./.test(l) && !/^\s*#/.test(l));
  assert.equal(lines.length, 2, "the build step and the Store step");
  for (const l of lines) assert.equal(l.trim(), "STORE_EXE: ${{ vars.STORE_EXE == 'true' && 'on' || 'off' }}");
  assert.ok(pages.includes('if [ "$STORE_EXE" != on ]; then') && pages.includes("store-exe-assemble.sh _site"));
  assert.ok(pages.includes('".github/scripts/store-exe-assemble.sh"'), "a change of the script redeploys");
});

// ---- the scripts (bash)
const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
const bash = process.platform === "win32" && fs.existsSync(gitBash) ? gitBash : "bash";
const have = (cmd) => spawnSync(bash, ["-c", `command -v ${cmd} > /dev/null`]).status === 0;
const posix = (p) => p.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, d) => (process.platform === "win32" ? `/${d.toLowerCase()}` : `${d}:`));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const scriptsOk = ["jq", "curl", "sha256sum"].every(have);
if (!scriptsOk) {
  console.log(`test-store-exe: ok (${n} checks; the scripts were SKIPPED: they need bash, jq, curl and sha256sum)`);
  process.exit(0);
}
const run = (script, args, { env = {}, fakeBin } = {}) =>
  spawnSync(bash, ["-c", `${fakeBin ? `export PATH="${posix(fakeBin)}:$PATH"; ` : ""}exec bash "${posix(path.join(root, script))}" "$@"`, "_", ...args], { encoding: "utf8", env: { ...process.env, ...env } });
const runAsync = (script, args, env) =>
  new Promise((resolve) => {
    const p = spawn(bash, ["-c", `exec bash "${posix(path.join(root, script))}" "$@"`, "_", ...args], { env: { ...process.env, ...env } });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (status) => resolve({ status, stdout: out, stderr: err }));
  });

// -- store-exe-assemble.sh with a fake gh and curl
const work = fs.mkdtempSync(path.join(os.tmpdir(), "hl-store-exe-"));
const fakeBin = path.join(work, "bin");
fs.mkdirSync(fakeBin);
fs.writeFileSync(
  path.join(fakeBin, "gh"),
  `#!/usr/bin/env bash
# fake gh: "gh api <path> --paginate --jq <filter>" answers with the filter applied to the fixture $FAKE_RELEASES
filter=""
while [ $# -gt 0 ]; do case "$1" in --jq) filter="$2"; shift 2 ;; *) shift ;; esac; done
jq -c "$filter" "$FAKE_RELEASES"
`,
);
fs.writeFileSync(
  path.join(fakeBin, "curl"),
  `#!/usr/bin/env bash
# fake curl: the last argument is the url, -o the target; the file comes from $FAKE_FILES by its name
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done
f="$FAKE_FILES/$(basename "$url")"
[ -f "$f" ] || exit 22
cp "$f" "$out"
`,
);
for (const n of ["gh", "curl"]) fs.chmodSync(path.join(fakeBin, n), 0o755);
// hermetic: the scripts must find OUR gh and curl first, never the runner's (a real gh would call the GitHub API with the runner's token)
for (const n of ["gh", "curl"]) {
  const r = spawnSync(bash, ["-c", `export PATH="${posix(fakeBin)}:$PATH"; command -v ${n}`], { encoding: "utf8" });
  assert.equal(r.stdout.trim(), `${posix(fakeBin)}/${n}`, `the fake ${n} is the one found first`);
}
const REPO = "thnonl/hey-look";
const fixture = (releases, files) => {
  const d = fs.mkdtempSync(path.join(work, "case-"));
  fs.mkdirSync(path.join(d, "files"));
  fs.mkdirSync(path.join(d, "site"));
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(d, "files", name), bytes);
  fs.writeFileSync(path.join(d, "releases.json"), JSON.stringify(releases));
  return d;
};
const asset = (v, bytes, over = {}) => ({ name: `HeyLook_${v}_windows_x64_offline.exe`, size: bytes.length, digest: `sha256:${sha(bytes)}`, browser_download_url: `https://github.com/${REPO}/releases/download/v${v}/HeyLook_${v}_windows_x64_offline.exe`, ...over });
const release = (v, assets, over = {}) => ({ tag_name: `v${v}`, draft: false, prerelease: false, assets, ...over });
const assemble = (d, keep) => run(".github/scripts/store-exe-assemble.sh", [path.join(d, "site"), REPO, ...(keep ? [String(keep)] : [])], { fakeBin, env: { FAKE_RELEASES: path.join(d, "releases.json"), FAKE_FILES: path.join(d, "files"), GH_TOKEN: "x" } });
const bytes = (v) => Buffer.from(`offline installer ${v} `.repeat(50));
const out = (r) => Object.fromEntries(r.stdout.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

check("assemble: the newest 3 published releases, drafts and prereleases left out", () => {
  const vs = ["1.0.3", "1.0.4", "1.0.5", "1.0.6"];
  const files = Object.fromEntries(vs.map((v) => [`HeyLook_${v}_windows_x64_offline.exe`, bytes(v)]));
  files["HeyLook_1.0.7_windows_x64_offline.exe"] = bytes("1.0.7");
  files["HeyLook_1.0.8_windows_x64_offline.exe"] = bytes("1.0.8");
  const d = fixture(
    [
      release("1.0.7", [asset("1.0.7", bytes("1.0.7"))], { draft: true }),
      release("1.0.8", [asset("1.0.8", bytes("1.0.8"))], { prerelease: true }),
      ...vs.map((v) => release(v, [asset(v, bytes(v))])),
      release("1.0.2", [{ name: "HeyLook_1.0.2_windows_x64-setup.exe", size: 5, digest: "sha256:" + "0".repeat(64), browser_download_url: "x" }]),
    ],
    files,
  );
  const r = assemble(d);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(out(r), { count: "3", newest: "1.0.6", newest_sha256: sha(bytes("1.0.6")), newest_size: String(bytes("1.0.6").length) });
  assert.deepEqual(fs.readdirSync(path.join(d, "site", "downloads")).sort(), ["1.0.4", "1.0.5", "1.0.6"]);
  for (const v of ["1.0.4", "1.0.5", "1.0.6"]) assert.ok(fs.readFileSync(path.join(d, "site", "downloads", v, `HeyLook_${v}_windows_x64_offline.exe`)).equals(bytes(v)));
  assert.equal(assemble(d, 1).status, 0);
});
check("assemble: no release has it yet, nothing is added and it is not an error", () => {
  const d = fixture([release("1.0.6", [{ name: "HeyLook_1.0.6_windows_x64-setup.exe", size: 1, digest: "sha256:" + "0".repeat(64), browser_download_url: "x" }])], {});
  const r = assemble(d);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(out(r), { count: "0" });
  assert.ok(!fs.existsSync(path.join(d, "site", "downloads")));
});
const refused = (label, releases, files, re) =>
  check(`assemble refuses: ${label}`, () => {
    const d = fixture(releases, files);
    const r = assemble(d);
    assert.notEqual(r.status, 0, `accepted: ${r.stdout}`);
    assert.match(r.stderr, re);
  });
const good = (v) => ({ [`HeyLook_${v}_windows_x64_offline.exe`]: bytes(v) });
refused("no digest", [release("1.0.6", [asset("1.0.6", bytes("1.0.6"), { digest: null })])], good("1.0.6"), /no sha256 digest/);
refused("a digest of another kind", [release("1.0.6", [asset("1.0.6", bytes("1.0.6"), { digest: "md5:abc" })])], good("1.0.6"), /no sha256 digest/);
refused("bytes that are not the digest", [release("1.0.6", [asset("1.0.6", bytes("1.0.6"))])], { "HeyLook_1.0.6_windows_x64_offline.exe": Buffer.from("tampered") }, /GitHub says/);
refused("a size that is not the size", [release("1.0.6", [asset("1.0.6", bytes("1.0.6"), { size: 7 })])], good("1.0.6"), /size is not 7/);
refused("a url outside the release", [release("1.0.6", [asset("1.0.6", bytes("1.0.6"), { browser_download_url: "https://example.org/HeyLook_1.0.6_windows_x64_offline.exe" })])], good("1.0.6"), /not the release asset of this repository/);
refused("a url of another release", [release("1.0.6", [asset("1.0.6", bytes("1.0.6"), { browser_download_url: `https://github.com/${REPO}/releases/download/v1.0.5/HeyLook_1.0.6_windows_x64_offline.exe` })])], good("1.0.6"), /not the release asset of this repository/);
refused("an asset of another version in the release", [release("1.0.6", [asset("1.0.9", bytes("1.0.9"))])], good("1.0.9"), /does not belong to the version/);
refused("a download that fails", [release("1.0.6", [asset("1.0.6", bytes("1.0.6"))])], {}, /download of .* failed/);

// -- store-url-check.sh against a local server
async function serve(mode, v, body) {
  let heads = 0;
  const srv = http.createServer((req, res) => {
    const p = req.url.split("?")[0];
    if (p === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(mode === "norobots" ? "User-agent: *\nAllow: /\nDisallow: /apt/\n" : "User-agent: *\nAllow: /\nDisallow: /apt/\nDisallow: /downloads/\n");
    }
    if (p !== `/downloads/${v}/HeyLook_${v}_windows_x64_offline.exe`) {
      res.writeHead(404);
      return res.end();
    }
    if (req.method === "HEAD") heads++;
    if (mode === "never" || (mode === "late" && heads <= 2)) {
      res.writeHead(404);
      return res.end();
    }
    if (mode === "redirect") {
      res.writeHead(302, { location: "https://example.org/x.exe" });
      return res.end();
    }
    const headers = { "content-length": body.length, "accept-ranges": "bytes" };
    if (mode === "encoding") headers["content-encoding"] = "identity";
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : mode === "tampered" ? Buffer.alloc(body.length, 1) : body);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}
const V = "1.0.7";
const BODY = Buffer.from("the offline installer ".repeat(200));
const urlCase = async (label, mode, { sha256 = sha(BODY), size = BODY.length, expect = 0, re = null, env = {} } = {}) =>
  checkAsync(`store-url-check: ${label}`, async () => {
    const s = await serve(mode, V, BODY);
    try {
      const r = await runAsync(".github/scripts/store-url-check.sh", [V, sha256, String(size), s.base], { STORE_URL_WAIT: "3", STORE_URL_SLEEP: "1", ...env });
      if (expect === 0) assert.equal(r.status, 0, r.stderr + r.stdout);
      else {
        assert.notEqual(r.status, 0, r.stdout);
        if (re) assert.match(r.stderr, re);
      }
    } finally {
      await s.close();
    }
  });
await urlCase("the address as Partner Center needs it", "ok");
await urlCase("a late deploy is waited for", "late", { env: { STORE_URL_WAIT: "20" } });
await urlCase("a deploy that never comes", "never", { expect: 1, re: /still not 200/, env: { STORE_URL_WAIT: "2" } });
await urlCase("a redirect", "redirect", { expect: 1, re: /still not 200|redirects/ });
await urlCase("a proxy that sets Content-Encoding", "encoding", { expect: 1, re: /Content-Encoding/ });
await urlCase("another size", "ok", { size: BODY.length + 1, expect: 1, re: /Content-Length/ });
await urlCase("other bytes", "tampered", { expect: 1, re: /sha256/ });
await urlCase("the digest of another file", "ok", { sha256: sha(Buffer.from("other")), expect: 1, re: /sha256/ });
await urlCase("robots.txt that does not block /downloads/", "norobots", { expect: 1, re: /robots\.txt/ });
check("store-url-check: bad arguments", () => {
  assert.notEqual(run(".github/scripts/store-url-check.sh", ["1.0.7", "abc", "5"]).status, 0);
  assert.notEqual(run(".github/scripts/store-url-check.sh", ["1.0.7", sha(BODY), "five"]).status, 0);
});

// -- the site build
check("build-site: robots.txt blocks /downloads/ only with STORE_EXE=on", () => {
  const build = (env) => {
    const out = fs.mkdtempSync(path.join(work, "site-"));
    const r = spawnSync("node", [path.join(root, "scripts/build-site.mjs"), out], { encoding: "utf8", env: { ...process.env, APT_SITE: "off", STORE_EXE: "", ...env } });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    return fs.readFileSync(path.join(out, "robots.txt"), "utf8");
  };
  const source = read("docs/robots.txt");
  assert.ok(!source.includes("/downloads/"), "docs/robots.txt never changes");
  assert.equal(build({}), source);
  for (const v of ["true", "ON"]) assert.equal(build({ STORE_EXE: v }), source, `STORE_EXE=${v}`);
  const on = build({ STORE_EXE: "on" });
  assert.equal(on, source.replace("Disallow: /apt/\n", "Disallow: /apt/\nDisallow: /downloads/\n"));
});

fs.rmSync(work, { recursive: true, force: true });
console.log(`test-store-exe: ok (${n} checks)`);
