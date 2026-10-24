// Drag and drop between the windows of the app (W4.7): the decisions, pure (no DOM, no Tauri), so scripts/test-drag-drop.mjs runs them as they are.
//
// What is dragged: a conversation (a row of the main list, the subject of a reader window) or an attachment chip of a message being written. The drag data
// carries a TOKEN only, in custom types (never text, never the mail itself): `application/x-heylook-mail` / `application/x-heylook-file` say what kind it is and
// `application/x-heylook-tok-<token>` carries the token (the NAME of a type is readable while the pointer moves over a target, its data only on the drop). The
// page that starts the drag tells the backend what the token stands for (src-tauri/src/drag.rs); a target asks for it. Where it goes: the real folders of the
// folder pane accept conversations (the same choices as the "Move to" menu), the editor of ANOTHER message accepts a file chip.
import { readerAllowed } from "./popout/readerLogic.ts";

export const MAIL_DRAG = "application/x-heylook-mail";
export const FILE_DRAG = "application/x-heylook-file";
const TOKEN_TYPE = "application/x-heylook-tok-";

/** The drag type that carries `token` (a UUID: lower case, so the browser's lower-casing of type names changes nothing). */
export const tokenType = (token: string) => `${TOKEN_TYPE}${token}`;

/** The token of a drag of `kind` in the type list of a `DataTransfer` (readable at any time), or null when it is not one of ours. */
export function tokenIn(types: readonly string[] | ReadonlyArray<string>, kind: "mail" | "file"): string | null {
  const list = Array.from(types);
  if (!list.includes(kind === "mail" ? MAIL_DRAG : FILE_DRAG)) return null;
  const t = list.find((x) => x.startsWith(TOKEN_TYPE));
  const token = t ? t.slice(TOKEN_TYPE.length) : "";
  return /^[0-9a-z-]{1,64}$/.test(token) ? token : null;
}

/** One conversation of a drag. */
export interface MailItem {
  threadId: string;
  accountId: string;
  /** the folder the row is in */
  folder: string;
}

export interface MailDrag {
  kind: "mail";
  items: MailItem[];
  /** the window that began it (`main`, `reader-3`): a reader window is closed once its conversation has moved */
  from: string;
  /** the view the conversations were in (the scope of the move, as for the buttons of a reader) */
  view?: string;
}

export interface FileDrag {
  kind: "file";
  name: string;
  mime: string;
  dataBase64: string;
  /** the window that began it */
  from: string;
  /** the message the chip belongs to: dropping a chip on its own message does nothing */
  compose: string;
}

export type DragPayload = MailDrag | FileDrag;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** What the backend returns for a token, read defensively; null for anything that is not a drag of ours. */
export function parsePayload(raw: unknown): DragPayload | null {
  if (!isObj(raw)) return null;
  if (raw.kind === "mail") {
    const items = (Array.isArray(raw.items) ? raw.items : [])
      .filter(isObj)
      .map((i) => ({ threadId: str(i.threadId), accountId: str(i.accountId), folder: str(i.folder) }))
      .filter((i) => i.threadId && i.accountId);
    return items.length ? { kind: "mail", items, from: str(raw.from), view: str(raw.view) || undefined } : null;
  }
  if (raw.kind === "file") {
    const name = str(raw.name);
    const dataBase64 = str(raw.dataBase64);
    return name && dataBase64 ? { kind: "file", name, mime: str(raw.mime) || "application/octet-stream", dataBase64, from: str(raw.from), compose: str(raw.compose) } : null;
  }
  return null;
}

/** Can a row be dragged? Not in Drafts (it is edited, not moved) and not in the Scheduled list: the rule of the reader window (`readerAllowed`). */
export const mayDragRow = (view: string, folder: string): boolean => readerAllowed(view, folder);

/** The conversations a drag from `rowId` takes: all the checked ones when that row is one of them, else the row alone. */
export function dragIds(rowId: string, checked: ReadonlySet<string>): string[] {
  return checked.has(rowId) ? [...checked] : [rowId];
}

/**
 * Does a folder of the folder pane take this drag? A real folder of the same mailbox as every dragged conversation, one that the "Move to" menu offers
 * (`moveKeys(accountId)`: not Drafts / Sent, no Junk where the mailbox has none), and not the folder they are all in. A virtual view, a folder of another
 * mailbox and a heading have no `accountId` or no such key: no.
 */
export function dropAllowed(items: readonly MailItem[], target: { accountId: string | null; key: string }, moveKeys: (accountId: string) => readonly string[]): boolean {
  if (!target.accountId || items.length === 0) return false;
  if (!items.every((i) => i.accountId === target.accountId)) return false;
  if (items.every((i) => i.folder === target.key)) return false;
  return moveKeys(target.accountId).includes(target.key);
}

/** What a drop on the folder `key` does: exactly what the buttons do for those folders (Junk, Delete, Archive), else "Move to" (`act` of store.ts). */
export function dropAction(key: string): { action: "move" | "junk" | "trash" | "archive"; arg?: string } {
  if (key === "junk") return { action: "junk" };
  if (key === "trash") return { action: "trash" };
  if (key === "archive") return { action: "archive" };
  return { action: "move", arg: key };
}

/** May this chip be dropped in the message `mine`? Not in the one it came from. */
export const fileDropOk = (p: FileDrag, mine: string): boolean => !!mine && p.compose !== mine;
