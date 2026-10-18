import { useEffect, useState } from "react";
import type { SidebarInput } from "./sidebarState";
import { useStore } from "./store";

/** The window width, kept up to date on resize (once per frame). The panes fill the window, so this is the width the layout has. */
export function useWindowWidth(): number {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    let raf = 0;
    const on = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setW(window.innerWidth));
    };
    on();
    window.addEventListener("resize", on);
    return () => {
      window.removeEventListener("resize", on);
      cancelAnimationFrame(raf);
    };
  }, []);
  return w;
}

/** What the layout is made from right now (the saved widths, not a drag in progress). */
export function sidebarInput(): SidebarInput {
  const p = useStore.getState().prefs;
  return { mode: p.sidebar, width: window.innerWidth, folderW: p.folderW, listW: p.listW, bottomPane: p.readingPane === "bottom" };
}

/**
 * Ctrl+B / Cmd+B: asks the side menu to do what its button does. The menu knows whether its overlay is open (sidebarPeek.ts), so it answers the request
 * (FolderPane.tsx); the rule is `toggleSidebar` in sidebarState.ts.
 */
export function toggleSidebarNow() {
  useStore.setState((s) => ({ sidebarToggle: s.sidebarToggle + 1 }));
}
