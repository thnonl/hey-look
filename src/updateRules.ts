// The pure rules of the "new version" announcement: what a check's answer means for the UI, and why the toast does or does not appear.
// No imports of the app (only types), so scripts/test-update-announce.mjs runs them as they are. updates.ts re-exports the first four.
import type { UpdateKind, UpdateResult } from "./api";

/** A check that failed (offline / error) but carries the update the app already knew: the offer stays, with a quiet note. */
export const isStaleOffer = (r: UpdateResult | null): boolean =>
  !!r && (r.kind === "offline" || r.kind === "error") && !!r.info && r.cachedKind === "available";

/** The kind that counts for the UI: `throttled` / `disabled` stand for what their cached info says, a stale offer for `available`. */
export const updateKindOf = (r: UpdateResult | null): UpdateKind | null =>
  !r ? null : r.kind === "throttled" || r.kind === "disabled" ? (r.info ? r.cachedKind ?? null : null) : isStaleOffer(r) ? "available" : r.kind;

/** A download is running or a package waits: automatic checks stay quiet. */
export const flowActive = (f: { state: string }) => f.state !== "idle" && f.state !== "failed";

/** The newer version the user has not skipped (drives the gear dot, the toast and the chip), else null. */
export function pendingVersion(update: UpdateResult | null, skipped: string): string | null {
  const latest = updateKindOf(update) === "available" ? update?.info?.latest ?? null : null;
  return latest && latest !== skipped ? latest : null;
}

/**
 * Why the "new version available" toast does not appear for this state, in a few words for `startup.log` (F-20: on macOS nothing said
 * why it stayed away), or null when it should appear. The toast is for news: a stale offer (the last check failed) and an answer of
 * kind `disabled` (automatic checks are off, REQ-18 r3.4) are remembered offers, not news.
 */
export function announceBlocker(update: UpdateResult | null, toastFor: string | null, flowState: string, skipped: string, focused: boolean): string | null {
  if (!update) return "no answer from a check yet";
  const v = pendingVersion(update, skipped);
  const info = update.info;
  if (!v || !info) {
    const kind = updateKindOf(update);
    if (kind === "available" && info) return `version ${info.latest} was skipped by the user`;
    const stored = update.cachedKind ? `, stored answer ${update.cachedKind}` : "";
    return `the answer is ${update.kind}${stored}: no newer version known${update.kind === "throttled" || update.kind === "disabled" ? " (no request was made)" : ""}`; // i18n-ok: a line for the log file, not UI text
  }
  if (toastFor === v) return `already shown for ${v} in this run`;
  if (flowActive({ state: flowState })) return `an update is already on its way (${flowState})`;
  if (!focused) return "the window is not focused";
  if (isStaleOffer(update)) return `the last check failed (${update.kind}); ${v} is only remembered`;
  if (update.kind === "disabled") return `automatic checks are off; ${v} is only remembered`;
  return null;
}
