// The page's part of a quit (REQ-48 b, c): a message being written is saved (and the person is asked when that fails), every message still in
// its Undo time goes out, and the backend is told whether the quit goes on. No Tauri and no store here (everything comes in through `deps`), so
// the sequence can be tested (scripts/test-quit-flush.mjs). The backend side is src-tauri/src/quitwait.rs: it gives a page that says nothing
// 8 s, a page that works 45 s and a question to the person 60 s, and then quits without it, so the first thing this does is to say "I am here".

export interface QuitFlushDeps {
  /** The request arrived: the backend waits for the work to finish, not only for a first sign. */
  alive(): void;
  /** Bring the window in front of the person (a question while the app sat in the tray). */
  showWindow(): void;
  /** The quit waits (`true`) or no longer waits (`false`) for the person's answer. */
  dialog(open: boolean): void;
  /** The answer to the backend: `go` false = the person keeps the window open. Always called, once. */
  done(go: boolean): void;
  /**
   * The message being written when it has unsaved changes; null when there is none. `scheduled`: a scheduled message being edited. `empty`: nothing
   * in it is worth a draft (only recipients, or everything typed was deleted again, W13.5): it is neither saved nor asked about.
   */
  unsaved(): { scheduled: boolean; empty?: boolean; save: ((o: { quiet: boolean }) => Promise<boolean | void>) | null } | null;
  /** The question; resolves to the id of the chosen answer, "quit" being the one that goes on. */
  ask(kind: "scheduledEdit" | "notSaved"): Promise<string>;
  /** The message was saved: the pane is emptied. */
  saved(): Promise<void>;
  /** A message with nothing worth a draft: no draft is written, the copy an autosave made of a new message goes, the snapshot goes, the pane is emptied. */
  emptied(): Promise<void>;
  /** "Quit and discard" was the answer: the message must not come back at the next start either. */
  discarded(): Promise<void>;
  /** Messages being sent now (the person is told). */
  inFlight(): number;
  tell(n: number): void;
  /** Let every message in its Undo time go out and wait for the sends under way (at most `ms`). */
  flush(ms: number): Promise<unknown>;
}

export async function runQuitFlush(d: QuitFlushDeps): Promise<boolean> {
  let go = true;
  try {
    d.alive();
    const u = d.unsaved();
    if (u) {
      if (u.empty && !u.scheduled) {
        await d.emptied();
      } else if (u.scheduled) {
        // a scheduled message being edited stays as it was
        d.showWindow();
        d.dialog(true);
        const c = await d.ask("scheduledEdit");
        d.dialog(false);
        go = c === "quit";
      } else {
        const saved = u.save ? await u.save({ quiet: true }) : false;
        if (saved === true) {
          await d.saved(); // (saved: no snapshot is needed; the process may end right after this)
        } else {
          d.showWindow();
          d.dialog(true);
          const c = await d.ask("notSaved");
          d.dialog(false);
          go = c === "quit";
          if (go) await d.discarded();
        }
      }
    }
    if (go) {
      const n = d.inFlight();
      if (n > 0) d.tell(n);
      await d.flush(20_000);
    }
  } catch {
    /* quit anyway */
  } finally {
    d.done(go);
  }
  return go;
}
