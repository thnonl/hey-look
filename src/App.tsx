import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import "./App.css";
import { forwardLast, newMailAccount, replyLast, targets } from "./actions";
import { api, BackfillProgress } from "./api";
import { CalendarView, EventDialog, newEvent } from "./components/Calendar";
import { CommandBar } from "./components/CommandBar";
import { Compose } from "./components/Compose";
import { BulkCleaner, ShowOriginal } from "./components/Dialogs";
import { GenerateKeyDialog, ImportKeyDialog, KeyDetailsDialog, PassphraseHost } from "./components/Pgp";
import { FolderPane } from "./components/FolderPane";
import { MessageList } from "./components/MessageList";
import { AskHost, Toasts } from "./components/overlays";
import { ReadingPane } from "./components/ReadingPane";
import { Ribbon } from "./components/Ribbon";
import { Settings } from "./components/SettingsDialog";
import { TopBar } from "./components/TopBar";
import { Welcome } from "./components/Welcome";
import { hasMailAccounts, shortcutWorks } from "./mailControls";
import { flushSends, useStore } from "./store";
import { osNow } from "./platform";
import { useUpdates } from "./updates";
import { calTz, configureCalendar, addDays, addMonths, today as todayDay } from "./calendar";
import { catchupText, configureDates, fmtWhen } from "./util";
import { frameAction, initFrame, useFrame } from "./winframe";

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
  const module = useStore((s) => s.module);
  const setPrefs = useStore((s) => s.setPrefs);
  const customFrame = useFrame((f) => f.custom);
  const [live, setLive] = useState<{ f?: number; l?: number }>({});

  configureDates(prefs);
  configureCalendar(prefs);

  useEffect(() => {
    void useStore.getState().init();
    initFrame();
  }, []);

  // the page is up and has painted once: the backend shows the (hidden) window now, and reloads the page if this never arrives
  // (a timer, not requestAnimationFrame: a page in a hidden window gets no animation frames)
  useEffect(() => {
    const t = setTimeout(() => void api.frontendReady().catch(() => undefined), 50);
    // a moment after the window is shown, say whether this page is really painting (visible state + an animation frame): when it is
    // not, the backend hides and shows the window again (the black window after an updater relaunch)
    let check: ReturnType<typeof setTimeout> | undefined;
    const sub = listen("app-shown", () => {
      clearTimeout(check);
      check = setTimeout(async () => {
        const frames = await new Promise<boolean>((done) => {
          requestAnimationFrame(() => done(true));
          setTimeout(() => done(false), 700);
        });
        void api.pageState(document.visibilityState, frames).catch(() => undefined);
      }, 1500);
    });
    return () => {
      clearTimeout(t);
      clearTimeout(check);
      void sub.then((off) => off()).catch(() => undefined);
    };
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
      // the background download of older Inbox mail: a status line in the list and a quiet, throttled re-read of it
      listen<BackfillProgress>("backfill-progress", (e) => useStore.getState().onBackfill(e.payload)),
      listen("tray-compose", () => {
        const st = useStore.getState();
        if (!hasMailAccounts(st.accounts.length)) return; // no account: nothing to write with
        void st.openCompose({ accountId: newMailAccount() });
      }),
      listen<string>("action-failed", (e) => useStore.getState().showToast(`Failed: ${e.payload}`, undefined, "error")),
      listen<{ threadId: string }>("open-thread", (e) => void open(e.payload.threadId)),
      listen<{ threadId: string }>("notify-reply", async (e) => {
        await open(e.payload.threadId);
        replyLast();
      }),
      // scheduled sends: state changes from the worker, catch-up after a closed period, quit guard
      listen<{ id: string; status: string; error?: string }>("outbox-changed", (e) => {
        const st = useStore.getState();
        void st.refresh();
        if (e.payload.status !== "failed") return;
        const subject = st.outbox.find((o) => o.id === e.payload.id)?.subject || "(no subject)";
        st.showToast(`Scheduled message “${subject}” failed to send.`, undefined, "error", [
          { label: "Retry", run: () => void api.outboxRetry(e.payload.id).then(() => useStore.getState().refresh()) },
          { label: "Open", run: () => void useStore.getState().setView("scheduled") },
        ]);
      }),
      // the calendar changed behind the view's back: sync processed an invitation, a reply or a cancellation
      listen("calendar-changed", () => {
        const st = useStore.getState();
        st.bumpCal();
        if (st.messages.some((m) => m.invite)) void st.reloadMessages();
      }),
      listen<{ eventId: string; title: string; line: string; joinUrl?: string | null }>("event-reminder", (e) => {
        const st = useStore.getState();
        st.showToast(`${e.payload.title}${e.payload.line ? ` · ${e.payload.line}` : ""}`, undefined, "info", [
          // no account: the calendar is not on screen, so there is nothing to open
          ...(hasMailAccounts(st.accounts.length) ? [{ label: "Open", run: () => st.setModule("calendar") }] : []),
          ...(e.payload.joinUrl ? [{ label: "Join", run: () => void openUrl(e.payload.joinUrl as string).catch(() => undefined) }] : []),
        ]);
      }),
      // the chosen save folder is gone: attachments went to Downloads instead (said once per session and folder)
      listen<{ configured: string; used: string }>("download-dir-fallback", (e) => {
        const st = useStore.getState();
        st.showToast(`The attachment folder “${e.payload.configured}” isn’t available, so files are saved to ${e.payload.used} instead.`, undefined, "info", [
          { label: "Change folder", run: () => st.setDialog({ type: "settings", tab: "general" }) },
        ]);
      }),
      // The rest of a quit (REQ-48 b, c): a message being written is saved to Drafts (and the person is asked when that fails), then every
      // message still in its Undo time goes out now, for at most 20 s. The answer tells the backend whether the quit goes on.
      listen("flush-sends", async () => {
        let go = true;
        try {
          const s = useStore.getState();
          if (s.compose && s.composeDirty) {
            if (s.compose.outboxId) {
              // a scheduled message being edited stays as it was
              void api.showWindow().catch(() => undefined);
              void api.quitDialog(true).catch(() => undefined);
              const c = await s.choose({
                title: "Quit without saving your changes?",
                body: "Your changes to this scheduled message aren’t saved. It stays scheduled as it was.",
                choices: [
                  { id: "keep", label: "Keep editing", kind: "primary" },
                  { id: "quit", label: "Quit and discard changes", kind: "danger" },
                ],
              });
              void api.quitDialog(false).catch(() => undefined);
              go = c === "quit";
            } else {
              const saved = s.composeSaver ? await s.composeSaver({ quiet: true }) : false;
              if (saved === true) {
                await useStore.getState().openCompose(null);
              } else {
                void api.showWindow().catch(() => undefined);
                void api.quitDialog(true).catch(() => undefined);
                const c = await s.choose({
                  title: "Your message isn’t saved",
                  body: `Hey Look! couldn’t save it to Drafts (${useStore.getState().draftError || "unknown error"}). If you quit now, it’s lost.`,
                  choices: [
                    { id: "keep", label: "Keep writing", kind: "primary" },
                    { id: "quit", label: "Quit and discard", kind: "danger" },
                  ],
                });
                void api.quitDialog(false).catch(() => undefined);
                go = c === "quit";
                if (go) useStore.setState({ composeDirty: false });
              }
            }
          }
          if (go) {
            const n = useStore.getState().sendsInFlight;
            if (n > 0) {
              useStore.getState().showToast(n === 1 ? "Sending your message before Hey Look! quits…" : `Sending ${n} messages before Hey Look! quits…`, undefined, "info");
            }
            await flushSends(20_000);
          }
        } catch {
          /* quit anyway */
        } finally {
          void api.sendsFlushed(go).catch(() => undefined);
        }
      }),
      // messages that were in their Undo time when the last run ended went out now (REQ-49 d)
      listen<{ count: number }>("outbox-leftover", (e) => {
        const n = e.payload.count;
        useStore.getState().showToast(n === 1 ? "Sent 1 message that was still waiting to go out when Hey Look! closed." : `Sent ${n} messages that were still waiting to go out when Hey Look! closed.`, undefined, "success");
      }),
      // a filter whose action failed on new mail (once per filter and error per run, REQ-52)
      listen<string>("filter-failed", (e) => useStore.getState().showToast(e.payload, undefined, "error")),
      listen<{ count: number }>("outbox-catchup", (e) => {
        const st = useStore.getState();
        st.showToast(catchupText(e.payload.count), undefined, "success", [
          { label: "View", run: () => void st.setView("scheduled") },
        ]);
      }),
      listen<{ count: number; next: number | null }>("confirm-quit", async (e) => {
        const st = useStore.getState();
        const n = e.payload.count;
        const next = e.payload.next ? ` The next one is due ${fmtWhen(e.payload.next)}.` : "";
        const choice = await st.choose({
          title: `${n} message${n === 1 ? " is" : "s are"} scheduled`,
          body: `If you quit now, ${n === 1 ? "it" : "they"} will be sent the next time you open Hey Look!.${next}`,
          choices: [
            { id: "cancel", label: "Cancel" },
            { id: "keep", label: "Keep running in tray", kind: "primary" },
            { id: "quit", label: "Quit anyway", kind: "danger" },
          ],
        });
        if (choice === "quit") await api.quitNow();
        else await api.quitCancelled().catch(() => undefined); // Cancel / Keep running: nothing else happens, a later quit asks again
      }),
    ];
    return () => {
      subs.forEach((p) => void p.then((off) => off()).catch(() => undefined));
    };
  }, []);

  // update check: once about 8 s after the UI is ready, then whenever the window comes back (the backend throttles to once per 6 h)
  useEffect(() => {
    if (!loaded) return;
    // how the last update went (after an update restart) is told first, then the startup check runs
    const t0 = setTimeout(() => void useUpdates.getState().startupCheck(), 1000);
    const t = setTimeout(() => {
      const up = useUpdates.getState();
      up.markStartup();
      void up.checkUpdate("startup");
    }, 8000);
    return () => (clearTimeout(t0), clearTimeout(t));
  }, [loaded]);

  useEffect(() => {
    const shown = () => {
      const up = useUpdates.getState();
      if (!up.startupIssued) return; // the window gains focus at launch: that must not pre-empt the startup delay
      void up.checkUpdate("shown");
      up.announceUpdate();
    };
    const sub = listen("app-shown", shown);
    const onFocus = () => shown();
    window.addEventListener("focus", onFocus);
    const off = useFrame.subscribe((s, prev) => {
      if (s.focused && !prev.focused) shown();
    });
    return () => {
      void sub.then((un) => un()).catch(() => undefined);
      window.removeEventListener("focus", onFocus);
      off();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      const n = st.accounts.length;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        st.setCommandOpen(true);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "s" && st.selected && !st.compose && shortcutWorks(n, "mail-keys")) {
        // Save all attachments of the open conversation (the strip's "Save all" link)
        e.preventDefault();
        document.querySelector<HTMLButtonElement>(".att-strip-head .link-btn")?.click();
        return;
      }
      if (e.key === "F11") {
        e.preventDefault();
        frameAction.toggleFullscreen();
        return;
      }
      if (e.key === "F5") {
        e.preventDefault();
        if (shortcutWorks(n, "sync")) void st.sync();
        return;
      }
      // no account: no mail shortcut (search, new mail, navigation, actions, Ctrl+1 / 2 ...) is live
      if (!shortcutWorks(n, "mail-keys")) return;
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t.closest("input,textarea,select,[contenteditable=true]")) return;
      if (!st.dialog && !st.commandOpen && !st.ask && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === "1" || e.key === "2")) {
        e.preventDefault();
        st.setModule(e.key === "2" ? "calendar" : "mail");
        return;
      }
      if (st.compose || st.dialog || st.commandOpen || st.ask) return;
      if (st.module === "calendar" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Calendar: c new event, t today, ←/→ previous/next period, m / w / a Month / Week / Agenda
        const tz = calTz(st.prefs);
        const v = st.prefs.calView;
        const step = (dir: 1 | -1) => st.setCalDate(v === "month" ? addMonths(st.calDate, dir) : addDays(st.calDate, (v === "week" ? 7 : 30) * dir));
        const handled = ((): boolean => {
          switch (e.key) {
            case "c": newEvent(); return true;
            case "t": st.setCalDate(todayDay(tz)); return true;
            case "ArrowLeft": step(-1); return true;
            case "ArrowRight": step(1); return true;
            case "m": st.setCalView("month"); return true;
            case "w": st.setCalView("week"); return true;
            case "a": st.setCalView("agenda"); return true;
            default: return false;
          }
        })();
        if (handled) {
          e.preventDefault();
          return;
        }
      }
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
        case "c": e.preventDefault(); void st.openCompose({ accountId: newMailAccount() }); break;
        case "/": e.preventDefault(); document.getElementById("search-input")?.focus(); break;
        case "j": void st.select(st.threads[Math.min(idx + 1, st.threads.length - 1)]?.threadId ?? null); break;
        case "k": void st.select(st.threads[Math.max(idx - 1, 0)]?.threadId ?? null); break;
        case "e": void st.act(ids, "archive", undefined, "Archived"); break;
        case "#": case "Delete": void st.act(ids, "trash", undefined, "Moved to Deleted Items"); break;
        // the Mac "delete" key (Backspace) deletes the selected conversation too; not while typing (guarded above)
        case "Backspace": if (osNow() === "macos") void st.act(ids, "trash", undefined, "Moved to Deleted Items"); break;
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

  if (!loaded) return <div className="app-loading" data-tauri-drag-region={customFrame ? "" : undefined}>Hey Look!</div>;

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
            {module === "calendar" ? (
              <>
                <CalendarView />
                {compose && (
                  <div className="reading-region cal-overlay">
                    <Compose key={composeKey} init={compose} />
                  </div>
                )}
              </>
            ) : (
              <>
                <MessageList />
                {prefs.readingPane === "right" && (
                  <Splitter label="Message list width" value={lw} min={300} max={680} onLive={(w) => setLive((s) => ({ ...s, l: w }))} onCommit={(w) => (setLive((s) => ({ ...s, l: undefined })), setPrefs({ listW: w }))} />
                )}
                <div className="reading-region">
                  {compose ? <Compose key={composeKey} init={compose} /> : <ReadingPane />}
                </div>
              </>
            )}
          </div>
        </>
      ) : (
        <Welcome />
      )}
      {dialog?.type === "settings" && <Settings initial={dialog.tab} focus={dialog.focus} nonce={dialog.nonce} />}
      {dialog?.type === "cleaner" && <BulkCleaner />}
      {dialog?.type === "original" && <ShowOriginal messageId={dialog.messageId} />}
      {dialog?.type === "pgp-generate" && <GenerateKeyDialog accountId={dialog.accountId} back={dialog.back} />}
      {dialog?.type === "pgp-import" && <ImportKeyDialog armored={dialog.armored} paste={dialog.paste} back={dialog.back} />}
      {dialog?.type === "event" && <EventDialog key={dialog.eventId ?? `new-${dialog.init?.start ?? 0}`} eventId={dialog.eventId} init={dialog.init} />}
      {dialog?.type === "pgp-key" && <KeyDetailsDialog fingerprint={dialog.fingerprint} back={dialog.back} />}
      {commandOpen && <CommandBar />}
      <AskHost />
      <PassphraseHost />
      <Toasts />
    </div>
  );
}

export default App;
