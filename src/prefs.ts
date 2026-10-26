import { isLang, t } from "./i18n/index.ts";
import type { Key, LangPref } from "./i18n/index.ts";
import { pruneOrder } from "./accountOrder";
import { folderLabel, ROLE_LABELS } from "./folderLabel";
import { applyPrefsRev, PREFS_REV } from "./prefsRev";
import { DEFAULT_MAIL_CANVAS, MailCanvas, resolveMailCanvas } from "./mailCanvas";
import { DEFAULT_HIGHLIGHT, normColor } from "./editor/colors";
import { DEFAULT_FONT_NAME, DEFAULT_FONT_SIZE } from "./editor/fonts";
import { cleanRecentEmoji } from "./editor/recentEmoji";
import { cleanRecent } from "./recentSearches";
import { DEFAULT_NUDGE, NudgeState, normalizeNudge } from "./supportNudge";
import { normalizeSidebar, SidebarMode } from "./sidebarState";
import { blend, buttonAccent, luminance, ratio } from "./topBarLight";
export { buttonAccent, topBar, type TopBarColors } from "./topBarLight";
import { type NotifySound, normNotifySound } from "./notifySound";
export type { NotifySound };
/** The labels are dictionary keys: show them with t() while rendering, so they follow the language. */
export const NOTIFY_ACTIONS: [string, Key][] = [
  ["none", "common.none"], ["archive", "settings.action.archive"], ["delete", "common.delete"], ["read", "settings.action.read"], ["flag", "settings.action.flag"], ["reply", "settings.action.reply"], ["snooze", "settings.action.snoozeTomorrow"],
];

/**
 * Settings that exist once for "All accounts" and can be overridden per account.
 * A value in `Prefs.accountPrefs[accountId]` wins over the "All accounts" value; a missing key means "inherit".
 */
export interface Overridable {
  notifications: boolean;
  smartNotifications: boolean;
  notifyPreview: boolean;
  notifySound: NotifySound;
  notifyActions: string[]; // up to 3 toast buttons
  autoCc: string;
  autoBcc: string;
  /** "" = automatic (default of the scope), "none" = no signature, otherwise a signature id */
  signatureId: string;
  signatureOnReply: boolean;
  replyDefault: "reply" | "replyAll";
  undoSeconds: number;
  loadRemote: boolean;
  syncMinutes: number;
  /** keep the Inbox connection open and get new mail at once (IMAP IDLE) when the server supports it */
  pushMail: boolean;
  /** pasted / dropped pictures go into the message ("inline") or are attached */
  inlinePictures: "inline" | "attach";
  /** resize pictures over 1 MB silently when inserting them */
  autoResizePictures: boolean;
  /** ask before a message goes out with a picture that has no alt text (REQ-51; off by default) */
  altCheck: boolean;
  /** receiving: inline pictures up to this size per picture are loaded with the message (0 = always) */
  inlineAutoLoadMB: 2 | 5 | 0;
  /** PGP: "possible" = Encrypt starts on only when every recipient has a key; "always" never turns itself off */
  pgpEncrypt: "never" | "possible" | "always";
  pgpSign: boolean;
  /** attach the public key to signed / encrypted messages (lets recipients reply encrypted) */
  pgpAttachKey: boolean;
  /** drafts of encrypted messages are encrypted to your own key on the server */
  pgpEncryptDrafts: boolean;
  /** keys attached to received mail */
  pgpImportFromMail: "ask" | "auto" | "never";
}

export interface Prefs extends Overridable {
  /** UI language: en (the default, also for an unset or unknown value), vi or fr; "en-XA" is the pseudo-locale of dev builds. The OS language is not used. */
  language: LangPref;
  theme: "system" | "light" | "dark";
  /** the background HTML mail is read on: as the sender designed it, or dark (reading pane button) */
  mailCanvas: MailCanvas;
  /** the font a new message, a reply and a forward start in (Settings > Composing > Default font): a font name of editor/fonts.ts and a size in pt */
  composeFontName: string;
  composeFontSize: number;
  /** font colours used lately, newest first (the "Recent colors" of the Font color menu; the first is what the button applies), and the last highlight colour */
  recentColors: string[];
  highlightColor: string;
  /** the emoji used lately, newest first, at most 16 (Insert > Emoji > Recently used; shared by the message and the signature / template editors) */
  recentEmoji: string[];
  /** what Ctrl+V does with text copied from other programs (Settings > Composing > When pasting from other apps): keep its formatting, take the format around it, or text only */
  pasteDefault: "source" | "merge" | "text";
  /** AutoFormat as you type in the rich editors: typographic quotes, dashes, ellipsis, arrows, (c) (r) (tm); Ctrl+Z right after a change undoes it (Settings > Composing, W3.2) */
  autoFormat: boolean;
  /** the mini toolbar (Bold, Italic, Underline, colours, Link) above text selected with the mouse (Settings > Composing, W3.3) */
  miniToolbar: boolean;
  /** primary (accent) color, #rrggbb */
  accent: string;
  density: "full" | "medium" | "compact";
  readingPane: "right" | "bottom";
  conversations: boolean; // organize by thread
  focused: boolean; // Focused / Other tabs
  preview: boolean;
  sortAsc: boolean;
  dateFormat: "relative" | "absolute";
  timeFormat: "24" | "12";
  fontSize: number;
  afterAction: "next" | "previous" | "list";
  markReadDelay: number; // seconds, -1 = never auto-mark as read
  undoActionSeconds: number; // Undo window for archive / delete / junk
  sentSound: boolean;
  closeToTray: boolean;
  /** open new messages, replies and forwards in a separate window (Shift on the click / key does the opposite); stored only until the compose window exists (WP6b), see popout/entry.ts */
  popoutCompose: boolean;
  /** Save folder for attachments; null = the system Downloads folder */
  downloadDir: string | null;
  /** ask for a location on every Save */
  askWhereToSave: boolean;
  /** what happens after a successful Save */
  afterSave: "notify" | "reveal" | "open";
  /** confirm before opening programs and scripts */
  warnExecutables: boolean;
  /** how long an unlocked PGP key stays unlocked: "session" = until the app quits (memory only) */
  pgpRemember: "never" | "session";
  /** scheduled messages whose time passed while the app was closed: send them, or ask first */
  scheduledCatchUp: "send" | "ask";
  /** retry network failures of scheduled messages 3 times, 5 minutes apart */
  retryScheduled: boolean;
  /** ask GitHub for a newer version when the app starts (once the last attempt is 5 minutes old) or when the window comes back from the tray (once the last attempt is 2 hours old); 15 minutes after a failed attempt (STARTUP_GAP_SECS, EVERY_SECS, RETRY_SECS in update.rs) */
  checkUpdates: boolean;
  /** version the user chose to skip in the update notice ("" = none) */
  skippedUpdate: string;
  /** the occasional "support the project" toast: the switch (Settings > General) and its schedule; stays on this computer (see supportNudge.ts) */
  supportNudge: NudgeState;
  /** most messages kept per mailbox by the background download and "load older" (all its folders together; also a plain setting `max_download`) */
  maxDownload: number;
  /** calendar: first day of the week (1 = Monday, 0 = Sunday, 6 = Saturday) */
  weekStart: 1 | 0 | 6;
  /** calendar: "auto" = this computer's zone, or an IANA zone id */
  calTz: string;
  /** add invitations to the calendar when they arrive (the answer shows as "Not responded") */
  autoAddInvites: boolean;
  /** desktop reminder before events, in minutes; null = none */
  eventReminderMin: number | null;
  lastModule: "mail" | "calendar";
  calView: "month" | "week" | "agenda";
  calShowDeclined: boolean;
  /** the calendar new events go to ("" = My events): the last synced calendar the person chose, while it still exists */
  calDefaultCalendar: string;
  trayBadge: "number" | "dot" | "off"; // unread badge on the tray icon
  taskbarBadge: "number" | "off"; // unread badge on the taskbar button
  countOtherMail: boolean; // include "Other" (bulk) mail in unread counts
  /** the last one-time preference change applied to the stored copy (see the comment at DEFAULT_PREFS) */
  prefsRev: number;
  recentSearches: string[];
  defaultAccount: string; // "" = first account
  /** account ids in the order the person arranged them (empty = the order the backend gives, i.e. the order they were added); see accountOrder.ts */
  accountOrder: string[];
  snoozeTimes: { evening: number; tomorrow: number; weekend: number; nextWeek: number }; // hour of day
  hoverActions: string[]; // archive | delete | flag | pin | read | snooze
  favorites: string[]; // "<accountId|*>|<folder key>"
  collapsed: Record<string, boolean>; // folder pane groups
  folderW: number; // pane widths in px
  listW: number;
  /** the side menu (folder pane): "auto" folds it to icons in a narrow window, "expanded" / "collapsed" are the person's own choice and win over the width; see sidebarState.ts */
  sidebar: SidebarMode;
  accountPrefs: Record<string, Partial<Overridable>>;
}

/**
 * `prefsRev` counts one-time changes of stored preferences, for a default that changes in a later version. The whole object is saved on
 * every change, so a stored value is almost never a choice, and a new default would never reach an existing install. A stored `prefs`
 * below the current revision gets the change once (`mergePrefs` here, `migrate_prefs` in db.rs for the stored copy at start-up), then
 * `prefsRev` is saved with it and the person's own choice is kept from then on. The rules and the newest revision are in prefsRev.ts
 * (1: "Count Other (bulk) mail" is on); a new change goes there and in `migrate_prefs` (db.rs), with a case in both tests.
 */
export const DEFAULT_PREFS: Prefs = {
  language: "en",
  theme: "system",
  mailCanvas: DEFAULT_MAIL_CANVAS,
  composeFontName: DEFAULT_FONT_NAME,
  composeFontSize: DEFAULT_FONT_SIZE,
  recentColors: [],
  highlightColor: DEFAULT_HIGHLIGHT,
  recentEmoji: [],
  pasteDefault: "source",
  autoFormat: true,
  miniToolbar: true,
  accent: "#0f6cbd",
  density: "full",
  readingPane: "right",
  conversations: true,
  focused: true,
  preview: true,
  sortAsc: false,
  dateFormat: "relative",
  timeFormat: "24",
  fontSize: 14,
  afterAction: "next",
  markReadDelay: 0,
  undoActionSeconds: 6,
  sentSound: true,
  closeToTray: true,
  popoutCompose: false,
  downloadDir: null,
  askWhereToSave: false,
  afterSave: "notify",
  warnExecutables: true,
  scheduledCatchUp: "send",
  retryScheduled: true,
  checkUpdates: true,
  skippedUpdate: "",
  supportNudge: DEFAULT_NUDGE,
  maxDownload: 2000,
  pgpRemember: "session",
  weekStart: 1,
  calTz: "auto",
  autoAddInvites: true,
  eventReminderMin: 15,
  lastModule: "mail",
  calView: "month",
  calShowDeclined: false,
  calDefaultCalendar: "",
  trayBadge: "number",
  taskbarBadge: "number",
  countOtherMail: true,
  prefsRev: PREFS_REV,
  recentSearches: [],
  defaultAccount: "",
  accountOrder: [],
  snoozeTimes: { evening: 18, tomorrow: 8, weekend: 9, nextWeek: 8 },
  hoverActions: ["archive", "delete", "flag", "pin"],
  favorites: ["*|inbox", "*|sent", "*|drafts"],
  collapsed: {},
  folderW: 248,
  listW: 392,
  sidebar: "auto",
  accountPrefs: {},
  // overridable (these are the "All accounts" values)
  notifications: true,
  smartNotifications: true,
  notifyPreview: true,
  notifySound: "pop",
  notifyActions: ["archive", "delete", "read"],
  autoCc: "",
  autoBcc: "",
  signatureId: "",
  signatureOnReply: true,
  replyDefault: "reply",
  undoSeconds: 10,
  loadRemote: false,
  syncMinutes: 2,
  pushMail: true,
  inlinePictures: "inline",
  autoResizePictures: false,
  altCheck: false,
  inlineAutoLoadMB: 2,
  pgpEncrypt: "possible",
  pgpSign: false,
  pgpAttachKey: true,
  pgpEncryptDrafts: true,
  pgpImportFromMail: "ask",
};

/** Effective value: the account's own override if it has one, otherwise the "All accounts" value. */
export function eff<K extends keyof Overridable>(prefs: Prefs, accountId: string | null | undefined, key: K): Prefs[K] {
  const own = accountId ? prefs.accountPrefs[accountId]?.[key] : undefined;
  return (own !== undefined ? own : prefs[key]) as Prefs[K];
}

export function isOverridden(prefs: Prefs, accountId: string | null | undefined, key: keyof Overridable): boolean {
  return !!accountId && prefs.accountPrefs[accountId]?.[key] !== undefined;
}

export const MAX_DOWNLOAD_PRESETS = [500, 1000, 2000, 5000];
/** Same bounds as the backend (`max_download` in lib.rs): anything else falls back to the default, a stored value above the maximum counts as the maximum. */
export function clampMaxDownload(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_PREFS.maxDownload;
  return Math.min(5000, Math.max(100, Math.trunc(n)));
}

export function mergePrefs(raw: string | null): Prefs {
  if (!raw) return { ...DEFAULT_PREFS };
  try {
    const p = JSON.parse(raw) as Partial<Prefs> & { showUnreadCount?: boolean };
    if (!p || typeof p !== "object" || Array.isArray(p)) return { ...DEFAULT_PREFS };
    // one-time changes (see DEFAULT_PREFS), decided on the stored object before it is merged with the defaults
    applyPrefsRev(p as Record<string, unknown>);
    // older versions had a single on/off switch for both badges
    if (p.showUnreadCount === false) {
      p.trayBadge ??= "off";
      p.taskbarBadge ??= "off";
    }
    // older per-account shape: { autoCc, autoBcc, signatureId, notify, sound } where "" meant "not set"
    const accountPrefs: Record<string, Partial<Overridable>> = {};
    for (const [id, old] of Object.entries(p.accountPrefs ?? {})) {
      const n: Record<string, unknown> = { ...(old as Record<string, unknown>) };
      if ("notify" in n) {
        n.notifications = n.notify;
        delete n.notify;
      }
      if ("sound" in n) {
        n.notifySound = n.sound;
        delete n.sound;
      }
      for (const k of ["autoCc", "autoBcc", "signatureId", "notifySound"]) if (n[k] === "") delete n[k];
      // (W13.8) the old sound choices: Silent stays off, every other one is on
      if ("notifySound" in n) n.notifySound = normNotifySound(n.notifySound);
      accountPrefs[id] = n as Partial<Overridable>;
    }
    return {
      ...DEFAULT_PREFS,
      ...p,
      maxDownload: clampMaxDownload(p.maxDownload),
      mailCanvas: resolveMailCanvas(p.mailCanvas),
      composeFontName: typeof p.composeFontName === "string" && p.composeFontName.trim() ? p.composeFontName.trim().slice(0, 60) : DEFAULT_FONT_NAME,
      composeFontSize: typeof p.composeFontSize === "number" && p.composeFontSize >= 6 && p.composeFontSize <= 96 ? p.composeFontSize : DEFAULT_FONT_SIZE,
      recentColors: Array.isArray(p.recentColors) ? p.recentColors.filter((c): c is string => typeof c === "string" && /^#[0-9A-F]{6}$/.test(normColor(c))).slice(0, 10) : [],
      recentEmoji: cleanRecentEmoji(p.recentEmoji),
      recentSearches: cleanRecent(p.recentSearches),
      notifySound: normNotifySound(p.notifySound),
      pasteDefault: p.pasteDefault === "merge" || p.pasteDefault === "text" ? p.pasteDefault : "source",
      autoFormat: typeof p.autoFormat === "boolean" ? p.autoFormat : true,
      miniToolbar: typeof p.miniToolbar === "boolean" ? p.miniToolbar : true,
      highlightColor: typeof p.highlightColor === "string" && /^#[0-9A-F]{6}$/.test(normColor(p.highlightColor)) ? normColor(p.highlightColor) : DEFAULT_HIGHLIGHT,
      // English unless the person chose another language (an unknown or older value counts as English)
      language: isLang(p.language) || p.language === "en-XA" ? p.language : "en",
      accountPrefs,
      sidebar: normalizeSidebar(p.sidebar),
      accountOrder: Array.isArray(p.accountOrder) ? p.accountOrder.filter((x): x is string => typeof x === "string") : [],
      supportNudge: normalizeNudge(p.supportNudge),
      snoozeTimes: { ...DEFAULT_PREFS.snoozeTimes, ...(p.snoozeTimes ?? {}) },
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The preferences that still refer to an account that exists: a removed account's default, overrides, favorites and
 *  collapsed groups are dropped. Returns the keys that changed (empty = nothing to clean). The backend does the same
 *  for the stored copy (`clean_prefs` in db.rs) when the app starts and when an account is removed. */
export function staleAccountPrefs(prefs: Prefs, accountIds: string[]): Partial<Prefs> {
  const known = new Set(accountIds);
  const out: Partial<Prefs> = {};
  if (prefs.defaultAccount && !known.has(prefs.defaultAccount)) out.defaultAccount = "";
  const ap = Object.entries(prefs.accountPrefs ?? {});
  if (ap.some(([id]) => !known.has(id))) out.accountPrefs = Object.fromEntries(ap.filter(([id]) => known.has(id)));
  const favs = (prefs.favorites ?? []).filter((f) => {
    const acct = f.split("|")[0];
    return acct === "*" || known.has(acct);
  });
  if (favs.length !== (prefs.favorites ?? []).length) out.favorites = favs;
  const order = pruneOrder(prefs.accountOrder ?? [], accountIds);
  if (order) out.accountOrder = order;
  const col = Object.entries(prefs.collapsed ?? {});
  if (col.some(([k]) => UUID_LIKE.test(k) && !known.has(k))) out.collapsed = Object.fromEntries(col.filter(([k]) => !UUID_LIKE.test(k) || known.has(k)));
  return out;
}

export { folderLabel, folderLabelIn } from "./folderLabel";

/**
 * The name of a folder in a list of folders (Move to...): a folder of the person under another one is "Parent / Child", so two folders called "2026" in different parents can be told apart.
 * (a folder's own `label` comes from the backend; `folderLabel` is the fallback for data without it)
 */
export function folderTitle(f: { key: string; name: string; label?: string; parent?: string | null; accountId?: string }, all: readonly { key: string; name: string; label?: string; accountId?: string }[]): string {
  if (ROLE_LABELS[f.key]) return t(ROLE_LABELS[f.key]);
  const own = f.label ?? folderLabel(f.key, f.name);
  const p = f.parent ? all.find((x) => x.key === f.parent && x.accountId === f.accountId) : undefined;
  return p ? `${p.label ?? folderLabel(p.key, p.name)} / ${own}` : own;
}

/** Folder nesting depth for custom folders ("Projects/Hey Look" = 1). */
export function folderDepth(key: string, name?: string): number {
  if (ROLE_LABELS[key]) return 0;
  const n = name ?? key.replace(/^f:/, "");
  return Math.max(0, n.split(/[/.]/).length - 1);
}

export const ACCENT_PRESETS: [string, Key][] = [
  ["#0f6cbd", "settings.accent.blue"], ["#0e7c86", "settings.accent.teal"], ["#1a7f4b", "settings.accent.green"], ["#6d4aff", "settings.accent.violet"],
  ["#c2327d", "settings.accent.rose"], ["#c4570c", "settings.accent.orange"], ["#475569", "settings.accent.slate"],
];

/** Readable text color on top of `hex` (the accent as a button background). */
export function readableOn(hex: string): string {
  // pick whichever of near-black / white has the higher WCAG contrast (they tie at luminance ~0.19)
  return luminance(hex) > 0.19 ? "#0b1220" : "#ffffff";
}
/** The accent as it appears in dark mode (lightened 40%), and the text color that goes on it. */
export function lightened(hex: string, amount = 0.4): string {
  const n = parseInt(hex.slice(1), 16);
  const m = (v: number) => Math.round(v * (1 - amount) + 255 * amount).toString(16).padStart(2, "0");
  return `#${m((n >> 16) & 255)}${m((n >> 8) & 255)}${m(n & 255)}`;
}
const SURFACES = { light: ["#ffffff", "#f6f7f9", "#eceef2"], dark: ["#1b1c20", "#232429", "#2d2f36"] };
/**
 * The accent as TEXT / link colour (--accent-text): keeps the hue, but darkens it (light theme) or lightens it (dark theme)
 * until it reads at >= 4.5:1 on the app surfaces and on the accent-tinted selection background. --accent itself stays the brand colour.
 */
export function accentText(accent: string, dark: boolean): string {
  const bg = SURFACES[dark ? "dark" : "light"];
  const base = dark ? lightened(accent) : accent;
  const soft = blend(bg[0], base, dark ? 0.14 : 0.12);
  const surfaces = [...bg, soft];
  for (let t = 0; t <= 1.0001; t += 0.02) {
    const c = blend(base, dark ? "#ffffff" : "#000000", t);
    if (surfaces.every((s) => ratio(c, s) >= 4.55)) return c;
  }
  return dark ? "#ffffff" : "#000000";
}
export const validHex = (v: string) => /^#[0-9a-fA-F]{6}$/.test(v);

// ---- mailbox (account) colors: ONE resolver for every place that shows one -------------------------------------------------
/** Curated mailbox colors (distinct hues, >= 3:1 as a flat mark on white and on the dark surface). Same list as db.rs. */
export const ACCOUNT_PALETTE = [
  "#0f6cbd", "#ca5010", "#13803c", "#8764b8", "#d13438", "#038387", "#e3008c", "#b8860b", "#5c7e9e", "#6b8e23",
];
const HEX6 = /^#[0-9a-f]{6}$/i;
/**
 * The colour of a mailbox: its stored colour, or - for an account that has none yet (before the one-time migration has stored it) -
 * the colour it was shown in until now, the primary colour. Always a #rrggbb string, so it works for dots, avatars and <input type=color>.
 */
export function accountColor(a: { color?: string | null } | null | undefined, accent: string): string {
  const c = a?.color?.trim();
  if (c && HEX6.test(c)) return c.toLowerCase();
  return buttonAccent(validHex(accent) ? accent : DEFAULT_PREFS.accent).toLowerCase();
}
/** Same rule as the backend (`pick_account_color` in db.rs): first palette colour no account uses, else the least used one. */
export function pickAccountColor(used: (string | null | undefined)[]): string {
  const rgb = (h: string) => (HEX6.test(h.trim()) ? [1, 3, 5].map((i) => parseInt(h.trim().slice(i, i + 2), 16)) : null);
  // a color with none stored is drawn in the primary color (default = first palette color); look-alikes count as the same color
  const u = used.map((c) => rgb(c ?? ACCOUNT_PALETTE[0])).filter((c): c is number[] => !!c);
  let best = ACCOUNT_PALETTE[0], n = Infinity;
  for (const p of ACCOUNT_PALETTE) {
    const pc = rgb(p)!;
    const k = u.filter((c) => Math.hypot(c[0] - pc[0], c[1] - pc[1], c[2] - pc[2]) < 45).length;
    if (k < n) { best = p; n = k; }
  }
  return best;
}
