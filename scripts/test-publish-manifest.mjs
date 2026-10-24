// WP11 W11.3 (REQ-11.3.6): the manifest step of the publish job (make-latest-json.cjs generate, then check, then the final asset-list check) has a dry-run check.
// The publish job runs only in a tag run, so its scripts would meet a real release for the first time there. This test feeds them the asset list of a
// release (the 7 installers and the 6 signatures that the build jobs upload, 13 names, as the publish job lists them) and the signature texts, and fails
// when the manifest generator, its checker or check-release-assets.sh would refuse that release. The signatures are the texts of a minisign signature
// (the publish job copies them; their cryptographic check is `verify-update-sigs.cjs --selftest`, which makes its own throw-away key). No network.
// Run: node scripts/test-publish-manifest.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const gen = join(here, "..", ".github", "scripts", "make-latest-json.cjs");
const assetsCheck = join(here, "..", ".github", "scripts", "check-release-assets.sh");
const dir = mkdtempSync(join(tmpdir(), "publish-manifest-"));
const V = "9.9.9";
const installers = [
  `HeyLook_${V}_windows_x64-setup.exe`,
  `HeyLook_${V}_windows_x64.msi`,
  `HeyLook_${V}_darwin_universal.app.tar.gz`,
  `HeyLook_${V}_darwin_universal.dmg`,
  `HeyLook_${V}_linux_amd64.AppImage`,
  `HeyLook_${V}_linux_amd64.deb`,
  `HeyLook_${V}_linux_x86_64.rpm`,
];
const signed = installers.filter((n) => !n.endsWith(".dmg"));
const names = [...installers, ...signed.map((n) => `${n}.sig`)];
assert.equal(names.length, 13);

const sigs = join(dir, "sigs");
mkdirSync(sigs);
const sigText = (n) => Buffer.from(`untrusted comment: signature from tauri secret key\nRUQ${"A".repeat(40)}\ntrusted comment: timestamp:1\tfile:${n}\n${"B".repeat(86)}\n`).toString("base64");
for (const n of signed) writeFileSync(join(sigs, `${n}.sig`), sigText(n));
writeFileSync(join(dir, "assets.json"), JSON.stringify(names.map((name, i) => ({ name, size: 1000 + i, id: i + 1 }))));
writeFileSync(join(dir, "notes.md"), "notes\n");

const out = execFileSync("node", [gen, "generate", "--version", V, "--assets", join(dir, "assets.json"), "--sigs", sigs, "--notes", join(dir, "notes.md")], { encoding: "utf8" });
writeFileSync(join(dir, "latest.json"), out);
const manifest = JSON.parse(out);
assert.equal(manifest.version, V);
assert.equal(Object.keys(manifest.platforms).length >= 9, true, "the manifest names every platform key");
for (const [key, p] of Object.entries(manifest.platforms)) {
  assert.ok(p.signature && p.url.includes(`/v${V}/`), `${key}: signature and url`);
}
const check = spawnSync("node", [gen, "check", join(dir, "latest.json"), "--version", V], { encoding: "utf8" });
assert.equal(check.status, 0, `check of a good manifest: ${check.stderr}`);

// the final list of the publish job: 13 names + latest.json = 14, accepted
const finalList = [...names, "latest.json"].join("\n") + "\n";
const ok = spawnSync("bash", [assetsCheck, V], { input: finalList, encoding: "utf8" });
assert.equal(ok.status, 0, `check-release-assets on a complete release: ${ok.stdout}${ok.stderr}`);
// ... and the list before latest.json exists (--pre), where latest.json must NOT be there
assert.equal(spawnSync("bash", [assetsCheck, V, "--pre"], { input: names.join("\n") + "\n", encoding: "utf8" }).status, 0, "the --pre list");
assert.notEqual(spawnSync("bash", [assetsCheck, V, "--pre"], { input: finalList, encoding: "utf8" }).status, 0, "--pre with latest.json present must fail");

// negative controls: a missing signature file and a missing installer are refused
const lost = signed[0];
const noSig = spawnSync("bash", [assetsCheck, V], { input: [...names.filter((n) => n !== `${lost}.sig`), "latest.json"].join("\n") + "\n", encoding: "utf8" });
assert.notEqual(noSig.status, 0, "a missing .sig must fail the asset check");
const noInstaller = spawnSync("bash", [assetsCheck, V], { input: [...names.filter((n) => !n.endsWith(".rpm")), "latest.json"].join("\n") + "\n", encoding: "utf8" });
assert.notEqual(noInstaller.status, 0, "a missing .rpm must fail the asset check");
writeFileSync(join(dir, "bad.json"), JSON.stringify({ ...manifest, version: "1.0.0" }));
assert.notEqual(spawnSync("node", [gen, "check", join(dir, "bad.json"), "--version", V], { encoding: "utf8" }).status, 0, "a manifest of another version must fail the check");

console.log(`ok - test-publish-manifest (13 names + latest.json, ${Object.keys(manifest.platforms).length} platform keys, generate/check/asset list, 3 negative controls)`);
