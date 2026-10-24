// The results of a search in a window of its own (W4.6, REQ-4.6.13 to 4.6.16): the search as the main window had it when the button was pressed (text with its operators, scope, view,
// mailbox, filter), run again from the backend whenever the mail changes; the rows look like the main list's (ThreadRow, the density and the sort of the preferences), without a reading pane.
// The main window keeps its own search. A result opens in a reader window (a draft in a compose window); the hover buttons and the keys e # * u p go to the main window as the
// reader's do (Archive, Delete ... with the Undo toast of the main window); j / k move the selection, Esc closes the window. No multi-select and no context menu in 1.0.7.
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { SearchX } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type ThreadSummary } from "../api";
import { HoverActions, ThreadRow } from "../components/MessageList";
import { EmptyState } from "../components/overlays";
import { VirtualList, type VItem } from "../components/VirtualList";
import { accountLabel } from "../accountLabel";
import { openDraftInWindow } from "../draftOpen";
import { t as tNow } from "../i18n";
import { useLang, useT } from "../i18n/react";
import { accountColor } from "../prefs";
import { useStore } from "../store";
import { askMain } from "./readerBridge";
import { rowWindowTarget } from "./readerLogic";
import { openReader } from "./openReader";
import { popoutTitle } from "./route";
import { searchInit, type SearchInit } from "./windowKinds";
import type { PopoutViewProps } from "./views";

const quiet = () => undefined;

/** The toast the main window makes for a move asked from here (the keys of the reader's toolbar; the main window checks them, requestKinds.ts `READER_LABELS`). */
const LABEL_OF: Record<string, string> = { archive: "reading.head.archived", trash: "reading.head.trashed", junk: "reading.head.movedJunk", unread: "reading.head.markedUnread" };
const MOVES = new Set(["archive", "trash", "junk", "snooze"]);

type Item = VItem & { kind: "row"; t: ThreadSummary; pos: number };

export default function SearchView({ init }: PopoutViewProps) {
  const spec = useMemo(() => searchInit(init), [init]);
  if (!spec) return <div className="popout-root" role="alert" data-popout="failed" />;
  return <Results spec={spec} />;
}

function Results({ spec }: { spec: SearchInit }) {
  const t = useT();
  const lang = useLang();
  const prefs = useStore((s) => s.prefs);
  const accounts = useStore((s) => s.accounts);
  const [rows, setRows] = useState<ThreadSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;
  const rowsRef = useRef<ThreadSummary[]>([]);
  rowsRef.current = rows ?? [];

  const title = t("mail.list.searchResults");
  useEffect(() => {
    const w = popoutTitle(title);
    document.title = w;
    void getCurrentWindow().setTitle(w).catch(quiet);
  }, [title, lang]);

  // the results, from the backend; the same call the main list makes for this search (no tab, the filter of the search box)
  const load = useCallback(async () => {
    try {
      const p = useStore.getState().prefs;
      const list = await api.listThreads({
        accountId: spec.accountId,
        folder: spec.folder,
        search: spec.search,
        focus: null,
        flat: !p.conversations,
        unreadOnly: spec.filter === "unread",
        flaggedOnly: spec.filter === "flagged",
        sortAsc: p.sortAsc,
        scope: spec.scope,
      });
      setRows(list);
      // a selection that is not in the results any more is dropped
      if (selectedRef.current && !list.some((x) => x.threadId === selectedRef.current)) setSelected(null);
    } catch {
      setRows((r) => r ?? []);
    }
  }, [spec]);

  useEffect(() => {
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 250); // (a sync or a burst of actions: one run after a short pause)
    };
    // what the rows need from the store of this window: the search it shows (the row labels), the mailboxes and folders (colours, names), and the actions of the hover
    // buttons asked of the main window (it owns the intent layer and the Undo toast)
    useStore.setState({
      folder: spec.folder,
      accountId: spec.accountId,
      search: spec.search,
      act: async (ids, action, arg, _label, view) => {
        for (const id of ids) {
          const labelKey = LABEL_OF[action];
          await askMain("thread-action", { threadId: id, action, arg, labelKey, view: view ?? spec.folder }, 30_000);
        }
        // a move takes the row out of the results at once; the rest is read again
        if (MOVES.has(action)) setRows((r) => (r ? r.filter((x) => !ids.includes(x.threadId)) : r));
        soon();
      },
    });
    void (async () => {
      const [a, f] = await Promise.all([api.listAccounts().catch(() => null), api.listFolders().catch(() => null)]);
      if (dead) return;
      if (a) useStore.setState({ accounts: a });
      if (f) useStore.setState({ folders: f });
      await load();
    })();
    const subs = [listen("mail-synced", soon), listen("thread-state", soon), listen("data-changed", soon)];
    return () => {
      dead = true;
      clearTimeout(timer);
      for (const s of subs) void s.then((off) => off()).catch(quiet);
    };
  }, [load, spec]);

  const open = useCallback((x: ThreadSummary) => {
    const target = rowWindowTarget(spec.folder, x.folder);
    if (target === "draft") void openDraftInWindow(x.threadId);
    else if (target === "reader") void openReader(x, spec.folder);
  }, [spec.folder]);

  // the keys of the list (REQ-4.6.15): j / k select, Enter opens, e # * u p act on the selected row, Esc closes the window; nothing while typing or behind a dialog
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const tgt = e.target;
      if (tgt instanceof Element && tgt.closest("input,textarea,select,[contenteditable=true]")) return;
      const st = useStore.getState();
      if (st.dialog || st.ask) return;
      const list = rowsRef.current;
      const at = list.findIndex((x) => x.threadId === selectedRef.current);
      const cur = at >= 0 ? list[at] : null;
      const act = (action: string) => cur && void st.act([cur.threadId], action, undefined, undefined, spec.folder);
      switch (e.key) {
        case "Escape": return void getCurrentWindow().close().catch(quiet);
        case "j": case "ArrowDown": {
          const next = list[Math.min(list.length - 1, at + 1)];
          if (next) (e.preventDefault(), setSelected(next.threadId));
          return;
        }
        case "k": case "ArrowUp": {
          const prev = list[Math.max(0, at - 1)];
          if (prev) (e.preventDefault(), setSelected(prev.threadId));
          return;
        }
        case "Enter": return cur ? (e.preventDefault(), e.stopPropagation(), open(cur)) : undefined;
        case "e": return act("archive");
        case "#": case "Delete": return act("trash");
        case "*": return act(cur?.flagged ? "unstar" : "star");
        case "u": return act(cur && cur.unread > 0 ? "read" : "unread");
        case "p": return act(cur?.pinned ? "unpin" : "pin");
      }
    };
    // (in the capture phase: the row's own Enter selects it, here Enter opens it)
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, spec.folder]);

  const mixed = spec.accountId === null && accounts.length > 1;
  const colors = useMemo(() => new Map(accounts.map((a) => [a.id, accountColor(a, prefs.accent)])), [accounts, prefs.accent]);
  const labels = useMemo(() => new Map(accounts.map((a) => [a.id, accountLabel(a).text])), [accounts]);
  const items: Item[] = useMemo(() => (rows ?? []).map((x, i) => ({ key: x.threadId, kind: "row" as const, group: "", t: x, pos: i + 1 })), [rows]);
  const scopeNote = spec.scope === "all" ? t("mail.list.scopeAll") : spec.scope === "account" ? t("mail.list.scopeAccount") : t("mail.list.scopeFolder", { folder: spec.folder });

  return (
    <div className="reader-win search-win" data-popout="search">
      <div className="ml-head">
        <div className="ml-title"><h1 className="ellipsis">{title}</h1></div>
        {/* the search text, read-only (REQ-4.6.14) */}
        <div className="ml-sub">
          <span className="sw-query ellipsis" aria-label={t("mail.list.searchResults")}>{spec.search}</span>
          {rows && <span className="muted"> · {scopeNote} · {rows.length}</span>}
        </div>
      </div>
      <section className="msg-list" aria-label={title}>
        <div className="ml-body" ref={scrollRef} role="listbox" aria-label={title}>
          {rows && rows.length === 0 ? (
            <EmptyState icon={<SearchX size={40} />} title={tNow("mail.empty.noResults")} text={spec.scope === "all" ? t("mail.empty.searchedAll") : t("mail.empty.searchHint")} />
          ) : (
            <VirtualList
              scrollRef={scrollRef}
              items={items}
              viewKey={`${spec.search}|${spec.scope}`}
              reveal={selected}
              render={(it) => (
                <ThreadRow
                  t={it.t}
                  prefs={prefs}
                  selected={selected === it.t.threadId}
                  checked={false}
                  showFolder
                  accountColor={mixed ? colors.get(it.t.accountId) ?? accountColor(null, prefs.accent) : null}
                  accountLabel={labels.get(it.t.accountId)}
                  hover={<HoverActions t={it.t} />}
                  onOpen={() => setSelected(it.t.threadId)}
                  onOpenWindow={() => open(it.t)}
                  posInSet={it.pos}
                  setSize={items.length}
                />
              )}
            />
          )}
        </div>
      </section>
    </div>
  );
}
