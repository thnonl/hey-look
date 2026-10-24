import { useEffect, useState } from "react";
import { onOsDarkChange, osDark } from "./osTheme";
import { useStore } from "./store";

/** True while the OS is dark: the engine's media query, or on Linux what the backend resolved (osTheme.ts); follows it live. */
function useOsDark(): boolean {
  const [os, setOs] = useState(osDark);
  useEffect(() => {
    const on = () => setOs(osDark());
    on();
    return onOsDarkChange(on);
  }, []);
  return os;
}

/** True while the app shows its dark theme (setting, or "system" with the OS in dark mode - follows the OS live). */
export function useAppDark(): boolean {
  const theme = useStore((s) => s.prefs.theme);
  const os = useOsDark();
  return theme === "dark" || (theme === "system" && os);
}
