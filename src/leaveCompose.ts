// Leaving a message being written to read another mail (F-21): what happens to the compose pane. No UI here, so the decision can be tested
// (scripts/test-leave-compose.mjs). The store wires the real pieces in (`leaveCompose` action), the Compose pane answers `probe` / `save`.

/** What the Compose pane says about itself. */
export interface ComposeProbe {
  /** to / subject / body (typed, not the signature or an untouched quote) / pictures / attachments: something the person made */
  hasContent: boolean;
  /** a file or picture is still being read into the message */
  attaching: boolean;
  /** goes up with every edit, so a save can tell whether the person kept typing while it ran */
  rev: number;
}

/** A draft that was just saved: what the toast needs. */
export interface SavedDraft {
  /** saved without encryption although encryption was on (another sentence in the toast) */
  plain: boolean;
  /** open the saved draft in Compose again */
  edit: () => void;
}

export interface LeaveEnv {
  /** a compose pane is open */
  open: () => boolean;
  /** editing a scheduled message (it is not a draft: "Save draft" does not apply) */
  scheduled: () => boolean;
  /** the person changed something since it was opened or last saved */
  dirty: () => boolean;
  probe: () => ComposeProbe | null;
  /** wait until the files being added are in (false: they are not, after a while) */
  attached: () => Promise<boolean>;
  /** save as a draft; `onSaved` gets what the toast needs. Anything but `true` is a failure (the pane has already said why). */
  save: (onSaved: (d: SavedDraft) => void) => Promise<boolean | void>;
  /** the person's answer for a scheduled message with unsaved changes */
  askScheduled: () => Promise<"keep" | "discard">;
  /** everything typed was deleted again: the copy an autosave made of a NEW message goes, and the snapshot (an opened draft keeps its last saved version) */
  dropEmptied?: () => Promise<void>;
  /** close the pane (nothing is saved by this) */
  close: () => Promise<void>;
}

export type LeaveOutcome =
  | { kind: "none" } // nothing was open
  | { kind: "closed"; why: "empty" | "scheduled" | "discarded" } // closed, no draft made
  | { kind: "saved"; saved: SavedDraft | null } // saved as a draft, then closed
  | { kind: "stay"; why: "save-failed" | "attaching" | "typing" | "kept" }; // the pane stays: nothing is lost

/** Saves tried while the person keeps typing, before the pane is left open. */
export const MAX_SAVES = 3;

/**
 * Decide and do. Empty (or never touched) closes without a draft. With content the draft is saved FIRST, and the pane closes only when
 * the save worked and nothing was typed meanwhile; a failed save never closes it. A scheduled message is not a draft: untouched it closes,
 * with unsaved changes the person is asked. Files still being added are waited for.
 */
export async function leaveCompose(env: LeaveEnv): Promise<LeaveOutcome> {
  if (!env.open()) return { kind: "none" };
  if (env.scheduled()) {
    if (!env.dirty()) {
      await env.close();
      return { kind: "closed", why: "scheduled" };
    }
    if ((await env.askScheduled()) !== "discard") return { kind: "stay", why: "kept" };
    await env.close();
    return { kind: "closed", why: "discarded" };
  }
  const got: { d: SavedDraft | null } = { d: null }; // (set by the save; an object, so the type does not narrow to null)
  for (let round = 0; round < MAX_SAVES; round++) {
    let p = env.probe();
    if (!env.dirty() && !p?.attaching) {
      // nothing the person changed: an opened draft, an untouched reply (a draft of it, if any, is already in Drafts)
      await env.close();
      return got.d ? { kind: "saved", saved: got.d } : { kind: "closed", why: "empty" };
    }
    if (p?.attaching) {
      if (!(await env.attached())) return { kind: "stay", why: "attaching" };
      p = env.probe();
    }
    if (!got.d && p && !p.hasContent) {
      await env.dropEmptied?.();
      await env.close();
      return { kind: "closed", why: "empty" }; // typed, then deleted again
    }
    const rev = p?.rev;
    const ok = await env.save((d) => (got.d = d));
    if (ok !== true) return { kind: "stay", why: "save-failed" };
    if (rev !== undefined && env.probe()?.rev !== rev) continue; // typed during the save: save again
    await env.close();
    return { kind: "saved", saved: got.d };
  }
  return { kind: "stay", why: "typing" };
}
