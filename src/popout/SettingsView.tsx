// Settings in a window of its own (W4.6, REQ-4.6.8 to 4.6.11): the Settings page of the dialog (the same tabs, the same code) as the page of a window. One window exists; every way of
// opening Settings while it exists brings it to the front on the asked tab (event popout-refocus). What differs from the dialog:
//   - the preferences are the main window's to write: a change is applied here at once and handed to the main page as a patch (the prefs request, any key of Prefs for this window
//     only), which writes it and tells every window (prefs-changed); the backend refuses set_setting("prefs") from any window but main (W4.9);
//   - the dialogs of Settings (PGP keys: generate, import, details) open inside this window, on top of the page; their "back" is a no-op here;
//   - what the lists of the main window show (mailboxes, folders, the sync of a new mailbox) is told by data-changed, the main window reads it again;
//   - "Restart now" of the update block is run by the main page (it saves the compose windows and its own pane first, as today): the update-restart request.
// Unsaved form fields behave as in the dialog when the window closes or the app quits (no new question).
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { Settings, type MbTab } from "../components/SettingsDialog";
import { PassphraseHost } from "../components/Pgp";
import { LazyGenerateKeyDialog, LazyImportKeyDialog, LazyKeyDetailsDialog } from "../lazyViews";
import { t as tNow } from "../i18n";
import { useLang } from "../i18n/react";
import { applyPrefs, useStore } from "../store";
import { useUpdates } from "../updates";
import { askMain } from "./readerBridge";
import { popoutTitle } from "./route";
import { refocusOf } from "./windowKinds";
import type { PopoutViewProps } from "./views";

const quiet = () => undefined;

interface Nav {
  tab?: string;
  focus?: string;
  nonce: number;
}

export default function SettingsView({ init, label }: PopoutViewProps) {
  const lang = useLang();
  const first = useMemo(() => {
    const r = init && typeof init === "object" ? (init as Record<string, unknown>) : {};
    return { ...refocusOf(r), section: typeof r.section === "string" ? (r.section as MbTab) : undefined };
  }, [init]);
  const [nav, setNav] = useState<Nav>({ tab: first.tab, focus: first.focus, nonce: 0 });
  const dialog = useStore((s) => s.dialog);

  useEffect(() => {
    const w = popoutTitle(tNow("settings.title"));
    document.title = w;
    void getCurrentWindow().setTitle(w).catch(quiet);
  }, [lang]);

  useEffect(() => {
    let dead = false;
    // ---- what this window's store does differently from the main window's
    useStore.setState({
      // a preference: shown here at once, written by the main page (the language and the theme of the page come back with its prefs-changed)
      setPrefs: (patch) => {
        const { language: _language, ...local } = patch;
        void _language;
        useStore.setState((s) => ({ prefs: { ...s.prefs, ...local } }));
        applyPrefs(useStore.getState().prefs);
        void askMain("prefs", patch, 15_000);
      },
      // Settings asked for again from inside (a link of a text, a PGP dialog's "back"): this window goes to the tab; the other dialogs open on top of the page
      setDialog: (d) => {
        if (d && d.type === "settings") {
          setNav({ tab: d.tab, focus: d.focus, nonce: d.nonce ?? Date.now() });
          useStore.setState({ dialog: null });
        } else useStore.setState({ dialog: d });
      },
      // a mailbox was added or changed here: this window reads the list; the main window is told (data-changed) and syncs the new mailbox
      accountAdded: async (acc, deferEnd) => {
        const list = await api.listAccounts().catch(() => null);
        if (list) useStore.setState({ accounts: list });
        if (!deferEnd) useStore.getState().showToast(tNow("errors.toast.accountAdded", { email: acc.email }), undefined, "success");
      },
      accountAddedDone: async (acc, withCalendar) => {
        const list = await api.listAccounts().catch(() => null);
        if (list) useStore.setState({ accounts: list });
        useStore.getState().showToast(tNow(withCalendar ? "errors.toast.accountAddedCal" : "errors.toast.accountAdded", { email: acc.email }), undefined, "success");
      },
      refresh: async () => void askMain("refresh", {}),
      sync: async () => void askMain("sync", {}),
      bumpCal: () => undefined,
    });
    // the restart of an update is the main window's
    useUpdates.setState({ restartToUpdate: async () => void (await askMain("update-restart", {}, 180_000)) });
    // the mailboxes and folders Settings lists, now and when another window changed them
    const load = async () => {
      const [accounts, folders] = await Promise.all([api.listAccounts().catch(() => null), api.listFolders().catch(() => null)]);
      if (dead) return;
      if (accounts) useStore.setState({ accounts });
      if (folders) useStore.setState({ folders });
    };
    void load();
    void useStore.getState().refreshAi();
    const subs = [
      listen("popout-refocus", (e) => {
        const r = refocusOf(e.payload);
        setNav({ tab: r.tab, focus: r.focus, nonce: Date.now() });
      }),
      listen<{ what?: string; from?: string }>("data-changed", (e) => {
        if (e.payload?.from !== label && (e.payload?.what === "accounts" || e.payload?.what === "calendar")) void load();
      }),
      listen("mail-synced", () => void load()),
    ];
    return () => {
      dead = true;
      for (const s of subs) void s.then((off) => off()).catch(quiet);
    };
  }, [label]);

  return (
    <div data-popout="settings">
      <Settings initial={nav.tab} focus={nav.focus} nonce={nav.nonce} section={first.section} windowed />
      {/* the dialogs of Settings open on top of the page, inside this window */}
      {dialog?.type === "pgp-generate" && <LazyGenerateKeyDialog accountId={dialog.accountId} back={dialog.back} />}
      {dialog?.type === "pgp-import" && <LazyImportKeyDialog armored={dialog.armored} paste={dialog.paste} back={dialog.back} />}
      {dialog?.type === "pgp-key" && <LazyKeyDetailsDialog fingerprint={dialog.fingerprint} back={dialog.back} />}
      <PassphraseHost />
    </div>
  );
}
