import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import "./App.css";
import { forwardLast, replyLast, targets } from "./actions";
import { CommandBar } from "./components/CommandBar";
import { Compose } from "./components/Compose";
import { BulkCleaner, ShowOriginal } from "./components/Dialogs";
import { FolderPane } from "./components/FolderPane";
import { MessageList } from "./components/MessageList";
import { AskHost, Toasts } from "./components/overlays";
import { ReadingPane } from "./components/ReadingPane";
import { Ribbon } from "./components/Ribbon";
import { Settings } from "./components/SettingsDialog";
import { TopBar } from "./components/TopBar";
import { Welcome } from "./components/Welcome";
import { useStore } from "./store";
import { configureDates } from "./util";

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Drag handle between two panes; the width is committed (saved) on release. */
function Splitter({ label, value, min, max, onLive, onCommit }: { label: string; value: number; min: number; max: number; onLive: (w: number) => void; onCommit: (w: number) => void }) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      onPointerDown={(e) => {
        drag.current = { x: e.clientX, w: value };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => drag.current && onLive(clamp(drag.current.w + e.clientX - drag.current.x, min, max))}
      onPointerUp={(e) => {
        if (!drag.current) return;
        onCommit(clamp(drag.current.w + e.clientX - drag.current.x, min, max));
        drag.current = null;
      }}
      onDoubleClick={() => onCommit(label.startsWith("Folder") ? 248 : 392)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onCommit(clamp(value - 16, min, max));
        if (e.key === "ArrowRight") onCommit(clamp(value + 16, min, max));
      }}
    />
  );
}

function App() {
  const compose = useStore((s) => s.compose);
  const composeKey = useStore((s) => s.composeKey);
  const dialog = useStore((s) => s.dialog);
  const commandOpen = useStore((s) => s.commandOpen);
  const prefs = useStore((s) => s.prefs);
  const loaded = useStore((s) => s.loaded);
  const hasAccounts = useStore((s) => s.accounts.length > 0);
  const setPrefs = useStore((s) => s.setPrefs);
  const [live, setLive] = useState<{ f?: number; l?: number }>({});

  configureDates(prefs);

  useEffect(() => {
    void useStore.getState().init();
  }, []);

  useEffect(() => {
    // periodic mail fetching, toasts and the tray badge live in the backend; this only re-reads local state
    const tick = setInterval(() => void useStore.getState().refresh(), 30 * 1000);
    return () => clearInterval(tick);
  }, []);

  // events from the tray menu, toasts and the background workers
  useEffect(() => {
    const open = async (threadId: string) => {
      await useStore.getState().setView("inbox", null);
      await useStore.getState().select(threadId);
    };
    const subs = [
      listen("mail-synced", () => void useStore.getState().refresh()),
      listen("tray-compose", () => {
        const st = useStore.getState();
        void st.openCompose({ accountId: st.prefs.defaultAccount || undefined });
      }),
      listen<string>("action-failed", (e) => useStore.getState().showToast(`Failed: ${e.payload}`, undefined, "error")),
      listen<{ threadId: string }>("open-thread", (e) => void open(e.payload.threadId)),
      listen<{ threadId: string }>("notify-reply", async (e) => {
        await open(e.payload.threadId);
        replyLast();
      }),
    ];
    return () => {
      subs.forEach((p) => void p.then((off) => off()).catch(() => undefined));
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        st.setCommandOpen(true);
        return;
      }
      if (e.key === "F5") {
        e.preventDefault();
        void st.sync();
        return;
      }
      const t = e.target as HTMLElement;
      if (t.closest("input,textarea,select,[contenteditable=true]")) return;
      if (st.compose || st.dialog || st.commandOpen || st.ask) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        st.setChecked(st.threads.map((x) => x.threadId));
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const ids = targets();
      const idx = st.threads.findIndex((x) => x.threadId === st.selected);
      const cur = st.threads[idx];
      switch (e.key) {
        case "c": e.preventDefault(); void st.openCompose({ accountId: st.prefs.defaultAccount || st.accountId || undefined }); break;
        case "/": e.preventDefault(); document.getElementById("search-input")?.focus(); break;
        case "j": void st.select(st.threads[Math.min(idx + 1, st.threads.length - 1)]?.threadId ?? null); break;
        case "k": void st.select(st.threads[Math.max(idx - 1, 0)]?.threadId ?? null); break;
        case "e": void st.act(ids, "archive", undefined, "Archived"); break;
        case "#": case "Delete": void st.act(ids, "trash", undefined, "Moved to Deleted Items"); break;
        case "!": void st.act(ids, "junk", undefined, "Moved to Junk"); break;
        case "u": void st.act(ids, "unread"); break;
        case "p": void st.act(ids, cur?.pinned ? "unpin" : "pin"); break;
        case "*": void st.act(ids, cur?.flagged ? "unstar" : "star"); break;
        case "s": document.querySelector<HTMLButtonElement>('.reading-pane button[title^="Snooze"]')?.click(); break;
        case "r": replyLast(false); break;
        case "a": replyLast(true); break;
        case "f": forwardLast(); break;
        case "Escape": st.setChecked([]); void st.select(null); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!loaded) return <div className="app-loading">Hey Look!</div>;

  const fw = live.f ?? prefs.folderW;
  const lw = live.l ?? prefs.listW;
  return (
    <div className={`app pane-${prefs.readingPane}`}>
      <TopBar />
      {hasAccounts ? (
        <>
          <Ribbon />
          <div className="workspace" style={{ ["--fw" as string]: `${fw}px`, ["--lw" as string]: `${lw}px` }}>
            <FolderPane />
            <Splitter label="Folder pane width" value={fw} min={180} max={360} onLive={(w) => setLive((s) => ({ ...s, f: w }))} onCommit={(w) => (setLive((s) => ({ ...s, f: undefined })), setPrefs({ folderW: w }))} />
            <MessageList />
            {prefs.readingPane === "right" && (
              <Splitter label="Message list width" value={lw} min={300} max={680} onLive={(w) => setLive((s) => ({ ...s, l: w }))} onCommit={(w) => (setLive((s) => ({ ...s, l: undefined })), setPrefs({ listW: w }))} />
            )}
            <div className="reading-region">
              {compose ? <Compose key={composeKey} init={compose} /> : <ReadingPane />}
            </div>
          </div>
        </>
      ) : (
        <Welcome />
      )}
      {dialog?.type === "settings" && <Settings initial={dialog.tab} focus={dialog.focus} />}
      {dialog?.type === "cleaner" && <BulkCleaner />}
      {dialog?.type === "original" && <ShowOriginal messageId={dialog.messageId} />}
      {commandOpen && <CommandBar />}
      <AskHost />
      <Toasts />
    </div>
  );
}

export default App;
