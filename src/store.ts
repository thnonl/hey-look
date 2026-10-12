import { create } from "zustand";
import { api, Account, Att, CalendarInfo, CalEvent, DraftSecurity, FolderInfo, Meeting, MessageFull, OutboxItem, SearchScope, ThreadSummary } from "./api";
import { calTz, CalView, Day, rangeFor, systemTz, today } from "./calendar";
import { accentText, buttonAccent, DEFAULT_PREFS, lightened, mergePrefs, Prefs, readableOn, topBar, validHex } from "./prefs";

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
  | { type: "settings"; tab?: string; focus?: string }
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
  // backend errors are "CODE: human text"; a few PGP ones carry data instead ("PGP_MISSING_KEYS:a@b.c,d@e.f")
  if (/^PGP_LOCKED:/.test(raw)) return "Your encryption key is locked. Unlock it and try again.";
  if (/^PGP_MISSING_KEYS:/.test(raw)) return `No public key for ${raw.slice("PGP_MISSING_KEYS:".length).split(",").join(", ")}.`;
  raw = raw.replace(/^[A-Z][A-Z_]+:\s+/, "");
  if (/login failed|authenticationfailed|invalid credentials|auth.*fail/i.test(raw))
    return "Sign-in failed. Check the password (Gmail, iCloud and Yahoo need an app password) or sign in again.";
  if (/no stored (password|\w+ token)/i.test(raw)) return "The saved credentials for this account are missing. Remove the account and add it again.";
  if (/timed out|timeout|10060|did not properly respond/i.test(raw)) return "The mail server did not respond. Check your connection and try again.";
  if (/lookup|dns|no such host|name or service not known|11001/i.test(raw)) return "Cannot reach the mail server. Check the server name and your connection.";
  if (/certificate|tls|ssl/i.test(raw) && /invalid|verify|unknown|expired/i.test(raw)) return "The server's security certificate was rejected. For a self-signed or private-CA server, remove the account and add it again with \"Trust this server's certificate\" turned on.";
  return raw.length > 220 ? `${raw.slice(0, 220)}…` : raw;
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
  loadingOlder: boolean;
  syncing: boolean;
  syncErrors: Record<string, string>;
  toasts: Toast[];
  ask: AskState | null;
  passphrase: PassphraseAsk | null;
  /** bumps whenever keys are added, removed or unlocked, so key-dependent views refetch */
  keysRev: number;
  compose: ComposeInit | null;
  composeKey: number; // changes on every open so a new message never inherits the old one's state
  composeDirty: boolean;
  composeSaver: (() => Promise<void>) | null;
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
  calLoading: boolean;
  calError: string | null;
  /** bumps when the calendar changed behind the view's back (sync, respond, save) */
  calRev: number;

  init: () => Promise<void>;
  setView: (folder: string, accountId?: string | null) => Promise<void>;
  setSearch: (q: string, remember?: boolean) => Promise<void>;
  setSearchScope: (s: SearchScope) => Promise<void>;
  setFocus: (f: "focused" | "other") => Promise<void>;
  setFilter: (f: "all" | "unread" | "flagged") => Promise<void>;
  refresh: () => Promise<void>;
  sync: () => Promise<void>;
  loadOlder: () => Promise<void>;
  select: (id: string | null) => Promise<void>;
  toggleCheck: (id: string) => void;
  setChecked: (ids: string[]) => void;
  act: (ids: string[], action: string, arg?: string, label?: string) => Promise<void>;
  openCompose: (c: ComposeInit | null) => Promise<void>;
  setComposeDirty: (d: boolean) => void;
  setComposeSaver: (f: (() => Promise<void>) | null) => void;
  setDialog: (d: Dialog) => void;
  setCommandOpen: (o: boolean) => void;
  setRibbonTab: (t: RibbonTab) => void;
  showToast: (text: string, undo?: () => void, kind?: Toast["kind"], actions?: ToastAction[]) => void;
  dismissToast: (id: number) => void;
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
  /** Re-read the open conversation without clearing it (an invitation's state changed). */
  reloadMessages: () => Promise<void>;
}

let toastSeq = 0;
let readTimer: ReturnType<typeof setTimeout> | undefined;

/** Preferences the backend acts on (saving, retries, quit) are also stored as plain settings. */
const BACKEND_SETTINGS: [keyof Prefs, string, (v: unknown) => string][] = [
  ["downloadDir", "download_dir", (v) => (typeof v === "string" ? v : "")],
  ["warnExecutables", "warn_executables", (v) => (v ? "1" : "0")],
  ["scheduledCatchUp", "scheduled_catchup", (v) => String(v)],
  ["retryScheduled", "scheduled_retry", (v) => (v ? "1" : "0")],
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
  loadingOlder: false,
  syncing: false,
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
  calendars: [],
  calLoading: false,
  calError: null,
  calRev: 0,

  init: async () => {
    const [accounts, rawPrefs] = await Promise.all([api.listAccounts(), api.getSetting("prefs")]);
    const prefs = mergePrefs(rawPrefs);
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
  },

  loadCalendar: async () => {
    const { prefs, calDate } = get();
    const tz = calTz(prefs);
    const { from, to } = rangeFor(prefs.calView, calDate, prefs.weekStart, tz);
    set({ calLoading: true });
    try {
      const [events, calendars] = await Promise.all([api.calendarListEvents(from, to), api.calendarListCalendars()]);
      // ignore a slow answer for a range the user already left
      const now = get();
      const cur = rangeFor(now.prefs.calView, now.calDate, now.prefs.weekStart, calTz(now.prefs));
      if (cur.from === from && cur.to === to) set({ calEvents: events, calendars, calError: null });
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
    set({ folder, accountId, selected: null, messages: [], threads: [], loading: true, checked: new Set(), search: "", module: "mail" });
    if (get().prefs.lastModule !== "mail") get().setPrefs({ lastModule: "mail" });
    await get().refresh();
  },

  setSearch: async (search, remember = false) => {
    set({ search, selected: null, messages: [], loading: true });
    if (remember && search.trim()) {
      const recent = [search.trim(), ...get().prefs.recentSearches.filter((r) => r !== search.trim())].slice(0, 8);
      get().setPrefs({ recentSearches: recent });
    }
    await get().refresh();
  },

  setSearchScope: async (searchScope) => {
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
      set({ syncing: false });
      await get().refresh();
    }
  },

  loadOlder: async () => {
    const { accountId, accounts, folder, loadingOlder } = get();
    if (loadingOlder || folder === "scheduled" || ["starred", "pinned", "snoozed", "all"].includes(folder)) return;
    const role = folder === "unread" ? "inbox" : folder;
    const targets = accountId ? [accountId] : accounts.map((a) => a.id);
    set({ loadingOlder: true });
    try {
      const counts = await Promise.all(targets.map((id) => api.loadOlder(id, role).catch(() => 0)));
      const added = counts.reduce((a, b) => a + b, 0);
      get().showToast(added > 0 ? `Loaded ${added} older message${added === 1 ? "" : "s"}` : "No older messages in this folder", undefined, added > 0 ? "success" : "info");
      await get().refresh();
    } finally {
      set({ loadingOlder: false });
    }
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
    set((s) => ({ toasts: [...s.toasts.filter((t) => t.undo || s.toasts.length < 4), { id, text, kind: k, undo, actions: acts, ttl }].slice(-5) }));
    setTimeout(() => get().dismissToast(id), ttl);
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

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
    set({ prefs });
    applyPrefs(prefs);
    void api.setSetting("prefs", JSON.stringify(prefs));
    mirrorSettings(patch);
    const layoutKeys: (keyof Prefs)[] = ["conversations", "focused", "sortAsc"];
    if (layoutKeys.some((k) => k in patch)) void get().refresh();
  },
}));
