import { Moon, Sun } from "lucide-react";
import { useT } from "../i18n/react";
import type { PreviewBg } from "../composePreview";
import type { Rove } from "./controls";

/**
 * "Preview as recipient" (F-23): a pair of toggle buttons at the end of the formatting toolbar. They are part of its roving focus (one Tab stop for the
 * whole toolbar, the arrow keys reach them, Tab goes on to the text: spec-rich-text.md AC-18). The mouse does not take the focus from the editor, so
 * the caret and the selection stay.
 */
export function PreviewSwitch({ pv, onChoose, rove }: { pv: PreviewBg; onChoose: (p: PreviewBg) => void; rove: (id: string) => Rove }) {
  const t = useT();
  return (
    <div className="pv-switch" role="group" aria-label={t("compose.preview.label")}>
      <span className="pv-label" aria-hidden="true">{t("compose.preview.label")}</span>
      <div className="seg pv-seg">
        <button type="button" {...rove("pv:light")} className={pv === "light" ? "on" : ""} aria-pressed={pv === "light"} title={t("compose.preview.lightTip")} aria-label={t("compose.preview.lightTip")} onMouseDown={(e) => e.preventDefault()} onClick={() => onChoose("light")}>
          <Sun size={13} aria-hidden /><span className="pv-txt">{t("app.ribbon.themeLight")}</span>
        </button>
        <button type="button" {...rove("pv:dark")} className={pv === "dark" ? "on" : ""} aria-pressed={pv === "dark"} title={t("compose.preview.darkTip")} aria-label={t("compose.preview.darkTip")} onMouseDown={(e) => e.preventDefault()} onClick={() => onChoose("dark")}>
          <Moon size={13} aria-hidden /><span className="pv-txt">{t("app.ribbon.themeDark")}</span>
        </button>
      </div>
    </div>
  );
}
