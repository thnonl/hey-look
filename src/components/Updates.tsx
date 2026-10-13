import { RefreshCw } from "lucide-react";
import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { UpdateInfo, UpdateResult } from "../api";
import { getVersion } from "@tauri-apps/api/app";
import { useStore } from "../store";
import { openUpdateLink, pct, updateKindOf, UpdateFlow, useUpdates } from "../updates";
import { fmtDay, fmtSize, fmtWhen } from "../util";

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

/** "a few seconds left", "about 20 s left", "about 3 min left" (nothing for an hour or more). */
function etaText(secs: number | null): string | null {
  if (secs == null) return null;
  if (secs < 10) return "a few seconds left";
  if (secs < 60) return `about ${Math.max(10, Math.round(secs / 5) * 5)} s left`;
  if (secs < 3600) return `about ${Math.ceil(secs / 60)} min left`;
  return null;
}

/** The progress bar of a download (determinate with a total, else indeterminate) or of the verification step. */
function FlowBar({ flow, verifying }: { flow: UpdateFlow; verifying: boolean }) {
  const p = pct(flow);
  const indet = verifying || p == null;
  const total = flow.total ? ` of ${fmtSize(flow.total)}` : "";
  return (
    <div
      className={`progress update-progress${indet ? " indet" : ""}`}
      role="progressbar"
      aria-label="Download progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indet ? undefined : p}
      aria-valuetext={verifying ? "Verifying" : p == null ? `Downloading, ${fmtSize(flow.received)}` : `${p}%, ${fmtSize(flow.received)}${total}`}
    >
      <i style={indet ? undefined : { width: `${p}%` }} />
    </div>
  );
}

const failedText = (f: UpdateFlow) =>
  f.stage === "verify"
    ? "The download is damaged or its signature doesn’t match. Nothing was installed."
    : f.stage === "badurl"
      ? "The update link isn’t from the Hey Look! releases. Nothing was downloaded."
      : f.stage === "install"
        ? `Couldn’t install the update: ${f.message}.`
        : `Couldn’t download the update. ${f.message}`;

function UpdateCard({ info, result, skipped }: { info: UpdateInfo; result: UpdateResult; skipped: boolean }) {
  const setPrefs = useStore((s) => s.setPrefs);
  const flow = useUpdates((s) => s.flow);
  const { startUpdate, cancelUpdate, restartToUpdate, deferUpdate, cancelRestart, retryUpdate, openFallback } = useUpdates.getState();
  const pendingFocus = useRef<string | null>(null);
  const mine = flow.state !== "idle" && flow.version === info.latest;
  const st = mine ? flow.state : "idle";
  // moves focus where the next step is (the button that was pressed has just gone away)
  useEffect(() => {
    if (pendingFocus.current) {
      document.getElementById(pendingFocus.current)?.focus();
      pendingFocus.current = null;
    } else if (document.activeElement === document.body) {
      if (st === "ready" || st === "deferred") document.getElementById("upd-restart")?.focus();
      else if (st === "failed") document.getElementById("upd-retry")?.focus();
    }
  }, [skipped, st]);
  const osArch = `${result.platform.label.replace(/ \(.*\)$/, "")} (${result.platform.arch})`;
  const readyHead = st === "ready" || st === "waiting" || st === "deferred" || st === "installing";
  const pill = (() => {
    if (st === "downloading") return <span className="pill accent">Downloading</span>;
    if (st === "verifying") return <span className="pill accent">Verifying</span>;
    if (st === "installing") return <span className="pill good">Installing</span>;
    if (readyHead) return <span className="pill good">Ready</span>;
    if (st === "failed") return null;
    return skipped ? <span className="pill">Skipped</span> : <span className="pill accent">New</span>;
  })();
  const speed = flow.speed != null ? `${fmtSize(Math.round(flow.speed))}/s` : null;
  const eta = etaText(flow.eta);
  const hint = result.platform.installer === "msi" ? "Windows will ask for permission to install." : ["deb", "rpm"].includes(result.platform.installer) ? "You’ll be asked for your password to install." : null;
  const sizeText = info.asset?.size != null ? ` · ${fmtSize(info.asset.size)}` : "";
  return (
    <div className={`set-card update-card${st !== "idle" ? " flowing" : ""}`}>
      <div className="set-card-head">
        <b>{readyHead ? `Hey Look! ${info.latest} is ready to install` : `Hey Look! ${info.latest} is available`}</b>
        {pill}
      </div>
      <div className="muted small">
        You have {result.current}
        {info.publishedAt != null && ` · Released ${fmtDay(info.publishedAt)}`}
        {!info.notes.trim() && " · No release notes"}
      </div>

      {(st === "downloading" || st === "verifying") && (
        <>
          <div aria-live="off">
            {st === "downloading" ? (
              <div className="update-flow-line">
                Downloading… {fmtSize(flow.received)}
                {flow.total ? ` of ${fmtSize(flow.total)} (${pct(flow)}%)` : ""}
              </div>
            ) : (
              <div className="update-flow-line" aria-hidden>Verifying the download…</div>
            )}
            <FlowBar flow={flow} verifying={st === "verifying"} />
            {st === "downloading" && (
              <div className="muted small update-flow-line">
                {speed ? [speed, eta].filter(Boolean).join(" · ") : "Starting…"}
              </div>
            )}
          </div>
          {st === "downloading" && (
            <div className="update-actions" style={{ marginTop: 8 }}>
              <button id="upd-cancel" className="btn" onClick={cancelUpdate}>Cancel</button>
              <span className="muted small">You can keep working.</span>
            </div>
          )}
        </>
      )}

      {st === "ready" && (
        <>
          <div className="notice good" style={{ marginTop: 10 }}>
            {flow.countdown != null ? `Restarting in ${flow.countdown} s to finish the update.` : "Hey Look! will restart to finish the update."}
          </div>
          <div className="update-actions">
            <button id="upd-restart" className="btn primary" onClick={() => void restartToUpdate()}>Restart now</button>
            <button className="btn" onClick={deferUpdate}>{flow.countdown != null ? "Not now" : "Later"}</button>
          </div>
        </>
      )}
      {st === "waiting" && (
        <>
          <div className="notice info" style={{ marginTop: 10 }}>Finishing sending your message… Hey Look! will restart right after.</div>
          <div className="update-actions">
            <button className="btn" onClick={cancelRestart}>Cancel restart</button>
          </div>
        </>
      )}
      {st === "installing" && <p className="muted" style={{ marginTop: 10 }}>Installing the update… Hey Look! will restart.</p>}
      {st === "deferred" && (
        <>
          <div className="notice good" style={{ marginTop: 10 }}>The update will be installed when you quit the app.</div>
          <div className="update-actions">
            <button id="upd-restart" className="btn primary" onClick={() => void restartToUpdate()}>Restart now</button>
          </div>
        </>
      )}
      {st === "failed" && (
        <>
          <div className="notice bad" style={{ marginTop: 10 }}>{failedText(flow)}</div>
          <div className="update-actions">
            <button id="upd-retry" className="btn primary" onClick={retryUpdate}>Try again</button>
            <button className="btn" onClick={openFallback}>Download from GitHub instead</button>
            <button className="btn" onClick={() => void openUpdateLink(info.releaseUrl)}>View release on GitHub</button>
          </div>
        </>
      )}

      {st === "idle" && (
        <>
          {!info.asset && (
            <div className="notice info" style={{ marginTop: 10 }}>
              This release has no installer for {osArch}. The release page may list other options.
            </div>
          )}
          <div className="update-actions">
            {info.asset && (
              <button
                id="upd-start"
                className="btn primary"
                onClick={() => ((pendingFocus.current = "upd-cancel"), void startUpdate("card"))}
              >
                Download and install
              </button>
            )}
            <button className={info.asset ? "btn" : "btn primary"} onClick={() => void openUpdateLink(info.releaseUrl)}>View release on GitHub</button>
          </div>
          {info.asset && <div className="muted small update-file">{info.asset.name}{sizeText}</div>}
          {info.asset && hint && <div className="muted small">{hint}</div>}
          <div className="small update-skip">
            {skipped ? (
              <>
                <span className="muted">You skipped this version. </span>
                <button id="upd-skip" className="link" onClick={() => ((pendingFocus.current = "upd-skip"), setPrefs({ skippedUpdate: "" }))}>Remind me again</button>
              </>
            ) : (
              <button id="upd-skip" className="link" onClick={() => ((pendingFocus.current = "upd-skip"), setPrefs({ skippedUpdate: info.latest }), useStore.getState().setStickyToast("update-available", null))}>Skip this version</button>
            )}
          </div>
        </>
      )}
      {info.notes.trim() && <UpdateNotes notes={info.notes} truncated={info.notesTruncated} releaseUrl={info.releaseUrl} />}
    </div>
  );
}

/** Settings > About > Updates: status, the update card, the "Check for updates" button and the automatic-check switch. */
export function UpdatesBlock({ privacy, autoSwitch }: { privacy: ReactNode; autoSwitch: ReactNode }) {
  const update = useUpdates((s) => s.update);
  const checkedAt = useUpdates((s) => s.checkedAt);
  const busy = useUpdates((s) => s.busy);
  const checkUpdate = useUpdates((s) => s.checkUpdate);
  const skippedUpdate = useStore((s) => s.prefs.skippedUpdate);
  const btn = useRef<HTMLButtonElement>(null);
  // the version of the running app: from the app itself until the first check answer
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    void getVersion().then(setAppVersion).catch(() => undefined);
  }, []);

  const kind = updateKindOf(update);
  const check = () => void checkUpdate("manual").then(() => btn.current?.focus());
  const retry = <button className="link" onClick={check}>Try again</button>;
  const checked = checkedAt == null ? "never" : Date.now() / 1000 - checkedAt < 60 ? "just now" : fmtWhen(checkedAt);
  const info = update?.info ?? null;
  const flow = useUpdates((s) => s.flow);

  // `live` is the short state text a screen reader announces; the card itself is outside the live region
  let live: ReactNode = null;
  let card: ReactNode = null;
  if (busy) live = <p className="muted">Checking for updates…</p>;
  else if (update && kind === "available" && info) {
    card = <UpdateCard info={info} result={update} skipped={info.latest === skippedUpdate} />;
    const mine = flow.state !== "idle" && flow.version === info.latest ? flow.state : "idle";
    const line =
      mine === "downloading" ? `Downloading Hey Look! ${info.latest}…`
      : mine === "verifying" ? "Verifying the download…"
      : mine === "ready" ? (flow.countdown != null ? `Hey Look! ${info.latest} is ready. Restarting in ${flow.countdown} s.` : `Hey Look! ${info.latest} is ready to install.`)
      : mine === "waiting" ? "Finishing sending your message…"
      : mine === "installing" ? "Installing the update…"
      : mine === "deferred" ? "The update will be installed when you quit the app."
      : mine === "failed" ? failedText(flow)
      : `Hey Look! ${info.latest} is available.`;
    live = <span className="sr-only">{line}</span>;
  } else if (update && kind === "upToDate" && info)
    live = (
      <div className="notice good">
        {info.latest === update.current
          ? `You’re up to date. Hey Look! ${update.current} is the latest version.`
          : `You’re up to date. This build (${update.current}) is newer than the latest release (${info.latest}).`}
      </div>
    );
  else if (kind === "noRelease")
    live = (
      <div className="notice info">
        Couldn’t find update information on GitHub. Try again later, or see the{" "}
        <a
          className="link"
          href="https://github.com/thnonl/hey-look/releases"
          onClick={(e) => {
            e.preventDefault();
            void openUpdateLink("https://github.com/thnonl/hey-look/releases");
          }}
        >
          releases page
        </a>
        .
      </div>
    );
  else if (kind === "offline") live = <div className="notice bad">Couldn’t check for updates. You seem to be offline. {retry}</div>;
  else if (kind === "error")
    live = (
      <div className="notice bad">
        Couldn’t check for updates{update?.message ? `: ${update.message}` : ""}. {retry}
      </div>
    );

  const version = update?.current || appVersion;
  return (
    <div>
      <div className="update-status">
        <span>
          <b>Version {version}</b> <span className="muted small">· Last checked: {checked}</span>
        </span>
        <button ref={btn} className="btn small" disabled={busy} aria-busy={busy || undefined} onClick={check}>
          {busy ? (
            <>
              <RefreshCw size={13} className="spin" /> Checking…
            </>
          ) : (
            "Check for updates"
          )}
        </button>
      </div>
      <div className="update-live" role="status" aria-live="polite">{live}</div>
      {card}
      {privacy}
      {autoSwitch}
    </div>
  );
}
