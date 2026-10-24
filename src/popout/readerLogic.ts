// The decisions of the reader window (REQ-R1 ... R13) that do not need a browser or Tauri, so scripts/test-popout.mjs runs them.
// Imports carry the `.ts` extension (this file is loaded by `node --experimental-strip-types`).

/** What the opener leaves in the backend for a reader window (`popout_open` -> `popout_init`). The address holds none of it (REQ-S3). */
export interface ReaderInit {
  threadId: string;
  accountId: string;
  /** the folder the row was in (messages of the conversation in this folder keep the window "alive", see `isGone`) */
  folder: string;
  /** the view of the main window it was opened from: the scope of a move (Archive, Delete ... act on the mail of that view) */
  view: string;
  subject: string;
  /** the mailbox the main window had selected when the window was opened (null = all mailboxes): the list of Next / Previous when the main list no longer has the conversation (W4.4) */
  listAccount?: string | null;
}

/** Reads the hand-off data defensively: a reader window without a usable conversation id shows the "could not open" state. */
export function readerInit(raw: unknown): ReaderInit | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const s = (v: unknown, d = "") => (typeof v === "string" ? v : d);
  const threadId = s(r.threadId);
  if (!threadId) return null;
  return { threadId, accountId: s(r.accountId), folder: s(r.folder), view: s(r.view, s(r.folder)), subject: s(r.subject), listAccount: typeof r.listAccount === "string" ? r.listAccount : null };
}

/** A row Next / Previous can go to: what a reader window needs to show it (the main page answers with these, or null at the end of the list). */
export interface Neighbor {
  threadId: string;
  accountId: string;
  folder: string;
  subject: string;
  /** the view of the list the row was found in (the scope of a move from the next conversation) */
  view: string;
}

/**
 * The row after (`dir` 1) or before (`dir` -1) the conversation `threadId` in `rows`, skipping the rows a reader cannot show (`canOpen`: drafts, Scheduled);
 * no wrap at the ends. `null`: there is none, or `threadId` is not in the list.
 */
export function neighborOf<T extends { threadId: string }>(rows: readonly T[], threadId: string, dir: 1 | -1, canOpen: (row: T) => boolean): T | null {
  const at = rows.findIndex((r) => r.threadId === threadId);
  if (at < 0) return null;
  for (let i = at + dir; i >= 0 && i < rows.length; i += dir) if (canOpen(rows[i])) return rows[i];
  return null;
}

/** What the main page answers to `neighbors`, read defensively (`null` for a side that has no row or an answer that is not one). */
export function neighborsOf(raw: unknown): { prev: Neighbor | null; next: Neighbor | null } {
  const one = (v: unknown): Neighbor | null => {
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    return typeof o.threadId === "string" && o.threadId ? { threadId: o.threadId, accountId: typeof o.accountId === "string" ? o.accountId : "", folder: typeof o.folder === "string" ? o.folder : "", subject: typeof o.subject === "string" ? o.subject : "", view: typeof o.view === "string" ? o.view : typeof o.folder === "string" ? o.folder : "" } : null;
  };
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return { prev: one(r.prev), next: one(r.next) };
}

/**
 * Can this row be opened in a reader window? A draft is edited, not read: in Drafts these gestures open the compose window (WP6b); until
 * that exists they do nothing (a click still opens the draft in Compose, as before). The Scheduled list is not a list of conversations.
 */
export function readerAllowed(view: string, folder: string): boolean {
  return view !== "drafts" && view !== "scheduled" && folder !== "drafts";
}

/**
 * What a double click (or Shift+Enter) on a row of the list opens: a draft is edited (the compose window), a conversation is read (the reader
 * window), the Scheduled list and anything else opens nothing. The decision is only about the row, never about the setting for new messages.
 */
export function rowWindowTarget(view: string, folder: string): "draft" | "reader" | "none" {
  if (view === "drafts") return "draft";
  return readerAllowed(view, folder) ? "reader" : "none";
}

/** Views of the main window that are not one IMAP folder (the move scope of such a view is "every folder the view can show"). */
const VIRTUAL = new Set(["starred", "pinned", "snoozed", "all", "scheduled"]);

/** The IMAP-side scope of a view for a move: the folder itself, nothing for the cross-folder views (`unread` reads the Inbox). Same rule as the main window's `scopeOf`. */
export function scopeOfView(view: string): string | undefined {
  if (view === "unread") return "inbox";
  return VIRTUAL.has(view) ? undefined : view;
}

/** The scope `get_thread` needs: Trash and Junk mail is only part of a conversation while that folder is the one looked at. */
export function threadScope(folder: string): string | undefined {
  return folder === "trash" || folder === "junk" ? folder : undefined;
}

/**
 * The conversation was moved or deleted elsewhere (REQ-R9): none of its messages is left (deleted, moved to Trash / Junk, the account
 * was removed), or none is left in the folder the window was opened from (archived, moved). A conversation opened from a cross-folder
 * view has no folder to compare with: only "nothing left" counts then.
 */
export function isGone(messages: readonly { folder: string }[], home: string): boolean {
  if (messages.length === 0) return true;
  if (!home || VIRTUAL.has(home)) return false;
  return !messages.some((m) => m.folder === home);
}

/** What a move-like action does to the window: it closes at once (REQ-R6). Flag, pin and read state keep it open (REQ-R7). */
export const MOVE_ACTIONS: ReadonlySet<string> = new Set(["archive", "trash", "junk", "block", "snooze"]);
/** The yes/no states of a conversation that the main window's intent layer sets (last click wins, one call at a time). */
export const STATE_ACTIONS: ReadonlySet<string> = new Set(["read", "unread", "star", "unstar", "pin", "unpin", "unsnooze"]);

export type ReaderAction = "reply" | "replyAll" | "forward" | "archive" | "trash" | "junk" | "unread" | "pin" | "flag" | "snooze" | "print" | "close" | "prev" | "next";

/** Actions that stay on when the conversation is gone (REQ-R9: only Close and Reply / Forward). */
export function allowedWhenGone(a: ReaderAction): boolean {
  return a === "close" || a === "reply" || a === "replyAll" || a === "forward";
}

export interface KeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export interface KeyContext {
  mac: boolean;
  /** the focus is in a field or an editor (typing) */
  inField: boolean;
  /** a dialog, a question or the passphrase prompt is open */
  modalOpen: boolean;
}

/**
 * The key table of the reader (REQ-R13): r, a, f, e, # / Delete (Backspace on macOS), !, u, *, p, s, j / k (next / previous conversation, W4.4), Ctrl+P / Cmd+P (macOS prints through the backend since W5.3), Esc, Ctrl+W / Cmd+W.
 * `null`: not a reader key. Never while typing in a field; Esc never while something modal is open (it closes that first).
 */
export function readerKey(e: KeyEvent, ctx: KeyContext): ReaderAction | null {
  if (ctx.inField) return null;
  const k = e.key;
  const cmd = e.ctrlKey || e.metaKey;
  if (cmd && !e.altKey && !e.shiftKey && k.toLowerCase() === "w") return "close";
  if (cmd && !e.altKey && !e.shiftKey && k.toLowerCase() === "p") return "print";
  if (cmd || e.altKey) return null;
  if (k === "Escape") return ctx.modalOpen ? null : "close";
  if (ctx.modalOpen) return null;
  switch (k) {
    case "r": return "reply";
    case "a": return "replyAll";
    case "f": return "forward";
    case "e": return "archive";
    case "#": case "Delete": return "trash";
    case "Backspace": return ctx.mac ? "trash" : null;
    case "!": return "junk";
    case "u": return "unread";
    case "p": return "pin";
    case "*": return "flag";
    case "s": return "snooze";
    case "j": return "next";
    case "k": return "prev";
    default: return null;
  }
}

/** When the conversation is marked read after opening (REQ-R8; the rule of the main reading pane): at once, after `delay` seconds, or not. */
export type ReadPlan = { kind: "none" } | { kind: "now" } | { kind: "after"; ms: number };
export function markReadPlan(messages: readonly { seen: boolean }[], delaySeconds: number): ReadPlan {
  if (!messages.some((m) => !m.seen) || delaySeconds < 0) return { kind: "none" };
  return delaySeconds === 0 ? { kind: "now" } : { kind: "after", ms: delaySeconds * 1000 };
}

/**
 * The state the person asked for in this window that the server may not have yet (REQ-R7: the window shows it at once). It is laid over
 * what the database says while a request for it is under way; when the last request of the window is answered the database is read again,
 * which also rolls a failure back. The same rules as the main window's optimistic update (store.ts `applyOptimistic`).
 */
export interface Wanted {
  /** true = every message flagged, false = none */
  flagged?: boolean;
  pinned?: boolean;
  /** true = the newest message is unread; false = all are read */
  unread?: boolean;
}

export function withWanted<M extends { seen: boolean; flagged: boolean }>(messages: readonly M[], w: Wanted): M[] {
  if (w.flagged === undefined && w.unread === undefined) return messages as M[];
  return messages.map((m, i) => {
    let n = m;
    if (w.unread !== undefined) {
      const seen = w.unread ? (i < messages.length - 1 ? m.seen : false) : true;
      if (seen !== m.seen) n = { ...n, seen };
    }
    if (w.flagged !== undefined && w.flagged !== m.flagged) n = { ...n, flagged: w.flagged };
    return n;
  });
}

/** Flagged when any message is (the Flag button of the reading pane shows the conversation that way). */
export function isFlagged(messages: readonly { flagged: boolean }[]): boolean {
  return messages.some((m) => m.flagged);
}

/** Unread when any message is. */
export function isUnread(messages: readonly { seen: boolean }[]): boolean {
  return messages.some((m) => !m.seen);
}

/** The text of the title bar's "{title} – Hey Look!" (REQ-W7): the subject of the conversation, or the words for "no subject". */
export function readerTitleText(subject: string, noSubject: string): string {
  return subject.trim() || noSubject;
}
