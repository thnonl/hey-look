import { fmtNumber } from "../i18n/format";
import { useT } from "../i18n/react";
import { friendlyError, useStore } from "../store";
import { rowKey, SERVER_MAX_ROWS, summaryOf, useServerSearch } from "../serverSearch";
import { ThreadRow } from "./MessageList";

// The end of a search: "Search on the server" (1.0.7 W6.7). Part of the list (it is not the search panel's): the button, the running state with Cancel, then the heading "On the server"
// and the messages the server has that this computer does not, drawn as ordinary rows. Opening one downloads it and stores it (serverSearch.ts); a different search drops the results.

/** Arrow keys, Home and End move the focus between the server rows (the rows are in the tab order, Enter opens one). */
function moveBetweenRows(e: React.KeyboardEvent<HTMLDivElement>) {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(".ml-row"));
  const at = rows.indexOf((e.target as HTMLElement).closest<HTMLElement>(".ml-row") as HTMLElement);
  if (at < 0) return;
  const to = e.key === "ArrowDown" ? Math.min(rows.length - 1, at + 1) : e.key === "ArrowUp" ? Math.max(0, at - 1) : e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : -1;
  if (to < 0) return;
  e.preventDefault();
  e.stopPropagation();
  rows[to].focus();
}

export function ServerSearchSection() {
  const tr = useT();
  const { phase, rows, capped, errors, localOnly, opening, run, cancel, open } = useServerSearch();
  const prefs = useStore((s) => s.prefs);
  const accounts = useStore((s) => s.accounts);
  const emailOf = (id: string) => accounts.find((a) => a.id === id)?.email ?? "";
  const hint = tr("mail.server.searchHint");

  if (phase === "idle") {
    return (
      <div className="ml-srv" data-server-search="idle">
        <button className="btn small" title={hint} aria-description={hint} onClick={() => void run()}>
          {tr("mail.server.search")}
        </button>
      </div>
    );
  }
  if (phase === "running") {
    return (
      <div className="ml-srv" data-server-search="running" role="status">
        {/* one line (the text and the button side by side), so starting the search does not make the footer taller than the button alone */}
        <div className="ml-srv-line">
          <span className="muted">
            <span className="spin" aria-hidden /> {tr("mail.server.searching")}
          </span>
          <button className="btn small" onClick={cancel}>
            {tr("common.cancel")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="ml-srv" data-server-search="done">
      {localOnly && <div className="muted small" role="note">{tr("mail.server.localOnly")}</div>}
      {errors.map((e, i) => (
        <div key={`${e.accountId}-${i}`} className="muted small ml-srv-err" role="status">
          {tr("mail.server.failed", { email: emailOf(e.accountId) || e.accountId, error: friendlyError(e.error) })}
        </div>
      ))}
      {rows.length > 0 ? (
        <section aria-labelledby="ml-srv-head">
          <h3 id="ml-srv-head" className="ml-srv-head">{tr("mail.server.heading")}</h3>
          <div role="listbox" aria-labelledby="ml-srv-head" className="ml-srv-rows" onKeyDown={moveBetweenRows}>
            {rows.map((r, i) => {
              const k = rowKey(r);
              const acct = accounts.length > 1 ? accounts.find((a) => a.id === r.accountId) : undefined;
              return (
                <ThreadRow
                  key={k}
                  t={summaryOf(r)}
                  prefs={prefs}
                  reservePreview
                  showFolder
                  accountColor={acct?.color ?? null}
                  accountLabel={acct?.email}
                  opening={opening === k}
                  posInSet={i + 1}
                  setSize={rows.length}
                  onOpen={() => void open(r)}
                  onOpenWindow={() => void open(r, true)}
                />
              );
            })}
          </div>
          {capped && <div className="muted small" role="status">{tr("mail.server.capped", { n: fmtNumber(SERVER_MAX_ROWS) })}</div>}
        </section>
      ) : (
        errors.length === 0 && <div className="muted small" role="status">{tr("mail.server.none")}</div>
      )}
    </div>
  );
}
