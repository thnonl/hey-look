import { Globe, Lock, Mail, ShieldCheck, Zap } from "lucide-react";
import logo from "../assets/logo.png";
import { useStore } from "../store";

/** First-run screen: shown while there is no account yet. */
export function Welcome() {
  const setDialog = useStore((s) => s.setDialog);
  return (
    <main className="welcome">
      <div className="welcome-card">
        <img src={logo} alt="" width={72} height={72} />
        <h1>Welcome to Hey Look!</h1>
        <p className="muted">A fast, private mail client. Connect an account to get started — everything is unlocked, no plans and no limits.</p>
        <div className="welcome-actions">
          <button className="wcard primary" onClick={() => setDialog({ type: "settings", tab: "add-account" })}>
            <Globe size={22} />
            <span>
              <b>Sign in with Google</b>
              <small>Gmail and Google Workspace, no password stored</small>
            </span>
          </button>
          <button className="wcard" onClick={() => setDialog({ type: "settings", tab: "add-account" })}>
            <Mail size={22} />
            <span>
              <b>Other email account</b>
              <small>Outlook, iCloud, Yahoo or any IMAP / SMTP server</small>
            </span>
          </button>
        </div>
        <ul className="welcome-points">
          <li><Lock size={14} /> Passwords stay in Windows Credential Manager</li>
          <li><ShieldCheck size={14} /> Remote images and trackers are blocked by default</li>
          <li><Zap size={14} /> Keeps checking mail from the tray, with Undo for every move</li>
        </ul>
      </div>
    </main>
  );
}
