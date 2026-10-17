// Crash recovery of the message being written (QA round 17 BUG-02): the writer that keeps the snapshot up to date, and the question asked
// at the next start. No UI and no Tauri here (the backend is passed in), so the sequence can be tested (scripts/test-recovery.mjs).
// The storage is src-tauri/src/recover.rs.

import type { Att } from "./api";
import { initialImportance } from "./importance.ts";
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
  /** written in a window of its own: it is restored in one */
  win?: true;
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

/** A snapshot as the question shows it. */
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
    attachments: l.files,
    // the toggles as they were; the body holds its one signature region, as in a stored draft
    restore: { encrypt: f.encrypt === "on" || f.encrypt === "auto" ? f.encrypt : ("off" as const), sign: !!f.sign, attachKey: !!f.attachKey },
    confidential: !!f.confidential,
    importance: initialImportance(f),
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

export interface RestoreDeps {
  list(): Promise<RecoveryInfo[]>;
  load(id: string): Promise<RecoveryLoaded | null>;
  /** "later" is also the answer of Esc and of a click outside */
  ask(info: RecoveryInfo): Promise<"restore" | "discard" | "later">;
  /**
   * open Compose with the snapshot (it keeps the snapshot's id, so the next snapshot replaces it). false = it could not be opened (too many
   * windows, no mailbox): the snapshot stays for the next start
   */
  open(l: RecoveryLoaded): Promise<boolean | void>;
  /**
   * This snapshot opens in a window of its own (the setting, or it was written in one): such a window does not take the pane, so the questions
   * go on at once and every restored message is opened together after the last question. A question asked while a window has just come up
   * can sit unseen behind it (Linux): all questions first, then the windows.
   */
  inWindow?(l: RecoveryLoaded): boolean;
  clear(id: string): Promise<void>;
  /** a message is being written */
  composing(): boolean;
  /** resolves when no message is being written */
  whenIdle(): Promise<void>;
  /** the snapshot could not be loaded */
  failed(info: RecoveryInfo): void;
}

export interface RestoreResult {
  restored: string[];
  discarded: string[];
  later: string[];
  gone: string[];
}

/**
 * The next start: every snapshot that is still there is offered, newest first, one at a time, and a message is only opened when no other one is
 * being written. Restore opens it (never sends it), Discard removes it, anything else keeps it (and the ones after it) for the next start: nothing is dropped or sent
 * without the person saying so.
 */
export async function offerRecovery(d: RestoreDeps): Promise<RestoreResult> {
  const res: RestoreResult = { restored: [], discarded: [], later: [], gone: [] };
  let items: RecoveryInfo[];
  try {
    items = await d.list();
  } catch {
    return res;
  }
  const windows: RecoveryLoaded[] = [];
  // the messages that wait for a window: opened in the order of the questions, as many as the app allows (the rest stays for the next start)
  const flush = async () => {
    for (let k = 0; k < windows.length; k++) {
      const ok = await d.open(windows[k]);
      if (ok === false) {
        res.later.push(...windows.slice(k).map((x) => x.id));
        break;
      }
      res.restored.push(windows[k].id);
    }
    windows.length = 0;
  };
  for (let i = 0; i < items.length; i++) {
    const info = items[i];
    if (d.composing()) {
      await flush();
      await d.whenIdle();
    }
    const answer = await d.ask(info);
    if (answer === "discard") {
      await d.clear(info.id);
      res.discarded.push(info.id);
    } else if (answer === "restore") {
      let l: RecoveryLoaded | null = null;
      try {
        l = await d.load(info.id);
      } catch {
        l = null;
      }
      if (!l) {
        d.failed(info);
        res.gone.push(info.id);
        continue; // (kept: it may load at the next start)
      }
      if (d.inWindow?.(l)) {
        windows.push(l);
        continue;
      }
      if (d.composing()) await d.whenIdle();
      if ((await d.open(l)) === false) res.later.push(info.id);
      else res.restored.push(info.id);
    } else {
      // "not now" is for the rest as well: they are asked again at the next start
      res.later.push(...items.slice(i).map((x) => x.id));
      break;
    }
  }
  await flush();
  return res;
}
