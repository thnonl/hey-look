// 1.0.7 W5.10 (REQ-5.10.4, REQ-5.10.5, REQ-5.10.6; DEC-017), no browser. Run: node --experimental-strip-types scripts/test-mac-notify-texts.mjs
//   - the two texts of the denied note and its button are exactly the ones agreed with the 7 specialists (spec-107-wp5 section 3.5), in 8 languages
//   - settings.tray.macUnavailable and backend.NOTIFY_MAC_UNAVAILABLE are gone from every dictionary and from every source
//   - the commands notify_permission and open_notification_settings are in the three places (handler, APP_COMMANDS, default.json and settings.json) and not in the other windows' files
//   - the page asks the backend before "Send test" on macOS only, shows the note only for `denied` on macOS, and the button opens System Settings
//   - the debug seam HEYLOOK_TEST_NOTIFY_PERMISSION is read under cfg!(debug_assertions) only
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDicts } from "./lib/i18n-dicts.mjs";

const d = await loadDicts();
const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(rootDir, p), "utf8").replace(/\r\n/g, "\n");
const CODES = ["en", "vi", "fr", "zh-Hans", "es", "ja", "de", "ru"];
const NB = " ";
const T = {
  denied: {
    en: "Notifications for Hey Look! are turned off in macOS, so banners and the Dock badge don’t appear. Turn them on in System Settings > Notifications.",
    vi: "Thông báo của Hey Look! đang bị tắt trong macOS, nên biểu ngữ và huy hiệu Dock không xuất hiện. Hãy bật chúng trong Cài đặt hệ thống > Thông báo.",
    fr: `Les notifications de Hey Look! sont désactivées dans macOS${NB}: les bannières et la pastille du Dock n’apparaissent donc pas. Activez-les dans Réglages Système > Notifications.`,
    "zh-Hans": "macOS中已关闭Hey Look!的通知，因此不会显示横幅和程序坞角标。请在“系统设置 → 通知”中开启。",
    es: "Las notificaciones de Hey Look! están desactivadas en macOS, por lo que no aparecen las tiras ni el globo del Dock. Actívalas en Ajustes del Sistema > Notificaciones.",
    ja: "macOSでHey Look!の通知がオフになっているため、バナーとDockのバッジは表示されません。システム設定の「通知」でオンにしてください。",
    de: "Mitteilungen für Hey Look! sind in macOS deaktiviert, daher werden weder Banner noch das Badge am Dock-Symbol angezeigt. Aktivieren Sie sie in den Systemeinstellungen unter „Mitteilungen“.",
    ru: "Уведомления для Hey Look! отключены в macOS, поэтому баннеры и индикатор на значке в Dock не появляются. Включите их в Системных настройках → Уведомления.",
  },
  open: {
    en: "Open System Settings", vi: "Mở Cài đặt hệ thống", fr: "Ouvrir les Réglages Système", "zh-Hans": "打开系统设置",
    es: "Abrir Ajustes del Sistema", ja: "システム設定を開く", de: "Systemeinstellungen öffnen", ru: "Открыть Системные настройки",
  },
  // 1.0.11 quiet note (alert style None): the macOS names of Notification Center and of the Banners / Alerts styles per language
  quiet: {
    en: ["Notification Center", "Banners", "Alerts"],
    vi: ["Trung tâm thông báo", "Biểu ngữ", "Cảnh báo"],
    fr: ["Centre de notifications", "Bannières", "Alertes"],
    "zh-Hans": ["通知中心", "“横幅”", "“提醒”"],
    es: ["Centro de notificaciones", "Tiras", "Alertas"],
    ja: ["通知センター", "「バナー」", "「通知パネル」"],
    de: ["Mitteilungszentrale", "„Banner“", "„Hinweise“"],
    ru: ["Центр уведомлений", "«Баннеры»", "«Предупреждения»"],
  },
};
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

for (const c of CODES) {
  check(`${c}: the agreed texts`, () => {
    assert.equal(d[c]["settings.tray.macDenied"], T.denied[c]);
    assert.equal(d[c]["settings.tray.macOpenSettings"], T.open[c]);
    assert.ok(!("settings.tray.macUnavailable" in d[c]), "macUnavailable is gone");
    assert.ok(!("backend.NOTIFY_MAC_UNAVAILABLE" in d[c]), "NOTIFY_MAC_UNAVAILABLE is gone");
    if (c !== "en") {
      assert.notEqual(d[c]["settings.tray.macDenied"], d.en["settings.tray.macDenied"]);
      assert.notEqual(d[c]["settings.tray.macOpenSettings"], d.en["settings.tray.macOpenSettings"]);
    }
  });
  check(`${c}: the quiet note uses the macOS names`, () => {
    const q = d[c]["settings.tray.macQuiet"];
    for (const term of T.quiet[c]) assert.ok(q.includes(term), `${term} in ${q}`);
    assert.ok(q.includes("Hey Look!"), q);
    assert.ok(!q.includes("Hey Look!."), "no Hey Look!. at the end");
  });
}
check("French keeps the no-break space before the colon", () => assert.ok(d.fr["settings.tray.macDenied"].includes(`macOS${NB}: `)));

// no source mentions the removed names (the Rust test for the Rust sources lives in macnotify.rs)
const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? (f === "node_modules" || f === "target" ? [] : walk(p)) : [p];
  });
check("no source or test mentions the removed names", () => {
  const here = fileURLToPath(import.meta.url);
  for (const dir of ["src", "src-tauri/src", "scripts"]) {
    for (const f of walk(path.join(rootDir, dir))) {
      if (!/\.(ts|tsx|rs|mjs|json)$/.test(f) || path.resolve(f) === path.resolve(here)) continue;
      const text = readFileSync(f, "utf8");
      assert.ok(!/macUnavailable|NOTIFY_MAC_UNAVAILABLE/.test(text), `${f} still mentions a removed name`);
    }
  }
});

check("the commands are in the three places, for the main and the settings windows only", () => {
  const lib = read("src-tauri/src/lib.rs");
  const build = read("src-tauri/build.rs");
  for (const [cmd, perm] of [["notify_permission", "allow-notify-permission"], ["open_notification_settings", "allow-open-notification-settings"]]) {
    const handler = lib.slice(lib.indexOf("tauri::generate_handler!["));
    assert.ok(new RegExp(`\\b${cmd},`).test(handler), `${cmd}: not in generate_handler!`);
    assert.ok(build.includes(`"${cmd}"`), `${cmd}: not in APP_COMMANDS`);
    for (const f of ["default.json", "settings.json"]) assert.ok(read(`src-tauri/capabilities/${f}`).includes(`"${perm}"`), `${cmd}: not in ${f}`);
    for (const f of ["popout.json", "event.json", "search.json", "scheduled.json"]) assert.ok(!read(`src-tauri/capabilities/${f}`).includes(`"${perm}"`), `${cmd}: in ${f}`);
  }
});

check("the page: Send test asks first on macOS only; the note is for denied on macOS; the button opens System Settings", () => {
  const ui = read("src/components/SettingsDialog.tsx");
  const tray = ui.slice(ui.indexOf("function TrayTab()"));
  const test = tray.slice(tray.indexOf("const test = async"), tray.indexOf("const toggleAuto"));
  assert.ok(/os === "macos"[\s\S]*notifyPermission\("sendTest"\)[\s\S]*state === "denied"[\s\S]*settings\.tray\.macDenied[\s\S]*return;[\s\S]*api\.testNotification\(\)/.test(test), test);
  assert.ok(/os === "macos" && perm === "denied"/.test(tray), "the note is for macOS and denied only");
  assert.ok(/api\.openNotificationSettings\(\)/.test(tray) && tray.includes("settings.tray.macOpenSettings"));
  assert.ok(/addEventListener\("focus", read\)/.test(tray), "the state is read again when the window gets the focus");
});

check("the seam is debug-only", () => {
  const mac = read("src-tauri/src/macnotify.rs");
  assert.ok(mac.includes('seam_from(cfg!(debug_assertions), std::env::var("HEYLOOK_TEST_NOTIFY_PERMISSION")'));
});

console.log(`test-mac-notify-texts: ok (${n} checks)`);
