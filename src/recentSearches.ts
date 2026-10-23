// The list of recent searches (Settings of the person, this computer only: prefs.recentSearches, never sent anywhere). Newest first, at most MAX_RECENT (W13.4, REQ-13.4.3).
export const MAX_RECENT = 5;

/** A list read from the stored preferences: text entries only, trimmed, each once (the first, i.e. the newest, stays), at most MAX_RECENT. */
export function cleanRecent(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string") continue;
    const q = x.trim();
    if (q && !out.includes(q)) out.push(q);
    if (out.length === MAX_RECENT) break;
  }
  return out;
}

/** `q` becomes the newest entry; an earlier identical one is dropped, the oldest beyond MAX_RECENT go. An empty text changes nothing. */
export function pushRecent(list: string[], q: string): string[] {
  const t = q.trim();
  if (!t) return list;
  return [t, ...list.filter((r) => r !== t)].slice(0, MAX_RECENT);
}

export const removeRecent = (list: string[], q: string): string[] => list.filter((r) => r !== q);
