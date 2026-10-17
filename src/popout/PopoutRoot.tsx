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
import { applyPrefs } from "../store";
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

  useEffect(() => {
    if (route.kind === "invalid") return;
    let dead = false;
    const stops: Array<Promise<() => void>> = [];
    let label = "";
    const readPrefs = async () => {
      try {
        applyPrefs(mergePrefs(await api.getSetting("prefs")));
      } catch {
        /* the defaults stay */
      }
    };
    void (async () => {
      try {
        stops.push(
          // a quit (or the update restart) asks this window to save what it holds and answer once
          listen("popout-flush", () =>
            runPopoutFlush({
              alive: () => void api.popoutFlushAlive().catch(quiet),
              done: (go) => void api.popoutFlushDone(go).catch(quiet),
              ctx: {
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
