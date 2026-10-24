// The Scheduled list in a window of its own (W4.6, REQ-4.6.17/18): ScheduledList as in the Scheduled view (groups, the failed count, Edit, Send now, Change time, Cancel with
// Keep scheduled / Move to Drafts / Delete), refreshed when the outbox changes. Edit opens a compose window (from a window a message is always started in a window,
// composeOpen.ts `wantsWindow`). The main Scheduled view keeps working at the same time: both read the outbox from the backend and hear `outbox-changed`.
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { api } from "../api";
import { PassphraseHost } from "../components/Pgp";
import { ScheduledList } from "../components/ScheduledList";
import { useT } from "../i18n/react";
import { useLang } from "../i18n/react";
import { useStore } from "../store";
import { popoutTitle } from "./route";
import type { PopoutViewProps } from "./views";

const quiet = () => undefined;

export default function ScheduledView(_p: PopoutViewProps) {
  const t = useT();
  const lang = useLang();
  const title = t("settings.folder.scheduled");

  // the title of the window: "Scheduled – Hey Look!", in the language in use
  useEffect(() => {
    const w = popoutTitle(title);
    document.title = w;
    void getCurrentWindow().setTitle(w).catch(quiet);
  }, [title, lang]);

  // the list is read from the backend, now and whenever the outbox changes (a send, a schedule, a change made in the main window or in a compose window)
  useEffect(() => {
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const outbox = await api.listOutbox();
        if (!dead) useStore.setState({ outbox });
      } catch {
        /* the list shown stays */
      }
    };
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 150);
    };
    // the list's own actions ask for a refresh when they are done: here that is a read of the outbox
    useStore.setState({ refresh: load });
    void load();
    const subs = [listen("outbox-changed", soon), listen("mail-synced", soon), listen("data-changed", soon)];
    return () => {
      dead = true;
      clearTimeout(timer);
      for (const s of subs) void s.then((off) => off()).catch(quiet);
    };
  }, []);

  return (
    <div className="reader-win sched-win" data-popout="scheduled">
      <h1 className="sw-title">{title}</h1>
      <div className="sw-body">
        <ScheduledList />
      </div>
      <PassphraseHost />
    </div>
  );
}
