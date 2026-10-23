// "New since you last looked" (1.0.7 W13.2): which mailboxes and folders got new mail, for the dot in the side menu. Pure and session-only (nothing is stored; empty after a
// restart). The backend decides what is new mail (`newmail.rs`, REQ-13.2.1) and says it with `mail-arrived`; this module only keeps the map and clears it.
//   - an arrival for the folder that is on screen while the window is in front is ignored (REQ-13.2.3),
//   - the person opens the folder, or the window comes to the front with the folder on screen, or the folder has no unread mail left: its marker goes (REQ-13.2.4).
import type { FolderInfo } from "./api";

/** One folder's marker: when the arrival was noted (a folder list read before that cannot clear it) and the conversations that arrived. */
export interface NewEntry {
  at: number;
  threads: string[];
}
/** `<accountId>|<folder key>` -> marker */
export type NewMap = Record<string, NewEntry>;

export interface Arrivals {
  accountId: string;
  folders: { folder: string; threads: string[] }[];
}

/** What is on screen: the folder key and mailbox of the list (`accountId` null = all mailboxes), and whether the main window is in front (focused and visible). */
export interface Shown {
  folder: string;
  accountId: string | null;
  front: boolean;
}

export const newKey = (accountId: string, folder: string) => `${accountId}|${folder}`;
/** Enough threads to know what arrived; the marker is a flag, not a list. */
const KEEP = 50;

/** Is the folder (a mailbox's `key`) what the list shows? The "all mailboxes" Inbox shows every mailbox's Inbox; the Unread view shows no folder. */
export function isShown(accountId: string, folder: string, on: Pick<Shown, "folder" | "accountId">): boolean {
  if (on.folder !== folder) return false;
  return on.accountId === accountId || (on.accountId === null && folder === "inbox");
}

/** REQ-13.2.3: an arrival for the folder that is on screen while the window is in front is ignored; the others are marked. */
export function addArrivals(map: NewMap, a: Arrivals, on: Shown, now: number): NewMap {
  let out = map;
  for (const f of a.folders) {
    if (!f.folder || f.threads.length === 0) continue;
    if (on.front && isShown(a.accountId, f.folder, on)) continue;
    const k = newKey(a.accountId, f.folder);
    const before = out[k]?.threads ?? [];
    const threads = [...before, ...f.threads.filter((t) => !before.includes(t))].slice(-KEEP);
    if (out === map) out = { ...map };
    out[k] = { at: now, threads };
  }
  return out;
}

/** REQ-13.2.4 a / b: the folder is opened (or is on screen as the window comes to the front). The "all mailboxes" Inbox clears every Inbox; the Unread view and the other views clear nothing. */
export function clearOnOpen(map: NewMap, folder: string, accountId: string | null): NewMap {
  const gone = Object.keys(map).filter((k) => {
    const i = k.indexOf("|");
    const acct = k.slice(0, i);
    return isShown(acct, k.slice(i + 1), { folder, accountId });
  });
  return without(map, gone);
}

/** The window came to the front: the folder that is on screen is looked at. */
export const clearOnFocus = clearOnOpen;

/**
 * REQ-13.2.4 c: a folder whose unread count is 0 (read here, read in another program, moved away) has nothing new left. `startedAt` is when the read of `folders` began:
 * an arrival noted after that is newer than the counts and stays.
 */
export function clearByCounts(map: NewMap, folders: Pick<FolderInfo, "accountId" | "key" | "unread">[], startedAt: number): NewMap {
  const gone = Object.entries(map)
    .filter(([k, v]) => {
      if (v.at > startedAt) return false;
      const i = k.indexOf("|");
      const info = folders.find((f) => f.accountId === k.slice(0, i) && f.key === k.slice(i + 1));
      return !!info && info.unread <= 0;
    })
    .map(([k]) => k);
  return without(map, gone);
}

/** Does this folder of this mailbox carry the marker? (`accountId` null: any mailbox's.) */
export function hasNew(map: NewMap, accountId: string | null, folder: string): boolean {
  if (accountId !== null) return !!map[newKey(accountId, folder)];
  return Object.keys(map).some((k) => k.endsWith(`|${folder}`) && k.slice(0, k.length - folder.length - 1).length > 0);
}

/** A mailbox shows the marker when its Inbox has it (REQ-13.2.6: only the Inbox marks the mailbox). */
export const hasNewMailbox = (map: NewMap, accountId: string): boolean => hasNew(map, accountId, "inbox");

function without(map: NewMap, keys: string[]): NewMap {
  if (keys.length === 0) return map;
  const out = { ...map };
  for (const k of keys) delete out[k];
  return out;
}
