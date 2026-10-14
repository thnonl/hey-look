import { KeyRound, Lock, Plus, Trash2, Upload } from "lucide-react";
import { openUpdateLink } from "../updates";
import { ABOUT_LINKS } from "../aboutLinks";
import { Fragment, ReactNode, useEffect, useRef, useState } from "react";
import { Account, api, Discovered, PgpKey, PROVIDERS, Rule, Signature, Template } from "../api";
import { ACCENT_PRESETS, ACCOUNT_PALETTE, accountColor, DEFAULT_PREFS, eff, folderLabel, isOverridden, MAX_DOWNLOAD_PRESETS, NOTIFY_ACTIONS, NOTIFY_SOUNDS, Overridable, Prefs, staleAccountPrefs, validHex } from "../prefs";
import { friendlyError, useStore } from "../store";
import { credStore, kbd, riskyHint, usePlatform } from "../platform";
import { systemTz } from "../calendar";
import { fmtDay, fmtFpr, shortKey } from "../util";
import { AppearancePreview } from "./AppearancePreview";
import { RichEditor } from "./RichEditor";
import { UpdatesBlock } from "./Updates";
import { keyName } from "./Pgp";
import { AccountPicker, Avatar, Modal, Switch } from "./ui";

const Row = ({ label, hint, children, id }: { label: string; hint?: ReactNode; children: ReactNode; id?: string }) => {
  const ctl = useRef<HTMLDivElement>(null);
  // the label is a sibling <div>, not a <label for>: give the unnamed inputs/selects in this row the label as accessible name
  useEffect(() => {
    const els = [...(ctl.current?.querySelectorAll<HTMLInputElement>("input,select,textarea") ?? [])].filter(
      (e) => !e.getAttribute("aria-label") && !e.getAttribute("aria-labelledby") && ![...(e.labels ?? [])].some((l) => l.textContent?.trim()),
    );
    els.forEach((e, i) => e.setAttribute("aria-label", els.length > 1 ? `${label} (${i + 1})` : label));
  });
  return (
    <div className="set-row" id={id ? `set-${id}` : undefined}>
      <div className="set-lbl">
        <div>{label}</div>
        {hint && <div className="muted small">{hint}</div>}
      </div>
      <div className="set-ctl" ref={ctl}>{children}</div>
    </div>
  );
};

function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="tablist">
      {options.map(([k, l]) => (
        <button key={k} role="tab" aria-selected={value === k} className={value === k ? "on" : ""} onClick={() => onChange(k)}>
          {l}
        </button>
      ))}
    </div>
  );
}

/**
 * A setting that exists for "All accounts" and can be overridden by an account.
 * scope === null edits the "All accounts" value; scope === accountId edits that account's override.
 */
function OvRow<K extends keyof Overridable>({
  scope, k, label, hint, id, children,
}: {
  scope: string | null;
  k: K;
  label: string;
  hint?: string;
  id?: string;
  children: (value: Prefs[K], set: (v: Prefs[K]) => void) => ReactNode;
}) {
  const { prefs, setPrefs } = useStore();
  const own = isOverridden(prefs, scope, k);
  const value = eff(prefs, scope, k);
  const set = (v: Prefs[K]) =>
    scope
      ? setPrefs({ accountPrefs: { ...prefs.accountPrefs, [scope]: { ...(prefs.accountPrefs[scope] ?? {}), [k]: v } } })
      : setPrefs({ [k]: v } as Partial<Prefs>);
  const reset = () => {
    if (!scope) return;
    const rest = { ...(prefs.accountPrefs[scope] ?? {}) };
    delete rest[k];
    setPrefs({ accountPrefs: { ...prefs.accountPrefs, [scope]: rest } });
  };
  return (
    <Row label={label} hint={hint} id={id}>
      <div className="ov">
        {children(value, set)}
        {scope && (own ? (
          <button className="ov-tag own" onClick={reset} title="Go back to the All accounts value">
            Custom · Reset
          </button>
        ) : (
          <span className="ov-tag" title="Change it to override the All accounts value for this account only">Same as All accounts</span>
        ))}
      </div>
    </Row>
  );
}

const SoundSelect = ({ value, onChange }: { value: string; onChange: (v: Prefs["notifySound"]) => void }) => (
  <select value={value} onChange={(e) => onChange(e.target.value as Prefs["notifySound"])}>
    {NOTIFY_SOUNDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
  </select>
);

// ---------------------------------------------------------------- General
/** IANA zone names the browser knows (a short fallback list when it can't enumerate them). */
function zoneList(): string[] {
  try {
    const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    const list = f?.("timeZone");
    if (list?.length) return list;
  } catch {
    /* fall through */
  }
  return ["UTC", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "Asia/Ho_Chi_Minh", "Asia/Tokyo", "Australia/Sydney"];
}

function GeneralTab() {
  const { prefs, setPrefs, accounts } = useStore();
  const set = <K extends keyof Prefs>(k: K, v: Prefs[K]) => setPrefs({ [k]: v } as Partial<Prefs>);
  return (
    <div>
      <h3>General</h3>
      <div className="muted small">Settings for the whole app. Settings that can differ per mailbox are under Mailboxes.</div>
      <Row label="After archiving or deleting">
        <select value={prefs.afterAction} onChange={(e) => set("afterAction", e.target.value as Prefs["afterAction"])}>
          <option value="next">Open the next message</option>
          <option value="previous">Open the previous message</option>
          <option value="list">Go back to the list</option>
        </select>
      </Row>
      <Row label="Mark as read">
        <select value={prefs.markReadDelay} onChange={(e) => set("markReadDelay", Number(e.target.value))}>
          <option value={0}>Immediately</option>
          <option value={2}>After 2 seconds</option>
          <option value={5}>After 5 seconds</option>
          <option value={-1}>Never (manually)</option>
        </select>
      </Row>
      <Row label="Undo window for archive, delete and junk" hint="The change reaches the server after this delay, so you can take it back">
        <select value={prefs.undoActionSeconds} onChange={(e) => set("undoActionSeconds", Number(e.target.value))}>
          {[3, 6, 10, 15, 30].map((n) => <option key={n} value={n}>{n} seconds</option>)}
        </select>
      </Row>
      <Row label="Default account" hint="Used for new mail when no mailbox is selected. Inside a mailbox, new mail starts from that mailbox.">
        <AccountPicker
          value={accounts.some((a) => a.id === prefs.defaultAccount) ? prefs.defaultAccount : ""}
          accounts={accounts}
          onChange={(id) => set("defaultAccount", id)}
          label="Default account"
          none="None - use the first account"
        />
      </Row>
      <Row label="Date format">
        <select value={prefs.dateFormat} onChange={(e) => set("dateFormat", e.target.value as Prefs["dateFormat"])}>
          <option value="relative">Relative (Today, Yesterday…)</option><option value="absolute">Absolute</option>
        </select>
      </Row>
      <Row label="Time format">
        <select value={prefs.timeFormat} onChange={(e) => set("timeFormat", e.target.value as Prefs["timeFormat"])}>
          <option value="24">24-hour</option><option value="12">12-hour</option>
        </select>
      </Row>
      <h4>Calendar</h4>
      <Row label="First day of the week">
        <select value={prefs.weekStart} onChange={(e) => set("weekStart", Number(e.target.value) as Prefs["weekStart"])}>
          <option value={1}>Monday</option><option value={0}>Sunday</option><option value={6}>Saturday</option>
        </select>
      </Row>
      <Row label="Time zone" hint="Used to show event times">
        <select value={prefs.calTz} onChange={(e) => set("calTz", e.target.value)}>
          <option value="auto">Automatic ({systemTz()})</option>
          {zoneList().map((z) => <option key={z} value={z}>{z}</option>)}
        </select>
      </Row>
      <Row label="Add invitations to my calendar when they arrive" hint="Shown as “Not responded” until you answer">
        <Switch checked={prefs.autoAddInvites} onChange={(v) => set("autoAddInvites", v)} />
      </Row>
      <Row label="Event reminders" hint="Desktop notification before events start">
        <select value={prefs.eventReminderMin === null ? "" : String(prefs.eventReminderMin)} onChange={(e) => set("eventReminderMin", e.target.value === "" ? null : Number(e.target.value))}>
          <option value="">No reminder</option>
          {[0, 5, 10, 15, 30, 60].map((n) => <option key={n} value={n}>{n === 0 ? "At the start" : n === 60 ? "1 hour before" : `${n} minutes before`}</option>)}
        </select>
      </Row>
      <h4>Attachments</h4>
      <Row label="Save attachments to" hint="Used by Save and Save all">
        <div className="path-field">
          <code title={prefs.downloadDir ?? "Downloads"}>{prefs.downloadDir ?? "Downloads"}</code>
          <button
            className="btn small"
            onClick={async () => {
              const p = await api.pickFolder("Save attachments to");
              if (p) set("downloadDir", p);
            }}
          >
            Change…
          </button>
          {prefs.downloadDir && <button className="link small" onClick={() => set("downloadDir", null)}>Use Downloads</button>}
        </div>
      </Row>
      <Row label="Ask where to save each file">
        <Switch checked={prefs.askWhereToSave} onChange={(v) => set("askWhereToSave", v)} />
      </Row>
      <Row label="After saving">
        <select value={prefs.afterSave} onChange={(e) => set("afterSave", e.target.value as Prefs["afterSave"])}>
          <option value="notify">Show a notification</option>
          <option value="reveal">Show in folder</option>
          <option value="open">Open the file</option>
        </select>
      </Row>
      <Row label="Warn before opening programs and scripts" hint={riskyHint()}>
        <Switch checked={prefs.warnExecutables} onChange={(v) => set("warnExecutables", v)} />
      </Row>
      <h4>Scheduled messages</h4>
      <Row label="If a scheduled time passes while Hey Look! is closed">
        <select value={prefs.scheduledCatchUp} onChange={(e) => set("scheduledCatchUp", e.target.value as Prefs["scheduledCatchUp"])}>
          <option value="send">Send as soon as it opens</option>
          <option value="ask">Ask me first</option>
        </select>
      </Row>
      <Row label="Retry failed scheduled messages" hint="Network errors are retried 3 times, 5 minutes apart">
        <Switch checked={prefs.retryScheduled} onChange={(v) => set("retryScheduled", v)} />
      </Row>
    </div>
  );
}

// ---------------------------------------------------------------- Appearance
function Cards<T extends string>({ value, options, onChange }: { value: T; options: { key: T; label: string; art: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="cards" role="radiogroup">
      {options.map((o) => (
        <button key={o.key} role="radio" aria-checked={value === o.key} className={`card-opt ${value === o.key ? "on" : ""}`} onClick={() => onChange(o.key)}>
          <div className="card-art">{o.art}</div>
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

const Swatch = ({ dark, half }: { dark?: boolean; half?: boolean }) => (
  <svg viewBox="0 0 64 44" width="64" height="44">
    <rect width="64" height="44" rx="5" fill={dark ? "#1f1f1f" : "#fff"} stroke="#9aa" strokeWidth="1" />
    {half && <path d="M32 0h27a5 5 0 0 1 5 5v34a5 5 0 0 1-5 5H32z" fill="#1f1f1f" />}
    <rect x="6" y="7" width="14" height="30" rx="2" fill={dark ? "#333" : "#eee"} />
    <rect x="24" y="9" width="34" height="5" rx="2" fill="#0f6cbd" />
    <rect x="24" y="19" width="34" height="3" rx="1.5" fill={dark ? "#777" : "#bbb"} />
    <rect x="24" y="26" width="26" height="3" rx="1.5" fill={dark ? "#777" : "#bbb"} />
  </svg>
);
const DensityArt = ({ gap, rows }: { gap: number; rows: number }) => (
  <svg viewBox="0 0 64 44" width="64" height="44">
    <rect width="64" height="44" rx="5" fill="#fff" stroke="#9aa" />
    {Array.from({ length: rows }, (_, i) => (
      <g key={i}>
        <circle cx="10" cy={8 + i * gap} r={gap > 9 ? 3.5 : 2.5} fill="#0f6cbd" />
        <rect x="18" y={6 + i * gap} width="36" height="3" rx="1.5" fill="#999" />
        {gap > 9 && <rect x="18" y={11 + i * gap} width="28" height="2.5" rx="1.2" fill="#ccc" />}
      </g>
    ))}
  </svg>
);
const PaneArt = ({ bottom }: { bottom?: boolean }) => (
  <svg viewBox="0 0 64 44" width="64" height="44">
    <rect width="64" height="44" rx="5" fill="#fff" stroke="#9aa" />
    <rect x="4" y="4" width="10" height="36" rx="2" fill="#eee" />
    {bottom ? (
      <>
        <rect x="18" y="4" width="42" height="15" rx="2" fill="#dfe9f5" />
        <rect x="18" y="23" width="42" height="17" rx="2" fill="#0f6cbd" opacity=".85" />
      </>
    ) : (
      <>
        <rect x="18" y="4" width="18" height="36" rx="2" fill="#dfe9f5" />
        <rect x="40" y="4" width="20" height="36" rx="2" fill="#0f6cbd" opacity=".85" />
      </>
    )}
  </svg>
);

function AppearanceTab() {
  const { prefs, setPrefs } = useStore();
  return (
    <div>
      <h3>Appearance</h3>
      <div className="muted small">Changes apply immediately. The preview is generated sample mail; your real mail is not shown here.</div>
      <AppearancePreview />

      <h4>Theme</h4>
      <Cards
        value={prefs.theme}
        onChange={(v) => setPrefs({ theme: v })}
        options={[
          { key: "light", label: "Light", art: <Swatch /> },
          { key: "dark", label: "Dark", art: <Swatch dark /> },
          { key: "system", label: "System", art: <Swatch half /> },
        ]}
      />
      <h4>Primary color</h4>
      <div className="muted small">Used for buttons, selection, links and the top bar. Dark mode automatically uses a lighter shade of it.</div>
      <div className="accents" role="radiogroup" aria-label="Primary color">
        {ACCENT_PRESETS.map(([hex, name]) => (
          <button
            key={hex}
            role="radio"
            aria-checked={prefs.accent.toLowerCase() === hex}
            aria-label={name}
            title={name}
            className={`swatch ${prefs.accent.toLowerCase() === hex ? "on" : ""}`}
            style={{ background: hex }}
            onClick={() => setPrefs({ accent: hex })}
          />
        ))}
        <label className="swatch-custom">
          <input type="color" value={validHex(prefs.accent) ? prefs.accent : DEFAULT_PREFS.accent} onChange={(e) => setPrefs({ accent: e.target.value })} aria-label="Custom primary color" />
          <span className="muted small">Custom</span>
        </label>
        {prefs.accent.toLowerCase() !== DEFAULT_PREFS.accent && (
          <button className="link small" onClick={() => setPrefs({ accent: DEFAULT_PREFS.accent })}>Reset</button>
        )}
      </div>
      <h4>Density</h4>
      <Cards
        value={prefs.density}
        onChange={(v) => setPrefs({ density: v })}
        options={[
          { key: "full", label: "Full", art: <DensityArt gap={13} rows={3} /> },
          { key: "medium", label: "Medium", art: <DensityArt gap={10} rows={4} /> },
          { key: "compact", label: "Compact", art: <DensityArt gap={7} rows={5} /> },
        ]}
      />
      <h4>Reading pane</h4>
      <Cards
        value={prefs.readingPane}
        onChange={(v) => setPrefs({ readingPane: v })}
        options={[
          { key: "right", label: "Right", art: <PaneArt /> },
          { key: "bottom", label: "Bottom", art: <PaneArt bottom /> },
        ]}
      />
      <h4>Message list</h4>
      <Row label="Show message preview"><Switch checked={prefs.preview} onChange={(v) => setPrefs({ preview: v })} /></Row>
      <Row label="Show as conversations" hint="Group messages of the same thread"><Switch checked={prefs.conversations} onChange={(v) => setPrefs({ conversations: v })} /></Row>
      <Row label="Focused Inbox" hint="Newsletters and bulk mail go to the Other tab"><Switch checked={prefs.focused} onChange={(v) => setPrefs({ focused: v })} /></Row>
      <Row label="Oldest on top"><Switch checked={prefs.sortAsc} onChange={(v) => setPrefs({ sortAsc: v })} /></Row>
      <Row label="Text size">
        <select value={prefs.fontSize} onChange={(e) => setPrefs({ fontSize: Number(e.target.value) })}>
          {[12, 13, 14, 15, 16, 18].map((n) => <option key={n} value={n}>{n} px</option>)}
        </select>
      </Row>
    </div>
  );
}

// ---------------------------------------------------------------- Adding accounts
type OAuthKind = "google" | "microsoft";

const OAUTH = {
  google: {
    label: "Google",
    secretName: "google_client_secret" as const,
    idSetting: "google_client_id",
    idPlaceholder: "1234-abc.apps.googleusercontent.com",
  },
  microsoft: {
    label: "Microsoft",
    secretName: "microsoft_client_secret" as const,
    idSetting: "microsoft_client_id",
    idPlaceholder: "00000000-0000-0000-0000-000000000000",
  },
};

function OAuthBlock({ kind }: { kind: OAuthKind }) {
  const { showToast } = useStore();
  const cfg = OAUTH[kind];
  const [cid, setCid] = useState("");
  const [sec, setSec] = useState("");
  const [secSaved, setSecSaved] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [fromEnv, setFromEnv] = useState(false);
  const [tenant, setTenant] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const envCheck = kind === "google" ? api.googleEnvConfigured() : api.microsoftEnvConfigured();
    void envCheck.then(setFromEnv).catch(() => undefined);
    void api.getSetting(cfg.idSetting).then((a) => setCid(a ?? ""));
    // Microsoft is a public client: no secret to ask for. Only Google needs one.
    if (kind === "google") void api.hasSecret(cfg.secretName).then(setSecSaved).catch(() => undefined);
    if (kind === "microsoft") {
      void api.microsoftTenant().then(setTenant).catch(() => undefined);
    }
  }, [kind, cfg]);
  const go = async () => {
    setBusy(true);
    setError("");
    try {
      const acc = kind === "google"
        ? await api.googleSignIn(cid, sec, name)
        : await api.microsoftSignIn(cid, "", tenant, name);
      // closes this dialog, opens the new account's Inbox and starts its first sync
      void useStore.getState().accountAdded(acc);
    } catch (e) {
      setError(friendlyError(e)); // stay here: the message is next to the button, and in a toast
      showToast(friendlyError(e), undefined, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="set-card">
      <h4>Sign in with {cfg.label}</h4>
      <div className="muted small">No password is stored. A browser window opens for you to sign in with {cfg.label}.</div>
      <div className="form">
        {!fromEnv && !cid && <div className="muted small" role="status">Sign-in with {cfg.label} is not available in this build.</div>}
        {!fromEnv && (
          <details className="advanced">
            <summary>Advanced</summary>
            <div className="form">
              <label>Client ID</label>
              <input aria-label="Client ID" value={cid} onChange={(e) => setCid(e.target.value)} placeholder={cfg.idPlaceholder} />
              {kind === "google" && (
                <>
                  <label>Client secret</label>
                  <input aria-label="Client secret" type="password" value={sec} onChange={(e) => setSec(e.target.value)} placeholder={secSaved ? `Saved in ${credStore()}` : ""} />
                </>
              )}
            </div>
          </details>
        )}
        {kind === "microsoft" && (
          <>
            <label>Tenant (optional)</label>
            <input aria-label="Tenant (optional)" value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder="common" />
            <div className="muted small">Leave empty unless your organisation gave you a tenant ID or domain.</div>
          </>
        )}
        <label>Display name (optional)</label>
        <input aria-label="Display name (optional)" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
        {error && <div className="notice bad" role="alert">{error}</div>}
        <button className="btn primary" disabled={busy || (!fromEnv && !cid)} onClick={() => void go()}>
          {busy ? `Waiting for ${cfg.label}…` : `Sign in with ${cfg.label}`}
        </button>
      </div>
    </div>
  );
}

const SOURCE_LABEL: Record<Discovered["source"], string> = {
  "built-in": "built-in settings",
  autoconfig: "the provider's autoconfig",
  ispdb: "the Thunderbird ISPDB",
  "dns-srv": "DNS SRV records",
  mx: "the MX record",
  guess: "common host names (not verified)",
};

function ImapForm() {
  const { showToast } = useStore();
  const [provider, setProvider] = useState("custom");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [pw, setPw] = useState("");
  const startAdv = (p: string) => ({ ...PROVIDERS[p], imapSsl: PROVIDERS[p].imapSsl ?? PROVIDERS[p].imapPort === 993 });
  const [adv, setAdv] = useState(startAdv("custom"));
  const [username, setUsername] = useState("");
  const [sepSmtp, setSepSmtp] = useState(false);
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpPw, setSmtpPw] = useState("");
  const [insecure, setInsecure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [found, setFound] = useState<Discovered | null>(null);
  const [error, setError] = useState("");
  const showAdv = provider === "custom" || provider === "bridge";
  const pick = (p: string) => {
    setProvider(p);
    setAdv(startAdv(p));
    setInsecure(!!PROVIDERS[p].insecure);
    setFound(null);
  };
  const detect = async () => {
    setDetecting(true);
    setFound(null);
    try {
      const d = await api.discoverServer(email);
      if (!d) {
        showToast("No server settings found for this address. Enter them manually.", undefined, "error");
        return;
      }
      setProvider("custom");
      setAdv({
        ...PROVIDERS.custom, imapHost: d.imapHost, imapPort: d.imapPort, imapSsl: d.imapSsl,
        smtpHost: d.smtpHost, smtpPort: d.smtpPort, smtpSecurity: d.smtpSecurity,
      });
      setUsername(d.username === email.trim() ? "" : d.username);
      setInsecure(false);
      setFound(d);
    } catch (e) {
      showToast(friendlyError(e), undefined, "error");
    } finally {
      setDetecting(false);
    }
  };
  const add = async () => {
    setBusy(true);
    setError("");
    try {
      const acc = await api.addAccount(
        {
          email, displayName: name, imapHost: adv.imapHost, imapPort: adv.imapPort, imapSsl: adv.imapSsl,
          smtpHost: adv.smtpHost, smtpPort: adv.smtpPort, smtpSecurity: adv.smtpSecurity, username: username || email,
          smtpUsername: sepSmtp ? smtpUser : "", tlsInsecure: insecure,
        },
        pw,
        sepSmtp ? smtpPw : undefined,
      );
      setPw(""); setSmtpPw("");
      // closes this dialog, opens the new account's Inbox and starts its first sync
      void useStore.getState().accountAdded(acc);
    } catch (e) {
      setError(friendlyError(e)); // stay here with what was typed: the message is next to the button, and in a toast
      showToast(friendlyError(e), undefined, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="set-card">
      <h4>Other account (IMAP / SMTP)</h4>
      <div className="form">
        <label>Provider</label>
        <select aria-label="Provider" value={provider} onChange={(e) => pick(e.target.value)}>
          {Object.entries(PROVIDERS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        {PROVIDERS[provider].hint && <div className="notice">{PROVIDERS[provider].hint}</div>}
        <label>Email</label>
        <div className="row-inline">
          <input aria-label="Email" placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button className="btn" disabled={detecting || !email.includes("@")} onClick={() => void detect()} title="Look up the server settings for this address">
            {detecting ? "Detecting…" : "Detect settings"}
          </button>
        </div>
        {found && (
          <div className="notice">
            Settings found via {SOURCE_LABEL[found.source]}. {found.source === "guess" ? "Check them before adding. " : ""}
            {found.oauth && <>This provider also supports signing in without a password: use the {found.oauth === "google" ? "Google" : "Microsoft"} tab.</>}
          </div>
        )}
        <label>Display name</label>
        <input aria-label="Display name" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
        <label>Password / app password</label>
        <input aria-label="Password / app password" type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
        {showAdv && (
          <>
            <label>Username (if different from email)</label>
            <input aria-label="Username (if different from email)" placeholder="name@example.com" value={username} onChange={(e) => setUsername(e.target.value)} />
            <label>IMAP host / port / security</label>
            <div className="row-inline">
              <input aria-label="IMAP host" placeholder="imap.example.com" value={adv.imapHost} onChange={(e) => setAdv({ ...adv, imapHost: e.target.value })} />
              <input type="number" aria-label="IMAP port" placeholder="993" value={adv.imapPort} onChange={(e) => setAdv({ ...adv, imapPort: Number(e.target.value) })} />
              <select aria-label="IMAP security" value={adv.imapSsl ? "ssl" : "starttls"} onChange={(e) => setAdv({ ...adv, imapSsl: e.target.value === "ssl" })}>
                <option value="ssl">SSL/TLS</option><option value="starttls">STARTTLS</option>
              </select>
            </div>
            <label>SMTP host / port / security</label>
            <div className="row-inline">
              <input aria-label="SMTP host" placeholder="smtp.example.com" value={adv.smtpHost} onChange={(e) => setAdv({ ...adv, smtpHost: e.target.value })} />
              <input type="number" aria-label="SMTP port" placeholder="465" value={adv.smtpPort} onChange={(e) => setAdv({ ...adv, smtpPort: Number(e.target.value) })} />
              <select aria-label="SMTP security" value={adv.smtpSecurity} onChange={(e) => setAdv({ ...adv, smtpSecurity: e.target.value as "ssl" | "starttls" })}>
                <option value="ssl">SSL/TLS</option><option value="starttls">STARTTLS</option>
              </select>
            </div>
            <div className="row-inline">
              <Switch checked={sepSmtp} onChange={setSepSmtp} label="Use a different login for sending (SMTP)" />
            </div>
            {sepSmtp && (
              <>
                <label>SMTP username</label>
                <input aria-label="SMTP username" value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} placeholder={username || email} />
                <label>SMTP password (empty = same as above)</label>
                <input aria-label="SMTP password" type="password" value={smtpPw} onChange={(e) => setSmtpPw(e.target.value)} />
              </>
            )}
            <div className="row-inline">
              <Switch checked={insecure} onChange={setInsecure} label="Trust this server's certificate (self-signed or private CA)" />
            </div>
            {insecure && (
              <div className="notice">
                The certificate is not checked, so anyone on the network path could impersonate this server. Use this only for servers on
                this computer or your own network.
              </div>
            )}
          </>
        )}
        {error && <div className="notice bad" role="alert">{error}</div>}
        <button className="btn primary" disabled={busy || !email || !pw} onClick={() => void add()}>
          <Plus size={14} /> {busy ? "Connecting…" : "Add account"}
        </button>
        <div className="muted small">Passwords are stored in {credStore()}, never in the database.</div>
      </div>
    </div>
  );
}

function AddAccountTab() {
  const [kind, setKind] = useState<OAuthKind | "imap">("google");
  return (
    <div>
      <h3>Add account</h3>
      <Seg value={kind} onChange={setKind} options={[["google", "Google"], ["microsoft", "Microsoft"], ["imap", "iCloud, Yahoo, other"]]} />
      {kind === "imap" ? <ImapForm /> : <OAuthBlock kind={kind} />}
    </div>
  );
}

// ---------------------------------------------------------------- Mailbox panels (scope = null | accountId)
function ComposingPanel({ scope }: { scope: string | null }) {
  const [sigs, setSigs] = useState<Signature[]>([]);
  useEffect(() => void api.listSignatures().then(setSigs), []);
  const usable = sigs.filter((s) => !s.accountId || s.accountId === scope || scope === null);
  return (
    <>
      <OvRow scope={scope} k="replyDefault" label="Default reply action">
        {(v, set) => (
          <select value={v} onChange={(e) => set(e.target.value as Prefs["replyDefault"])}>
            <option value="reply">Reply</option>
            <option value="replyAll">Reply all</option>
          </select>
        )}
      </OvRow>
      <OvRow scope={scope} k="undoSeconds" label="Undo send" hint="Delay before a message is actually sent">
        {(v, set) => (
          <select value={v} onChange={(e) => set(Number(e.target.value))}>
            {[0, 5, 10, 20, 30, 60].map((n) => <option key={n} value={n}>{n === 0 ? "Off" : `${n} seconds`}</option>)}
          </select>
        )}
      </OvRow>
      <OvRow scope={scope} k="autoCc" label="Auto Cc" hint="Added to Cc on every new message">
        {(v, set) => <input value={v} onChange={(e) => set(e.target.value)} placeholder="name@example.com" />}
      </OvRow>
      <OvRow scope={scope} k="autoBcc" label="Auto Bcc">
        {(v, set) => <input value={v} onChange={(e) => set(e.target.value)} placeholder="name@example.com" />}
      </OvRow>
      <OvRow scope={scope} k="signatureId" label="Signature" hint="Automatic uses the default signature of this scope">
        {(v, set) => (
          <select value={v} onChange={(e) => set(e.target.value)}>
            <option value="">Automatic (default)</option>
            <option value="none">No signature</option>
            {usable.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
      </OvRow>
      <OvRow scope={scope} k="inlinePictures" label="Pasted and dropped pictures" hint="Put in the message, or attached as files">
        {(v, set) => (
          <select value={v} onChange={(e) => set(e.target.value as Prefs["inlinePictures"])}>
            <option value="inline">Put in the message</option>
            <option value="attach">Attach as files</option>
          </select>
        )}
      </OvRow>
      <OvRow scope={scope} k="autoResizePictures" label="Resize large pictures automatically" hint="Pictures over 1 MB are reduced to 1600 px wide when inserted">
        {(v, set) => <Switch checked={v} onChange={set} />}
      </OvRow>
      <OvRow scope={scope} k="signatureOnReply" label="Add signature to replies">
        {(v, set) => <Switch checked={v} onChange={set} />}
      </OvRow>
    </>
  );
}

function ScopedList<T extends { id: string; accountId?: string | null }>({
  scope, items, title, tags, render, onOpen, onDelete, empty,
}: {
  scope: string | null;
  items: T[];
  title: (i: T) => ReactNode;
  /** badges of the row (default, off...): right-aligned, just before the action */
  tags?: (i: T) => ReactNode;
  render?: (i: T) => ReactNode;
  onOpen: (i: T) => void;
  onDelete: (i: T) => void;
  empty: string;
}) {
  const own = items.filter((i) => (i.accountId ?? null) === scope);
  const inherited = scope ? items.filter((i) => !i.accountId) : [];
  return (
    <>
      {own.length === 0 && <div className="muted small pad">{empty}</div>}
      {own.map((i) => (
        <div key={i.id} className="list-row" onClick={() => onOpen(i)}>
          <div className="lr-name"><span className="lr-title">{title(i)}</span>{render?.(i)}</div>
          {tags?.(i) && <span className="lr-tags">{tags(i)}</span>}
          <button className="icon-btn" title="Delete" aria-label="Delete" onClick={(e) => { e.stopPropagation(); onDelete(i); }}><Trash2 size={15} /></button>
        </div>
      ))}
      {inherited.length > 0 && (
        <>
          <div className="muted small inh-title">Also applies here (from All accounts)</div>
          {inherited.map((i) => (
            <div key={i.id} className="list-row inherited">
              <div className="lr-name"><span className="lr-title">{title(i)}</span></div>
              <span className="lr-tags"><span className="ov-tag">All accounts</span></span>
            </div>
          ))}
        </>
      )}
    </>
  );
}

function SignaturesPanel({ scope }: { scope: string | null }) {
  const { confirm } = useStore();
  const [list, setList] = useState<Signature[]>([]);
  const [cur, setCur] = useState<Signature | null>(null);
  const load = () => api.listSignatures().then(setList);
  useEffect(() => void load(), []);
  const own = list.filter((s) => (s.accountId ?? null) === scope);
  return (
    <>
      <ScopedList
        scope={scope}
        items={list}
        empty={scope ? "No signature of its own. This account uses the ones from All accounts." : "No signatures yet."}
        title={(s) => s.name}
        tags={(s) => s.isDefault && <span className="ov-tag own">default</span>}
        onOpen={setCur}
        onDelete={async (s) => {
          if (await confirm({ title: `Delete the signature “${s.name}”?`, confirmLabel: "Delete", danger: true })) {
            await api.deleteSignature(s.id);
            void load();
          }
        }}
      />
      <button className="btn" onClick={() => setCur({ id: crypto.randomUUID(), accountId: scope, name: "New signature", html: "", isDefault: !own.some((s) => s.isDefault) })}>
        <Plus size={14} /> New signature
      </button>
      {cur && (
        <div className="form set-card">
          <label>Name</label>
          <input aria-label="Name" placeholder="Work signature" value={cur.name} onChange={(e) => setCur({ ...cur, name: e.target.value })} />
          <label>Signature</label>
          <RichEditor key={cur.id} label="Signature" value={cur.html} onChange={(html) => setCur((c) => (c ? { ...c, html } : c))} placeholder="Your name, title, phone…" />
          <Switch checked={cur.isDefault} onChange={(v) => setCur({ ...cur, isDefault: v })} label={scope ? "Default for this account" : "Default for all accounts"} />
          <div className="row-inline">
            <button className="btn primary" onClick={async () => { await api.saveSignature(cur); setCur(null); void load(); }}>Save</button>
            <button className="btn" onClick={() => setCur(null)}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}

function TemplatesPanel({ scope }: { scope: string | null }) {
  const { confirm } = useStore();
  const [list, setList] = useState<Template[]>([]);
  const [cur, setCur] = useState<Template | null>(null);
  const load = () => api.listTemplates().then(setList);
  useEffect(() => void load(), []);
  return (
    <>
      <ScopedList
        scope={scope}
        items={list}
        empty={scope ? "No template of its own. This account can use the ones from All accounts." : "No templates yet."}
        title={(t) => t.name}
        onOpen={setCur}
        onDelete={async (t) => {
          if (await confirm({ title: `Delete the template “${t.name}”?`, confirmLabel: "Delete", danger: true })) {
            await api.deleteTemplate(t.id);
            void load();
          }
        }}
      />
      <button className="btn" onClick={() => setCur({ id: crypto.randomUUID(), accountId: scope, name: "New template", subject: "", body: "" })}>
        <Plus size={14} /> New template
      </button>
      {cur && (
        <div className="form set-card">
          <label>Name</label>
          <input aria-label="Name" placeholder="Weekly report" value={cur.name} onChange={(e) => setCur({ ...cur, name: e.target.value })} />
          <label>Subject (optional)</label>
          <input aria-label="Subject (optional)" placeholder="Weekly status update" value={cur.subject} onChange={(e) => setCur({ ...cur, subject: e.target.value })} />
          <label>Message</label>
          <RichEditor key={cur.id} label="Message" value={cur.body} onChange={(body) => setCur((c) => (c ? { ...c, body } : c))} minHeight={180} />
          <div className="row-inline">
            <button className="btn primary" onClick={async () => { await api.saveTemplate(cur); setCur(null); void load(); }}>Save</button>
            <button className="btn" onClick={() => setCur(null)}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}

function FiltersPanel({ scope }: { scope: string | null }) {
  const { folders, showToast, confirm } = useStore();
  const [list, setList] = useState<Rule[]>([]);
  const [cur, setCur] = useState<Rule | null>(null);
  const load = () => api.listRules().then(setList);
  useEffect(() => void load(), []);
  const roles = Array.from(new Set(folders.filter((f) => !scope || f.accountId === scope).map((f) => f.key))).filter((k) => !["inbox", "sent", "drafts"].includes(k));
  return (
    <>
      <div className="muted small pad">Filters run on new inbox mail when it arrives, also while the app sits in the tray.</div>
      <ScopedList
        scope={scope}
        items={list}
        empty="No filters yet."
        title={(r) => r.name || `${r.field} ${r.op} “${r.value}”`}
        tags={(r) => !r.enabled && <span className="ov-tag">off</span>}
        render={(r) => <div className="muted small">{r.action}{r.arg ? ` → ${folderLabel(r.arg)}` : ""}</div>}
        onOpen={setCur}
        onDelete={async (r) => {
          if (await confirm({ title: "Delete this filter?", confirmLabel: "Delete", danger: true })) {
            await api.deleteRule(r.id);
            void load();
          }
        }}
      />
      <button className="btn" onClick={() => setCur({ id: crypto.randomUUID(), accountId: scope, name: "", field: "from", op: "contains", value: "", action: "archive", arg: null, enabled: true })}>
        <Plus size={14} /> New filter
      </button>
      {cur && (
        <div className="form set-card">
          <label>Name</label>
          <input aria-label="Name" placeholder="Move newsletters" value={cur.name} onChange={(e) => setCur({ ...cur, name: e.target.value })} />
          <label>When</label>
          <div className="row-inline">
            <select aria-label="Rule field" value={cur.field} onChange={(e) => setCur({ ...cur, field: e.target.value as Rule["field"] })}>
              <option value="from">From</option><option value="to">To</option><option value="subject">Subject</option><option value="any">Any field</option>
            </select>
            <select aria-label="Rule condition" value={cur.op} onChange={(e) => setCur({ ...cur, op: e.target.value as Rule["op"] })}>
              <option value="contains">contains</option><option value="equals">equals</option>
            </select>
            <input aria-label="Rule text" placeholder="newsletter@example.com" value={cur.value} onChange={(e) => setCur({ ...cur, value: e.target.value })} />
          </div>
          <label>Then</label>
          <div className="row-inline">
            <select aria-label="Rule action" value={cur.action} onChange={(e) => setCur({ ...cur, action: e.target.value as Rule["action"] })}>
              <option value="archive">Archive</option><option value="trash">Delete</option><option value="junk">Move to Junk</option>
              <option value="read">Mark as read</option><option value="star">Flag</option><option value="pin">Pin</option><option value="move">Move to folder…</option>
            </select>
            {cur.action === "move" && (
              <select aria-label="Target folder" value={cur.arg ?? ""} onChange={(e) => setCur({ ...cur, arg: e.target.value })}>
                <option value="">Choose folder</option>
                {roles.map((k) => <option key={k} value={k}>{folderLabel(k, folders.find((f) => f.key === k)?.name)}</option>)}
              </select>
            )}
          </div>
          <Switch checked={cur.enabled} onChange={(v) => setCur({ ...cur, enabled: v })} label="Enabled" />
          <div className="row-inline">
            <button
              className="btn primary"
              disabled={!cur.value.trim() || (cur.action === "move" && !cur.arg)}
              onClick={async () => { await api.saveRule(cur); setCur(null); void load(); showToast("Filter saved", undefined, "success"); }}
            >
              Save
            </button>
            <button className="btn" onClick={() => setCur(null)}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}

function NotifyPanel({ scope }: { scope: string | null }) {
  const os = usePlatform((s) => s.os);
  const windows = os === "windows";
  return (
    <>
      <OvRow scope={scope} k="notifications" label="Desktop notifications for new mail">
        {(v, set) => <Switch checked={v} onChange={set} />}
      </OvRow>
      {!windows && <div className="muted small">Notifications on {os === "macos" ? "macOS" : "Linux"} have no buttons. Open Hey Look! to act on a message.</div>}
      <OvRow scope={scope} k="smartNotifications" label="Smart notifications" hint="Skip newsletters and bulk mail">
        {(v, set) => <Switch checked={v} onChange={set} />}
      </OvRow>
      <OvRow scope={scope} k="notifyPreview" label="Show message preview">
        {(v, set) => <Switch checked={v} onChange={set} />}
      </OvRow>
      <OvRow scope={scope} k="notifySound" label="Sound" hint={windows ? undefined : "Every choice except None plays the system’s notification sound."}>
        {(v, set) => <SoundSelect value={v} onChange={set} />}
      </OvRow>
      {windows && (
      <OvRow scope={scope} k="notifyActions" label="Notification buttons" hint="Up to three buttons on each notification">
        {(v, set) => (
          <div className="three">
            {[0, 1, 2].map((i) => (
              <select
                key={i}
                aria-label={`Button ${i + 1}`}
                value={v[i] ?? "none"}
                onChange={(e) => {
                  const a = [...v];
                  while (a.length < 3) a.push("none");
                  a[i] = e.target.value;
                  set(a);
                }}
              >
                {NOTIFY_ACTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            ))}
          </div>
        )}
      </OvRow>
      )}
    </>
  );
}

function ReadingPanel({ scope }: { scope: string | null }) {
  const { prefs, setPrefs } = useStore();
  // a value outside the presets (edited by hand) stays selectable instead of silently showing another one
  const caps = MAX_DOWNLOAD_PRESETS.includes(prefs.maxDownload) ? MAX_DOWNLOAD_PRESETS : [...MAX_DOWNLOAD_PRESETS, prefs.maxDownload].sort((a, b) => a - b);
  return (
    <>
      <OvRow scope={scope} k="loadRemote" id="loadRemote" label="Always load remote content (images)" hint="Off = blocked to stop tracking pixels; you can still load a single message. When on, senders can tell you opened it.">
        {(v, set) => <Switch checked={v} onChange={set} />}
      </OvRow>
      <OvRow scope={scope} k="inlineAutoLoadMB" label="Load inline pictures automatically up to" hint="Larger pictures show a placeholder you can click to load">
        {(v, set) => (
          <select value={v} onChange={(e) => set(Number(e.target.value) as Prefs["inlineAutoLoadMB"])}>
            <option value={2}>2 MB each</option>
            <option value={5}>5 MB each</option>
            <option value={0}>Always</option>
          </select>
        )}
      </OvRow>
      <OvRow scope={scope} k="syncMinutes" label="Fetch new mail every">
        {(v, set) => (
          <select value={v} onChange={(e) => set(Number(e.target.value))}>
            {[1, 2, 5, 10, 15, 30].map((n) => <option key={n} value={n}>{n} min</option>)}
          </select>
        )}
      </OvRow>
      {/* one value for every mailbox (each mailbox is counted on its own), so no per-mailbox override */}
      <Row
        label="Max emails to download per mailbox"
        id="maxDownload"
        hint="The fewer mails, the less disk space they use and the better the app performs. When the limit is reached, the oldest mails are removed from this computer as new mail arrives (they stay on the server)."
      >
        <select value={prefs.maxDownload} onChange={(e) => setPrefs({ maxDownload: Number(e.target.value) })}>
          {caps.map((n) => <option key={n} value={n}>{n.toLocaleString("en-US")}{n === DEFAULT_PREFS.maxDownload ? " (default)" : ""}</option>)}
        </select>
      </Row>
    </>
  );
}

function FoldersPanel({ scope }: { scope: string | null }) {
  const { folders, prefs, setPrefs } = useStore();
  const isFav = (id: string) => prefs.favorites.includes(id);
  const toggle = (id: string) => setPrefs({ favorites: isFav(id) ? prefs.favorites.filter((f) => f !== id) : [...prefs.favorites, id] });
  const keys = scope ? folders.filter((f) => f.accountId === scope).map((f) => ({ key: f.key, label: folderLabel(f.key, f.name) })) : ["inbox", "drafts", "sent", "archive", "junk", "trash"].map((k) => ({ key: k, label: folderLabel(k) }));
  return (
    <>
      <div className="muted small pad">{scope ? "Folders of this account that appear under Favorites." : "Folders shown under Favorites for all accounts together."}</div>
      {keys.map(({ key, label }) => (
        <Row key={key} label={label}>
          <Switch checked={isFav(`${scope ?? "*"}|${key}`)} onChange={() => toggle(`${scope ?? "*"}|${key}`)} />
        </Row>
      ))}
    </>
  );
}

function ProfilePanel({ account }: { account: Account }) {
  const accent = useStore((s) => s.prefs.accent);
  const color = accountColor(account, accent);
  const upd = async (patch: Partial<Account>) => {
    const n = { ...account, ...patch };
    await api.updateAccount(account.id, n.displayName, n.color ?? null);
    useStore.setState((s) => ({ accounts: s.accounts.map((x) => (x.id === account.id ? n : x)) }));
  };
  return (
    <>
      <Row label="Display name" hint="Shown to recipients as the sender name"><input defaultValue={account.displayName} placeholder="Your name" onBlur={(e) => void upd({ displayName: e.target.value })} /></Row>
      <Row label="Color" hint="Marks this account in the folder pane and in combined lists">
        <div className="accents" role="radiogroup" aria-label="Mailbox color" style={{ margin: 0, gap: 8, justifyContent: "flex-end" }}>
          {ACCOUNT_PALETTE.map((hex) => (
            <button
              key={hex}
              role="radio"
              aria-checked={color === hex}
              aria-label={hex}
              title={hex}
              className={`swatch small ${color === hex ? "on" : ""}`}
              style={{ background: hex }}
              onClick={() => void upd({ color: hex })}
            />
          ))}
          <label className="swatch-custom">
            <input type="color" aria-label="Custom mailbox color" value={color} onChange={(e) => void upd({ color: e.target.value })} />
          </label>
        </div>
      </Row>
    </>
  );
}

function ServerPanel({ account, close }: { account: Account; close: () => void }) {
  const { confirm } = useStore();
  const remove = async () => {
    const ok = await confirm({
      title: `Remove ${account.email}?`,
      body: "The local copy of this mailbox and the saved credentials are deleted. Mail stays on the server.",
      confirmLabel: "Remove account",
      danger: true,
    });
    if (!ok) return;
    await api.removeAccount(account.id);
    useStore.setState((s) => ({ accounts: s.accounts.filter((x) => x.id !== account.id) }));
    const st = useStore.getState();
    const stale = staleAccountPrefs(st.prefs, st.accounts.map((x) => x.id));
    if (Object.keys(stale).length) st.setPrefs(stale);
    await useStore.getState().refresh();
    // the last account: Settings stays open on "+ Add account" (the store switched it), not on the page of the removed mailbox
    if (useStore.getState().accounts.length > 0) close();
  };
  return (
    <>
      <Row label="Sign-in method">{account.auth === "oauth_google" ? "Google (OAuth 2.0)" : account.auth === "oauth_microsoft" ? "Microsoft (OAuth 2.0)" : `Password (stored in ${credStore()})`}</Row>
      <Row label="Incoming (IMAP)">{account.imapHost}:{account.imapPort}</Row>
      <Row label="Outgoing (SMTP)">{account.smtpHost}:{account.smtpPort} ({account.smtpSecurity})</Row>
      {account.smtpUsername && <Row label="SMTP login">{account.smtpUsername}</Row>}
      {account.tlsInsecure && <Row label="Server certificate" hint="Self-signed or private-CA certificates are accepted for this account.">Not verified</Row>}
      <Row label="Remove account" hint="Deletes the local cache and stored credentials.">
        <button className="btn danger" onClick={() => void remove()}><Trash2 size={14} /> Remove</button>
      </Row>
    </>
  );
}

/** Per-mailbox PGP defaults. "My key" belongs to one account, so it is only shown inside a mailbox. */
function SecurityPanel({ scope }: { scope: string | null }) {
  const { keysRev, bumpKeys, showToast } = useStore();
  const [keys, setKeys] = useState<PgpKey[]>([]);
  useEffect(() => void api.pgpListKeys().then(setKeys).catch(() => setKeys([])), [keysRev]);
  const own = keys.filter((k) => k.hasSecret);
  const current = scope ? own.find((k) => k.defaultFor.includes(scope))?.fingerprint ?? "" : "";
  return (
    <>
      {scope ? (
        <Row label="My key for this mailbox" hint="Used to sign, and to read mail encrypted to you">
          <select
            style={{ maxWidth: 260 }}
            value={current}
            onChange={(e) => void api.pgpSetDefault(scope, e.target.value || null).then(bumpKeys).catch((er) => showToast(friendlyError(er), undefined, "error"))}
          >
            <option value="">{own.length ? "Automatic (a key with this address)" : "No key yet"}</option>
            {own.map((k) => <option key={k.fingerprint} value={k.fingerprint}>{shortKey(k.fingerprint)} · {k.algo}{k.expires ? ` · exp. ${new Date(k.expires * 1000).getFullYear()}` : ""}</option>)}
          </select>
        </Row>
      ) : (
        <div className="muted small pad">Your keys are chosen per mailbox. Open a mailbox to pick its key. Manage keys under More → Encryption (PGP).</div>
      )}
      <OvRow scope={scope} k="pgpEncrypt" label="Encrypt new messages" hint="“When possible” turns Encrypt on only if every recipient has a public key">
        {(v, set) => (
          <select value={v} onChange={(e) => set(e.target.value as Prefs["pgpEncrypt"])}>
            <option value="possible">When possible</option>
            <option value="never">Never (turn on per message)</option>
            <option value="always">Always (warn before sending unencrypted)</option>
          </select>
        )}
      </OvRow>
      <OvRow scope={scope} k="pgpSign" label="Sign new messages">
        {(v, set) => <Switch checked={v} onChange={set} />}
      </OvRow>
      <OvRow scope={scope} k="pgpAttachKey" label="Attach my public key" hint="Lets recipients reply encrypted">
        {(v, set) => <Switch checked={v} onChange={set} />}
      </OvRow>
      <OvRow scope={scope} k="pgpEncryptDrafts" label="Keep drafts encrypted on the server" hint="Drafts of encrypted messages are encrypted to your own key">
        {(v, set) => <Switch checked={v} onChange={set} />}
      </OvRow>
      <OvRow scope={scope} k="pgpImportFromMail" label="Import keys found in received mail" hint="Ask before adding keys attached to messages (application/pgp-keys)">
        {(v, set) => (
          <select value={v} onChange={(e) => set(e.target.value as Prefs["pgpImportFromMail"])}>
            <option value="ask">Ask</option>
            <option value="auto">Import automatically</option>
            <option value="never">Never</option>
          </select>
        )}
      </OvRow>
    </>
  );
}

type MbTab = "profile" | "composing" | "signatures" | "templates" | "filters" | "notifications" | "reading" | "security" | "folders" | "server";

/** The sections of a mailbox (scope = account id) or of "All accounts" (null). They are listed under the mailbox in the Settings navigation. */
function mailboxSections(scope: string | null): [MbTab, string][] {
  return [
    ...(scope ? ([["profile", "Profile"]] as [MbTab, string][]) : []),
    ["composing", "Composing"], ["signatures", "Signatures"], ["templates", "Templates"], ["filters", "Filters"],
    ["notifications", "Notifications"], ["reading", "Reading & sync"], ["security", "Security"], ["folders", "Folders"],
    ...(scope ? ([["server", "Server"]] as [MbTab, string][]) : []),
  ];
}
const activeSection = (scope: string | null, tab: MbTab): MbTab => (mailboxSections(scope).some(([k]) => k === tab) ? tab : "composing");

function MailboxPage({ scope, tab, close }: { scope: string | null; tab: MbTab; close: () => void }) {
  const { accounts, prefs } = useStore();
  const account = scope ? accounts.find((a) => a.id === scope) : undefined;
  if (scope && !account) return <div className="muted">Account not found.</div>;
  const active = activeSection(scope, tab);
  return (
    <div>
      <div className="mb-head">
        {account ? <Avatar name={account.displayName || account.email} size={36} color={accountColor(account, prefs.accent)} /> : <div className="mb-all">∗</div>}
        <div>
          <h3>{account ? account.email : "All accounts"}</h3>
          <div className="muted small">
            {account
              ? "Anything you set here overrides the All accounts value for this mailbox only. Untouched settings follow All accounts."
              : "The default for every mailbox. A mailbox can override any of these in its own settings."}
          </div>
        </div>
      </div>
      <div className="mb-body" role="region" aria-label={mailboxSections(scope).find(([k]) => k === active)?.[1]}>
        {active === "profile" && account && <ProfilePanel account={account} />}
        {active === "composing" && <ComposingPanel scope={scope} />}
        {active === "signatures" && <SignaturesPanel scope={scope} />}
        {active === "templates" && <TemplatesPanel scope={scope} />}
        {active === "filters" && <FiltersPanel scope={scope} />}
        {active === "notifications" && <NotifyPanel scope={scope} />}
        {active === "reading" && <ReadingPanel scope={scope} />}
        {active === "security" && <SecurityPanel scope={scope} />}
        {active === "folders" && <FoldersPanel scope={scope} />}
        {active === "server" && account && <ServerPanel account={account} close={close} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- app-level pages
function TrayTab() {
  const { prefs, setPrefs, showToast } = useStore();
  const os = usePlatform((s) => s.os);
  const tray = usePlatform((s) => s.tray);
  const [autostart, setAutostart] = useState(false);
  useEffect(() => void api.getAutostart().then(setAutostart).catch(() => undefined), []);
  const test = async () => {
    try {
      await api.testNotification();
    } catch (e) {
      const text = String(e instanceof Error ? e.message : e).replace(/^Error:\s*/, "").slice(0, 120);
      showToast(os === "windows" ? text : `Couldn’t show a notification: ${text}`, undefined, "error");
    }
  };
  const toggleAuto = async (v: boolean) => {
    try {
      await api.setAutostart(v);
      setAutostart(v);
    } catch (e) {
      showToast(String(e), undefined, "error");
    }
  };
  return (
    <div>
      <h3>Notifications & tray</h3>
      {os === "macos" && <div className="muted small" style={{ marginBottom: 6 }}>Notifications aren’t available on macOS in this version.</div>}
      <div className="muted small">{os === "windows" ? "Which mail triggers a notification, its sound and its buttons are set per mailbox (Mailboxes → Notifications)." : "Which mail triggers a notification and its sound are set per mailbox (Mailboxes → Notifications)."}</div>
      <Row label="Test notification"><button className="btn" onClick={() => void test()}>Send test</button></Row>
      <Row label="Sound when a message is sent"><Switch checked={prefs.sentSound} onChange={(v) => setPrefs({ sentSound: v })} /></Row>
      <Row
        label="Keep running in the tray when the window is closed"
        hint={
          !tray
            ? "No tray area was found on this desktop, so closing the window quits Hey Look!."
            : os === "macos"
              ? "Mail keeps syncing and notifying. Quit from the menu bar icon or with Cmd+Q."
              : "Mail keeps syncing and notifying. Quit from the tray menu."
        }
      >
        <Switch checked={tray && prefs.closeToTray} disabled={!tray} onChange={(v) => setPrefs({ closeToTray: v })} />
      </Row>
      {tray && (
        <Row label="Tray icon badge" hint="A dot is the calmest option; the exact number is always in the tooltip">
          <select value={prefs.trayBadge} onChange={(e) => setPrefs({ trayBadge: e.target.value as Prefs["trayBadge"] })}>
            <option value="number">Unread number</option>
            <option value="dot">Dot only</option>
            <option value="off">None</option>
          </select>
        </Row>
      )}
      {os === "windows" && (
        <Row label="Taskbar badge">
          <select value={prefs.taskbarBadge} onChange={(e) => setPrefs({ taskbarBadge: e.target.value as Prefs["taskbarBadge"] })}>
            <option value="number">Unread number</option>
            <option value="off">None</option>
          </select>
        </Row>
      )}
      <Row label="Count Other (bulk) mail" hint="Off = the numbers only include conversations in Focused, so newsletters do not inflate them">
        <Switch checked={prefs.countOtherMail} onChange={(v) => setPrefs({ countOtherMail: v })} />
      </Row>
      <Row
        label={os === "windows" ? "Start Hey Look! when I sign in to Windows" : "Start Hey Look! when I log in"}
        hint={os === "linux" && !tray ? "Starts with the window open" : "Starts minimized to the tray"}
      >
        <Switch checked={autostart} onChange={(v) => void toggleAuto(v)} />
      </Row>
    </div>
  );
}

const ALL_ACTIONS: [string, string][] = [["archive", "Archive"], ["delete", "Delete"], ["flag", "Flag"], ["pin", "Pin"], ["read", "Mark read/unread"], ["snooze", "Snooze"]];

function ActionsTab() {
  const { prefs, setPrefs } = useStore();
  const toggle = (k: string) =>
    setPrefs({ hoverActions: prefs.hoverActions.includes(k) ? prefs.hoverActions.filter((x) => x !== k) : [...prefs.hoverActions, k] });
  return (
    <div>
      <h3>Thread actions</h3>
      <div className="muted small">Quick actions that appear when you hover a conversation in the list.</div>
      {ALL_ACTIONS.map(([k, l]) => (
        <Row key={k} label={l}><Switch checked={prefs.hoverActions.includes(k)} onChange={() => toggle(k)} /></Row>
      ))}
    </div>
  );
}

function TimesTab() {
  const { prefs, setPrefs } = useStore();
  const t = prefs.snoozeTimes;
  const sel = (k: keyof typeof t, label: string) => (
    <Row label={label}>
      <select value={t[k]} onChange={(e) => setPrefs({ snoozeTimes: { ...t, [k]: Number(e.target.value) } })}>
        {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
      </select>
    </Row>
  );
  return (
    <div>
      <h3>Customize times</h3>
      <div className="muted small">Used by Snooze and Send later.</div>
      {sel("evening", "Later today")}
      {sel("tomorrow", "Tomorrow")}
      {sel("weekend", "This weekend")}
      {sel("nextWeek", "Next week")}
    </div>
  );
}

function BlockedTab() {
  const [list, setList] = useState<string[]>([]);
  const load = () => api.listBlocked().then(setList);
  useEffect(() => void load(), []);
  return (
    <div>
      <h3>Blocked senders</h3>
      {list.length === 0 && <div className="muted">No blocked senders.</div>}
      {list.map((e) => (
        <div key={e} className="list-row">
          <div className="lr-name"><span className="lr-title">{e}</span></div>
          <button className="btn small" onClick={async () => { await api.unblock(e); void load(); }}>Unblock</button>
        </div>
      ))}
    </div>
  );
}

function AiTab() {
  const [v, setV] = useState({ ai_endpoint: "", ai_model: "" });
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const { showToast, refreshAi } = useStore();
  // model ids offered by {Base URL}/models (fetched by the backend: no CORS, Bearer key); refetched when URL or key change
  const [models, setModels] = useState<string[]>([]);
  const [modelsState, setModelsState] = useState<"idle" | "loading" | "error">("idle");
  const [modelsErr, setModelsErr] = useState("");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!ready) return;
    if (!v.ai_endpoint.trim()) {
      setModels([]);
      setModelsState("idle");
      return;
    }
    let stale = false;
    setModelsState("loading");
    const timer = setTimeout(() => {
      api.aiListModels(v.ai_endpoint.trim(), key.trim() || undefined)
        .then((ids) => {
          if (stale) return;
          setModels(ids);
          setModelsState("idle");
        })
        .catch((e) => {
          if (stale) return;
          setModels([]);
          setModelsErr(friendlyError(e));
          setModelsState("error");
        });
    }, 600);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [ready, v.ai_endpoint, key, hasKey]);
  useEffect(() => {
    void Promise.all([api.getSetting("ai_endpoint"), api.getSetting("ai_model"), api.hasSecret("ai_key")]).then(([a, c, h]) => {
      setV({ ai_endpoint: a ?? "", ai_model: c ?? "" });
      setHasKey(h);
      setReady(true);
    });
  }, []);
  const save = async () => {
    await Promise.all([api.setSetting("ai_endpoint", v.ai_endpoint), api.setSetting("ai_model", v.ai_model)]);
    if (key.trim()) {
      await api.setSecret("ai_key", key.trim());
      setHasKey(true);
      setKey("");
    }
    await refreshAi();
    showToast("AI Assistant settings saved", undefined, "success");
  };
  return (
    <div>
      <h3>AI Assistant</h3>
      <div className="muted small">Any OpenAI-compatible endpoint (OpenAI, a local server, a gateway). Used for summaries, translation and writing help.</div>
      <div className="form">
        <label>Base URL (ending in /v1)</label>
        <input aria-label="Base URL (ending in /v1)" placeholder="https://api.openai.com/v1" value={v.ai_endpoint} onChange={(e) => setV({ ...v, ai_endpoint: e.target.value })} />
        <label>API key</label>
        <input aria-label="API key" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={hasKey ? `Saved in ${credStore()}` : "Optional for local servers"} />
        {hasKey && (
          <button className="link small" onClick={async () => { await api.setSecret("ai_key", ""); setHasKey(false); }}>Remove the saved key</button>
        )}
        <label>Model</label>
        {models.length > 0 ? (
          <select aria-label="Model" value={v.ai_model} onChange={(e) => setV({ ...v, ai_model: e.target.value })}>
            {!v.ai_model && <option value="">Choose a model…</option>}
            {/* the saved model stays selectable even when the endpoint does not list it */}
            {v.ai_model && !models.includes(v.ai_model) && <option value={v.ai_model}>{v.ai_model} (saved)</option>}
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        ) : (
          <input aria-label="Model" value={v.ai_model} placeholder="Model id, e.g. gpt-4o-mini" onChange={(e) => setV({ ...v, ai_model: e.target.value })} />
        )}
        {modelsState === "loading" && <div className="muted small" role="status">Loading models…</div>}
        {modelsState === "error" && <div className="muted small" role="status">Could not load the model list ({modelsErr}). Type a model id instead.</div>}
        {modelsState === "idle" && models.length === 0 && v.ai_endpoint.trim() && <div className="muted small" role="status">The endpoint returned no models. Type a model id instead.</div>}
        <button className="btn primary" onClick={() => void save()}>Save</button>
      </div>
    </div>
  );
}

function KeyRow({ k, onOpen }: { k: PgpKey; onOpen: () => void }) {
  const accounts = useStore((s) => s.accounts);
  const used = k.defaultFor.map((id) => accounts.find((a) => a.id === id)?.email).filter(Boolean) as string[];
  const fp = fmtFpr(k.fingerprint).split(" ");
  return (
    <div
      className="key-row"
      tabIndex={0}
      role="button"
      aria-label={`${keyName(k)}, key ${shortKey(k.fingerprint)}. Open details`}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}
    >
      <span className={`key-ico ${k.hasSecret ? "" : "pub"}`}>{k.hasSecret ? <KeyRound size={17} /> : <Lock size={16} />}</span>
      <span className="key-meta">
        <b className="ellipsis">{keyName(k)}</b>
        <span className="fpr" aria-hidden>{fp.slice(0, 4).join(" ")} … {fp.slice(-1)} · {k.algo}{k.expires ? ` · ${k.expired ? "expired" : "expires"} ${fmtDay(k.expires)}` : ""}</span>
      </span>
      <span className="key-tags">
        {k.revoked && <span className="pill bad">Revoked</span>}
        {!k.revoked && k.expired && <span className="pill warn">Expired</span>}
        {k.hasSecret ? (
          <>
            {used.map((e) => <span key={e} className="pill accent">Default for {e}</span>)}
            {k.unlocked && <span className="pill">{k.passphraseRemembered ? "Passphrase remembered" : "Unlocked"}</span>}
          </>
        ) : k.verified ? <span className="pill good">Verified</span> : <span className="pill">Not verified</span>}
      </span>
    </div>
  );
}

function PgpTab() {
  const { setDialog, prefs, setPrefs, keysRev, bumpKeys, showToast } = useStore();
  const [keys, setKeys] = useState<PgpKey[] | null>(null);
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    api.pgpListKeys().then((k) => (setKeys(k), setErr(""))).catch((e) => (setKeys([]), setErr(friendlyError(e))));
  }, [keysRev]);
  const own = keys?.filter((k) => k.hasSecret) ?? [];
  const others = (keys ?? []).filter((k) => !k.hasSecret);
  const needle = q.trim().toLowerCase();
  const shown = needle ? others.filter((k) => `${k.userIds.join(" ")} ${k.keyId} ${k.fingerprint}`.toLowerCase().includes(needle)) : others;
  const open = (fingerprint: string) => setDialog({ type: "pgp-key", fingerprint, back: "pgp" });
  return (
    <div>
      <h3>Encryption (PGP)</h3>
      <div className="muted small">OpenPGP keys for encrypting and signing mail (PGP/MIME). Your secret keys stay on this computer, locked with your passphrase. Keys are never looked up online: you add them yourself.</div>
      {err && <div className="notice bad" role="alert" style={{ marginTop: 10 }}>Couldn’t load keys: {err} <button className="link" onClick={bumpKeys}>Retry</button></div>}
      <div className="set-card-head" style={{ marginTop: 14 }}>
        <h4 style={{ margin: 0, flex: 1 }}>Your keys</h4>
        <button className="btn small" onClick={() => setDialog({ type: "pgp-import", back: "pgp" })}><Upload size={13} /> Import…</button>
        <button className="btn small primary" onClick={() => setDialog({ type: "pgp-generate", back: "pgp" })}><Plus size={13} /> Generate key…</button>
      </div>
      <div style={{ marginTop: 8 }}>
        {!keys ? (
          <div className="sk" style={{ height: 56 }} aria-busy aria-label="Loading keys" />
        ) : own.length === 0 ? (
          <div className="empty-state" style={{ padding: "18px 0" }}>
            <div className="empty-art"><KeyRound size={34} /></div>
            <div className="empty-title">No keys yet</div>
            <div className="muted">Generate a key to sign mail and let people send you encrypted mail.</div>
            <button className="btn primary" style={{ marginTop: 8 }} onClick={() => setDialog({ type: "pgp-generate", back: "pgp" })}>Generate key…</button>
          </div>
        ) : own.map((k) => <KeyRow key={k.fingerprint} k={k} onOpen={() => open(k.fingerprint)} />)}
      </div>
      <div className="set-card-head" style={{ marginTop: 18 }}>
        <h4 style={{ margin: 0, flex: 1 }}>Other people’s public keys <span className="muted small" style={{ fontWeight: 400 }}>· {others.length}</span></h4>
        <input placeholder="Search name, email or key ID" aria-label="Search keys" style={{ width: 220 }} value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn small" onClick={() => setDialog({ type: "pgp-import", back: "pgp" })}><Upload size={13} /> Import…</button>
      </div>
      <div style={{ marginTop: 8 }}>
        {others.length === 0 && keys && <div className="muted small">Public keys you import, or that arrive attached to mail, appear here.</div>}
        {others.length > 0 && shown.length === 0 && <div className="muted small">No key matches “{q}”.</div>}
        {shown.map((k) => <KeyRow key={k.fingerprint} k={k} onOpen={() => open(k.fingerprint)} />)}
      </div>
      <h4>Passphrases</h4>
      <Row label="Remember passphrases" hint="How long an unlocked key stays unlocked. It is kept in memory only, never on disk.">
        <select value={prefs.pgpRemember} onChange={(e) => setPrefs({ pgpRemember: e.target.value as Prefs["pgpRemember"] })}>
          <option value="session">Until Hey Look! quits</option>
          <option value="never">Ask every time</option>
        </select>
      </Row>
      <Row label="Lock all keys now" hint="Forget every remembered passphrase and decrypted message">
        <button className="btn small" onClick={() => void api.pgpLockAll().then(() => (bumpKeys(), showToast("All keys are locked", undefined, "success")))}>Lock now</button>
      </Row>
    </div>
  );
}

function ShortcutsTab() {
  const os = usePlatform((s) => s.os);
  const rows: [string, string][] = [
    ["c", "New mail"], ["/", "Search"], ["j / k", "Next / previous conversation"], ["e", "Archive"], ["#", "Delete"], ["!", "Move to Junk"],
    ["s", "Snooze"], ["p", "Pin"], ["*", "Flag"], ["u", "Mark as unread"], ["r", "Reply"], ["a", "Reply all"], ["f", "Forward"],
    ["Ctrl+Enter", "Send (while writing)"], ["Ctrl+Shift+Enter", "Send later (while writing)"], ["Ctrl+Shift+P", "Insert picture (while writing)"], ["Ctrl+Shift+E", "Encrypt (while writing)"], ["Ctrl+Shift+G", "Sign (while writing)"],
    ["Space / Enter", "Preview / open attachment"], ["Ctrl+S", "Save attachment as…"], ["Ctrl+Shift+S", "Save all attachments"],
    ["Ctrl+1 / Ctrl+2", "Mail / Calendar"], ["c · t · ← / → · m / w / a", "Calendar: new event, today, previous / next, Month / Week / Agenda"],
    ["Ctrl+A", "Select all"], ["Ctrl+K", "Command bar"], ["F5", "Sync now"], ["Esc", "Close / deselect"],
  ];
  return (
    <div>
      <h3>Keyboard shortcuts</h3>
      {rows.map(([k, d]) => (
        <div key={k} className="set-row"><kbd>{kbd(os === "macos" && k === "#" ? "delete / #" : k, os)}</kbd><span>{d}</span></div>
      ))}
    </div>
  );
}

function AboutTab() {
  const { prefs, setPrefs } = useStore();
  const testData = usePlatform((s) => s.testData);
  return (
    <div>
      <h3>About</h3>
      <p><b>Hey Look!</b> — a desktop mail client built with Tauri, React and Rust.</p>
      {testData && <div className="notice info">Test build: your mail, accounts and settings are kept in {testData}, not in the normal data folder.</div>}
      <UpdatesBlock
        privacy={
          <p className="muted small">All features are always enabled. No license, no subscription, no cloud account. Mail goes directly between this app and your mail servers; AI features use only the endpoint you configure. Update checks ask GitHub (github.com) for the latest version; updates are downloaded from GitHub only after you agree. You can turn automatic checks off below.</p>
        }
        autoSwitch={
          <Row
            label="Check for updates automatically"
            hint="When Hey Look! starts or comes back from the tray, at most every 6 hours. Only GitHub is asked; your mail and accounts are never sent."
          >
            <Switch checked={prefs.checkUpdates} onChange={(v) => setPrefs({ checkUpdates: v })} />
          </Row>
        }
      />
      <div className="about-links">
        {ABOUT_LINKS.map((l) => (
          <button key={l.url} className="link about-link" title={l.url} onClick={() => void openUpdateLink(l.url)}>{l.text}</button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- shell
const MORE: [string, string][] = [
  ["tray", "Notifications & tray"], ["actions", "Thread actions"], ["times", "Customize times"], ["blocked", "Blocked senders"], ["pgp", "Encryption (PGP)"],
  ["ai", "AI Assistant"], ["shortcuts", "Shortcuts"], ["about", "About"],
];

export function Settings({ initial, focus, nonce }: { initial?: string; focus?: string; nonce?: number }) {
  const { setDialog, accounts, prefs } = useStore();
  const start = initial === "accounts" ? "mb:all" : initial === "notifications" ? "tray" : initial;
  const [tab, setTab] = useState<string>(start || (accounts.length === 0 ? "add-account" : "general"));
  const [mbTab, setMbTab] = useState<MbTab>(focus === "loadRemote" || focus === "maxDownload" ? "reading" : focus === "security" ? "security" : "composing");
  const close = () => setDialog(null);
  // Settings is already open and something asks for a tab (toast "What’s new", Command bar, the gear with a dot): switch to it
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (initial) setTab(initial === "accounts" ? "mb:all" : initial === "notifications" ? "tray" : initial);
  }, [initial, nonce]);
  useEffect(() => {
    if (!focus) return;
    const t = setTimeout(() => {
      const el = document.getElementById(`set-${focus}`);
      el?.scrollIntoView({ block: "center" });
      el?.classList.add("flash");
    }, 80);
    return () => clearTimeout(t);
  }, [focus, tab, mbTab]);
  // keep the selected navigation entry in view (the list scrolls on small windows)
  useEffect(() => {
    document.querySelector<HTMLElement>(".settings-nav button.active:not(.has-sub)")?.scrollIntoView({ block: "nearest" });
  }, [tab, mbTab]);

  // sections of the selected mailbox, listed right under it (Arrow Up/Down move between them)
  const sections = (k: string) => {
    const scope = k === "mb:all" ? null : k.slice(3);
    const active = activeSection(scope, mbTab);
    return (
      <div
        className="nav-sub"
        role="group"
        aria-label="Mailbox sections"
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          const list = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
          const i = list.indexOf(document.activeElement as HTMLButtonElement);
          list[Math.max(0, Math.min(list.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.click();
          list[Math.max(0, Math.min(list.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
        }}
      >
        {mailboxSections(scope).map(([s, l]) => (
          <button key={s} className={s === active ? "active" : ""} aria-current={s === active ? "page" : undefined} onClick={() => setMbTab(s)}>
            {l}
          </button>
        ))}
      </div>
    );
  };
  const item = (k: string, l: ReactNode, sub = false) => (
    <Fragment key={k}>
      <button className={`${tab === k ? "active" : ""} ${sub ? "sub" : ""} ${tab === k && k.startsWith("mb:") ? "has-sub" : ""}`} aria-current={tab === k ? "page" : undefined} onClick={() => setTab(k)}>
        {l}
      </button>
      {tab === k && k.startsWith("mb:") && sections(k)}
    </Fragment>
  );

  return (
    <Modal title="Settings" onClose={close} wide>
      <div className="settings">
        <nav className="settings-nav" aria-label="Settings sections">
          <div className="nav-label">App</div>
          {item("general", "General")}
          {item("appearance", "Appearance")}
          <div className="nav-label">Mailboxes</div>
          {item("mb:all", "All accounts")}
          {accounts.map((a) => item(`mb:${a.id}`, <><span className="dot" style={{ background: accountColor(a, prefs.accent) }} />{a.email}</>, true))}
          {item("add-account", "+ Add account", true)}
          <div className="nav-label">More</div>
          {MORE.map(([k, l]) => item(k, l))}
        </nav>
        <div className="settings-body">
          {tab === "general" && <GeneralTab />}
          {tab === "appearance" && <AppearanceTab />}
          {tab === "add-account" && <AddAccountTab />}
          {tab === "mb:all" && <MailboxPage scope={null} tab={mbTab} close={() => setTab("mb:all")} />}
          {tab.startsWith("mb:") && tab !== "mb:all" && <MailboxPage key={tab} scope={tab.slice(3)} tab={mbTab} close={() => setTab("mb:all")} />}
          {tab === "tray" && <TrayTab />}
          {tab === "actions" && <ActionsTab />}
          {tab === "times" && <TimesTab />}
          {tab === "blocked" && <BlockedTab />}
          {tab === "pgp" && <PgpTab />}
          {tab === "ai" && <AiTab />}
          {tab === "shortcuts" && <ShortcutsTab />}
          {tab === "about" && <AboutTab />}
        </div>
      </div>
    </Modal>
  );
}
