// 1.0.7 W5.8 (REQ-5.8.1, REQ-5.8.2; AC-5.8.1 static part, AC-5.8.4 static part), no browser. Run: node scripts/test-nsis-languages.mjs
//   - tauri.conf.json: the 8 languages, English first (the fallback), no language selector in the release config, a custom file for each of the 7 others
//   - every file in src-tauri/nsis/languages/: UTF-8 WITHOUT a byte order mark (Tauri runs makensis with -INPUTCHARSET UTF8; a BOM before the first line is read as part of a command and aborts the build), exactly the 27 ids of Tauri's English file, each once, with ${LANG_<its own language>}, the quotes balanced, the placeholders
//     ($R4, ${PRODUCTNAME}, ${VERSION}, $\n) intact, the text in its own script (not English), no replacement character
//   - the corrections agreed with the language specialists (spec-107-wp5 section 3.2) are in, and the typos of Tauri's files are out (`unbekannt`, "déja", "continer", "nhấn Next", ...)
//   - the .msi stays English (no WiX language setting), the release workflow still expects one setup.exe and one .msi
import assert from "node:assert/strict";
import fs from "node:fs";
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

const IDS = ["addOrReinstall", "alreadyInstalled", "alreadyInstalledLong", "appRunning", "appRunningOkKill", "chooseMaintenanceOption", "choowHowToInstall", "createDesktop", "dontUninstall", "dontUninstallDowngrade", "failedToKillApp", "installingWebview2", "newerVersionInstalled", "older", "olderOrUnknownVersionInstalled", "silentDowngrades", "unableToUninstall", "uninstallApp", "uninstallBeforeInstalling", "unknown", "webview2AbortError", "webview2DownloadError", "webview2DownloadSuccess", "webview2Downloading", "webview2InstallError", "webview2InstallSuccess", "deleteAppData"];
const LANGS = { Vietnamese: ["VIETNAMESE", /[ạảãàáâấầẩẫậăắằẳẵặẹẻẽèéêếềểễệỉịọỏõòóôốồổỗộơớờởỡợụủũùúưứừửữựỳỷỹýđ]/i], French: ["FRENCH", /[éèêàçùûô]/i], SimpChinese: ["SIMPCHINESE", /[一-鿿]/], Spanish: ["SPANISH", /[áéíóúñ]/i], Japanese: ["JAPANESE", /[぀-ヿ一-鿿]/], German: ["GERMAN", /[äöüß]/i], Russian: ["RUSSIAN", /[Ѐ-ӿ]/] };

const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
const nsis = conf.bundle.windows.nsis;

check("the 8 languages, English first, no selector, a custom file for each of the others", () => {
  assert.deepEqual(nsis.languages, ["English", "Vietnamese", "French", "SimpChinese", "Spanish", "Japanese", "German", "Russian"]);
  assert.equal(nsis.displayLanguageSelector, false, "the release installer follows the Windows display language, it does not ask");
  assert.deepEqual(Object.keys(nsis.customLanguageFiles).sort(), Object.keys(LANGS).sort(), "English uses Tauri's own file");
  for (const [name, file] of Object.entries(nsis.customLanguageFiles)) {
    assert.equal(file, `nsis/languages/${name}.nsh`);
    assert.ok(fs.existsSync(path.join(root, "src-tauri", file)), `${file} is missing`);
  }
  assert.equal(nsis.installerHooks, "nsis/hooks.nsh", "the hooks of W14.4 stay");
  assert.deepEqual(fs.readdirSync(path.join(root, "src-tauri/nsis/languages")).sort(), Object.keys(LANGS).map((k) => `${k}.nsh`).sort(), "no other file in the folder");
  const noUpdater = JSON.parse(read("src-tauri/tauri.no-updater.conf.json"));
  assert.ok(!noUpdater.bundle?.windows?.nsis, "the other config does not change the installer languages");
  assert.ok(!JSON.parse(read("src-tauri/tauri.store-exe.conf.json")).bundle.windows.nsis, "the Store's offline installer does not either");
});

const texts = {};
// (the English texts that the translations must not still be, by id)
const texts_en = { addOrReinstall: "Add/Reinstall components", alreadyInstalled: "Already Installed", createDesktop: "Create desktop shortcut", deleteAppData: "Delete the application data", uninstallApp: "Uninstall ${PRODUCTNAME}" };
for (const [name, [key, script]] of Object.entries(LANGS)) {
  const bytes = fs.readFileSync(path.join(root, `src-tauri/nsis/languages/${name}.nsh`));
  const src = bytes.toString("utf8");
  const map = {};
  check(`${name}: 27 ids, no BOM, own language, balanced quotes, the placeholders`, () => {
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "no byte order mark: makensis -INPUTCHARSET UTF8 would read it as part of the first command");
    assert.ok(bytes.subarray(0, 1)[0] === 0x3b, "the first line is a comment");
    assert.ok(!src.includes("�"), "a replacement character: the text was damaged");
    const lines = src.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() && !l.startsWith(";"));
    assert.equal(lines.length, 27);
    for (const l of lines) {
      const m = /^LangString (\w+) \$\{LANG_([A-Z]+)\} "(.*)"$/.exec(l);
      assert.ok(m, `not a LangString line: ${l}`);
      assert.equal(m[2], key, `${m[1]} is for another language`);
      assert.ok(!(m[1] in map), `${m[1]} twice`);
      assert.ok(!/(^|[^$])"/.test(m[3]), `${m[1]}: an unescaped quote`);
      assert.ok(!m[3].includes("{{") && !m[3].includes("}}"), `${m[1]}: a handlebars name (a custom file is not rendered by Tauri; \${PRODUCTNAME} is)`);
      map[m[1]] = m[3];
    }
    assert.deepEqual(Object.keys(map).sort(), [...IDS].sort(), "the ids of Tauri's English file, no other");
    assert.ok(!("unbekannt" in map));
    // the placeholders of the English text are in the translation, and only those
    for (const id of ["alreadyInstalledLong", "appRunning", "appRunningOkKill", "choowHowToInstall", "failedToKillApp", "newerVersionInstalled", "olderOrUnknownVersionInstalled", "uninstallApp"]) {
      assert.ok(map[id].includes("${PRODUCTNAME}"), `${id}: no \${PRODUCTNAME}`);
    }
    assert.ok(map.alreadyInstalledLong.includes("${VERSION}"), "alreadyInstalledLong: no ${VERSION}");
    assert.ok(map.olderOrUnknownVersionInstalled.includes("$R4"), "$R4 (older or unknown) is in the text");
    assert.ok(map.silentDowngrades.endsWith("$\\n"), "the line break of the silent-downgrade text");
    assert.ok(map.appRunningOkKill.includes("$\\n"), "the line break of the question");
    const own = Object.values(map).filter((v) => script.test(v)).length;
    assert.ok(own >= 10, `only ${own} of 27 texts are in ${name} script: the file is English or damaged`);
    for (const [id, v] of Object.entries(map)) assert.ok(id === "unknown" || id === "older" || v !== texts_en[id], `${id} is still the English text`);
  });
  texts[name] = map;
}

check("the corrections of spec-107-wp5 section 3.2", () => {
  const t = texts;
  // Vietnamese
  assert.equal(t.Vietnamese.createDesktop, "Tạo lối tắt trên màn hình nền");
  assert.ok(t.Vietnamese.silentDowngrades.startsWith("Trình cài đặt này không cho phép hạ cấp nên không thể tiếp tục ở chế độ cài đặt im lặng."));
  assert.equal(t.Vietnamese.dontUninstallDowngrade, "Không gỡ cài đặt (Trình cài đặt này không cho phép hạ cấp nếu không gỡ cài đặt trước)");
  for (const id of ["alreadyInstalledLong", "newerVersionInstalled", "olderOrUnknownVersionInstalled"]) assert.ok(t.Vietnamese[id].includes("nhấn Tiếp") && !t.Vietnamese[id].includes("nhấn Next"), id);
  // French
  assert.equal(t.French.alreadyInstalled, "Déjà installé.");
  for (const id of ["alreadyInstalledLong", "newerVersionInstalled"]) assert.ok(t.French[id].includes("déjà") && !/déja\b/.test(t.French[id]), id);
  assert.ok(t.French.newerVersionInstalled.includes("continuer") && !t.French.newerVersionInstalled.includes("continer"));
  assert.equal(t.French.older, "ancienne");
  assert.equal(t.French.unknown, "inconnue");
  assert.ok(t.French.olderOrUnknownVersionInstalled.startsWith("Une version $R4 de"));
  assert.equal(t.French.webview2AbortError, "L'installation de WebView2 a échoué ! L'application ne peut pas s'exécuter sans WebView2. Veuillez essayer de redémarrer l'installation.");
  // Simplified Chinese
  assert.equal(t.SimpChinese.older, "较旧");
  assert.equal(t.SimpChinese.olderOrUnknownVersionInstalled, "系统中已安装 $R4版本的 ${PRODUCTNAME}。推荐先卸载当前版本后再进行安装。选择你想要执行的操作后点击下一步以继续。");
  assert.equal(t.SimpChinese.silentDowngrades, "降级操作在此安装程序上已禁用，无法进行静默安装，请使用图形界面安装程序。$\\n");
  // Spanish
  assert.equal(t.Spanish.dontUninstallDowngrade, "No desinstalar (instalar una versión anterior sin desinstalar está deshabilitado en este instalador)");
  assert.equal(t.Spanish.silentDowngrades, "Instalar una versión anterior está deshabilitado en este instalador. No se puede continuar con la instalación silenciosa; use el instalador con interfaz gráfica.$\\n");
  assert.equal(t.Spanish.deleteAppData, "Eliminar los datos de la aplicación");
  assert.equal(t.Spanish.webview2AbortError, "No se ha podido instalar WebView2. La aplicación no puede funcionar sin él. Intente reiniciar el instalador.");
  // Japanese
  assert.equal(t.Japanese.older, "古い");
  assert.equal(t.Japanese.unknown, "不明な");
  assert.ok(t.Japanese.olderOrUnknownVersionInstalled.startsWith("お使いのシステムには、${PRODUCTNAME} の$R4バージョンがインストールされています。") && t.Japanese.olderOrUnknownVersionInstalled.endsWith("「次へ」をクリックして続行します。"));
  assert.equal(t.Japanese.silentDowngrades, "このインストーラーではダウングレードできません。サイレントインストールは続行できないため、代わりにグラフィカルインストーラーを使用してください。$\\n");
  // German
  assert.equal(t.German.failedToKillApp, "${PRODUCTNAME} konnte nicht beendet werden. Bitte schließen Sie es zuerst und versuchen Sie es dann erneut.");
  assert.equal(t.German.unableToUninstall, "Deinstallation nicht möglich!");
  assert.equal(t.German.older, "ältere");
  assert.equal(t.German.unknown, "unbekannte");
  assert.equal(t.German.appRunningOkKill, "${PRODUCTNAME} läuft!$\\nKlicken Sie auf OK, um es zu beenden.");
  assert.equal(t.German.uninstallApp, "${PRODUCTNAME} deinstallieren");
  assert.equal(t.German.installingWebview2, "WebView2 wird installiert …");
  assert.equal(t.German.deleteAppData, "Anwendungsdaten löschen");
  assert.equal(t.German.webview2Downloading, "WebView2-Bootstrapper wird heruntergeladen …");
  assert.equal(t.German.dontUninstallDowngrade, "Nicht deinstallieren (Ein Downgrade ohne Deinstallation ist mit diesem Installationsprogramm nicht möglich)");
  assert.equal(t.German.silentDowngrades, "Downgrades sind mit diesem Installationsprogramm nicht möglich. Eine automatische Installation ist deshalb nicht möglich. Bitte verwenden Sie stattdessen das Installationsprogramm mit grafischer Oberfläche.$\\n");
  // Russian
  assert.equal(t.Russian.appRunningOkKill, "${PRODUCTNAME} запущен!$\\nНажмите OK, чтобы закрыть приложение");
  for (const id of ["alreadyInstalledLong", "newerVersionInstalled", "olderOrUnknownVersionInstalled"]) assert.ok(t.Russian[id].includes("выполнить, и нажмите «Далее»") && !t.Russian[id].includes("выполнить и нажмите Далее"), id);
});

check("what is not changed on purpose (the specialists called it acceptable)", () => {
  assert.ok(texts.SimpChinese.alreadyInstalledLong.includes("你"), "zh-Hans keeps Tauri's 你");
  assert.ok(texts.German.webview2DownloadSuccess.length > 5 && texts.German.webview2InstallError.length > 5);
});

check("the .msi stays English and the pipeline still expects one setup.exe and one .msi", () => {
  assert.ok(!JSON.stringify(conf.bundle.windows).includes("wix"), "no WiX language in the config");
  const wf = read(".github/workflows/release.yml");
  assert.ok(/bundle\/nsis\/\*-setup\.exe src-tauri\/target\/release\/bundle\/msi\/\*\.msi/.test(wf), "release.yml copies one setup.exe and one .msi");
});

console.log(`test-nsis-languages: ok (${n} checks)`);
