import { create } from "zustand";
import { api, Account, FolderKey, MessageFull, OutboxItem, ThreadSummary } from "./api";

export interface ComposeInit {
  accountId?: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  bodyHtml?: string;
  inReplyTo?: string | null;
  references?: string[];
}

interface State {
  accounts: Account[];
  accountId: string | null; // null = unified
  folder: FolderKey;
  search: string;
  threads: ThreadSummary[];
  outbox: OutboxItem[];
  selected: string | null;
  checked: Set<string>;
  messages: MessageFull[];
  syncing: boolean;
  toast: { text: string; undo?: () => void } | null;
  compose: ComposeInit | null;
  settingsOpen: boolean;
  commandOpen: boolean;
  theme: "system" | "light" | "dark";
  undoSeconds: number;
  loadRemote: boolean;

  init: () => Promise<void>;
  setFolder: (f: FolderKey, accountId?: string | null) => Promise<void>;
  setSearch: (q: string) => Promise<void>;
  refresh: () => Promise<void>;
  sync: () => Promise<void>;
  select: (id: string | null) => Promise<void>;
  toggleCheck: (id: string) => void;
  act: (ids: string[], action: string, arg?: string, label?: string) => Promise<void>;
  openCompose: (c: ComposeInit | null) => void;
  setSettingsOpen: (o: boolean) => void;
  setCommandOpen: (o: boolean) => void;
  showToast: (text: string, undo?: () => void) => void;
  setTheme: (t: "system" | "light" | "dark") => void;
  setPref: (key: "undoSeconds" | "loadRemote", v: number | boolean) => void;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export const useStore = create<State>((set, get) => ({
  accounts: [],
  accountId: null,
  folder: "inbox",
  search: "",
  threads: [],
  outbox: [],
  selected: null,
  checked: new Set(),
  messages: [],
  syncing: false,
  toast: null,
  compose: null,
  settingsOpen: false,
  commandOpen: false,
  theme: "system",
  undoSeconds: 10,
  loadRemote: false,

  init: async () => {
    const [accounts, theme, undo, remote] = await Promise.all([
      api.listAccounts(),
      api.getSetting("theme"),
      api.getSetting("undo_seconds"),
      api.getSetting("load_remote"),
    ]);
    set({
      accounts,
      theme: (theme as State["theme"]) ?? "system",
      undoSeconds: undo ? Number(undo) : 10,
      loadRemote: remote === "1",
    });
    applyTheme(get().theme);
    if (accounts.length === 0) set({ settingsOpen: true });
    await get().refresh();
    void get().sync();
  },

  setFolder: async (folder, accountId = null) => {
    set({ folder, accountId, selected: null, messages: [], checked: new Set(), search: "" });
    await get().refresh();
  },

  setSearch: async (search) => {
    set({ search });
    await get().refresh();
  },

  refresh: async () => {
    const { folder, accountId, search } = get();
    if (folder === "scheduled") {
      set({ outbox: await api.listOutbox(), threads: [] });
      return;
    }
    const threads = await api.listThreads({ accountId, folder, search });
    set({ threads });
  },

  sync: async () => {
    const { accounts, syncing } = get();
    if (syncing || accounts.length === 0) return;
    set({ syncing: true });
    try {
      const results = await Promise.allSettled(accounts.map((a) => api.syncAccount(a.id)));
      const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
      if (failed) get().showToast(`Sync error: ${failed.reason}`);
    } finally {
      set({ syncing: false });
      await get().refresh();
    }
  },

  select: async (id) => {
    set({ selected: id, messages: [] });
    if (!id) return;
    const messages = await api.getThread(id);
    set({ messages });
    if (messages.some((m) => !m.seen)) {
      await api.threadAction([id], "read");
      set({ messages: messages.map((m) => ({ ...m, seen: true })) });
      await get().refresh();
    }
  },

  toggleCheck: (id) => {
    const c = new Set(get().checked);
    c.has(id) ? c.delete(id) : c.add(id);
    set({ checked: c });
  },

  act: async (ids, action, arg, label) => {
    if (ids.length === 0) return;
    const removing = ["archive", "trash", "junk", "inbox", "snooze", "block", "delete_forever"].includes(action);
    if (removing) {
      set((s) => ({
        threads: s.threads.filter((t) => !ids.includes(t.threadId)),
        selected: s.selected && ids.includes(s.selected) ? null : s.selected,
        messages: s.selected && ids.includes(s.selected) ? [] : s.messages,
        checked: new Set(),
      }));
    }
    try {
      await api.threadAction(ids, action, arg);
      if (label) get().showToast(label);
    } catch (e) {
      get().showToast(`Failed: ${e}`);
    }
    await get().refresh();
    if (removing && action !== "snooze") void get().sync();
  },

  openCompose: (compose) => set({ compose }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setCommandOpen: (commandOpen) => set({ commandOpen }),

  showToast: (text, undo) => {
    clearTimeout(toastTimer);
    set({ toast: { text, undo } });
    toastTimer = setTimeout(() => set({ toast: null }), undo ? 8000 : 4000);
  },

  setTheme: (theme) => {
    set({ theme });
    applyTheme(theme);
    void api.setSetting("theme", theme);
  },

  setPref: (key, v) => {
    set({ [key]: v } as Partial<State>);
    void api.setSetting(key === "undoSeconds" ? "undo_seconds" : "load_remote", key === "loadRemote" ? (v ? "1" : "0") : String(v));
  },
}));

function applyTheme(t: "system" | "light" | "dark") {
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
}
