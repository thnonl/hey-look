import { ChevronRight, Lock, Mail, ShieldCheck, Zap } from "lucide-react";
import { ReactNode } from "react";
import logo from "../assets/logo.png";
import { credStore } from "../platform";
import { useStore } from "../store";

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
  const setDialog = useStore((s) => s.setDialog);
  const add = () => setDialog({ type: "settings", tab: "add-account" });
  return (
    <main className="welcome">
      <div className="welcome-card">
        <img src={logo} alt="" width={64} height={64} />
        <h1>Welcome to Hey Look!</h1>
        <p className="muted">A fast, private mail client. Connect an account to get started — everything is unlocked, no plans and no limits.</p>
        <div className="welcome-actions">
          <Choice icon={<GoogleMark />} tone="g" title="Sign in with Google" text="Gmail and Google Workspace, no password stored" onClick={add} />
          <Choice icon={<MicrosoftMark />} tone="m" title="Sign in with Microsoft" text="Outlook.com, Hotmail and Microsoft 365, no password stored" onClick={add} />
          <Choice icon={<Mail size={20} />} tone="o" title="Other email account" text="iCloud (app password), Yahoo or any IMAP / SMTP server" onClick={add} />
        </div>
        <ul className="welcome-points">
          <li><Lock size={14} /> Passwords stay in {credStore()}</li>
          <li><ShieldCheck size={14} /> Remote images and trackers are blocked by default</li>
          <li><Zap size={14} /> Keeps checking mail from the tray, with Undo for every move</li>
        </ul>
      </div>
    </main>
  );
}
