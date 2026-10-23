#!/usr/bin/env node
// Builds the Microsoft Store package (WP14 option A, spec WA.1) from the release exe, with the tools of the Windows SDK (makeappx, makepri):
//   node scripts/msix-build.mjs --exe <hey-look.exe> --out <folder> [--version X.Y.Z] [--require-identity] [--test-sign] [--store-logos] [--github-output]
// Identity from the environment: MSIX_IDENTITY_NAME, MSIX_PUBLISHER, MSIX_PUBLISHER_DISPLAY_NAME (public values from Partner Center > Product
// identity; repository variables, not secrets). None set = a placeholder identity (CN=HeyLook-Dev) for a dry run; --require-identity (tag runs)
// makes that an error. The version is the one of src-tauri/tauri.conf.json (X.Y.Z -> X.Y.Z.0) unless --version says another;
// --expect-version X.Y.Z (a tag run: the tag) makes any other version an error.
// Writes, in <folder>:
//   HeyLook_<V>_x64.msix        the package for Partner Center (unsigned: the Store signs it after certification, MSIX-REQ)
//   HeyLook_<V>_x64_test.msix   with --test-sign: a copy signed with a throw-away certificate whose subject is the Publisher (CI install check,
//                               Windows Sandbox); HeyLook-test.cer is its PUBLIC half. The private key lives in a temp folder only for the
//                               signing and is deleted at once; nothing private is ever written into <folder>
//   store/                      with --store-logos: the listing images (box art, poster, tile)
//   layout/                     what was packed (exe, Assets, AppxManifest.xml, resources.pri)
//   msix-build.json             identity (public), versions, sizes and sha256 of the exe and the packages
// --github-output appends version=, file=, ready=, dev= to $GITHUB_OUTPUT. `ready` is readiness.json's appPackagedMode (src-tauri/msix).
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXE_NAME, TEMPLATE, ROOT, checkManifest, fillManifest, findOpenssl, findSdkTool, msixVersion, packageImages, publisherToSubject, readReadiness, resolveIdentity, sha256File, storeLogos } from "./lib/msix.mjs";
import { renderImages } from "./msix-assets.mjs";

function run(tool, args, { cwd } = {}) {
  try {
    return execFileSync(tool, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  } catch (e) {
    throw new Error(`${path.basename(tool)} ${args.slice(0, 2).join(" ")} failed (exit ${e.status}):\n${e.stdout ?? ""}${e.stderr ?? ""}`);
  }
}

/** A copy of `msix` signed with a throw-away certificate whose subject is `publisher`. Returns { signed, cer }. */
export function testSign({ msix, publisher, outSigned, outCer, tmp }) {
  const openssl = findOpenssl();
  const signtool = findSdkTool("signtool.exe");
  if (!openssl) throw new Error("openssl was not found (Git for Windows has one)");
  if (!signtool) throw new Error("signtool.exe was not found (Windows SDK)");
  fs.mkdirSync(tmp, { recursive: true });
  const key = path.join(tmp, "test.key");
  const crt = path.join(tmp, "test.crt");
  const pfx = path.join(tmp, "test.pfx");
  const password = randomBytes(18).toString("base64url");
  try {
    run(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt, "-days", "2", "-sha256", "-subj", publisherToSubject(publisher), "-addext", "basicConstraints=critical,CA:FALSE", "-addext", "keyUsage=critical,digitalSignature", "-addext", "extendedKeyUsage=critical,codeSigning"]);
    // 3DES/SHA1 for the file protection: every signtool reads that without OpenSSL's legacy provider (a throw-away file)
    run(openssl, ["pkcs12", "-export", "-inkey", key, "-in", crt, "-out", pfx, "-passout", `pass:${password}`, "-certpbe", "PBE-SHA1-3DES", "-keypbe", "PBE-SHA1-3DES", "-macalg", "SHA1"]);
    run(openssl, ["x509", "-in", crt, "-outform", "DER", "-out", outCer]);
    fs.copyFileSync(msix, outSigned);
    run(signtool, ["sign", "/fd", "SHA256", "/f", pfx, "/p", password, outSigned]);
  } finally {
    for (const f of [key, crt, pfx]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* never written */
      }
    }
  }
  return { signed: outSigned, cer: outCer };
}

export async function build({ exe, out, version, expectVersion, requireIdentity = false, testSignIt = false, withStoreLogos = false, env = process.env, tmp }) {
  if (process.platform !== "win32") throw new Error("the package is built on Windows (the Windows SDK tools makeappx and makepri)");
  const makeappx = findSdkTool("makeappx.exe");
  const makepri = findSdkTool("makepri.exe");
  if (!makeappx || !makepri) throw new Error("makeappx.exe / makepri.exe not found: install the Windows SDK or set MAKEAPPX and MAKEPRI");
  if (!fs.existsSync(exe)) throw new Error(`${exe} does not exist`);
  const conf = JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
  const v3 = version || conf.version;
  if (expectVersion && v3 !== expectVersion) throw new Error(`the version is ${v3} (tauri.conf.json), expected ${expectVersion} (the tag)`);
  const v4 = msixVersion(v3);
  const identity = resolveIdentity({ name: env.MSIX_IDENTITY_NAME, publisher: env.MSIX_PUBLISHER, publisherDisplayName: env.MSIX_PUBLISHER_DISPLAY_NAME }, { requireIdentity });
  const ready = readReadiness().appPackagedMode;

  const manifest = fillManifest(fs.readFileSync(TEMPLATE, "utf8"), identity, v4);
  const problems = checkManifest(manifest, { name: identity.name, publisher: identity.publisher, publisherDisplayName: identity.publisherDisplayName, version: v4 });
  if (problems.length) throw new Error(`the manifest is not what the spec says:\n- ${problems.join("\n- ")}`);
  fs.mkdirSync(out, { recursive: true });
  const layout = path.join(out, "layout");
  if (fs.existsSync(layout) && fs.readdirSync(layout).length) throw new Error(`${layout} is not empty: use a new output folder`);
  fs.mkdirSync(path.join(layout, "Assets"), { recursive: true });

  fs.copyFileSync(exe, path.join(layout, EXE_NAME));
  const exeSha = sha256File(path.join(layout, EXE_NAME));

  fs.writeFileSync(path.join(layout, "AppxManifest.xml"), manifest);

  await renderImages(packageImages(), path.join(layout, "Assets"));

  // resources.pri: the scaled images (Square44x44Logo.scale-200.png ...) are found through it
  const priCfg = path.join(out, "priconfig.xml");
  run(makepri, ["createconfig", "/cf", priCfg, "/dq", "en-US", "/pv", "10.0.0", "/o"]);
  // one package, one resources.pri with every scale in it: without this the default config splits the scales into resources.scale-125.pri ... (resource packs of a bundle)
  fs.writeFileSync(priCfg, fs.readFileSync(priCfg, "utf8").replace(/<packaging>[\s\S]*?<\/packaging>/, ""));
  const pri = path.join(out, "resources.pri");
  run(makepri, ["new", "/pr", layout, "/cf", priCfg, "/mn", path.join(layout, "AppxManifest.xml"), "/of", pri, "/o"]);
  fs.copyFileSync(pri, path.join(layout, "resources.pri"));

  const msix = path.join(out, `HeyLook_${v3}_x64.msix`);
  run(makeappx, ["pack", "/d", layout, "/p", msix, "/o"]);

  const result = { version: v3, msixVersion: v4, identity, ready, exe: { sha256: exeSha, bytes: fs.statSync(path.join(layout, EXE_NAME)).size }, msix: { file: path.basename(msix), bytes: fs.statSync(msix).size, sha256: sha256File(msix) } };
  if (testSignIt) {
    const signed = path.join(out, `HeyLook_${v3}_x64_test.msix`);
    const cer = path.join(out, "HeyLook-test.cer");
    testSign({ msix, publisher: identity.publisher, outSigned: signed, outCer: cer, tmp: tmp ?? path.join(os.tmpdir(), `hl-msix-sign-${randomBytes(4).toString("hex")}`) });
    result.test = { file: path.basename(signed), cer: path.basename(cer), bytes: fs.statSync(signed).size, sha256: sha256File(signed) };
  }
  if (withStoreLogos) result.storeLogos = (await renderImages(storeLogos(), path.join(out, "store"))).map((f) => path.basename(f));
  fs.writeFileSync(path.join(out, "msix-build.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const val = (n) => (a.includes(n) ? a[a.indexOf(n) + 1] : undefined);
  const flag = (n) => a.includes(n);
  const exe = val("--exe");
  const out = val("--out");
  if (!exe || !out) {
    console.error("usage: node scripts/msix-build.mjs --exe <hey-look.exe> --out <folder> [--version X.Y.Z] [--expect-version X.Y.Z] [--require-identity] [--test-sign] [--store-logos] [--github-output]");
    process.exit(2);
  }
  try {
    const r = await build({ exe: path.resolve(exe), out: path.resolve(out), version: val("--version"), expectVersion: val("--expect-version"), requireIdentity: flag("--require-identity"), testSignIt: flag("--test-sign"), withStoreLogos: flag("--store-logos"), tmp: val("--tmp") });
    console.log(JSON.stringify(r, null, 2));
    if (flag("--github-output") && process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${r.version}\nfile=${r.msix.file}\nready=${r.ready}\ndev=${r.identity.dev}\n`);
    }
  } catch (e) {
    console.error(`msix-build: ${e.message}`);
    process.exit(1);
  }
}
