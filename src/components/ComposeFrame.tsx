import { ChevronDown, Trash2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { kbd } from "../platform";
import { startPreview, previewVars } from "../composePreview";
import { statusShown, STATUS_AFTER_MS, STATUS_MIN_MS } from "../composeShell";
import { startRecipients } from "../composeStart";
import { eff } from "../prefs";
import { useDelayedFlag } from "../delayedFlag";
import { useT } from "../i18n/react";
import { useStore, type ComposeInit } from "../store";
import { useAppDark } from "../useAppDark";
import { LazyLoading } from "../lazy";
import { GhostChips } from "./GhostChips";

/**
 * The compose pane before the editor stack (components/Compose.tsx, a chunk of its own, WP9d) has arrived: the same boxes with the same class names, drawn by the main chunk.
 * A Reply / Reply all / Forward shows its shell from here (REQ-13.13.1 / 13.13.9: the shell never waits for the editor): the action row with Send off and Discard, the header rows
 * off (subject and account known), the status "Preparing reply…" 140 ms after the press. Any other message shows the loading look in the body after 150 ms. Normally this is on
 * screen for a few frames at most, the editor chunk is fetched when the browser is idle after the first paint and when the pointer reaches a Reply button (lazyViews.tsx).
 * The caret of the real pane goes where it goes today; Esc and Discard end a shell like the real pane's (REQ-13.13.6).
 */
export function ComposeFrame({ init, late }: { init: ComposeInit; late: boolean }) {
  const t = useT();
  const accounts = useStore((s) => s.accounts);
  const canvas = useStore((s) => s.prefs.mailCanvas);
  const prefs = useStore((s) => s.prefs);
  const themeDark = useAppDark();
  const preparing = init.preparing;
  // the same delay as the real pane's (counted from the press), so the status neither comes twice nor flashes
  const status = useDelayedFlag(!!preparing, preparing ? Math.max(0, STATUS_AFTER_MS - (Date.now() - preparing.at)) : STATUS_AFTER_MS, STATUS_MIN_MS);
  useEffect(() => {
    if (preparing && status) statusShown(preparing.id);
  }, [preparing, status]);
  const prepRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (preparing) prepRef.current?.focus({ preventScroll: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const discard = () => void useStore.getState().openCompose(null, { restore: false });
  const account = accounts.find((a) => a.id === init.accountId) ?? accounts[0];
  // the Cc and Bcc rows of the real pane (a Reply all with Cc recipients, a forward with an Auto Cc / Bcc): in the shell from the first frame, so nothing appears at the fill (REQ-13.13.12)
  const rows = startRecipients(init, { cc: eff(prefs, account?.id, "autoCc"), bcc: eff(prefs, account?.id, "autoBcc") });
  const hiddenChip = (
    <span className="rchip" aria-hidden style={{ visibility: "hidden" }}><span>.</span><button type="button" tabIndex={-1}><X size={11} /></button></span>
  );
  return (
    <div
      className={`compose-pane ${preparing ? "preparing" : ""}`}
      aria-busy="true"
      data-lazy-frame=""
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) (e.preventDefault(), discard());
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") e.preventDefault();
      }}
    >
      <div className="cp-head">
        <div className="cp-bar">
          <div className="split-btn" data-fit="fixed">
            <button className="btn primary" disabled title={kbd(t("compose.bar.sendTip"))}><span className="btn-lbl">{t("compose.bar.send")}</span></button>
            <button className="btn primary split-caret" disabled aria-label={t("compose.bar.sendLaterOptions")}><ChevronDown size={14} /></button>
          </div>
          <button className="rb cp-keep" data-fit="fixed" onClick={discard}><Trash2 size={15} /><span>{t("compose.bar.discard")}</span></button>
        </div>
        <div className="cp-fields" inert>
          <div className="cf-field"><label>{t("compose.from")}</label><span className="cf-static">{account?.email ?? ""}</span></div>
          <div className="cf-field rcpt">
            <label>{t("compose.to")}</label>
            {/* the boxes of the real field, so the row has its height before the message is filled in (D-067): a reply has a recipient (one invisible chip), a forward has none; the input is the one of RecipientField */}
            <div className="chips">
              <GhostChips values={preparing?.rcpt?.to} />
              <input autoComplete="off" readOnly tabIndex={-1} aria-label={t("compose.to")} />
            </div>
          </div>
          {!rows.showCc && (
            // (the row of the real pane that adds them: same height, so the Subject row below does not move when the real pane replaces this frame)
            <div className="cf-links"><button className="link" tabIndex={-1}>{t("compose.cc")}</button><button className="link" tabIndex={-1}>{t("compose.bcc")}</button></div>
          )}
          {rows.showCc && (
            <>
              <div className="cf-field rcpt"><label>{t("compose.cc")}</label><div className="chips"><GhostChips values={preparing?.rcpt?.cc} />{rows.cc.length > 0 && hiddenChip}<input autoComplete="off" readOnly tabIndex={-1} aria-label={t("compose.cc")} /></div></div>
              <div className="cf-field rcpt"><label>{t("compose.bcc")}</label><div className="chips">{rows.bcc.length > 0 && hiddenChip}<input autoComplete="off" readOnly tabIndex={-1} aria-label={t("compose.bcc")} /></div></div>
            </>
          )}
          <div className="cf-field cf-subject"><label>{t("compose.subject")}</label><input autoComplete="off" readOnly tabIndex={-1} value={init.subject ?? ""} aria-label={t("compose.subject")} /></div>
        </div>
      </div>
      <div className="cp-fmt" inert aria-hidden><span style={{ height: 28 }} /></div>
      <div className={`cp-editor cp-pv pv-${startPreview(themeDark, canvas)}`} style={previewVars(startPreview(themeDark, canvas)) as React.CSSProperties} data-preparing={preparing ? "" : undefined}>
        {preparing ? (
          <div className="cp-prep" ref={prepRef} tabIndex={-1}>
            {status && (
              <div className="reader-state" role="status" aria-busy="true">
                <span className="busy-ring spin" aria-hidden />
                <span className="busy-dots" aria-hidden>···</span>
                <p className="muted">{preparing.fetching ? t("compose.fwd.fetching") : t(preparing.kind === "forward" ? "compose.preparing.forward" : "compose.preparing.reply")}</p>
              </div>
            )}
          </div>
        ) : late ? (
          <LazyLoading />
        ) : null}
      </div>
    </div>
  );
}
