import { useEffect, useState } from "react";
import { useT } from "../i18n/react";
import { progressValue, type PicProgress } from "../pictureProgress";

const SHOW_AFTER_MS = 300; // (a mail whose pictures come faster than this shows no bar at all)
const FADE_MS = 350; // (the fill to 100 % and the fade, see .pic-bar in App.css)

/** The one thin bar at the top of the message body while its pictures load: determinate, shown only when the loading lasts, full and gone when the last picture is in. */
export function PictureBar({ progress }: { progress: PicProgress }) {
  const t = useT();
  const [phase, setPhase] = useState<"hidden" | "on" | "fading">("hidden");
  const active = progress.pending > 0;
  useEffect(() => {
    if (active) {
      if (phase === "on") return;
      if (phase === "fading") return setPhase("on"); // (a new round started while the bar faded)
      const id = setTimeout(() => setPhase("on"), SHOW_AFTER_MS);
      return () => clearTimeout(id);
    }
    if (phase === "on") return setPhase("fading");
    if (phase === "fading") {
      const id = setTimeout(() => setPhase("hidden"), FADE_MS);
      return () => clearTimeout(id);
    }
  }, [active, progress.cycle, phase]);
  if (phase === "hidden") return null;
  const done = progress.peak - progress.pending;
  return (
    <div className="pic-bar" data-fade={phase === "fading" ? "1" : undefined} role="progressbar" aria-label={t("reading.pic.showing")} aria-valuemin={0} aria-valuemax={progress.peak} aria-valuenow={done}>
      <i style={{ width: `${Math.round(progressValue(progress) * 100)}%` }} />
    </div>
  );
}
