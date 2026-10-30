// Remote pictures of a message, fetched through the backend (api.fetchRemoteImages: url -> data: URI) so that the webview never contacts the sender's servers itself. One cache
// for the whole window, shared by the reading pane (ReadingPane.tsx) and by the quoted original of a reply / forward (editor/quoteNode.ts): a reply to a message that was just
// read shows its pictures at once, and one policy ("Load remote content" of the account) decides in both places. Capped by size (the oldest go first): a long session with
// newsletters would else keep every picture it ever showed.
import { api } from "./api";

const cache = new Map<string, string>();
const CACHE_CHARS = 40_000_000;
let chars = 0;

/** The data: URI of a picture that was fetched already. */
export const cachedImage = (url: string): string | undefined => cache.get(url);
export const hasCachedImage = (url: string): boolean => cache.has(url);

function cacheImage(url: string, data: string): void {
  chars -= cache.get(url)?.length ?? 0;
  cache.delete(url);
  cache.set(url, data);
  chars += data.length;
  while (chars > CACHE_CHARS && cache.size > 1) {
    const oldest = cache.keys().next().value as string;
    chars -= cache.get(oldest)?.length ?? 0;
    cache.delete(oldest);
  }
}

/** Addresses that did not answer, and when: a quote that is drawn again (the composer mounts its editor more than once for one message) does not ask for them again for a while. */
const failed = new Map<string, number>();
const RETRY_AFTER_MS = 60_000;

/** The backend fetches at most this many addresses per call (fetch_remote_images in lib.rs). */
const PER_CALL = 60;

/**
 * Fetches what is not cached yet (a call per 60 addresses) and caches it; returns how many pictures came in. Never rejects: a picture that could not be fetched is simply not in the
 * cache afterwards. `retry`: asks again for the addresses that failed a moment ago (the person pressed "Load content").
 */
export async function loadRemoteImages(urls: readonly string[], retry = false): Promise<number> {
  let n = 0;
  const now = Date.now();
  const missing = [...new Set(urls)].filter((u) => !cache.has(u) && (retry || now - (failed.get(u) ?? -Infinity) > RETRY_AFTER_MS));
  for (let i = 0; i < missing.length; i += PER_CALL) {
    try {
      const got = await api.fetchRemoteImages(missing.slice(i, i + PER_CALL));
      for (const [u, d] of Object.entries(got ?? {})) {
        cacheImage(u, d);
        n++;
      }
      for (const u of missing.slice(i, i + PER_CALL)) if (!cache.has(u)) failed.set(u, now);
    } catch {
      /* (offline, or the host does not answer: the picture stays a box) */
    }
  }
  return n;
}
