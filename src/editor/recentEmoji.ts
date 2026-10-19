// The emoji used lately (Insert > Emoji > "Recently used"), newest first, at most 16, kept in the preferences (`recentEmoji`, shared by the message editor and the
// signature / template editors). Tiny and pure: the preferences read it at start-up, so it must not pull in the emoji list or the names (those are lazy, insertUi.tsx).

export const RECENT_EMOJI_MAX = 16;

/** Whether a stored value can be an emoji the picker offers: a short text that starts with a pictograph (the picker itself shows only the ones it knows). */
const looksLikeEmoji = (e: unknown): e is string => typeof e === "string" && e.length > 0 && e.length <= 16 && /^\p{Extended_Pictographic}/u.test(e);

/** The saved list as it is used: only emoji, each once, the first 16. `known` (the picker's emoji) narrows it to those. */
export function cleanRecentEmoji(raw: unknown, known?: ReadonlySet<string>): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const e of raw) {
    if (!looksLikeEmoji(e) || out.includes(e) || (known && !known.has(e))) continue;
    out.push(e);
    if (out.length === RECENT_EMOJI_MAX) break;
  }
  return out;
}

/** `emoji` goes first; an earlier use of it moves up instead of repeating; the list stays at 16. */
export function pushRecentEmoji(list: readonly string[], emoji: string): string[] {
  return [emoji, ...list.filter((e) => e !== emoji)].slice(0, RECENT_EMOJI_MAX);
}
