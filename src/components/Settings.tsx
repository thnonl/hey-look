import { Plus, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Account, api, PROVIDERS, Signature, Template } from "../api";
import { useStore } from "../store";

type Tab = "accounts" | "signatures" | "templates" | "ai" | "general";

function AccountsTab() {
  const { accounts, showToast } = useStore();
  const [provider, setProvider] = useState("gmail");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [pw, setPw] = useState("");
  const [adv, setAdv] = useState(PROVIDERS.gmail);
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);

  const pick = (p: string) => {
    setProvider(p);
    setAdv(PROVIDERS[p]);
  };

  const add = async () => {
    setBusy(true);
    try {
      const acc = await api.addAccount(
        {
          email,
          displayName: name,
          imapHost: adv.imapHost,
          imapPort: adv.imapPort,
          imapSsl: adv.imapPort === 993,
          smtpHost: adv.smtpHost,
          smtpPort: adv.smtpPort,
          smtpSecurity: adv.smtpSecurity,
          username: username || email,
        },
        pw,
      );
      useStore.setState((s) => ({ accounts: [...s.accounts, acc] }));
      setEmail("");
      setPw("");
      setName("");
      showToast(`Added ${acc.email}. Syncing…`);
      void useStore.getState().sync();
    } catch (e) {
      showToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a: Account) => {
    if (!confirm(`Remove ${a.email}? Local cache is deleted; mail stays on the server.`)) return;
    await api.removeAccount(a.id);
    useStore.setState((s) => ({ accounts: s.accounts.filter((x) => x.id !== a.id) }));
    await useStore.getState().refresh();
  };

  return (
    <div>
      <h3>Accounts</h3>
      {accounts.map((a) => (
        <div key={a.id} className="list-row">
          <span>{a.email}</span>
          <span className="muted small">{a.imapHost}</span>
          <button className="icon-btn" onClick={() => remove(a)}><Trash2 size={15} /></button>
        </div>
      ))}
      <h3>Add account</h3>
      <div className="form">
        <label>Provider</label>
        <select value={provider} onChange={(e) => pick(e.target.value)}>
          {Object.entries(PROVIDERS).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>
        {PROVIDERS[provider].hint && <div className="muted small">{PROVIDERS[provider].hint}</div>}
        <label>Email</label>
        <input value={email} onChange={(e) => setEmail(e.target.value)} />
        <label>Display name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} />
        <label>Password / app password</label>
        <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
        {provider === "custom" && (
          <>
            <label>Username (if different from email)</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} />
            <label>IMAP host / port</label>
            <div className="row-inline">
              <input value={adv.imapHost} onChange={(e) => setAdv({ ...adv, imapHost: e.target.value })} />
              <input type="number" value={adv.imapPort} onChange={(e) => setAdv({ ...adv, imapPort: Number(e.target.value) })} />
            </div>
            <label>SMTP host / port / security</label>
            <div className="row-inline">
              <input value={adv.smtpHost} onChange={(e) => setAdv({ ...adv, smtpHost: e.target.value })} />
              <input type="number" value={adv.smtpPort} onChange={(e) => setAdv({ ...adv, smtpPort: Number(e.target.value) })} />
              <select value={adv.smtpSecurity} onChange={(e) => setAdv({ ...adv, smtpSecurity: e.target.value as "ssl" | "starttls" })}>
                <option value="ssl">SSL/TLS</option>
                <option value="starttls">STARTTLS</option>
              </select>
            </div>
          </>
        )}
        <button className="btn primary" disabled={busy || !email || !pw} onClick={add}>
          <Plus size={14} /> {busy ? "Connecting…" : "Add account"}
        </button>
        <div className="muted small">Password is stored in the Windows Credential Manager, never in the database.</div>
      </div>
    </div>
  );
}

function SignaturesTab() {
  const [list, setList] = useState<Signature[]>([]);
  const [cur, setCur] = useState<Signature | null>(null);
  const load = () => api.listSignatures().then(setList);
  useEffect(() => void load(), []);
  return (
    <div>
      <h3>Signatures</h3>
      {list.map((s) => (
        <div key={s.id} className="list-row" onClick={() => setCur(s)}>
          <span>{s.name}{s.isDefault && " (default)"}</span>
          <button className="icon-btn" onClick={async (e) => { e.stopPropagation(); await api.deleteSignature(s.id); load(); }}><Trash2 size={15} /></button>
        </div>
      ))}
      <button className="btn" onClick={() => setCur({ id: crypto.randomUUID(), name: "New signature", html: "", isDefault: list.length === 0 })}>
        <Plus size={14} /> New
      </button>
      {cur && (
        <div className="form">
          <label>Name</label>
          <input value={cur.name} onChange={(e) => setCur({ ...cur, name: e.target.value })} />
          <label>HTML</label>
          <textarea rows={6} value={cur.html} onChange={(e) => setCur({ ...cur, html: e.target.value })} />
          <label><input type="checkbox" checked={cur.isDefault} onChange={(e) => setCur({ ...cur, isDefault: e.target.checked })} /> Default</label>
          <button className="btn primary" onClick={async () => { await api.saveSignature(cur); setCur(null); load(); }}>Save</button>
        </div>
      )}
    </div>
  );
}

function TemplatesTab() {
  const [list, setList] = useState<Template[]>([]);
  const [cur, setCur] = useState<Template | null>(null);
  const load = () => api.listTemplates().then(setList);
  useEffect(() => void load(), []);
  return (
    <div>
      <h3>Templates</h3>
      {list.map((t) => (
        <div key={t.id} className="list-row" onClick={() => setCur(t)}>
          <span>{t.name}</span>
          <button className="icon-btn" onClick={async (e) => { e.stopPropagation(); await api.deleteTemplate(t.id); load(); }}><Trash2 size={15} /></button>
        </div>
      ))}
      <button className="btn" onClick={() => setCur({ id: crypto.randomUUID(), name: "New template", subject: "", body: "" })}>
        <Plus size={14} /> New
      </button>
      {cur && (
        <div className="form">
          <label>Name</label>
          <input value={cur.name} onChange={(e) => setCur({ ...cur, name: e.target.value })} />
          <label>Subject (optional)</label>
          <input value={cur.subject} onChange={(e) => setCur({ ...cur, subject: e.target.value })} />
          <label>Body (HTML)</label>
          <textarea rows={8} value={cur.body} onChange={(e) => setCur({ ...cur, body: e.target.value })} />
          <button className="btn primary" onClick={async () => { await api.saveTemplate(cur); setCur(null); load(); }}>Save</button>
        </div>
      )}
    </div>
  );
}

function AiTab() {
  const [v, setV] = useState({ ai_endpoint: "", ai_key: "", ai_model: "" });
  const showToast = useStore((s) => s.showToast);
  useEffect(() => {
    void Promise.all(["ai_endpoint", "ai_key", "ai_model"].map((k) => api.getSetting(k))).then(([a, b, c]) =>
      setV({ ai_endpoint: a ?? "", ai_key: b ?? "", ai_model: c ?? "" }),
    );
  }, []);
  const save = async () => {
    await Promise.all(Object.entries(v).map(([k, val]) => api.setSetting(k, val)));
    showToast("AI settings saved");
  };
  return (
    <div>
      <h3>AI Copilot</h3>
      <div className="muted small">Any OpenAI-compatible endpoint (OpenAI, a local server, a gateway). Used for Summarize and Let AI write.</div>
      <div className="form">
        <label>Base URL (ending in /v1)</label>
        <input placeholder="https://api.openai.com/v1" value={v.ai_endpoint} onChange={(e) => setV({ ...v, ai_endpoint: e.target.value })} />
        <label>API key</label>
        <input type="password" value={v.ai_key} onChange={(e) => setV({ ...v, ai_key: e.target.value })} />
        <label>Model</label>
        <input value={v.ai_model} onChange={(e) => setV({ ...v, ai_model: e.target.value })} />
        <button className="btn primary" onClick={save}>Save</button>
      </div>
    </div>
  );
}

function GeneralTab() {
  const { theme, setTheme, undoSeconds, loadRemote, setPref } = useStore();
  return (
    <div>
      <h3>General</h3>
      <div className="form">
        <label>Theme</label>
        <select value={theme} onChange={(e) => setTheme(e.target.value as typeof theme)}>
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
        <label>Undo send window (seconds, 0 = off)</label>
        <input type="number" min={0} max={60} value={undoSeconds} onChange={(e) => setPref("undoSeconds", Number(e.target.value))} />
        <label>
          <input type="checkbox" checked={loadRemote} onChange={(e) => setPref("loadRemote", e.target.checked)} /> Always load remote images
          (allows senders to track opens)
        </label>
      </div>
      <h3>Keyboard shortcuts</h3>
      <div className="muted small pre">{`c compose   / search   j/k next/prev   e archive   # trash   ! junk
s snooze   p pin   * star   u mark unread   r reply   a reply all   f forward
Ctrl+K command bar   F5 sync   Esc close`}</div>
    </div>
  );
}

export function Settings() {
  const { setSettingsOpen, accounts } = useStore();
  const [tab, setTab] = useState<Tab>("accounts");
  const tabs: [Tab, string][] = [["accounts", "Accounts"], ["signatures", "Signatures"], ["templates", "Templates"], ["ai", "AI"], ["general", "General"]];
  return (
    <div className="modal-back" onClick={() => accounts.length && setSettingsOpen(false)}>
      <div className="modal settings" onClick={(e) => e.stopPropagation()}>
        <div className="settings-nav">
          {tabs.map(([k, l]) => (
            <button key={k} className={`side-item ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
        <div className="settings-body">
          <button className="icon-btn close" onClick={() => setSettingsOpen(false)}><X size={16} /></button>
          {tab === "accounts" && <AccountsTab />}
          {tab === "signatures" && <SignaturesTab />}
          {tab === "templates" && <TemplatesTab />}
          {tab === "ai" && <AiTab />}
          {tab === "general" && <GeneralTab />}
        </div>
      </div>
    </div>
  );
}
