import { Moon, RefreshCw, Settings, Sun } from "lucide-react";
import logo from "../assets/logo.png";
import { useStore } from "../store";
import { SearchBox } from "./SearchBox";

export function TopBar() {
  const { sync, syncing, setDialog, prefs, setPrefs } = useStore();
  const dark = prefs.theme === "dark" || (prefs.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);

  return (
    <header className="topbar">
      <div className="brand">
        <img src={logo} alt="" width={26} height={26} />
        <span>Hey Look!</span>
      </div>
      <SearchBox />
      <div className="top-actions">
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
    </header>
  );
}
