// Search in Settings (1.0.7 W8.12): the registry of every setting a person can look for, the folding of text, and the ranking. Pure (no React, no Tauri), so
// scripts/test-settings-index.mjs runs it with node. The strings are resolved with `t()` in the language in use, so the index follows the app language; it is
// built once per change of language, system, tray state, or the list of mailboxes (SettingsSearch.tsx), never per key press.
//
// Two tests keep the registry honest: scripts/test-settings-index.mjs (every Row of SettingsDialog.tsx has a registered id, every id exists, the label keys
// agree, every entry is found by its own label in the 8 languages) and scripts/test-settings-search.mjs (the rendered panels in the dev preview agree with the index).
import { t, getLang, LANGUAGES } from "./i18n/index.ts";
import type { Key } from "./i18n/index.ts";
import { providerName, serviceName } from "./calendarSync.ts";
import { filtersIntroKey, keepRunningLabelKey, startsMinimizedHint, startsMinimizedKey, trayBadgeLabelKey, trayTabTitleKey } from "./trayWords.ts";

// ------------------------------------------------------------------------------------------------ folding
/** One text after `fold`: `s` is the folded text; `from[i]` / `to[i]` are the range of the ORIGINAL text that the folded UTF-16 unit `i` stands for. */
export interface Folded {
  s: string;
  from: number[];
  to: number[];
}

const CLUSTER = /\P{M}[\p{M}ﾞﾟ]*|[\p{M}ﾞﾟ]+/gu;
const EXTRA: Record<string, string> = { "đ": "d", "ß": "ss", "ø": "o", "æ": "ae", "œ": "oe", "ł": "l", "ı": "i" };
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** The steps of D-12.4 on one cluster (a letter with its marks): NFKC, accents off (the Japanese dakuten stay), lower case, a few letters, katakana to hiragana, punctuation to spaces. */
function foldCluster(c: string): string {
  let x = c.normalize("NFKC");
  x = x.normalize("NFD").replace(/[̀-ͯ]/g, "").normalize("NFC").toLowerCase();
  x = x.normalize("NFD").replace(/[̀-ͯ]/g, "").normalize("NFC"); // (a capital I with a dot gives an i and a mark)
  x = x.replace(/[đßøæœłı]/g, (m) => EXTRA[m]);
  x = x.replace(/[ァ-ヶ]/g, (m) => String.fromCharCode(m.charCodeAt(0) - 0x60));
  return x.replace(/[^\p{L}\p{N}]/gu, " ");
}

/** `fold` with the map back to the original text (for the bold part of a result). */
export function foldMap(text: string): Folded {
  const s: string[] = [];
  const from: number[] = [];
  const to: number[] = [];
  for (const m of text.matchAll(CLUSTER)) {
    const a = m.index ?? 0;
    const b = a + m[0].length;
    for (const ch of foldCluster(m[0])) {
      for (let u = 0; u < ch.length; u++) {
        if (ch === " " && (s.length === 0 || s[s.length - 1] === " ")) continue; // no leading space, runs of spaces are one
        s.push(ch[u]);
        from.push(a);
        to.push(b);
      }
    }
  }
  while (s.length && s[s.length - 1] === " ") (s.pop(), from.pop(), to.pop()); // no trailing space
  return { s: s.join(""), from, to };
}

/** Case, accents, width, kana and punctuation do not matter: "UNDO SÉND" and "undo  send" are the same text. */
export const fold = (text: string): string => foldMap(text).s;

// ------------------------------------------------------------------------------------------------ the match rules
/** A part of a word of 1 or 2 letters is not looked for inside words (ai must not list every label that has "mail" in it); a CJK text has no words, so it always is. */
const substringOk = (w: string): boolean => w.length >= 3 || CJK.test(w);

/** Index of `w` where a word of `f` starts (any length), or -1. */
function wordStart(f: string, w: string): number {
  let i = f.indexOf(w);
  while (i >= 0) {
    if (i === 0 || f[i - 1] === " ") return i;
    i = f.indexOf(w, i + 1);
  }
  return -1;
}
/** Where the query word `w` is in the folded text `f`: anywhere when it is long enough, else at the start of a word. */
const findWord = (f: string, w: string): number => (substringOk(w) ? f.indexOf(w) : wordStart(f, w));

// ------------------------------------------------------------------------------------------------ the index
export type Os = "windows" | "macos" | "linux";

/** One mailbox as the index needs it. `cal`: the mailbox has a Calendar section (null: it has none). */
export interface IndexAccount {
  id: string;
  email: string;
  cal: null | { kind: "google" | "microsoft" } | { kind: "dav"; label: string | null };
}

export interface IndexCtx {
  os: Os;
  tray: boolean;
  /** this copy is updated by the Snap Store / apt / the Microsoft Store: no update button and no automatic check switch */
  managed: boolean;
  /** the notifications of this system have buttons: Windows always, macOS never, Linux when its notification service lists the capability (W5.4) */
  notifyButtons: boolean;
  accounts: IndexAccount[];
  /** `Ctrl+` becomes `Cmd+` on macOS (platform.ts `kbd`) */
  kbd: (label: string) => string;
}

export type EntryKind = "page" | "row" | "group";

export interface Entry {
  /** the DOM id without `set-` of the target */
  id: string;
  /** the Settings page: general, appearance, add-account, mb:all, mb:<accountId>, tray, actions, times, blocked, pgp, ai, shortcuts, about */
  tab: string;
  /** the section of a mailbox page */
  section?: string;
  /** page: the heading of a page or a section (it takes the focus itself); row: one setting; group: a setting that is not a Row (cards, the key buttons) */
  kind: EntryKind;
  label: string;
  hint: string;
  /** the terms of the keywords key, as written */
  kw: string[];
  /** the place names the search looks in (page, mailbox, section, group heading) */
  places: string[];
  /** the place names that are shown (a page has the name of its group of the navigation instead) */
  shown: string[];
  /** `shown` joined by " → " */
  line: string;
  /** the target sits inside a closed <details> that the jump opens first */
  inDetails?: boolean;
  fl: Folded;
  fh: string;
  fk: string;
  fp: string;
}

interface Def {
  id: string;
  tab: string;
  section?: string;
  kind?: EntryKind;
  label: string;
  hint?: string;
  /** the keywords key (or keys: the words of the "tray" rows come from two) */
  kw?: Key | Key[];
  /** the place names that are looked in and shown */
  path?: string[];
  /** looked in, not shown ("Mailboxes", to save width) */
  quiet?: string[];
  /** shown on the line of a page entry, which has no place names */
  lead?: string;
  inDetails?: boolean;
}

const kwTerms = (key: Key): string[] => t(key).split(/[,、，]/).map((s) => s.trim()).filter(Boolean);

/** The separator that joins the place names for a screen reader ("," for most languages, "、" for Japanese and Chinese) */
export const listSep = (): string => LANGUAGES.find((l) => l.code === getLang())?.listSep ?? ", ";

/** The mailbox sections that exist for the All accounts scope, in the order of the navigation (Profile and Server only exist for a mailbox, Calendar for one with a calendar). */
const ALL_SECTIONS: [string, Key][] = [
  ["composing", "settings.section.composing"], ["signatures", "settings.section.signatures"], ["templates", "settings.section.templates"], ["filters", "settings.section.filters"],
  ["notifications", "settings.section.notifications"], ["reading", "settings.section.reading"], ["security", "settings.section.security"], ["folders", "settings.section.folders"],
];

const RISKY: Record<Os, Key> = { windows: "errors.os.risky.windows", macos: "errors.os.risky.macos", linux: "errors.os.risky.linux" };

/** Every entry of Settings for this language, system and set of mailboxes, in the order of the navigation (this order is the tie-break of the ranking). */
export function buildIndex(ctx: IndexCtx): Entry[] {
  const out: Entry[] = [];
  const win = ctx.os === "windows";
  const mac = ctx.os === "macos";
  const add = (d: Def) => {
    const places = [...(d.quiet ?? []), ...(d.path ?? [])];
    const kw = d.kw ? ([] as Key[]).concat(d.kw).flatMap(kwTerms) : [];
    const hint = d.hint ?? "";
    const shown = (d.path ?? []).length ? d.path! : d.lead ? [d.lead] : [];
    out.push({
      id: d.id, tab: d.tab, section: d.section, kind: d.kind ?? "row", label: d.label, hint, kw, places, shown,
      line: shown.join(" → "),
      inDetails: d.inDetails,
      fl: foldMap(d.label), fh: fold(hint), fk: fold(kw.join(" ")), fp: fold(places.join(" ")),
    });
  };
  const h = (k?: Key): string | undefined => (k ? t(k) : undefined);
  const nav = { app: t("settings.nav.app"), mailboxes: t("settings.nav.mailboxes"), more: t("settings.nav.more") };
  const allAccounts = t("settings.scope.allAccounts");

  // ---- General
  const general = t("settings.general.title");
  const G = (id: string, label: Key, hint?: Key | { text: string }, group?: Key, extra: Partial<Def> = {}) =>
    add({ id, tab: "general", label: t(label), hint: hint && typeof hint === "object" ? hint.text : h(hint), path: group ? [general, t(group)] : [general], ...extra });
  add({ id: "pg-general", tab: "general", kind: "page", label: general, hint: t("settings.general.intro"), lead: nav.app });
  G("language", "settings.general.language", "settings.general.languageHint");
  G("afterAction", "settings.general.afterAction");
  G("markRead", "settings.general.markRead");
  G("undoWindow", "settings.general.undoWindow", "settings.general.undoWindowHint");
  G("defaultAccount", "settings.general.defaultAccount", "settings.general.defaultAccountHint");
  G("dateFormat", "settings.general.dateFormat");
  G("timeFormat", "settings.general.timeFormat");
  G("supportReminder", "settings.general.supportReminder", "settings.general.supportReminderHint");
  G("weekStart", "settings.general.weekStart", undefined, "settings.general.calendar");
  G("timeZone", "settings.general.timeZone", "settings.general.timeZoneHint", "settings.general.calendar");
  G("autoAddInvites", "settings.general.autoAddInvites", "settings.general.autoAddInvitesHint", "settings.general.calendar");
  G("eventReminders", "settings.general.eventReminders", "settings.general.eventRemindersHint", "settings.general.calendar");
  G("saveTo", "settings.general.saveTo", "settings.general.saveToHint", "settings.general.attachments");
  G("askWhere", "settings.general.askWhere", undefined, "settings.general.attachments");
  G("afterSaving", "settings.general.afterSaving", undefined, "settings.general.attachments");
  G("warnExec", "settings.general.warnExec", { text: t(RISKY[ctx.os]) }, "settings.general.attachments");
  G("catchUp", "settings.general.catchUp", undefined, "settings.general.scheduled");
  G("retry", "settings.general.retry", "settings.general.retryHint", "settings.general.scheduled");

  // ---- Appearance
  const appearance = t("settings.appearance.title");
  const A = (id: string, label: Key, hint?: Key, group?: Key, extra: Partial<Def> = {}) =>
    add({ id, tab: "appearance", label: t(label), hint: h(hint), path: group ? [appearance, t(group)] : [appearance], ...extra });
  add({ id: "pg-appearance", tab: "appearance", kind: "page", label: appearance, hint: t("settings.appearance.intro"), lead: nav.app });
  A("theme", "settings.appearance.theme", undefined, undefined, { kind: "group", kw: "settings.kw.theme" });
  A("accent", "settings.appearance.primary", "settings.appearance.primaryHint", undefined, { kind: "group" });
  A("density", "settings.appearance.density", undefined, undefined, { kind: "group", kw: "settings.kw.density" });
  A("readingPane", "settings.appearance.readingPane", undefined, undefined, { kind: "group" });
  A("sideMenu", "settings.appearance.sideMenuMode", "settings.appearance.sideMenuHint");
  A("preview", "settings.appearance.preview", undefined, "settings.appearance.messageList");
  A("conversations", "settings.appearance.conversations", "settings.appearance.conversationsHint", "settings.appearance.messageList");
  A("focused", "settings.appearance.focused", "settings.appearance.focusedHint", "settings.appearance.messageList");
  A("oldestOnTop", "settings.appearance.oldestOnTop", undefined, "settings.appearance.messageList");
  A("textSize", "settings.appearance.textSize", undefined, "settings.appearance.messageList", { kw: "settings.kw.textSize" });

  // ---- Mailboxes > All accounts: the page, then its sections
  const SECTIONS: Record<string, Key> = Object.fromEntries(ALL_SECTIONS);
  const sec = (k: string) => t(SECTIONS[k]);
  const quiet = [nav.mailboxes];
  add({ id: "pg-mb", tab: "mb:all", kind: "page", label: allAccounts, lead: nav.mailboxes, quiet });
  const sectionPage = (scope: "all" | IndexAccount, k: string, label: string, hint?: string, kw?: Key) =>
    add({
      id: "sec", tab: scope === "all" ? "mb:all" : `mb:${scope.id}`, section: k, kind: "page", label, hint, kw,
      path: [scope === "all" ? allAccounts : scope.email], quiet,
    });
  const S = (k: string, id: string, label: Key, hint?: Key | { text: string }, extra: Partial<Def> = {}) =>
    add({ id, tab: "mb:all", section: k, label: t(label), hint: hint && typeof hint === "object" ? hint.text : h(hint), path: [allAccounts, sec(k)], quiet, ...extra });

  sectionPage("all", "composing", sec("composing"));
  S("composing", "replyDefault", "settings.composing.replyDefault");
  S("composing", "undoSend", "settings.composing.undoSend", "settings.composing.undoSendHint", { kw: "settings.kw.undoSend" });
  S("composing", "autoCc", "settings.composing.autoCc", "settings.composing.autoCcHint");
  S("composing", "autoBcc", "settings.composing.autoBcc");
  S("composing", "signature", "settings.composing.signature", "settings.composing.signatureHint", { kw: "settings.kw.signature" });
  S("composing", "pictures", "settings.composing.pictures", "settings.composing.picturesHint");
  S("composing", "resize", "settings.composing.resize", "settings.composing.resizeHint");
  S("composing", "sigOnReply", "settings.composing.sigOnReply");
  S("composing", "popout", "settings.composing.popout", "settings.composing.popoutHint");
  S("composing", "altCheck", "settings.composing.altCheck", "settings.composing.altCheckHint");
  S("composing", "composeFont", "settings.composing.font", "settings.composing.fontHint");
  S("composing", "pasteDefault", "settings.composing.paste", { text: ctx.kbd(t("settings.composing.pasteHint")) });
  S("composing", "autoFormat", "settings.composing.autoFormat", { text: ctx.kbd(t("settings.composing.autoFormatHint")) });
  S("composing", "miniToolbar", "settings.composing.miniToolbar", "settings.composing.miniToolbarHint");
  sectionPage("all", "signatures", sec("signatures"));
  sectionPage("all", "templates", sec("templates"));
  sectionPage("all", "filters", sec("filters"), t(filtersIntroKey(ctx.tray)), "settings.kw.rules"); // (1.0.8) found by Rules, the old word Filters, "rule" and "filter" in every language
  sectionPage("all", "notifications", sec("notifications"));
  S("notifications", "notifyDesktop", "settings.notify.desktop", undefined, { kw: "settings.kw.desktopNotify" });
  S("notifications", "smartNotify", "settings.notify.smart", "settings.notify.smartHint");
  S("notifications", "notifyPreview", "settings.appearance.preview");
  S("notifications", "notifySound", "settings.notify.sound", "settings.notify.soundOnHint", { kw: "settings.kw.sound" });
  if (ctx.notifyButtons) S("notifications", "notifyButtons", "settings.notify.buttons", "settings.notify.buttonsHint");
  sectionPage("all", "reading", sec("reading"));
  S("reading", "loadRemote", "settings.reading.loadRemote", "settings.reading.loadRemoteHint", { kw: "settings.kw.loadRemote" });
  S("reading", "inlineAuto", "settings.reading.inlineAuto", "settings.reading.inlineAutoHint");
  S("reading", "fetchEvery", "settings.reading.fetchEvery", undefined, { kw: "settings.kw.fetchEvery" });
  S("reading", "push", "settings.reading.push", "settings.reading.pushHint");
  S("reading", "maxDownload", "settings.reading.maxDownload", "settings.reading.maxDownloadHint");
  sectionPage("all", "security", sec("security"));
  S("security", "pgpEncryptDefault", "settings.security.encrypt", "settings.security.encryptHint");
  S("security", "pgpSignDefault", "settings.security.sign");
  S("security", "attachKey", "settings.security.attachKey", "settings.security.attachKeyHint");
  S("security", "encryptDrafts", "settings.security.encryptDrafts", "settings.security.encryptDraftsHint");
  S("security", "importKeys", "settings.security.importKeys", "settings.security.importKeysHint");
  sectionPage("all", "folders", sec("folders"));

  // ---- Mailboxes > each mailbox (the navigation order)
  const profile = t("settings.section.profile");
  const calendarSec = t("settings.section.calendar");
  const security = t("settings.section.security");
  const server = t("settings.section.server");
  for (const a of ctx.accounts) {
    const tab = `mb:${a.id}`;
    const R = (section: string, sectionName: string, id: string, label: Key | { text: string }, hint?: Key | { text: string }) =>
      add({
        id, tab, section, label: typeof label === "object" ? label.text : t(label),
        hint: hint && typeof hint === "object" ? hint.text : h(hint),
        path: [a.email, sectionName], quiet,
      });
    add({ id: "pg-mb", tab, kind: "page", label: a.email, lead: nav.mailboxes, quiet });
    sectionPage(a, "profile", profile);
    R("profile", profile, "displayName", "settings.add.displayName", "settings.profile.displayNameHint");
    R("profile", profile, "replyTo", "settings.profile.replyTo", "settings.profile.replyToHint");
    R("profile", profile, "color", "settings.profile.color", "settings.profile.colorHint");
    if (a.cal) {
      sectionPage(a, "calendar", calendarSec);
      if (a.cal.kind === "dav" && a.cal.label === null) R("calendar", calendarSec, "calendar", "settings.calendar.davLabel", "settings.calendar.davHint");
      else {
        const provider = a.cal.kind === "dav" ? (a.cal.label as string) : providerName(a.cal.kind);
        const service = a.cal.kind === "dav" ? (a.cal.label as string) : serviceName(a.cal.kind);
        R("calendar", calendarSec, "calendar", { text: t("settings.calendar.syncWith", { provider }) }, { text: t("settings.calendar.syncHint", { service }) });
      }
    }
    R("security", security, "myKey", "settings.security.myKey", "settings.security.myKeyHint");
    sectionPage(a, "server", server);
    R("server", server, "signIn", "settings.server.signIn");
    R("server", server, "incoming", "settings.server.incoming");
    R("server", server, "newMail", "settings.server.newMail", "settings.server.newMailHint");
    R("server", server, "outgoing", "settings.server.outgoing");
    R("server", server, "removeAccount", "settings.server.removeAccount", "settings.server.removeHint");
  }

  // ---- Add account
  add({ id: "pg-add-account", tab: "add-account", kind: "page", label: t("settings.nav.addAccount"), lead: nav.mailboxes, quiet, kw: "settings.kw.addAccount" });

  // ---- More
  const trayTitle = t(trayTabTitleKey(ctx.tray, ctx.os));
  const Y = (id: string, label: Key, hint?: Key, extra: Partial<Def> = {}) => add({ id, tab: "tray", label: t(label), hint: h(hint), path: [trayTitle], ...extra });
  // (people type the word "tray" whatever the system calls the icon: a Mac says menu bar, a Linux without a tray host says nothing, D-113)
  add({ id: "pg-tray", tab: "tray", kind: "page", label: trayTitle, hint: t(win ? "settings.tray.introWindows" : "settings.tray.intro"), lead: nav.more, kw: "settings.kw.tray" });
  Y("testNotify", "settings.tray.test");
  Y("sentSound", "settings.tray.sentSound");
  Y("keepRunning", keepRunningLabelKey(ctx.os), !ctx.tray ? "settings.tray.noTray" : mac ? "settings.tray.keepRunningMac" : "settings.tray.keepRunningHint", { kw: ["settings.kw.keepRunning", "settings.kw.tray"] });
  if (ctx.tray) Y("trayBadge", trayBadgeLabelKey(ctx.os), "settings.tray.trayBadgeHint", { kw: "settings.kw.tray" });
  if (win || mac) Y("taskbarBadge", mac ? "settings.tray.dockBadge" : "settings.tray.taskbarBadge");
  Y("countOther", "settings.tray.countOther", "settings.tray.countOtherHint");
  Y("autostart", win ? "settings.tray.autostartWindows" : "settings.tray.autostart", ctx.os === "linux" && !ctx.tray ? "settings.tray.startsOpen" : startsMinimizedHint(ctx.os) ? startsMinimizedKey(ctx.os) : undefined, { kw: ["settings.kw.autostart", "settings.kw.tray"] });
  // (the row is always drawn on Windows with a tray; greyed with a hint while the start at sign-in is off)
  if (win && ctx.tray) Y("startInTray", "settings.tray.startInTray", undefined, { kw: ["settings.kw.autostart", "settings.kw.tray"] });

  const actionsTitle = t("settings.actions.title");
  add({ id: "pg-actions", tab: "actions", kind: "page", label: actionsTitle, hint: t("settings.actions.intro"), lead: nav.more });
  for (const [k, l] of [["archive", "settings.action.archive"], ["delete", "common.delete"], ["flag", "settings.action.flag"], ["pin", "settings.action.pin"], ["read", "settings.action.readUnread"], ["snooze", "settings.action.snooze"]] as [string, Key][])
    add({ id: `act-${k}`, tab: "actions", label: t(l), path: [actionsTitle] });

  const timesTitle = t("settings.times.title");
  add({ id: "pg-times", tab: "times", kind: "page", label: timesTitle, hint: t("settings.times.intro"), lead: nav.more });
  for (const k of ["evening", "tomorrow", "weekend", "nextWeek"] as const) add({ id: `snooze-${k}`, tab: "times", label: t(`settings.times.${k}`), path: [timesTitle] });

  add({ id: "pg-blocked", tab: "blocked", kind: "page", label: t("settings.blocked.title"), lead: nav.more, kw: "settings.kw.blocked" });

  const pgp = t("settings.pgp.title");
  add({ id: "pg-pgp", tab: "pgp", kind: "page", label: pgp, hint: t("settings.pgp.intro"), lead: nav.more, kw: "settings.kw.pgp" });
  add({ id: "pgpGenerate", tab: "pgp", kind: "group", label: t("settings.pgp.generate"), path: [pgp, t("settings.pgp.yourKeys")] });
  add({ id: "pgpImport", tab: "pgp", kind: "group", label: t("settings.pgp.import"), path: [pgp, t("settings.pgp.yourKeys")] });
  add({ id: "pgpOthers", tab: "pgp", kind: "group", label: t("settings.pgp.others"), path: [pgp] });
  add({ id: "pgpRemember", tab: "pgp", label: t("settings.pgp.remember"), hint: t("settings.pgp.rememberHint"), path: [pgp, t("settings.pgp.passphrases")] });
  add({ id: "pgpLockAll", tab: "pgp", label: t("settings.pgp.lockAll"), hint: t("settings.pgp.lockAllHint"), path: [pgp, t("settings.pgp.passphrases")] });

  const ai = t("settings.ai.title");
  add({ id: "pg-ai", tab: "ai", kind: "page", label: ai, hint: t("settings.ai.intro"), lead: nav.more, kw: "settings.kw.ai" });
  add({ id: "aiBaseUrl", tab: "ai", kind: "group", label: t("settings.ai.baseUrl"), path: [ai] });
  add({ id: "aiKey", tab: "ai", kind: "group", label: t("settings.ai.apiKey"), path: [ai] });
  add({ id: "aiModel", tab: "ai", kind: "group", label: t("settings.ai.model"), path: [ai] });
  // (W8.11) the model list URL sits in the closed "Advanced" of the tab: the jump opens it first
  add({ id: "aiModelsUrl", tab: "ai", kind: "group", label: t("settings.ai.modelsUrl"), hint: t("settings.ai.modelsUrlHint"), path: [ai], inDetails: true });

  add({ id: "pg-shortcuts", tab: "shortcuts", kind: "page", label: t("settings.nav.shortcuts"), lead: nav.more, hint: t("settings.keys.title") });

  const about = t("settings.about.title");
  add({ id: "pg-about", tab: "about", kind: "page", label: about, lead: nav.more });
  if (!ctx.managed) {
    add({ id: "updateCheck", tab: "about", kind: "group", label: t("updates.action.check"), path: [about] });
    add({ id: "autoCheck", tab: "about", label: t("settings.about.autoCheck"), hint: t("settings.about.autoCheckHint"), path: [about], kw: "settings.kw.autoCheck" });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the search
export interface Hit {
  entry: Entry;
  /** 1 (the label is the query) to 7 (found only with the place names); lower is better */
  tier: number;
  /** the parts of the label (ranges of the original text) that matched, for the bold letters */
  ranges: [number, number][];
}

/** The tier of an entry for a folded query (`words` = its words), 0 when it does not match. */
function tierOf(e: Entry, q: string, words: string[]): number {
  const L = e.fl.s;
  if (L === q) return 1;
  if (L.startsWith(q)) return 2;
  if (wordStart(L, q) >= 0) return 3;
  const inLabel = words.every((w) => findWord(L, w) >= 0);
  if ((substringOk(q) && L.includes(q)) || inLabel) return 4;
  const K = e.fk;
  if (words.every((w) => findWord(L, w) >= 0 || findWord(K, w) >= 0)) return 5;
  const H = e.fh;
  if (words.every((w) => findWord(L, w) >= 0 || findWord(K, w) >= 0 || findWord(H, w) >= 0)) return 6;
  const P = e.fp;
  if (words.every((w) => findWord(L, w) >= 0 || findWord(K, w) >= 0 || findWord(H, w) >= 0 || findWord(P, w) >= 0)) return 7;
  return 0;
}

/** The parts of the label that the words matched, as ranges of the original label (neighbours that touch are one range). */
function labelRanges(f: Folded, words: string[]): [number, number][] {
  const found: [number, number][] = [];
  for (const w of words) {
    const i = findWord(f.s, w);
    if (i >= 0) found.push([f.from[i], f.to[i + w.length - 1]]);
  }
  found.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const r of found) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** The entries that match `query` (all words must), best tier first, the order of the registry within a tier; at most `limit`. An empty folded query is no search. */
export function searchSettings(index: readonly Entry[], query: string, limit = 50): Hit[] {
  const q = fold(query);
  if (!q) return [];
  const words = q.split(" ");
  const hits: (Hit & { n: number })[] = [];
  index.forEach((entry, n) => {
    const tier = tierOf(entry, q, words);
    if (tier) hits.push({ entry, tier, ranges: [], n });
  });
  hits.sort((a, b) => a.tier - b.tier || a.n - b.n);
  const top = hits.slice(0, limit);
  for (const h of top) h.ranges = labelRanges(h.entry.fl, words);
  return top.map(({ entry, tier, ranges }) => ({ entry, tier, ranges }));
}

/** What a screen reader says for a result: the setting, then where it is ("Undo send, All accounts, Composing"). */
export const optionName = (e: Entry): string =>
  t("settings.search.optionName", { setting: e.label, path: e.shown.join(listSep()) });
