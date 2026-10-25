import fs from 'node:fs';
const p = 'src/settingsIndex.ts';
let s = fs.readFileSync(p, 'utf8');
const rep = (a, b) => { if (!s.includes(a)) throw new Error('missing: ' + a); s = s.replace(a, b); };
rep("  kw?: Key;\n  /** the place names that are looked in and shown */", "  /** the keywords key (or keys: the words of the \"tray\" rows come from two) */\n  kw?: Key | Key[];\n  /** the place names that are looked in and shown */");
rep("const kw = d.kw ? kwTerms(d.kw) : [];", "const kw = d.kw ? ([] as Key[]).concat(d.kw).flatMap(kwTerms) : [];");
rep('add({ id: "pg-tray", tab: "tray", kind: "page", label: trayTitle, hint: t(win ? "settings.tray.introWindows" : "settings.tray.intro"), lead: nav.more });',
    '// (people type the word "tray" whatever the system calls the icon: a Mac says menu bar, a Linux without a tray host says nothing, D-113)\n  add({ id: "pg-tray", tab: "tray", kind: "page", label: trayTitle, hint: t(win ? "settings.tray.introWindows" : "settings.tray.intro"), lead: nav.more, kw: "settings.kw.tray" });');
rep('{ kw: "settings.kw.keepRunning" });\n  if (ctx.tray) Y("trayBadge", trayBadgeLabelKey(ctx.os), "settings.tray.trayBadgeHint");',
    '{ kw: ["settings.kw.keepRunning", "settings.kw.tray"] });\n  if (ctx.tray) Y("trayBadge", trayBadgeLabelKey(ctx.os), "settings.tray.trayBadgeHint", { kw: "settings.kw.tray" });');
rep('startsMinimizedKey(ctx.os), { kw: "settings.kw.autostart" });', 'startsMinimizedKey(ctx.os), { kw: ["settings.kw.autostart", "settings.kw.tray"] });');
fs.writeFileSync(p, s);

const vals = {
  'ns/settings.ts': ['    ', 'tray, system tray, notification area'],
  'locales/vi/settings.ts': ['  ', 'tray, system tray, khay hệ thống'],
  'locales/fr/settings.ts': ['  ', 'tray, system tray, zone de notification, systray'],
  'locales/zh-Hans/settings.ts': ['  ', 'tray, system tray, 托盘, 系统托盘, 通知区域'],
  'locales/es/settings.ts': ['  ', 'tray, system tray, bandeja del sistema, área de notificación'],
  'locales/ja/settings.ts': ['  ', 'tray, system tray, システムトレイ, タスクトレイ, 通知領域'],
  'locales/de/settings.ts': ['  ', 'tray, system tray, Infobereich, Systray'],
  'locales/ru/settings.ts': ['  ', 'tray, system tray, трей, область уведомлений'],
};
for (const [f, [ind, v]] of Object.entries(vals)) {
  const fp = 'src/i18n/' + f;
  let t = fs.readFileSync(fp, 'utf8');
  const m = t.match(/^(\s*)"settings\.kw\.autostart": .*\n/m);
  if (!m) throw new Error('no autostart kw in ' + f);
  t = t.replace(m[0], m[0] + `${m[1]}"settings.kw.tray": ${JSON.stringify(v)},\n`);
  fs.writeFileSync(fp, t);
}
