import { ArrowDown } from "lucide-react";
import { useT } from "../i18n/react";
import { Importance, pressImportance, shownImportance } from "../importance";

/** Outlook's red exclamation mark (lucide has no bare one). */
export function HighIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3.2} strokeLinecap="round" aria-hidden="true">
      <path d="M12 3.5v11" />
      <path d="M12 20.5h.01" />
    </svg>
  );
}

/** The mark of a High / Low message: red "!" or blue down arrow. Nothing for Normal. With `label` the words follow the icon. */
export function ImportanceMark({ level, size = 12, label = false }: { level: Importance | null | undefined; size?: number; label?: boolean }) {
  const t = useT();
  const shown = shownImportance(level);
  if (!shown) return null;
  const text = t(shown === "high" ? "mail.importance.high" : "mail.importance.low");
  return (
    <span className={`imp imp-${shown} ${label ? "imp-label" : ""}`} role="img" aria-label={text} title={text}>
      {shown === "high" ? <HighIcon size={size} /> : <ArrowDown size={size} strokeWidth={2.6} aria-hidden />}
      {label && <span className="imp-text" aria-hidden="true">{text}</span>}
    </span>
  );
}

/** Compose toolbar: Outlook's two toggle buttons. Pressing the one that is on goes back to Normal. */
export function ImportanceButtons({ value, onChange }: { value: Importance; onChange: (v: Importance) => void }) {
  const t = useT();
  const btn = (kind: "high" | "low") => {
    const on = value === kind;
    const name = t(kind === "high" ? "mail.importance.high" : "mail.importance.low");
    const tip = t(kind === "high" ? (on ? "compose.bar.importanceHighOnTip" : "compose.bar.importanceHighOffTip") : on ? "compose.bar.importanceLowOnTip" : "compose.bar.importanceLowOffTip");
    return (
      <button
        key={kind}
        type="button"
        className={`rb imp-btn ${kind} ${on ? "on" : ""}`}
        aria-pressed={on}
        aria-label={name}
        title={tip}
        onClick={() => onChange(pressImportance(value, kind))}
      >
        {kind === "high" ? <HighIcon size={15} /> : <ArrowDown size={15} strokeWidth={2.4} aria-hidden />}
      </button>
    );
  };
  return (
    <div className="imp-group" role="group" aria-label={t("compose.bar.importance")}>
      {btn("high")}
      {btn("low")}
    </div>
  );
}
