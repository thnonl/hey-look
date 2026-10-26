// The Microsoft Store package (WP14 option A, spec WA.1, AC-WA.1.1): the rules and the template, on every system; with the Windows SDK, a browser and
// OpenSSL (the CI job msix, a developer's Windows PC) also a real pack, unpack and test signature. Run: node scripts/test-msix-build.mjs
//   - version X.Y.Z -> X.Y.Z.0, first part not 0 (spec A-4); identity from the three repository variables: none = placeholder, a tag run refuses that,
//     one or two = error, odd values refused; the three public values of the Partner Center product are accepted
//   - the manifest template filled and checked by checkManifest: Store name (DEC-006) in Properties and VisualElements, x64, full trust and nothing
//     else, the startup task (off), 8 languages, 1809 minimum, no protocol / file type / mailto; every rule is also proven to FAIL on a mutated manifest
//   - the image lists: every scale of the three package logos, the unplated target sizes, the five Store listing images at their exact sizes
//   - publisherToSubject (the throw-away certificate's subject = the Publisher), readiness.json (and that `true` needs the packaged-mode code)
//   - release.yml wiring that WA.1 needs: the artifact names, the retention, the tag-run identity switch, no secret and no Environment in the msix jobs
//   - real: msix-build.mjs on a stand-in exe makes the package, msix-verify.mjs unpacks it (also the test-signed copy), no key is left behind
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEV_IDENTITY, LANGUAGES, ROOT, STORE_DISPLAY_NAME, TEMPLATE, checkManifest, fillManifest, findOpenssl, findSdkTool, msixVersion, packageImages, pngInfo, publisherToSubject, readReadiness, resolveIdentity, storeLogos } from "./lib/msix.mjs";

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

// the three public values of the Partner Center product (owner input 2026-10-19; not secrets)
const STORE = { name: "40278Noamo.651773BC9C4C7", publisher: "CN=FE739770-637C-437D-B2B9-DAA2E2EA56F1", publisherDisplayName: "Noamo" };
const template = fs.readFileSync(TEMPLATE, "utf8");
const conf = JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));

// ---- version
check("version", () => {
  assert.equal(msixVersion("1.0.7"), "1.0.7.0");
  assert.equal(msixVersion(" 2.10.300 "), "2.10.300.0");
  assert.equal(msixVersion(conf.version), `${conf.version}.0`);
  for (const bad of ["", "1.0", "1.0.7.1", "0.9.0", "1.0.7-rc1", "v1.0.7", "1.0.65536", "a.b.c", "1..2"]) assert.throws(() => msixVersion(bad), undefined, `'${bad}' must be refused`);
});

// ---- identity
check("identity: none set", () => {
  assert.deepEqual(resolveIdentity({}), DEV_IDENTITY);
  assert.deepEqual(resolveIdentity({ name: "", publisher: " ", publisherDisplayName: "" }), DEV_IDENTITY);
  assert.equal(DEV_IDENTITY.publisher, "CN=HeyLook-Dev");
  assert.throws(() => resolveIdentity({}, { requireIdentity: true }), /not set/, "a tag run needs the identity");
});
check("identity: the Partner Center values", () => {
  assert.deepEqual(resolveIdentity(STORE, { requireIdentity: true }), { ...STORE, dev: false });
});
check("identity: partly set is an error naming what is missing", () => {
  assert.throws(() => resolveIdentity({ name: STORE.name }), /MSIX_PUBLISHER, MSIX_PUBLISHER_DISPLAY_NAME/);
  assert.throws(() => resolveIdentity({ name: STORE.name, publisher: STORE.publisher }), /MSIX_PUBLISHER_DISPLAY_NAME/);
  assert.throws(() => resolveIdentity({ publisherDisplayName: "Noamo" }), /MSIX_IDENTITY_NAME, MSIX_PUBLISHER/);
});
check("identity: odd values refused", () => {
  assert.throws(() => resolveIdentity({ ...STORE, name: "ab" }), /identity name/);
  assert.throws(() => resolveIdentity({ ...STORE, name: "has space" }), /identity name/);
  assert.throws(() => resolveIdentity({ ...STORE, name: "-lead.ing" }), /identity name/);
  assert.throws(() => resolveIdentity({ ...STORE, publisher: "FE739770" }), /CN=/);
  assert.throws(() => resolveIdentity({ ...STORE, publisher: 'CN=a"b' }), /CN=/);
  assert.throws(() => resolveIdentity({ ...STORE, publisherDisplayName: "A<B" }), /display name/);
  assert.throws(() => resolveIdentity({ ...STORE, publisherDisplayName: "x".repeat(257) }), /display name/);
});

// ---- the template
const good = fillManifest(template, { ...STORE, dev: false }, "1.0.7.0");
const expectGood = { ...STORE, version: "1.0.7.0" };
check("template: filled with the Partner Center identity it is what AC-WA.1.1 says", () => {
  assert.deepEqual(checkManifest(good, expectGood), []);
  assert.ok(good.includes(`Name="${STORE.name}"`) && good.includes(`Publisher="${STORE.publisher}"`) && good.includes(`<PublisherDisplayName>${STORE.publisherDisplayName}</PublisherDisplayName>`));
  assert.ok(good.includes('Version="1.0.7.0"') && good.includes('ProcessorArchitecture="x64"'));
});
check("template: the placeholder identity is a valid manifest too", () => {
  assert.deepEqual(checkManifest(fillManifest(template, DEV_IDENTITY, "1.0.7.0"), { name: "HeyLook.Dev", publisher: "CN=HeyLook-Dev", publisherDisplayName: "HeyLook Dev", version: "1.0.7.0" }), []);
});
check("template: the Store name (DEC-006), the product facts", () => {
  assert.equal(STORE_DISPLAY_NAME, "Hey Look! Mail Client");
  assert.equal((good.match(/Hey Look! Mail Client/g) ?? []).length >= 2, true);
  assert.ok(good.includes("<DisplayName>Hey Look! Mail Client</DisplayName>"));
  assert.ok(good.includes('<uap:VisualElements\n        DisplayName="Hey Look! Mail Client"'));
  assert.ok(good.includes('BackgroundColor="transparent"'));
  assert.ok(good.includes('EntryPoint="Windows.FullTrustApplication"') && good.includes('Executable="hey-look.exe"'));
  assert.ok(good.includes('<TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.26100.0" />'));
  assert.ok(good.includes('<uap5:StartupTask TaskId="HeyLookStartup" Enabled="false" DisplayName="Hey Look!" />'));
  assert.ok(good.includes("<uap17:UpdateWhileInUse>defer</uap17:UpdateWhileInUse>"));
  assert.deepEqual([...good.matchAll(/<Resource Language="([^"]+)"/g)].map((m) => m[1]), ["en-US", "vi", "fr", "zh-Hans", "es", "ja", "de", "ru"]);
  assert.deepEqual(LANGUAGES, ["en-US", "vi", "fr", "zh-Hans", "es", "ja", "de", "ru"]);
});
check("template: placeholders", () => {
  assert.throws(() => fillManifest("<A>{{NOPE}}</A>", DEV_IDENTITY, "1.0.7.0"), /unknown placeholder/);
  assert.deepEqual([...new Set([...template.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]))].sort(), ["NAME", "PUBLISHER", "PUBLISHER_DISPLAY_NAME", "VERSION"]);
  const esc = fillManifest(template, { name: "a.b.c", publisher: "CN=x & y", publisherDisplayName: "A & B", dev: false }, "1.0.7.0");
  assert.ok(esc.includes('Publisher="CN=x &amp; y"') && esc.includes("<PublisherDisplayName>A &amp; B</PublisherDisplayName>"));
  assert.deepEqual(checkManifest(esc, { name: "a.b.c", publisher: "CN=x & y", publisherDisplayName: "A & B", version: "1.0.7.0" }), [], "the check reads the escaped text back");
});

// every rule must be able to fail
const mutate = (label, from, to, expectProblem) =>
  check(`mutation: ${label}`, () => {
    assert.ok(good.includes(from), `the template has no '${from}'`);
    const problems = checkManifest(good.replace(from, to), expectGood);
    assert.ok(problems.some((p) => expectProblem.test(p)), `no problem matching ${expectProblem} in: ${problems.join(" | ") || "(none)"}`);
  });
mutate("the old product name in Properties", "<DisplayName>Hey Look! Mail Client</DisplayName>", "<DisplayName>Hey Look!</DisplayName>", /Properties DisplayName/);
mutate("the old product name in VisualElements", 'DisplayName="Hey Look! Mail Client"', 'DisplayName="Hey Look!"', /VisualElements DisplayName/);
mutate("a version with a 4th part", 'Version="1.0.7.0"', 'Version="1.0.7.1"', /Version/);
mutate("another architecture", 'ProcessorArchitecture="x64"', 'ProcessorArchitecture="neutral"', /ProcessorArchitecture/);
mutate("another publisher", `Publisher="${STORE.publisher}"`, 'Publisher="CN=somebody"', /Publisher is/);
mutate("another publisher display name", "<PublisherDisplayName>Noamo</PublisherDisplayName>", "<PublisherDisplayName>thnonl</PublisherDisplayName>", /PublisherDisplayName/);
mutate("no full trust", '<rescap:Capability Name="runFullTrust" />', "", /capabilities/);
mutate("an extra capability", '<rescap:Capability Name="runFullTrust" />', '<rescap:Capability Name="runFullTrust" /><Capability Name="internetClient" />', /capabilities/);
mutate("full trust without rescap", '<rescap:Capability Name="runFullTrust" />', '<Capability Name="runFullTrust" />', /rescap/);
mutate("a startup task that is on", 'Enabled="false"', 'Enabled="true"', /Enabled="false"/);
mutate("another startup task id", 'TaskId="HeyLookStartup"', 'TaskId="Other"', /startup task/);
mutate("a language less", '    <Resource Language="ru" />\n', "", /languages/);
mutate("a language more", '    <Resource Language="ru" />\n', '    <Resource Language="ru" />\n    <Resource Language="pt" />\n', /languages/);
mutate("a higher minimum Windows", 'MinVersion="10.0.17763.0"', 'MinVersion="10.0.19041.0"', /TargetDeviceFamily/);
mutate("another executable", 'Executable="hey-look.exe" EntryPoint="Windows.FullTrustApplication">', 'Executable="app.exe" EntryPoint="Windows.FullTrustApplication">', /Executable/);
mutate("no update-while-in-use", "<uap17:UpdateWhileInUse>defer</uap17:UpdateWhileInUse>", "", /UpdateWhileInUse/);
mutate("a namespace that is not ignorable", 'IgnorableNamespaces="uap uap5 uap17 rescap"', 'IgnorableNamespaces="uap uap5 rescap"', /uap17/);
mutate("a mailto / protocol registration", "    </Application>", '<Extensions><uap:Extension Category="windows.protocol"><uap:Protocol Name="mailto"/></uap:Extension></Extensions>\n    </Application>', /windows\.protocol/);
mutate("a file type association", "    </Application>", '<uap:Extension Category="windows.fileTypeAssociation" />\n    </Application>', /fileTypeAssociation/);
mutate("a logo outside Assets", "<Logo>Assets\\StoreLogo.png</Logo>", "<Logo>StoreLogo.png</Logo>", /image reference/);
mutate("another description", "<Description>Desktop mail client</Description>", "<Description>x</Description>", /Description/);

// ---- images
check("package images: three logos, five scales, the target sizes (spec A-21)", () => {
  const list = packageImages();
  const names = list.map((i) => i.file);
  assert.equal(new Set(names).size, names.length);
  const sizes = (base) => list.filter((i) => i.file.startsWith(`${base}.scale-`)).map((i) => `${i.file.match(/scale-(\d+)/)[1]}:${i.w}x${i.h}`);
  assert.deepEqual(sizes("StoreLogo"), ["100:50x50", "125:63x63", "150:75x75", "200:100x100", "400:200x200"]);
  assert.deepEqual(sizes("Square44x44Logo"), ["100:44x44", "125:55x55", "150:66x66", "200:88x88", "400:176x176"]);
  assert.deepEqual(sizes("Square150x150Logo"), ["100:150x150", "125:188x188", "150:225x225", "200:300x300", "400:600x600"]);
  for (const t of [16, 24, 32, 48, 256]) {
    for (const f of [`Square44x44Logo.targetsize-${t}.png`, `Square44x44Logo.targetsize-${t}_altform-unplated.png`]) {
      const i = list.find((x) => x.file === f);
      assert.ok(i && i.w === t && i.h === t, f);
    }
  }
  assert.equal(list.length, 25);
});
check("store listing images: exact sizes (W14.7)", () => {
  assert.deepEqual(storeLogos().map((i) => `${i.file}:${i.w}x${i.h}`), ["store-box-2160x2160.png:2160x2160", "store-box-1080x1080.png:1080x1080", "store-poster-1440x2160.png:1440x2160", "store-poster-720x1080.png:720x1080", "store-tile-300x300.png:300x300"]);
  for (const i of storeLogos()) assert.ok(i.file.includes(`${i.w}x${i.h}`), `${i.file} says its own size`);
});
check("png reader", () => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(300, 16);
  b.writeUInt32BE(150, 20);
  b[24] = 8;
  b[25] = 6;
  assert.deepEqual(pngInfo(b), { w: 300, h: 150, bitDepth: 8, colorType: 6 });
  assert.equal(pngInfo(Buffer.from("not a png")), null);
});

// ---- the subject of the throw-away certificate
check("publisherToSubject", () => {
  assert.equal(publisherToSubject(STORE.publisher), "/CN=FE739770-637C-437D-B2B9-DAA2E2EA56F1");
  assert.equal(publisherToSubject("CN=Name, O=Org, C=VN"), "/CN=Name/O=Org/C=VN");
  for (const bad of ["O=Org", "CN=a/b", 'CN="a"', "CN=", "Noamo", "CN=a=b"]) assert.throws(() => publisherToSubject(bad), /test certificate/, bad);
});

// ---- readiness.json: the app's packaged mode (WP14 part 2) flips it; then the code must be there
check("readiness.json", () => {
  const r = readReadiness();
  assert.equal(typeof r.appPackagedMode, "boolean");
  if (r.appPackagedMode) {
    // part 2 landed: the app must detect a package (GetCurrentPackageFullName, spec A-9) and keep its keyring entries apart (heylook.store, A-16)
    const src = fs.readdirSync(path.join(ROOT, "src-tauri", "src")).filter((f) => f.endsWith(".rs")).map((f) => fs.readFileSync(path.join(ROOT, "src-tauri", "src", f), "utf8")).join("\n");
    assert.ok(src.includes("GetCurrentPackageFullName"), "appPackagedMode is true but the app has no package detection (GetCurrentPackageFullName)");
    assert.ok(src.includes("heylook.store"), "appPackagedMode is true but the keyring service heylook.store is not in the app");
  }
});

// ---- the workflow wiring of WA.1
const yml = fs.readFileSync(path.join(ROOT, ".github/workflows/release.yml"), "utf8");
const block = (name) => {
  const head = `\n  ${name}:\n`;
  const at = yml.indexOf(head);
  assert.ok(at >= 0, `job ${name} not found`);
  const next = yml.slice(at + head.length).search(/\n  [a-z][\w-]*:\n/);
  return yml.slice(at, next < 0 ? undefined : at + head.length + next);
};
check("workflow: the msix job", () => {
  const b = block("msix");
  assert.match(b, /^    needs: \[plan, build\]$/m);
  assert.match(b, /^    runs-on: windows-2025-vs2026$/m);
  assert.ok(!/^    environment:/m.test(b) && !/secrets\./.test(b), "no Environment, no secret");
  assert.match(b, /^    permissions:\n      contents: read$/m);
  // identity from the three repository variables, tag runs refuse the placeholder and a tag that is not the version
  // identity: the public values of the Partner Center product (owner input 2026-10-19) are the defaults, the repository variables override them, so a tag run never fails for a missing variable
  const defaults = { MSIX_IDENTITY_NAME: STORE.name, MSIX_PUBLISHER: STORE.publisher, MSIX_PUBLISHER_DISPLAY_NAME: STORE.publisherDisplayName };
  for (const [v, d] of Object.entries(defaults)) assert.ok(b.includes(`${v}: \${{ vars.${v} || '${d}' }}`), `${v} must default to '${d}'`);
  assert.equal(STORE.name, "40278Noamo.651773BC9C4C7");
  assert.equal(STORE.publisher, "CN=FE739770-637C-437D-B2B9-DAA2E2EA56F1");
  assert.equal(STORE.publisherDisplayName, "Noamo");
  assert.ok(b.includes('if [ "$EVENT" = "push" ]; then extra+=(--require-identity --expect-version "${GITHUB_REF_NAME#v}"); fi'));
  assert.ok(b.includes("--test-sign") && b.includes("--store-logos") && b.includes("--github-output"));
  // the exe of the NSIS build, byte for byte, and the check of the package against it
  assert.ok(b.includes("name: windows-exe") && b.includes("--from msix-out/msix-build.json --exe exe/hey-look.exe"));
  // artifacts: msix-store on tag runs only, 14 days, never the GitHub release; msix-test 1 day with the public certificate only
  const store = /- name: Keep the package for Partner Center\n        if: github\.event_name == 'push'\n[\s\S]*?(?=\n      - name:|\n*$)/.exec(b)?.[0] ?? "";
  assert.ok(store.includes("msix-store") && store.includes("msix-store-NOT-READY") && store.includes("retention-days: 14") && store.includes("path: msix-out/HeyLook_*_x64.msix"), "msix-store step");
  const test = /- name: Keep the test-signed copy\n[\s\S]*$/.exec(b)?.[0] ?? "";
  assert.ok(test.includes("name: msix-test") && test.includes("retention-days: 1") && test.includes("HeyLook-test.cer") && !/\.pfx|\.key|\.pem/.test(test), "msix-test step");
  assert.ok(!/gh release|releases\//.test(b), "the package is never attached to the GitHub release");
  assert.ok(b.includes("No key in the output"));
});
check("workflow: publish does not wait for the Store package", () => {
  const b = block("publish");
  assert.match(b, /^    needs: \[[^\]]*\]$/m);
  const needs = /^    needs: \[([^\]]*)\]$/m.exec(b)[1].split(",").map((s) => s.trim());
  for (const j of ["msix", "msix-check", "store-url", "store-submit", "store-submit-exe"]) assert.ok(!needs.includes(j), `publish needs ${j}`);
});
check("workflow: msix-check", () => {
  const b = block("msix-check");
  assert.match(b, /^    runs-on: windows-2025-vs2026$/m);
  assert.match(b, /^    needs: \[msix\]$/m);
  assert.ok(!/^    environment:/m.test(b) && !/secrets\./.test(b));
  assert.ok(b.includes("shell: powershell") && b.includes("msix-check.ps1") && b.includes("name: msix-test"));
});
check("workflow: every action is pinned to a commit", () => {
  const all = [...yml.matchAll(/^\s+(?:- )?uses: ([^\s]+)/gm)].map((m) => m[1]);
  for (const u of all) assert.match(u, /@[0-9a-f]{40}$/, `${u} is not pinned`);
});

// ---- the owner steps in PACKAGING.md name what the workflow reads
check("PACKAGING.md: the owner's variables, values, artifacts and Environment", () => {
  const doc = fs.readFileSync(path.join(ROOT, "PACKAGING.md"), "utf8");
  for (const needle of [
    `\`${STORE.name}\``, `\`${STORE.publisher}\``, `\`${STORE.publisherDisplayName}\``, "gh variable set MSIX_IDENTITY_NAME", "gh variable set MSIX_PUBLISHER ", "gh variable set MSIX_PUBLISHER_DISPLAY_NAME",
    "`msix-store`", "`msix-store-NOT-READY`", "`msix-test`", "`msix-store-logos`", "`STORE_SUBMIT`", "`STORE_EXE`", "`STORE_PRODUCT_ID`", "`STORE_EXE_PRODUCT_ID`", "Environment **`store`**",
    "AZURE_AD_TENANT_ID", "AZURE_AD_APPLICATION_CLIENT_ID", "AZURE_AD_APPLICATION_SECRET", "SELLER_ID", "Hey Look! Mail Client", "runFullTrust", "private audience", "readiness.json", "WP14 part 2",
  ]) assert.ok(doc.includes(needle), `PACKAGING.md lacks ${needle}`);
  // every variable the msix jobs read is documented
  for (const v of [...new Set([...yml.matchAll(/vars\.((?:MSIX|STORE)_\w+)/g)].map((m) => m[1]))]) assert.ok(doc.includes(`\`${v}\``), `PACKAGING.md does not document the variable ${v}`);
  // and every secret of the store jobs
  for (const s of new Set([...block("store-submit").matchAll(/secrets\.(\w+)/g)].map((m) => m[1]))) assert.ok(doc.includes(s), `PACKAGING.md does not document the secret ${s}`);
});

// ---- the install check script (WA.4): it parses, and says what the spec says
const ps1 = path.join(ROOT, ".github", "scripts", "msix-check.ps1");
check("msix-check.ps1: parses (PowerShell syntax) and holds the steps of REQ-WA.4.1", () => {
  const text = fs.readFileSync(ps1, "utf8");
  for (const needle of ["Cert:\\LocalMachine\\TrustedPeople", "Add-AppxPackage", "Remove-AppxPackage", "IApplicationActivationManager", "*\\WindowsApps\\*", "LocalState\\heylook.db", "thnonl.heylook", "appcert.exe", "WACK not available on the runner", "$info.ready"]) assert.ok(text.includes(needle), `msix-check.ps1 lacks ${needle}`);
  assert.ok(!/Set-ExecutionPolicy|Enable-WindowsOptionalFeature|reg add|bcdedit|Set-MpPreference/i.test(text), "the check changes no system setting beyond trusting the throw-away certificate");
  const shells = process.platform === "win32" ? ["powershell", "pwsh"] : ["pwsh"];
  const shell = shells.find((s) => spawnSync(s, ["-NoProfile", "-Command", "exit 0"], { encoding: "utf8" }).status === 0);
  if (!shell) return; // (no PowerShell here: the text checks above are all there is)
  const r = spawnSync(shell, ["-NoProfile", "-Command", "$e = $null; $t = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:PS1_FILE, [ref]$t, [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.Message + ' at line ' + $_.Extent.StartLineNumber }; exit 1 }"], { encoding: "utf8", env: { ...process.env, PS1_FILE: ps1 } });
  assert.equal(r.status, 0, `PowerShell does not parse msix-check.ps1:\n${r.stdout}${r.stderr}`);
});
check("workflow: msix-check uses Windows PowerShell (the Appx cmdlets) and its script name", () => {
  const b = block("msix-check");
  assert.ok(b.includes("shell: powershell") && !b.includes("shell: pwsh"));
});

// ---- real pack (Windows SDK, a browser, OpenSSL)
const canBuild = process.platform === "win32" && findSdkTool("makeappx.exe") && findSdkTool("makepri.exe") && findSdkTool("signtool.exe") && findOpenssl() && (await import("./msix-assets.mjs")).findChrome();
if (!canBuild) {
  console.log(`test-msix-build: ok (${n} checks; the real pack was SKIPPED: it needs Windows, the Windows SDK, OpenSSL and Chrome or Edge)`);
} else {
  const { build } = await import("./msix-build.mjs");
  const { verify } = await import("./msix-verify.mjs");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "hl-msix-test-"));
  const exe = path.join(work, "hey-look.exe");
  fs.copyFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "notepad.exe"), exe); // a stand-in program
  await checkAsync("real: build, unpack, verify, test signature", async () => {
    const out = path.join(work, "out");
    const r = await build({ exe, out, version: "1.0.7", env: { MSIX_IDENTITY_NAME: STORE.name, MSIX_PUBLISHER: STORE.publisher, MSIX_PUBLISHER_DISPLAY_NAME: STORE.publisherDisplayName }, requireIdentity: true, testSignIt: true, withStoreLogos: true, tmp: path.join(work, "sign") });
    assert.equal(r.msixVersion, "1.0.7.0");
    assert.equal(r.identity.dev, false);
    assert.ok(fs.existsSync(path.join(out, "HeyLook_1.0.7_x64.msix")) && fs.existsSync(path.join(out, "HeyLook_1.0.7_x64_test.msix")) && fs.existsSync(path.join(out, "HeyLook-test.cer")));
    // one resources.pri with all the scales in it (no resources.scale-125.pri split)
    assert.deepEqual(fs.readdirSync(out).filter((f) => /\.pri$/.test(f)), ["resources.pri"]);
    for (const f of ["HeyLook_1.0.7_x64.msix", "HeyLook_1.0.7_x64_test.msix"]) {
      const v = verify(path.join(out, f), { ...STORE, version: "1.0.7.0", exeSha256: r.exe.sha256 }, { unpack: path.join(work, `unpack-${f}`) });
      assert.deepEqual(v.bad, [], `${f}: ${v.bad.join(" | ")}`);
    }
    // the test copy is a different file (signed), the store copy is not signed
    assert.notEqual(r.msix.sha256, r.test.sha256);
    assert.ok(r.test.bytes > r.msix.bytes);
    // the certificate: DER, subject = Publisher, code signing; and the signing folder holds no key any more
    const openssl = findOpenssl();
    const cert = spawnSync(openssl, ["x509", "-inform", "DER", "-in", path.join(out, "HeyLook-test.cer"), "-noout", "-subject", "-ext", "extendedKeyUsage,basicConstraints"], { encoding: "utf8" });
    assert.equal(cert.status, 0, cert.stderr);
    assert.match(cert.stdout, /CN\s*=\s*FE739770-637C-437D-B2B9-DAA2E2EA56F1/);
    assert.match(cert.stdout, /Code Signing/);
    assert.match(cert.stdout, /CA:FALSE/);
    assert.deepEqual(fs.existsSync(path.join(work, "sign")) ? fs.readdirSync(path.join(work, "sign")) : [], []);
    // nothing private in the output
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of walk(out)) {
      assert.ok(!/\.(pfx|key|p12|pem)$/i.test(f), `key file ${f}`);
      if (/\.(xml|json|cer)$/i.test(f) && !f.endsWith(".cer")) assert.ok(!fs.readFileSync(f, "utf8").includes("PRIVATE KEY"), `${f} holds a private key`);
    }
    // the Store listing images at their exact sizes, opaque box art and poster
    for (const i of storeLogos()) {
      const info = pngInfo(fs.readFileSync(path.join(out, "store", i.file)));
      assert.ok(info && info.w === i.w && info.h === i.h, i.file);
      assert.equal(info.colorType === 6, i.kind === "tile", `${i.file}: only the tile keeps its transparent corners`);
    }
    // the package images at their exact sizes, with transparent corners
    for (const i of packageImages()) {
      const info = pngInfo(fs.readFileSync(path.join(out, "layout", "Assets", i.file)));
      assert.ok(info && info.w === i.w && info.h === i.h && info.colorType === 6, i.file);
    }
  });
  await checkAsync("real: a dry run without the variables gets the placeholder identity, a tag run is refused", async () => {
    const r = await build({ exe, out: path.join(work, "dry"), version: "1.0.7", env: {} });
    assert.equal(r.identity.dev, true);
    await assert.rejects(() => build({ exe, out: path.join(work, "tag"), version: "1.0.7", env: {}, requireIdentity: true }), /not set/);
    assert.ok(!fs.existsSync(path.join(work, "tag", "layout")), "nothing is made before the identity is accepted");
    await assert.rejects(() => build({ exe, out: path.join(work, "dry"), version: "1.0.7", env: {} }), /not empty/, "a used output folder is not overwritten");
    await assert.rejects(() => build({ exe, out: path.join(work, "tag2"), version: "1.0.7", expectVersion: "1.0.8", env: {} }), /expected 1\.0\.8/);
  });
  console.log(`test-msix-build: ok (${n} checks, including a real pack, unpack and test signature with ${path.basename(findSdkTool("makeappx.exe"))})`);
}
