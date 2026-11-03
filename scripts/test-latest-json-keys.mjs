// F-20: the platform keys of latest.json. The updater plugin asks for `<os>-<arch>-<installer>` and then `<os>-<arch>` (macOS is `darwin`,
// the CPU `x86_64` / `aarch64`). The release workflow publishes ONE universal macOS archive under all four darwin keys; this test runs the
// real generator (.github/scripts/make-latest-json.cjs) with the asset names of a release and checks that every key the app can ask for
// is in the manifest and points at the right installer, so a Mac (Apple silicon or Intel, bundle type known or not) never gets "no installer".
// The Rust side (manifest_keys in src-tauri/src/update.rs) is checked from its source here and by cargo test.
// Run: node scripts/test-latest-json-keys.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = new URL("../.github/scripts/make-latest-json.cjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const dir = mkdtempSync(join(tmpdir(), "latest-json-keys-"));
try {
  const V = "1.0.4";
  const names = [
    `HeyLook_${V}_windows_x64-setup.exe`,
    `HeyLook_${V}_windows_x64.msi`,
    `HeyLook_${V}_darwin_universal.app.tar.gz`,
    `HeyLook_${V}_darwin_universal.dmg`,
    `HeyLook_${V}_linux_amd64.AppImage`,
    `HeyLook_${V}_linux_amd64.deb`,
    `HeyLook_${V}_linux_x86_64.rpm`,
    // 1.0.12: the native ARM64 builds
    `HeyLook_${V}_windows_arm64-setup.exe`,
    `HeyLook_${V}_windows_arm64.msi`,
    `HeyLook_${V}_linux_aarch64.AppImage`,
    `HeyLook_${V}_linux_arm64.deb`,
    `HeyLook_${V}_linux_aarch64.rpm`,
  ];
  const sigs = join(dir, "sigs");
  mkdirSync(sigs);
  const sig = Buffer.from(`untrusted comment: signature\nAAAA\ntrusted comment: timestamp:1\tfile:x\tversion:${V}\nBBBB\n`).toString("base64");
  for (const n of names.filter((n) => !n.endsWith(".dmg"))) writeFileSync(join(sigs, `${n}.sig`), sig);
  writeFileSync(join(dir, "assets.json"), JSON.stringify(names.map((name, i) => ({ name, size: 1000 + i }))));
  writeFileSync(join(dir, "notes.md"), "notes\n");
  const out = execFileSync("node", [script, "generate", "--version", V, "--assets", join(dir, "assets.json"), "--sigs", sigs, "--notes", join(dir, "notes.md")], { encoding: "utf8" });
  const manifest = JSON.parse(out);
  const platforms = manifest.platforms;

  // what the app asks for, written down once from the plugin's rules and compared with the Rust source below
  const keysFor = ({ os, arch, installer }) => {
    const o = os === "macos" ? "darwin" : os;
    const a = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : arch;
    return [...(installer === "unknown" ? [] : [`${o}-${a}-${installer}`]), `${o}-${a}`];
  };
  const shipped = [
    [{ os: "macos", arch: "arm64", installer: "app" }, ".app.tar.gz"],
    [{ os: "macos", arch: "x64", installer: "app" }, ".app.tar.gz"],
    [{ os: "macos", arch: "arm64", installer: "unknown" }, ".app.tar.gz"],
    [{ os: "macos", arch: "x64", installer: "unknown" }, ".app.tar.gz"],
    [{ os: "windows", arch: "x64", installer: "nsis" }, "-setup.exe"],
    [{ os: "windows", arch: "x64", installer: "msi" }, ".msi"],
    [{ os: "linux", arch: "x64", installer: "appimage" }, ".AppImage"],
    [{ os: "linux", arch: "x64", installer: "deb" }, ".deb"],
    [{ os: "linux", arch: "x64", installer: "rpm" }, ".rpm"],
    [{ os: "windows", arch: "arm64", installer: "nsis" }, "-setup.exe"],
    [{ os: "windows", arch: "arm64", installer: "msi" }, ".msi"],
    [{ os: "linux", arch: "arm64", installer: "appimage" }, ".AppImage"],
    [{ os: "linux", arch: "arm64", installer: "deb" }, ".deb"],
    [{ os: "linux", arch: "arm64", installer: "rpm" }, ".rpm"],
  ];
  for (const [p, ext] of shipped) {
    for (const key of keysFor(p)) {
      const e = platforms[key];
      assert.ok(e, `${JSON.stringify(p)}: the app asks for ${key}, latest.json has no such key (${Object.keys(platforms).join(", ")})`);
      // the installer-specific key (first) must be the installer; the plain key is only the fallback (Windows: nsis, Linux: AppImage)
      if (key === keysFor(p)[0]) assert.ok(e.url.endsWith(ext), `${key} points at ${e.url}, expected ...${ext}`);
      assert.ok(e.url.startsWith(`https://github.com/thnonl/hey-look/releases/download/v${V}/`), `${key}: ${e.url}`);
      assert.ok(e.signature && e.size > 0, `${key}: signature and size`);
    }
  }
  // each architecture gets its OWN file (an ARM64 key never points at the x64 installer and the other way round)
  assert.match(platforms["windows-aarch64-nsis"].url, /_windows_arm64-setup\.exe$/);
  assert.match(platforms["windows-x86_64-nsis"].url, /_windows_x64-setup\.exe$/);
  assert.match(platforms["linux-aarch64-deb"].url, /_linux_arm64\.deb$/);
  assert.match(platforms["linux-x86_64-deb"].url, /_linux_amd64\.deb$/);
  assert.equal(platforms["windows-aarch64"].url, platforms["windows-aarch64-nsis"].url, "the plain Windows ARM64 key is the NSIS setup");
  assert.equal(platforms["linux-aarch64"].url, platforms["linux-aarch64-appimage"].url, "the plain Linux ARM64 key is the AppImage");
  // the universal archive serves both Mac CPUs and both ways of naming (with and without the bundle type)
  const mac = ["darwin-aarch64-app", "darwin-x86_64-app", "darwin-aarch64", "darwin-x86_64"].map((k) => platforms[k].url);
  assert.equal(new Set(mac).size, 1);
  assert.match(mac[0], /_darwin_universal\.app\.tar\.gz$/);

  // the checker the release workflow runs on the real manifest accepts it
  writeFileSync(join(dir, "latest.json"), out);
  execFileSync("node", [script, "check", join(dir, "latest.json"), "--version", V], { encoding: "utf8" });

  // a release without ARM64 builds (ARM64_BUILD=false): --no-arm makes the generator and the checker want the x64 keys only
  {
    const x64only = names.filter((n) => !/arm64|aarch64/.test(n));
    writeFileSync(join(dir, "assets-x64.json"), JSON.stringify(x64only.map((name, i) => ({ name, size: 1000 + i }))));
    const out2 = execFileSync("node", [script, "generate", "--version", V, "--assets", join(dir, "assets-x64.json"), "--sigs", sigs, "--notes", join(dir, "notes.md"), "--no-arm"], { encoding: "utf8" });
    assert.ok(!Object.keys(JSON.parse(out2).platforms).some((k) => /aarch64/.test(k) && !k.startsWith("darwin")), "no ARM64 key without ARM64 builds");
    writeFileSync(join(dir, "latest-x64.json"), out2);
    execFileSync("node", [script, "check", join(dir, "latest-x64.json"), "--version", V, "--no-arm"], { encoding: "utf8" });
    assert.throws(() => execFileSync("node", [script, "check", join(dir, "latest-x64.json"), "--version", V], { encoding: "utf8", stdio: "pipe" }), "a manifest without the ARM64 keys is refused when they are wanted");
    assert.throws(() => execFileSync("node", [script, "generate", "--version", V, "--assets", join(dir, "assets-x64.json"), "--sigs", sigs, "--notes", join(dir, "notes.md")], { encoding: "utf8", stdio: "pipe" }), "ARM64 wanted but missing");
    assert.throws(() => execFileSync("node", [script, "generate", "--version", V, "--assets", join(dir, "assets.json"), "--sigs", sigs, "--notes", join(dir, "notes.md"), "--no-arm"], { encoding: "utf8", stdio: "pipe" }), "ARM64 files present although none are wanted");
  }

  // the Rust side states the same mapping
  const rust = readFileSync(new URL("../src-tauri/src/update.rs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const fn = rust.slice(rust.indexOf("pub fn manifest_keys("));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /p\.os == "macos" \{ "darwin" \}/, "macOS is darwin");
  assert.match(body, /"x64" => "x86_64"/);
  assert.match(body, /"arm64" => "aarch64"/);
  assert.match(body, /format!\("\{os\}-\{arch\}-\{\}", p\.installer\)/, "<os>-<arch>-<installer> first");
  assert.match(body, /format!\("\{os\}-\{arch\}"\)/, "then <os>-<arch>");
  // and logs them when it asks the server
  assert.match(rust, /manifest_keys\(&ctx\.platform\)\.join\(" then "\)/, "startup.log names the keys looked for");
  console.log("ok");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
