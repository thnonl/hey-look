import { AlertTriangle, Download, Loader, RotateCw } from "lucide-react";
import { pct, useUpdates } from "../updates";

/** The update in the top bar: shows download progress and "Restart to update"; a click opens Settings > About. */
export function UpdateChip() {
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
      label = p == null ? "Downloading…" : `${p}%`;
      name = p == null ? `Update: downloading Hey Look! ${v}` : `Update: downloading Hey Look! ${v}, ${p}%`;
      bar = p == null ? "indet" : p;
      break;
    case "verifying":
      label = "Verifying…";
      name = "Update: verifying";
      bar = "indet";
      break;
    case "installing":
      label = "Installing…";
      name = "Update: installing";
      icon = <Loader size={13} className="spin" aria-hidden />;
      break;
    case "failed":
      label = "Update failed";
      name = "Update failed: open details";
      icon = <AlertTriangle size={13} aria-hidden />;
      break;
    default:
      label = "Restart to update";
      name = `Update ready: restart to update to ${v}`;
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
