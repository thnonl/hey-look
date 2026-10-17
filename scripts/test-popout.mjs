// Secondary windows ("pop-outs"), the foundation (src/popout/*, src/main.tsx): which window a page is in, the title, the dev flag, the
// rule "the setting says what a click does, Shift does the opposite", and guards on how the pieces are wired. The window manager itself is
// tested in Rust (src-tauri/src/popout.rs); the quit protocol in scripts/test-quit-flush.mjs.
// Run: node --experimental-strip-types scripts/test-popout.mjs
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { isPopout, popoutDevEnabled, popoutTitle, routeOf } from "../src/popout/route.ts";
import { opensInWindow, shiftOnly } from "../src/popout/entry.ts";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

// ---- the router: the main window has no query; a pop-out is ?w=<kind>&t=<token>; anything else mounts nothing
assert.deepEqual(routeOf(""), { kind: "main" });
assert.deepEqual(routeOf("?"), { kind: "main" });
assert.deepEqual(routeOf("?w=main"), { kind: "main" });
assert.deepEqual(routeOf("?w="), { kind: "main" });
assert.deepEqual(routeOf("?mock=1"), { kind: "main" }, "other parameters (the dev preview) do not matter");
assert.deepEqual(routeOf("?w=compose&t=abc123"), { kind: "compose", token: "abc123" });
assert.deepEqual(routeOf("?w=reader&t=zz"), { kind: "reader", token: "zz" });
assert.deepEqual(routeOf("?t=zz&w=reader"), { kind: "reader", token: "zz" }, "the order does not matter");
assert.deepEqual(routeOf("?w=compose"), { kind: "compose", token: "" }, "a missing token is the backend's to refuse (popout_init)");
assert.deepEqual(routeOf("w=compose&t=x"), { kind: "compose", token: "x" }, "also without the question mark");
// an unknown kind never mounts the app a second time
for (const bad of ["settings", "Compose", "compose-1", "main2", "../x", "reader%20"]) {
  const r = routeOf(`?w=${bad}`);
  assert.equal(r.kind, "invalid", bad);
  assert.equal(isPopout(r), false);
}
assert.equal(isPopout(routeOf("?w=compose&t=1")), true);
assert.equal(isPopout(routeOf("?w=reader&t=1")), true);
assert.equal(isPopout(routeOf("")), false);

// ---- the title (REQ-W7)
assert.equal(popoutTitle("Q4 contract call"), "Q4 contract call – Hey Look!");
assert.equal(popoutTitle("  padded  "), "padded – Hey Look!");
assert.equal(popoutTitle(""), "Hey Look!");
assert.equal(popoutTitle("   "), "Hey Look!");

// ---- the dev flag: a dev build, or the stored flag; nothing else
assert.equal(popoutDevEnabled(true, null), true);
assert.equal(popoutDevEnabled(false, "1"), true);
assert.equal(popoutDevEnabled(false, null), false);
assert.equal(popoutDevEnabled(false, "0"), false);
assert.equal(popoutDevEnabled(false, "true"), false);

// ---- the entry rule (REQ-C1, C2): the setting XOR Shift
assert.equal(opensInWindow(false, false), false, "setting off, plain click: inline");
assert.equal(opensInWindow(false, true), true, "setting off, Shift: a window");
assert.equal(opensInWindow(true, false), true, "setting on, plain click: a window");
assert.equal(opensInWindow(true, true), false, "setting on, Shift: inline (the opposite)");
const ev = (o) => ({ shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...o });
assert.equal(shiftOnly(ev({ shiftKey: true })), true);
assert.equal(shiftOnly(ev({})), false);
assert.equal(shiftOnly(ev({ shiftKey: true, ctrlKey: true })), false, "Ctrl+Shift is another shortcut");
assert.equal(shiftOnly(ev({ shiftKey: true, metaKey: true })), false);
assert.equal(shiftOnly(ev({ shiftKey: true, altKey: true })), false);

// ---- the setting: stored, default off, and nothing reads it yet (WP6b does). (prefs.ts cannot be imported by node: read its text)
{
  const prefs = read("src/prefs.ts");
  assert.ok(/popoutCompose: boolean;/.test(prefs), "the field");
  assert.ok(prefs.includes("export const DEFAULT_PREFS: Prefs = {") && /closeToTray: true,\n  popoutCompose: false,/.test(prefs), "default off");
  assert.ok(prefs.includes("...DEFAULT_PREFS,\n      ...p,"), "an older prefs blob without the field gets the default");
}
{
  const users = [];
  const walk = (dir) => {
    for (const e of readdirSync(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name) && read(p).includes("popoutCompose")) users.push(p);
    }
  };
  walk("src");
  assert.deepEqual(users.sort(), ["src/components/SettingsDialog.tsx", "src/popout/entry.ts", "src/prefs.ts"], `only the definition, the comment and the toggle mention it: ${users}`);
}
{
  const dlg = read("src/components/SettingsDialog.tsx");
  const panel = dlg.slice(dlg.indexOf("function ComposingPanel"), dlg.indexOf("function ScopedList"));
  assert.ok(panel.includes('t("settings.composing.popout")') && panel.includes('t("settings.composing.popoutHint")'), "the toggle is in Settings > Composing");
  assert.ok(panel.includes("setPrefs({ popoutCompose: v })") && panel.includes("scope === null"), "one switch for the whole app, not per mailbox");
}

// ---- the wiring
{
  const main = read("src/main.tsx");
  assert.ok(main.includes("routeOf(window.location.search)"), "the entry asks the router");
  assert.ok(main.includes('route.kind === "main" ? <App /> : <PopoutRoot route={route} />'), "a pop-out never mounts the app");
  assert.ok(main.indexOf("applySavedLanguage(api.getSetting)") < main.indexOf("ReactDOM.createRoot("), "the language is applied before the first render in every window");
  const root = read("src/popout/PopoutRoot.tsx");
  // REQ-W12 / R-3 / R-4: a pop-out handles no quit, tray, toast, update or support event and never writes the preferences
  for (const never of ['listen("flush-sends"', "confirm-quit", "tray-compose", "open-thread", "notify-reply", "app-shown", "setSetting", "setPrefs", "frontendReady", "pageState", ".init()"]) {
    assert.ok(!root.includes(never), `PopoutRoot must not use ${never}`);
  }
  assert.ok(root.includes('listen<{ writer?: string }>("prefs-changed"'), "it follows the preferences of the main page");
  // no code of the pop-out writes the preferences blob (the main page is the only writer)
  for (const f of ["route.ts", "entry.ts", "flush.ts", "open.ts", "dev.ts", "views.tsx", "PopoutRoot.tsx"]) {
    const src = read(`src/popout/${f}`);
    assert.ok(!/setSetting\(\s*["']prefs["']/.test(src) && !src.includes("useStore.getState().setPrefs"), `${f} writes the preferences`);
  }
  // the views are the place WP6b / WP6c plug in
  const views = read("src/popout/views.tsx");
  assert.ok(/export const VIEWS: Record<PopoutKind,/.test(views) && views.includes("compose: Placeholder") && views.includes("reader: Placeholder"));
  // the backend commands this page uses exist
  const api = read("src/api.ts");
  for (const c of ["popout_open", "popout_init", "popout_ready", "popout_focus", "popout_close", "popout_save_all", "popout_flush_alive", "popout_flush_dialog", "popout_flush_done"]) {
    assert.ok(api.includes(`"${c}"`), c);
  }
  // the update restart asks the secondary windows first
  const upd = read("src/updates.ts");
  assert.ok(upd.indexOf("api.popoutSaveAll()") > 0 && upd.indexOf("api.popoutSaveAll()") < upd.indexOf("if (st.compose) {"), "the windows save before the inline Compose");
}

console.log("ok - test-popout");
