// What a compose window tells the main window (REQ-S4): the message is over and it was saved, a toast that has to be made where the person
// still looks (the window is about to close), a dialog that only the main window has (Settings, the PGP key dialogs), a refresh of the lists.
// They are fire-and-forget requests of the channel `popout_request` (the kinds start with `cw-`, so they never meet the reader's); the main
// page checks each one here before it does anything. Pure, so scripts/test-popout.mjs runs it.

export const CW_PREFIX = "cw-";

export type ComposeDialogReq =
  | { type: "settings"; tab?: string; focus?: string }
  | { type: "pgp-generate"; accountId?: string }
  | { type: "pgp-import"; armored?: string; paste?: boolean }
  | { type: "pgp-key"; fingerprint: string };

export type ComposeReq =
  /** a toast the window raised and closed on: shown here */
  | { kind: "toast"; text: string; level: "info" | "success" | "error" }
  /** "Draft saved" with the way back to the draft */
  | { kind: "draft-saved"; threadId: string; plain: boolean }
  /** the message was scheduled: "Scheduled for ..." with Undo and View, made where the outbox lives (the main window) */
  | { kind: "scheduled"; outboxId: string; sendAt: number }
  | { kind: "dialog"; dialog: ComposeDialogReq }
  | { kind: "sync" }
  | { kind: "refresh" };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** The request, checked and cut to what is accepted; null for a kind that is not a compose window's (another handler's), or an error. */
export function parseComposeRequest(kind: string, payload: unknown): ComposeReq | { error: string } | null {
  if (!kind.startsWith(CW_PREFIX)) return null;
  const p = isObj(payload) ? payload : {};
  switch (kind.slice(CW_PREFIX.length)) {
    case "toast": {
      const text = str(p.text)?.trim();
      if (!text) return { error: "toast: no text" };
      const level = p.level === "success" || p.level === "error" ? p.level : "info";
      return { kind: "toast", text: text.slice(0, 400), level };
    }
    case "draft-saved": {
      const threadId = str(p.threadId);
      if (!threadId) return { error: "draft-saved: no draft" };
      return { kind: "draft-saved", threadId, plain: p.plain === true };
    }
    case "scheduled": {
      const outboxId = str(p.outboxId);
      const sendAt = typeof p.sendAt === "number" && Number.isFinite(p.sendAt) ? p.sendAt : null;
      if (!outboxId || sendAt === null) return { error: "scheduled: no message or no time" };
      return { kind: "scheduled", outboxId, sendAt };
    }
    case "dialog": {
      const d = isObj(p.dialog) ? p.dialog : null;
      switch (d?.type) {
        case "settings": return { kind: "dialog", dialog: { type: "settings", tab: str(d.tab), focus: str(d.focus) } };
        case "pgp-generate": return { kind: "dialog", dialog: { type: "pgp-generate", accountId: str(d.accountId) } };
        case "pgp-import": return { kind: "dialog", dialog: { type: "pgp-import", armored: str(d.armored), paste: d.paste === true } };
        case "pgp-key": return str(d.fingerprint) ? { kind: "dialog", dialog: { type: "pgp-key", fingerprint: str(d.fingerprint) as string } } : { error: "dialog: no key" };
        default: return { error: "dialog: not a dialog a compose window may open" };
      }
    }
    case "sync":
      return { kind: "sync" };
    case "refresh":
      return { kind: "refresh" };
    default:
      return { error: `unknown compose request: ${kind.slice(0, 40)}` };
  }
}

/**
 * The toasts to carry over to the main window when a compose window ends: those raised at or after `since` (the moment the message was handed
 * over or ended; a little earlier for the "Draft saved" that comes just before the end). Text is made now, in the language in use.
 */
export function carryToasts<T extends { at: number; kind: "info" | "success" | "error" }>(raised: readonly T[], since: number): T[] {
  return raised.filter((x) => x.at >= since);
}
