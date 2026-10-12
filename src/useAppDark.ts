import { useEffect, useState } from "react";
import { useStore } from "./store";

/** True while the app shows its dark theme (setting, or "system" with the OS in dark mode - follows the OS live). */
export function useAppDark(): boolean {
  const theme = useStore((s) => s.prefs.theme);
  const [os, setOs] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => setOs(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return theme === "dark" || (theme === "system" && os);
}
