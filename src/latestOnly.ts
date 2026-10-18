/**
 * Numbers the runs of an asynchronous read so that only the last one STARTED may apply its answer. Two re-reads of the list that overlap (the 30 s
 * refresh, a sync, the end of an Undo time) can be answered in either order; the older answer was read before the newer change and must not be laid
 * over the newer one (a deleted message came back into the list until the next refresh).
 */
export class Latest {
  private n = 0;

  /** A run starts: its number. */
  start(): number {
    return ++this.n;
  }

  /** Is this still the last run that started? */
  current(run: number): boolean {
    return run === this.n;
  }
}
