/**
 * F-16 / F-17: the read / unread state the person asked for, kept per conversation until the server has it.
 *
 * Before, every click (and every auto mark-as-read) was its own backend call that opened its own IMAP connection. Several of them
 * ran at once and finished in any order, each one ended with a re-read of the list, and the backend changes its local row only after
 * the server did. So the list that came back while a call was still under way showed the OLD state over the new one (a mail that was
 * just opened flipped back to unread), and rapid clicks left the server - and then the list - in whatever state finished last.
 *
 * Here: `set` records the last intent of a conversation (last write wins), at most ONE call per conversation is under way, and what
 * arrives while it runs is coalesced into a single follow-up call to the FINAL state (an idempotent set, never a toggle). A list or a
 * conversation read from the backend is shown through `threads` / `messages`: an intent still pending wins over the answer, and so
 * does one that was acknowledged after that read began (the answer may predate it). A failed final call drops the intent, so the
 * server's state is what the next read shows (rollback).
 */

type Failure = { failed: boolean; error?: unknown };
interface Waiter {
  intent: number;
  done: (f: Failure) => void;
}
interface Entry {
  /** the state asked for last: true = read */
  want: boolean;
  /** sequence number of that ask (monotonic: later asks have bigger numbers) */
  intent: number;
  /** the call under way: the ask it carries */
  sending: { intent: number; want: boolean } | null;
  /** the server has the final intent; the entry is only remembered for reads that began before that */
  settled: boolean;
  /** sequence number of the last ask / acknowledgement */
  touched: number;
  waiters: Waiter[];
}

export interface SettleResult {
  /** conversations whose final call failed (their intent was dropped) */
  failed: string[];
  error?: unknown;
  /** every conversation of this call was asked again later: that later call reports the outcome */
  superseded: boolean;
}

export class ReadIntents {
  private seq = 0;
  private entries = new Map<string, Entry>();
  /** reads of a list / conversation under way: the sequence number each began at (counted: two may begin at the same one) */
  private readers = new Map<number, number>();

  /** `send` makes the backend set the state of these conversations (one call; it resolves when the server has it). */
  private send: (ids: string[], read: boolean) => Promise<void>;
  constructor(send: (ids: string[], read: boolean) => Promise<void>) {
    this.send = send;
  }

  /** Ask for the state of these conversations. Resolves when the server has the final state asked for them (or the call failed). */
  set(ids: string[], read: boolean): Promise<SettleResult> {
    const seq = ++this.seq;
    const waits = ids.map(
      (id) =>
        new Promise<Failure & { id: string; last: boolean }>((resolve) => {
          let e = this.entries.get(id);
          if (!e || e.settled) {
            e = { want: read, intent: seq, sending: null, settled: false, touched: seq, waiters: [] };
            this.entries.set(id, e);
          } else {
            e.want = read;
            e.intent = seq;
            e.touched = seq;
          }
          const entry = e;
          e.waiters.push({ intent: seq, done: (f) => resolve({ ...f, id, last: entry.intent === seq }) });
        }),
    );
    queueMicrotask(() => this.flush());
    return Promise.all(waits).then((rs) => {
      const bad = rs.filter((r) => r.failed);
      return { failed: bad.map((r) => r.id), error: bad[0]?.error, superseded: rs.length > 0 && rs.every((r) => !r.last) };
    });
  }

  /** Call before asking the backend for a list / conversation; pass the token to `threads` / `messages` and `end`. */
  begin(): number {
    this.readers.set(this.seq, (this.readers.get(this.seq) ?? 0) + 1);
    return this.seq;
  }

  end(token: number) {
    const n = (this.readers.get(token) ?? 1) - 1;
    if (n > 0) this.readers.set(token, n);
    else this.readers.delete(token);
    this.prune();
  }

  /** Something was asked or acknowledged since `token` (counts of the folders read at that time may be older). */
  changedSince(token: number): boolean {
    return this.seq !== token;
  }

  /** The rows of a list read after `token`, with the intents that are newer than that read laid over them. */
  threads<T extends { threadId: string; unread: number }>(list: T[], token: number): T[] {
    if (this.entries.size === 0) return list;
    let changed = false;
    const out = list.map((t) => {
      const e = this.entries.get(t.threadId);
      if (!e || !this.newer(e, token)) return t;
      const unread = e.want ? 0 : Math.max(1, t.unread);
      if (unread === t.unread) return t;
      changed = true;
      return { ...t, unread };
    });
    return changed ? out : list;
  }

  /** The messages of conversation `id` read after `token`, with the intent laid over them (unread: the newest one, as the list does). */
  messages<T extends { seen: boolean }>(id: string, list: T[], token: number): T[] {
    const e = this.entries.get(id);
    if (!e || !this.newer(e, token)) return list;
    const out = list.map((m, i) => {
      const seen = e.want ? true : i < list.length - 1 ? m.seen : false;
      return seen === m.seen ? m : { ...m, seen };
    });
    return out.some((m, i) => m !== list[i]) ? out : list;
  }

  private newer(e: Entry, token: number) {
    return !e.settled || e.touched > token;
  }

  private prune() {
    const oldest = this.readers.size ? Math.min(...this.readers.keys()) : Infinity;
    for (const [id, e] of this.entries) if (e.settled && e.touched <= oldest) this.entries.delete(id);
  }

  /** Start a call for every conversation that has an intent and none under way (one call per state, so a batch stays one connection). */
  private flush() {
    const groups: [string[], boolean][] = [[[], true], [[], false]];
    for (const [id, e] of this.entries) {
      if (e.settled || e.sending) continue;
      e.sending = { intent: e.intent, want: e.want };
      groups[e.want ? 0 : 1][0].push(id);
    }
    for (const [ids, read] of groups) if (ids.length) void this.run(ids, read);
  }

  private async run(ids: string[], read: boolean) {
    let error: unknown;
    let failed = false;
    try {
      await this.send(ids, read);
    } catch (e) {
      failed = true;
      error = e;
    }
    this.seq++;
    for (const id of ids) {
      const e = this.entries.get(id);
      const sent = e?.sending;
      if (!e || !sent) continue;
      e.sending = null;
      const again = e.intent !== sent.intent && (failed || e.want !== sent.want);
      if (again) continue; // asked again meanwhile: the final state is sent next
      const waiters = e.waiters;
      e.waiters = [];
      if (failed) this.entries.delete(id); // rollback: the next read shows the server's state
      else {
        e.settled = true;
        e.touched = this.seq;
      }
      for (const w of waiters) w.done({ failed, error });
    }
    this.prune();
    this.flush();
  }
}
