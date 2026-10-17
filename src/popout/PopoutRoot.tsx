// The root of a secondary window (compose, reader). It is mounted instead of <App /> (src/main.tsx), so none of the main page's start-up
// runs here: no `init()`, no account sync, no tray / toast / quit / update listeners (REQ-W12), no `frontend_ready` / `page_state`.
//
// What it does, in this order:
// 1. listens for the quit request (`popout-flush`) and for `prefs-changed`, then
// 2. asks the backend who it is (`popout_init`: the kind, the label, the key, the hand-off data) and reads the preferences once,
// 3. tells the backend it is ready (`popout_ready`), which shows the window. The backend asks only windows that are ready to answer a
//    quit, which is why the listener comes first.
// Afterwards: a preferences change by the main page is applied within a moment (theme, accent, font size, language), Ctrl+W / Cmd+W
// closes the window, and the view of its kind (views.tsx) is drawn.
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "../api";
import { mergePrefs } from "../prefs";
import { applyPrefs, useStore } from "../store";
import { currentFlushHandlers, runPopoutFlush } from "./flush";
import type { Route } from "./route";
import { VIEWS } from "./views";
import { AskHost, Toasts } from "../components/overlays";

const quiet = () => undefined;

interface Known {
  label: string;
  key: string | null;
  init: unknown;
}

export default function PopoutRoot({ route }: { route: Exclude<Route, { kind: "main" }> }) {
  const [known, setKnown] = useState<Known | null>(null);
  const [failed, setFailed] = useState(false);

  // what goes wrong in this page goes to startup.log too (a white window with no console to look at; Mac QA 1.0.6 had one)
  useEffect(() => {
    const say = (text: string) => void api.popoutNote("error", text).catch(quiet);
    const onError = (e: ErrorEvent) => say(`${e.message} (${(e.filename || "").split("/").pop()}:${e.lineno}:${e.colno})`);
    const onRejection = (e: PromiseRejectionEvent) => say(`unhandled rejection: ${e.reason instanceof Error ? e.reason.message : String(e.reason)}`);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  // the view was drawn: it has something with a size. Looked at every half second for 7 s (a slow start under load is not a blank window); the
  // backend reloads a window that is "ready" but never says so within 8 s, once (popout.rs `watch_content`)
  useEffect(() => {
    if (!known) return;
    const t0 = Date.now();
    const id = setInterval(() => {
      const box = document.getElementById("root")?.firstElementChild?.getBoundingClientRect();
      const drawn = !!box && box.width > 0 && box.height > 0 && document.body.innerText.trim().length + document.querySelectorAll("button, input, [contenteditable]").length > 0;
      if (drawn) {
        clearInterval(id);
        void api.popoutNote("content", `drawn ${Math.round(box!.width)} x ${Math.round(box!.height)} after ${Date.now() - t0} ms`).catch(quiet);
      } else if (Date.now() - t0 > 7000) {
        clearInterval(id);
        void api.popoutNote("error", "the view has nothing on screen 7 s after it was mounted").catch(quiet);
      }
    }, 500);
    return () => clearInterval(id);
  }, [known]);

  useEffect(() => {
    if (route.kind === "invalid") return;
    let dead = false;
    const stops: Array<Promise<() => void>> = [];
    let label = "";
    const readPrefs = async () => {
      try {
        const p = mergePrefs(await api.getSetting("prefs"));
        applyPrefs(p);
        useStore.setState({ prefs: p }); // the views read the preferences from this window's own store (a read-only copy: nothing here writes them)
        // the title bar follows the app theme (REQ-W8); "system" gives the choice back to the OS
        void getCurrentWindow().setTheme(p.theme === "system" ? null : p.theme).catch(quiet);
      } catch {
        /* the defaults stay */
      }
    };
    void (async () => {
      try {
        stops.push(
          // a quit (or the update restart) asks this window to save what it holds and answer once
          listen<{ why?: string } | null>("popout-flush", (e) =>
            runPopoutFlush({
              alive: () => void api.popoutFlushAlive().catch(quiet),
              done: (go) => void api.popoutFlushDone(go).catch(quiet),
              ctx: {
                why: e.payload?.why === "update" ? "update" : "quit",
                dialog: (open) => void api.popoutFlushDialog(open).catch(quiet),
                showWindow: () => void api.popoutFocus(label).catch(quiet),
              },
              handlers: currentFlushHandlers,
            }),
          ),
          // the main page is the only writer of the preferences; every other window re-reads them
          listen<{ writer?: string }>("prefs-changed", (e) => {
            if (e.payload?.writer !== label) void readPrefs();
          }),
        );
        await Promise.all(stops);
        const info = await api.popoutInit(route.token);
        label = info.label;
        await readPrefs();
        if (dead) return;
        setKnown({ label: info.label, key: info.key, init: info.init });
        await api.popoutReady();
      } catch {
        if (!dead) setFailed(true);
        void api.popoutReady().catch(quiet); // show the window anyway: an empty window the person can close
      }
    })();
    return () => {
      dead = true;
      for (const s of stops) void s.then((off) => off()).catch(quiet);
    };
  }, [route]);

  // Ctrl+W (Cmd+W) closes the window by the same road as its close button; a view decides in `onCloseRequested` what that means for it
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        void getCurrentWindow().close().catch(quiet);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (route.kind === "invalid" || failed) return <div className="popout-root" role="alert" data-popout="failed" />;
  if (!known) return <div className="popout-root" data-popout="loading" />;
  const View = VIEWS[route.kind];
  return (
    <>
      <View kind={route.kind} label={known.label} keyOf={known.key} init={known.init} />
      <Toasts />
      <AskHost />
    </>
  );
}
