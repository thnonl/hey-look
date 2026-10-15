// The command list of the website demo (docs/index.html and the seven translated index pages, attribute `data-cmds`) and the few texts of
// docs/assets/i18n/<code>.js that quote the app must say exactly what the app says in the same language (src/i18n, `app.cmd.*`, folder
// names, `mail.done.*`, Settings tab names). The list is kept by hand per page, so this test is what stops it drifting from the app again.
// Run: node --experimental-strip-types scripts/test-site-commands.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { loadDicts } from "./lib/i18n-dicts.mjs";
import { LANGS } from "./generate-site-languages.mjs";

const docs = fileURLToPath(new URL("../docs/", import.meta.url));
const storyJs = fs.readFileSync(path.join(docs, "assets/story.js"), "utf8");
const errors = [];
const fail = (where, msg) => errors.push(`${where}: ${msg}`);
const dicts = await loadDicts();

/** The app's command bar, in the order src/components/CommandBar.tsx lists it for a signed-in account with a conversation open. */
const FOLDERS = ["inbox", "unread", "starred", "pinned", "snoozed", "scheduled", "sent", "drafts", "archive", "junk", "trash"];
const ORDER = [
  "app.cmd.newMail", "app.cmd.syncNow", "app.cmd.newEvent", "app.cmd.goCalendar", "app.cmd.goMail",
  "app.cmd.calMonth", "app.cmd.calWeek", "app.cmd.calAgenda", "app.cmd.openSettings", "app.cmd.checkUpdates", "app.cmd.sweep",
  "app.cmd.themeLight", "app.cmd.themeDark", "app.cmd.themeSystem",
  "app.cmd.toggleReadingPane", "app.cmd.toggleConversations", "app.cmd.toggleFocused",
  ...FOLDERS.map((f) => ["app.cmd.goToFolder", `settings.folder.${f}`]),
  "app.cmd.archive", "app.cmd.delete", "app.cmd.markUnread", "app.cmd.flag", "app.cmd.pin", "app.cmd.showAll",
];

// the positions the demo script (story.js) gives a name to must be the same number as the app's list
const ids = /CMD_IDS\s*=\s*\[([^\]]*)\]/.exec(storyJs)?.[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")).filter(Boolean) ?? [];
if (ids.length !== ORDER.length) fail("docs/assets/story.js", `CMD_IDS has ${ids.length} commands, the app list in this test has ${ORDER.length}`);

const decode = (s) => s.replace(/&nbsp;/g, " ").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const str = (dict, key, where) => {
  const v = dict?.[key];
  if (typeof v !== "string") { fail(where, `the app dictionary has no plain text ${key}`); return ""; }
  return v;
};
const fill = (s, p) => s.replace(/\{(\w+)\}/g, (m, k) => (k in p ? p[k] : m));

// docs/assets/i18n/<code>.js assigns window.HL_I18N[code] = {...}
function siteDict(dir, code) {
  const file = path.join(docs, "assets/i18n", `${dir || "en"}.js`);
  const ctx = { window: { HL_I18N: {} } };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), ctx, { filename: file });
  return ctx.window.HL_I18N[dir || "en"] ?? ctx.window.HL_I18N[code] ?? {};
}

for (const l of LANGS) {
  const reg = l.hreflang; // registry code: en, vi, fr, zh-Hans, es, ja, de, ru
  const app = dicts[reg];
  const where = `${l.dir || "en"}/index.html`;
  if (!app) { fail(where, `no app dictionary for ${reg}`); continue; }
  const page = fs.readFileSync(path.join(docs, l.dir, "index.html"), "utf8");
  const raw = /\sdata-cmds='([^']*)'/.exec(page) ?? /\sdata-cmds="([^"]*)"/.exec(page);
  if (!raw) { fail(where, "no data-cmds attribute"); continue; }
  let list;
  try { list = JSON.parse(decode(raw[1])); } catch (e) { fail(where, `data-cmds is not JSON: ${e.message}`); continue; }
  const want = ORDER.map((k) => (Array.isArray(k) ? fill(str(app, k[0], where), { folder: str(app, k[1], where) }) : str(app, k, where)));
  if (list.length !== want.length) fail(where, `data-cmds has ${list.length} commands, the app has ${want.length} in this list`);
  for (let i = 0; i < want.length; i++) {
    if (list[i] !== want[i]) fail(where, `command ${i + 1} (${Array.isArray(ORDER[i]) ? ORDER[i][1] : ORDER[i]}): site "${list[i]}" but the app says "${want[i]}"`);
  }

  // the texts of the site dictionary that quote the app
  const site = siteDict(l.dir, l.code);
  const sw = `assets/i18n/${l.dir || "en"}.js`;
  const quote = (key, needle, label) => {
    const v = site[key];
    if (typeof v !== "string") return fail(sw, `no ${key}`);
    if (!v.includes(needle)) fail(sw, `${key} must quote the app's ${label} "${needle}": ${v}`);
  };
  // "Moved to Deleted Items" / "Archived" / "Moved to Junk": the confirmations of the app
  for (const [key, appKey] of [["story.archived", "mail.done.archived"], ["story.deleted", "mail.done.trashed"], ["story.junk", "mail.done.junk"]]) {
    const a = str(app, appKey, sw);
    const strip = (s) => s.replace(/[.。]$/, "");
    if (typeof site[key] === "string" && strip(site[key]) !== strip(a)) fail(sw, `${key} is "${site[key]}" but the app (${appKey}) says "${a}"`);
  }
  quote("story.cmd_deleted", strip0(str(app, "mail.done.trashed", sw)), "mail.done.trashed");
  quote("story.cmd_archived", strip0(str(app, "mail.done.archived", sw)), "mail.done.archived");
  // "Settings, More, Customize times": the names of the Settings group and tab
  for (const key of ["story.snz_custom", "story.snz_custom_say"]) {
    quote(key, str(app, "settings.nav.more", sw), "settings.nav.more");
    quote(key, str(app, "settings.times.title", sw), "settings.times.title");
  }
}
function strip0(s) { return s.replace(/[.。]$/, ""); }

if (errors.length) {
  console.error(`site commands: ${errors.length} problem(s)\n  ` + errors.join("\n  "));
  process.exit(1);
}
console.log(`ok - test-site-commands (${LANGS.length} languages, ${ORDER.length} commands each)`);
