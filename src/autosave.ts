// When the message being written is saved to Drafts by itself, and when its crash-recovery snapshot is written (QA round 17 BUG-02).
// No UI and no Tauri here, so the decisions can be tested (scripts/test-autosave.mjs). The Compose pane supplies the facts and acts on the answer.

/** A changed message is saved to Drafts about this often. */
export const AUTOSAVE_MS = 30_000;
/** The snapshot for crash recovery is written this often while the message changes. */
export const SNAPSHOT_MS = 3_000;
/** The longest wait between two failed tries. */
const MAX_BACKOFF = 6;

export type AutosaveWhy = "tick" | "blur" | "hidden";

export interface AutosaveFacts {
  now: number;
  why: AutosaveWhy;
  /** goes up with every edit (Compose `revRef`) */
  rev: number;
  /** the `rev` the last successful save covered */
  savedRev: number;
  /** when the first edit after that save happened (0: none) */
  changedAt: number;
  /** when the last try started (0: never) */
  lastTryAt: number;
  /** failed tries in a row */
  failures: number;
  /** the message holds something worth a draft (composeContent.ts `draftContent`: text, a subject, a picture or a file of the person's, a meeting place; recipients alone are not) */
  draftContent: boolean;
  /** files are still being read into the message */
  attaching: boolean;
  /** a save (autosave, Save draft, leaving) is running */
  saving: boolean;
  /** the message is being sent or scheduled */
  sending: boolean;
  /** a scheduled message being edited: it is not a draft */
  scheduled: boolean;
  /** Encrypt is on but drafts are not encrypted: a draft would put the text on the server in the clear, so nothing is saved by itself */
  plainWouldLeak: boolean;
}

/**
 * Save now? Only a changed message that holds draft content (a message with nothing but recipients is never saved, W13.5), never while another save is running or the message is on its
 * way out, and never a message that Encrypt is meant to protect when the draft would not be encrypted. The timer waits `interval` after the
 * first change (or the last try) and backs off after failures; leaving the window (blur / hidden) does not wait for the timer, but a try
 * that has just been made is not repeated at once.
 */
export function autosaveDue(f: AutosaveFacts, interval = AUTOSAVE_MS): boolean {
  if (f.scheduled || f.sending || f.saving || f.attaching || f.plainWouldLeak) return false;
  if (!f.draftContent || f.rev === f.savedRev) return false;
  const since = f.now - f.lastTryAt;
  if (f.why !== "tick") return f.lastTryAt === 0 || since >= Math.min(interval, 2_000) * (1 + Math.min(f.failures, MAX_BACKOFF));
  const wait = interval * (1 + Math.min(f.failures, MAX_BACKOFF));
  return f.now - Math.max(f.changedAt, f.lastTryAt) >= wait;
}

export interface SnapshotFacts {
  now: number;
  rev: number;
  /** the `rev` the last snapshot covered (-1: none yet) */
  snapRev: number;
  lastWriteAt: number;
  /** size of the text of the message in characters, to write big messages less often */
  size: number;
  hasContent: boolean;
  scheduled: boolean;
  /** the message is encrypted on purpose: its text is not written to the disk in the clear */
  encrypted: boolean;
}

/** Write the snapshot now? When something changed since the last one, at most every few seconds (a message with big pictures less often). */
export function snapshotDue(f: SnapshotFacts, gap = SNAPSHOT_MS): boolean {
  if (f.scheduled || f.encrypted || !f.hasContent || f.rev === f.snapRev) return false;
  const slower = Math.min(10, Math.floor(f.size / 1_000_000)); // one more second per MB of text and pictures, at most ten
  return f.now - f.lastWriteAt >= gap + slower * 1_000;
}

/** The facts the dev mock may override to make the timers short (`#autosave=3000` in the address of the dev page). */
export function timing(): { autosaveMs: number; snapshotMs: number } {
  const w = (typeof window === "undefined" ? {} : window) as { __hlTiming?: { autosaveMs?: number; snapshotMs?: number } };
  const o = w.__hlTiming;
  return { autosaveMs: o?.autosaveMs && o.autosaveMs > 0 ? o.autosaveMs : AUTOSAVE_MS, snapshotMs: o?.snapshotMs && o.snapshotMs > 0 ? o.snapshotMs : SNAPSHOT_MS };
}
