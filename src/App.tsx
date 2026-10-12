import { useEffect } from "react";
import "./App.css";
import { CommandBar } from "./components/CommandBar";
import { Compose } from "./components/Compose";
import { Settings } from "./components/Settings";
import { Sidebar } from "./components/Sidebar";
import { ThreadList } from "./components/ThreadList";
import { ThreadView } from "./components/ThreadView";
import { useStore } from "./store";
import { quoteHtml, splitAddrs } from "./util";

function App() {
  const s = useStore();

  useEffect(() => {
    void s.init();
    const poll = setInterval(() => void useStore.getState().sync(), 2 * 60 * 1000);
    const tick = setInterval(() => void useStore.getState().refresh(), 30 * 1000); // surfaces snoozed/scheduled changes
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      if (t.closest("input,textarea,select,[contenteditable=true]") || e.ctrlKey || e.metaKey || e.altKey) return;
      if (st.compose || st.settingsOpen || st.commandOpen) return;
      const ids = st.selected ? [st.selected] : [];
      const idx = st.threads.findIndex((x) => x.threadId === st.selected);
      const cur = st.threads[idx];
      const last = st.messages[st.messages.length - 1];
      switch (e.key) {
        case "c": e.preventDefault(); st.openCompose({}); break;
        case "/": e.preventDefault(); document.getElementById("search-input")?.focus(); break;
        case "j": void st.select(st.threads[Math.min(idx + 1, st.threads.length - 1)]?.threadId ?? null); break;
        case "k": void st.select(st.threads[Math.max(idx - 1, 0)]?.threadId ?? null); break;
        case "e": void st.act(ids, "archive", undefined, "Archived"); break;
        case "#": void st.act(ids, "trash", undefined, "Moved to trash"); break;
        case "!": void st.act(ids, "junk", undefined, "Moved to junk"); break;
        case "u": void st.act(ids, "unread"); break;
        case "p": void st.act(ids, cur?.pinned ? "unpin" : "pin"); break;
        case "*": void st.act(ids, cur?.flagged ? "unstar" : "star"); break;
        case "s": if (ids.length) document.querySelector<HTMLButtonElement>('button[title^="Snooze"]')?.click(); break;
        case "r":
        case "a":
          if (last) {
            const mine = new Set(st.accounts.map((a) => a.email.toLowerCase()));
            const all = e.key === "a";
            st.openCompose({
              accountId: last.accountId,
              to: all ? Array.from(new Set([last.fromEmail, ...splitAddrs(last.to)])).filter((x) => !mine.has(x.toLowerCase())) : [last.fromEmail],
              cc: all ? splitAddrs(last.cc).filter((x) => !mine.has(x.toLowerCase())) : [],
              subject: /^re:/i.test(last.subject) ? last.subject : `Re: ${last.subject}`,
              bodyHtml: quoteHtml(last),
              inReplyTo: last.messageId,
              references: st.messages.map((m) => m.messageId).filter(Boolean) as string[],
            });
          }
          break;
        case "Escape": void st.select(null); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app">
      <Sidebar />
      <ThreadList />
      <ThreadView />
      {s.compose && <Compose key={JSON.stringify(s.compose).length + String(s.compose.subject)} init={s.compose} />}
      {s.settingsOpen && <Settings />}
      {s.commandOpen && <CommandBar />}
      {s.toast && (
        <div className="toast">
          {s.toast.text}
          {s.toast.undo && (
            <button className="link" onClick={() => { s.toast?.undo?.(); useStore.setState({ toast: null }); }}>
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
