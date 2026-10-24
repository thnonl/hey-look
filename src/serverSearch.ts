import { create } from "zustand";
import { api, type ServerRow, type ServerSearchResult, type ThreadSummary } from "./api";
import { openReader } from "./popout/openReader";
import { friendlyError, useStore } from "./store";
import { t } from "./i18n";

// "Search on the server" (1.0.7 W6.7): the state of the section at the end of the search results. Never started by itself: the page asks (the button). The results belong to the
// search they were made for (`keyOf`): a different search text, scope, mailbox or folder drops them and the button returns. Nothing is stored before a row is opened.

export type ServerPhase = "idle" | "running" | "done";

interface State {
  /** the search the rows belong to */
  key: string;
  phase: ServerPhase;
  rows: ServerRow[];
  capped: boolean;
  errors: ServerSearchResult["errors"];
  localOnly: boolean;
  /** the row being downloaded (its key) */
  opening: string | null;
  run: () => Promise<void>;
  cancel: () => void;
  /** drop everything (the search changed) */
  reset: () => void;
  /** the rows of a search for the current view only; [] when the results belong to another search */
  open: (row: ServerRow, inWindow?: boolean) => Promise<void>;
}

/** Most rows the server gives (the backend's `MAX_ROWS`): the text "Showing the newest {n}" says this number. */
export const SERVER_MAX_ROWS = 200;

/** The key of the search the page shows now: text, scope, mailbox and folder. */
function keyOf(): string {
  const s = useStore.getState();
  return [s.search.trim(), s.searchScope, s.accountId ?? "", s.folder].join("|");
}

export const rowKey = (r: ServerRow) => `srv:${r.accountId}:${r.role}:${r.uid}`;

/** A server row as the list's own row component draws it (no snippet, no count, not selected). */
export function summaryOf(r: ServerRow): ThreadSummary {
  return {
    threadId: rowKey(r),
    rowKey: rowKey(r),
    accountId: r.accountId,
    folder: r.role,
    bulk: false,
    subject: r.subject,
    participants: [r.fromName || r.fromEmail],
    snippet: "",
    lastDate: r.date,
    count: 1,
    unread: r.seen ? 0 : 1,
    flagged: r.flagged,
    pinned: false,
    snoozedUntil: null,
    hasAttach: r.hasAttach,
  };
}

let run = 0;

export const useServerSearch = create<State>((set, get) => ({
  key: "",
  phase: "idle",
  rows: [],
  capped: false,
  errors: [],
  localOnly: false,
  opening: null,

  run: async () => {
    if (get().phase === "running") return;
    const s = useStore.getState();
    const search = s.search.trim();
    if (!search) return;
    const key = keyOf();
    const mine = ++run;
    set({ key, phase: "running", rows: [], capped: false, errors: [], localOnly: false, opening: null });
    try {
      const r = await api.serverSearch({ accountId: s.accountId, folder: s.folder, search, scope: s.searchScope });
      // cancelled, or the person searched for something else meanwhile: the answer is dropped
      if (mine !== run || r.cancelled || keyOf() !== key) return;
      set({ phase: "done", rows: r.rows, capped: r.capped, errors: r.errors, localOnly: r.localOnly });
    } catch (e) {
      if (mine !== run) return;
      set({ phase: "done", rows: [], errors: [{ accountId: "", error: String((e as { message?: string } | null)?.message ?? e) }] });
    }
  },

  cancel: () => {
    run++;
    void api.serverSearchCancel().catch(() => undefined);
    set({ phase: "idle", rows: [], capped: false, errors: [], localOnly: false, opening: null });
  },

  reset: () => {
    if (get().phase === "running") {
      run++;
      void api.serverSearchCancel().catch(() => undefined);
    }
    set({ key: "", phase: "idle", rows: [], capped: false, errors: [], localOnly: false, opening: null });
  },

  open: async (row, inWindow = false) => {
    const k = rowKey(row);
    if (get().opening) return;
    set({ opening: k });
    try {
      const tid = await api.serverOpen(row.accountId, row.role, row.uid, row.validity);
      if (inWindow) await openReader({ ...summaryOf(row), threadId: tid }, useStore.getState().folder);
      else await useStore.getState().openMail(tid);
    } catch (e) {
      // the message is gone, or the folder changed: told, and the row goes
      useStore.getState().showToast(() => t("errors.toast.failed", { error: friendlyError(e) }), undefined, "error");
      set((s) => ({ rows: s.rows.filter((x) => rowKey(x) !== k) }));
    } finally {
      set({ opening: null });
    }
  },
}));

// A different search - text, scope, mailbox or folder - drops the results and the button returns (the section may be off screen or not drawn at that moment).
useStore.subscribe((s, prev) => {
  if (s.search.trim() === prev.search.trim() && s.searchScope === prev.searchScope && s.accountId === prev.accountId && s.folder === prev.folder) return;
  const st = useServerSearch.getState();
  if (st.phase !== "idle" || st.key) st.reset();
});
