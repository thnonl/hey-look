/**
 * (BUG-1) Moves (archive, delete, junk, move) waiting out their Undo window, as the app sees them. While the window runs the backend
 * checks on the server that the folder the saved list names still exists; when it is gone and cannot be made it drops the move and says
 * so. This keeps what the app needs to answer that: the toast that shows the move (to take it away), whether the person pressed Undo
 * (Undo wins over a check that ends later), and news that came before the toast was shown (then no toast is shown at all).
 */
interface Entry {
  toast: number | null;
  undone: boolean;
}

const KEEP = 200;

export class QueuedMoves {
  private moves = new Map<string, Entry>();
  private early = new Set<string>();

  /** The backend queued the move. False when it had already been dropped (a fast server): show no "Archived" toast. */
  queued(token: string): boolean {
    if (this.early.delete(token)) return false;
    this.moves.set(token, { toast: null, undone: false });
    if (this.moves.size > KEEP) this.moves.delete(this.moves.keys().next().value as string);
    return true;
  }

  /** The toast that shows the move. */
  shown(token: string, toast: number) {
    const e = this.moves.get(token);
    if (e) e.toast = toast;
  }

  /** The person pressed Undo. */
  undo(token: string) {
    const e = this.moves.get(token);
    if (e) e.undone = true;
  }

  /** The backend dropped the move. null: the person took it back first, nothing to do. Otherwise the toast to take away (if one is shown). */
  dropped(token: string): { dismiss: number | null } | null {
    const e = this.moves.get(token);
    if (e?.undone) return null;
    this.moves.delete(token);
    if (!e) {
      this.early.add(token);
      if (this.early.size > KEEP) this.early.delete(this.early.values().next().value as string);
    }
    return { dismiss: e?.toast ?? null };
  }
}
