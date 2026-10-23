#!/usr/bin/env node
// Unpacks a package with makeappx and checks it against the acceptance criterion AC-WA.1.1 (spec WP14 WA.1):
//   node scripts/msix-verify.mjs <package.msix> [--name N] [--publisher P] [--publisher-display-name D] [--version X.Y.Z.0] [--exe-sha256 <hex>] [--unpack <folder>]
//   node scripts/msix-verify.mjs <package.msix> --from <msix-build.json> --exe <hey-look.exe>   (identity and version from the build's json, the exe from its own file)
// The manifest says what scripts/lib/msix.mjs checkManifest says (identity, version X.Y.Z.0, x64, runFullTrust and only that, the startup task,
// 8 languages, the Store name in Properties and VisualElements), hey-look.exe is in the package and (with --exe-sha256) byte-identical to the one of the
// NSIS build, resources.pri and every image of the list in lib/msix.mjs are in it, and a package must carry no key (PRIVATE KEY text, .pfx, .key).
// Prints one line per check and the sha256 of the exe; exit 1 on the first list of problems.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkManifest, EXE_NAME, findSdkTool, packageImages, sha256File } from "./lib/msix.mjs";

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

export function verify(msix, expect = {}, { unpack } = {}) {
  const makeappx = findSdkTool("makeappx.exe");
  if (!makeappx) throw new Error("makeappx.exe not found (Windows SDK)");
  const dir = unpack ?? fs.mkdtempSync(path.join(os.tmpdir(), "hl-msix-unpack-"));
  fs.mkdirSync(dir, { recursive: true });
  // /nv: a package signed with a throw-away certificate is read without a trust check
  execFileSync(makeappx, ["unpack", "/p", msix, "/d", dir, "/o", "/nv"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const bad = [];
  const manifestFile = path.join(dir, "AppxManifest.xml");
  if (!fs.existsSync(manifestFile)) return { bad: ["the package has no AppxManifest.xml"], dir };
  bad.push(...checkManifest(fs.readFileSync(manifestFile, "utf8"), expect));
  const exe = path.join(dir, EXE_NAME);
  let exeSha = null;
  if (!fs.existsSync(exe)) bad.push(`${EXE_NAME} is not in the package`);
  else {
    exeSha = sha256File(exe);
    if (expect.exeSha256 && exeSha !== expect.exeSha256) bad.push(`${EXE_NAME} has sha256 ${exeSha}, the NSIS build's is ${expect.exeSha256}`);
  }
  if (!fs.existsSync(path.join(dir, "resources.pri"))) bad.push("resources.pri is not in the package");
  for (const img of packageImages()) if (!fs.existsSync(path.join(dir, "Assets", img.file))) bad.push(`Assets\\${img.file} is not in the package`);
  for (const f of walk(dir)) {
    if (/\.(pfx|p12|key|pem)$/i.test(f)) bad.push(`key material in the package: ${path.relative(dir, f)}`);
  }
  return { bad, dir, exeSha };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const val = (n) => (a.includes(n) ? a[a.indexOf(n) + 1] : undefined);
  const msix = a.find((x) => x.endsWith(".msix"));
  if (!msix) {
    console.error("usage: node scripts/msix-verify.mjs <package.msix> [--name N] [--publisher P] [--publisher-display-name D] [--version X.Y.Z.0] [--exe-sha256 <hex>] [--unpack <folder>] | --from <msix-build.json> --exe <hey-look.exe>");
    process.exit(2);
  }
  try {
    const from = val("--from") ? JSON.parse(fs.readFileSync(val("--from"), "utf8")) : null;
    const exeFile = val("--exe");
    const expect = from
      ? { name: from.identity.name, publisher: from.identity.publisher, publisherDisplayName: from.identity.publisherDisplayName, version: from.msixVersion, exeSha256: exeFile ? sha256File(exeFile) : from.exe.sha256 }
      : { name: val("--name"), publisher: val("--publisher"), publisherDisplayName: val("--publisher-display-name"), version: val("--version"), exeSha256: val("--exe-sha256") };
    const r = verify(path.resolve(msix), expect, { unpack: val("--unpack") ? path.resolve(val("--unpack")) : undefined });
    if (r.exeSha) console.log(`${EXE_NAME} sha256 ${r.exeSha}`);
    if (r.bad.length) {
      for (const b of r.bad) console.error(`problem: ${b}`);
      process.exit(1);
    }
    console.log(`msix-verify: ${path.basename(msix)} is as AC-WA.1.1 says`);
  } catch (e) {
    console.error(`msix-verify: ${e.message}`);
    process.exit(1);
  }
}
