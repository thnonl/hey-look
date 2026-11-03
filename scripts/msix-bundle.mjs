#!/usr/bin/env node
// Packs the x64 and the arm64 Store package into ONE bundle for Partner Center (1.0.12), with makeappx of the Windows SDK:
//   node scripts/msix-bundle.mjs --x64 <HeyLook_V_x64.msix> --arm64 <HeyLook_V_arm64.msix> --out <HeyLook_V.msixbundle>
// Both packages must carry the same version (compared from the file names; the identity comes from the same build step). The bundle version is the package version X.Y.Z.0. Nothing is signed: the Store signs it after certification.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findSdkTool, msixVersion } from "./lib/msix.mjs";

/** Version X.Y.Z of the package named HeyLook_<X.Y.Z>_<arch>[_test].msix, or null. */
export function versionOfName(file, arch) {
  const m = new RegExp(`^HeyLook_(\\d+\\.\\d+\\.\\d+)_${arch}\\.msix$`).exec(path.basename(file));
  return m ? m[1] : null;
}

export function bundle({ x64, arm64, out }) {
  if (process.platform !== "win32") throw new Error("the bundle is made on Windows (makeappx of the Windows SDK)");
  const makeappx = findSdkTool("makeappx.exe");
  if (!makeappx) throw new Error("makeappx.exe not found (Windows SDK)");
  const v1 = versionOfName(x64, "x64");
  const v2 = versionOfName(arm64, "arm64");
  if (!v1 || !v2) throw new Error(`the packages must be named HeyLook_<X.Y.Z>_x64.msix and HeyLook_<X.Y.Z>_arm64.msix (got ${path.basename(x64)}, ${path.basename(arm64)})`);
  if (v1 !== v2) throw new Error(`the two packages have different versions: ${v1} and ${v2}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hl-msix-bundle-"));
  fs.copyFileSync(x64, path.join(dir, path.basename(x64)));
  fs.copyFileSync(arm64, path.join(dir, path.basename(arm64)));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  execFileSync(makeappx, ["bundle", "/d", dir, "/p", out, "/bv", msixVersion(v1), "/o"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  return { version: v1, bundleVersion: msixVersion(v1), file: path.basename(out), bytes: fs.statSync(out).size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const val = (n) => (a.includes(n) ? a[a.indexOf(n) + 1] : undefined);
  if (!val("--x64") || !val("--arm64") || !val("--out")) {
    console.error("usage: node scripts/msix-bundle.mjs --x64 <HeyLook_V_x64.msix> --arm64 <HeyLook_V_arm64.msix> --out <HeyLook_V.msixbundle>");
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(bundle({ x64: path.resolve(val("--x64")), arm64: path.resolve(val("--arm64")), out: path.resolve(val("--out")) }), null, 2));
  } catch (e) {
    console.error(`msix-bundle: ${e.message}${e.stderr ? "\n" + e.stderr : ""}`);
    process.exit(1);
  }
}
