// The background HTML mail is read on: the mail's original colours by default, a dark one on request. WP13g (DEC-025): in the light app theme always the original (the button only sets a
// session choice, never stored, cleared by any theme switch); in the dark app theme the stored choice, which the button changes.
// Pure logic of src/mailCanvas.ts (the full matrix of effectiveCanvas, the button, the theme-switch clearing rule) plus source checks of the pieces that use it (prefs, reading pane, sync).
// Run: node --experimental-strip-types scripts/test-mail-canvas.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { t } from "../src/i18n/index.ts";
import { canvasForTheme, DARK_CANVAS, DEFAULT_MAIL_CANVAS, effectiveCanvas, frameBaseCss, frameRootClass, pressCanvas, resolveMailCanvas, sessionAfterThemeChange, themeIsDark, themeKey, toggleMailCanvas } from "../src/mailCanvas.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

// preference resolution: original unless "dark" was stored
assert.equal(DEFAULT_MAIL_CANVAS, "original");
assert.equal(resolveMailCanvas(undefined), "original");
assert.equal(resolveMailCanvas(null), "original");
assert.equal(resolveMailCanvas("dark"), "dark");
for (const bad of ["light", "Dark", "", 1, true, {}, "original"]) assert.equal(resolveMailCanvas(bad), "original", String(bad));
assert.equal(toggleMailCanvas("original"), "dark");
assert.equal(toggleMailCanvas("dark"), "original");
assert.equal(toggleMailCanvas(toggleMailCanvas("original")), "original");

// the matrix (REQ-13.15.1/2/4): [theme dark?, stored, session] -> shown
for (const [themeDark, stored, session, want] of [
  [false, "original", null, "original"],
  [false, "dark", null, "original"], // stored dark, light app: original
  [false, "original", "dark", "dark"], // session dark in the light app
  [false, "dark", "dark", "dark"],
  [true, "original", null, "original"],
  [true, "dark", null, "dark"], // stored dark still applies in the dark app
  [true, "original", "dark", "original"], // a stray session value never shows in the dark app
  [true, "dark", "dark", "dark"],
]) assert.equal(effectiveCanvas(themeDark, stored, session), want, JSON.stringify([themeDark, stored, session]));
// a surface without a session override (the composer's preview start)
assert.equal(canvasForTheme(false, "dark"), "original");
assert.equal(canvasForTheme(false, "original"), "original");
assert.equal(canvasForTheme(true, "dark"), "dark");
assert.equal(canvasForTheme(true, "original"), "original");
// the theme: dark, or system with the OS dark; light, or system with the OS light
assert.equal(themeIsDark("dark", false), true);
assert.equal(themeIsDark("dark", true), true);
assert.equal(themeIsDark("light", true), false);
assert.equal(themeIsDark("light", false), false);
assert.equal(themeIsDark("system", true), true);
assert.equal(themeIsDark("system", false), false);
assert.equal(themeIsDark("nonsense", true), false);
// the button: dark app -> stores the other choice, nothing in the session; light app -> session on/off, nothing stored
assert.deepEqual(pressCanvas(true, "original", null), { pref: "dark" });
assert.deepEqual(pressCanvas(true, "dark", null), { pref: "original" });
assert.deepEqual(pressCanvas(false, "original", null), { session: "dark" });
assert.deepEqual(pressCanvas(false, "dark", null), { session: "dark" }, "stored dark, light app shows original: the press makes it dark for the session");
assert.deepEqual(pressCanvas(false, "original", "dark"), { session: null });
assert.deepEqual(pressCanvas(false, "dark", "dark"), { session: null });
// AC-13.15.3 / 13.15.4 as a walk: light app, press -> dark; theme to dark -> stored original; press -> stored dark; theme to light -> original; back to dark -> dark
{
  let theme = "light", os = false, stored = "original", session = null, key = themeKey(theme, os);
  const shown = () => effectiveCanvas(themeIsDark(theme, os), stored, session);
  const press = () => { const p = pressCanvas(themeIsDark(theme, os), stored, session); if (p.pref) stored = p.pref; if (p.session !== undefined) session = p.session; };
  const setTheme = (t, o = os) => { theme = t; os = o; const k = themeKey(theme, os); session = sessionAfterThemeChange(key, k, session); key = k; };
  assert.equal(shown(), "original");
  press();
  assert.equal(shown(), "dark");
  assert.equal(stored, "original", "nothing stored in the light app");
  setTheme("dark");
  assert.equal(session, null, "a switch of the theme clears the session choice");
  assert.equal(shown(), "original");
  press();
  assert.equal(stored, "dark");
  assert.equal(shown(), "dark");
  setTheme("light");
  assert.equal(shown(), "original", "AC-13.15.4: the light app shows the original whatever is stored");
  assert.equal(stored, "dark", "stored value untouched");
  setTheme("dark");
  assert.equal(shown(), "dark");
  // System: the OS flips the resolved scheme
  setTheme("system", false);
  assert.equal(shown(), "original");
  press();
  assert.equal(session, "dark");
  setTheme("system", true);
  assert.equal(session, null, "the OS going dark under System is a theme switch");
  assert.equal(shown(), "dark", "dark app: the stored dark");
  setTheme("system", false);
  assert.equal(shown(), "original");
}
// the clearing rule on its own: the same key keeps the session (an OS flip under a fixed setting), a different key clears it
assert.equal(sessionAfterThemeChange(themeKey("light", false), themeKey("light", true), "dark"), "dark", "the OS flips under the Light setting: not a theme switch");
assert.equal(sessionAfterThemeChange(themeKey("dark", true), themeKey("dark", false), "dark"), "dark");
assert.equal(sessionAfterThemeChange(themeKey("light", false), themeKey("dark", false), "dark"), null);
assert.equal(sessionAfterThemeChange(themeKey("system", false), themeKey("system", true), "dark"), null);
assert.equal(sessionAfterThemeChange(themeKey("light", false), themeKey("system", false), "dark"), null, "choosing System is a switch of the setting, also when the OS is light");
assert.equal(sessionAfterThemeChange(themeKey("light", false), themeKey("dark", true), null), null);

// the frame is built right the first time: original = plain (never hidden, nothing recoloured); dark = created dark and hidden until recoloured
assert.equal(frameRootClass("original"), "");
assert.equal(frameRootClass("dark"), ' class="hm-dark hm-pend"');
const css = frameBaseCss();
assert.match(css, /html\{--hm-fg:#242424;--hm-link:#0f6cbd;--hm-bg:#ffffff\}/, "white base for mails without a background of their own, also for plain text");
const [r, g, b] = DARK_CANVAS;
assert.ok(css.includes(`html.hm-dark{--hm-fg:#e6e6e6;--hm-link:#6cb8f6;--hm-bg:rgb(${r},${g},${b});color-scheme:dark}`), "dark base is a real colour, not the pane behind");
assert.ok(!/transparent/.test(css));
assert.ok(css.startsWith("html{") && css.indexOf("@media screen{") > 0, "the dark rules are screen only: printing keeps the original colours");
assert.ok(css.indexOf("hm-pend") > css.indexOf("@media screen"), "hiding is under the dark class only, so the original is never hidden");
assert.deepEqual(DARK_CANVAS, [27, 28, 32], "the dark theme's own surface");

// the button
assert.equal(t("reading.canvas.label"), "Message background: original / dark");

// the preference is stored with the other preferences, default original, unknown values fall back
const prefs = read("src/prefs.ts");
assert.match(prefs, /mailCanvas: MailCanvas;/);
assert.match(prefs, /mailCanvas: DEFAULT_MAIL_CANVAS,/);
assert.match(prefs, /mailCanvas: resolveMailCanvas\(p\.mailCanvas\),/);

// the reading pane: the background is effectiveCanvas of the app theme, the stored choice and the session choice (WP13g); the button is always there, the frame uses the builders
const rp = read("src/components/ReadingPane.tsx");
assert.match(rp, /const stored = useStore\(\(s\) => s\.prefs\.mailCanvas\);/);
assert.match(rp, /const session = useStore\(\(s\) => s\.mailCanvasSession\);/);
// fix38 moved the one rule into useCanvasDark() (src/openStatus.tsx), which the pane, the reader window and the status share
assert.match(rp, /const dark = useCanvasDark\(\);/);
assert.match(read("src/openStatus.tsx"), /effectiveCanvas\(themeDark, stored, session\) === "dark"/);
assert.match(rp, /pressCanvas\(themeDark, stored, session\)/);
assert.match(rp, /if \(press\.pref\) setPrefs\(\{ mailCanvas: press\.pref \}\)/);
assert.match(rp, /setSession\(press\.session\)/);
assert.ok(!/appSurface/.test(rp));
// the store holds the session choice and never writes it to the preferences; the preference object has no such key
const store = read("src/store.ts");
assert.match(store, /mailCanvasSession: null,/);
assert.match(store, /setMailCanvasSession: \(v\) => \{\n    if \(get\(\)\.mailCanvasSession !== v\) set\(\{ mailCanvasSession: v \}\);\n  \},/);
assert.ok(!/mailCanvasSession/.test(prefs), "not a preference: nothing is stored");
const setPrefsAt = store.indexOf("setPrefs: (patch) => {");
assert.ok(setPrefsAt > 0 && !/mailCanvasSession/.test(store.slice(setPrefsAt, setPrefsAt + 4000)), "setPrefs does not save it");
// the sync: a theme switch clears it (and the composer's choice) in every window; the main window tells the readers; installed once per page
const sync = read("src/mailCanvasSync.ts");
assert.match(sync, /sessionAfterThemeChange\(last, next, useStore\.getState\(\)\.mailCanvasSession\)/);
assert.match(sync, /forgetPreview\(\);/);
assert.match(sync, /onOsDarkChange\(check\)/);
assert.match(sync, /emit\(CANVAS_SESSION_EVENT, byTheme \? \{ dark: false, theme: true \} : \{ dark: s\.mailCanvasSession === "dark" \}\)/);
assert.match(read("src/main.tsx"), /installMailCanvasSync\(route\.kind === "main"\)/);
// the reader window: its own setter asks the main page; it listens to the event and asks once at start
const rb = read("src/popout/readerBridge.ts");
assert.match(rb, /setMailCanvasSession: \(v\) => \{\n      useStore\.setState\(\{ mailCanvasSession: v \}\);\n      void askMain\("canvas-session", \{ dark: v === "dark" \}\);/);
assert.match(rb, /listen<\{ dark\?: unknown; theme\?: unknown \}>\(CANVAS_SESSION_EVENT/);
assert.match(rb, /if \(e\.payload\?\.theme === true\) return;/);
assert.match(rb, /requester\s*\.ask\("canvas-session", \{\}\)/);
// the composer: its start value is the theme's (light in Light), and a theme switch puts it back
const cp = read("src/components/Compose.tsx");
assert.match(cp, /startPreview\(themeDark, prefs\.mailCanvas\)/);
assert.match(cp, /useSyncExternalStore\(onThemeSwitch, themeSwitches\)/);
assert.match(cp, /forgetPreview\(\);\n    setPv\(startPreview\(themeIsDark\(st\.prefs\.theme, osDark\(\)\), st\.prefs\.mailCanvas\)\);/);
assert.match(sync, /switches\+\+;/);
assert.match(sync, /switchListeners\.forEach\(\(f\) => f\(\)\);/);
assert.match(read("src/components/ComposeFrame.tsx"), /startPreview\(themeDark, canvas\)/);
assert.match(rp, /title=\{canvasLabel\} aria-label=\{canvasLabel\} aria-pressed=\{cv\.dark\}/);
assert.ok(!/\{cv\.appDark && \(/.test(rp), "the button is not limited to the dark theme");
assert.match(rp, /frameRootClass\(darkNow\.current \? "dark" : "original"\)/);
assert.match(rp, /\$\{frameBaseCss\(\)\}/);
assert.equal((rp.match(/setMailDark\(doc, /g) ?? []).length, 2, "recoloured in place on a toggle and once on load (the off switch is the same call)");

// WK-F7.02: the way out of hm-pend does not depend on the animation timeline alone (it stands still while the window is hidden): a timer of 1.5 s takes the class off too
assert.match(rp, /setTimeout\(\(\) => frameRef\.current\?\.contentDocument\?\.documentElement\?\.classList\.remove\("hm-pend"\), 1500\)/);
assert.match(rp, /window\.clearTimeout\(failsafe\)/);

console.log("ok - test-mail-canvas");
