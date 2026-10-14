// The "Downloading mails…" line of the list: what `backfill-progress` events do to the state and what the line shows.
// Imports only types, so a plain Node script can test it (scripts/test-backfill-line.mjs).
import type { BackfillProgress } from "./api";

/** The state after one event: `done` ends the account's line (the state is keyed by account, a mailbox downloads one folder at a time). */
export function applyBackfill(state: Record<string, BackfillProgress>, p: BackfillProgress): Record<string, BackfillProgress> {
  const next = { ...state };
  if (p.done) delete next[p.accountId];
  else next[p.accountId] = p;
  return next;
}

/**
 * The line for the open list: the running Inbox downloads of the mailbox(es) shown, or null when there is nothing to say.
 * Only mailboxes that still exist count (a removed mailbox never sends its closing event), only the Inbox (other folders download
 * quietly) and never while searching.
 */
export function downloadLine(
  state: Record<string, BackfillProgress>,
  opts: { inboxish: boolean; searching: boolean; accountId: string | null; accountIds: readonly string[] },
): { have: number; target: number } | null {
  if (!opts.inboxish || opts.searching) return null;
  const running = Object.values(state).filter(
    (p) => !p.done && p.role === "inbox" && opts.accountIds.includes(p.accountId) && (!opts.accountId || p.accountId === opts.accountId),
  );
  if (running.length === 0) return null;
  return { have: running.reduce((n, p) => n + Math.min(p.have, p.target), 0), target: running.reduce((n, p) => n + p.target, 0) };
}
