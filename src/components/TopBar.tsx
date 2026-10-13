import { Moon, RefreshCw, Settings, Sun } from "lucide-react";
import type { MouseEvent } from "react";
import logo from "../assets/logo.png";
import { api } from "../api";
import { useStore } from "../store";
import { pendingVersion, useUpdates } from "../updates";
import { useAppDark } from "../useAppDark";
import { hasMailAccounts } from "../mailControls";
import { useFrame } from "../winframe";
import { SearchBox } from "./SearchBox";
import { UpdateChip } from "./UpdateChip";
import { WindowControls } from "./WindowControls";

export function TopBar() {
  const { sync, syncing, firstSync, setDialog, setPrefs } = useStore();
  const openSettingsAbout = useUpdates((s) => s.openSettingsAbout);
  const skipped = useStore((s) => s.prefs.skippedUpdate);
  const newVersion = useUpdates((s) => pendingVersion(s.update, skipped));
  const dark = useAppDark();
  // no account: only the Welcome screen is shown, so no search box and no sync button
  const mail = useStore((st) => hasMailAccounts(st.accounts.length));

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
      {mail ? <SearchBox /> : <div className="top-spacer" />}
      <div className="top-actions" data-tauri-drag-region="false">
        <UpdateChip />
        {mail && (
          <button className="icon-btn" title="Sync now (F5)" onClick={() => void sync()}>
            <RefreshCw size={16} className={syncing || firstSync ? "spin" : ""} />
          </button>
        )}
        <button className="icon-btn" title={dark ? "Light mode" : "Dark mode"} onClick={() => setPrefs({ theme: dark ? "light" : "dark" })}>
          {dark ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <button
          className={`icon-btn${newVersion ? " has-dot" : ""}`}
          title={newVersion ? `Settings — Hey Look! ${newVersion} is available` : "Settings"}
          aria-label={newVersion ? "Settings (update available)" : "Settings"}
          onClick={() => (newVersion ? openSettingsAbout(false) : setDialog({ type: "settings" }))}
        >
          <Settings size={16} />
        </button>
      </div>
      <WindowControls />
    </header>
  );
}
