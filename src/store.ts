import { create } from "zustand";
import { api, Account, Att, BackfillProgress, CalendarInfo, CalEvent, CalSource, DraftSecurity, FolderInfo, Meeting, MessageFull, OutboxItem, SearchScope, ThreadSummary } from "./api";
import { loadPlatform } from "./platform";
import { hasMailAccounts } from "./mailControls";
import { applyBackfill } from "./backfill";
import { calendarErrorText } from "./calendarSync";
import { calTz, CalView, Day, rangeFor, systemTz, today } from "./calendar";
import { accentText, accountColor, buttonAccent, clampMaxDownload, DEFAULT_PREFS, lightened, mergePrefs, Prefs, readableOn, staleAccountPrefs, topBar, validHex } from "./prefs";

export interface ComposeInit {
  accountId?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  bodyHtml?: string;
  inReplyTo?: string | null;
  references?: string[];
  replaces?: string; // draft thread id being edited
  isReply?: boolean;
  attachments?: Att[];
  /** a scheduled message opened for editing (paused while open) */
  outboxId?: string;
  /** the scheduled time of that message */
  sendAt?: number;
  /** open the "Send later" picker straight away (Change time from the Scheduled list) */
  openSchedule?: boolean;
  /** why the scheduled message failed (shown in the Compose banner) */
  outboxError?: string;
  /** encryption / signing of a reopened draft or scheduled message */
  security?: DraftSecurity;
  /**
   * Compose reopened after a send failed or was undone: `bodyHtml` is the exact HTML that was built (the signature region included,
   * as in a stored draft), and Encrypt / Sign / public key are as the user had set them.
   */
  restore?: { encrypt: "on" | "off" | "auto"; sign: boolean; attachKey: boolean };
  /** send as confidential (an answer to confidential mail starts that way) */
  confidential?: boolean;
  /** start Compose as a meeting invitation ("Meeting" switched on) */
  meeting?: Partial<Meeting> & { on?: boolean };
}

/** What the New / Edit event dialog starts with. */
export interface EventInit {
  summary?: string;
  start?: number;
  end?: number;
  allDay?: boolean;
  location?: string;
  description?: string;
  attendees?: string[];
}

export type Dialog =
  | null
  | { type: "settings"; tab?: string; focus?: string; nonce?: number }
  | { type: "cleaner" }
  | { type: "original"; messageId: string }
  | { type: "pgp-generate"; accountId?: string; back?: string }
  | { type: "pgp-import"; armored?: string; paste?: boolean; back?: string }
  | { type: "pgp-key"; fingerprint: string; back?: string }
  | { type: "event"; eventId?: string; init?: EventInit };

/** Why a PGP key has to be unlocked right now (the title of the passphrase prompt). */
export type UnlockReason = "sign" | "decrypt" | "draft" | "schedule";

export interface PassphraseAsk {
  fingerprint: string;
  reason: UnlockReason;
  /** e.g. the address the key belongs to */
  label?: string;
  resolve: (unlocked: boolean) => void;
}

export type RibbonTab = "home" | "view" | "help";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "success" | "error";
  undo?: () => void;
  /** up to two buttons, e.g. Open / Show in folder / Retry */
  actions?: ToastAction[];
  ttl: number;
  /** stays until it is answered (no timer, no countdown bar); `key` names it so a new one replaces the old */
  sticky?: boolean;
  key?: string;
  /** what the "×" does for a sticky toast (default: just close it) */
  onDismiss?: () => void;
  /** accessible name of the "×" (default: "Later" when `onDismiss` is set, else "Dismiss") */
  closeLabel?: string;
  /** Esc closes it (when nothing else that Esc closes is open) */
  escCloses?: boolean;
}

export interface Choice {
  id: string;
  label: string;
  kind?: "primary" | "danger";
}
export interface AskState {
  title: string;
  body?: string;
  choices: Choice[];
  resolve: (id: string) => void;
}

const VIRTUAL = new Set(["starred", "pinned", "snoozed", "all", "scheduled"]);
const MOVE_LIKE = new Set(["archive", "trash", "junk", "block", "move", "inbox", "delete_forever"]);

/** The IMAP-side folder a move should act on (undefined for cross-folder views). */
export function scopeOf(folder: string): string | undefined {
  if (folder === "unread") return "inbox";
  return VIRTUAL.has(folder) ? undefined : folder;
}

/** Turn backend / network errors into something a person can act on. */
export function friendlyError(e: unknown): string {
  let raw = String(e instanceof Error ? e.message : e).replace(/^Error:\s*/, "").trim();
  // calendar sync errors come with their sentence ("CAL_CONFLICT: This event was changed in …"): shown as they are
  const calendarText = calendarErrorText(raw);
  if (calendarText) return calendarText;
  // backend errors are "CODE: human text"; a few PGP ones carry data instead ("PGP_MISSING_KEYS:a@b.c,d@e.f")
  if (/^PGP_LOCKED:/.test(raw)) return "Your encryption key is locked. Unlock it and try again.";
  if (/^PGP_MISSING_KEYS:/.test(raw)) return `No public key for ${raw.slice("PGP_MISSING_KEYS:".length).split(",").join(", ")}.`;
  raw = raw.replace(/^[A-Z][A-Z_]+:\s+/, "");
  // the backend already explained a server that does not do SSL/TLS or STARTTLS (mail.rs): keep its words
  if (/^Couldn[’']t start a secure connection to /.test(raw)) return shortenError(raw);
  if (/login failed|authenticationfailed|invalid credentials|auth.*fail/i.test(raw))
    return "Sign-in failed. Check the password (Gmail, iCloud and Yahoo need an app password) or sign in again.";
  if (/no stored (password|\w+ token)/i.test(raw)) return "The saved credentials for this account are missing. Remove the account and add it again.";
  if (/timed out|timeout|10060|did not properly respond/i.test(raw)) return "The mail server did not respond. Check your connection and try again.";
  if (/lookup|dns|no such host|name or service not known|11001/i.test(raw)) return "Cannot reach the mail server. Check the server name and your connection.";
  if (/certificate|tls|ssl/i.test(raw) && /invalid|verify|unknown|expired/i.test(raw)) return "The server's security certificate was rejected. For a self-signed or private-CA server, remove the account and add it again with \"Trust this server's certificate\" turned on.";
  return shortenError(raw);
}

/** Longer texts are cut for the toast; the whole text is kept here so the toast can show it as a tooltip. */
const fullErrors = new Map<string, string>();
export const fullErrorFor = (shown: string): string | undefined => {
  for (const [k, v] of fullErrors) if (shown.includes(k)) return shown.replace(k, v);
  return undefined;
};

/** `text` cut to at most `max` characters at a word boundary, with an ellipsis. */
export function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const sp = head.search(/\s\S*$/);
  return `${(sp > max * 0.5 ? head.slice(0, sp) : head).replace(/[\s,;:.(\-]+$/, "")}…`;
}

/**
 * The words we wrote ("CODE: advice (Server reply: …)") are shown whole; only what the server said is cut, at a word, and
 * the complete text stays available (tooltip). Any other long error is cut at a word at 220 characters.
 */
export function shortenError(raw: string): string {
  const m = raw.match(/^([\s\S]*?)\s*\((Server reply: [\s\S]*?)\)\s*$/);
  const shown = m ? `${m[1]} (${cutAtWord(m[2], 120)})` : cutAtWord(raw, 220);
  if (shown !== raw) {
    if (fullErrors.size > 20) fullErrors.delete(fullErrors.keys().next().value as string);
    fullErrors.set(shown, raw);
  }
  return shown;
}

interface State {
  accounts: Account[];
  accountId: string | null; // null = all accounts
  folder: string;
  search: string;
  searchScope: SearchScope;
  focus: "focused" | "other";
  filter: "all" | "unread" | "flagged";
  threads: ThreadSummary[];
  outbox: OutboxItem[];
  folders: FolderInfo[];
  selected: string | null;
  checked: Set<string>;
  messages: MessageFull[];
  loading: boolean;
  /** `loadMore` is fetching older mail right now (re-entrancy guard and the "Loading…" footer) */
  loadingMore: boolean;
  /** the last `loadMore` failed: scrolling stops retrying, the footer button is the retry */
  moreError: boolean;
  /** "accountId|role" the server has nothing older for; cleared by a sync */
  exhausted: Record<string, true>;
  /** "accountId|role" the "Max emails to download" cap stopped; cleared by a sync and when the cap changes */
  limited: Record<string, true>;
  /** background download of older Inbox mail per account (`backfill-progress`), only while it runs */
  backfill: Record<string, BackfillProgress>;
  syncing: boolean;
  /** account whose first sync runs right now (after it was added): its empty Inbox says so instead of "all caught up" */
  firstSync: string | null;
  syncErrors: Record<string, string>;
  toasts: Toast[];
  ask: AskState | null;
  passphrase: PassphraseAsk | null;
  /** bumps whenever keys are added, removed or unlocked, so key-dependent views refetch */
  keysRev: number;
  compose: ComposeInit | null;
  composeKey: number; // changes on every open so a new message never inherits the old one's state
  composeDirty: boolean;
  /** Saves the open message as a draft; resolves true when it was saved (false: the save failed, the message is still open). */
  composeSaver: ((opts?: { quiet?: boolean }) => Promise<boolean | void>) | null;
  dialog: Dialog;
  commandOpen: boolean;
  ribbonTab: RibbonTab;
  prefs: Prefs;
  aiConfigured: boolean;
  loaded: boolean;
  /** Mail or Calendar */
  module: "mail" | "calendar";
  /** the day the calendar is centred on */
  calDate: Day;
  calEvents: CalEvent[];
  calendars: CalendarInfo[];
  /** calendar sync state of the mailboxes that turned it on (Settings, the calendar sidebar) */
  calSources: CalSource[];
  calLoading: boolean;
  calError: string | null;
  /** bumps when the calendar changed behind the view's back (sync, respond, save) */
  calRev: number;
  /** Messages being sent right now: waiting in the undo window or handed to the backend and not answered yet (an update restart waits for them). */
  sendsInFlight: number;
  /** The app is flushing sends because it is about to quit (a failed send then goes to Drafts). */
  quitting: boolean;
  /** Why the last draft save failed (the quit dialog says it). */
  draftError: string;

  init: () => Promise<void>;
  setView: (folder: string, accountId?: string | null) => Promise<void>;
  setSearch: (q: string, remember?: boolean) => Promise<void>;
  setSearchScope: (s: SearchScope) => Promise<void>;
  setFocus: (f: "focused" | "other") => Promise<void>;
  setFilter: (f: "all" | "unread" | "flagged") => Promise<void>;
  refresh: () => Promise<void>;
  sync: () => Promise<void>;
  /** A new account was added: close the dialogs, show its Inbox, start its first sync with a visible loading state. */
  accountAdded: (acc: Account) => Promise<void>;
  /** Older mail of the open folder: up to MORE_CHUNKS x 50 per account, one request at a time. `manual` = the button (retry, ignores a previous error). */
  loadMore: (manual?: boolean) => Promise<void>;
  onBackfill: (p: BackfillProgress) => void;
  select: (id: string | null) => Promise<void>;
  toggleCheck: (id: string) => void;
  setChecked: (ids: string[]) => void;
  act: (ids: string[], action: string, arg?: string, label?: string) => Promise<void>;
  openCompose: (c: ComposeInit | null) => Promise<void>;
  setComposeDirty: (d: boolean) => void;
  setComposeSaver: (f: ((opts?: { quiet?: boolean }) => Promise<boolean | void>) | null) => void;
  setDialog: (d: Dialog) => void;
  setCommandOpen: (o: boolean) => void;
  setRibbonTab: (t: RibbonTab) => void;
  showToast: (text: string, undo?: () => void, kind?: Toast["kind"], actions?: ToastAction[]) => void;
  dismissToast: (id: number) => void;
  /** A toast that stays until it is answered (or `null` to remove it); one per `key`, a new text replaces the old in place. */
  setStickyToast: (
    key: string,
    spec: { text: string; kind?: Toast["kind"]; actions?: ToastAction[]; onDismiss?: () => void; closeLabel?: string; escCloses?: boolean } | null,
  ) => void;
  /** Count a message as being sent from now until `done()` is called. */
  /** A send is under way (its undo window counts). `flush` makes it go out at once (a quit); it is dropped when the send ends. */
  beginSend: (flush?: () => void) => () => void;
  confirm: (o: { title: string; body?: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>;
  choose: (o: { title: string; body?: string; choices: Choice[] }) => Promise<string>;
  resolveAsk: (id: string) => void;
  /** Asks for the passphrase of a key and unlocks it. Resolves true when it is unlocked, false when cancelled. */
  askPassphrase: (o: { fingerprint: string; reason: UnlockReason; label?: string }) => Promise<boolean>;
  resolvePassphrase: (unlocked: boolean) => void;
  bumpKeys: () => void;
  /** Swap one message of the open conversation (after it was decrypted). */
  replaceMessage: (m: MessageFull) => void;
  setPrefs: (p: Partial<Prefs>) => void;
  refreshAi: () => Promise<void>;
  setModule: (m: "mail" | "calendar") => void;
  setCalView: (v: CalView) => void;
  setCalDate: (d: Day) => void;
  loadCalendar: () => Promise<void>;
  bumpCal: () => void;
  loadCalSources: () => Promise<void>;
  /** Re-read the open conversation without clearing it (an invitation's state changed). */
  reloadMessages: () => Promise<void>;
}

let toastSeq = 0;
let readTimer: ReturnType<typeof setTimeout> | undefined;

/** Folders `loadMore` cannot page back (cross-folder views and the outbox have no single IMAP folder). */
const NO_PAGING = new Set(["starred", "pinned", "snoozed", "all", "scheduled"]);
export const canPageBack = (folder: string, searching: boolean) => !searching && !NO_PAGING.has(folder);
/** The IMAP-side role `load_older` takes for a view (the Unread view reads the Inbox). */
const roleOf = (folder: string) => (folder === "unread" ? "inbox" : folder);
export const exhaustedKey = (accountId: string, folder: string) => `${accountId}|${roleOf(folder)}`;

/** Shown where the "Max emails to download" cap stopped the list (toast of "Load older messages"; the list footer words it the same). */
export const limitMessage = (n: number) => `Download limit reached (${n.toLocaleString("en-US")} mails per mailbox). Raise it in Settings > Reading & sync.`;

const MORE_CHUNKS = 4; // one scroll to the end = up to 4 x 50 = 200 older messages in total, however many mailboxes are open
const MORE_PAUSE_MS = 700; // between two requests, so the server and the list can breathe
const BACKFILL_REFRESH_MS = 1000; // the list is re-read at most this often while the background download runs
/** Bumped whenever the open view changes: a `loadMore` loop that sees a newer number stops without touching the state. */
let moreRun = 0;
let backfillTimer: ReturnType<typeof setTimeout> | undefined;
let backfillLast = 0;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** The mailbox to page next: the one whose oldest loaded thread is the most recent (one with nothing loaded goes first). */
function nextMailbox(ids: Set<string>, threads: { accountId: string; lastDate: number }[]): string {
  const oldest = new Map<string, number>();
  for (const t of threads) if (ids.has(t.accountId)) oldest.set(t.accountId, Math.min(oldest.get(t.accountId) ?? Infinity, t.lastDate));
  let best = "";
  let bestAt = -Infinity;
  for (const id of ids) {
    const at = oldest.get(id) ?? Infinity;
    if (at > bestAt) [best, bestAt] = [id, at];
  }
  return best;
}

/** Preferences the backend acts on (saving, retries, quit) are also stored as plain settings. */
const BACKEND_SETTINGS: [keyof Prefs, string, (v: unknown) => string][] = [
  ["downloadDir", "download_dir", (v) => (typeof v === "string" ? v : "")],
  ["warnExecutables", "warn_executables", (v) => (v ? "1" : "0")],
  ["scheduledCatchUp", "scheduled_catchup", (v) => String(v)],
  ["retryScheduled", "scheduled_retry", (v) => (v ? "1" : "0")],
  ["maxDownload", "max_download", (v) => String(clampMaxDownload(v))],
  ["autoAddInvites", "auto_add_invites", (v) => (v ? "1" : "0")],
  ["eventReminderMin", "event_reminder_min", (v) => (typeof v === "number" ? String(v) : "")],
];

function mirrorSettings(p: Partial<Prefs>) {
  for (const [pref, key, fmt] of BACKEND_SETTINGS) {
    if (pref in p) void api.setSetting(key, fmt(p[pref])).catch(() => undefined);
  }
}

function applyPrefs(p: Prefs) {
  const root = document.documentElement;
  if (p.theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", p.theme);
  root.setAttribute("data-density", p.density);
  root.style.setProperty("--fs", `${p.fontSize}px`);
  const accent = buttonAccent(validHex(p.accent) ? p.accent : DEFAULT_PREFS.accent);
  root.style.setProperty("--accent-base", accent);
  root.style.setProperty("--accent-fg-lt", readableOn(accent));
  root.style.setProperty("--accent-fg-dk", readableOn(lightened(accent)));
  root.style.setProperty("--accent-text-lt", accentText(accent, false));
  root.style.setProperty("--accent-text-dk", accentText(accent, true));
  const top = topBar(accent);
  root.style.setProperty("--top-lt", top.bg);
  root.style.setProperty("--top-fg-lt", top.fg);
  root.style.setProperty("--top-field-lt", top.field);
  root.style.setProperty("--top-field-h-lt", top.fieldHover);
  root.style.setProperty("--top-hover-lt", top.hover);
}

/** Apply read/unread/flag/pin changes to the lists right away; the backend call (IMAP) follows. */
function applyOptimistic(ids: string[], action: string) {
  if (!["read", "unread", "star", "unstar", "pin", "unpin"].includes(action)) return;
  const idset = new Set(ids);
  const st = useStore.getState();
  const folders = st.folders.map((f) => ({ ...f }));
  const bump = (t: ThreadSummary, delta: number) => {
    const f = folders.find((x) => x.accountId === t.accountId && x.key === t.folder);
    if (f) f.unread = Math.max(0, f.unread + delta);
  };
  const threads = st.threads.map((t) => {
    if (!idset.has(t.threadId)) return t;
    const n = { ...t };
    if (action === "read") n.unread = 0;
    else if (action === "unread") n.unread = Math.max(1, t.unread);
    else if (action === "star") n.flagged = true;
    else if (action === "unstar") n.flagged = false;
    else if (action === "pin") n.pinned = true;
    else if (action === "unpin") n.pinned = false;
    if (t.unread > 0 !== n.unread > 0) bump(t, n.unread > 0 ? 1 : -1);
    return n;
  });
  const messages =
    st.selected && idset.has(st.selected) && (action === "read" || action === "unread")
      ? st.messages.map((m, i) => ({ ...m, seen: action === "read" ? true : i < st.messages.length - 1 ? m.seen : false }))
      : st.messages;
  useStore.setState({ threads, folders, messages });
}

/**
 * One-time migration: an account without a stored color has always been drawn in the primary color, so that exact color is stored
 * for it now (what the user sees does not change) and every place - dots, avatars, Settings > Profile - reads the stored value.
 */
/** The sends still waiting out their "Undo" time: each can be told to go out now. */
const sendFlushers = new Set<() => void>();

/**
 * The app is about to quit: let every message that is still in its Undo window go out at once and wait (at most `maxMs`) until no send is
 * under way. A quit used to throw such a message away (the timer lives only here). Resolves true when nothing is left.
 */
export async function flushSends(maxMs = 25_000): Promise<boolean> {
  useStore.setState({ quitting: true });
  try {
    for (const f of [...sendFlushers]) f();
    const until = Date.now() + maxMs;
    while (useStore.getState().sendsInFlight > 0) {
      if (Date.now() > until) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
    return true;
  } finally {
    useStore.setState({ quitting: false });
  }
}

export function storeMissingColors(accounts: Account[], accent: string): Account[] {
  return accounts.map((a) => {
    if (a.color) return a;
    const color = accountColor(a, accent);
    void api.updateAccount(a.id, a.displayName, color).catch(() => {});
    return { ...a, color };
  });
}

/** The open view changed: a running `loadMore` is abandoned (its answer is ignored) and a new one may start. */
function cancelMore() {
  moreRun++;
  useStore.setState({ loadingMore: false, moreError: false });
}

export const useStore = create<State>((set, get) => ({
  accounts: [],
  accountId: null,
  folder: "inbox",
  search: "",
  searchScope: "current",
  focus: "focused",
  filter: "all",
  threads: [],
  outbox: [],
  folders: [],
  selected: null,
  checked: new Set(),
  messages: [],
  loading: true,
  loadingMore: false,
  moreError: false,
  exhausted: {},
  limited: {},
  backfill: {},
  syncing: false,
  firstSync: null,
  syncErrors: {},
  toasts: [],
  ask: null,
  passphrase: null,
  keysRev: 0,
  compose: null,
  composeKey: 0,
  composeDirty: false,
  composeSaver: null,
  dialog: null,
  commandOpen: false,
  ribbonTab: "home",
  prefs: { ...DEFAULT_PREFS },
  aiConfigured: false,
  loaded: false,
  module: "mail",
  calDate: today(systemTz()),
  calEvents: [],
  calSources: [],
  calendars: [],
  calLoading: false,
  calError: null,
  calRev: 0,
  sendsInFlight: 0,
  quitting: false,
  draftError: "",

  init: async () => {
    const [rawAccounts, rawPrefs] = await Promise.all([api.listAccounts(), api.getSetting("prefs"), loadPlatform()]);
    let prefs = mergePrefs(rawPrefs);
    // settings that point at an account that was removed (default account, overrides, favorites) are dropped
    const stale = staleAccountPrefs(prefs, rawAccounts.map((a) => a.id));
    if (Object.keys(stale).length) {
      prefs = { ...prefs, ...stale };
      void api.setSetting("prefs", JSON.stringify(prefs)).catch(() => undefined);
    }
    const accounts = storeMissingColors(rawAccounts, prefs.accent);
    applyPrefs(prefs);
    mirrorSettings(prefs);
    set({ accounts, prefs, loaded: true, module: prefs.lastModule === "calendar" ? "calendar" : "mail", calDate: today(calTz(prefs)) });
    if (prefs.lastModule === "calendar") void get().loadCalendar();
    void get().refreshAi();
    await get().refresh();
    void get().sync();
  },

  refreshAi: async () => {
    try {
      const [ep, model] = await Promise.all([api.getSetting("ai_endpoint"), api.getSetting("ai_model")]);
      set({ aiConfigured: !!ep?.trim() && !!model?.trim() });
    } catch {
      set({ aiConfigured: false });
    }
  },

  setModule: (module) => {
    if (get().module === module) return;
    set({ module });
    get().setPrefs({ lastModule: module });
    if (module === "calendar") void get().loadCalendar();
  },

  setCalView: (v) => {
    get().setPrefs({ calView: v });
    void get().loadCalendar();
  },

  setCalDate: (calDate) => {
    set({ calDate });
    void get().loadCalendar();
  },

  bumpCal: () => {
    set((s) => ({ calRev: s.calRev + 1 }));
    if (get().module === "calendar") void get().loadCalendar();
    else void get().loadCalSources();
  },

  loadCalSources: async () => {
    try {
      set({ calSources: await api.calendarSources() });
    } catch {
      /* keep what is shown */
    }
  },

  loadCalendar: async () => {
    const { prefs, calDate } = get();
    const tz = calTz(prefs);
    const { from, to } = rangeFor(prefs.calView, calDate, prefs.weekStart, tz);
    set({ calLoading: true });
    try {
      const [events, calendars, calSources] = await Promise.all([api.calendarListEvents(from, to), api.calendarListCalendars(), api.calendarSources().catch(() => get().calSources)]);
      // ignore a slow answer for a range the user already left
      const now = get();
      const cur = rangeFor(now.prefs.calView, now.calDate, now.prefs.weekStart, calTz(now.prefs));
      if (cur.from === from && cur.to === to) set({ calEvents: events, calendars, calSources, calError: null });
    } catch (e) {
      set({ calError: friendlyError(e) });
    } finally {
      set({ calLoading: false });
    }
  },

  reloadMessages: async () => {
    const { selected, folder } = get();
    if (!selected) return;
    try {
      const messages = await api.getThread(selected, scopeOf(folder));
      if (get().selected === selected) set({ messages });
    } catch {
      /* keep what is shown */
    }
  },

  setView: async (folder, accountId = null) => {
    cancelMore();
    set({ folder, accountId, selected: null, messages: [], threads: [], loading: true, checked: new Set(), search: "", module: "mail" });
    if (get().prefs.lastModule !== "mail") get().setPrefs({ lastModule: "mail" });
    await get().refresh();
  },

  setSearch: async (search, remember = false) => {
    // searching is a mail thing: leave the calendar
    if (get().module !== "mail") get().setModule("mail");
    cancelMore();
    set({ search, selected: null, messages: [], loading: true });
    if (remember && search.trim()) {
      const recent = [search.trim(), ...get().prefs.recentSearches.filter((r) => r !== search.trim())].slice(0, 8);
      get().setPrefs({ recentSearches: recent });
    }
    await get().refresh();
  },

  setSearchScope: async (searchScope) => {
    cancelMore();
    set({ searchScope });
    if (get().search.trim()) {
      set({ loading: true });
      await get().refresh();
    }
  },

  setFocus: async (focus) => {
    set({ focus, loading: true });
    await get().refresh();
  },

  setFilter: async (filter) => {
    set({ filter, loading: true });
    await get().refresh();
  },

  refresh: async () => {
    const { folder, accountId, search, searchScope, focus, filter, prefs } = get();
    const foldersP = api.listFolders().then((folders) => set({ folders }));
    // scheduled messages feed the Scheduled view and its badge, so they are read on every refresh
    const outboxP = api.listOutbox().then((outbox) => set({ outbox })).catch(() => undefined);
    void api.refreshBadge().catch(() => undefined);
    try {
      if (folder === "scheduled") {
        set({ threads: [] });
        await Promise.all([foldersP, outboxP]);
        return;
      }
      const threads = await api.listThreads({
        accountId,
        folder,
        search,
        focus: folder === "inbox" && prefs.focused && !search.trim() ? focus : null,
        flat: !prefs.conversations,
        unreadOnly: filter === "unread",
        flaggedOnly: filter === "flagged",
        sortAsc: prefs.sortAsc,
        scope: search.trim() ? searchScope : "current",
      });
      // ignore a slow answer for a view the user already left
      const now = get();
      if (now.folder === folder && now.accountId === accountId && now.search === search) set({ threads });
      await Promise.all([foldersP, outboxP]);
    } finally {
      set({ loading: false });
    }
  },

  sync: async () => {
    const { accounts, syncing } = get();
    if (syncing || accounts.length === 0) return;
    set({ syncing: true });
    try {
      // toasts and the tray badge are handled by the backend (it keeps syncing while the window is hidden)
      const results = await Promise.allSettled(accounts.map((a) => api.syncAccount(a.id)));
      const errors: Record<string, string> = {};
      results.forEach((r, i) => {
        if (r.status === "rejected") errors[accounts[i].id] = friendlyError(r.reason);
      });
      set({ syncErrors: errors });
      const first = Object.entries(errors)[0];
      if (first) {
        const acct = accounts.find((a) => a.id === first[0]);
        get().showToast(`${acct?.email ?? "Account"}: ${first[1]}`, undefined, "error");
      }
    } finally {
      // new mail may have arrived and a failed fetch may work now: scrolling may ask the server for older mail again
      set({ syncing: false, exhausted: {}, limited: {}, moreError: false });
      await get().refresh();
    }
  },

  accountAdded: async (acc) => {
    // the backend list is the truth (it also assigns the colour); fall back to what we were given
    let accounts = await api.listAccounts().catch(() => get().accounts);
    if (!accounts.some((a) => a.id === acc.id)) accounts = [...accounts.filter((a) => a.email !== acc.email), acc];
    accounts = storeMissingColors(accounts, get().prefs.accent);
    // the selection moves to the new mailbox: a stale search / filter of the old view must not hide it
    set({ accounts, dialog: null, firstSync: acc.id, filter: "all" });
    get().showToast(`Account ${acc.email} added`, undefined, "success");
    await get().setView("inbox", acc.id);
    try {
      await api.syncAccount(acc.id);
      set((s) => ({ syncErrors: Object.fromEntries(Object.entries(s.syncErrors).filter(([k]) => k !== acc.id)) }));
    } catch (e) {
      const msg = friendlyError(e);
      set((s) => ({ syncErrors: { ...s.syncErrors, [acc.id]: msg } }));
      get().showToast(`${acc.email}: ${msg}`, undefined, "error");
    } finally {
      set({ firstSync: null });
      await get().refresh();
    }
  },

  loadMore: async (manual = false) => {
    const { accountId, accounts, folder, search, loadingMore, moreError } = get();
    if (loadingMore || !canPageBack(folder, search.trim().length > 0)) return;
    if (moreError && !manual) return;
    const role = roleOf(folder);
    const targets = accountId ? [accountId] : accounts.map((a) => a.id);
    // the button asks again even where the server said "nothing older" (it may have been wrong or things changed) or the cap
    // stopped it (answered at once by the backend, without any network)
    let { exhausted, limited } = get();
    const mine = (k: string) => targets.some((id) => k === `${id}|${role}`);
    if (manual) {
      exhausted = Object.fromEntries(Object.entries(exhausted).filter(([k]) => !mine(k)));
      limited = Object.fromEntries(Object.entries(limited).filter(([k]) => !mine(k)));
    }
    const pending = targets.filter((id) => !exhausted[`${id}|${role}`] && !limited[`${id}|${role}`]);
    if (manual) set({ exhausted, limited });
    if (pending.length === 0) return;
    const run = ++moreRun;
    set({ loadingMore: true, moreError: false });
    const alive = () => run === moreRun;
    let added = 0;
    let failing = "";
    try {
      // MORE_CHUNKS requests in all, shared by the mailboxes: each goes to the one whose loaded mail ends most recently,
      // so the merged timeline grows evenly instead of one mailbox racing ahead
      const active = new Set(pending);
      for (let i = 0; i < MORE_CHUNKS && active.size > 0; i++) {
        if (i > 0) await sleep(MORE_PAUSE_MS);
        if (!alive()) return;
        const id = nextMailbox(active, get().threads);
        failing = id;
        const r = await api.loadOlder(id, role, 50);
        if (!alive()) return;
        added += r.added;
        if (r.exhausted) {
          active.delete(id);
          set((s) => ({ exhausted: { ...s.exhausted, [`${id}|${role}`]: true } }));
        } else if (r.limited) {
          // the cap, not the server: a mailbox stops being asked just like an exhausted one, but the footer says why
          active.delete(id);
          set((s) => ({ limited: { ...s.limited, [`${id}|${role}`]: true } }));
        }
        // the list grows chunk by chunk (the viewport keeps its place)
        if (r.added > 0) await get().refresh();
        if (!alive()) return;
      }
      const stopped = (id: string) => get().exhausted[`${id}|${role}`] || get().limited[`${id}|${role}`];
      const done = pending.every(stopped);
      if (manual) {
        if (added > 0) get().showToast(`Loaded ${added} older message${added === 1 ? "" : "s"}`, undefined, "success");
        else if (done) {
          const capped = targets.some((id) => get().limited[`${id}|${role}`]);
          get().showToast(capped ? limitMessage(get().prefs.maxDownload) : "No older messages in this folder", undefined, "info");
        }
      }
      // nothing came back although the server did not say it was done: stop scrolling from asking again and again (the button still can)
      if (added === 0 && !done) set({ moreError: true });
    } catch (e) {
      if (!alive()) return;
      // with several mailboxes say which one failed
      const acct = targets.length > 1 ? get().accounts.find((x) => x.id === failing)?.email : undefined;
      get().showToast(`${acct ? `${acct}: ` : ""}${friendlyError(e)}`, undefined, "error");
      set({ moreError: true });
    } finally {
      if (alive()) set({ loadingMore: false });
    }
  },

  onBackfill: (p) => {
    set((s) => ({ backfill: applyBackfill(s.backfill, p) }));
    // the list is re-read quietly (same scroll position, same selection), at most once a second; the last chunk always is
    clearTimeout(backfillTimer);
    const wait = p.done ? 0 : Math.max(0, backfillLast + BACKFILL_REFRESH_MS - Date.now());
    backfillTimer = setTimeout(() => {
      backfillLast = Date.now();
      void get().refresh();
    }, wait);
  },

  select: async (id) => {
    clearTimeout(readTimer);
    set({ selected: id, messages: [] });
    if (!id) return;
    const { folder, prefs } = get();
    const messages = await api.getThread(id, scopeOf(folder));
    if (get().selected !== id) return;
    set({ messages });
    if (messages.some((m) => !m.seen) && prefs.markReadDelay >= 0) {
      const mark = () => {
        if (get().selected === id) void get().act([id], "read");
      };
      if (prefs.markReadDelay === 0) mark();
      else readTimer = setTimeout(mark, prefs.markReadDelay * 1000);
    }
  },

  toggleCheck: (id) => {
    const c = new Set(get().checked);
    if (c.has(id)) c.delete(id);
    else c.add(id);
    set({ checked: c });
  },

  setChecked: (ids) => set({ checked: new Set(ids) }),

  act: async (ids, action, arg, label) => {
    if (ids.length === 0) return;
    applyOptimistic(ids, action);
    const { threads, selected, prefs, folder } = get();
    const moveLike = MOVE_LIKE.has(action);
    const removing = moveLike || action === "snooze";
    let nextSel = selected;
    if (removing) {
      if (selected && ids.includes(selected)) {
        const idx = threads.findIndex((t) => t.threadId === selected);
        const rest = threads.filter((t) => !ids.includes(t.threadId));
        const pick = prefs.afterAction === "list" ? null : prefs.afterAction === "previous" ? rest[Math.max(idx - 1, 0)] : rest[Math.min(idx, rest.length - 1)];
        nextSel = pick?.threadId ?? null;
      }
      set({ threads: threads.filter((t) => !ids.includes(t.threadId)), checked: new Set() });
    }

    if (moveLike) {
      // hide now, run on the server after the Undo window (the backend also flushes this on quit)
      const scope = scopeOf(folder);
      const real = action === "trash" && scope === "trash" ? "delete_forever" : action;
      try {
        const token = await api.queueAction(ids, real, arg ?? null, scope ?? null, prefs.undoActionSeconds);
        if (label) {
          get().showToast(
            label,
            () => {
              void api.cancelAction(token).then(() => get().refresh());
            },
            "success",
          );
        }
      } catch (e) {
        get().showToast(`Failed: ${friendlyError(e)}`, undefined, "error");
        await get().refresh();
      }
      if (selected && ids.includes(selected)) await get().select(nextSel);
      return;
    }

    try {
      await api.threadAction(ids, action, arg, scopeOf(folder));
      if (label) {
        get().showToast(label, action === "snooze" ? () => void get().act(ids, "unsnooze") : undefined, "success");
      }
    } catch (e) {
      get().showToast(`Failed: ${friendlyError(e)}`, undefined, "error");
    }
    if (removing && selected && ids.includes(selected)) await get().select(nextSel);
    await get().refresh();
  },

  openCompose: async (compose) => {
    const st = get();
    if (compose && !hasMailAccounts(st.accounts.length)) return; // no account: there is nothing to send with
    if (compose && st.compose && st.composeDirty) {
      const choice = await st.choose({
        title: "You have an unsent message",
        body: "Opening another message will close the one you are writing.",
        choices: [
          { id: "keep", label: "Keep writing" },
          { id: "save", label: "Save draft and continue", kind: "primary" },
          { id: "discard", label: "Discard", kind: "danger" },
        ],
      });
      if (choice === "keep") return;
      if (choice === "save") await get().composeSaver?.();
    }
    set({ compose, composeKey: get().composeKey + 1, composeDirty: false, composeSaver: null });
  },

  setComposeDirty: (composeDirty) => set({ composeDirty }),
  setComposeSaver: (composeSaver) => set({ composeSaver }),
  setDialog: (dialog) => set({ dialog }),
  setCommandOpen: (commandOpen) => set({ commandOpen }),
  setRibbonTab: (ribbonTab) => set({ ribbonTab }),

  showToast: (text, undo, kind, actions) => {
    const k: Toast["kind"] = kind ?? (/^(failed|sync error|send failed|schedule failed|save|unsubscribe failed|cannot)/i.test(text) ? "error" : "info");
    const acts = actions?.slice(0, 2);
    // a toast with buttons stays long enough to be read and clicked
    const ttl = undo ? Math.max(5000, get().prefs.undoActionSeconds * 1000) : acts?.length || k === "error" ? 8000 : 4500;
    const id = ++toastSeq;
    // newest last; keep a short stack and never evict a toast that still has an Undo
    set((s) => ({ toasts: [...s.toasts.filter((t) => t.undo || t.sticky || s.toasts.length < 4), { id, text, kind: k, undo, actions: acts, ttl }].slice(-5) }));
    setTimeout(() => get().dismissToast(id), ttl);
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  setStickyToast: (key, spec) =>
    set((s) => {
      const others = s.toasts.filter((t) => t.key !== key);
      if (!spec) return { toasts: others };
      const old = s.toasts.find((t) => t.key === key);
      const toast: Toast = { id: old?.id ?? ++toastSeq, text: spec.text, kind: spec.kind ?? "info", actions: spec.actions, ttl: 0, sticky: true, key, onDismiss: spec.onDismiss, closeLabel: spec.closeLabel, escCloses: spec.escCloses };
      // in place when it exists (the countdown changes its text every second), else on top of the stack
      return { toasts: old ? s.toasts.map((t) => (t.key === key ? toast : t)) : [...others, toast].slice(-5) };
    }),

  beginSend: (flush) => {
    set((s) => ({ sendsInFlight: s.sendsInFlight + 1 }));
    if (flush) sendFlushers.add(flush);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (flush) sendFlushers.delete(flush);
      set((s) => ({ sendsInFlight: Math.max(0, s.sendsInFlight - 1) }));
    };
  },

  choose: (o) =>
    new Promise<string>((resolve) => {
      set({ ask: { title: o.title, body: o.body, choices: o.choices, resolve } });
    }),

  confirm: async (o) => {
    const id = await get().choose({
      title: o.title,
      body: o.body,
      choices: [
        { id: "no", label: "Cancel" },
        { id: "yes", label: o.confirmLabel ?? "OK", kind: o.danger ? "danger" : "primary" },
      ],
    });
    return id === "yes";
  },

  resolveAsk: (id) => {
    const a = get().ask;
    set({ ask: null });
    a?.resolve(id);
  },

  askPassphrase: (o) =>
    new Promise<boolean>((resolve) => {
      set({ passphrase: { ...o, resolve } });
    }),

  resolvePassphrase: (unlocked) => {
    const p = get().passphrase;
    set({ passphrase: null });
    if (unlocked) get().bumpKeys();
    p?.resolve(unlocked);
  },

  bumpKeys: () => set((s) => ({ keysRev: s.keysRev + 1 })),

  replaceMessage: (m) => set((s) => ({ messages: s.messages.map((x) => (x.id === m.id ? m : x)) })),

  setPrefs: (patch) => {
    const prefs = { ...get().prefs, ...patch };
    // a new cap: mailboxes that were stopped by the old one are asked again
    if ("maxDownload" in patch && patch.maxDownload !== get().prefs.maxDownload) set({ limited: {} });
    set({ prefs });
    applyPrefs(prefs);
    void api.setSetting("prefs", JSON.stringify(prefs));
    mirrorSettings(patch);
    const layoutKeys: (keyof Prefs)[] = ["conversations", "focused", "sortAsc"];
    if (layoutKeys.some((k) => k in patch)) {
      // a different list (order, grouping): the old lines are dropped so the list starts at the top instead of keeping a place that no longer means anything
      set({ threads: [], loading: true });
      void get().refresh();
    }
  },
}));

// The account list decides whether mail controls exist (see mailControls.ts). When the last account goes, whatever belonged to it
// (an open search, selection, compose window, calendar module) is dropped, so the first account added later starts clean; the tray's
// "New mail" and "Check mail now" follow the same state.
useStore.subscribe((s, prev) => {
  if (!s.loaded) return;
  const had = hasMailAccounts(prev.accounts.length);
  const has = hasMailAccounts(s.accounts.length);
  if (had === has && prev.loaded) return;
  void api.setMailAvailable(has).catch(() => undefined);
  if (!prev.loaded) return; // the first read at start-up is not a change
  // the saved module is Mail in the zero-account state and after the first account (Calendar is a mail-app module)
  if (had !== has) useStore.getState().setModule("mail");
  if (had && !has) {
    // an open Compose is closed WITHOUT saving: the account's local copy is gone, and the pane unmounts with the workspace
    useStore.setState({
      search: "", selected: null, messages: [], threads: [], checked: new Set(), compose: null, composeDirty: false, composeSaver: null,
      commandOpen: false, accountId: null, folder: "inbox", filter: "all", firstSync: null, dialog: s.dialog?.type === "settings" ? { type: "settings", tab: "add-account", nonce: Date.now() } : s.dialog,
    });
  }
});
