import { useEffect, useState } from "react";
import { SidebarInput, toggleSidebar as nextToggle } from "./sidebarState";
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

/** The collapse / expand control (button and Ctrl+B): the choice is saved, so it is the person's own from now on. */
export function toggleSidebarNow() {
  const st = useStore.getState();
  const r = nextToggle(sidebarInput());
  if (r.mode !== st.prefs.sidebar) st.setPrefs({ sidebar: r.mode });
  if (r.pin) useStore.setState((s) => ({ sidebarPin: s.sidebarPin + 1 }));
}
