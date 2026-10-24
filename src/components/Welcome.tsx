import { ChevronRight, Lock, Mail, ShieldCheck, Zap } from "lucide-react";
import { ReactNode } from "react";
import logo from "../assets/logo.png";
import { credStore, osNow, usePlatform } from "../platform";
import { welcomeKeepKey } from "../trayWords";
import { useT } from "../i18n/react";
import { useStore } from "../store";
import { LanguageChoice } from "./LanguageSwitcher";

/** Generic provider marks (a letter badge and a four-square mark): neutral glyphs, not the providers' own logos. */
const GoogleMark = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
    <text x="12" y="18.2" textAnchor="middle" fontSize="19" fontWeight="700" fontFamily="Segoe UI, Arial, sans-serif" fill="#4a7fe0">G</text>
  </svg>
);
const MicrosoftMark = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
    <rect x="3" y="3" width="8.4" height="8.4" rx="1" fill="#e5603b" />
    <rect x="12.6" y="3" width="8.4" height="8.4" rx="1" fill="#6dae2f" />
    <rect x="3" y="12.6" width="8.4" height="8.4" rx="1" fill="#2f9be0" />
    <rect x="12.6" y="12.6" width="8.4" height="8.4" rx="1" fill="#f3b61f" />
  </svg>
);

function Choice({ icon, tone, title, text, onClick }: { icon: ReactNode; tone: string; title: string; text: string; onClick: () => void }) {
  return (
    <button className="wcard" onClick={onClick}>
      <span className={`wglyph ${tone}`} aria-hidden>{icon}</span>
      <span className="wtext">
        <b>{title}</b>
        <small>{text}</small>
      </span>
      <ChevronRight size={18} className="wgo" aria-hidden />
    </button>
  );
}

/** First-run screen: shown while there is no account yet. */
export function Welcome() {
  const t = useT();
  const setDialog = useStore((s) => s.setDialog);
  const add = () => setDialog({ type: "settings", tab: "add-account" });
  const tray = usePlatform((s) => s.tray);
  return (
    <main className="welcome">
      <div className="welcome-card">
        <LanguageChoice />
        <img src={logo} alt="" width={64} height={64} />
        <h1>{t("app.welcome.title")}</h1>
        <p className="muted">{t("app.welcome.intro")}</p>
        <div className="welcome-actions">
          <Choice icon={<GoogleMark />} tone="g" title={t("app.welcome.google.title")} text={t("app.welcome.google.text")} onClick={add} />
          <Choice icon={<MicrosoftMark />} tone="m" title={t("app.welcome.microsoft.title")} text={t("app.welcome.microsoft.text")} onClick={add} />
          <Choice icon={<Mail size={20} />} tone="o" title={t("app.welcome.other.title")} text={t("app.welcome.other.text")} onClick={add} />
        </div>
        <ul className="welcome-points">
          <li><Lock size={14} /> {t("app.welcome.point.passwords", { store: credStore() })}</li>
          <li><ShieldCheck size={14} /> {t("app.welcome.point.privacy")}</li>
          <li><Zap size={14} /> {t(welcomeKeepKey(osNow(), tray))}</li>
        </ul>
      </div>
    </main>
  );
}
