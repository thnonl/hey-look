export type NotifySound = "mail" | "default" | "im" | "reminder" | "sms" | "none";
export const NOTIFY_SOUNDS: [NotifySound, string][] = [
  ["mail", "Mail"], ["default", "Default"], ["im", "Instant message"], ["reminder", "Reminder"], ["sms", "SMS"], ["none", "Silent"],
];
export const NOTIFY_ACTIONS: [string, string][] = [
  ["none", "None"], ["archive", "Archive"], ["delete", "Delete"], ["read", "Mark as read"], ["flag", "Flag"], ["reply", "Reply"], ["snooze", "Snooze until tomorrow"],
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
}

export interface Prefs extends Overridable {
  theme: "system" | "light" | "dark";
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
  trayBadge: "number" | "dot" | "off"; // unread badge on the tray icon
  taskbarBadge: "number" | "off"; // unread badge on the taskbar button
  countOtherMail: boolean; // include "Other" (bulk) mail in unread counts
  recentSearches: string[];
  defaultAccount: string; // "" = first account
  snoozeTimes: { evening: number; tomorrow: number; weekend: number; nextWeek: number }; // hour of day
  hoverActions: string[]; // archive | delete | flag | pin | read | snooze
  favorites: string[]; // "<accountId|*>|<folder key>"
  collapsed: Record<string, boolean>; // folder pane groups
  folderW: number; // pane widths in px
  listW: number;
  accountPrefs: Record<string, Partial<Overridable>>;
}

export const DEFAULT_PREFS: Prefs = {
  theme: "system",
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
  trayBadge: "number",
  taskbarBadge: "number",
  countOtherMail: false,
  recentSearches: [],
  defaultAccount: "",
  snoozeTimes: { evening: 18, tomorrow: 8, weekend: 9, nextWeek: 8 },
  hoverActions: ["archive", "delete", "flag", "pin"],
  favorites: ["*|inbox", "*|sent", "*|drafts"],
  collapsed: {},
  folderW: 248,
  listW: 392,
  accountPrefs: {},
  // overridable (these are the "All accounts" values)
  notifications: true,
  smartNotifications: true,
  notifyPreview: true,
  notifySound: "mail",
  notifyActions: ["archive", "delete", "read"],
  autoCc: "",
  autoBcc: "",
  signatureId: "",
  signatureOnReply: true,
  replyDefault: "reply",
  undoSeconds: 10,
  loadRemote: false,
  syncMinutes: 2,
};

/** Effective value: the account's own override if it has one, otherwise the "All accounts" value. */
export function eff<K extends keyof Overridable>(prefs: Prefs, accountId: string | null | undefined, key: K): Prefs[K] {
  const own = accountId ? prefs.accountPrefs[accountId]?.[key] : undefined;
  return (own !== undefined ? own : prefs[key]) as Prefs[K];
}

export function isOverridden(prefs: Prefs, accountId: string | null | undefined, key: keyof Overridable): boolean {
  return !!accountId && prefs.accountPrefs[accountId]?.[key] !== undefined;
}

export function mergePrefs(raw: string | null): Prefs {
  if (!raw) return { ...DEFAULT_PREFS };
  try {
    const p = JSON.parse(raw) as Partial<Prefs> & { showUnreadCount?: boolean };
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
      accountPrefs[id] = n as Partial<Overridable>;
    }
    return {
      ...DEFAULT_PREFS,
      ...p,
      accountPrefs,
      snoozeTimes: { ...DEFAULT_PREFS.snoozeTimes, ...(p.snoozeTimes ?? {}) },
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export const ROLE_LABELS: Record<string, string> = {
  inbox: "Inbox",
  drafts: "Drafts",
  sent: "Sent Items",
  archive: "Archive",
  junk: "Junk Email",
  trash: "Deleted Items",
  starred: "Flagged",
  pinned: "Pinned",
  snoozed: "Snoozed",
  scheduled: "Scheduled",
  unread: "Unread",
  all: "All Mail",
};

export function folderLabel(key: string, name?: string): string {
  if (ROLE_LABELS[key]) return ROLE_LABELS[key];
  const n = name ?? key.replace(/^f:/, "");
  return n.split(/[/.]/).pop() || n;
}

/** Folder nesting depth for custom folders ("Projects/Hey Look" = 1). */
export function folderDepth(key: string, name?: string): number {
  if (ROLE_LABELS[key]) return 0;
  const n = name ?? key.replace(/^f:/, "");
  return Math.max(0, n.split(/[/.]/).length - 1);
}

export const ACCENT_PRESETS: [string, string][] = [
  ["#0f6cbd", "Blue"], ["#0e7c86", "Teal"], ["#1a7f4b", "Green"], ["#6d4aff", "Violet"],
  ["#c2327d", "Rose"], ["#c4570c", "Orange"], ["#475569", "Slate"],
];

const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
/** Readable text color on top of `hex` (the accent as a button background). */
export function readableOn(hex: string): string {
  return luminance(hex) > 0.4 ? "#0b1220" : "#ffffff";
}
/** The accent as it appears in dark mode (lightened 28%), and the text color that goes on it. */
export function lightened(hex: string, amount = 0.28): string {
  const n = parseInt(hex.slice(1), 16);
  const m = (v: number) => Math.round(v * (1 - amount) + 255 * amount).toString(16).padStart(2, "0");
  return `#${m((n >> 16) & 255)}${m((n >> 8) & 255)}${m(n & 255)}`;
}
export const validHex = (v: string) => /^#[0-9a-fA-F]{6}$/.test(v);
