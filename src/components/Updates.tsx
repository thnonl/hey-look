import { RefreshCw } from "lucide-react";
import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { UpdateInfo, UpdateResult } from "../api";
import { downloadUpdate, openUpdateLink, updateKindOf, useStore } from "../store";
import { fmtClock, fmtDay, fmtSize, fmtWhen } from "../util";

/** One line of release notes as plain text: markdown markers removed, links kept as their text, nothing is HTML. */
const plainLine = (s: string) =>
  s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]*)`/g, "$1");

/** Release notes as React text (never HTML): headings bold, bullets as "• ", other lines as they are. */
function UpdateNotes({ notes, truncated, releaseUrl }: { notes: string; truncated: boolean; releaseUrl: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (el) setScrolls(el.scrollHeight > el.clientHeight);
  }, [notes]);
  const lines: { h: boolean; text: string }[] = [];
  let blanks = 0;
  for (const raw of notes.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      if (++blanks <= 2) lines.push({ h: false, text: "" });
      continue;
    }
    blanks = 0;
    const head = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (head) lines.push({ h: true, text: plainLine(head[1]) });
    else if (bullet) lines.push({ h: false, text: `• ${plainLine(bullet[1])}` });
    else lines.push({ h: false, text: plainLine(line) });
  }
  return (
    <div className="update-notes" ref={box} tabIndex={scrolls ? 0 : undefined} aria-label={scrolls ? "Release notes" : undefined} role={scrolls ? "region" : undefined}>
      <div className="small h">What’s new</div>
      {lines.map((l, i) => (
        <div key={i} className={l.h ? "h" : undefined}>{l.text || <br />}</div>
      ))}
      {truncated && (
        <div>
          … <button className="link" onClick={() => void openUpdateLink(releaseUrl)}>Read the full notes on GitHub</button>
        </div>
      )}
    </div>
  );
}

function UpdateCard({ info, result, skipped }: { info: UpdateInfo; result: UpdateResult; skipped: boolean }) {
  const setPrefs = useStore((s) => s.setPrefs);
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    if (!pendingFocus.current) return;
    document.getElementById(pendingFocus.current)?.focus();
    pendingFocus.current = null;
  }, [skipped]);
  const osArch = `${result.platform.label.replace(/ \(.*\)$/, "")} (${result.platform.arch})`;
  return (
    <div className="set-card update-card">
      <div className="set-card-head">
        <b>Hey Look! {info.latest} is available</b>
        {skipped ? <span className="pill">Skipped</span> : <span className="pill accent">New</span>}
      </div>
      <div className="muted small">
        You have {result.current}
        {info.publishedAt != null && ` · Released ${fmtDay(info.publishedAt)}`}
        {!info.notes.trim() && " · No release notes"}
      </div>
      {!info.asset && (
        <div className="notice info" style={{ marginTop: 10 }}>
          This release has no installer for {osArch}. The release page may list other options.
        </div>
      )}
      {/* DOM order = tab order (buttons, skip link, then the notes); CSS `order` shows the notes above the buttons */}
      <div className="update-actions">
        {info.asset && (
          <button className="btn primary" onClick={() => void downloadUpdate(info)}>Download for {result.platform.label}</button>
        )}
        <button className={info.asset ? "btn" : "btn primary"} onClick={() => void openUpdateLink(info.releaseUrl)}>View release on GitHub</button>
      </div>
      {info.asset && <div className="muted small update-file">{info.asset.name} · {fmtSize(info.asset.size)}</div>}
      <div className="small update-skip">
        {skipped ? (
          <>
            <span className="muted">You skipped this version. </span>
            <button id="upd-skip" className="link" onClick={() => ((pendingFocus.current = "upd-skip"), setPrefs({ skippedUpdate: "" }))}>Remind me again</button>
          </>
        ) : (
          <button id="upd-skip" className="link" onClick={() => ((pendingFocus.current = "upd-skip"), setPrefs({ skippedUpdate: info.latest }))}>Skip this version</button>
        )}
      </div>
      {info.notes.trim() && <UpdateNotes notes={info.notes} truncated={info.notesTruncated} releaseUrl={info.releaseUrl} />}
    </div>
  );
}

/** Settings > About > Updates: status, the update card, the "Check for updates" button and the automatic-check switch. */
export function UpdatesBlock({ autoSwitch }: { autoSwitch: ReactNode }) {
  const update = useStore((s) => s.update);
  const checkedAt = useStore((s) => s.updateCheckedAt);
  const busy = useStore((s) => s.updateBusy);
  const prefs = useStore((s) => s.prefs);
  const checkUpdate = useStore((s) => s.checkUpdate);
  const btn = useRef<HTMLButtonElement>(null);
  const [, tick] = useState(0);

  const kind = updateKindOf(update);
  const retryAt = kind === "rateLimited" ? update?.retryAt ?? null : null;
  const limited = retryAt != null && retryAt * 1000 > Date.now();
  // the rate-limit hold ends by itself: re-render when it is over
  useEffect(() => {
    if (retryAt == null) return;
    const ms = retryAt * 1000 - Date.now();
    if (ms <= 0) return;
    const t = setTimeout(() => tick((n) => n + 1), ms + 50);
    return () => clearTimeout(t);
  }, [retryAt]);

  const check = () => void checkUpdate("manual").then(() => btn.current?.focus());
  const retry = <button className="link" onClick={check}>Try again</button>;
  const checked = checkedAt == null ? "never" : Date.now() / 1000 - checkedAt < 60 ? "just now" : fmtWhen(checkedAt);
  const info = update?.info ?? null;

  let status: ReactNode = null;
  if (busy) status = <p className="muted">Checking for updates…</p>;
  else if (update && kind === "available" && info) status = <UpdateCard info={info} result={update} skipped={info.latest === prefs.skippedUpdate} />;
  else if (update && kind === "upToDate" && info)
    status = (
      <div className="notice good">
        {info.latest === update.current
          ? `You’re up to date. Hey Look! ${update.current} is the latest version.`
          : `You’re up to date. This build (${update.current}) is newer than the latest release (${info.latest}).`}
      </div>
    );
  else if (kind === "noRelease") status = <div className="notice info">No release has been published yet.</div>;
  else if (kind === "offline") status = <div className="notice bad">Couldn’t check for updates. You seem to be offline. {retry}</div>;
  else if (kind === "rateLimited")
    status = (
      <div className="notice bad">
        GitHub is limiting update checks right now.{retryAt != null && ` Try again after ${fmtClock(retryAt)}.`}
      </div>
    );
  else if (kind === "error")
    status = (
      <div className="notice bad">
        Couldn’t check for updates{update?.message ? `: ${update.message}` : ""}. {retry}
      </div>
    );

  return (
    <div>
      <h4>Updates</h4>
      <div className="update-live" role="status" aria-live="polite">{status}</div>
      <div className="update-status">
        <span className="muted small">Last checked: {checked}</span>
        <button
          ref={btn}
          className="btn small"
          disabled={busy || limited}
          aria-busy={busy || undefined}
          title={limited && retryAt != null ? `Try again after ${fmtClock(retryAt)}` : undefined}
          onClick={check}
        >
          {busy ? (
            <>
              <RefreshCw size={13} className="spin" /> Checking…
            </>
          ) : (
            "Check for updates"
          )}
        </button>
      </div>
      {autoSwitch}
    </div>
  );
}
