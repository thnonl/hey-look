import { RefreshCw } from "lucide-react";
import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { UpdateInfo, UpdateResult } from "../api";
import { getVersion } from "@tauri-apps/api/app";
import { t } from "../i18n";
import { useT } from "../i18n/react";
import { tx } from "../i18n/rich";
import { usePlatform } from "../platform";
import { useStore } from "../store";
import { isStaleOffer, openUpdateLink, pct, updateKindOf, UpdateFlow, useUpdates } from "../updates";
import { fmtDay, fmtSize, fmtWhen } from "../util";

/** The command a copy managed by apt names in Settings > About (a shell command, the same in every language). */
const APT_UPGRADE = "sudo apt update && sudo apt upgrade";

/** One line of release notes as plain text: markdown markers removed, links kept as their text, nothing is HTML. */
const plainLine = (s: string) =>
  s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]*)`/g, "$1");

/** Release notes as React text (never HTML): headings bold, bullets as "• ", other lines as they are. */
function UpdateNotes({ notes, truncated, releaseUrl }: { notes: string; truncated: boolean; releaseUrl: string }) {
  const t = useT();
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
    <div className="update-notes" ref={box} tabIndex={scrolls ? 0 : undefined} aria-label={scrolls ? t("updates.notes.region") : undefined} role={scrolls ? "region" : undefined}>
      <div className="small h">{t("updates.action.whatsNew")}</div>
      {lines.map((l, i) => (
        <div key={i} className={l.h ? "h" : undefined}>{l.text || <br />}</div>
      ))}
      {truncated && (
        <div>
          … <button className="link" onClick={() => void openUpdateLink(releaseUrl)}>{t("updates.notes.readFull")}</button>
        </div>
      )}
    </div>
  );
}

/** "a few seconds left", "about 20 s left", "about 3 min left" (nothing for an hour or more). */
function etaText(secs: number | null): string | null {
  if (secs == null) return null;
  if (secs < 10) return t("updates.eta.fewSeconds");
  if (secs < 60) return t("updates.eta.seconds", { seconds: Math.max(10, Math.round(secs / 5) * 5) });
  if (secs < 3600) return t("updates.eta.minutes", { minutes: Math.ceil(secs / 60) });
  return null;
}

/** The progress bar of a download (determinate with a total, else indeterminate) or of the verification step. */
function FlowBar({ flow, verifying }: { flow: UpdateFlow; verifying: boolean }) {
  const t = useT();
  const p = pct(flow);
  const indet = verifying || p == null;
  return (
    <div
      className={`progress update-progress${indet ? " indet" : ""}`}
      role="progressbar"
      aria-label={t("updates.progress.label")}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indet ? undefined : p}
      aria-valuetext={
        verifying ? t("updates.progress.verifying")
        : p == null ? t("updates.progress.downloading", { received: fmtSize(flow.received) })
        : flow.total ? t("updates.progress.percentOf", { percent: p, received: fmtSize(flow.received), total: fmtSize(flow.total) })
        : t("updates.progress.percent", { percent: p, received: fmtSize(flow.received) })
      }
    >
      <i style={indet ? undefined : { width: `${p}%` }} />
    </div>
  );
}

const failedText = (f: UpdateFlow) =>
  f.stage === "verify"
    ? t("updates.failed.verify")
    : f.stage === "badurl"
      ? t("updates.failed.badurl")
      : f.stage === "install"
        ? t("updates.failed.install", { message: f.message })
        : t("updates.failed.download", { message: f.message });

function UpdateCard({ info, result, skipped }: { info: UpdateInfo; result: UpdateResult; skipped: boolean }) {
  const t = useT();
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
    if (st === "downloading") return <span className="pill accent">{t("updates.pill.downloading")}</span>;
    if (st === "verifying") return <span className="pill accent">{t("updates.pill.verifying")}</span>;
    if (st === "installing") return <span className="pill good">{t("updates.pill.installing")}</span>;
    if (readyHead) return <span className="pill good">{t("updates.pill.ready")}</span>;
    if (st === "failed") return null;
    return skipped ? <span className="pill">{t("updates.pill.skipped")}</span> : <span className="pill accent">{t("updates.pill.new")}</span>;
  })();
  const speed = flow.speed != null ? `${fmtSize(Math.round(flow.speed))}/s` : null;
  const eta = etaText(flow.eta);
  const hint = result.platform.installer === "msi" ? t("updates.hint.msi") : ["deb", "rpm"].includes(result.platform.installer) ? t("updates.hint.password") : null;
  const sizeText = info.asset?.size != null ? ` · ${fmtSize(info.asset.size)}` : "";
  return (
    <div className={`set-card update-card${st !== "idle" ? " flowing" : ""}`}>
      <div className="set-card-head">
        <b>{t(readyHead ? "updates.card.readyHead" : "updates.card.availableHead", { version: info.latest })}</b>
        {pill}
      </div>
      <div className="muted small">
        {t("updates.card.youHave", { version: result.current })}
        {info.publishedAt != null && ` · ${t("updates.card.released", { date: fmtDay(info.publishedAt) })}`}
        {!info.notes.trim() && ` · ${t("updates.card.noNotes")}`}
      </div>

      {(st === "downloading" || st === "verifying") && (
        <>
          <div aria-live="off">
            {st === "downloading" ? (
              <div className="update-flow-line">
                {flow.total
                  ? t("updates.flow.downloadingOf", { received: fmtSize(flow.received), total: fmtSize(flow.total), percent: pct(flow) ?? 0 })
                  : t("updates.flow.downloading", { received: fmtSize(flow.received) })}
              </div>
            ) : (
              <div className="update-flow-line" aria-hidden>{t("updates.flow.verifying")}</div>
            )}
            <FlowBar flow={flow} verifying={st === "verifying"} />
            {st === "downloading" && (
              <div className="muted small update-flow-line">
                {speed ? [speed, eta].filter(Boolean).join(" · ") : t("updates.flow.starting")}
              </div>
            )}
          </div>
          {st === "downloading" && (
            <div className="update-actions" style={{ marginTop: 8 }}>
              <button id="upd-cancel" className="btn" onClick={cancelUpdate}>{t("common.cancel")}</button>
              <span className="muted small">{t("updates.flow.keepWorking")}</span>
            </div>
          )}
        </>
      )}

      {st === "ready" && (
        <>
          <div className="notice good" style={{ marginTop: 10 }}>
            {flow.countdown != null ? t("updates.flow.restartCountdown", { seconds: flow.countdown }) : t("updates.flow.restartWill")}
          </div>
          <div className="update-actions">
            <button id="upd-restart" className="btn primary" onClick={() => void restartToUpdate()}>{t("updates.action.restartNow")}</button>
            <button className="btn" onClick={deferUpdate}>{flow.countdown != null ? t("updates.action.notNow") : t("updates.action.later")}</button>
          </div>
        </>
      )}
      {st === "waiting" && (
        <>
          <div className="notice info" style={{ marginTop: 10 }}>{t("updates.flow.waiting")}</div>
          <div className="update-actions">
            <button className="btn" onClick={cancelRestart}>{t("updates.action.cancelRestart")}</button>
          </div>
        </>
      )}
      {st === "installing" && <p className="muted" style={{ marginTop: 10 }}>{t("updates.flow.installing")}</p>}
      {st === "deferred" && (
        <>
          <div className="notice good" style={{ marginTop: 10 }}>{t("updates.flow.deferred")}</div>
          <div className="update-actions">
            <button id="upd-restart" className="btn primary" onClick={() => void restartToUpdate()}>{t("updates.action.restartNow")}</button>
          </div>
        </>
      )}
      {st === "failed" && (
        <>
          <div className="notice bad" style={{ marginTop: 10 }}>{failedText(flow)}</div>
          <div className="update-actions">
            <button id="upd-retry" className="btn primary" onClick={retryUpdate}>{t("updates.action.tryAgain")}</button>
            <button className="btn" onClick={openFallback}>{t("updates.action.downloadFromGithub")}</button>
            <button className="btn" onClick={() => void openUpdateLink(info.releaseUrl)}>{t("updates.action.viewRelease")}</button>
          </div>
        </>
      )}

      {st === "idle" && (
        <>
          {!info.asset && (
            <div className="notice info" style={{ marginTop: 10 }}>
              {t("updates.card.noInstaller", { platform: osArch })}
            </div>
          )}
          <div className="update-actions">
            {info.asset && (
              <button
                id="upd-start"
                className="btn primary"
                onClick={() => ((pendingFocus.current = "upd-cancel"), void startUpdate("card"))}
              >
                {t("updates.action.downloadInstall")}
              </button>
            )}
            <button className={info.asset ? "btn" : "btn primary"} onClick={() => void openUpdateLink(info.releaseUrl)}>{t("updates.action.viewRelease")}</button>
          </div>
          {info.asset && <div className="muted small update-file">{info.asset.name}{sizeText}</div>}
          {info.asset && hint && <div className="muted small">{hint}</div>}
          {info.asset && isStaleOffer(result) && (
            <div className="muted small">{t("updates.card.offlineNote")}</div>
          )}
          <div className="small update-skip">
            {skipped ? (
              <>
                <span className="muted">{t("updates.card.skipped")} </span>
                <button id="upd-skip" className="link" onClick={() => ((pendingFocus.current = "upd-skip"), setPrefs({ skippedUpdate: "" }))}>{t("updates.action.remind")}</button>
              </>
            ) : (
              <button id="upd-skip" className="link" onClick={() => ((pendingFocus.current = "upd-skip"), setPrefs({ skippedUpdate: info.latest }), useStore.getState().setStickyToast("update-available", null))}>{t("updates.action.skip")}</button>
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
  const t = useT();
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
  const managed = usePlatform((s) => s.managed);
  const check = () => void checkUpdate("manual").then(() => btn.current?.focus());
  const retry = <button className="link" onClick={check}>{t("updates.action.tryAgain")}</button>;
  const checked = checkedAt == null ? t("updates.status.never") : Date.now() / 1000 - checkedAt < 60 ? t("updates.status.justNow") : fmtWhen(checkedAt);
  const info = update?.info ?? null;
  const flow = useUpdates((s) => s.flow);

  // `live` is the short state text a screen reader announces; the card itself is outside the live region
  let live: ReactNode = null;
  let card: ReactNode = null;
  if (busy) live = <p className="muted">{t("updates.status.checking")}</p>;
  else if (update && kind === "available" && info) {
    card = <UpdateCard info={info} result={update} skipped={info.latest === skippedUpdate} />;
    const mine = flow.state !== "idle" && flow.version === info.latest ? flow.state : "idle";
    const line =
      mine === "downloading" ? t("updates.live.downloading", { version: info.latest })
      : mine === "verifying" ? t("updates.flow.verifying")
      : mine === "ready" ? (flow.countdown != null ? t("updates.live.readyCountdown", { version: info.latest, seconds: flow.countdown }) : t("updates.live.ready", { version: info.latest }))
      : mine === "waiting" ? t("updates.live.waiting")
      : mine === "installing" ? t("updates.live.installing")
      : mine === "deferred" ? t("updates.flow.deferred")
      : mine === "failed" ? failedText(flow)
      : t("updates.available", { version: info.latest });
    // a stale offer (the last check failed): the quiet note replaces the sr-only line, only while no download / restart is going on.
    // After a failed download (F6) the card keeps its failure (REQ-47 h) and the note is added: the person asked for a check, and a check
    // that could not reach the server must say so (QA round 6, stopped server).
    if (isStaleOffer(update) && (mine === "idle" || mine === "failed"))
      live = (
        <>
          <p className="muted small">
            {update.kind === "offline" ? t("updates.stale.offline") : update.message ? t("updates.stale.error", { message: update.message }) : t("updates.stale.errorNoMessage")} {retry}
          </p>
          {mine === "failed" && <span className="sr-only">{line}</span>}
        </>
      );
    else live = <span className="sr-only">{line}</span>;
  } else if (update && kind === "upToDate" && info)
    live = (
      <div className="notice good">
        {info.latest === update.current
          ? t("updates.upToDate.same", { version: update.current })
          : t("updates.upToDate.newer", { current: update.current, latest: info.latest })}
      </div>
    );
  else if (kind === "noRelease")
    live = (
      <div className="notice info">
        {tx("updates.noRelease", {
          link: (
            <a
              className="link"
              href="https://github.com/thnonl/hey-look/releases"
              onClick={(e) => {
                e.preventDefault();
                void openUpdateLink("https://github.com/thnonl/hey-look/releases");
              }}
            >
              {t("updates.noRelease.link")}
            </a>
          ),
        })}
      </div>
    );
  else if (kind === "offline") live = <div className="notice bad">{t("updates.check.offline")} {retry}</div>;
  else if (kind === "error")
    live = (
      <div className="notice bad">
        {update?.message ? t("updates.check.error", { message: update.message }) : t("updates.check.errorNoMessage")} {retry}
      </div>
    );

  const version = update?.current || appVersion;
  // a snap is updated by the Snap Store, an apt copy by apt and the Microsoft Store package by the Store: the version, who updates it, the privacy statement without its
  // update sentences (the Store version has its own text that says the Store updates it), and neither the button nor the switch
  if (managed)
    return (
      <div>
        <div className="update-status">
          <span>
            <b className="selectable">{t("updates.status.version", { version })}</b>
          </span>
        </div>
        <p className="muted small">{managed === "apt" ? tx("updates.managed.apt", { command: <code>{APT_UPGRADE}</code> }) : managed === "msstore" ? t("settings.about.updatesStore") : t("updates.managed.snap")}</p>
        <p className="muted small">{managed === "msstore" ? t("settings.about.privacyStore") : t("settings.about.privacyManaged")}</p>
      </div>
    );
  return (
    <div>
      <div className="update-status">
        <span>
          <b className="selectable">{t("updates.status.version", { version })}</b> <span className="muted small">· {t("updates.status.lastChecked", { when: checked })}</span>
        </span>
        <button ref={btn} className="btn small" disabled={busy} aria-busy={busy || undefined} onClick={check}>
          {busy ? (
            <>
              <RefreshCw size={13} className="spin" /> {t("updates.action.checking")}
            </>
          ) : (
            t("updates.action.check")
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
