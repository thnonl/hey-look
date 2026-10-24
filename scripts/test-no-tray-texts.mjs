// 1.0.7 W5.6 (REQ-5.6.1, REQ-5.6.2), no browser. Run: node --experimental-strip-types scripts/test-no-tray-texts.mjs
// The five places that talk about the tray pick the no-tray text when `shell_info.tray` is false, the menu-bar text on a Mac, and the old text otherwise; every key exists in all 8 languages.
import assert from "node:assert/strict";
import fs from "node:fs";
import { filtersIntroKey, quitKeepKey, scheduleKeepKey, trayTabTitleKey, welcomeKeepKey } from "../src/trayWords.ts";

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
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

check("Welcome", () => {
  assert.equal(welcomeKeepKey("linux", false), "app.welcome.point.noTray");
  assert.equal(welcomeKeepKey("linux", true), "app.welcome.point.tray");
  assert.equal(welcomeKeepKey("windows", true), "app.welcome.point.tray");
  assert.equal(welcomeKeepKey("macos", true), "app.welcome.point.menuBar");
  assert.equal(welcomeKeepKey("macos", false), "app.welcome.point.menuBar", "a Mac always has its menu bar");
  assert.equal(welcomeKeepKey("windows"), "app.welcome.point.tray", "tray defaults to true");
});
check("the quit question", () => {
  assert.equal(quitKeepKey("linux", false), "app.quit.keepOpen");
  assert.equal(quitKeepKey("linux", true), "app.quit.keepRunning");
  assert.equal(quitKeepKey("windows"), "app.quit.keepRunning");
  assert.equal(quitKeepKey("macos"), "app.quit.keepRunningMac");
});
check("the Send later picker: no link without a tray, the old ones otherwise", () => {
  assert.equal(scheduleKeepKey("linux", false), null);
  assert.equal(scheduleKeepKey("linux", true), "compose.schedule.keepInTray");
  assert.equal(scheduleKeepKey("macos"), "compose.schedule.keepInMenuBar");
});
check("Settings: the Filters intro and the tab title", () => {
  assert.equal(filtersIntroKey(false), "settings.filters.introNoTray");
  assert.equal(filtersIntroKey(true), "settings.filters.intro");
  assert.equal(filtersIntroKey(), "settings.filters.intro");
  assert.equal(trayTabTitleKey(false), "settings.tray.titleNoTray");
  assert.equal(trayTabTitleKey(true), "settings.tray.title");
});
check("the pages use these functions (no key is written in the page any more)", () => {
  assert.match(read("src/components/Welcome.tsx"), /t\(welcomeKeepKey\(osNow\(\), tray\)\)/);
  assert.doesNotMatch(read("src/components/Welcome.tsx"), /app\.welcome\.point\.tray/);
  assert.match(read("src/App.tsx"), /quitKeepKey\(osNow\(\), usePlatform\.getState\(\)\.tray\)/);
  const sp = read("src/components/SchedulePicker.tsx");
  assert.match(sp, /const keepKey = scheduleKeepKey\(osNow\(\), usePlatform\(\(s\) => s\.tray\)\)/);
  assert.match(sp, /\{keepKey && \(/, "no link without a key");
  assert.match(sp, /t\("compose\.schedule\.quitWarning"\)/, "the warning sentence stays");
  const sd = read("src/components/SettingsDialog.tsx");
  assert.match(sd, /t\(filtersIntroKey\(tray\)\)/);
  assert.match(sd, /<h3>\{t\(trayTabTitleKey\(tray\)\)\}<\/h3>/);
  assert.match(sd, /item\(k, t\(k === "tray" \? trayTabTitleKey\(trayHost\) : l\)\)/);
  // the disabled keep-running row keeps its own texts (the one place that names the tray on purpose)
  assert.match(sd, /t\("settings\.tray\.noTray"\)/);
});
check("every new key is in all 8 languages", () => {
  const files = { app: ["app.welcome.point.menuBar", "app.welcome.point.noTray", "app.quit.keepOpen"], settings: ["settings.filters.introNoTray", "settings.tray.titleNoTray", "settings.notify.noButtonsDesktop"] };
  const langs = ["ns", ...["vi", "fr", "zh-Hans", "es", "ja", "de", "ru"].map((l) => `locales/${l}`)];
  for (const [area, keys] of Object.entries(files)) {
    for (const l of langs) {
      const src = read(`src/i18n/${l}/${area}.ts`);
      for (const k of keys) assert.ok(new RegExp(`"${k.replace(/\./g, "\\.")}": "[^"]{4,}"`).test(src), `${l}/${area}: ${k}`);
    }
  }
});

console.log(`ok - test-no-tray-texts (${n} checks)`);
