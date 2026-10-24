// The identity and hygiene of the Windows installers (WP14 W14.4, AC-14.4.6: the static hooks test). Run: node scripts/test-installer-identity.mjs
//   - tauri.conf.json: the publisher "thnonl" (what Add/Remove Programs and the exe's details show; never "Hey Look!" itself), the copyright, the homepage, the descriptions, the licence;
//     Cargo.toml says the same author; the NSIS hooks file is wired in (bundle.windows.nsis.installerHooks) and exists; nothing else of bundle.windows is set (WebView2 stays the
//     setup's download: only the Store configuration of option B has the offline mode)
//   - src-tauri/nsis/hooks.nsh: the four macros of Tauri's template and what each may do (silent install: no new desktop shortcut; "Delete the application data" ticked and not an update:
//     the app removes the saved credentials; not an update: the installer's registry key goes), and nothing that touches user data without the tick
//   - the flag of the hook is the flag of the app (src/credwipe.rs), and every variable and macro the hooks use is in the template of the Tauri CLI of this checkout (read from the
//     CLI's binary; skipped when node_modules has no CLI)
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8").replace(/\r\n/g, "\n");
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

const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
const hooks = read("src-tauri/nsis/hooks.nsh");

check("bundle identity", () => {
  const b = conf.bundle;
  assert.equal(b.publisher, "thnonl");
  assert.notEqual(b.publisher, conf.productName, "the publisher must differ from the product name");
  assert.equal(b.copyright, "© 2026 thnonl");
  assert.equal(b.homepage, "https://heylook.namthai.site/");
  assert.equal(b.shortDescription, "Fast, private desktop mail client");
  assert.equal(b.longDescription, "Hey Look! is a free, open-source desktop mail client for Google, Microsoft, iCloud, Yahoo and any IMAP/SMTP mailbox.");
  assert.equal(b.license, "MIT");
  assert.match(read("src-tauri/Cargo.toml"), /^authors = \["thnonl"\]$/m);
});
check("the hooks are wired in and nothing else of bundle.windows is set", () => {
  assert.deepEqual(conf.bundle.windows, { nsis: { installerHooks: "nsis/hooks.nsh" } });
  assert.ok(existsSync(path.join(root, "src-tauri", conf.bundle.windows.nsis.installerHooks)));
  // the Store's offline installer (option B) is the one place that sets the WebView2 mode
  assert.equal(JSON.parse(read("src-tauri/tauri.store-exe.conf.json")).bundle.windows.webviewInstallMode.type, "offlineInstaller");
});

const macro = (name) => {
  const m = new RegExp(`!macro ${name}\\n([\\s\\S]*?)!macroend`).exec(hooks);
  assert.ok(m, `macro ${name}`);
  return m[1];
};
check("the four macros of the template, and only those", () => {
  const names = [...hooks.matchAll(/^!macro (\w+)/gm)].map((m) => m[1]).sort();
  assert.deepEqual(names, ["NSIS_HOOK_POSTINSTALL", "NSIS_HOOK_POSTUNINSTALL", "NSIS_HOOK_PREINSTALL", "NSIS_HOOK_PREUNINSTALL"]);
});
check("a. a silent fresh install makes no new desktop shortcut", () => {
  const pre = macro("NSIS_HOOK_PREINSTALL");
  assert.ok(pre.includes('${FileExists} "$DESKTOP\\${PRODUCTNAME}.lnk"') && pre.includes("StrCpy $HeyLookHadDesktopLink 1"), "it looks first whether the shortcut is there");
  const post = macro("NSIS_HOOK_POSTINSTALL");
  assert.ok(post.includes("${If} ${Silent}") && post.includes("${AndIf} $UpdateMode <> 1") && post.includes("${AndIf} $HeyLookHadDesktopLink = 0"), "only silent, not an update, and not there before");
  assert.ok(post.includes('Delete "$DESKTOP\\${PRODUCTNAME}.lnk"'));
  assert.equal((post.match(/Delete /g) ?? []).length, 1, "it deletes nothing else");
  assert.ok(hooks.includes("Var HeyLookHadDesktopLink"));
});
check("b. the credentials go only with the tick, never on an update", () => {
  const pre = macro("NSIS_HOOK_PREUNINSTALL");
  assert.ok(pre.includes("${If} $DeleteAppDataCheckboxState = 1") && pre.includes("${AndIf} $UpdateMode <> 1"));
  assert.ok(pre.includes("ExecWait '\"$INSTDIR\\${MAINBINARYNAME}.exe\" --remove-saved-credentials'"));
  // the call sits inside the If: nothing runs before it
  const ifAt = pre.indexOf("${If}");
  assert.ok(ifAt >= 0 && ifAt < pre.indexOf("ExecWait") && pre.indexOf("ExecWait") < pre.indexOf("${EndIf}"));
});
check("c. an uninstall that is not an update removes the installer's registry key", () => {
  const post = macro("NSIS_HOOK_POSTUNINSTALL");
  assert.ok(post.includes("${If} $UpdateMode <> 1") && post.includes('DeleteRegKey HKCU "${MANUPRODUCTKEY}"') && post.includes('DeleteRegKey /ifempty HKCU "${MANUKEY}"'));
  assert.ok(!/RMDir|\$APPDATA|\$LOCALAPPDATA|DeleteRegValue/.test(hooks.replace(/^;.*$/gm, "")), "the hooks never touch the person's data (the template does, with the tick)");
});
check("the flag of the hook is the flag of the app", () => {
  const rs = read("src-tauri/src/credwipe.rs");
  assert.match(rs, /pub const FLAG: &str = "--remove-saved-credentials";/);
  assert.ok(read("src-tauri/src/lib.rs").includes("credwipe::wanted"));
});

// the variables and macros the hooks use exist in the template that this checkout's Tauri CLI uses
const cli = path.join(root, "node_modules", "@tauri-apps", "cli-win32-x64-msvc", "cli.win32-x64-msvc.node");
if (!existsSync(cli)) {
  console.log(`test-installer-identity: ok (${n} checks; the template check was SKIPPED: no Windows Tauri CLI in node_modules)`);
} else {
  check("every NSIS name the hooks use is in the template of the CLI", () => {
    const bin = readFileSync(cli);
    const start = bin.indexOf(Buffer.from("NSIS_HOOK_PREINSTALL"));
    assert.ok(start > 0, "the template is in the CLI binary");
    const from = bin.lastIndexOf(Buffer.from("Unicode true"), start);
    let to = start;
    while (bin[to] !== 0 && to < start + 120000) to++;
    const tpl = bin.subarray(from, to).toString("latin1");
    for (const word of ["NSIS_HOOK_PREINSTALL", "NSIS_HOOK_POSTINSTALL", "NSIS_HOOK_PREUNINSTALL", "NSIS_HOOK_POSTUNINSTALL", "DeleteAppDataCheckboxState", "UpdateMode", "MANUPRODUCTKEY", "MANUKEY", "MAINBINARYNAME", "PRODUCTNAME", "CreateOrUpdateDesktopShortcut", "installer_hooks"]) {
      assert.ok(tpl.includes(word), `the template of the Tauri CLI has no ${word}`);
    }
    // the order the hooks rely on: the pre-uninstall hook runs before the program file is deleted, the post-install hook after the desktop shortcut was made
    const at = (s) => tpl.indexOf(s);
    assert.ok(at("!insertmacro NSIS_HOOK_PREUNINSTALL") < at("Delete \"$INSTDIR\\${MAINBINARYNAME}.exe\"") || at("Delete \"$INSTDIR\\${MAINBINARYNAME}.exe\"") < 0, "PREUNINSTALL runs before the program file goes");
    assert.ok(at("Call CreateOrUpdateDesktopShortcut") < at("!insertmacro NSIS_HOOK_POSTINSTALL"), "POSTINSTALL runs after the desktop shortcut was made");
  });
  console.log(`test-installer-identity: ok (${n} checks)`);
}
if (!existsSync(cli)) process.exitCode = 0;
