// The decisions behind the windows of the four kinds that W4.6 adds (event, Settings, search results, Scheduled list): their keys, what they are opened with, which preferences
// a window may ask the main page to change, and where "open Settings" goes. Pure (no browser, no Tauri), so scripts/test-popout.mjs runs it.
// Imports carry the `.ts` extension (this file is loaded by `node --experimental-strip-types`).

/** Settings and the Scheduled list exist once: asking for them again focuses the window (the same keys as src-tauri/src/popout.rs `Kind::single_key`). */
export const SETTINGS_KEY = "settings";
export const SCHEDULED_KEY = "scheduled";

export type SearchScopeName = "current" | "account" | "all";

/** What a search window is opened with: the search as the main window has it at that moment (REQ-4.6.13). */
export interface SearchInit {
  /** the search text with its operators, as typed (Advanced search writes its filters into it) */
  search: string;
  scope: SearchScopeName;
  /** the view the search ran in (`inbox`, `all`, a folder key) */
  folder: string;
  /** the mailbox selection (null = all mailboxes) */
  accountId: string | null;
  /** the list filter of the search box: all / unread / flagged */
  filter: "all" | "unread" | "flagged";
}

/** Reads the hand-off data defensively; null for a search without text (there is nothing to show). */
export function searchInit(raw: unknown): SearchInit | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const search = typeof r.search === "string" ? r.search.trim() : "";
  if (!search) return null;
  const scope = r.scope === "account" || r.scope === "all" ? r.scope : "current";
  const filter = r.filter === "unread" || r.filter === "flagged" ? r.filter : "all";
  return { search, scope, folder: typeof r.folder === "string" && r.folder ? r.folder : "inbox", accountId: typeof r.accountId === "string" && r.accountId ? r.accountId : null, filter };
}

/**
 * The key of a search window: the search normalised (case, spacing), its scope, the view, the mailbox and the filter. The same search focuses its window (REQ-4.6.13); a search
 * with another word, scope or filter is another window.
 */
export function searchKey(s: SearchInit): string {
  const text = s.search.trim().toLowerCase().replace(/\s+/g, " ");
  return ["search", text, s.scope, s.folder, s.accountId ?? "*", s.filter].join("\u0001");
}

/**
 * The key of an event window: the event, so that opening it again focuses its window; a new event has none (REQ-4.6.6). A part of a series (W7.1) has the part and the occurrence
 * in its key: another occurrence of the same series is another window.
 */
export const eventKey = (eventId: string | null | undefined, scope?: string | null, occurrenceStart?: number | null): string | null =>
  eventId ? (scope ? `event:${eventId}:${scope}:${occurrenceStart ?? ""}` : `event:${eventId}`) : null;

/**
 * May the window `from` ask the main page to change these preferences (REQ-4.6.3)? The Settings window any key of `Prefs` (`known`: the keys of the defaults); every other window
 * only the mail background of the reader (`mailCanvas`), which is the one thing a reader changes. Nothing for the main window itself (it writes its own).
 */
export function prefsPatchAllowed(from: string, patch: Record<string, unknown>, known: readonly string[]): boolean {
  const keys = Object.keys(patch);
  if (keys.length === 0) return false;
  if (from.startsWith("settings-")) return keys.every((k) => known.includes(k));
  return keys.length === 1 && keys[0] === "mailCanvas" && (patch.mailCanvas === "dark" || patch.mailCanvas === "original");
}

/**
 * Where a request to open the Settings dialog goes (REQ-4.6.9): to the Settings window while it exists (the window comes to the front on the asked tab), else the dialog of the
 * page. Only the main page decides; `windowOpen` is what the backend last said (`popout-count`).
 */
export function settingsTarget(windowOpen: boolean): "window" | "dialog" {
  return windowOpen ? "window" : "dialog";
}

/** What the Settings window is told when it is asked for again (`popout-refocus`): the tab and the focus target of the dialog that was meant, read defensively. */
export function refocusOf(raw: unknown): { tab?: string; focus?: string } {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return { tab: typeof r.tab === "string" ? r.tab : undefined, focus: typeof r.focus === "string" ? r.focus : undefined };
}

/** A mutation in one window of what other windows show (accounts, signatures ...): the part of the data that changed, sent as `data-changed` (REQ-4.6.4). */
export type DataChange = "accounts" | "signatures" | "templates" | "rules" | "pgp" | "calendar";

/** The commands whose success changes a list that other windows show, and which list (the page that made the change tells every other window). */
export const DATA_CHANGING: Readonly<Record<string, DataChange>> = {
  add_account: "accounts", update_account: "accounts", remove_account: "accounts",
  save_signature: "signatures", delete_signature: "signatures",
  save_template: "templates", delete_template: "templates",
  save_rule: "rules", delete_rule: "rules",
  pgp_generate_key: "pgp", pgp_import_key: "pgp", pgp_import_from_message: "pgp", pgp_delete_key: "pgp", pgp_set_default: "pgp", pgp_set_verified: "pgp", pgp_set_expiry: "pgp", pgp_change_passphrase: "pgp",
  calendar_connect: "calendar", calendar_disconnect: "calendar", calendar_set_sync: "calendar", calendar_set_visible: "calendar",
};
