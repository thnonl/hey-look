// The browser side of dragging between windows (W4.7): sets the drag data (a token, see dragDrop.ts), tells the backend what the token stands for, and answers
// the targets. The decisions are in dragDrop.ts; the registry in src-tauri/src/drag.rs.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api";
import { FILE_DRAG, MAIL_DRAG, parsePayload, tokenType, type DragPayload, type MailItem } from "./dragDrop";

/** What the drags begun in this window stand for, and what a target already looked at: the pointer moves over many targets, each asks again and again. */
const known = new Map<string, DragPayload>();
const asked = new Set<string>();
let current: string | null = null;

/** The label of this window (`main`, `reader-2`, `compose-1`). */
export function windowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return "main";
  }
}

function begin(e: { dataTransfer: DataTransfer | null }, payload: DragPayload): string | null {
  const dt = e.dataTransfer;
  if (!dt) return null;
  const token = crypto.randomUUID();
  // the data are the token in custom types only: nothing for another program to read or paste (a mail moves, a chip is copied)
  dt.effectAllowed = payload.kind === "mail" ? "move" : "copy";
  dt.setData(payload.kind === "mail" ? MAIL_DRAG : FILE_DRAG, token);
  dt.setData(tokenType(token), "1");
  known.set(token, payload);
  current = token;
  // (not waited for: the registry has it long before the pointer reaches another window)
  void api.dragBegin(token, payload).catch(() => undefined);
  return token;
}

/** A drag of conversations begins (a row of the list, the subject of a reader window). */
export function startMailDrag(e: { dataTransfer: DataTransfer | null }, items: MailItem[], view?: string): void {
  begin(e, { kind: "mail", items, from: windowLabel(), view });
}

/** A drag of an attachment chip begins; `compose` identifies the message it belongs to. */
export function startFileDrag(e: { dataTransfer: DataTransfer | null }, file: { filename: string; mime: string; dataBase64: string }, compose: string): void {
  begin(e, { kind: "file", name: file.filename, mime: file.mime, dataBase64: file.dataBase64, from: windowLabel(), compose });
}

/** The drag ended in the window that began it (dropped, cancelled with Esc, released outside any target). */
export function endDrag(): void {
  const token = current;
  current = null;
  if (!token) return;
  known.delete(token);
  asked.delete(token);
  void api.dragEnd(token).catch(() => undefined);
}

/** What `token` stands for if it is known here already; otherwise it is asked of the backend once and `onKnown` runs when the answer is in. */
export function peekDrag(token: string, onKnown: () => void): DragPayload | undefined {
  const p = known.get(token);
  if (p) return p;
  if (!asked.has(token)) {
    asked.add(token);
    void api.dragPeek(token).then((raw) => {
      const q = parsePayload(raw);
      if (q) {
        known.set(token, q);
        onKnown();
      }
    }, () => undefined);
  }
  return undefined;
}

/** The drop: what `token` stands for, once. Null when it is gone (60 s, or the drag ended). */
export async function takeDrag(token: string): Promise<DragPayload | null> {
  const local = known.get(token) ?? null;
  known.delete(token);
  asked.delete(token);
  const remote = parsePayload(await api.dragTake(token).catch(() => null));
  return remote ?? local;
}
