import { listen } from "@tauri-apps/api/event";
import { KeyRound, Lock, Plus, Trash2, Upload } from "lucide-react";
import { openUpdateLink } from "../updates";
import { Grip, useAccountReorder } from "./AccountReorder";
import { ABOUT_LINKS } from "../aboutLinks";
import { Fragment, ReactNode, useEffect, useRef, useState } from "react";
import { Account, api, CalSource, Discovered, PgpKey, PROVIDERS, Rule, Signature, Template } from "../api";
import { calendarErrorCode, calendarSyncKind, providerName, serviceName, statusLine, truncatedNote } from "../calendarSync";
import { ACCENT_PRESETS, ACCOUNT_PALETTE, accountColor, DEFAULT_PREFS, eff, folderLabel, isOverridden, MAX_DOWNLOAD_PRESETS, NOTIFY_ACTIONS, NOTIFY_SOUNDS, Overridable, Prefs, staleAccountPrefs, validHex } from "../prefs";
import { folderVisible } from "../junk";
import { cutAtWord, friendlyError, useStore } from "../store";
import { credStore, kbd, riskyHint, usePlatform } from "../platform";
import { systemTz } from "../calendar";
import { setEnabled as setNudgeEnabled } from "../supportNudge";
import { fmtDay, fmtFpr, shortKey } from "../util";
import { AppearancePreview } from "./AppearancePreview";
import { baseFromPrefs } from "../editor/baseFont";
import { FONTS, SIZES, stackFor } from "../editor/fonts";
import { RichEditor } from "./RichEditor";
import { UpdatesBlock } from "./Updates";
import { ReauthNotice, SignInEnded, SignInWaiting, signInEnd, type SignInEnd } from "./SignInHelp";
import { keyName } from "./Pgp";
import { AccountPicker, Avatar, Modal, Switch } from "./ui";
import { LANGS, intlLocale, pseudoAllowed, type Key } from "../i18n";
import { fmtNumber, weekdayName } from "../i18n/format";
import { useT } from "../i18n/react";
import { tx } from "../i18n/rich";

/** "lundi" -> "Lundi": Intl gives weekday names in lower case in some languages, the options here start with a capital. */
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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
  const t = useT();
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
          <button className="ov-tag own" onClick={reset} title={t("settings.ov.backToAll")}>
            {t("settings.ov.customReset")}
          </button>
        ) : (
          <span className="ov-tag" title={t("settings.ov.overrideHint")}>{t("settings.ov.sameAsAll")}</span>
        ))}
      </div>
    </Row>
  );
}

const SoundSelect = ({ value, onChange }: { value: string; onChange: (v: Prefs["notifySound"]) => void }) => {
  const t = useT();
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as Prefs["notifySound"])}>
      {NOTIFY_SOUNDS.map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}
    </select>
  );
};

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
  const t = useT();
  const { prefs, setPrefs, accounts } = useStore();
  const set = <K extends keyof Prefs>(k: K, v: Prefs[K]) => setPrefs({ [k]: v } as Partial<Prefs>);
  return (
    <div>
      <h3>{t("settings.general.title")}</h3>
      <div className="muted small">{t("settings.general.intro")}</div>
      <Row label={t("settings.general.language")} hint={t("settings.general.languageHint")}>
        <select value={prefs.language} onChange={(e) => set("language", e.target.value as Prefs["language"])}>
          {LANGS.map((l) => <option key={l.code} value={l.code} lang={l.code}>{l.nativeName}</option>)}
          {/* i18n-ok: dev builds only, not shown to users */}
          {pseudoAllowed() && <option value="en-XA">Pseudo-locale (dev)</option>}
        </select>
      </Row>
      <Row label={t("settings.general.afterAction")}>
        <select value={prefs.afterAction} onChange={(e) => set("afterAction", e.target.value as Prefs["afterAction"])}>
          <option value="next">{t("settings.general.openNext")}</option>
          <option value="previous">{t("settings.general.openPrevious")}</option>
          <option value="list">{t("settings.general.backToList")}</option>
        </select>
      </Row>
      <Row label={t("settings.general.markRead")}>
        <select value={prefs.markReadDelay} onChange={(e) => set("markReadDelay", Number(e.target.value))}>
          <option value={0}>{t("settings.general.immediately")}</option>
          <option value={2}>{t("settings.general.after2")}</option>
          <option value={5}>{t("settings.general.after5")}</option>
          <option value={-1}>{t("settings.general.never")}</option>
        </select>
      </Row>
      <Row label={t("settings.general.undoWindow")} hint={t("settings.general.undoWindowHint")}>
        <select value={prefs.undoActionSeconds} onChange={(e) => set("undoActionSeconds", Number(e.target.value))}>
          {[3, 6, 10, 15, 30].map((n) => <option key={n} value={n}>{t("settings.unit.seconds", { n })}</option>)}
        </select>
      </Row>
      <Row label={t("settings.general.defaultAccount")} hint={t("settings.general.defaultAccountHint")}>
        <AccountPicker
          value={accounts.some((a) => a.id === prefs.defaultAccount) ? prefs.defaultAccount : ""}
          accounts={accounts}
          onChange={(id) => set("defaultAccount", id)}
          label={t("settings.general.defaultAccount")}
          none={t("settings.general.noDefaultAccount")}
        />
      </Row>
      <Row label={t("settings.general.dateFormat")}>
        <select value={prefs.dateFormat} onChange={(e) => set("dateFormat", e.target.value as Prefs["dateFormat"])}>
          <option value="relative">{t("settings.general.dateRelative")}</option><option value="absolute">{t("settings.general.dateAbsolute")}</option>
        </select>
      </Row>
      <Row label={t("settings.general.timeFormat")}>
        <select value={prefs.timeFormat} onChange={(e) => set("timeFormat", e.target.value as Prefs["timeFormat"])}>
          <option value="24">{t("settings.general.time24")}</option><option value="12">{t("settings.general.time12")}</option>
        </select>
      </Row>
      <Row label={t("settings.general.supportReminder")} hint={t("settings.general.supportReminderHint")}>
        <Switch checked={prefs.supportNudge.enabled} onChange={(v) => set("supportNudge", setNudgeEnabled(prefs.supportNudge, v, Date.now()))} ariaLabel={t("settings.general.supportReminder")} />
      </Row>
      <h4>{t("settings.general.calendar")}</h4>
      <Row label={t("settings.general.weekStart")}>
        <select value={prefs.weekStart} onChange={(e) => set("weekStart", Number(e.target.value) as Prefs["weekStart"])}>
          <option value={1}>{cap(weekdayName(1, "long"))}</option><option value={0}>{cap(weekdayName(0, "long"))}</option><option value={6}>{cap(weekdayName(6, "long"))}</option>
        </select>
      </Row>
      <Row label={t("settings.general.timeZone")} hint={t("settings.general.timeZoneHint")}>
        <select value={prefs.calTz} onChange={(e) => set("calTz", e.target.value)}>
          <option value="auto">{t("settings.general.tzAuto", { zone: systemTz() })}</option>
          {zoneList().map((z) => <option key={z} value={z}>{z}</option>)}
        </select>
      </Row>
      <Row label={t("settings.general.autoAddInvites")} hint={t("settings.general.autoAddInvitesHint")}>
        <Switch checked={prefs.autoAddInvites} onChange={(v) => set("autoAddInvites", v)} />
      </Row>
      <Row label={t("settings.general.eventReminders")} hint={t("settings.general.eventRemindersHint")}>
        <select value={prefs.eventReminderMin === null ? "" : String(prefs.eventReminderMin)} onChange={(e) => set("eventReminderMin", e.target.value === "" ? null : Number(e.target.value))}>
          <option value="">{t("settings.general.noReminder")}</option>
          {[0, 5, 10, 15, 30, 60].map((n) => <option key={n} value={n}>{n === 0 ? t("settings.general.remindAtStart") : n === 60 ? t("settings.general.remind1h") : t("settings.general.remindMinutes", { n })}</option>)}
        </select>
      </Row>
      <h4>{t("settings.general.attachments")}</h4>
      <Row label={t("settings.general.saveTo")} hint={t("settings.general.saveToHint")}>
        <div className="path-field">
          <code title={prefs.downloadDir ?? t("settings.general.downloads")}>{prefs.downloadDir ?? t("settings.general.downloads")}</code>
          <button
            className="btn small"
            onClick={async () => {
              const p = await api.pickFolder(t("settings.general.saveTo"));
              if (p) set("downloadDir", p);
            }}
          >
            {t("settings.general.change")}
          </button>
          {prefs.downloadDir && <button className="link small" onClick={() => set("downloadDir", null)}>{t("settings.general.useDownloads")}</button>}
        </div>
      </Row>
      <Row label={t("settings.general.askWhere")}>
        <Switch checked={prefs.askWhereToSave} onChange={(v) => set("askWhereToSave", v)} />
      </Row>
      <Row label={t("settings.general.afterSaving")}>
        <select value={prefs.afterSave} onChange={(e) => set("afterSave", e.target.value as Prefs["afterSave"])}>
          <option value="notify">{t("settings.general.showNotification")}</option>
          <option value="reveal">{t("settings.general.showInFolder")}</option>
          <option value="open">{t("settings.general.openFile")}</option>
        </select>
      </Row>
      <Row label={t("settings.general.warnExec")} hint={riskyHint()}>
        <Switch checked={prefs.warnExecutables} onChange={(v) => set("warnExecutables", v)} />
      </Row>
      <h4>{t("settings.general.scheduled")}</h4>
      <Row label={t("settings.general.catchUp")}>
        <select value={prefs.scheduledCatchUp} onChange={(e) => set("scheduledCatchUp", e.target.value as Prefs["scheduledCatchUp"])}>
          <option value="send">{t("settings.general.sendAtOpen")}</option>
          <option value="ask">{t("settings.general.askFirst")}</option>
        </select>
      </Row>
      <Row label={t("settings.general.retry")} hint={t("settings.general.retryHint")}>
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
  const t = useT();
  const { prefs, setPrefs } = useStore();
  return (
    <div>
      <h3>{t("settings.appearance.title")}</h3>
      <div className="muted small">{t("settings.appearance.intro")}</div>
      <AppearancePreview />

      <h4>{t("settings.appearance.theme")}</h4>
      <Cards
        value={prefs.theme}
        onChange={(v) => setPrefs({ theme: v })}
        options={[
          { key: "light", label: t("settings.appearance.light"), art: <Swatch /> },
          { key: "dark", label: t("settings.appearance.dark"), art: <Swatch dark /> },
          { key: "system", label: t("settings.appearance.system"), art: <Swatch half /> },
        ]}
      />
      <h4>{t("settings.appearance.primary")}</h4>
      <div className="muted small">{t("settings.appearance.primaryHint")}</div>
      <div className="accents" role="radiogroup" aria-label={t("settings.appearance.primary")}>
        {ACCENT_PRESETS.map(([hex, name]) => (
          <button
            key={hex}
            role="radio"
            aria-checked={prefs.accent.toLowerCase() === hex}
            aria-label={t(name)}
            title={t(name)}
            className={`swatch ${prefs.accent.toLowerCase() === hex ? "on" : ""}`}
            style={{ background: hex }}
            onClick={() => setPrefs({ accent: hex })}
          />
        ))}
        <label className="swatch-custom">
          <input type="color" value={validHex(prefs.accent) ? prefs.accent : DEFAULT_PREFS.accent} onChange={(e) => setPrefs({ accent: e.target.value })} aria-label={t("settings.appearance.customPrimary")} />
          <span className="muted small">{t("settings.appearance.custom")}</span>
        </label>
        {prefs.accent.toLowerCase() !== DEFAULT_PREFS.accent && (
          <button className="link small" onClick={() => setPrefs({ accent: DEFAULT_PREFS.accent })}>{t("settings.appearance.reset")}</button>
        )}
      </div>
      <h4>{t("settings.appearance.density")}</h4>
      <Cards
        value={prefs.density}
        onChange={(v) => setPrefs({ density: v })}
        options={[
          { key: "full", label: t("settings.appearance.full"), art: <DensityArt gap={13} rows={3} /> },
          { key: "medium", label: t("settings.appearance.medium"), art: <DensityArt gap={10} rows={4} /> },
          { key: "compact", label: t("settings.appearance.compact"), art: <DensityArt gap={7} rows={5} /> },
        ]}
      />
      <h4>{t("settings.appearance.readingPane")}</h4>
      <Cards
        value={prefs.readingPane}
        onChange={(v) => setPrefs({ readingPane: v })}
        options={[
          { key: "right", label: t("settings.appearance.right"), art: <PaneArt /> },
          { key: "bottom", label: t("settings.appearance.bottom"), art: <PaneArt bottom /> },
        ]}
      />
      <h4>{t("settings.appearance.messageList")}</h4>
      <Row label={t("settings.appearance.preview")}><Switch checked={prefs.preview} onChange={(v) => setPrefs({ preview: v })} /></Row>
      <Row label={t("settings.appearance.conversations")} hint={t("settings.appearance.conversationsHint")}><Switch checked={prefs.conversations} onChange={(v) => setPrefs({ conversations: v })} /></Row>
      <Row label={t("settings.appearance.focused")} hint={t("settings.appearance.focusedHint")}><Switch checked={prefs.focused} onChange={(v) => setPrefs({ focused: v })} /></Row>
      <Row label={t("settings.appearance.oldestOnTop")}><Switch checked={prefs.sortAsc} onChange={(v) => setPrefs({ sortAsc: v })} /></Row>
      <Row label={t("settings.appearance.textSize")}>
        <select value={prefs.fontSize} onChange={(e) => setPrefs({ fontSize: Number(e.target.value) })}>
          {/* i18n-ok: unit */}
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

function OAuthBlock({ kind, onAppPassword }: { kind: OAuthKind; onAppPassword: () => void }) {
  const t = useT();
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
  const [ended, setEnded] = useState<SignInEnd | null>(null);
  const goBtn = useRef<HTMLButtonElement>(null);
  const wasBusy = useRef(false);
  // the sign-in ended without an account: the Cancel button that had the focus is gone, so the focus goes back to the button that started it
  useEffect(() => {
    if (busy) wasBusy.current = true;
    else if (wasBusy.current) {
      wasBusy.current = false;
      if (!document.activeElement || document.activeElement === document.body) goBtn.current?.focus();
    }
  }, [busy]);
  // a sign-in is waiting for the browser: leaving this screen (closing Settings, switching the tab) ends the wait and frees the port
  const waiting = useRef(false);
  useEffect(() => () => { if (waiting.current) void api.oauthCancel().catch(() => undefined); }, []);
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
    setEnded(null);
    waiting.current = true;
    try {
      const acc = kind === "google"
        ? await api.googleSignIn(cid, sec, name)
        : await api.microsoftSignIn(cid, "", tenant, name);
      waiting.current = false;
      // closes this dialog, opens the new account's Inbox and starts its first sync
      void useStore.getState().accountAdded(acc);
    } catch (e) {
      waiting.current = false;
      // timed out, cancelled, refused, or the organization has to approve: a calm notice with advice, and no toast
      const end = signInEnd(kind, "mail", e);
      if (end) {
        setEnded(end);
      } else {
        setError(friendlyError(e)); // stay here: the message is next to the button, and in a toast
        showToast(() => friendlyError(e), undefined, "error");
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="set-card">
        <h4>{t("settings.add.signInWith", { provider: cfg.label })}</h4>
        <div className="muted small">{t("settings.add.noPassword", { provider: cfg.label })}</div>
        <div className="form">
          {!fromEnv && (
            <details className="advanced">
              <summary>{t("settings.add.advanced")}</summary>
              <div className="form">
                <label>{t("settings.add.clientId")}</label>
                <input aria-label={t("settings.add.clientId")} value={cid} onChange={(e) => setCid(e.target.value)} placeholder={cfg.idPlaceholder} />
                {kind === "google" && (
                  <>
                    <label>{t("settings.add.clientSecret")}</label>
                    <input aria-label={t("settings.add.clientSecret")} type="password" value={sec} onChange={(e) => setSec(e.target.value)} placeholder={secSaved ? t("settings.add.savedIn", { store: credStore() }) : ""} />
                  </>
                )}
              </div>
            </details>
          )}
          {kind === "microsoft" && (
            <>
              <label>{t("settings.add.tenant")}</label>
              <input aria-label={t("settings.add.tenant")} value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder="common" />
              <div className="muted small">{t("settings.add.tenantHint")}</div>
            </>
          )}
          <label>{t("settings.add.displayNameOpt")}</label>
          <input aria-label={t("settings.add.displayNameOpt")} placeholder={t("settings.add.yourName")} value={name} onChange={(e) => setName(e.target.value)} />
          <div className="row-inline">
            <button ref={goBtn} className="btn primary" disabled={busy || (!fromEnv && !cid)} onClick={() => void go()}>
              {busy ? t("settings.add.waitingFor", { provider: cfg.label }) : t("settings.add.signInWith", { provider: cfg.label })}
            </button>
            {busy && <button className="btn" autoFocus onClick={() => void api.oauthCancel()}>{t("common.cancel")}</button>}
          </div>
        </div>
      </div>
      {/* what the sign-in is doing or how it ended: ONE slot of fixed size under the card, so the button above never moves (it used to be rows above and below it) */}
      <div className="signin-slot">
        {busy ? <SignInWaiting provider={kind} lead={t("signin.waiting.mail")} />
          : ended ? <SignInEnded provider={kind} purpose="mail" end={ended} onAppPassword={kind === "google" ? onAppPassword : undefined} />
          : error ? <div className="notice bad" role="alert">{error}</div>
          : !fromEnv && !cid ? <div className="muted small" role="status">{t("settings.add.notAvailable", { provider: cfg.label })}</div>
          : null}
      </div>
    </>
  );
}

/** The sentence that says where the detected server settings came from, per source. */
const SOURCE_LABEL: Record<Discovered["source"], Key> = {
  "built-in": "settings.add.found.builtIn",
  autoconfig: "settings.add.found.autoconfig",
  ispdb: "settings.add.found.ispdb",
  "dns-srv": "settings.add.found.dnsSrv",
  mx: "settings.add.found.mx",
  guess: "settings.add.found.guess",
};

function ImapForm({ initialProvider = "custom" }: { initialProvider?: string }) {
  const t = useT();
  const { showToast } = useStore();
  const [provider, setProvider] = useState(initialProvider);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [pw, setPw] = useState("");
  const startAdv = (p: string) => ({ ...PROVIDERS[p], imapSsl: PROVIDERS[p].imapSsl ?? PROVIDERS[p].imapPort === 993 });
  const [adv, setAdv] = useState(startAdv(initialProvider));
  const [username, setUsername] = useState("");
  const [sepSmtp, setSepSmtp] = useState(false);
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpPw, setSmtpPw] = useState("");
  const [insecure, setInsecure] = useState(!!PROVIDERS[initialProvider].insecure);
  const [busy, setBusy] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [found, setFound] = useState<Discovered | null>(null);
  const [error, setError] = useState("");
  const addBtn = useRef<HTMLButtonElement>(null);
  const wasBusy = useRef(false);
  // the attempt failed: the button was disabled while it ran (the focus fell off it), so the focus goes back to it
  useEffect(() => {
    if (busy) wasBusy.current = true;
    else if (wasBusy.current) {
      wasBusy.current = false;
      if (!document.activeElement || document.activeElement === document.body) addBtn.current?.focus();
    }
  }, [busy]);
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
        showToast(() => t("settings.add.noServerFound"), undefined, "error");
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
      showToast(() => friendlyError(e), undefined, "error");
    } finally {
      setDetecting(false);
    }
  };
  /** which attempt is the one on screen: Cancel (or a newer attempt) leaves an older one without a voice */
  const attempt = useRef(0);
  const cancel = () => {
    attempt.current++;
    setBusy(false);
    setError("");
    void api.cancelAddAccount().catch(() => undefined);
  };
  const add = async () => {
    const mine = ++attempt.current;
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
      if (mine !== attempt.current) return; // (cancelled: the person has gone on; nothing was stored)
      setError(friendlyError(e)); // stay here with what was typed: the message is next to the button, and in a toast
      showToast(() => friendlyError(e), undefined, "error");
    } finally {
      if (mine === attempt.current) setBusy(false);
    }
  };
  return (
    <>
      <div className="set-card">
        <h4>{t("settings.add.otherAccount")}</h4>
        <div className="form">
          <label>{t("settings.add.provider")}</label>
          <select aria-label={t("settings.add.provider")} value={provider} onChange={(e) => pick(e.target.value)}>
            {Object.entries(PROVIDERS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          {PROVIDERS[provider].hint && <div className="notice">{PROVIDERS[provider].hint}</div>}
          <label>{t("settings.add.email")}</label>
          <div className="row-inline">
            <input aria-label={t("settings.add.email")} placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <button className="btn" disabled={detecting || !email.includes("@")} onClick={() => void detect()} title={t("settings.add.detectTitle")}>
              {detecting ? t("settings.add.detecting") : t("settings.add.detect")}
            </button>
          </div>
          {found && (
            <div className="notice">
              {t(SOURCE_LABEL[found.source])} {found.source === "guess" ? `${t("settings.add.checkThem")} ` : ""}
              {found.oauth && <>{t("settings.add.oauthAlso", { provider: found.oauth === "google" ? "Google" : "Microsoft" })}</>}
            </div>
          )}
          <label>{t("settings.add.displayName")}</label>
          <input aria-label={t("settings.add.displayName")} placeholder={t("settings.add.yourName")} value={name} onChange={(e) => setName(e.target.value)} />
          <label>{t("settings.add.password")}</label>
          <input aria-label={t("settings.add.password")} type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
          {showAdv && (
            <>
              <label>{t("settings.add.username")}</label>
              <input aria-label={t("settings.add.username")} placeholder="name@example.com" value={username} onChange={(e) => setUsername(e.target.value)} />
              <label>{t("settings.add.imapServer")}</label>
              <div className="row-inline">
                <input aria-label={t("settings.add.imapHost")} placeholder="imap.example.com" value={adv.imapHost} onChange={(e) => setAdv({ ...adv, imapHost: e.target.value })} />
                <input type="number" aria-label={t("settings.add.imapPort")} placeholder="993" value={adv.imapPort} onChange={(e) => setAdv({ ...adv, imapPort: Number(e.target.value) })} />
                <select aria-label={t("settings.add.imapSecurity")} value={adv.imapSsl ? "ssl" : "starttls"} onChange={(e) => setAdv({ ...adv, imapSsl: e.target.value === "ssl" })}>
                  {/* i18n-ok: protocol names */}
                  <option value="ssl">SSL/TLS</option><option value="starttls">STARTTLS</option>
                </select>
              </div>
              <label>{t("settings.add.smtpServer")}</label>
              <div className="row-inline">
                <input aria-label={t("settings.add.smtpHost")} placeholder="smtp.example.com" value={adv.smtpHost} onChange={(e) => setAdv({ ...adv, smtpHost: e.target.value })} />
                <input type="number" aria-label={t("settings.add.smtpPort")} placeholder="465" value={adv.smtpPort} onChange={(e) => setAdv({ ...adv, smtpPort: Number(e.target.value) })} />
                <select aria-label={t("settings.add.smtpSecurity")} value={adv.smtpSecurity} onChange={(e) => setAdv({ ...adv, smtpSecurity: e.target.value as "ssl" | "starttls" })}>
                  {/* i18n-ok: protocol names */}
                  <option value="ssl">SSL/TLS</option><option value="starttls">STARTTLS</option>
                </select>
              </div>
              <div className="row-inline">
                <Switch checked={sepSmtp} onChange={setSepSmtp} label={t("settings.add.sepSmtp")} />
              </div>
              {sepSmtp && (
                <>
                  <label>{t("settings.add.smtpUsername")}</label>
                  <input aria-label={t("settings.add.smtpUsername")} value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} placeholder={username || email} />
                  <label>{t("settings.add.smtpPasswordLabel")}</label>
                  <input aria-label={t("settings.add.smtpPassword")} type="password" value={smtpPw} onChange={(e) => setSmtpPw(e.target.value)} />
                </>
              )}
              <div className="row-inline">
                <Switch checked={insecure} onChange={setInsecure} label={t("settings.add.trustCert")} />
              </div>
              {insecure && (
                <div className="notice">
                  {t("settings.add.trustCertWarning")}
                </div>
              )}
            </>
          )}
          <button ref={addBtn} className="btn primary" disabled={busy || !email || !pw} onClick={() => void add()}>
            <Plus size={14} /> {busy ? t("settings.add.connecting") : t("settings.add.addAccount")}
          </button>
          <div className="muted small">{t("settings.add.passwordsStored", { store: credStore() })}</div>
        </div>
      </div>
      {/* how the attempt ended: one slot of fixed size under the card, so the Add button never moves (the error used to be a row above it) */}
      <div className="signin-slot">
        {error ? (
          <div className="notice bad" role="alert">{error}</div>
        ) : busy ? (
          // the wait for the server, or for a locked keyring, can be long: it can be ended
          <div className="notice" role="status">
            {t("settings.add.connecting")} <button className="link" onClick={cancel}>{t("common.cancel")}</button>
          </div>
        ) : null}
      </div>
    </>
  );
}

function AddAccountTab() {
  const t = useT();
  const [kind, setKind] = useState<OAuthKind | "imap">("google");
  // "Add Gmail with an app password" (after a Google sign-in that ended without access) opens the form with the Gmail preset
  const [preset, setPreset] = useState("custom");
  return (
    <div>
      <h3>{t("settings.add.addAccount")}</h3>
      <Seg value={kind} onChange={(k) => { setPreset("custom"); setKind(k); }} options={[["google", "Google"], ["microsoft", "Microsoft"], ["imap", t("settings.add.imapTab")]]} />
      {kind === "imap" ? <ImapForm key={preset} initialProvider={preset} /> : <OAuthBlock key={kind} kind={kind} onAppPassword={() => { setPreset("gmail"); setKind("imap"); }} />}
    </div>
  );
}

// ---------------------------------------------------------------- Mailbox panels (scope = null | accountId)
function ComposingPanel({ scope }: { scope: string | null }) {
  const t = useT();
  const { prefs, setPrefs } = useStore();
  const [sigs, setSigs] = useState<Signature[]>([]);
  useEffect(() => void api.listSignatures().then(setSigs), []);
  const usable = sigs.filter((s) => !s.accountId || s.accountId === scope || scope === null);
  return (
    <>
      <OvRow scope={scope} k="replyDefault" label={t("settings.composing.replyDefault")}>
        {(v, set) => (
          <select value={v} onChange={(e) => set(e.target.value as Prefs["replyDefault"])}>
            <option value="reply">{t("settings.action.reply")}</option>
            <option value="replyAll">{t("settings.composing.replyAll")}</option>
          </select>
        )}
      </OvRow>
      <OvRow scope={scope} k="undoSeconds" label={t("settings.composing.undoSend")} hint={t("settings.composing.undoSendHint")}>
        {(v, set) => (
          <select value={v} onChange={(e) => set(Number(e.target.value))}>
            {[0, 5, 10, 20, 30, 60].map((n) => <option key={n} value={n}>{n === 0 ? t("common.off") : t("settings.unit.seconds", { n })}</option>)}
          </select>
        )}
      </OvRow>
      <OvRow scope={scope} k="autoCc" label={t("settings.composing.autoCc")} hint={t("settings.composing.autoCcHint")}>
        {(v, set) => <input value={v} onChange={(e) => set(e.target.value)} placeholder="name@example.com" />}
      </OvRow>
      <OvRow scope={scope} k="autoBcc" label={t("settings.composing.autoBcc")}>
        {(v, set) => <input value={v} onChange={(e) => set(e.target.value)} placeholder="name@example.com" />}
      </OvRow>
      <OvRow scope={scope} k="signatureId" label={t("settings.composing.signature")} hint={t("settings.composing.signatureHint")}>
        {(v, set) => (
          <select value={v} onChange={(e) => set(e.target.value)}>
            <option value="">{t("settings.composing.sigAuto")}</option>
            <option value="none">{t("settings.composing.sigNone")}</option>
            {usable.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
      </OvRow>
      <OvRow scope={scope} k="inlinePictures" label={t("settings.composing.pictures")} hint={t("settings.composing.picturesHint")}>
        {(v, set) => (
          <select value={v} onChange={(e) => set(e.target.value as Prefs["inlinePictures"])}>
            <option value="inline">{t("settings.composing.picInline")}</option>
            <option value="attach">{t("settings.composing.picAttach")}</option>
          </select>
        )}
      </OvRow>
      <OvRow scope={scope} k="autoResizePictures" label={t("settings.composing.resize")} hint={t("settings.composing.resizeHint")}>
        {(v, set) => <Switch checked={v} onChange={set} />}
      </OvRow>
      <OvRow scope={scope} k="signatureOnReply" label={t("settings.composing.sigOnReply")}>
        {(v, set) => <Switch checked={v} onChange={set} />}
      </OvRow>
      {/* one setting for the whole app, not per mailbox. Stored only: the compose window that reads it comes with WP6b (popout/entry.ts) */}
      {scope === null && (
        <Row label={t("settings.composing.popout")} hint={t("settings.composing.popoutHint")}>
          <Switch checked={prefs.popoutCompose} onChange={(v) => setPrefs({ popoutCompose: v })} />
        </Row>
      )}
      {scope === null && <DefaultFontRow />}
      {scope === null && <PasteDefaultRow />}
    </>
  );
}

/** Settings > Composing > Default font: the family and size a new message, a reply and a forward start in (editor/baseFont.ts); the colour is Automatic. */
function DefaultFontRow() {
  const t = useT();
  const { prefs, setPrefs } = useStore();
  const base = baseFromPrefs(prefs);
  // a name that is not in the list (an older value, a font typed by hand) stays selectable
  const names = FONTS.some((f) => f.name === prefs.composeFontName) ? FONTS.map((f) => f.name) : [prefs.composeFontName, ...FONTS.map((f) => f.name)];
  const sizes = SIZES.includes(prefs.composeFontSize) ? SIZES : [...SIZES, prefs.composeFontSize].sort((a, b) => a - b);
  return (
    <Row label={t("settings.composing.font")} hint={t("settings.composing.fontHint")} id="composeFont">
      <div className="row-inline" style={{ margin: 0 }}>
        <select aria-label={t("compose.fmt.font")} value={prefs.composeFontName} onChange={(e) => setPrefs({ composeFontName: e.target.value })} style={{ fontFamily: base.family }}>
          {names.map((n) => <option key={n} value={n} style={{ fontFamily: stackFor(n) }}>{n}</option>)}
        </select>
        <select aria-label={t("compose.fmt.fontSize")} value={prefs.composeFontSize} onChange={(e) => setPrefs({ composeFontSize: Number(e.target.value) })} style={{ flex: "0 0 5em" }}>
          {sizes.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      {/* i18n-ok: a font sample, the same in every language */}
      <div className="font-sample" style={{ fontFamily: base.family, fontSize: `${base.size}pt` }} aria-hidden="true">Aa Bb Cc 123</div>
    </Row>
  );
}

/** Settings > Composing > When pasting from other apps: what Ctrl+V does with text copied from other programs (editor/pasteOptions.tsx); Ctrl+Shift+V is always text only. */
function PasteDefaultRow() {
  const t = useT();
  const { prefs, setPrefs } = useStore();
  const os = usePlatform((s) => s.os);
  return (
    <Row label={t("settings.composing.paste")} hint={kbd(t("settings.composing.pasteHint"), os)} id="pasteDefault">
      <select aria-label={t("settings.composing.paste")} value={prefs.pasteDefault} onChange={(e) => setPrefs({ pasteDefault: e.target.value as Prefs["pasteDefault"] })}>
        <option value="source">{t("compose.paste.keepSource")}</option>
        <option value="merge">{t("compose.paste.merge")}</option>
        <option value="text">{t("compose.paste.textOnly")}</option>
      </select>
    </Row>
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
  const t = useT();
  const own = items.filter((i) => (i.accountId ?? null) === scope);
  const inherited = scope ? items.filter((i) => !i.accountId) : [];
  return (
    <>
      {own.length === 0 && <div className="muted small pad">{empty}</div>}
      {own.map((i) => (
        <div key={i.id} className="list-row" onClick={() => onOpen(i)}>
          <div className="lr-name"><span className="lr-title">{title(i)}</span>{render?.(i)}</div>
          {tags?.(i) && <span className="lr-tags">{tags(i)}</span>}
          <button className="icon-btn" title={t("common.delete")} aria-label={t("common.delete")} onClick={(e) => { e.stopPropagation(); onDelete(i); }}><Trash2 size={15} /></button>
        </div>
      ))}
      {inherited.length > 0 && (
        <>
          <div className="muted small inh-title">{t("settings.scope.alsoApplies")}</div>
          {inherited.map((i) => (
            <div key={i.id} className="list-row inherited">
              <div className="lr-name"><span className="lr-title">{title(i)}</span></div>
              <span className="lr-tags"><span className="ov-tag">{t("settings.scope.allAccounts")}</span></span>
            </div>
          ))}
        </>
      )}
    </>
  );
}

function SignaturesPanel({ scope }: { scope: string | null }) {
  const t = useT();
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
        empty={scope ? t("settings.sig.emptyAccount") : t("settings.sig.empty")}
        title={(s) => s.name}
        tags={(s) => s.isDefault && <span className="ov-tag own">{t("settings.sig.default")}</span>}
        onOpen={setCur}
        onDelete={async (s) => {
          if (await confirm({ title: t("settings.sig.deleteTitle", { name: s.name }), confirmLabel: t("common.delete"), danger: true })) {
            await api.deleteSignature(s.id);
            void load();
          }
        }}
      />
      <button className="btn" onClick={() => setCur({ id: crypto.randomUUID(), accountId: scope, name: t("settings.sig.new"), html: "", isDefault: !own.some((s) => s.isDefault) })}>
        <Plus size={14} /> {t("settings.sig.new")}
      </button>
      {cur && (
        <div className="form set-card">
          <label>{t("settings.form.name")}</label>
          <input aria-label={t("settings.form.name")} placeholder={t("settings.sig.namePlaceholder")} value={cur.name} onChange={(e) => setCur({ ...cur, name: e.target.value })} />
          <label>{t("settings.composing.signature")}</label>
          <RichEditor pictures key={cur.id} label={t("settings.composing.signature")} value={cur.html} onChange={(html) => setCur((c) => (c ? { ...c, html } : c))} placeholder={t("settings.sig.bodyPlaceholder")} />
          <Switch checked={cur.isDefault} onChange={(v) => setCur({ ...cur, isDefault: v })} label={scope ? t("settings.sig.defaultThis") : t("settings.sig.defaultAll")} />
          <div className="row-inline">
            <button className="btn primary" onClick={async () => { await api.saveSignature(cur); setCur(null); void load(); }}>{t("common.save")}</button>
            <button className="btn" onClick={() => setCur(null)}>{t("common.cancel")}</button>
          </div>
        </div>
      )}
    </>
  );
}

function TemplatesPanel({ scope }: { scope: string | null }) {
  const t = useT();
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
        empty={scope ? t("settings.tpl.emptyAccount") : t("settings.tpl.empty")}
        title={(tpl) => tpl.name}
        onOpen={setCur}
        onDelete={async (tpl) => {
          if (await confirm({ title: t("settings.tpl.deleteTitle", { name: tpl.name }), confirmLabel: t("common.delete"), danger: true })) {
            await api.deleteTemplate(tpl.id);
            void load();
          }
        }}
      />
      <button className="btn" onClick={() => setCur({ id: crypto.randomUUID(), accountId: scope, name: t("settings.tpl.new"), subject: "", body: "" })}>
        <Plus size={14} /> {t("settings.tpl.new")}
      </button>
      {cur && (
        <div className="form set-card">
          <label>{t("settings.form.name")}</label>
          <input aria-label={t("settings.form.name")} placeholder={t("settings.tpl.namePlaceholder")} value={cur.name} onChange={(e) => setCur({ ...cur, name: e.target.value })} />
          <label>{t("settings.tpl.subjectOpt")}</label>
          <input aria-label={t("settings.tpl.subjectOpt")} placeholder={t("settings.tpl.subjectPlaceholder")} value={cur.subject} onChange={(e) => setCur({ ...cur, subject: e.target.value })} />
          <label>{t("settings.tpl.message")}</label>
          <RichEditor pictures key={cur.id} label={t("settings.tpl.message")} value={cur.body} onChange={(body) => setCur((c) => (c ? { ...c, body } : c))} minHeight={180} />
          <div className="row-inline">
            <button className="btn primary" onClick={async () => { await api.saveTemplate(cur); setCur(null); void load(); }}>{t("common.save")}</button>
            <button className="btn" onClick={() => setCur(null)}>{t("common.cancel")}</button>
          </div>
        </div>
      )}
    </>
  );
}

/** The words a filter is described with in the list (field, condition, action), lower case as the rule reads: "from contains “x”". */
const FIELD_WORD: Record<Rule["field"], Key> = { from: "settings.filters.wFrom", to: "settings.filters.wTo", subject: "settings.filters.wSubject", any: "settings.filters.wAny" };
const OP_WORD: Record<Rule["op"], Key> = { contains: "settings.filters.opContains", equals: "settings.filters.opEquals" };
const ACTION_WORD: Record<Rule["action"], Key> = {
  archive: "settings.filters.wArchive", trash: "settings.filters.wTrash", junk: "settings.filters.wJunk", read: "settings.filters.wRead",
  star: "settings.filters.wStar", pin: "settings.filters.wPin", move: "settings.filters.wMove",
};

function FiltersPanel({ scope }: { scope: string | null }) {
  const t = useT();
  const { folders, showToast, confirm } = useStore();
  const [list, setList] = useState<Rule[]>([]);
  const [cur, setCur] = useState<Rule | null>(null);
  const load = () => api.listRules().then(setList);
  useEffect(() => void load(), []);
  const roles = Array.from(new Set(folders.filter((f) => !scope || f.accountId === scope).map((f) => f.key))).filter((k) => !["inbox", "sent", "drafts"].includes(k));
  return (
    <>
      <div className="muted small pad">{t("settings.filters.intro")}</div>
      <ScopedList
        scope={scope}
        items={list}
        empty={t("settings.filters.empty")}
        title={(r) => r.name || t("settings.filters.autoName", { field: t(FIELD_WORD[r.field]), op: t(OP_WORD[r.op]), value: r.value })}
        tags={(r) => !r.enabled && <span className="ov-tag">{t("settings.filters.off")}</span>}
        render={(r) => <div className="muted small">{t(ACTION_WORD[r.action])}{r.arg ? ` → ${folderLabel(r.arg)}` : ""}</div>}
        onOpen={setCur}
        onDelete={async (r) => {
          if (await confirm({ title: t("settings.filters.deleteTitle"), confirmLabel: t("common.delete"), danger: true })) {
            await api.deleteRule(r.id);
            void load();
          }
        }}
      />
      <button className="btn" onClick={() => setCur({ id: crypto.randomUUID(), accountId: scope, name: "", field: "from", op: "contains", value: "", action: "archive", arg: null, enabled: true })}>
        <Plus size={14} /> {t("settings.filters.new")}
      </button>
      {cur && (
        <div className="form set-card">
          <label>{t("settings.form.name")}</label>
          <input aria-label={t("settings.form.name")} placeholder={t("settings.filters.namePlaceholder")} value={cur.name} onChange={(e) => setCur({ ...cur, name: e.target.value })} />
          <label>{t("settings.filters.when")}</label>
          <div className="row-inline">
            <select aria-label={t("settings.filters.ruleField")} value={cur.field} onChange={(e) => setCur({ ...cur, field: e.target.value as Rule["field"] })}>
              <option value="from">{t("settings.filters.from")}</option><option value="to">{t("settings.filters.to")}</option><option value="subject">{t("settings.filters.subject")}</option><option value="any">{t("settings.filters.anyField")}</option>
            </select>
            <select aria-label={t("settings.filters.ruleCondition")} value={cur.op} onChange={(e) => setCur({ ...cur, op: e.target.value as Rule["op"] })}>
              <option value="contains">{t("settings.filters.opContains")}</option><option value="equals">{t("settings.filters.opEquals")}</option>
            </select>
            <input aria-label={t("settings.filters.ruleText")} placeholder="newsletter@example.com" value={cur.value} onChange={(e) => setCur({ ...cur, value: e.target.value })} />
          </div>
          <label>{t("settings.filters.then")}</label>
          <div className="row-inline">
            <select aria-label={t("settings.filters.ruleAction")} value={cur.action} onChange={(e) => setCur({ ...cur, action: e.target.value as Rule["action"] })}>
              <option value="archive">{t("settings.action.archive")}</option><option value="trash">{t("common.delete")}</option><option value="junk">{t("settings.filters.toJunk")}</option>
              <option value="read">{t("settings.action.read")}</option><option value="star">{t("settings.action.flag")}</option><option value="pin">{t("settings.action.pin")}</option><option value="move">{t("settings.filters.toFolder")}</option>
            </select>
            {cur.action === "move" && (
              <select aria-label={t("settings.filters.targetFolder")} value={cur.arg ?? ""} onChange={(e) => setCur({ ...cur, arg: e.target.value })}>
                <option value="">{t("settings.filters.chooseFolder")}</option>
                {roles.map((k) => <option key={k} value={k}>{folderLabel(k, folders.find((f) => f.key === k)?.name)}</option>)}
              </select>
            )}
          </div>
          <Switch checked={cur.enabled} onChange={(v) => setCur({ ...cur, enabled: v })} label={t("settings.filters.enabled")} />
          <div className="row-inline">
            <button
              className="btn primary"
              disabled={!cur.value.trim() || (cur.action === "move" && !cur.arg)}
              onClick={async () => { await api.saveRule(cur); setCur(null); void load(); showToast(t("settings.filters.saved"), undefined, "success"); }}
            >
              {t("common.save")}
            </button>
            <button className="btn" onClick={() => setCur(null)}>{t("common.cancel")}</button>
          </div>
        </div>
      )}
    </>
  );
}

function NotifyPanel({ scope }: { scope: string | null }) {
  const t = useT();
  const os = usePlatform((s) => s.os);
  const windows = os === "windows";
  return (
    <>
      <OvRow scope={scope} k="notifications" label={t("settings.notify.desktop")}>
        {(v, set) => <Switch checked={v} onChange={set} />}
      </OvRow>
      {!windows && <div className="muted small">{t("settings.notify.noButtons", { os: os === "macos" ? "macOS" : "Linux" })}</div>}
      <OvRow scope={scope} k="smartNotifications" label={t("settings.notify.smart")} hint={t("settings.notify.smartHint")}>
        {(v, set) => <Switch checked={v} onChange={set} />}
      </OvRow>
      <OvRow scope={scope} k="notifyPreview" label={t("settings.appearance.preview")}>
        {(v, set) => <Switch checked={v} onChange={set} />}
      </OvRow>
      <OvRow scope={scope} k="notifySound" label={t("settings.notify.sound")} hint={windows ? undefined : t("settings.notify.soundHint")}>
        {(v, set) => <SoundSelect value={v} onChange={set} />}
      </OvRow>
      {windows && (
      <OvRow scope={scope} k="notifyActions" label={t("settings.notify.buttons")} hint={t("settings.notify.buttonsHint")}>
        {(v, set) => (
          <div className="three">
            {[0, 1, 2].map((i) => (
              <select
                key={i}
                aria-label={t("settings.notify.buttonN", { n: i + 1 })}
                value={v[i] ?? "none"}
                onChange={(e) => {
                  const a = [...v];
                  while (a.length < 3) a.push("none");
                  a[i] = e.target.value;
                  set(a);
                }}
              >
                {NOTIFY_ACTIONS.map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}
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
  const t = useT();
  const { prefs, setPrefs } = useStore();
  // a value outside the presets (edited by hand) stays selectable instead of silently showing another one
  const caps = MAX_DOWNLOAD_PRESETS.includes(prefs.maxDownload) ? MAX_DOWNLOAD_PRESETS : [...MAX_DOWNLOAD_PRESETS, prefs.maxDownload].sort((a, b) => a - b);
  return (
    <>
      <OvRow scope={scope} k="loadRemote" id="loadRemote" label={t("settings.reading.loadRemote")} hint={t("settings.reading.loadRemoteHint")}>
        {(v, set) => <Switch checked={v} onChange={set} />}
      </OvRow>
      <OvRow scope={scope} k="inlineAutoLoadMB" label={t("settings.reading.inlineAuto")} hint={t("settings.reading.inlineAutoHint")}>
        {(v, set) => (
          <select value={v} onChange={(e) => set(Number(e.target.value) as Prefs["inlineAutoLoadMB"])}>
            <option value={2}>{t("settings.reading.mbEach", { n: 2 })}</option>
            <option value={5}>{t("settings.reading.mbEach", { n: 5 })}</option>
            <option value={0}>{t("settings.reading.always")}</option>
          </select>
        )}
      </OvRow>
      <OvRow scope={scope} k="syncMinutes" label={t("settings.reading.fetchEvery")}>
        {(v, set) => (
          <select value={v} onChange={(e) => set(Number(e.target.value))}>
            {[1, 2, 5, 10, 15, 30].map((n) => <option key={n} value={n}>{t("settings.reading.minutes", { n })}</option>)}
          </select>
        )}
      </OvRow>
      <OvRow scope={scope} k="pushMail" label={t("settings.reading.push")} hint={t("settings.reading.pushHint")}>
        {(v, set) => <Switch checked={v} onChange={set} />}
      </OvRow>
      {/* one value for every mailbox (each mailbox is counted on its own), so no per-mailbox override */}
      <Row
        label={t("settings.reading.maxDownload")}
        id="maxDownload"
        hint={t("settings.reading.maxDownloadHint")}
      >
        <select value={prefs.maxDownload} onChange={(e) => setPrefs({ maxDownload: Number(e.target.value) })}>
          {caps.map((n) => <option key={n} value={n}>{n === DEFAULT_PREFS.maxDownload ? t("settings.reading.maxDefault", { n: fmtNumber(n) }) : fmtNumber(n)}</option>)}
        </select>
      </Row>
    </>
  );
}

function FoldersPanel({ scope }: { scope: string | null }) {
  const t = useT();
  const { folders, prefs, setPrefs } = useStore();
  const isFav = (id: string) => prefs.favorites.includes(id);
  const toggle = (id: string) => setPrefs({ favorites: isFav(id) ? prefs.favorites.filter((f) => f !== id) : [...prefs.favorites, id] });
  const keys = (scope ? folders.filter((f) => f.accountId === scope).map((f) => ({ key: f.key, label: folderLabel(f.key, f.name) })) : ["inbox", "drafts", "sent", "archive", "junk", "trash"].map((k) => ({ key: k, label: folderLabel(k) }))).filter((k) => folderVisible(folders, scope, k.key));
  return (
    <>
      <div className="muted small pad">{scope ? t("settings.folders.account") : t("settings.folders.all")}</div>
      {keys.map(({ key, label }) => (
        <Row key={key} label={label}>
          <Switch checked={isFav(`${scope ?? "*"}|${key}`)} onChange={() => toggle(`${scope ?? "*"}|${key}`)} />
        </Row>
      ))}
    </>
  );
}

function ProfilePanel({ account }: { account: Account }) {
  const t = useT();
  const accent = useStore((s) => s.prefs.accent);
  const color = accountColor(account, accent);
  const upd = async (patch: Partial<Account>) => {
    const n = { ...account, ...patch };
    await api.updateAccount(account.id, n.displayName, n.color ?? null);
    useStore.setState((s) => ({ accounts: s.accounts.map((x) => (x.id === account.id ? n : x)) }));
  };
  return (
    <>
      <Row label={t("settings.add.displayName")} hint={t("settings.profile.displayNameHint")}><input defaultValue={account.displayName} placeholder={t("settings.add.yourName")} onBlur={(e) => void upd({ displayName: e.target.value })} /></Row>
      <Row label={t("settings.profile.color")} hint={t("settings.profile.colorHint")}>
        <div className="accents" role="radiogroup" aria-label={t("settings.profile.mailboxColor")} style={{ margin: 0, gap: 8, justifyContent: "flex-end" }}>
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
            <input type="color" aria-label={t("settings.profile.customColor")} value={color} onChange={(e) => void upd({ color: e.target.value })} />
          </label>
        </div>
      </Row>
    </>
  );
}

/** "push" while the account's Inbox connection (IMAP IDLE) is running, otherwise "polling"; kept up to date by the backend's idle-state event. */
function usePushState(accountId: string): string {
  const [state, setState] = useState("polling");
  useEffect(() => {
    let dead = false;
    let off: (() => void) | undefined;
    void api.idleStates().then((m) => { if (!dead) setState(m[accountId] ?? "polling"); }).catch(() => {});
    void listen<{ accountId: string; state: string }>("idle-state", (e) => {
      if (e.payload.accountId === accountId) setState(e.payload.state);
    }).then((u) => { if (dead) u(); else off = u; }).catch(() => {});
    return () => { dead = true; off?.(); };
  }, [accountId]);
  return state;
}

function ServerPanel({ account, close }: { account: Account; close: () => void }) {
  const t = useT();
  const { confirm } = useStore();
  const push = usePushState(account.id);
  const remove = async () => {
    const ok = await confirm({
      title: t("settings.server.removeTitle", { email: account.email }),
      body: t("settings.server.removeBody"),
      confirmLabel: t("settings.server.removeAccount"),
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
      <ReauthNotice account={account} />
      {/* i18n-ok: provider + protocol names */}
      <Row label={t("settings.server.signIn")}>{account.auth === "oauth_google" ? "Google (OAuth 2.0)" : account.auth === "oauth_microsoft" ? "Microsoft (OAuth 2.0)" : t("settings.server.passwordStored", { store: credStore() })}</Row>
      <Row label={t("settings.server.incoming")}>{account.imapHost}:{account.imapPort}</Row>
      <Row label={t("settings.server.newMail")} hint={t("settings.server.newMailHint")}>{push === "push" ? t("settings.server.push") : t("settings.server.polling")}</Row>
      <Row label={t("settings.server.outgoing")}>{account.smtpHost}:{account.smtpPort} ({account.smtpSecurity})</Row>
      {account.smtpUsername && <Row label={t("settings.server.smtpLogin")}>{account.smtpUsername}</Row>}
      {account.tlsInsecure && <Row label={t("settings.server.cert")} hint={t("settings.server.certHint")}>{t("settings.server.notVerified")}</Row>}
      <Row label={t("settings.server.removeAccount")} hint={t("settings.server.removeHint")}>
        <button className="btn danger" onClick={() => void remove()}><Trash2 size={14} /> {t("common.remove")}</button>
      </Row>
    </>
  );
}

/** Settings > mailbox > Calendar: sync this mailbox's Google / Outlook calendars (a separate, calendar-only consent in the browser). */
function CalendarPanel({ account }: { account: Account }) {
  const t = useT();
  const { confirm, showToast, calSources, loadCalSources, bumpCal, prefs } = useStore();
  const kind = calendarSyncKind(account);
  const src: CalSource | undefined = calSources.find((s) => s.accountId === account.id);
  const [connecting, setConnecting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ended, setEnded] = useState<SignInEnd | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const cancelBtn = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null); // what started the consent (the switch or "Allow again"): it gets the focus back when the consent ends
  const switchBox = useRef<HTMLSpanElement>(null);
  useEffect(() => void loadCalSources(), [loadCalSources]);
  // "Last synced 3 min ago" stays current
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 20_000);
    return () => clearInterval(timer);
  }, []);
  // the Cancel button takes the focus when the switch is turned on and disabled
  useEffect(() => {
    if (connecting) cancelBtn.current?.focus();
    else if (opener.current) {
      // the consent ended and Cancel (which had the focus) is gone
      const back = opener.current && document.contains(opener.current) && !(opener.current as HTMLButtonElement).disabled ? opener.current : switchBox.current?.querySelector("input");
      opener.current = null;
      if (!document.activeElement || document.activeElement === document.body) back?.focus();
    }
  }, [connecting]);
  // a message about the last attempt (the sign-in ended, a failure) is dropped when the sync state moves on by itself
  useEffect(() => {
    setErr(null);
    setEnded(null);
  }, [src?.status]);
  if (!kind) return <div className="muted">{t("settings.calendar.none")}</div>;
  const service = serviceName(kind);
  const clock = (sec: number) => new Intl.DateTimeFormat(intlLocale(), { hour: "2-digit", minute: "2-digit", timeZone: systemTz() }).format(new Date(sec * 1000));

  const connect = async () => {
    setErr(null);
    setEnded(null);
    opener.current = document.activeElement as HTMLElement | null;
    setConnecting(true);
    try {
      await api.calendarConnect(account.id);
      showToast(t("settings.calendar.syncOn", { email: account.email }), undefined, "success");
    } catch (e) {
      // timed out / cancelled / refused: the calendar's own sentence and the advice for the service; cancelled with nothing to add says nothing
      const end = kind ? signInEnd(kind, "calendar", e) : null;
      if (end) setEnded(end);
      else if (calendarErrorCode(String(e)) !== "CANCELLED") setErr(friendlyError(e));
    } finally {
      setConnecting(false);
      await loadCalSources();
      bumpCal();
    }
  };
  const stop = async () => {
    const ok = await confirm({
      title: t("settings.calendar.stopTitle", { email: account.email }),
      body: t("settings.calendar.stopBody", { service }),
      confirmLabel: t("settings.calendar.stopLabel"),
      danger: true,
    });
    if (!ok) return;
    setErr(null);
    setEnded(null);
    try {
      await api.calendarDisconnect(account.id);
    } catch (e) {
      setErr(friendlyError(e));
    }
    await loadCalSources();
    bumpCal();
  };
  const line = src ? statusLine(src, { email: account.email, nowSec: now, fmtTime: clock }) : null;
  const note = src ? truncatedNote(src) : null;
  const on = connecting || !!src;
  return (
    <>
      <Row
        label={t("settings.calendar.syncWith", { provider: providerName(kind) })}
        hint={t("settings.calendar.syncHint", { service })}
        id="calendar"
      >
        <span ref={switchBox}><Switch checked={on} disabled={connecting} onChange={(v) => void (v ? connect() : stop())} /></span>
      </Row>
      {/* the buttons stay while a consent waits (they are off): they come and go with the connection, not with the status. They are above the slot, so the room the slot keeps for a long message is under the status line, not between a message and its button */}
      {src && (
        <div className="row-inline set-actions">
          {line?.allow && <button className="btn primary" disabled={connecting} onClick={() => void connect()}>{t("settings.calendar.allowAgain")}</button>}
          {line && line.syncNow !== "off" && (
            <button className="btn small" disabled={connecting || line.syncNow === "disabled"} onClick={() => void api.calendarSyncNow(account.id).then(() => loadCalSources())}>{t("settings.calendar.syncNow")}</button>
          )}
        </div>
      )}
      {/* where the sync says what it is doing, one thing at a time and always in the same place: the sign-in waits, it ended, it failed, or how the sync is. A slot of fixed size, so nothing under it moves */}
      <div role="status" aria-live="polite" className="set-status">
        {connecting ? (
          <SignInWaiting provider={kind} lead={t("settings.calendar.allowInBrowser")} onCancel={() => void api.calendarCancelConnect()} cancelRef={cancelBtn} />
        ) : ended ? (
          <SignInEnded provider={kind} purpose="calendar" end={ended} />
        ) : err ? (
          <div className="field-err" role="alert">{err}</div>
        ) : line ? (
          <div className={line.tone === "bad" ? "notice bad" : "muted small"}>
            {line.text}
            {line.detail && <div style={{ marginTop: 2, fontSize: "0.9em", opacity: 0.8 }}>{line.detail}</div>}
            {note && <div>{note}</div>}
          </div>
        ) : null}
      </div>
      {src && src.calendars.length > 0 && (
        <>
          <h4 style={{ margin: "16px 0 2px" }}>{t("settings.calendar.calendars")}</h4>
          <div className="muted small">{t("settings.calendar.calendarsHint")}</div>
          {src.calendars.map((c) => (
            <div className="set-row" key={c.id}>
              <div className="set-lbl">
                <div>
                  <span className="dot" style={{ background: c.color || accountColor(account, prefs.accent), marginRight: 8 }} aria-hidden />
                  {c.name}
                  {c.primary && <span className="muted small"> · {t("settings.calendar.primary")}</span>}
                  {c.readOnly && <span className="muted small"> · {t("settings.calendar.readOnly")}</span>}
                </div>
              </div>
              <div className="set-ctl">
                <Switch checked={c.syncOn} ariaLabel={t("settings.calendar.syncCal", { name: c.name })} onChange={(v) => { setErr(null); void api.calendarSetSync(c.id, v).then(() => { bumpCal(); return loadCalSources(); }).catch((e) => setErr(friendlyError(e))); }} />
              </div>
            </div>
          ))}
        </>
      )}
    </>
  );
}

/** Per-mailbox PGP defaults. "My key" belongs to one account, so it is only shown inside a mailbox. */
function SecurityPanel({ scope }: { scope: string | null }) {
  const t = useT();
  const { keysRev, bumpKeys, showToast } = useStore();
  const [keys, setKeys] = useState<PgpKey[]>([]);
  useEffect(() => void api.pgpListKeys().then(setKeys).catch(() => setKeys([])), [keysRev]);
  const own = keys.filter((k) => k.hasSecret);
  const current = scope ? own.find((k) => k.defaultFor.includes(scope))?.fingerprint ?? "" : "";
  return (
    <>
      {scope ? (
        <Row label={t("settings.security.myKey")} hint={t("settings.security.myKeyHint")}>
          <select
            value={current}
            onChange={(e) => void api.pgpSetDefault(scope, e.target.value || null).then(bumpKeys).catch((er) => showToast(() => friendlyError(er), undefined, "error"))}
          >
            <option value="">{own.length ? t("settings.security.keyAuto") : t("settings.security.noKeyYet")}</option>
            {own.map((k) => <option key={k.fingerprint} value={k.fingerprint}>{k.expires ? t("settings.security.keyLabelExp", { key: shortKey(k.fingerprint), algo: k.algo, year: new Date(k.expires * 1000).getFullYear() }) : t("settings.security.keyLabel", { key: shortKey(k.fingerprint), algo: k.algo })}</option>)}
          </select>
        </Row>
      ) : (
        <div className="muted small pad">{t("settings.security.keysPerMailbox")}</div>
      )}
      <OvRow scope={scope} k="pgpEncrypt" label={t("settings.security.encrypt")} hint={t("settings.security.encryptHint")}>
        {(v, set) => (
          <select value={v} onChange={(e) => set(e.target.value as Prefs["pgpEncrypt"])}>
            <option value="possible">{t("settings.security.whenPossible")}</option>
            <option value="never">{t("settings.security.neverEncrypt")}</option>
            <option value="always">{t("settings.security.alwaysEncrypt")}</option>
          </select>
        )}
      </OvRow>
      <OvRow scope={scope} k="pgpSign" label={t("settings.security.sign")}>
        {(v, set) => <Switch checked={v} onChange={set} />}
      </OvRow>
      <OvRow scope={scope} k="pgpAttachKey" label={t("settings.security.attachKey")} hint={t("settings.security.attachKeyHint")}>
        {(v, set) => <Switch checked={v} onChange={set} />}
      </OvRow>
      <OvRow scope={scope} k="pgpEncryptDrafts" label={t("settings.security.encryptDrafts")} hint={t("settings.security.encryptDraftsHint")}>
        {(v, set) => <Switch checked={v} onChange={set} />}
      </OvRow>
      <OvRow scope={scope} k="pgpImportFromMail" label={t("settings.security.importKeys")} hint={t("settings.security.importKeysHint")}>
        {(v, set) => (
          <select value={v} onChange={(e) => set(e.target.value as Prefs["pgpImportFromMail"])}>
            <option value="ask">{t("settings.security.importAsk")}</option>
            <option value="auto">{t("settings.security.importAuto")}</option>
            <option value="never">{t("settings.security.importNever")}</option>
          </select>
        )}
      </OvRow>
    </>
  );
}

type MbTab = "profile" | "composing" | "signatures" | "templates" | "filters" | "notifications" | "reading" | "calendar" | "security" | "folders" | "server";

/** The sections of a mailbox (scope = account id) or of "All accounts" (null). They are listed under the mailbox in the Settings navigation. */
function mailboxSections(scope: string | null, accounts: Account[]): [MbTab, Key][] {
  // only a Google / Gmail (and later Microsoft) mailbox has a calendar to sync
  const calendar = scope !== null && accounts.some((a) => a.id === scope && calendarSyncKind(a) !== null);
  return [
    ...(scope ? ([["profile", "settings.section.profile"]] as [MbTab, Key][]) : []),
    ["composing", "settings.section.composing"], ["signatures", "settings.section.signatures"], ["templates", "settings.section.templates"], ["filters", "settings.section.filters"],
    ["notifications", "settings.section.notifications"], ["reading", "settings.section.reading"],
    ...(calendar ? ([["calendar", "settings.section.calendar"]] as [MbTab, Key][]) : []),
    ["security", "settings.section.security"], ["folders", "settings.section.folders"],
    ...(scope ? ([["server", "settings.section.server"]] as [MbTab, Key][]) : []),
  ];
}
const activeSection = (scope: string | null, tab: MbTab, accounts: Account[]): MbTab => (mailboxSections(scope, accounts).some(([k]) => k === tab) ? tab : "composing");

function MailboxPage({ scope, tab, close }: { scope: string | null; tab: MbTab; close: () => void }) {
  const t = useT();
  const { accounts, prefs } = useStore();
  const account = scope ? accounts.find((a) => a.id === scope) : undefined;
  if (scope && !account) return <div className="muted">{t("settings.mailbox.notFound")}</div>;
  const active = activeSection(scope, tab, accounts);
  return (
    <div>
      <div className="mb-head">
        {account ? <Avatar name={account.displayName || account.email} size={36} color={accountColor(account, prefs.accent)} /> : <div className="mb-all">∗</div>}
        <div>
          <h3>{account ? account.email : t("settings.scope.allAccounts")}</h3>
          <div className="muted small">
            {account ? t("settings.mailbox.accountIntro") : t("settings.mailbox.allIntro")}
          </div>
        </div>
      </div>
      <div className="mb-body" role="region" aria-label={t(mailboxSections(scope, accounts).find(([k]) => k === active)![1])}>
        {active === "profile" && account && <ProfilePanel account={account} />}
        {active === "composing" && <ComposingPanel scope={scope} />}
        {active === "signatures" && <SignaturesPanel scope={scope} />}
        {active === "templates" && <TemplatesPanel scope={scope} />}
        {active === "filters" && <FiltersPanel scope={scope} />}
        {active === "notifications" && <NotifyPanel scope={scope} />}
        {active === "reading" && <ReadingPanel scope={scope} />}
        {active === "calendar" && account && <CalendarPanel account={account} />}
        {active === "security" && <SecurityPanel scope={scope} />}
        {active === "folders" && <FoldersPanel scope={scope} />}
        {active === "server" && account && <ServerPanel account={account} close={close} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- app-level pages
function TrayTab() {
  const t = useT();
  const { prefs, setPrefs, showToast } = useStore();
  const os = usePlatform((s) => s.os);
  const tray = usePlatform((s) => s.tray);
  const [autostart, setAutostart] = useState(false);
  useEffect(() => void api.getAutostart().then(setAutostart).catch(() => undefined), []);
  const test = async () => {
    try {
      await api.testNotification();
    } catch (e) {
      showToast(() => os === "windows" ? friendlyError(e) : t("settings.tray.testFailed", { error: friendlyError(e) }), undefined, "error");
    }
  };
  const toggleAuto = async (v: boolean) => {
    try {
      await api.setAutostart(v);
      setAutostart(v);
    } catch (e) {
      showToast(() => friendlyError(e), undefined, "error");
    }
  };
  return (
    <div>
      <h3>{t("settings.tray.title")}</h3>
      {os === "macos" && <div className="muted small" style={{ marginBottom: 6 }}>{t("settings.tray.macUnavailable")}</div>}
      <div className="muted small">{os === "windows" ? t("settings.tray.introWindows") : t("settings.tray.intro")}</div>
      <Row label={t("settings.tray.test")}><button className="btn" onClick={() => void test()}>{t("settings.tray.sendTest")}</button></Row>
      <Row label={t("settings.tray.sentSound")}><Switch checked={prefs.sentSound} onChange={(v) => setPrefs({ sentSound: v })} /></Row>
      <Row
        label={t("settings.tray.keepRunning")}
        hint={
          !tray
            ? t("settings.tray.noTray")
            : os === "macos"
              ? t("settings.tray.keepRunningMac")
              : t("settings.tray.keepRunningHint")
        }
      >
        <Switch checked={tray && prefs.closeToTray} disabled={!tray} onChange={(v) => setPrefs({ closeToTray: v })} />
      </Row>
      {tray && (
        <Row label={t("settings.tray.trayBadge")} hint={t("settings.tray.trayBadgeHint")}>
          <select value={prefs.trayBadge} onChange={(e) => setPrefs({ trayBadge: e.target.value as Prefs["trayBadge"] })}>
            <option value="number">{t("settings.tray.unreadNumber")}</option>
            <option value="dot">{t("settings.tray.dotOnly")}</option>
            <option value="off">{t("common.none")}</option>
          </select>
        </Row>
      )}
      {(os === "windows" || os === "macos") && (
        <Row label={os === "macos" ? t("settings.tray.dockBadge") : t("settings.tray.taskbarBadge")}>
          <select value={prefs.taskbarBadge} onChange={(e) => setPrefs({ taskbarBadge: e.target.value as Prefs["taskbarBadge"] })}>
            <option value="number">{t("settings.tray.unreadNumber")}</option>
            <option value="off">{t("common.none")}</option>
          </select>
        </Row>
      )}
      <Row label={t("settings.tray.countOther")} hint={t("settings.tray.countOtherHint")}>
        <Switch checked={prefs.countOtherMail} onChange={(v) => setPrefs({ countOtherMail: v })} />
      </Row>
      <Row
        label={os === "windows" ? t("settings.tray.autostartWindows") : t("settings.tray.autostart")}
        hint={os === "linux" && !tray ? t("settings.tray.startsOpen") : t("settings.tray.startsMinimized")}
      >
        <Switch checked={autostart} onChange={(v) => void toggleAuto(v)} />
      </Row>
    </div>
  );
}

const ALL_ACTIONS: [string, Key][] = [
  ["archive", "settings.action.archive"], ["delete", "common.delete"], ["flag", "settings.action.flag"], ["pin", "settings.action.pin"],
  ["read", "settings.action.readUnread"], ["snooze", "settings.action.snooze"],
];

function ActionsTab() {
  const t = useT();
  const { prefs, setPrefs } = useStore();
  const toggle = (k: string) =>
    setPrefs({ hoverActions: prefs.hoverActions.includes(k) ? prefs.hoverActions.filter((x) => x !== k) : [...prefs.hoverActions, k] });
  return (
    <div>
      <h3>{t("settings.actions.title")}</h3>
      <div className="muted small">{t("settings.actions.intro")}</div>
      {ALL_ACTIONS.map(([k, l]) => (
        <Row key={k} label={t(l)}><Switch checked={prefs.hoverActions.includes(k)} onChange={() => toggle(k)} /></Row>
      ))}
    </div>
  );
}

function TimesTab() {
  const t = useT();
  const { prefs, setPrefs } = useStore();
  const times = prefs.snoozeTimes;
  const sel = (k: keyof typeof times, label: string) => (
    <Row label={label}>
      <select value={times[k]} onChange={(e) => setPrefs({ snoozeTimes: { ...times, [k]: Number(e.target.value) } })}>
        {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
      </select>
    </Row>
  );
  return (
    <div>
      <h3>{t("settings.times.title")}</h3>
      <div className="muted small">{t("settings.times.intro")}</div>
      {sel("evening", t("settings.times.evening"))}
      {sel("tomorrow", t("settings.times.tomorrow"))}
      {sel("weekend", t("settings.times.weekend"))}
      {sel("nextWeek", t("settings.times.nextWeek"))}
    </div>
  );
}

function BlockedTab() {
  const t = useT();
  const [list, setList] = useState<string[]>([]);
  const load = () => api.listBlocked().then(setList);
  useEffect(() => void load(), []);
  return (
    <div>
      <h3>{t("settings.blocked.title")}</h3>
      {list.length === 0 && <div className="muted">{t("settings.blocked.none")}</div>}
      {list.map((e) => (
        <div key={e} className="list-row">
          <div className="lr-name"><span className="lr-title">{e}</span></div>
          <button className="btn small" onClick={async () => { await api.unblock(e); void load(); }}>{t("settings.blocked.unblock")}</button>
        </div>
      ))}
    </div>
  );
}

function AiTab() {
  const t = useT();
  const [v, setV] = useState({ ai_endpoint: "", ai_model: "" });
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const { showToast, refreshAi } = useStore();
  // model ids offered by {Base URL}/models (fetched by the backend: no CORS, Bearer key); refetched when URL or key change
  const [models, setModels] = useState<string[]>([]);
  const [modelsState, setModelsState] = useState<"idle" | "loading" | "error">("idle");
  const [modelsErr, setModelsErr] = useState("");
  const [ready, setReady] = useState(false);
  // Save (or Remove the saved key) failed: said in the slot under Save, in place of the model list's text, until something is typed or tried again
  const [saveErr, setSaveErr] = useState("");
  // the Model control is a list when the endpoint listed models and a text box otherwise. It is never swapped under the user's hands: while
  // it has focus it keeps its kind (the list that arrives, or goes, is adopted when focus leaves), so focus and caret stay where they are
  const [modelFocused, setModelFocused] = useState(false);
  const [heldList, setHeldList] = useState(false);
  const asList = modelFocused ? heldList : models.length > 0;
  const keyRef = useRef<HTMLInputElement>(null);
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
          setModelsErr(cutAtWord(friendlyError(e), 70)); // the status line below Save has two lines: a longer reason would push its second sentence out
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
  // typing clears it (an effect on the values would also clear an error that arrives right after Save emptied the key box)
  const edit = (patch: Partial<typeof v>) => (setSaveErr(""), setV({ ...v, ...patch }));
  const save = async () => {
    setSaveErr("");
    try {
      await Promise.all([api.setSetting("ai_endpoint", v.ai_endpoint), api.setSetting("ai_model", v.ai_model)]);
      if (key.trim()) {
        await api.setSecret("ai_key", key.trim());
        setHasKey(true);
        setKey("");
      }
      await refreshAi();
      showToast(t("settings.ai.saved"), undefined, "success");
    } catch (e) {
      // what was typed stays in the boxes (nothing above is cleared before it worked); the reason is cut like the model list's so both lines of the slot hold the sentence
      setSaveErr(t("settings.ai.saveFailed", { error: cutAtWord(friendlyError(e), 70) }));
    }
  };
  const removeKey = async () => {
    setSaveErr("");
    try {
      await api.setSecret("ai_key", "");
      setHasKey(false);
      keyRef.current?.focus();
    } catch (e) {
      setSaveErr(t("settings.ai.removeKeyFailed", { error: cutAtWord(friendlyError(e), 70) }));
    }
  };
  const modelFocus = { onFocus: () => (setHeldList(asList), setModelFocused(true)), onBlur: () => setModelFocused(false) };
  // what the model list is doing, in the slot under Save: the slot is always there (two lines high), so these texts coming and going move nothing
  const status = saveErr ? saveErr
    : modelsState === "loading" ? t("settings.ai.loadingModels")
    : modelsState === "error" ? t("settings.ai.modelsError", { error: modelsErr })
    : models.length === 0 && v.ai_endpoint.trim() ? t("settings.ai.noModels") : "";
  return (
    <div>
      <h3>{t("settings.ai.title")}</h3>
      <div className="muted small">{t("settings.ai.intro")}</div>
      <div className="form">
        <label>{t("settings.ai.baseUrl")}</label>
        <input id="set-aiBaseUrl" aria-label={t("settings.ai.baseUrl")} placeholder="https://api.openai.com/v1" value={v.ai_endpoint} onChange={(e) => edit({ ai_endpoint: e.target.value })} />
        {/* the link to remove the saved key sits on the label's line: it appears after Save without moving the fields below */}
        <div className="field">
          <div className="field-head">
            <label>{t("settings.ai.apiKey")}</label>
            {hasKey && (
              <button className="link small" onClick={() => void removeKey()}>{t("settings.ai.removeKey")}</button>
            )}
          </div>
          <input ref={keyRef} id="set-aiKey" aria-label={t("settings.ai.apiKey")} type="password" value={key} onChange={(e) => (setSaveErr(""), setKey(e.target.value))} placeholder={hasKey ? t("settings.add.savedIn", { store: credStore() }) : t("settings.ai.keyOptional")} />
        </div>
        <label>{t("settings.ai.model")}</label>
        {asList ? (
          <select id="set-aiModel" aria-label={t("settings.ai.model")} value={v.ai_model} onChange={(e) => edit({ ai_model: e.target.value })} {...modelFocus}>
            {!v.ai_model && <option value="">{t("settings.ai.chooseModel")}</option>}
            {/* the saved model stays selectable even when the endpoint does not list it */}
            {v.ai_model && !models.includes(v.ai_model) && <option value={v.ai_model}>{t("settings.ai.modelSaved", { model: v.ai_model })}</option>}
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        ) : (
          <input id="set-aiModel" aria-label={t("settings.ai.model")} value={v.ai_model} placeholder={t("settings.ai.modelPlaceholder")} onChange={(e) => edit({ ai_model: e.target.value })} {...modelFocus} />
        )}
        <div className="ai-actions">
          <button className="btn primary" onClick={() => void save()}>{t("common.save")}</button>
          <div className={`ai-status small ${saveErr ? "bad" : "muted"}`} role="status" title={status || undefined}>{status}</div>
        </div>
      </div>
    </div>
  );
}

function KeyRow({ k, onOpen }: { k: PgpKey; onOpen: () => void }) {
  const t = useT();
  const accounts = useStore((s) => s.accounts);
  const used = k.defaultFor.map((id) => accounts.find((a) => a.id === id)?.email).filter(Boolean) as string[];
  const fp = fmtFpr(k.fingerprint).split(" ");
  return (
    <div
      className="key-row"
      tabIndex={0}
      role="button"
      aria-label={t("settings.pgp.keyAria", { name: keyName(k), key: shortKey(k.fingerprint) })}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}
    >
      <span className={`key-ico ${k.hasSecret ? "" : "pub"}`}>{k.hasSecret ? <KeyRound size={17} /> : <Lock size={16} />}</span>
      <span className="key-meta">
        <b className="ellipsis">{keyName(k)}</b>
        <span className="fpr" aria-hidden>
          {k.expires
            ? t(k.expired ? "settings.pgp.fprExpired" : "settings.pgp.fprExpires", { fpr: `${fp.slice(0, 4).join(" ")} … ${fp.slice(-1)}`, algo: k.algo, date: fmtDay(k.expires) })
            : t("settings.pgp.fpr", { fpr: `${fp.slice(0, 4).join(" ")} … ${fp.slice(-1)}`, algo: k.algo })}
        </span>
      </span>
      <span className="key-tags">
        {k.revoked && <span className="pill bad">{t("settings.pgp.revoked")}</span>}
        {!k.revoked && k.expired && <span className="pill warn">{t("settings.pgp.expired")}</span>}
        {k.hasSecret ? (
          <>
            {used.map((e) => <span key={e} className="pill accent">{t("settings.pgp.defaultFor", { email: e })}</span>)}
            {k.unlocked && <span className="pill">{k.passphraseRemembered ? t("settings.pgp.remembered") : t("settings.pgp.unlocked")}</span>}
          </>
        ) : k.verified ? <span className="pill good">{t("settings.pgp.verified")}</span> : <span className="pill">{t("settings.server.notVerified")}</span>}
      </span>
    </div>
  );
}

function PgpTab() {
  const t = useT();
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
      <h3>{t("settings.pgp.title")}</h3>
      <div className="muted small">{t("settings.pgp.intro")}</div>
      {err && <div className="notice bad" role="alert" style={{ marginTop: 10 }}>{t("settings.pgp.loadFailed", { error: err })} <button className="link" onClick={bumpKeys}>{t("common.retry")}</button></div>}
      <div className="set-card-head" style={{ marginTop: 14 }}>
        <h4 style={{ margin: 0, flex: 1 }}>{t("settings.pgp.yourKeys")}</h4>
        <button className="btn small" onClick={() => setDialog({ type: "pgp-import", back: "pgp" })}><Upload size={13} /> {t("settings.pgp.import")}</button>
        <button className="btn small primary" onClick={() => setDialog({ type: "pgp-generate", back: "pgp" })}><Plus size={13} /> {t("settings.pgp.generate")}</button>
      </div>
      <div style={{ marginTop: 8 }}>
        {!keys ? (
          <div className="sk" style={{ height: 56 }} aria-busy aria-label={t("settings.pgp.loadingKeys")} />
        ) : own.length === 0 ? (
          <div className="empty-state" style={{ padding: "18px 0" }}>
            <div className="empty-art"><KeyRound size={34} /></div>
            <div className="empty-title">{t("settings.pgp.noKeys")}</div>
            <div className="muted">{t("settings.pgp.noKeysHint")}</div>
            <button className="btn primary" style={{ marginTop: 8 }} onClick={() => setDialog({ type: "pgp-generate", back: "pgp" })}>{t("settings.pgp.generate")}</button>
          </div>
        ) : own.map((k) => <KeyRow key={k.fingerprint} k={k} onOpen={() => open(k.fingerprint)} />)}
      </div>
      <div className="set-card-head" style={{ marginTop: 18, flexWrap: "wrap" }}>
        <h4 style={{ margin: 0, flex: 1 }}>{t("settings.pgp.others")} <span className="muted small" style={{ fontWeight: 400 }}>· {others.length}</span></h4>
        <input placeholder={t("settings.pgp.searchPlaceholder")} aria-label={t("settings.pgp.searchKeys")} style={{ width: 340, maxWidth: "100%" }} value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn small" onClick={() => setDialog({ type: "pgp-import", back: "pgp" })}><Upload size={13} /> {t("settings.pgp.import")}</button>
      </div>
      <div style={{ marginTop: 8 }}>
        {others.length === 0 && keys && <div className="muted small">{t("settings.pgp.othersEmpty")}</div>}
        {others.length > 0 && shown.length === 0 && <div className="muted small">{t("settings.pgp.noMatch", { q })}</div>}
        {shown.map((k) => <KeyRow key={k.fingerprint} k={k} onOpen={() => open(k.fingerprint)} />)}
      </div>
      <h4>{t("settings.pgp.passphrases")}</h4>
      <Row label={t("settings.pgp.remember")} hint={t("settings.pgp.rememberHint")}>
        <select value={prefs.pgpRemember} onChange={(e) => setPrefs({ pgpRemember: e.target.value as Prefs["pgpRemember"] })}>
          <option value="session">{t("settings.pgp.untilQuit")}</option>
          <option value="never">{t("settings.pgp.askEveryTime")}</option>
        </select>
      </Row>
      <Row label={t("settings.pgp.lockAll")} hint={t("settings.pgp.lockAllHint")}>
        <button className="btn small" onClick={() => void api.pgpLockAll().then(() => (bumpKeys(), showToast(t("settings.pgp.allLocked"), undefined, "success")))}>{t("settings.pgp.lockNow")}</button>
      </Row>
    </div>
  );
}

function ShortcutsTab() {
  const t = useT();
  const os = usePlatform((s) => s.os);
  const rows: [string, Key][] = [
    ["c", "settings.keys.newMail"], ["Shift+C / R / A / F", "settings.keys.shiftCompose"], ["Ctrl+Shift+O", "settings.keys.popOutCompose"], ["/", "settings.keys.search"], ["j / k", "settings.keys.nextPrev"], ["e", "settings.action.archive"], ["#", "common.delete"], ["!", "settings.filters.toJunk"],
    ["s", "settings.action.snooze"], ["p", "settings.action.pin"], ["*", "settings.action.flag"], ["u", "settings.keys.markUnread"], ["r", "settings.action.reply"], ["a", "settings.composing.replyAll"], ["f", "settings.keys.forward"],
    ["Ctrl+Enter", "settings.keys.send"], ["Ctrl+Shift+Enter", "settings.keys.sendLater"], ["Ctrl+Shift+P", "settings.keys.insertPicture"], ["Ctrl+Shift+E", "settings.keys.encrypt"], ["Ctrl+Shift+G", "settings.keys.sign"],
    ["Space / Enter", "settings.keys.preview"], ["Ctrl+S", "settings.keys.saveAs"], ["Ctrl+Shift+S", "settings.keys.saveAll"],
    ["Ctrl+1 / Ctrl+2", "settings.keys.mailCalendar"], ["c · t · ← / → · m / w / a", "settings.keys.calendarKeys"],
    ["Ctrl+] / Ctrl+[", "settings.keys.fontSize"], ["Ctrl+= / Ctrl+Shift+=", "settings.keys.subSuper"], [os === "macos" ? "Ctrl+\\" : "Ctrl+Space / Ctrl+\\", "compose.fmt.clear"], ["Alt+F10", "settings.keys.focusToolbar"],
    ["Ctrl+Shift+L / 8", "compose.fmt.bulleted"], ["Ctrl+Shift+7", "compose.fmt.numbered"], ["Ctrl+L / E / R / Shift+J", "settings.keys.align"], ["Ctrl+T / Ctrl+Shift+T", "settings.keys.indent"],
    ["Ctrl+Shift+S", "settings.keys.stylesMenu"], ["Ctrl+Shift+N / Ctrl+Alt+1-3", "settings.keys.styleKeys"],
    ["Ctrl+A", "settings.keys.selectAll"], ["Ctrl+K", "settings.keys.commandBar"], ["F5", "settings.keys.syncNow"], ["Esc", "settings.keys.closeDeselect"], ["Shift+Enter", "settings.keys.openInWindow"], ["Ctrl+W", "settings.keys.closeWindow"],
    ["Ctrl+Shift+V", "settings.keys.pasteText"], [os === "macos" ? "Cmd" : "Ctrl", "settings.keys.pasteOptions"],
    ["Ctrl+K", "settings.keys.insertLink"], ["Ctrl+Click", "settings.keys.openLink"], ["Tab / Shift+Tab", "settings.keys.tableCells"],
  ];
  return (
    <div>
      <h3>{t("settings.keys.title")}</h3>
      {rows.map(([k, d]) => (
        <div key={k + d} className="set-row"><kbd>{kbd(os === "macos" && k === "#" ? "delete / #" : k, os)}</kbd><span>{t(d)}</span></div>
      ))}
    </div>
  );
}

function AboutTab() {
  const t = useT();
  const { prefs, setPrefs } = useStore();
  const testData = usePlatform((s) => s.testData);
  return (
    <div>
      <h3>{t("settings.about.title")}</h3>
      <p>{tx("settings.about.tagline", { name: <b>Hey Look!</b> })}</p>
      {testData && <div className="notice info">{t("settings.about.testBuild", { dir: testData })}</div>}
      <UpdatesBlock
        privacy={
          <p className="muted small">{t("settings.about.privacy")}</p>
        }
        autoSwitch={
          <Row
            label={t("settings.about.autoCheck")}
            hint={t("settings.about.autoCheckHint")}
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
const MORE: [string, Key][] = [
  ["tray", "settings.tray.title"], ["actions", "settings.actions.title"], ["times", "settings.times.title"], ["blocked", "settings.blocked.title"], ["pgp", "settings.pgp.title"],
  ["ai", "settings.ai.title"], ["shortcuts", "settings.nav.shortcuts"], ["about", "settings.about.title"],
];

export function Settings({ initial, focus, nonce }: { initial?: string; focus?: string; nonce?: number }) {
  const t = useT();
  const { setDialog, accounts, prefs } = useStore();
  const start = initial === "accounts" ? "mb:all" : initial === "notifications" ? "tray" : initial;
  const [tab, setTab] = useState<string>(start || (accounts.length === 0 ? "add-account" : "general"));
  const [mbTab, setMbTab] = useState<MbTab>(focus === "loadRemote" || focus === "maxDownload" ? "reading" : focus === "security" ? "security" : focus === "calendar" ? "calendar" : "composing");
  const close = () => setDialog(null);
  const navRef = useRef<HTMLElement>(null);
  const reorder = useAccountReorder(navRef);
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
    const timer = setTimeout(() => {
      const el = document.getElementById(`set-${focus}`);
      // a field of the AI Assistant tab (an AI problem sends the person to the one it is about): the cursor goes in, nothing scrolls or moves
      if (focus.startsWith("ai")) return void el?.focus({ preventScroll: true });
      el?.scrollIntoView({ block: "center" });
      el?.classList.add("flash");
    }, 80);
    return () => clearTimeout(timer);
  }, [focus, tab, mbTab, nonce]);
  // keep the selected navigation entry in view (the list scrolls on small windows)
  useEffect(() => {
    document.querySelector<HTMLElement>(".settings-nav button.active:not(.has-sub)")?.scrollIntoView({ block: "nearest" });
  }, [tab, mbTab]);

  // sections of the selected mailbox, listed right under it (Arrow Up/Down move between them)
  const sections = (k: string) => {
    const scope = k === "mb:all" ? null : k.slice(3);
    const active = activeSection(scope, mbTab, accounts);
    return (
      <div
        className="nav-sub"
        role="group"
        aria-label={t("settings.nav.mailboxSections")}
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          const list = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
          const i = list.indexOf(document.activeElement as HTMLButtonElement);
          list[Math.max(0, Math.min(list.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.click();
          list[Math.max(0, Math.min(list.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
        }}
      >
        {mailboxSections(scope, accounts).map(([s, l]) => (
          <button key={s} className={s === active ? "active" : ""} aria-current={s === active ? "page" : undefined} onClick={() => setMbTab(s)}>
            {t(l)}
          </button>
        ))}
      </div>
    );
  };
  const item = (k: string, l: ReactNode, sub = false, movable = false) => (
    <Fragment key={k}>
      <button data-reorder-focus={movable ? "" : undefined} className={`${tab === k ? "active" : ""} ${sub ? "sub" : ""} ${tab === k && k.startsWith("mb:") ? "has-sub" : ""}`} aria-current={tab === k ? "page" : undefined} onClick={() => setTab(k)}>
        {l}
      </button>
      {tab === k && k.startsWith("mb:") && sections(k)}
    </Fragment>
  );

  return (
    <Modal title={t("settings.title")} onClose={close} wide>
      <div className="settings">
        <nav className="settings-nav" aria-label={t("settings.nav.sections")} ref={navRef}>
          <div className="nav-label">{t("settings.nav.app")}</div>
          {item("general", t("settings.general.title"))}
          {item("appearance", t("settings.appearance.title"))}
          <div className="nav-label">{t("settings.nav.mailboxes")}</div>
          {item("mb:all", t("settings.scope.allAccounts"))}
          {accounts.map((a) => (
            // the mailboxes can be moved here too (grip, Alt+Up / Alt+Down, menu): AccountReorder.tsx
            <div key={a.id} className={`nav-acct ${reorder.dragging === a.id ? "reorder-src" : ""}`} data-reorder-id={a.id} {...reorder.entry(a.id)}>
              {accounts.length > 1 && <Grip email={a.email} bind={reorder.grip(a.id)} dragging={reorder.dragging === a.id} />}
              {item(`mb:${a.id}`, <><span className="dot" style={{ background: accountColor(a, prefs.accent) }} />{a.email}</>, true, true)}
            </div>
          ))}
          {item("add-account", t("settings.nav.addAccount"), true)}
          <div className="nav-label">{t("settings.nav.more")}</div>
          {MORE.map(([k, l]) => item(k, t(l)))}
          {reorder.overlay}
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
