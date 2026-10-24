// "Search mail for the selection" (1.0.7 W8.1): what the text menu searches for when text of a message is selected. Pure, so scripts/test-selection-search.mjs runs it with node.
// The words are searched like typed words (an AND of words, not an exact phrase: the stored body text has other line breaks than the screen); the search box then shows them.

/** The operators of the backend's `parse_query` (src-tauri/src/lib.rs). A selected word that starts with one of them and a colon must not be read as a filter. */
const OPERATORS = new Set(["from", "to", "cc", "subject", "body", "has", "hasattachment", "hasattachments", "is", "after", "since", "before", "until", "folder", "in"]);

const MAX_WORDS = 8;
export const MAX_CHARS = 100;
/** The longest selection text shown in the menu entry (the search itself keeps its 8 words). */
const LABEL_CHARS = 30;

/**
 * The search for the selected text: spaces and line breaks become one space, quotes go, `from:x` becomes `from x` (any operator, any case), at most the first 8 words and 100 characters
 * (cut at the end of a word), trimmed. null when nothing is left (no menu entry).
 */
export function selectionQuery(text: string): string | null {
  const words = text
    .replace(/"/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => {
      const i = w.indexOf(":");
      return i > 0 && OPERATORS.has(w.slice(0, i).toLowerCase()) ? `${w.slice(0, i)} ${w.slice(i + 1)}`.trim() : w;
    })
    .join(" ")
    .split(/\s+/) // (`from:` + a value made two words: the 8-word cut counts the words the search will see)
    .filter(Boolean)
    .slice(0, MAX_WORDS);
  let out = "";
  for (const w of words) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > MAX_CHARS) break;
    out = next;
  }
  if (!out && words[0]) out = words[0].slice(0, MAX_CHARS); // (one word longer than the limit: cut inside it)
  return out || null;
}

/** The query as the menu entry shows it: at most 30 characters, then an ellipsis. */
export function selectionLabel(query: string): string {
  const chars = Array.from(query);
  return chars.length > LABEL_CHARS ? `${chars.slice(0, LABEL_CHARS).join("")}…` : query;
}

/**
 * How "Search mail for ..." runs: unset in the main window (the menu searches there, store.setSearch); a reader window sets it (popout/readerBridge.ts) to ask the main page
 * with the checked request `search`.
 */
export const searchVia: { run?: (query: string) => void } = {};

/** What a reader window may ask the main page to search for (REQ-8.1.6): a string of at most 200 characters that `selectionQuery` leaves as it is, else null. */
export function checkedSearchText(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 200) return null;
  const q = selectionQuery(raw);
  return q;
}
