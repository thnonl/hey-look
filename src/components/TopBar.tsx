import { Moon, RefreshCw, Settings, Sun } from "lucide-react";
import type { MouseEvent } from "react";
import logo from "../assets/logo.png";
import { api } from "../api";
import { useStore } from "../store";
import { useAppDark } from "../useAppDark";
import { useFrame } from "../winframe";
import { SearchBox } from "./SearchBox";
import { WindowControls } from "./WindowControls";

export function TopBar() {
  const { sync, syncing, setDialog, setPrefs } = useStore();
  const dark = useAppDark();

  const custom = useFrame((f) => f.custom);

  // On Windows this bar is the title bar: empty space drags the window (native Aero Snap), double-click maximizes
  // (both from data-tauri-drag-region) and right-click shows the system menu. Controls opt out with "false".
  const systemMenu = (e: MouseEvent) => {
    if ((e.target as Element).closest('[data-tauri-drag-region="false"]')) return;
    e.preventDefault();
    void api.frameSystemMenu(e.clientX, e.clientY).catch(() => undefined);
  };

  return (
    <header className="topbar" data-tauri-drag-region={custom ? "deep" : undefined} onContextMenu={custom ? systemMenu : undefined}>
      <div className="brand">
        <img src={logo} alt="" width={26} height={26} draggable={false} />
        <span>Hey Look!</span>
      </div>
      <SearchBox />
      <div className="top-actions" data-tauri-drag-region="false">
        <button className="icon-btn" title="Sync now (F5)" onClick={() => void sync()}>
          <RefreshCw size={16} className={syncing ? "spin" : ""} />
        </button>
        <button className="icon-btn" title={dark ? "Light mode" : "Dark mode"} onClick={() => setPrefs({ theme: dark ? "light" : "dark" })}>
          {dark ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <button className="icon-btn" title="Settings" onClick={() => setDialog({ type: "settings" })}>
          <Settings size={16} />
        </button>
      </div>
      <WindowControls />
    </header>
  );
}
