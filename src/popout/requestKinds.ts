// What the main page accepts from a secondary window (REQ-S4): each kind of request is checked here before anything is done, so a page can
// ask for these things and nothing else. Pure, so scripts/test-popout.mjs runs it. (src/popout/mainRequests.ts does the work.)

/** The envelope the backend sends to the main page (`popout-request`): `from` is stamped by the backend. */
export interface Envelope {
  id: string;
  from: string;
  kind: string;
  payload: unknown;
}

/** A thread action a reader may ask for: the buttons and keys of its toolbar, nothing else (no delete-forever, no move to a named folder). */
export const READER_ACTIONS: ReadonlySet<string> = new Set([
  "read", "unread", "star", "unstar", "pin", "unpin", "archive", "trash", "junk", "block", "snooze", "unsnooze",
]);

/**
 * The toast texts a reader may ask the main page to show (keys of the reading toolbar). The reader sends the key and its values, never the
 * text: the toast is made in the main window and follows a language change while it is on screen.
 */
export const READER_LABELS: ReadonlySet<string> = new Set([
  "reading.head.archived", "reading.head.trashed", "reading.head.movedJunk", "reading.head.markedUnread", "reading.head.snoozed", "reading.head.blocked",
]);

export interface ThreadActionReq {
  threadId: string;
  action: string;
  arg?: string;
  labelKey?: string;
  labelParams?: Record<string, string>;
  /** the view of the main window the conversation was opened from (the scope of a move) */
  view?: string;
}

export type ComposeMode = "reply" | "replyAll" | "forward";

export interface ComposeReq {
  mode: ComposeMode;
  /** the message answered, as the reader holds it */
  message: Record<string, unknown>;
  /** the Message-ID of every message of the conversation (the fallback References of the answer) */
  threadMessageIds: (string | null)[];
}

/** A new message started from a reader (unsubscribe by mail, "attach to a new message"): only what those two need. */
export interface ComposeNewReq {
  accountId: string;
  to?: string[];
  subject?: string;
  attachments?: { filename: string; mime: string; dataBase64: string }[];
}

/** Dialogs of the main window that a reader may open (REQ-R11): Settings, the event dialog and the PGP key dialogs. */
export type DialogReq = { type: "settings"; tab?: string; focus?: string } | { type: "event"; init?: Record<string, unknown> } | { type: "pgp-key"; fingerprint: string } | { type: "pgp-generate"; accountId?: string } | { type: "pgp-import"; armored?: string; paste?: boolean };

export type Parsed =
  | { kind: "thread-action"; req: ThreadActionReq }
  | { kind: "prefs"; patch: { mailCanvas: "dark" | "original" } }
  | { kind: "compose"; req: ComposeReq }
  | { kind: "compose-new"; req: ComposeNewReq }
  | { kind: "import-key"; messageId: string; index: number }
  | { kind: "dialog"; req: DialogReq }
  | { kind: "calendar"; day: { y: number; m: number; d: number } | null }
  | { kind: "show-main" };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** The request, checked and cut to what is accepted; or why it is not (the reader is told with an error, nothing is done). */
export function parseRequest(kind: string, payload: unknown): Parsed | { error: string } {
  const p = isObj(payload) ? payload : {};
  switch (kind) {
    case "thread-action": {
      const threadId = str(p.threadId);
      const action = str(p.action);
      if (!threadId || !action || !READER_ACTIONS.has(action)) return { error: "thread-action: not an action of a reader" };
      const arg = str(p.arg);
      if (action === "snooze" && !(arg && /^\d{1,12}$/.test(arg))) return { error: "thread-action: snooze needs a time" };
      const labelKey = str(p.labelKey);
      if (labelKey !== undefined && !READER_LABELS.has(labelKey)) return { error: "thread-action: not a text a reader may ask for" };
      const labelParams = isObj(p.labelParams)
        ? Object.fromEntries(Object.entries(p.labelParams).filter((e): e is [string, string] => typeof e[1] === "string").slice(0, 4).map(([k, v]) => [k, v.slice(0, 200)]))
        : undefined;
      return { kind: "thread-action", req: { threadId, action, arg, labelKey, labelParams, view: str(p.view) } };
    }
    case "prefs": {
      // the main page is the only writer of the preferences (REQ-W11): a reader may change the mail background and nothing else
      const keys = Object.keys(p);
      if (keys.length !== 1 || keys[0] !== "mailCanvas" || (p.mailCanvas !== "dark" && p.mailCanvas !== "original")) return { error: "prefs: only mailCanvas" };
      return { kind: "prefs", patch: { mailCanvas: p.mailCanvas } };
    }
    case "compose": {
      const mode = p.mode;
      if (mode !== "reply" && mode !== "replyAll" && mode !== "forward") return { error: "compose: unknown mode" };
      if (!isObj(p.message) || typeof p.message.id !== "string") return { error: "compose: no message" };
      const ids = Array.isArray(p.threadMessageIds) ? p.threadMessageIds.filter((x): x is string | null => x === null || typeof x === "string") : [];
      return { kind: "compose", req: { mode, message: p.message, threadMessageIds: ids } };
    }
    case "import-key": {
      // a public key from a message goes into the key store: key management is the main window's (REQ-S2)
      const messageId = str(p.messageId);
      if (!messageId || typeof p.index !== "number" || !Number.isInteger(p.index) || p.index < 0) return { error: "import-key: no attachment" };
      return { kind: "import-key", messageId, index: p.index };
    }
    case "compose-new": {
      const i = isObj(p.init) ? p.init : null;
      const accountId = str(i?.accountId);
      if (!i || !accountId) return { error: "compose-new: no mailbox" };
      const to = Array.isArray(i.to) ? i.to.filter((x): x is string => typeof x === "string").slice(0, 20) : undefined;
      const attachments = Array.isArray(i.attachments)
        ? i.attachments.filter(isObj).map((a) => ({ filename: str(a.filename) ?? "", mime: str(a.mime) ?? "application/octet-stream", dataBase64: str(a.dataBase64) ?? "" })).filter((a) => a.filename && a.dataBase64)
        : undefined;
      return { kind: "compose-new", req: { accountId, to, subject: str(i.subject), attachments } };
    }
    case "dialog": {
      const d = isObj(p.dialog) ? p.dialog : null;
      switch (d?.type) {
        case "settings": return { kind: "dialog", req: { type: "settings", tab: str(d.tab), focus: str(d.focus) } };
        case "event": return { kind: "dialog", req: { type: "event", init: isObj(d.init) ? d.init : undefined } };
        case "pgp-key": return str(d.fingerprint) ? { kind: "dialog", req: { type: "pgp-key", fingerprint: str(d.fingerprint) as string } } : { error: "dialog: no key" };
        case "pgp-generate": return { kind: "dialog", req: { type: "pgp-generate", accountId: str(d.accountId) } };
        case "pgp-import": return { kind: "dialog", req: { type: "pgp-import", armored: str(d.armored), paste: d.paste === true } };
        default: return { error: "dialog: not a dialog a reader may open" };
      }
    }
    case "calendar":
    {
      const d = isObj(p.day) ? p.day : null;
      const ok = d && [d.y, d.m, d.d].every((n) => typeof n === "number" && Number.isInteger(n));
      return { kind: "calendar", day: ok ? { y: d.y as number, m: d.m as number, d: d.d as number } : null };
    }
    case "show-main":
      return { kind: "show-main" };
    default:
      return { error: `unknown request: ${kind.slice(0, 40)}` };
  }
}
