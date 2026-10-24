// 1.0.7 W5.2 (REQ-5.2.4, AC-5.2.7 static part), no browser. Run: node --experimental-strip-types scripts/test-os-theme.mjs
// One source of "the OS is dark" for every page: Windows and macOS keep the engine's media query and set no `data-theme` for System (byte for byte as before); Linux uses the backend's
// value (src-tauri/src/linuxtheme.rs) and writes the resolved theme on the root like a chosen one. System / Light / Dark x OS dark / light -> the theme that is shown.
import assert from "node:assert/strict";
import fs from "node:fs";
import { resolveSystemTheme } from "../src/osThemeLogic.ts";

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
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

check("System / Light / Dark x OS dark / light", () => {
  for (const [setting, os, want] of [
    ["system", true, "dark"], ["system", false, "light"], ["light", true, "light"], ["light", false, "light"], ["dark", true, "dark"], ["dark", false, "dark"],
  ]) assert.equal(resolveSystemTheme(setting, os), want, `${setting} with the OS ${os ? "dark" : "light"}`);
});

const os = read("src/osTheme.ts");
const store = read("src/store.ts");
check("the backend's value is used where there is one, else the media query", () => {
  assert.ok(/return backend \?\? query\(\)\?\.matches \?\? false;/.test(os), "osDark(): the backend first, then the media query");
  assert.ok(/return backend === null \? null : backend \? "dark" : "light";/.test(os), "no attribute until the backend says");
  assert.ok(os.includes('listen<{ dark?: unknown }>("os-color-scheme"') && os.includes("api.osColorScheme()"), "the event and the command");
  assert.ok(/typeof v\?\.dark === "boolean" \? v\.dark : null/.test(os) && /typeof e\.payload\?\.dark === "boolean" \? e\.payload\.dark : null/.test(os), "anything but a boolean is nothing");
});

check("applyPrefs: no data-theme for System on Windows and macOS, the resolved theme on Linux; Light and Dark as before", () => {
  const a = store.slice(store.indexOf("export function applyPrefs("));
  assert.ok(a.includes("const os = systemThemeAttribute();"));
  assert.ok(/if \(p\.theme === "system" && os === null\) root\.removeAttribute\("data-theme"\);\s*else root\.setAttribute\("data-theme", p\.theme === "system" \? \(os as string\) : p\.theme\);/.test(a), a.slice(0, 700));
  assert.ok(a.includes("JSON.stringify({ theme: p.theme, accent, os })"), "the start screen of the next start knows the scheme");
  const boot = read("public/theme-boot.js");
  assert.ok(/b\.theme === "system" && \(b\.os === "dark" \|\| b\.os === "light"\)/.test(boot), "theme-boot.js uses it for System");
});

check("every reader of the OS scheme uses the one source", () => {
  for (const f of ["src/useAppDark.ts", "src/components/AppearancePreview.tsx", "src/popout/PopoutRoot.tsx"]) {
    assert.ok(!/matchMedia\([^)]*prefers-color-scheme/.test(read(f)), `${f} asks the engine directly`);
  }
  assert.ok(read("src/useAppDark.ts").includes("onOsDarkChange(on)") && read("src/components/AppearancePreview.tsx").includes("useAppDark()"));
  assert.ok(read("src/popout/PopoutRoot.tsx").includes("const dark = osDark();") && read("src/popout/PopoutRoot.tsx").includes("return onOsDarkChange(askFrameTheme);"));
  const main = read("src/main.tsx");
  assert.ok(main.includes("void onOsDarkChange(() => applyPrefs(useStore.getState().prefs));") && main.includes("startOsTheme()"), "a change of the OS scheme applies the preferences again, in every window");
  assert.ok(/\/Linux\/\.test\(navigator\.userAgent\)/.test(main) && main.includes("setTimeout(r, 1200)"), "only Linux waits for the first answer, at most 1.2 s");
});

check("the command and the event are in the three places and every window kind may ask", () => {
  assert.ok(read("src-tauri/build.rs").includes('"os_color_scheme"'));
  assert.ok(/tauri::generate_handler!\[[\s\S]*\bos_color_scheme,/.test(read("src-tauri/src/lib.rs")));
  for (const f of ["default", "settings", "popout", "event", "search", "scheduled"]) assert.ok(read(`src-tauri/capabilities/${f}.json`).includes('"allow-os-color-scheme"'), f);
  const lt = read("src-tauri/src/linuxtheme.rs");
  assert.ok(lt.includes('app.emit("os-color-scheme"'));
});

console.log(`test-os-theme: ok (${n} checks)`);
