// A calendar event in a window of its own (W4.6, REQ-4.6.6/4.6.7): the event form (EventDialog, the same fields and rules as the dialog) as the page of a window. The form opens with
// what it was handed: an event (its id, and the changes made so far when it moved here from the dialog), or a new event. Save or Delete ends the window and the main calendar shows
// the change (`calendar-changed`); Close (the X, Esc, Ctrl/Cmd+W) with changes asks the discard question of the dialog, without changes it closes. A quit with a changed event window
// loses the changes, exactly as with the event dialog (no question, noted in the spec). The window never writes the preferences; a toast is made in the main window.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { LazyEventWindowForm } from "../lazyViews";
import { t as tNow } from "../i18n";
import { useStore, type EventInit } from "../store";
import { askMain } from "./readerBridge";
import { popoutTitle } from "./route";
import type { PopoutViewProps } from "./views";

const quiet = () => undefined;

// (the types of the form; the form itself is loaded by lazyViews.tsx like every big part: test-lazy-load)
type EventDraft = import("../components/Calendar").EventDraft;
type EventWindowHooks = import("../components/Calendar").EventWindowHooks;

interface Spec {
  eventId?: string;
  init?: EventInit;
  draft?: EventDraft;
}

/** What the window was opened with, read defensively. */
function specOf(raw: unknown): Spec {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
  return {
    eventId: typeof r.eventId === "string" && r.eventId ? r.eventId : undefined,
    init: (obj(r.init) as EventInit | null) ?? undefined,
    draft: (obj(r.draft) as EventDraft | null) ?? undefined,
  };
}

export default function EventView({ init }: PopoutViewProps) {
  const spec = useMemo(() => specOf(init), [init]);
  const [ready, setReady] = useState(false);
  const form = useRef<{ dirty: () => boolean; close: () => Promise<void> } | null>(null);

  // the title of the window: the title of the event, or "New event"
  const setTitle = useRef((text: string) => {
    const w = popoutTitle(text || tNow("calendar.newEvent"));
    document.title = w;
    void getCurrentWindow().setTitle(w).catch(quiet);
  }).current;
  useEffect(() => setTitle(spec.draft?.title || tNow("calendar.newEvent")), [setTitle, spec.draft?.title]);

  const hooks = useMemo<EventWindowHooks>(
    () => ({
      done: () => void api.popoutDestroy().catch(quiet),
      register: (h) => {
        form.current = h;
      },
      toast: (text, kind) => void askMain("toast", { text, level: kind }, 10_000),
      title: setTitle,
    }),
    [setTitle],
  );

  // what the form takes from the store of this window: the mailboxes and calendars it offers; its calls that belong to the main window are nothing here
  useEffect(() => {
    let dead = false;
    useStore.setState({
      bumpCal: () => undefined, // (the main calendar hears `calendar-changed` from the backend)
      setCalDate: () => undefined,
      setPrefs: () => undefined, // (a window never writes the preferences, REQ-4.6.3)
      setDialog: (d) => {
        if (d === null) hooks.done();
      },
    });
    void (async () => {
      const [accounts, calendars] = await Promise.all([api.listAccounts().catch(() => null), api.calendarListCalendars().catch(() => null)]);
      if (dead) return;
      if (accounts) useStore.setState({ accounts });
      if (calendars) useStore.setState({ calendars });
      setReady(true);
    })();
    return () => {
      dead = true;
    };
  }, [hooks]);

  // Close (the X of the frame, Ctrl/Cmd+W) goes through the form: a question first when it has changes (the page decides, popout.rs `Kind::page_decides_close`)
  useEffect(() => {
    const un = getCurrentWindow().onCloseRequested(async (e) => {
      e.preventDefault();
      if (form.current) await form.current.close();
      else hooks.done();
    });
    return () => void un.then((off) => off()).catch(quiet);
  }, [hooks]);

  // Esc closes the form the way its Cancel button does, unless a question or a menu on top of it takes the key first
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || useStore.getState().ask) return;
      void getCurrentWindow().close().catch(quiet);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!ready) return <div className="popout-root" data-popout="loading" />;
  return (
    <div data-popout="event">
      <LazyEventWindowForm eventId={spec.eventId} init={spec.init} draft={spec.draft} windowed={hooks} />
    </div>
  );
}
