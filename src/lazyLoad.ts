// Loading a part of the app on demand (1.0.7 WP9d, REQ-9.2.5): the editor, Settings, the Calendar, the PGP dialogs and the pop-out views are chunks of their own (src/lazyViews.tsx).
// This is the part with no React in it: one `import()` per part at a time, a success is remembered, a failure is retried once after 500 ms and then NOT remembered (the next
// try fetches again). Plain TypeScript so scripts/test-lazy-load.mjs runs it in Node.

/** Wait before the one retry of a failed chunk (the same as the language chunks, i18n/index.ts). */
export const LAZY_RETRY_MS = 500;
/** A part that is not there this long after it was asked for shows the loading look (REQ-9.2.4; the pending state is painted by 150 ms, spec-107-wp13e-feedback RULE-2). */
export const LAZY_LOOK_MS = 150;

interface Entry {
  mod?: unknown;
  inflight?: Promise<unknown>;
}
const entries = new Map<string, Entry>();

/** Waiting between the two tries; replaced in the node tests. */
let pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export function setLazyPause(f: (ms: number) => Promise<void>): void {
  pause = f;
}

const isDev = (): boolean => !!(import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV;
const isNode = (): boolean => !!(globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node;
/**
 * Dev preview seam `#lazyfail=<compose|settings|calendar|pgp|dialogs|popout>` (several: `lazyfail=settings,pgp`): the load of that part fails, every try, to see the failure path.
 * Read at each try, so taking it out of the address makes the next try work. Dev builds only (the node tests set `globalThis.__heylookLazyFail`).
 */
export function failSeam(kind: string): boolean {
  if (isDev() && typeof window !== "undefined") {
    const m = /(?:^|[#&])lazyfail=([^&]*)/.exec(window.location.hash);
    if (m && m[1].split(",").includes(kind)) return true;
  }
  return isNode() && ((globalThis as { __heylookLazyFail?: string[] }).__heylookLazyFail ?? []).includes(kind);
}

async function attempt<M>(kind: string, importer: () => Promise<M>): Promise<M> {
  if (failSeam(kind)) throw new Error(`the part "${kind}" could not be loaded (#lazyfail)`); // i18n-ok: dev preview seam, never reached in a release build
  return importer();
}

/**
 * The module behind `importer`, loaded once (`key` names it; parts that share a chunk may share a key). Resolves with the module; rejects after the retry. A second call while the first
 * runs gets the same promise. `kind` is the name the dev seam answers to.
 */
export function loadLazy<M>(key: string, importer: () => Promise<M>, kind: string = key): Promise<M> {
  let e = entries.get(key);
  if (!e) entries.set(key, (e = {}));
  if (e.mod !== undefined) return Promise.resolve(e.mod as M);
  if (!e.inflight) {
    const entry = e;
    entry.inflight = (async () => {
      try {
        return await attempt(kind, importer);
      } catch {
        await pause(LAZY_RETRY_MS);
        return attempt(kind, importer); // a second failure goes to the caller
      }
    })().then(
      (m) => {
        entry.mod = m;
        entry.inflight = undefined;
        return m;
      },
      (err: unknown) => {
        entry.inflight = undefined; // not remembered: the next try fetches again
        throw err;
      },
    );
  }
  return e.inflight as Promise<M>;
}

/** The module when it is loaded already (a view that is there is drawn in the same render, with no loading step), else undefined. */
export function peekLazy<M>(key: string): M | undefined {
  return entries.get(key)?.mod as M | undefined;
}

/** Start loading in the background; a failure is swallowed (the real use asks again and reports it). */
export function prefetchLazy(key: string, importer: () => Promise<unknown>, kind: string = key): void {
  void loadLazy(key, importer, kind).catch(() => undefined);
}

/** Forget everything (the node tests). */
export function resetLazy(): void {
  entries.clear();
}
