// The result of "Test connection" (and of a refused "Add account") under the manual account form: a summary line, one line for the incoming and one
// for the outgoing server, each with the sentence, what to do, "Show field" and the one-click fixes, then Details with Copy. The words come from
// src/connHints.ts (kind -> message, hint, field, fixes); the state lives in the form (SettingsDialog.tsx ImapForm).
import { getVersion } from "@tauri-apps/api/app";
import { Check, TriangleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import { copyToClipboard } from "../open";
import { osNow } from "../platform";
import { useStore } from "../store";
import {
  type Block, type ConnForm, describe, detailsText, FIELD_LABEL, type FieldId, fixMsg, type Fix, okMsg, type PartName, type PartView, say, smtpSharedNote, staleParts, summaryOf,
} from "../connHints";
import { type Key } from "../i18n";
import { useT } from "../i18n/react";

const OS_NAME: Record<string, string> = { windows: "Windows", macos: "macOS", linux: "Linux" };

/** "Hey Look! 1.0.10, Windows": the last line of the details. */
function useProduct(): string {
  const [version, setVersion] = useState("");
  useEffect(() => {
    void getVersion().then(setVersion).catch(() => undefined);
  }, []);
  return `Hey Look! ${version}, ${OS_NAME[osNow()] ?? osNow()}`.replace("!  ", "! ");
}

interface Props {
  block: Block;
  /** the form as it is now (presets hide the server fields; an edit makes a line stale) */
  form: ConnForm;
  now: import("../connHints").Sigs;
  onCancel: () => void;
  onShowField: (id: FieldId) => void;
  onFix: (fix: Fix) => void;
}

export function ConnTestBlock({ block, form, now, onCancel, onShowField, onFix }: Props) {
  const t = useT();
  const showToast = useStore((s) => s.showToast);
  const product = useProduct();
  const stale = staleParts(block, now);
  const sum = summaryOf(block, stale);
  const checking = block.imap.state === "checking" || block.smtp.state === "checking";
  const cancelled = block.imap.state === "cancelled" && block.smtp.state === "cancelled";
  const name = (p: PartName) => t(p === "imap" ? "settings.server.incoming" : "settings.server.outgoing");
  const lines = (["imap", "smtp"] as const).map((p) => ({ p, v: p === "imap" ? block.imap : block.smtp }));
  // what a screen reader hears when the test is over: the summary and each part that failed (never the colour alone)
  const failed = lines.filter(({ p, v }) => !checking && !stale[p] && v.report?.status === "error").map(({ p, v }) => `${name(p)}: ${describeText(p, v, form)}`);
  const auto = lines.some(({ p, v }) => v.report && !stale[p] && describe(p, v.report, form).openDetails && v.report.status === "error");
  const [open, setOpen] = useState<boolean | null>(null);
  const copyText = detailsText(block, product);
  const copy = () =>
    void copyToClipboard(copyText).then((ok) => (ok ? showToast(() => t("settings.test.copied"), undefined, "success") : showToast(() => t("mail.ctx.copyFailed"), undefined, "error")));
  const hasReport = lines.some(({ v }) => v.report);
  const tone = sum.tone === "warn" ? "" : sum.tone;
  return (
    <div className={`notice conn-block ${tone}`} data-conn="block" data-tone={sum.tone} role="group" aria-label={t("settings.test.groupLabel")}>
      <div className="conn-head">
        <b role="status" aria-live="polite" data-conn="summary">
          {t(sum.key)}
          {failed.length > 0 && <span className="sr-only"> {failed.join(" ")}</span>}
        </b>
        {checking && (
          <button className="link" data-conn="cancel" onClick={onCancel}>
            {t("common.cancel")}
          </button>
        )}
      </div>
      {!cancelled &&
        lines.map(({ p, v }) => (
          <PartLine key={p} part={p} view={v} stale={stale[p]} form={form} name={name(p)} note={p === "smtp" && !stale.smtp && smtpSharedNote(block, form)} onShowField={onShowField} onFix={onFix} />
        ))}
      {hasReport && !checking && !cancelled && (
        <details className="advanced conn-details" data-conn="details" open={open ?? auto} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
          <summary>{t("settings.test.details")}</summary>
          <pre className="conn-details-text" data-conn="details-text">{copyText}</pre>
          <button className="btn small" data-conn="copy" onClick={copy}>
            {t("common.copy")}
          </button>
        </details>
      )}
    </div>
  );
}

function describeText(part: PartName, v: PartView, form: ConnForm): string {
  if (!v.report) return "";
  const l = describe(part, v.report, form);
  return [l.msg, ...l.hints].map(say).join(" ");
}

function PartLine({ part, view, stale, form, name, note, onShowField, onFix }: { part: PartName; view: PartView; stale: boolean; form: ConnForm; name: string; note: boolean; onShowField: (id: FieldId) => void; onFix: (fix: Fix) => void }) {
  const t = useT();
  const r = view.report;
  const kind = view.state === "checking" ? "checking" : view.state === "notChecked" ? "notChecked" : stale ? "stale" : r?.status === "ok" ? "ok" : r?.status === "warn" ? "warn" : "error";
  const icon =
    kind === "checking" ? <span className="spin" aria-hidden="true" />
    : kind === "ok" ? <Check size={14} aria-hidden="true" className="conn-ic good" />
    : kind === "warn" ? <TriangleAlert size={14} aria-hidden="true" className="conn-ic warn" />
    : kind === "error" ? <X size={14} aria-hidden="true" className="conn-ic bad" />
    : null;
  let text: string;
  let actions: React.ReactNode = null;
  if (kind === "checking") text = t("settings.test.checking");
  else if (kind === "notChecked") text = t("settings.test.notChecked");
  else if (kind === "stale") text = t("settings.test.stale");
  else if (r && kind === "ok") text = say(okMsg(part, r));
  else if (r) {
    const l = describe(part, r, form);
    text = [l.msg, ...l.hints].map(say).join(" ");
    if (note) text += ` ${t("settings.test.smtpSharedNote")}`;
    const field = l.field;
    actions = (
      <>
        {field && (
          <button className="link" data-conn="show-field" aria-label={t("settings.test.showFieldNamed", { field: t(FIELD_LABEL[field] as Key) })} onClick={() => onShowField(field)}>
            {t("settings.test.showField")}
          </button>
        )}
        {l.fixes.map((fix) => (
          <button key={fix.id + ("part" in fix ? fix.part : "")} className="btn small" data-conn={`fix-${fix.id}`} onClick={() => onFix(fix)}>
            {say(fixMsg(fix))}
          </button>
        ))}
      </>
    );
  } else text = "";
  return (
    <div className={`conn-part ${kind}`} data-part={part} data-state={kind} data-kind={r?.kind ?? ""}>
      <div className="conn-line">
        {icon}
        <b className="conn-name">{name}</b>
        <span className="conn-text" data-conn="text">{text}</span>
      </div>
      {actions && <div className="conn-actions">{actions}</div>}
    </div>
  );
}
