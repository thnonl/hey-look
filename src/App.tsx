import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import "./App.css";
import { forwardLast, newMail, replyLast, targets } from "./actions";
import { api, BackfillProgress } from "./api";
import { newEvent } from "./newEvent";
import { CommandBar } from "./components/CommandBar";
import { PassphraseHost } from "./components/Pgp";
import { FolderPane } from "./components/FolderPane";
import { MessageList } from "./components/MessageList";
import { AskHost, Toasts } from "./components/overlays";
import { ReadingPane } from "./components/ReadingPane";
import { Ribbon } from "./components/Ribbon";
import { TopBar } from "./components/TopBar";
import { Welcome } from "./components/Welcome";
import { hasMailAccounts, shortcutWorks } from "./mailControls";
import { t as tNow } from "./i18n";
import { useT } from "./i18n/react";
import { runQuitFlush } from "./quitFlush";
import { nothingToKeep } from "./leaveCompose";
import { flushSends, friendlyError, moveDropped, moveRefused, useStore } from "./store";
import { osNow } from "./platform";
import { quitKeepKey } from "./trayWords";
import { openUpdateLink, useUpdates } from "./updates";
import { handlePopoutRequest } from "./popout/mainRequests";
import { startComposeHub } from "./popout/composeHub";
import type { Envelope } from "./popout/requestKinds";
import { calTz, configureCalendar, addDays, addMonths, today as todayDay } from "./calendar";
import { catchupText, configureDates, fmtWhen } from "./util";
import { frameAction, initFrame, useFrame } from "./winframe";
import { startSupportNudge } from "./supportNudgeHost";
import { watchNewMail } from "./newMailWire";
import { recoverUnsaved, reshowRecoveryToast } from "./composeRecovery";
import { composeSwallowsAppKey, inEditable, keyAction, moduleSwitchKey, sidebarToggleKey } from "./composeKeys";
import { MIN_READER_W, RAIL_W, SPLITTER_W, listHiddenWhileComposing, sidebarLayout } from "./sidebarState";
import { toggleSidebarNow, useWindowWidth } from "./useSidebar";
import { installEditorIntent, LazyBulkCleaner, LazyCalendarView, LazyCompose, LazyEventDialog, LazyFolderDialog, LazyGenerateKeyDialog, LazyImportKeyDialog, LazyKeyDetailsDialog, LazySettings, LazyShowOriginal, prefetchEditor, prefetchEditorWhenIdle } from "./lazyViews";

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Drag handle between two panes; the width is committed (saved) on release. */
function Splitter({ which, label, value, min, max, onLive, onCommit, disabled }: { which: "folder" | "list"; label: string; value: number; min: number; max: number; onLive: (w: number) => void; onCommit: (w: number) => void; disabled?: boolean }) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  // the side menu folded to icons has no width to change: the line stays (it is the edge of the pane), the drag and the keys are off
  if (disabled) return <div className="splitter off" data-which={which} aria-hidden />;
  return (
    <div
      className="splitter"
      data-which={which}
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
      onDoubleClick={() => onCommit(which === "folder" ? 248 : 392)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onCommit(clamp(value - 16, min, max));
        if (e.key === "ArrowRight") onCommit(clamp(value + 16, min, max));
      }}
    />
  );
}

function App() {
  const t = useT();
  const compose = useStore((s) => s.compose);
  const composeKey = useStore((s) => s.composeKey);
  const dialog = useStore((s) => s.dialog);
  const commandOpen = useStore((s) => s.commandOpen);
  const prefs = useStore((s) => s.prefs);
  const loaded = useStore((s) => s.loaded);
  const hasAccounts = useStore((s) => s.accounts.length > 0);
  const module = useStore((s) => s.module);
  const listAsked = useStore((s) => s.listAsked);
  const setPrefs = useStore((s) => s.setPrefs);
  const customFrame = useFrame((f) => f.custom);
  const [live, setLive] = useState<{ f?: number; l?: number }>({});
  const width = useWindowWidth();
  const readingPane = prefs.readingPane;
  // a message written in the pane in a window narrower than 1100 px takes the width of the list (W2.26); the list is back for the things in listHiddenWhileComposing
  const listHidden = listHiddenWhileComposing({ width, readingPane, module, composeOpen: !!compose, listAsked });
  // the side menu: in full or as a column of icons (sidebarState.ts); the width of the window and the person's own choice decide
  const fw = live.f ?? prefs.folderW;
  const lw = live.l ?? prefs.listW;
  // (decided from the saved widths: a splitter being dragged never folds the menu under the pointer; its limits below keep the reading pane at its minimum)
  const folded = sidebarLayout({ mode: prefs.sidebar, width, folderW: prefs.folderW, listW: prefs.listW, bottomPane: readingPane === "bottom" }).collapsed;

  configureDates(prefs);
  configureCalendar(prefs);

  useEffect(() => {
    void useStore.getState().init();
    initFrame();
  }, []);

  // the occasional support reminder: once the preferences are loaded, make sure its first due date exists and start looking for a calm moment
  useEffect(() => {
    if (loaded) void startSupportNudge();
  }, [loaded]);

  // messages that were being written when the app ended without saving or sending them are saved as drafts, and one toast says so (once per start)
  useEffect(() => {
    if (loaded && hasAccounts) void recoverUnsaved();
  }, [loaded, hasAccounts]);

  // the editor stack is a chunk of its own (lazyViews.tsx): fetched when the browser is idle after the first paint, and when a pointer or the focus reaches a button that opens it
  // (New mail, Reply, Reply all, Forward), so the first message after the start opens as fast as the next ones (REQ-13.13.9)
  useEffect(() => {
    if (!loaded) return;
    prefetchEditorWhenIdle();
    return installEditorIntent();
  }, [loaded]);

  // a conversation is open: a Reply is likely next
  const hasOpenMail = useStore((s) => s.messages.length > 0);
  useEffect(() => {
    if (hasOpenMail) prefetchEditor();
  }, [hasOpenMail]);

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

  // (W13.2) folders that got new mail get a dot until the person looks at them
  useEffect(() => watchNewMail(), []);

  // events from the tray menu, toasts and the background workers
  useEffect(() => {
    // a click on the notification of a new message: the conversation opens wherever it is (the Other tab, another mailbox or folder, a window of its own), store.ts openNotified
    const open = (threadId: string) => useStore.getState().openNotified(threadId);
    const stopHub = startComposeHub(); // the compose windows' requests and the count of open windows
    const takeTrayCompose = () => void api.takeTrayCompose().then((pending) => pending && newMail({ shift: false })).catch(() => undefined);
    const subs = [
      listen("mail-synced", () => void useStore.getState().refresh()),
      // an archive / delete / move whose Undo time is over has been done (also while the window was hidden to the tray): the messages leave the list now
      listen<{ threadIds: string[] }>("moves-committed", (e) => useStore.getState().dropThreads(e.payload.threadIds)),
      // the server renumbered a folder and its mail was read again (W6.1): a selection or an open conversation of it goes, the list is read again
      listen<{ accountId: string; role: string }>("folder-reset", (e) => useStore.getState().folderReset(e.payload.accountId, e.payload.role)),
      // the window comes back (from the tray, a second start): what changed meanwhile is read at once, not at the next 30 s refresh
      listen("app-shown", () => void useStore.getState().refresh()),
      // a secondary window (the reader) asks for something the main page owns: mail state with its Undo, the preferences, a dialog, a message
      listen<Envelope>("popout-request", (e) => void handlePopoutRequest(e.payload)),
      // a Google / Microsoft mailbox was signed out behind our back (the background sync got rejected): it shows "Sign in again"
      listen<{ accountId: string; state: "again" | "blocked" | null; error?: string }>("signin-state", (e) => {
        const st = useStore.getState();
        const { accountId, state, error } = e.payload;
        st.setReauth(accountId, state);
        if (!state) {
          useStore.setState((x) => ({ syncErrors: Object.fromEntries(Object.entries(x.syncErrors).filter(([k]) => k !== accountId)) }));
          return;
        }
        const shown = friendlyError(error ?? "");
        useStore.setState((x) => ({ syncErrors: { ...x.syncErrors, [accountId]: shown } }));
        const email = st.accounts.find((a) => a.id === accountId)?.email;
        st.showToast(() => email ? tNow("errors.toast.withAccount", { account: email, error: friendlyError(error ?? "") }) : friendlyError(error ?? ""), undefined, "error");
      }),
      // the background download of older Inbox mail: a status line in the list and a quiet, throttled re-read of it
      listen<BackfillProgress>("backfill-progress", (e) => useStore.getState().onBackfill(e.payload)),
      // follows the setting; with it on, a window opens (the tray did not show the main window, shell.rs). The backend keeps the request until the page has
      // taken it (an event sent before this page listens is lost); while the mailboxes are not read yet it waits in the queue of newMail
      listen("tray-compose", () => takeTrayCompose()),
      listen<{ id: string; error: string }>("action-verify-failed", (e) => moveDropped(e.payload.id, e.payload.error)),
      // a queued move the server refused after the Undo window (the payload names the move)
      listen<{ id: string; error: string }>("action-failed", (e) => moveRefused(e.payload.id, e.payload.error)),
      listen<{ threadId: string }>("open-thread", (e) => void open(e.payload.threadId)),
      listen<{ threadId: string }>("notify-reply", async (e) => {
        if (await open(e.payload.threadId)) replyLast(undefined, { shift: false }); // (the setting decides; no click or key is being handled)
      }),
      // scheduled sends: state changes from the worker, catch-up after a closed period, quit guard
      listen<{ id: string; status: string; error?: string }>("outbox-changed", (e) => {
        const st = useStore.getState();
        void st.refresh();
        if (e.payload.status !== "failed") return;
        const subject = st.outbox.find((o) => o.id === e.payload.id)?.subject || t("app.noSubject");
        st.showToast(() => t("app.toast.scheduledFailed", { subject }), undefined, "error", [
          { label: () => t("common.retry"), run: () => void api.outboxRetry(e.payload.id).then(() => useStore.getState().refresh()) },
          { label: () => t("app.action.open"), run: () => void useStore.getState().setView("scheduled") },
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
        st.showToast(() => `${e.payload.title}${e.payload.line ? ` · ${e.payload.line}` : ""}`, undefined, "info", [
          // no account: the calendar is not on screen, so there is nothing to open
          ...(hasMailAccounts(st.accounts.length) ? [{ label: () => t("app.action.open"), run: () => st.setModule("calendar") }] : []),
          ...(e.payload.joinUrl ? [{ label: () => t("app.action.join"), run: () => void openUpdateLink(e.payload.joinUrl as string) }] : []),
        ]);
      }),
      // the chosen save folder is gone: attachments went to Downloads instead (said once per session and folder)
      listen<{ configured: string; used: string }>("download-dir-fallback", (e) => {
        const st = useStore.getState();
        st.showToast(() => t("app.toast.downloadDirFallback", { configured: e.payload.configured, used: e.payload.used }), undefined, "info", [
          { label: () => t("app.action.changeFolder"), run: () => st.setDialog({ type: "settings", tab: "general" }) },
        ]);
      }),
      // The rest of a quit (REQ-48 b, c): a message being written is saved to Drafts (and the person is asked when that fails), then every
      // message still in its Undo time goes out now, for at most 20 s. The answer tells the backend whether the quit goes on.
      listen<{ due?: number } | null>("flush-sends", (ev) => {
        const swallow = () => undefined;
        // the scheduled messages that are due now go out after this part of the quit (the backend sends them, W6.12): the toast counts them with the messages in their Undo time
        const due = Math.max(0, Math.floor(Number(ev.payload?.due ?? 0)) || 0);
        const ask = (kind: "scheduledEdit" | "notSaved") =>
          kind === "scheduledEdit"
            ? useStore.getState().choose({
                title: t("app.quit.discardTitle"),
                body: t("app.quit.discardBody"),
                choices: [
                  { id: "keep", label: t("app.quit.keepEditing"), kind: "primary" },
                  { id: "quit", label: t("app.quit.quitDiscardChanges"), kind: "danger" },
                ],
              })
            : useStore.getState().choose({
                title: t("app.quit.notSavedTitle"),
                body: t("app.quit.notSavedBody", { error: useStore.getState().draftError || t("app.quit.unknownError") }),
                choices: [
                  { id: "keep", label: t("app.quit.keepWriting"), kind: "primary" },
                  { id: "quit", label: t("app.quit.quitDiscard"), kind: "danger" },
                ],
              });
        return runQuitFlush({
          alive: () => void api.quitPageAlive().catch(swallow),
          showWindow: () => void api.showWindow().catch(swallow),
          dialog: (open) => void api.quitDialog(open).catch(swallow),
          done: (go) => void api.sendsFlushed(go).catch(swallow),
          unsaved: () => {
            const s = useStore.getState();
            // nothing worth a draft in it (only recipients, or typed and deleted again, W13.5): no draft, no question
            return s.compose && s.composeDirty ? { scheduled: !!s.compose.outboxId, empty: nothingToKeep(s.composeProbe?.()), save: s.composeSaver } : null;
          },
          ask,
          saved: async () => {
            await useStore.getState().composeEnd?.();
            await useStore.getState().openCompose(null);
          },
          emptied: async () => {
            await useStore.getState().composeEnd?.({ emptied: true });
            await useStore.getState().openCompose(null);
          },
          discarded: async () => {
            await useStore.getState().composeEnd?.();
            useStore.setState({ composeDirty: false });
          },
          inFlight: () => useStore.getState().sendsInFlight + due,
          tell: (n) => useStore.getState().showToast(t("app.quit.sending", { n }), undefined, "info"),
          flush: flushSends,
        });
      }),
      // messages that were in their Undo time when the last run ended went out now (REQ-49 d)
      listen<{ count: number }>("outbox-leftover", (e) => {
        const n = e.payload.count;
        useStore.getState().showToast(t("app.toast.leftover", { n }), undefined, "success");
      }),
      // a filter whose action failed on new mail (once per filter and error per run, REQ-52)
      listen<string>("filter-failed", (e) => useStore.getState().showToast(e.payload, undefined, "error")), // i18n-ok: the text comes from the backend
      listen<{ count: number }>("outbox-catchup", (e) => {
        const st = useStore.getState();
        st.showToast(() => catchupText(e.payload.count), undefined, "success", [
          { label: () => t("app.action.view"), run: () => void st.setView("scheduled") },
        ]);
      }),
      listen<{ count: number; next: number | null }>("confirm-quit", async (e) => {
        const st = useStore.getState();
        const n = e.payload.count;
        const choice = await st.choose({
          title: t("app.quit.scheduledTitle", { n }),
          body: e.payload.next
            ? t(n === 1 ? "app.quit.scheduledBodyNext.one" : "app.quit.scheduledBodyNext.many", { when: fmtWhen(e.payload.next) })
            : t(n === 1 ? "app.quit.scheduledBody.one" : "app.quit.scheduledBody.many"),
          choices: [
            { id: "cancel", label: t("common.cancel") },
            { id: "keep", label: t(quitKeepKey(osNow())), kind: "primary" },
            { id: "quit", label: t("app.quit.quitAnyway"), kind: "danger" },
          ],
        });
        if (choice === "quit") await api.quitNow();
        else await api.quitCancelled().catch(() => undefined); // Cancel / Keep running: nothing else happens, a later quit asks again
      }),
    ];
    // a "New mail" of the tray menu from before this page listened (the first moments of a start)
    void Promise.all(subs).then(takeTrayCompose).catch(() => undefined);
    return () => {
      stopHub();
      subs.forEach((p) => void p.then((off) => off()).catch(() => undefined));
    };
  }, []);

  // update check: once about 8 s after the UI is ready, then whenever the window comes back (the backend throttles: 5 minutes after the last attempt at launch, 2 h on return, 15 minutes after a failure)
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
      reshowRecoveryToast(); // (a toast nobody answered comes back if anything took it off the screen while the window was hidden)
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
      // Ctrl/Cmd+K: the command bar, except inside an editor (compose body), where it is the link UI of that editor
      const ka = keyAction(e, { inEditor: inEditable(e.target) });
      // Ctrl/Cmd+1 while a message is written: the list comes back next to it (W2.26); the module and the message stay as they are
      if (st.compose && st.module === "mail" && !e.defaultPrevented && moduleSwitchKey(e, { inField: false, inCompose: false, modalOpen: !!(st.dialog || st.commandOpen || st.ask) }) === "go-mail") {
        e.preventDefault();
        st.askList();
        return;
      }
      if (ka === "command-bar") {
        e.preventDefault();
        st.setCommandOpen(true);
        return;
      }
      if (ka === "insert-link") return;
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
      // the mailboxes are not read yet (the first second of a start): "c" is kept and opens the message when they are (newMailQueue.ts)
      if (!st.loaded && (e.key === "c" || e.key === "C") && !e.ctrlKey && !e.metaKey && !e.altKey && !(e.target instanceof Element && e.target.closest("input,textarea,select,[contenteditable=true]"))) {
        e.preventDefault();
        void newMail();
        return;
      }
      // no account: no mail shortcut (search, new mail, navigation, actions, Ctrl+1 / 2 ...) is live
      if (!shortcutWorks(n, "mail-keys")) return;
      const tgt = e.target;
      if (!(tgt instanceof Element)) return;
      if (tgt.closest("input,textarea,select,[contenteditable=true]")) return;
      const inCompose = !!tgt.closest(".compose-pane");
      const modalOpen = !!(st.dialog || st.commandOpen || st.ask);
      const go = moduleSwitchKey(e, { inField: false, inCompose, modalOpen });
      if (go) {
        e.preventDefault();
        st.setModule(go === "go-calendar" ? "calendar" : "mail");
        return;
      }
      // Ctrl/Cmd+B: fold or open the side menu (not in the message being written: there it is Bold)
      if (sidebarToggleKey(e, { inField: false, inCompose, modalOpen })) {
        e.preventDefault();
        toggleSidebarNow();
        return;
      }
      if (modalOpen) return;
      // a message being written stays as it is, except that j / k (focus outside the pane) go on to the next / previous conversation (F-21);
      // the compose pane is modal for the keys that act on the mailbox, whichever of its buttons has the focus (A-24)
      if (composeSwallowsAppKey(e, { composeOpen: !!st.compose, inCompose, module: st.module })) return;
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
        // Shift+C / R / A / F do the opposite of c / r / a / f: a window of its own, or the pane when the setting is on (modifier.ts reads the Shift)
        case "c": case "C": e.preventDefault(); void newMail(); break;
        case "/": e.preventDefault(); document.getElementById("search-input")?.focus(); break;
        case "j": case "k": {
          const next = st.threads[e.key === "j" ? Math.min(idx + 1, st.threads.length - 1) : Math.max(idx - 1, 0)]?.threadId ?? null;
          if (next) void st.openMail(next);
          else if (!st.compose) void st.select(null);
          break;
        }
        case "e": void st.act(ids, "archive", undefined, () => t("mail.done.archived")); break;
        case "#": case "Delete": void st.act(ids, "trash", undefined, () => t("mail.done.trashed")); break;
        // the Mac "delete" key (Backspace) deletes the selected conversation too; not while typing (guarded above)
        case "Backspace": if (osNow() === "macos") void st.act(ids, "trash", undefined, () => t("mail.done.trashed")); break;
        case "!": void st.act(ids, "junk", undefined, () => t("mail.done.junk")); break;
        case "u": void st.act(ids, "unread"); break;
        case "p": void st.act(ids, cur?.pinned ? "unpin" : "pin"); break;
        case "*": void st.act(ids, cur?.flagged ? "unstar" : "star"); break;
        // the Snooze button of the reading pane (found by its class: its tooltip is translated, and written with the punctuation of the language)
        case "s": document.querySelector<HTMLButtonElement>(".reading-pane button.snooze-btn")?.click(); break;
        case "r": case "R": replyLast(false); break;
        case "a": case "A": replyLast(true); break;
        case "f": case "F": forwardLast(); break;
        case "Escape": st.setChecked([]); void st.select(null); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!loaded) return (
    <div className="app-loading" data-tauri-drag-region={customFrame ? "" : undefined}>
      Hey Look!
      <Toasts /> {/* (a kept New mail says so here, and says when it could not be done) */}
    </div>
  );

  // how far the splitters may go: the reading pane keeps its minimum width (with the reading pane below there is no such limit)
  const right = readingPane === "right";
  const folderMax = right && !folded ? clamp(width - lw - 2 * SPLITTER_W - MIN_READER_W, 180, 360) : 360;
  const listMax = right ? clamp(width - (folded ? RAIL_W : fw) - 2 * SPLITTER_W - MIN_READER_W, 300, 680) : 680;
  return (
    <div className={`app pane-${prefs.readingPane}`}>
      <TopBar />
      {hasAccounts ? (
        <>
          <Ribbon />
          <div className={`workspace ${live.f !== undefined || live.l !== undefined ? "dragging" : ""} ${listHidden ? "list-hidden" : ""}`} style={{ ["--fw" as string]: `${folded ? RAIL_W : fw}px`, ["--fw-full" as string]: `${fw}px`, ["--lw" as string]: `${lw}px` }}>
            <FolderPane collapsed={folded} />
            <Splitter which="folder" disabled={folded} label={t("app.splitter.folder")} value={fw} min={180} max={folderMax} onLive={(w) => setLive((s) => ({ ...s, f: w }))} onCommit={(w) => (setLive((s) => ({ ...s, f: undefined })), setPrefs({ folderW: w }))} />
            {module === "calendar" ? (
              <LazyCalendarView />
            ) : (
              <>
                <MessageList hidden={listHidden} />
                {prefs.readingPane === "right" && (
                  <Splitter which="list" label={t("app.splitter.list")} value={lw} min={300} max={listMax} onLive={(w) => setLive((s) => ({ ...s, l: w }))} onCommit={(w) => (setLive((s) => ({ ...s, l: undefined })), setPrefs({ listW: w }))} />
                )}
              </>
            )}
            {/* One place in the tree for the message being written, in both modules: switching Mail <-> Calendar (Ctrl+1 / 2, the folder pane) only
                changes the class of this element, so Compose is not unmounted and what was typed is not lost (QA round 17, A-24). */}
            {(compose || module === "mail") && (
              <div className={module === "calendar" ? "reading-region cal-overlay" : "reading-region"}>
                {compose ? <LazyCompose key={composeKey} init={compose} /> : <ReadingPane />}
              </div>
            )}
          </div>
        </>
      ) : (
        <Welcome />
      )}
      {/* the big dialogs are parts of their own, loaded when one opens (lazyViews.tsx): the frame of the dialog is there at once */}
      {dialog?.type === "settings" && <LazySettings initial={dialog.tab} focus={dialog.focus} nonce={dialog.nonce} />}
      {dialog?.type === "cleaner" && <LazyBulkCleaner />}
      {dialog?.type === "folder-new" && <LazyFolderDialog key={`${dialog.accountId}|${dialog.parentKey ?? ""}`} accountId={dialog.accountId} parentKey={dialog.parentKey} />}
      {dialog?.type === "original" && <LazyShowOriginal messageId={dialog.messageId} />}
      {dialog?.type === "pgp-generate" && <LazyGenerateKeyDialog accountId={dialog.accountId} back={dialog.back} />}
      {dialog?.type === "pgp-import" && <LazyImportKeyDialog armored={dialog.armored} paste={dialog.paste} back={dialog.back} />}
      {dialog?.type === "event" && <LazyEventDialog key={dialog.eventId ?? `new-${dialog.init?.start ?? 0}`} eventId={dialog.eventId} init={dialog.init} />}
      {dialog?.type === "pgp-key" && <LazyKeyDetailsDialog fingerprint={dialog.fingerprint} back={dialog.back} />}
      {commandOpen && <CommandBar />}
      <AskHost />
      <PassphraseHost />
      <Toasts />
    </div>
  );
}

export default App;
