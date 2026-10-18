// Crash recovery of the message being written (QA round 17 BUG-02): the writer that keeps the snapshot up to date, and what the next start does
// with what is left (1.0.6: it saves every snapshot as a real draft and only tells the person, no question). No UI and no Tauri here (the
// backend is passed in), so the sequence can be tested (scripts/test-recovery.mjs). The storage is src-tauri/src/recover.rs.

import type { AnswersRef, Att, Draft } from "./api";
import { swapPictures } from "./editor/messageBody.ts";
import { htmlToText } from "./htmlText.ts";
import { draftImportance, initialImportance } from "./importance.ts";
import { encodeMeeting, readMeetingWire, type MeetingWire } from "./meetingDraft.ts";
import type { ComposeInit } from "./store";

/** The form of a message as the snapshot keeps it. The body is the editor's HTML with the signature in it and the pictures as data: URIs. */
export interface RecoveryForm {
  v: 1;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  inReplyTo: string | null;
  references: string[];
  /** the draft this message takes the place of (a reference, see api.saveDraft) */
  replaces: string | null;
  isReply: boolean;
  encrypt: "on" | "off" | "auto";
  sign: boolean;
  attachKey: boolean;
  confidential: boolean;
  /** High / Low (F-24); left out for Normal and in snapshots of older versions */
  importance?: "high" | "low";
  /** the meeting strip, when "Meeting" was on (BUG-R3-4); left out otherwise and in snapshots of older versions */
  meeting?: MeetingWire;
  /** the message this one answers or forwards (W2.22 CF-18); left out for a new message and in snapshots of older versions */
  answers?: AnswersRef;
  /** the signature picker: "" Automatic, "none", or a signature id (W2.7); left out in snapshots of older versions */
  sigId?: string;
  /** written in a window of its own: it is restored in one */
  win?: true;
}

/** The `answers` of a snapshot, when it is one of ours. */
export function readAnswers(v: unknown): AnswersRef | undefined {
  const a = v as Partial<AnswersRef> | null;
  if (!a || typeof a !== "object" || (a.kind !== "answered" && a.kind !== "forwarded")) return undefined;
  return typeof a.accountId === "string" && a.accountId && typeof a.messageId === "string" && /^<[^\s"<>]+>$/.test(a.messageId) ? { kind: a.kind, accountId: a.accountId, messageId: a.messageId } : undefined;
}

/** What goes to the backend for one snapshot. `files` is null when the attachments are those of the previous snapshot. */
export interface SnapshotOut {
  id: string;
  accountId: string;
  subject: string;
  preview: string;
  payload: string;
  files: Att[] | null;
}

export interface RecoveryBackend {
  save(s: SnapshotOut): Promise<void>;
  /** `why` only goes to startup.log */
  clear(id: string, why?: string): Promise<void>;
}

/**
 * Writes the snapshots of ONE message. Writes are one at a time and the newest wins (a write that is waiting while another runs is replaced),
 * the attachments are only sent when they changed AND the last send of them worked, and once `clear` was called nothing is written for this
 * message any more (a late write must not bring a finished message back).
 */
export class RecoveryWriter {
  private pending: { out: Omit<SnapshotOut, "files">; filesKey: string; files: () => Att[] } | null = null;
  private running: Promise<void> | null = null;
  private closed = false;
  /** the attachments the backend has for this message (their key), or null when unknown */
  private stored: string | null = null;
  /** how many writes failed in a row */
  failures = 0;
  /** how many writes were made (for tests and the status line) */
  writes = 0;

  readonly id: string;
  private backend: RecoveryBackend;

  // (no parameter properties: the tests run this file with Node's type stripping)
  constructor(id: string, backend: RecoveryBackend) {
    this.id = id;
    this.backend = backend;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Keep this form. `filesKey` names the attachments (equal key = equal attachments); `files` makes them only when they have to be sent. */
  write(form: { accountId: string; subject: string; preview: string; payload: string }, filesKey: string, files: () => Att[]): void {
    if (this.closed) return;
    this.pending = { out: { id: this.id, ...form }, filesKey, files };
    this.running ??= this.pump();
  }

  private async pump(): Promise<void> {
    try {
      while (this.pending && !this.closed) {
        const p = this.pending;
        this.pending = null;
        const send = p.filesKey !== this.stored;
        try {
          await this.backend.save({ ...p.out, files: send ? p.files() : null });
          if (send) this.stored = p.filesKey;
          this.failures = 0;
          this.writes++;
        } catch {
          // the next snapshot tries again (with the attachments, as they were not stored)
          this.failures++;
          this.stored = null;
        }
      }
    } finally {
      this.running = null;
    }
  }

  /**
   * The pane is there (again): writes are taken. A pane that is mounted twice in a row (React's strict mode in the dev page) clears the writer in
   * between; the second mount opens it again. A message that is over is not opened again by this: it has no pane.
   */
  open(): void {
    this.closed = false;
  }

  /** The message is over (sent, discarded or saved): wait for the write that is running, then remove the snapshot. Never throws. */
  async clear(): Promise<void> {
    this.closed = true;
    this.pending = null;
    await this.running?.catch(() => undefined);
    try {
      await this.backend.clear(this.id, "message over");
    } catch {
      // a snapshot that stays is offered at the next start: nothing is lost by this
    }
  }

  /**
   * The message was saved (a draft on the server has everything written so far): the snapshot goes, but the message is still being written,
   * so a later change writes a new one (with its attachments again).
   */
  async release(): Promise<void> {
    if (this.closed) return;
    this.pending = null;
    await this.running?.catch(() => undefined);
    if (this.closed || this.pending) return; // (cleared meanwhile, or something newer is waiting: it is the one to keep)
    this.stored = null;
    try {
      await this.backend.clear(this.id, "draft saved");
    } catch {
      // the snapshot stays: it is offered at the next start (an old copy of a message that is saved)
    }
  }

  /** Wait for the write that is running (tests). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }
}

/** A snapshot as the start lists it. */
export interface RecoveryInfo {
  id: string;
  accountId: string;
  savedAt: number;
  subject: string;
  preview: string;
  files: number;
}

export interface RecoveryLoaded {
  id: string;
  accountId: string;
  savedAt: number;
  payload: string;
  files: Att[];
}

/** The message of a snapshot as Compose opens it, or null when the snapshot cannot be read. */
export function composeFromSnapshot(l: RecoveryLoaded): ComposeInit | null {
  let f: RecoveryForm;
  try {
    f = JSON.parse(l.payload) as RecoveryForm;
  } catch {
    return null;
  }
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  if (typeof f !== "object" || f === null || typeof f.html !== "string") return null;
  return {
    accountId: l.accountId,
    to: list(f.to),
    cc: list(f.cc),
    bcc: list(f.bcc),
    subject: typeof f.subject === "string" ? f.subject : "",
    bodyHtml: f.html,
    inReplyTo: f.inReplyTo ?? null,
    references: list(f.references),
    replaces: f.replaces ?? undefined,
    isReply: !!f.isReply,
    answers: readAnswers(f.answers),
    sigId: typeof f.sigId === "string" ? f.sigId : undefined,
    attachments: l.files,
    // the toggles as they were; the body holds its one signature region, as in a stored draft
    restore: { encrypt: f.encrypt === "on" || f.encrypt === "auto" ? f.encrypt : ("off" as const), sign: !!f.sign, attachKey: !!f.attachKey },
    confidential: !!f.confidential,
    importance: initialImportance(f),
    meetingForm: readMeetingWire(f.meeting) ?? undefined, // (anything that is not a meeting form of ours is ignored: the message opens without one)
    // the snapshot keeps its id: the next snapshot of this message replaces it, and it goes when the message is sent, discarded or saved
    recoveryId: l.id,
  };
}

/** Was the message of this snapshot written in a window of its own? Then it is restored in one. */
export function snapshotInWindow(l: RecoveryLoaded): boolean {
  try {
    return (JSON.parse(l.payload) as { win?: unknown }).win === true;
  } catch {
    return false;
  }
}

/**
 * The snapshot as a draft for the Drafts folder: the pictures of the body (data: URIs) become inline parts with a cid: reference (as a normal
 * Save draft makes them), Bcc stays, the text part is made from the HTML. Null = it must not go to the server (the message was meant to be
 * encrypted: a plain copy would defeat that) or the snapshot cannot be read. `recoveryId` is added by the backend.
 */
export function draftFromSnapshot(l: RecoveryLoaded): Draft | null {
  const init = composeFromSnapshot(l);
  if (!init) return null;
  if (init.restore?.encrypt === "on") return null;
  const swapped = swapPictures(init.bodyHtml ?? "", () => `${crypto.randomUUID()}@heylook`, (mime, n) => `picture-${n}.${mime.split("/")[1]?.replace("jpeg", "jpg") ?? "img"}`);
  return {
    accountId: l.accountId,
    to: init.to ?? [],
    cc: init.cc ?? [],
    bcc: init.bcc ?? [],
    subject: init.subject ?? "",
    html: swapped.html,
    text: htmlToText(swapped.html),
    inReplyTo: init.inReplyTo ?? null,
    references: init.references ?? [],
    answers: init.answers,
    attachments: l.files,
    inline: swapped.inline.map((i) => ({ cid: i.cid, filename: i.name, mime: i.mime, dataBase64: i.dataBase64 })),
    confidential: init.confidential || undefined,
    importance: draftImportance(init.importance ?? "normal"),
    meetingForm: init.meetingForm ? encodeMeeting(init.meetingForm, init.meetingForm.tz) : undefined,
  };
}

/** What the backend says about a snapshot it saved as a draft (src-tauri `recovery_save_draft`): `covered` = a draft saved at or after the snapshot was on the server already. */
export interface RecoveredDraft {
  status: "saved" | "covered";
  threadId: string | null;
  draftRef: string | null;
}

/** A message of the last session that the start kept: saved in Drafts, or still only on this computer. */
export interface Kept {
  id: string;
  accountId: string;
  subject: string;
  savedAt: number;
  where: "drafts" | "local";
  /** the conversation of the draft (where === "drafts"), to open it like a draft of the Drafts folder */
  threadId: string | null;
  /** it was written in a window of its own */
  inWindow: boolean;
}

/** A snapshot that could not be saved to the server is removed after this long (seconds); a start says so in the log and the person is not asked. */
export const LOCAL_KEEP_SECS = 30 * 24 * 3600;

export interface SettleDeps {
  list(): Promise<RecoveryInfo[]>;
  load(id: string): Promise<RecoveryLoaded | null>;
  /** save the snapshot as a draft and remove it once it is confirmed; throws when that cannot be done (the snapshot stays) */
  saveDraft(id: string, draft: Draft, replaces: string | null): Promise<RecoveredDraft>;
  /** remove the snapshot (`why` goes to the log) */
  clear(id: string, why: string): Promise<void>;
  /** seconds since 1970 */
  now(): number;
}

/**
 * The next start (1.0.6): every snapshot that is still there is saved as a real draft, one after the other, newest first, without a question and
 * without opening, sending or discarding anything. A snapshot that cannot be saved (no Drafts folder, no connection, the server refuses) stays
 * on this computer and is reported as such; one older than 30 days is removed. Returns what was kept, newest first.
 */
export async function settleRecovery(d: SettleDeps): Promise<Kept[]> {
  let items: RecoveryInfo[];
  try {
    items = await d.list();
  } catch {
    return [];
  }
  const kept: Kept[] = [];
  for (const info of [...items].sort((a, b) => b.savedAt - a.savedAt)) {
    let l: RecoveryLoaded | null = null;
    try {
      l = await d.load(info.id);
    } catch {
      l = null;
    }
    if (!l) continue; // (it may load at the next start)
    const init = composeFromSnapshot(l);
    if (!init) {
      // not a snapshot this version can read: it is of no use, and trying again at every start would not help
      await d.clear(info.id, "unreadable").catch(() => undefined);
      continue;
    }
    const base = { id: l.id, accountId: l.accountId, subject: (init.subject ?? "").trim(), savedAt: l.savedAt, inWindow: snapshotInWindow(l) };
    const draft = draftFromSnapshot(l);
    let saved: RecoveredDraft | null = null;
    if (draft) {
      try {
        saved = await d.saveDraft(l.id, draft, init.replaces ?? null);
      } catch {
        saved = null; // (the snapshot stays: the backend removes it only after the draft is confirmed)
      }
    }
    if (saved) {
      kept.push({ ...base, where: "drafts", threadId: saved.threadId });
    } else if (d.now() - l.savedAt > LOCAL_KEEP_SECS) {
      await d.clear(l.id, "kept on this computer for more than 30 days").catch(() => undefined);
    } else {
      kept.push({ ...base, where: "local", threadId: null });
    }
  }
  return kept;
}

export interface OpenKeptDeps {
  /** a draft of the Drafts folder (Compose.openDraftThread): pane or window by the setting, `window` forces one; false = not opened */
  openDraft(threadId: string, o: { window?: boolean; shift: boolean }): Promise<boolean>;
  loadSnapshot(id: string): Promise<RecoveryLoaded | null>;
  /** Compose with a message (popout/composeOpen.startCompose) */
  start(init: ComposeInit, o: { window?: boolean; shift: boolean; key?: string }): Promise<boolean>;
  /** the pop-out setting: every message opens in a window of its own */
  popoutSetting(): boolean;
  /** the message could not be found: tell the person */
  notFound(): void;
}

/**
 * Continue writing: the message opens the way a draft of the Drafts folder does, in the pane or in a window by the pop-out setting, and in a
 * window whatever the setting says when it was written in one. A message that is only on this computer opens from its snapshot (which stays
 * until the message is saved to the server or sent). Never sends or discards anything.
 */
export async function openKept(k: Kept, d: OpenKeptDeps): Promise<boolean> {
  const window = k.inWindow || undefined; // (undefined: the setting decides)
  if (k.where === "drafts" && k.threadId) return d.openDraft(k.threadId, { window, shift: false });
  const l = await d.loadSnapshot(k.id);
  const init = l && composeFromSnapshot(l);
  if (!l || !init) {
    d.notFound();
    return false;
  }
  // every snapshot has a window key of its own: two messages opened together are two windows, not one
  return d.start(init, { window, shift: false, key: k.inWindow || d.popoutSetting() ? `recovery:${l.id}` : undefined });
}
