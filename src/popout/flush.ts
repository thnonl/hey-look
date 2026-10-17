// The part of a secondary window in a quit or an update restart: the backend sends `popout-flush` to every window whose page is ready
// (lib.rs `ask_windows`, quitwait.rs gives each window its own bounded wait), and the window must save what it holds and answer once.
// The pop-out counterpart of src/quitFlush.ts: no Tauri and no store here (everything comes in through `deps`), so
// scripts/test-popout.mjs runs it. A view registers a handler (`registerFlushHandler`); with none registered the window answers
// "go on" at once. WP6b registers the compose window's: save to Drafts quietly, and when that fails show the "not saved" question
// (`ctx.showWindow()`, then `ctx.dialog(true)` / `ctx.dialog(false)` around it so that the backend waits for the person, 60 s at most)
// and return `false` for "Keep writing".

export interface FlushCtx {
  /** The quit waits (`true`, for 60 s at most) or no longer waits (`false`) for the person's answer. */
  dialog(open: boolean): void;
  /** Bring this window to the front (a question needs a window the person can see). */
  showWindow(): void;
}

/** Returns `false` when the person chose to keep the window open (the whole quit is cancelled); anything else means "go on". */
export type FlushHandler = (ctx: FlushCtx) => Promise<boolean | void> | boolean | void;

const handlers = new Set<FlushHandler>();

/** Register a handler for this window's lifetime; returns the function that removes it. */
export function registerFlushHandler(h: FlushHandler): () => void {
  handlers.add(h);
  return () => void handlers.delete(h);
}

export function flushHandlerCount(): number {
  return handlers.size;
}

export interface FlushDeps {
  /** The request arrived: the backend waits for the work to finish, not only for a first sign. */
  alive(): void;
  /** The answer to the backend, always called once. */
  done(go: boolean): void;
  ctx: FlushCtx;
  handlers(): FlushHandler[];
}

export async function runPopoutFlush(d: FlushDeps): Promise<boolean> {
  let go = true;
  try {
    d.alive();
    for (const h of d.handlers()) {
      if ((await h(d.ctx)) === false) {
        go = false;
        break; // the person keeps the window: nothing after it is asked
      }
    }
  } catch {
    /* quit anyway: the backend must hear an answer (otherwise it waits out its limit) */
  } finally {
    d.done(go);
  }
  return go;
}

export function currentFlushHandlers(): FlushHandler[] {
  return [...handlers];
}
