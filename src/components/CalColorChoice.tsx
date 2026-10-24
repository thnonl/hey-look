import { useT } from "../i18n/react";
import { ACCOUNT_PALETTE } from "../prefs";

/**
 * The colour of a synced calendar (W7.5, D-7.5b): the service's own colour (`null`), one of the mailbox swatches, or a colour of the person's own. A radio group; the choice is a setting of Hey Look!, nothing is
 * sent to the service. Used by Settings > Calendar and the New calendar dialog.
 */
export function CalColorChoice({ value, label, service, onChange }: { value: string | null; label: string; service: string; onChange: (hex: string | null) => void }) {
  const t = useT();
  const now = value?.toLowerCase() ?? null;
  return (
    <div className="accents cal-colors" role="radiogroup" aria-label={label}>
      <button type="button" role="radio" aria-checked={now === null} className={`btn small ${now === null ? "primary" : ""}`} onClick={() => onChange(null)}>
        {t("settings.calendar.colorDefault", { service })}
      </button>
      {ACCOUNT_PALETTE.map((hex) => (
        <button type="button" key={hex} role="radio" aria-checked={now === hex.toLowerCase()} aria-label={hex} title={hex} className={`swatch small ${now === hex.toLowerCase() ? "on" : ""}`} style={{ background: hex }} onClick={() => onChange(hex)} />
      ))}
      <label className="swatch-custom">
        <input type="color" aria-label={t("settings.profile.customColor")} value={now ?? "#4f46e5"} onChange={(e) => onChange(e.target.value)} />
      </label>
    </div>
  );
}
