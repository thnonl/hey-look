import type { ReactNode } from "react";
import { ComposeFrame } from "./components/ComposeFrame";
import { Modal } from "./components/ui";
import type { Key } from "./i18n";
import { useT } from "./i18n/react";
import { lazyView, LazyLoading } from "./lazy";
import { prefetchLazy } from "./lazyLoad";
import type { SearchAdvancedProps } from "./components/SearchAdvanced";
import { useStore } from "./store";

// The big parts of the app that are loaded when they are needed (1.0.7 WP9d, W9.2; the plan is spec-107-wp9 section 2.2). THIS is the only place that imports them (a `import()` each);
// everything else uses the wrappers below, so the main chunk holds none of them (scripts/bundle-budget.json `mustBeLazy` keeps it that way):
//   editor      Compose, RichEditor, src/editor/*, tiptap, prosemirror              fetched when the browser is idle after the first paint and when a pointer reaches a button that needs it
//   settings    the Settings dialog with the signature editor and the updates block  on open
//   calendar    the Calendar view, its side menu and the event dialog                 on the first switch to Calendar / the first event dialog
//   pgp         Generate key, Import key, Key details, the passphrase question        on open
//   dialogs     the bulk cleaner and Show original                                   on open
//   search      "Advanced search" of the search panel (filters, dates, fields)       when the person opens it
//   folder      the New folder / New subfolder dialog                                on open
//   popout      the compose window's and the reader window's view                    their own window (popout/views.tsx)
// Loading, retry and failure: lazy.tsx / lazyLoad.ts.

// ---- the parts -------------------------------------------------------------------------------------------------------------

const composeModule = () => import("./components/Compose");
/** The editor stack, and the nodes the editor needs (editor/kit.ts) so the first message opens with no second wait. */
const loadEditor = () => composeModule().then(async (m) => (await m.loadEditorKit(), m));
const settingsModule = () => import("./components/SettingsDialog");
const calendarModule = () => import("./components/Calendar");
const pgpModule = () => import("./components/PgpDialogs");
const dialogsModule = () => import("./components/Dialogs");
const searchAdvancedModule = () => import("./components/SearchAdvanced");
const folderModule = () => import("./components/FolderDialog");

export const loadComposeWindowView = () => import("./popout/ComposeView").then(async (m) => (await m.ready(), m));
export const loadReaderWindowView = () => import("./popout/ReaderView");
export const loadEventWindowView = () => import("./popout/EventView");
export const loadSettingsWindowView = () => import("./popout/SettingsView");
export const loadSearchWindowView = () => import("./popout/SearchView");
export const loadScheduledWindowView = () => import("./popout/ScheduledView");

// ---- prefetch ---------------------------------------------------------------------------------------------------------------

/** Fetch the editor now (no screen change; a failure is told when the editor is really asked for). */
export function prefetchEditor(): void {
  prefetchLazy("editor", loadEditor, "compose");
}

/** The compose window asks for its view and the editor before React renders (main.tsx). */
export function prefetchComposeWindow(): void {
  prefetchLazy("popout-compose", loadComposeWindowView, "popout");
}
export function prefetchReaderWindow(): void {
  prefetchLazy("popout-reader", loadReaderWindowView, "popout");
}
/** The view of an event / Settings / search / Scheduled window (main.tsx, before React renders). */
export function prefetchWindowView(kind: "event" | "settings" | "search" | "scheduled"): void {
  const load = { event: loadEventWindowView, settings: loadSettingsWindowView, search: loadSearchWindowView, scheduled: loadScheduledWindowView }[kind];
  prefetchLazy(`popout-${kind}`, load, "popout");
}

let idleDone = false;
/** The editor chunk, when the browser is idle after the first paint (`requestIdleCallback`, 2 s at most; engines without it, WebKit among them, wait 1 s). Once. */
export function prefetchEditorWhenIdle(): void {
  if (idleDone || typeof window === "undefined") return;
  idleDone = true;
  const w = window as unknown as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number };
  if (w.requestIdleCallback) w.requestIdleCallback(prefetchEditor, { timeout: 2000 });
  else setTimeout(prefetchEditor, 1000);
}

/**
 * A pointer or the keyboard focus reaching a button that will open the editor (New mail, Reply, Reply all, Forward: `data-intent="editor"`) fetches it at once, so the first
 * Reply after the start finds it there (REQ-13.13.9). Returns the function that removes the listeners.
 */
export function installEditorIntent(): () => void {
  const on = (e: Event) => {
    if (e.target instanceof Element && e.target.closest('[data-intent="editor"]')) {
      prefetchEditor();
      off();
    }
  };
  const off = () => {
    document.removeEventListener("pointerover", on, true);
    document.removeEventListener("focusin", on, true);
  };
  document.addEventListener("pointerover", on, true);
  document.addEventListener("focusin", on, true);
  return off;
}

// ---- frames -----------------------------------------------------------------------------------------------------------------

/** The frame of a dialog: the title and the box at once (so the click visibly worked), the loading look in the body after 150 ms. */
function DialogFrame({ title, late, wide, width, onClose }: { title: Key; late: boolean; wide?: boolean; width?: number; onClose: () => void }) {
  const t = useT();
  return (
    <Modal title={t(title)} onClose={onClose} wide={wide} width={width}>
      {late ? <LazyLoading /> : <div className="lazy-load" aria-hidden />}
    </Modal>
  );
}
const closeDialog = () => useStore.getState().setDialog(null);
const frame = (title: Key, o: { wide?: boolean; width?: number } = {}) => (_p: unknown, late: boolean): ReactNode => <DialogFrame title={title} late={late} wide={o.wide} width={o.width} onClose={closeDialog} />;

// ---- the wrappers -----------------------------------------------------------------------------------------------------------

type NoProps = Record<never, never>;

type EditorModule = Awaited<ReturnType<typeof loadEditor>>;
type ComposeProps = React.ComponentProps<EditorModule["Compose"]>;

/** The message being written in the pane. The editor is drawn in the same render when it is there; else the frame of the pane (a Reply's shell from the first frame on). */
export const LazyCompose = lazyView<EditorModule, ComposeProps>({
  key: "editor",
  kind: "compose",
  load: loadEditor,
  pick: (m) => m.Compose,
  frame: (p, late) => <ComposeFrame init={p.init} late={late} />,
  // nothing half open: the pane is closed (a Reply's shell too: its result is dropped, answerShell.ts)
  failed: () => void useStore.getState().openCompose(null, { restore: false }),
});

type SettingsModule = Awaited<ReturnType<typeof settingsModule>>;
export const LazySettings = lazyView<SettingsModule, React.ComponentProps<SettingsModule["Settings"]>>({
  key: "settings",
  kind: "settings",
  load: settingsModule,
  pick: (m) => m.Settings,
  dialog: true,
  frame: frame("settings.title", { wide: true }),
  failed: closeDialog,
});

/** The Settings page as the page of the Settings window (W4.6): nothing is drawn but the loading look while it loads. */
export const LazySettingsWindowForm = lazyView<SettingsModule, React.ComponentProps<SettingsModule["Settings"]>>({ key: "settings", kind: "settings", load: settingsModule, pick: (m) => m.Settings });

type CalendarModule = Awaited<ReturnType<typeof calendarModule>>;
const calendarOpts = { key: "calendar", kind: "calendar", load: calendarModule } as const;
/** The Calendar pane. */
export const LazyCalendarView = lazyView<CalendarModule, NoProps>({
  ...calendarOpts,
  pick: (m) => m.CalendarView,
  frame: function CalendarFrame(_p, late) {
    return <CalendarFrameBox late={late} />;
  },
  // nothing half open: back to Mail
  failed: () => useStore.getState().setModule("mail"),
});
function CalendarFrameBox({ late }: { late: boolean }) {
  const t = useT();
  return (
    <section className="cal-view" aria-label={t("calendar.title")} aria-busy="true">
      {late ? <LazyLoading /> : null}
    </section>
  );
}
/** The side menu of the Calendar module (the folder pane): the pane tells the failure, these say nothing of their own. */
export const LazyCalSidebar = lazyView<CalendarModule, NoProps>({ ...calendarOpts, pick: (m) => m.CalSidebar, quiet: true });
export const LazyCalRail = lazyView<CalendarModule, NoProps>({ ...calendarOpts, pick: (m) => m.CalRail, quiet: true });

type EventProps = React.ComponentProps<CalendarModule["EventDialog"]>;
export const LazyEventDialog = lazyView<CalendarModule, EventProps>({
  ...calendarOpts,
  pick: (m) => m.EventDialog,
  dialog: true,
  frame: (p, late) => <DialogFrame title={p.eventId ? "calendar.dialog.editTitle" : "calendar.newEvent"} late={late} width={560} onClose={closeDialog} />,
  failed: closeDialog,
});

/** The event form as the page of an event window (W4.6): nothing is drawn but the loading look while it loads; a failure is told by a toast and the window can be closed as usual. */
export const LazyEventWindowForm = lazyView<CalendarModule, EventProps>({ ...calendarOpts, pick: (m) => m.EventDialog });

type PgpModule = Awaited<ReturnType<typeof pgpModule>>;
const pgpOpts = { key: "pgp", kind: "pgp", load: pgpModule, dialog: true, failed: closeDialog } as const;
export const LazyGenerateKeyDialog = lazyView<PgpModule, React.ComponentProps<PgpModule["GenerateKeyDialog"]>>({ ...pgpOpts, pick: (m) => m.GenerateKeyDialog, frame: frame("pgp.gen.title") });
export const LazyImportKeyDialog = lazyView<PgpModule, React.ComponentProps<PgpModule["ImportKeyDialog"]>>({ ...pgpOpts, pick: (m) => m.ImportKeyDialog, frame: frame("pgp.import.title") });
export const LazyKeyDetailsDialog = lazyView<PgpModule, React.ComponentProps<PgpModule["KeyDetailsDialog"]>>({ ...pgpOpts, pick: (m) => m.KeyDetailsDialog, frame: frame("pgp.details.title") });
/** The passphrase question: nothing is drawn while it loads (it was asked for by an action that is waiting for the answer); a failure answers "not unlocked". */
export const LazyPassphraseDialog = lazyView<PgpModule, NoProps>({
  key: "pgp",
  kind: "pgp",
  load: pgpModule,
  pick: (m) => m.PassphraseDialog,
  failed: () => useStore.getState().resolvePassphrase(false),
});

type DialogsModule = Awaited<ReturnType<typeof dialogsModule>>;
const dialogsOpts = { key: "dialogs", kind: "dialogs", load: dialogsModule, dialog: true, failed: closeDialog } as const;
export const LazyBulkCleaner = lazyView<DialogsModule, NoProps>({ ...dialogsOpts, pick: (m) => m.BulkCleaner, frame: frame("app.sweep.title", { wide: true }) });
export const LazyShowOriginal = lazyView<DialogsModule, React.ComponentProps<DialogsModule["ShowOriginal"]>>({ ...dialogsOpts, pick: (m) => m.ShowOriginal, frame: frame("app.original.title", { wide: true }) });

type SearchAdvancedModule = Awaited<ReturnType<typeof searchAdvancedModule>>;
/** "Advanced search" inside the search panel: nothing is drawn while it loads except the loading look after 150 ms; a failure folds the section back (the toast tells why). */
export const LazySearchAdvanced = lazyView<SearchAdvancedModule, SearchAdvancedProps>({
  key: "search",
  kind: "search",
  load: searchAdvancedModule,
  pick: (m) => m.SearchAdvanced,
  failed: (p) => p.onFail?.(),
});

type FolderModule = Awaited<ReturnType<typeof folderModule>>;
/** New folder / New subfolder: the frame (title and box) at once, the form when the part is there. */
export const LazyFolderDialog = lazyView<FolderModule, React.ComponentProps<FolderModule["FolderDialog"]>>({
  key: "folder",
  kind: "folder",
  load: folderModule,
  pick: (m) => m.FolderDialog,
  dialog: true,
  frame: (p, late) => <DialogFrame title={p.parentKey ? "mail.folder.dlgTitleSub" : "mail.folder.dlgTitle"} late={late} width={440} onClose={closeDialog} />,
  failed: closeDialog,
});
