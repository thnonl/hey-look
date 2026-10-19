// The compose window: the same Compose pane as the main window, in a window of its own (spec "pop-out windows", REQ-C5). One message per
// window, with state of its own (this page has its own store: nothing is shared with the other windows except through the backend).
//
// What this adds around <Compose />:
// - a store that works here: the accounts, the preferences (PopoutRoot), the platform; and the few store actions that mean "something else" in
//   a window are replaced: `openCompose` (the editor comes back after Undo or a failed send, or the message is over and the window ends),
//   `sync` / `refresh` / `setDialog` (asked of the main window), `showToast` (a toast raised just before the window ends is shown in the main
//   window, where the person still looks);
// - the send: the editor stays on screen, locked, with a toast "Sending... n s" and Undo in the window's own toast area (W13.1); a window the person
//   closes then goes out of sight and keeps running until the message has gone (composeWindow.ts, `step`); Undo or a failure unlocks the same editor;
// - closing: Save / Discard / Cancel (REQ-C11); an empty message closes silently;
// - quit and update restart: the window saves what it holds, or asks (composeWindow.ts, `composeFlush`);
// - the title of the window: the subject (REQ-W7).
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import { orderAccounts } from "../accountOrder";
import { api } from "../api";
import { configureCalendar } from "../calendar";
import { Compose } from "../components/Compose";
import { GuardMenuHost } from "../components/GuardMenuHost";
import { PassphraseHost } from "../components/Pgp";
import { t as tNow } from "../i18n";
import { loadPlatform } from "../platform";
import { flushSends, lazyText, useStore, type ComposeInit, type Lazy } from "../store";
import { configureDates } from "../util";
import { notifyMain } from "./composeBridge";
import { carryToasts } from "./composeRequests";
import { setComposeSeam, type ComposeSeam } from "./composeSeam";
import { composeFlush, runClose, secondsLeft, START, step, type Ev, type Fx, type WinState } from "./composeWindow";
import { draftKey } from "./entry";
import { registerFlushHandler } from "./flush";
import { popoutTitle } from "./route";
import type { PopoutViewProps } from "./views";

const quiet = () => undefined;
/** The one toast of a message that is being sent from this window: "Sending... n s" with Undo, then "Sending...". */
const SEND_TOAST = "compose-send";
type Level = "info" | "success" | "error";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export default function ComposeView({ label, init }: PopoutViewProps) {
  const prefs = useStore((s) => s.prefs);
  configureDates(prefs);
  configureCalendar(prefs);

  // what the editor shows: the message handed over by the opener (the backend kept it), later the one that comes back after Undo / a failed send
  const [editor, setEditor] = useState<{ init: ComposeInit; n: number } | null>(() => ({ init: isObj(init) ? (init as ComposeInit) : {}, n: 1 }));
  const [win, setWin] = useState<WinState>(START);
  const [ready, setReady] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const winRef = useRef<WinState>(START);
  const undoRef = useRef<(() => void) | null>(null);
  const lastThread = useRef<string | null>(null);
  const raised = useRef<{ at: number; text: Lazy; kind: Level }[]>([]);
  const since = useRef(0);
  const closing = useRef(false);
  /** the scheduled message this window holds paused (opened for editing); null when it is not this window's to release any more (W2.10) */
  const held = useRef<string | null>(isObj(init) && typeof init.outboxId === "string" ? init.outboxId : null);

  const releasePause = useCallback(async () => {
    const id = held.current;
    held.current = null;
    if (id) await api.outboxRelease(id).catch(quiet);
  }, []);
  const run = useCallback((fx: Fx) => {
    switch (fx) {
      case "park":
        void api.popoutPark().catch(quiet);
        break;
      case "show":
        void api.popoutFocus(label).catch(quiet);
        break;
      case "grace":
        setTimeout(() => dispatchRef.current({ t: "grace", now: Date.now() }), 400);
        break;
      case "destroy": {
        // what the person should still see (Message sent, Draft saved ...) is shown in the main window; then the window ends
        for (const x of carryToasts(raised.current, since.current)) notifyMain("toast", { text: lazyText(x.text), level: x.kind });
        // a scheduled message that was only looked at goes back to its schedule before the window is gone (the page may not run its clean-up)
        void releasePause().then(() => api.popoutDestroy().catch(quiet));
        break;
      }
    }
  }, [label, releasePause]);
  const dispatchRef = useRef<(e: Ev) => void>(quiet);
  const dispatch = useCallback(
    (e: Ev) => {
      if (e.t === "handoff" || e.t === "end") since.current = Date.now() - 1500; // (the toast of a save comes just before the end)
      const r = step(winRef.current, e);
      winRef.current = r.s;
      setWin(r.s);
      for (const fx of r.fx) run(fx);
    },
    [run],
  );
  dispatchRef.current = dispatch;

  // ---- the store of this window, the seam Compose asks, the questions of a close / quit
  useEffect(() => {
    let alive = true;
    const st = useStore;
    const loadAccounts = async () => {
      try {
        const list = await api.listAccounts();
        if (alive) st.setState({ accounts: orderAccounts(list, st.getState().prefs.accountOrder) });
      } catch {
        /* the accounts shown stay */
      }
    };
    const orig = st.getState().showToast;
    st.setState({
      openCompose: async (c, opts) => {
        if (c) {
          held.current = c.outboxId ?? null; // (a scheduled message that came back as an ordinary one is not held)
          setEditor((prev) => ({ init: c, n: (prev?.n ?? 0) + 1 }));
          dispatchRef.current({ t: "reopen" });
          return;
        }
        setEditor(null);
        // `sending`: the message is on its way (the Undo time in seconds, 0 for none or for a scheduled message); else it is over
        if (typeof opts?.sending === "number") dispatchRef.current({ t: "handoff", wait: opts.sending, now: Date.now() });
        else dispatchRef.current({ t: "end" });
      },
      sync: async () => notifyMain("sync"),
      refresh: async () => notifyMain("refresh"),
      setDialog: (d) => {
        if (d) notifyMain("dialog", { dialog: d });
      },
      showToast: (text, undo, kind, actions) => {
        orig(text, undo, kind, actions);
        raised.current = [...raised.current.slice(-9), { at: Date.now(), text, kind: kind ?? "info" }];
      },
    });
    void (async () => {
      await loadPlatform();
      await loadAccounts();
      void st.getState().refreshAi();
      if (alive) setReady(true);
    })();

    // the subject is the title of the window, at most every 500 ms
    let titleTimer: ReturnType<typeof setTimeout> | undefined;
    const setTitle = (subject: string) => {
      clearTimeout(titleTimer);
      titleTimer = setTimeout(() => {
        void getCurrentWindow().setTitle(popoutTitle(subject.trim() || tNow("compose.popout.newTitle"))).catch(quiet);
      }, 500);
    };
    const seam: ComposeSeam = {
      inWindow: true,
      undoOffer: (undo) => {
        undoRef.current = undo;
        dispatchRef.current({ t: "undo-offer" });
      },
      scheduled: (outboxId, sendAt) => notifyMain("scheduled", { outboxId, sendAt }),
      lock: (wait) => dispatchRef.current({ t: "handoff", wait, now: Date.now(), lock: true }),
      unlock: () => dispatchRef.current({ t: "reopen" }),
      scheduledHandled: () => {
        held.current = null;
      },
      draftSaved: (threadId) => {
        lastThread.current = threadId;
        void api.popoutSetKey(draftKey(threadId)).catch(quiet); // the lock of a draft follows its saves
      },
      title: setTitle,
    };
    const unseam = setComposeSeam(seam);

    const unsubSends = st.subscribe((s, prev) => {
      if (s.sendsInFlight !== prev.sendsInFlight) dispatchRef.current({ t: "sends", n: s.sendsInFlight, now: Date.now() });
    });

    // ---- close (REQ-C11)
    const choose = (o: Parameters<ReturnType<typeof st.getState>["choose"]>[0]) => st.getState().choose(o);
    const save = async (): Promise<boolean> => {
      const saver = st.getState().composeSaver;
      if (!saver) return false;
      return (await saver({ quiet: true, onSaved: () => undefined })) === true; // (no toast here: the main window makes it)
    };
    const discard = async () => {
      if ((await st.getState().composeEnd?.({ dropDraft: true })) === false) return false; // an opened draft could not be put back: the window stays
      st.setState({ composeDirty: false });
      return true;
    };
    const closeNow = async () => {
      if (closing.current) return;
      closing.current = true;
      try {
        await runClose({
          facts: () => {
            const p = st.getState().composeProbe?.();
            return { phase: winRef.current.phase, dirty: st.getState().composeDirty, hasContent: !!p?.draftContent, attaching: !!p?.attaching, scheduled: held.current !== null };
          },
          askScheduled: async () =>
            (await choose({
              title: tNow("compose.leave.scheduledTitle"),
              body: tNow("app.quit.discardBody"),
              choices: [
                { id: "keep", label: tNow("app.quit.keepEditing"), kind: "primary" },
                { id: "discard", label: tNow("errors.ask.discard"), kind: "danger" },
              ],
            })) === "discard"
              ? "discard"
              : "keep",
          ask: async () => {
            const a = await choose({
              title: tNow("compose.popout.closeTitle"),
              body: tNow("compose.popout.closeBody"),
              // (Esc and a click outside answer with the first choice: Cancel keeps the message)
              choices: [
                { id: "cancel", label: tNow("common.cancel") },
                { id: "save", label: tNow("common.save"), kind: "primary" },
                { id: "discard", label: tNow("compose.dlg.discard"), kind: "danger" },
              ],
            });
            return a === "save" || a === "discard" ? a : "cancel";
          },
          save,
          askFailed: async () => {
            const a = await choose({
              title: tNow("app.quit.notSavedTitle"),
              body: tNow("compose.popout.notSavedBody", { error: st.getState().draftError || tNow("app.quit.unknownError") }),
              choices: [
                { id: "keep", label: tNow("app.quit.keepWriting"), kind: "primary" },
                { id: "discard", label: tNow("compose.popout.closeDiscard"), kind: "danger" },
              ],
            });
            return a === "discard" ? "discard" : "keep";
          },
          discard,
          emptied: async () => void (await st.getState().composeEnd?.({ emptied: true })),
          park: () => dispatchRef.current({ t: "close" }),
          end: () => dispatchRef.current({ t: "end" }),
          attaching: () => st.getState().showToast(tNow("compose.leave.attaching"), undefined, "info"),
          savedDraft: () => {
            if (lastThread.current) notifyMain("draft-saved", { threadId: lastThread.current, plain: false });
            else notifyMain("toast", { text: tNow("compose.toast.draftSaved"), level: "success" });
          },
        });
      } finally {
        closing.current = false;
      }
    };
    const unClose = getCurrentWindow().onCloseRequested(async (e) => {
      e.preventDefault(); // the window system holds the close back; this page ends the window itself (popout_destroy) or hides it (popout_park)
      await closeNow();
    });

    // ---- quit and update restart (REQ-C12)
    const unFlush = registerFlushHandler((ctx) =>
      composeFlush(
        {
          phase: () => winRef.current.phase,
          dirty: () => st.getState().composeDirty,
          hasContent: () => !!st.getState().composeProbe?.().draftContent,
          emptied: async () => void (await st.getState().composeEnd?.({ emptied: true })),
          scheduled: () => held.current !== null,
          release: releasePause,
          save,
          ask: async (why) => {
            const a = await choose({
              title: tNow(why === "update" ? "updates.ask.unsavedTitle" : "app.quit.notSavedTitle"),
              body: tNow(why === "update" ? "updates.ask.unsavedBody" : "app.quit.notSavedBody", { error: st.getState().draftError || tNow("app.quit.unknownError") }),
              choices: [
                { id: "keep", label: tNow("app.quit.keepWriting"), kind: "primary" },
                { id: "discard", label: tNow(why === "update" ? "updates.action.restartDiscardMessage" : "app.quit.quitDiscard"), kind: "danger" },
              ],
            });
            return a === "discard" ? "discard" : "keep";
          },
          showWindow: ctx.showWindow,
          dialog: ctx.dialog,
          discarded: async () => {
            await st.getState().composeEnd?.();
            st.setState({ composeDirty: false });
          },
          flushSends: () => flushSends(20_000),
        },
        ctx.why,
      ),
    );

    // accounts and keys can change in the main window while this one is open
    const subs = [listen("mail-synced", () => void loadAccounts()), listen("prefs-changed", () => void loadAccounts())];
    const onFocus = () => {
      void loadAccounts();
      st.getState().bumpKeys();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      clearTimeout(titleTimer);
      unseam();
      unsubSends();
      unFlush();
      void unClose.then((off) => off()).catch(quiet);
      for (const s of subs) void s.then((off) => off()).catch(quiet);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  // the first title: the subject the message starts with
  useEffect(() => {
    const subject = isObj(init) && typeof init.subject === "string" ? init.subject : "";
    void getCurrentWindow().setTitle(popoutTitle(subject.trim() || tNow("compose.popout.newTitle"))).catch(quiet);
  }, [init]);

  // the countdown of the Undo time
  useEffect(() => {
    if (win.phase !== "count") return;
    const id = setInterval(() => {
      setNow(Date.now());
      dispatch({ t: "tick", now: Date.now() });
    }, 250);
    return () => clearInterval(id);
  }, [win.phase, dispatch]);

  const undo = useCallback(() => {
    dispatch({ t: "undo-start", now: Date.now() });
    undoRef.current?.();
  }, [dispatch]);

  // The toast of a message on its way (REQ-13.1.2/3): "Sending... n s" with Undo while the Undo time runs, then "Sending..." with the busy ring until the server has
  // answered. One toast that changes in place; the number is drawn aria-hidden and a screen reader gets "Sending..." once. Not shown while Undo is being
  // carried out (the click closed it; the editor comes back in a moment).
  const sending = win.phase === "count" || win.phase === "work";
  const secs = win.phase === "count" ? secondsLeft(win.endsAt, now) : 0;
  const showUndo = win.phase === "count" && win.canUndo && win.undoAt === null;
  const counting = win.phase === "count";
  useEffect(() => {
    const st = useStore.getState();
    if (!sending || (win.phase === "count" && win.undoAt !== null)) {
      st.setStickyToast(SEND_TOAST, null);
      return;
    }
    st.setStickyToast(SEND_TOAST, {
      text: () => (counting ? tNow("compose.popout.sending", { n: secs }) : tNow("compose.toast.sending")),
      readAs: () => tNow("compose.toast.sending"),
      kind: "info",
      busy: true,
      hideClose: true,
      undo: showUndo ? undo : undefined,
    });
  }, [sending, counting, win.phase, win.undoAt, secs, showUndo, undo]);
  useEffect(() => () => useStore.getState().setStickyToast(SEND_TOAST, null), []);

  // Undo has the keyboard focus as soon as it works (REQ-C8)
  useEffect(() => {
    if (!showUndo) return;
    let tries = 0;
    const id = setInterval(() => {
      const b = document.querySelector<HTMLButtonElement>(".toasts .toast-undo");
      if (b) (b.focus(), clearInterval(id));
      else if (++tries > 20) clearInterval(id);
    }, 30);
    return () => clearInterval(id);
  }, [showUndo]);

  return (
    <div className="popout-compose" data-popout="compose" data-label={label} data-phase={win.phase}>
      {/* the editor stays while the message is sent: Compose locks itself (inert, "Sending...") and unlocks in place on Undo or a failure (seam.lock / unlock) */}
      {ready && editor && <Compose key={editor.n} init={editor.init} />}
      <PassphraseHost />
      <GuardMenuHost />
    </div>
  );
}
