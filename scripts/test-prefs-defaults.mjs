// "Count Other (bulk) mail" is on by default (1.0.7 W13.11) in every layer, and an existing install gets it once (prefsRev 1).
//   - src/prefsRev.ts (the rule mergePrefs applies to the STORED object before it is merged with the defaults): the same cases as `prefs_rev_1_turns_count_other_on_once`
//     in db.rs; a later choice of "off" is kept; other keys are not touched; the rule is idempotent;
//   - src/prefs.ts: DEFAULT_PREFS has the setting on and the marker, and mergePrefs applies the rule to the parsed object and leaves damaged text to the defaults
//     (the end to end behaviour is in scripts/test-focus-tabs.mjs, which stores old preferences in the dev preview and starts the app);
//   - the three layers read the key with the same fallback (true): folder_infos in lib.rs, unread_count in shell.rs (a source check, so they cannot drift apart);
//   - the switch acts at once: setPrefs saves first and refreshes when the setting changes (source check on store.ts);
//   - the Appearance preview's Inbox number follows the setting.
// Run: node --experimental-strip-types scripts/test-prefs-defaults.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyPrefsRev, PREFS_REV, readFavorites, withOneInbox } from "../src/prefsRev.ts";

const ROOT = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), "utf8").replace(/\r\n/g, "\n");

// ---- the one-time change on a stored object (the same cases as the Rust test)
assert.equal(PREFS_REV, 2);
const run = (o) => {
  const p = { ...o };
  const changed = applyPrefsRev(p);
  return { p, changed };
};
{
  const a = run({ countOtherMail: false, listW: 420 });
  assert.deepEqual([a.changed, a.p.countOtherMail, a.p.prefsRev, a.p.listW], [true, true, 2, 420], "a stored false without the marker was never a choice: on, other keys kept");
  const b = run({ countOtherMail: true });
  assert.deepEqual([b.changed, b.p.countOtherMail, b.p.prefsRev], [true, true, 2], "a stored true stays on and gets the marker");
  const c = run({});
  assert.deepEqual([c.changed, c.p.countOtherMail, c.p.prefsRev], [true, true, 2], "an empty object");
  assert.equal(run({ countOtherMail: false, prefsRev: 0 }).p.countOtherMail, true, "revision 0 is below 1");
  assert.equal(run({ countOtherMail: false, prefsRev: "1" }).p.countOtherMail, true, "a marker that is not a number does not count");
  // done once: the person's own "off" is kept
  const d = run({ countOtherMail: false, prefsRev: 1 });
  assert.deepEqual([d.changed, d.p.countOtherMail, d.p.prefsRev], [true, false, 2], "rev 1: rule 1 does not run again, only the marker moves (rule 2)");
  assert.equal(run({ countOtherMail: false, prefsRev: 2 }).p.countOtherMail, false, "a later revision is left alone");
  assert.equal(run({ countOtherMail: false, prefsRev: 2 }).changed, false);
  // idempotent
  const once = run({ countOtherMail: false });
  assert.equal(run(once.p).changed, false);
  assert.equal(run({ ...once.p, countOtherMail: false }).p.countOtherMail, false, "after the switch is saved off together with the marker");
}

// ---- rule 2 (1.0.10): One Inbox is always in Favorites. The same cases as `prefs_rev_2_puts_one_inbox_back_once` in db.rs
{
  const f = (o) => run(o);
  const a = f({ prefsRev: 1, favorites: ["*|sent"] });
  assert.deepEqual([a.p.favorites, a.p.prefsRev, a.changed], [["*|inbox", "*|sent"], 2, true]);
  assert.deepEqual(f({ prefsRev: 1, favorites: [] }).p.favorites, ["*|inbox"]);
  const c = f({ prefsRev: 1, favorites: ["*|inbox", "x|sent"] });
  assert.deepEqual([c.p.favorites, c.p.prefsRev, c.changed], [["*|inbox", "x|sent"], 2, true], "present: not touched, the marker is written");
  assert.deepEqual(f({ prefsRev: 1, favorites: ["*|sent", "*|inbox"] }).p.favorites, ["*|sent", "*|inbox"], "present: not moved");
  const d = f({ prefsRev: 1 });
  assert.deepEqual(["favorites" in d.p, d.p.prefsRev, d.changed], [false, 2, true], "no list: no key is made");
  const e = f({ prefsRev: 1, favorites: "junk" });
  assert.deepEqual([e.p.favorites, e.p.prefsRev, e.changed], ["junk", 2, true], "not a list: left alone");
  const g = f({ countOtherMail: false, favorites: ["*|sent"] });
  assert.deepEqual([g.p.favorites, g.p.countOtherMail, g.p.prefsRev], [["*|inbox", "*|sent"], true, 2], "rev 0 gets both rules");
  const h = f({ prefsRev: 2, favorites: ["*|sent"] });
  assert.deepEqual([h.p.favorites, h.p.prefsRev, h.changed], [["*|sent"], 2, false], "rev 2: the rev rule does not run again");
  const i = f({ prefsRev: 3, favorites: ["*|sent"] });
  assert.deepEqual([i.p.favorites, i.p.prefsRev, i.changed], [["*|sent"], 3, false], "a later rev is untouched");
  assert.deepEqual(f({ prefsRev: 1, favorites: ["a1|inbox"] }).p.favorites, ["*|inbox", "a1|inbox"], "an account's Inbox is not One Inbox");
  // the read rule (REQ-4.5): every read, not only once
  const DEF = ["*|inbox", "*|sent", "*|drafts"];
  assert.deepEqual(readFavorites(["*|sent"], DEF), ["*|inbox", "*|sent"], "rev 2 without One Inbox: shown anyway");
  assert.deepEqual(readFavorites(["*|sent", "*|inbox"], DEF), ["*|sent", "*|inbox"], "present: the order is kept");
  assert.deepEqual(readFavorites("junk", DEF), DEF, "not a list: the defaults");
  assert.deepEqual(readFavorites(undefined, DEF), DEF, "no list: the defaults");
  assert.deepEqual(readFavorites([], DEF), ["*|inbox"]);
  assert.deepEqual(readFavorites(["*|sent", 5, null], DEF), ["*|inbox", "*|sent"], "entries that are not text are dropped");
  assert.deepEqual(withOneInbox(["*|inbox"]), ["*|inbox"]);
}

// ---- prefs.ts
const prefs = read("src/prefs.ts");
assert.match(prefs, /\n  countOtherMail: true,\n  prefsRev: PREFS_REV,\n/, "the defaults: on, with the marker");
assert.ok(!/countOtherMail: false/.test(prefs), "no default is off");
assert.match(prefs, /favorites: readFavorites\(p\.favorites, DEFAULT_PREFS\.favorites\)/, "mergePrefs reads favorites with the read rule");
const merge = prefs.slice(prefs.indexOf("export function mergePrefs"), prefs.indexOf("const UUID_LIKE"));
assert.ok(merge.indexOf("applyPrefsRev(p as Record<string, unknown>)") > 0, "mergePrefs applies the rule");
assert.ok(merge.indexOf("applyPrefsRev(") < merge.indexOf("...DEFAULT_PREFS,\n      ...p,"), "...to the stored object, before the merge with the defaults");
assert.match(merge, /Array\.isArray\(p\)\) return \{ \.\.\.DEFAULT_PREFS \}/, "a stored value that is not an object gives the defaults");
assert.match(merge, /catch \{\n    return \{ \.\.\.DEFAULT_PREFS \};/, "damaged text gives the defaults");

// ---- the layers read the same fallback
const lib = read("src-tauri/src/lib.rs");
const shell = read("src-tauri/src/shell.rs");
assert.match(lib, /p\.get\("countOtherMail"\)\.and_then\(\|v\| v\.as_bool\(\)\)\.unwrap_or\(true\)/, "folder_infos (lib.rs) reads countOtherMail with fallback true");
assert.match(shell, /pbool\(&p, "countOtherMail", true\)/, "unread_count (shell.rs) reads countOtherMail with fallback true");
assert.ok(!/pbool\(&p, "countOtherMail", false\)|"countOtherMail"\)[^\n]*unwrap_or\(false\)/.test(lib + shell), "no reader falls back to false");
const db = read("src-tauri/src/db.rs");
assert.ok(/pub fn migrate_prefs\(raw: &str\)/.test(db) && /fn prefs_rev_1_turns_count_other_on_once/.test(db), "the backend rule and its test exist");
assert.match(db, /unwrap_or\(0\);\n    if rev >= 2 \{/, "the backend rule is revision 2, like prefsRev.ts");
assert.ok(/fn prefs_rev_2_puts_one_inbox_back_once/.test(db), "the backend test of rule 2 exists");
// the migration runs at start-up, after the orphans are cleaned and BEFORE the tray is drawn (so its first number is right)
const setup = lib.slice(lib.indexOf("db::prune_orphans(&lock(&db))"));
assert.ok(setup.indexOf("db::migrate_stored_prefs") > 0 && setup.indexOf("db::migrate_stored_prefs") < setup.indexOf("shell::setup_tray"), "migrate_stored_prefs runs before setup_tray");

// ---- One Inbox is locked (REQ-4.1/4.3/4.4): the write guard sits in the shared store code, the star and the Settings switch are locked
const guard = read("src/store.ts").slice(read("src/store.ts").indexOf("setPrefs: (patch) => {"), read("src/store.ts").indexOf("const layoutKeys"));
assert.match(guard, /if \(patch\.favorites\) patch = \{ \.\.\.patch, favorites: withOneInbox\(patch\.favorites\) \};/, "setPrefs puts One Inbox back before it applies and saves");
assert.ok(guard.indexOf("withOneInbox") < guard.indexOf("const prefs = { ...before, ...patch }"), "...before the patch is applied");
const fp = read("src/components/FolderPane.tsx");
const tip = read("src/components/Tip.tsx");
assert.match(fp, /locked=\{acct === null && key === "inbox"\}/, "the star of One Inbox is locked");
assert.match(tip, /aria-disabled=\{locked \? true : undefined\}/, "aria-disabled, not disabled: it stays in the Tab order");
assert.match(tip, /if \(!locked\) onToggle\(\);/, "a click on the locked star does nothing");
assert.match(tip, /title=\{label\}/, "the title stays next to the tooltip of Tip.tsx");
const sd = read("src/components/SettingsDialog.tsx");
assert.match(sd, /disabled=\{!scope && key === "inbox"\}/, "the All accounts Inbox switch is disabled");

// ---- the switch acts at once: saved first, refreshed after
const store = read("src/store.ts");
const set = store.slice(store.indexOf("setPrefs: (patch) => {"), store.indexOf("const layoutKeys"));
assert.match(set, /const saved = api\.setSetting\("prefs"/, "the save is kept");
assert.match(set, /"countOtherMail" in patch && patch\.countOtherMail !== before\.countOtherMail\) void saved\.catch\(\(\) => undefined\)\.then\(\(\) => get\(\)\.refresh\(\)\)/, "refresh runs after the save resolved, when the setting changed");
assert.ok(set.indexOf("const saved") < set.indexOf("get().refresh()"), "save first, refresh after");

// ---- the Appearance preview follows the setting like the real side menu
const ap = read("src/components/AppearancePreview.tsx");
assert.match(ap, /th\.unread && \(prefs\.countOtherMail \|\| !prefs\.focused \|\| !th\.bulk\)/, "the preview's Inbox number counts bulk mail with the setting on");

console.log("test-prefs-defaults: ok");
