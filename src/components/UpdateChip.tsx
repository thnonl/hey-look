import { AlertTriangle, Download, Loader, RotateCw } from "lucide-react";
import { useT } from "../i18n/react";
import { pct, useUpdates } from "../updates";

/** The update in the top bar: shows download progress and "Restart to update"; a click opens Settings > About. */
export function UpdateChip() {
  const t = useT();
  const flow = useUpdates((s) => s.flow);
  const openAbout = useUpdates((s) => s.openSettingsAbout);
  if (flow.state === "idle") return null;
  const v = flow.version ?? "";
  const p = pct(flow);
  let label: string;
  let name: string;
  let icon = <Download size={13} aria-hidden />;
  let bar: number | "indet" | null = null;
  switch (flow.state) {
    case "downloading":
      label = p == null ? t("updates.chip.downloading") : t("updates.chip.percent", { percent: p });
      name = p == null ? t("updates.chip.nameDownloading", { version: v }) : t("updates.chip.nameDownloadingPercent", { version: v, percent: p });
      bar = p == null ? "indet" : p;
      break;
    case "verifying":
      label = t("updates.chip.verifying");
      name = t("updates.chip.nameVerifying");
      bar = "indet";
      break;
    case "installing":
      label = t("updates.chip.installing");
      name = t("updates.chip.nameInstalling");
      icon = <Loader size={13} className="spin" aria-hidden />;
      break;
    case "failed":
      label = t("updates.chip.failed");
      name = t("updates.chip.nameFailed");
      icon = <AlertTriangle size={13} aria-hidden />;
      break;
    default:
      label = t("updates.chip.restart");
      name = t("updates.chip.nameReady", { version: v });
      icon = <RotateCw size={13} aria-hidden />;
  }
  return (
    <button className="update-chip" title={name} aria-label={name} onClick={() => openAbout(false)}>
      {icon}
      <span>{label}</span>
      {bar !== null && (
        <span className={`progress${bar === "indet" ? " indet" : ""}`} aria-hidden>
          <i style={bar === "indet" ? undefined : { width: `${bar}%` }} />
        </span>
      )}
    </button>
  );
}
