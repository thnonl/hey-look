import { listen } from "@tauri-apps/api/event";
import { ChevronDown, ChevronUp, ExternalLink, KeyRound, Lock, Play, Plus, ShieldAlert, Trash2, Upload, Volume2 } from "lucide-react";
import { openPopout } from "../popout/open";
import { SETTINGS_KEY } from "../popout/windowKinds";
import { openUpdateLink } from "../updates";
import { Grip, useAccountReorder } from "./AccountReorder";
import { ABOUT_LINKS, siteUrl } from "../aboutLinks";
import { Fragment, ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Account, api, AutostartInfo, CalSource, Discovered, NotifyPermission, PgpKey, PROVIDERS, Rule, Signature, Template } from "../api";
import { singleLabelHostsOf } from "../addresses";
import { backendText } from "../backendErrors";
import { parseReplyTo } from "../replyTo";
import { calendarDavEligible, calendarErrorCode, calendarStepFailure, calendarSyncKind, canCreateCalendar, providerName, serviceName, sourceService, statusLine, truncatedNote } from "../calendarSync";
import { CalDavDialog } from "./CalDavDialog";
import { CalColorChoice } from "./CalColorChoice";
import { NewCalendarDialog } from "./NewCalendarDialog";
import { ACCENT_PRESETS, ACCOUNT_PALETTE, accountColor, DEFAULT_PREFS, eff, folderLabel, folderLabelIn, folderTitle, isOverridden, MAX_DOWNLOAD_PRESETS, NOTIFY_ACTIONS, Overridable, Prefs, staleAccountPrefs, validHex } from "../prefs";
import { aiSettingsSaved } from "../aiGuide";
import { keyTag, modelsFetchKey, NO_LIST } from "../aiModelsKey";
import { hostLabel, keyIsSent, originOf, otherServer, resolveModelsUrl } from "../aiModelsUrl";
import { normalizeSidebar } from "../sidebarState";
import { folderVisible, ruleTargetProblem } from "../junk";
import { cutAtWord, friendlyError, useStore } from "../store";
import { ensureTrustedLoaded, reloadTrusted, removeTrusted, useTrusted } from "../trustedSenders";
import { credStore, kbd, riskyHint, usePlatform } from "../platform";
import { portFromText, portText } from "../portField";
import { LazyRuleDialog } from "../lazyViews";
import { ACTION_WORD, ruleTitle } from "../ruleText";
import { runRule } from "../ruleRun";
import { filtersIntroKey, keepRunningLabelKey, startInTrayOffered, startsMinimizedHint, startsMinimizedKey, trayBadgeLabelKey, trayTabTitleKey } from "../trayWords";
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
import { isImeEvent } from "../recipients";
import { buildIndex, type Entry, type EntryKind, type IndexAccount } from "../settingsIndex";
import { showSetting } from "../settingsJump";
import { SearchBox, SearchResults, useSettingsSearch } from "./SettingsSearch";
import { AccountPicker, Avatar, Modal, Switch } from "./ui";
import { LANGS, intlLocale, langVersion, pseudoAllowed, type Key } from "../i18n";
import { fmtNumber, weekdayName } from "../i18n/format";
import { useT } from "../i18n/react";
import { tx } from "../i18n/rich";

/** "lundi" -> "Lundi": Intl gives weekday names in lower case in some languages, the options here start with a capital. */
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** `id`: the target of Settings search and of the deep links (src/settingsIndex.ts lists it); `noSearch`: a row the search does not look for (user data, a row that only some mailboxes have) */
const Row = ({ label, hint, children, id, noSearch }: { label: string; hint?: ReactNode; children: ReactNode; id?: string; noSearch?: boolean }) => {
  const ctl = useRef<HTMLDivElement>(null);
  // the label is a sibling <div>, not a <label for>: give the unnamed inputs/selects in this row the label as accessible name
  useEffect(() => {
    const els = [...(ctl.current?.querySelectorAll<HTMLInputElement>("input,select,textarea") ?? [])].filter(
      (e) => !e.getAttribute("aria-label") && !e.getAttribute("aria-labelledby") && ![...(e.labels ?? [])].some((l) => l.textContent?.trim()),
    );
    els.forEach((e, i) => e.setAttribute("aria-label", els.length > 1 ? `${label} (${i + 1})` : label));
  });
  return (
    <div className="set-row" id={id ? `set-${id}` : undefined} data-search-skip={noSearch ? "" : undefined}>
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

/** The sound row of Settings > Notifications (W13.8): the switch and "Play sound", which plays the new-mail sound once, switch on or off. */
const SoundControl = ({ value, onChange }: { value: Prefs["notifySound"]; onChange: (v: Prefs["notifySound"]) => void }) => {
  const t = useT();
  const showToast = useStore((s) => s.showToast);
  const play = async () => {
    try {
      await api.playNotifySound();
    } catch {
      showToast(() => t("settings.notify.playFailed"), undefined, "error");
    }
  };
  return (
    <div className="sound-row">
      <Switch checked={value !== "none"} onChange={(on) => onChange(on ? "pop" : "none")} ariaLabel={t("settings.notify.sound")} />
      <button className="btn sound-play" onClick={() => void play()}>
        <Volume2 size={15} aria-hidden />
        <span>{t("settings.notify.playSound")}</span>
      </button>
    </div>
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
  const { prefs, setPrefs, accounts, langLoading } = useStore();
  const set = <K extends keyof Prefs>(k: K, v: Prefs[K]) => setPrefs({ [k]: v } as Partial<Prefs>);
  return (
    <div>
      <h3 id="set-pg-general">{t("settings.general.title")}</h3>
      <div className="muted small">{t("settings.general.intro")}</div>
      <Row id="language" label={t("settings.general.language")} hint={t("settings.general.languageHint")}>
        {/* the language just picked shows at once; the texts switch when its chunk is there (store.setPrefs) */}
        <select value={langLoading ?? prefs.language} aria-busy={langLoading !== null} onChange={(e) => set("language", e.target.value as Prefs["language"])}>
          {LANGS.map((l) => <option key={l.code} value={l.code} lang={l.code}>{l.nativeName}</option>)}
          {/* i18n-ok: dev builds only, not shown to users */}
          {pseudoAllowed() && <option value="en-XA">Pseudo-locale (dev)</option>}
        </select>
      </Row>
      <Row id="afterAction" label={t("settings.general.afterAction")}>
        <select value={prefs.afterAction} onChange={(e) => set("afterAction", e.target.value as Prefs["afterAction"])}>
          <option value="next">{t("settings.general.openNext")}</option>
          <option value="previous">{t("settings.general.openPrevious")}</option>
          <option value="list">{t("settings.general.backToList")}</option>
        </select>
      </Row>
      <Row id="markRead" label={t("settings.general.markRead")}>
        <select value={prefs.markReadDelay} onChange={(e) => set("markReadDelay", Number(e.target.value))}>
          <option value={0}>{t("settings.general.immediately")}</option>
          <option value={2}>{t("settings.general.after2")}</option>
          <option value={5}>{t("settings.general.after5")}</option>
          <option value={-1}>{t("settings.general.never")}</option>
        </select>
      </Row>
      <Row id="undoWindow" label={t("settings.general.undoWindow")} hint={t("settings.general.undoWindowHint")}>
        <select value={prefs.undoActionSeconds} onChange={(e) => set("undoActionSeconds", Number(e.target.value))}>
          {[3, 6, 10, 15, 30].map((n) => <option key={n} value={n}>{t("settings.unit.seconds", { n })}</option>)}
        </select>
      </Row>
      <Row id="defaultAccount" label={t("settings.general.defaultAccount")} hint={t("settings.general.defaultAccountHint")}>
        <AccountPicker
          value={accounts.some((a) => a.id === prefs.defaultAccount) ? prefs.defaultAccount : ""}
          accounts={accounts}
          onChange={(id) => set("defaultAccount", id)}
          label={t("settings.general.defaultAccount")}
          none={t("settings.general.noDefaultAccount")}
        />
      </Row>
      <Row id="dateFormat" label={t("settings.general.dateFormat")}>
        <select value={prefs.dateFormat} onChange={(e) => set("dateFormat", e.target.value as Prefs["dateFormat"])}>
          <option value="relative">{t("settings.general.dateRelative")}</option><option value="absolute">{t("settings.general.dateAbsolute")}</option>
        </select>
      </Row>
      <Row id="timeFormat" label={t("settings.general.timeFormat")}>
        <select value={prefs.timeFormat} onChange={(e) => set("timeFormat", e.target.value as Prefs["timeFormat"])}>
          <option value="24">{t("settings.general.time24")}</option><option value="12">{t("settings.general.time12")}</option>
        </select>
      </Row>
      <Row id="supportReminder" label={t("settings.general.supportReminder")} hint={t("settings.general.supportReminderHint")}>
        <Switch checked={prefs.supportNudge.enabled} onChange={(v) => set("supportNudge", setNudgeEnabled(prefs.supportNudge, v, Date.now()))} ariaLabel={t("settings.general.supportReminder")} />
      </Row>
      <h4>{t("settings.general.calendar")}</h4>
      <Row id="weekStart" label={t("settings.general.weekStart")}>
        <select value={prefs.weekStart} onChange={(e) => set("weekStart", Number(e.target.value) as Prefs["weekStart"])}>
          <option value={1}>{cap(weekdayName(1, "long"))}</option><option value={0}>{cap(weekdayName(0, "long"))}</option><option value={6}>{cap(weekdayName(6, "long"))}</option>
        </select>
      </Row>
      <Row id="timeZone" label={t("settings.general.timeZone")} hint={t("settings.general.timeZoneHint")}>
        <select value={prefs.calTz} onChange={(e) => set("calTz", e.target.value)}>
          <option value="auto">{t("settings.general.tzAuto", { zone: systemTz() })}</option>
          {zoneList().map((z) => <option key={z} value={z}>{z}</option>)}
        </select>
      </Row>
      <Row id="autoAddInvites" label={t("settings.general.autoAddInvites")} hint={t("settings.general.autoAddInvitesHint")}>
        <Switch checked={prefs.autoAddInvites} onChange={(v) => set("autoAddInvites", v)} />
      </Row>
      <Row id="eventReminders" label={t("settings.general.eventReminders")} hint={t("settings.general.eventRemindersHint")}>
        <select value={prefs.eventReminderMin === null ? "" : String(prefs.eventReminderMin)} onChange={(e) => set("eventReminderMin", e.target.value === "" ? null : Number(e.target.value))}>
          <option value="">{t("settings.general.noReminder")}</option>
          {[0, 5, 10, 15, 30, 60].map((n) => <option key={n} value={n}>{n === 0 ? t("settings.general.remindAtStart") : n === 60 ? t("settings.general.remind1h") : t("settings.general.remindMinutes", { n })}</option>)}
        </select>
      </Row>
      <h4>{t("settings.general.attachments")}</h4>
      <Row id="saveTo" label={t("settings.general.saveTo")} hint={t("settings.general.saveToHint")}>
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
      <Row id="askWhere" label={t("settings.general.askWhere")}>
        <Switch checked={prefs.askWhereToSave} onChange={(v) => set("askWhereToSave", v)} />
      </Row>
      <Row id="afterSaving" label={t("settings.general.afterSaving")}>
        <select value={prefs.afterSave} onChange={(e) => set("afterSave", e.target.value as Prefs["afterSave"])}>
          <option value="notify">{t("settings.general.showNotification")}</option>
          <option value="reveal">{t("settings.general.showInFolder")}</option>
          <option value="open">{t("settings.general.openFile")}</option>
        </select>
      </Row>
      <Row id="warnExec" label={t("settings.general.warnExec")} hint={riskyHint()}>
        <Switch checked={prefs.warnExecutables} onChange={(v) => set("warnExecutables", v)} />
      </Row>
      <h4>{t("settings.general.scheduled")}</h4>
      <Row id="catchUp" label={t("settings.general.catchUp")}>
        <select value={prefs.scheduledCatchUp} onChange={(e) => set("scheduledCatchUp", e.target.value as Prefs["scheduledCatchUp"])}>
          <option value="send">{t("settings.general.sendAtOpen")}</option>
          <option value="ask">{t("settings.general.askFirst")}</option>
        </select>
      </Row>
      <Row id="retry" label={t("settings.general.retry")} hint={t("settings.general.retryHint")}>
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
      <h3 id="set-pg-appearance">{t("settings.appearance.title")}</h3>
      <div className="muted small">{t("settings.appearance.intro")}</div>
      <AppearancePreview />

      <div id="set-theme">
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
      </div>
      <div id="set-accent">
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
      </div>
      <div id="set-density">
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
      </div>
      <div id="set-readingPane">
        <h4>{t("settings.appearance.readingPane")}</h4>
        <Cards
          value={prefs.readingPane}
          onChange={(v) => setPrefs({ readingPane: v })}
          options={[
            { key: "right", label: t("settings.appearance.right"), art: <PaneArt /> },
            { key: "bottom", label: t("settings.appearance.bottom"), art: <PaneArt bottom /> },
          ]}
        />
      </div>
      <h4>{t("settings.appearance.sideMenu")}</h4>
      <Row id="sideMenu" label={t("settings.appearance.sideMenuMode")} hint={t("settings.appearance.sideMenuHint")}>
        <select value={prefs.sidebar} onChange={(e) => setPrefs({ sidebar: normalizeSidebar(e.target.value) })}>
          <option value="auto">{t("settings.appearance.sideAuto")}</option>
          <option value="expanded">{t("settings.appearance.sideOpen")}</option>
          <option value="collapsed">{t("settings.appearance.sideIcons")}</option>
        </select>
        {prefs.sidebar !== "auto" && <button className="link small" onClick={() => setPrefs({ sidebar: "auto" })}>{t("settings.appearance.sideReset")}</button>}
      </Row>
      <h4>{t("settings.appearance.messageList")}</h4>
      <Row id="preview" label={t("settings.appearance.preview")}><Switch checked={prefs.preview} onChange={(v) => setPrefs({ preview: v })} /></Row>
      <Row id="conversations" label={t("settings.appearance.conversations")} hint={t("settings.appearance.conversationsHint")}><Switch checked={prefs.conversations} onChange={(v) => setPrefs({ conversations: v })} /></Row>
      <Row id="focused" label={t("settings.appearance.focused")} hint={t("settings.appearance.focusedHint")}><Switch checked={prefs.focused} onChange={(v) => setPrefs({ focused: v })} /></Row>
      <Row id="oldestOnTop" label={t("settings.appearance.oldestOnTop")}><Switch checked={prefs.sortAsc} onChange={(v) => setPrefs({ sortAsc: v })} /></Row>
      <Row id="textSize" label={t("settings.appearance.textSize")}>
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
  // "Also sync my calendar" (W7.9): ticked every time the card opens; offered only when this build can connect the service
  const [alsoCal, setAlsoCal] = useState(true);
  const [kinds, setKinds] = useState<string[] | null>(null);
  // step 2, the calendar consent right after the mail sign-in: "wait" while the browser page is open, "failed" with the notice and Retry / Continue
  const [cal, setCal] = useState<{ acc: Account; phase: "wait" | "failed"; end: SignInEnd | null; err: string } | null>(null);
  const step = useRef<Account | null>(null); // the mailbox whose calendar step is open; cleared when it ends, so a late answer of a consent that was skipped is ignored
  const goBtn = useRef<HTMLButtonElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const wasBusy = useRef(false);
  // the calendar step says what it waits for, or why it ended, in the slot under the card: in a low window that is below the fold, so it is brought into view
  useEffect(() => {
    if (cal) slot.current?.scrollIntoView?.({ block: "nearest" });
  }, [cal?.phase]); // eslint-disable-line react-hooks/exhaustive-deps
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
  // the same for the calendar step (closing Settings, another tab): it ends as Skip does, and the Inbox of the new mailbox opens
  useEffect(() => () => {
    const acc = step.current;
    if (!acc) return;
    step.current = null;
    void api.calendarCancelConnect().catch(() => undefined);
    void useStore.getState().answerCalOffer();
    void useStore.getState().accountAddedDone(acc, false);
  }, []);
  useEffect(() => {
    let live = true;
    api.calendarKindsAvailable().then((k) => live && setKinds(k)).catch(() => live && setKinds([]));
    return () => void (live = false);
  }, []);
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
  const showCal = kinds !== null && kinds.includes(kind);
  /** The end of step 2 without the calendar: the account is already added; the dialog closes and its Inbox opens. */
  const endWithout = (acc: Account) => {
    if (step.current !== acc) return;
    step.current = null;
    setCal(null);
    void useStore.getState().answerCalOffer();
    void useStore.getState().accountAddedDone(acc, false);
  };
  const calendarStep = async (acc: Account) => {
    step.current = acc;
    setCal({ acc, phase: "wait", end: null, err: "" });
    try {
      await api.calendarConnect(acc.id);
      if (step.current !== acc) return;
      step.current = null;
      setCal(null);
      const st = useStore.getState();
      void st.answerCalOffer();
      void st.loadCalSources().then(() => st.bumpCal());
      void st.accountAddedDone(acc, true);
    } catch (e) {
      if (step.current !== acc) return; // (Skip, or Settings was left: the answer of a consent that was ended has no voice)
      if (calendarStepFailure(e) === "skip") return endWithout(acc);
      // the same notice as Settings > Calendar shows for this end; the account stays added in every case and its mail token is never touched
      const end = signInEnd(kind, "calendar", e);
      setCal({ acc, phase: "failed", end, err: end ? "" : friendlyError(e) });
    }
  };
  const skipCalendar = () => {
    if (cal?.phase === "wait") void api.calendarCancelConnect().catch(() => undefined);
    if (cal) endWithout(cal.acc);
  };
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
      // the mailbox has no calendar source yet and the box is ticked: the calendar consent follows at once (a mailbox that already syncs skips it)
      const withCal = alsoCal && showCal && !(await api.calendarSources().catch(() => [] as CalSource[])).some((x) => x.accountId === acc.id);
      if (withCal) {
        // the mailbox joins the folder pane and its first sync starts now; this dialog stays until the step ends
        void useStore.getState().accountAdded(acc, true);
        void calendarStep(acc);
      } else {
        // closes this dialog, opens the new account's Inbox and starts its first sync
        void useStore.getState().accountAdded(acc);
      }
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
                <input autoComplete="off" aria-label={t("settings.add.clientId")} value={cid} onChange={(e) => setCid(e.target.value)} placeholder={cfg.idPlaceholder} />
                {kind === "google" && (
                  <>
                    <label>{t("settings.add.clientSecret")}</label>
                    <input autoComplete="off" aria-label={t("settings.add.clientSecret")} type="password" value={sec} onChange={(e) => setSec(e.target.value)} placeholder={secSaved ? t("settings.add.savedIn", { store: credStore() }) : ""} />
                  </>
                )}
              </div>
            </details>
          )}
          {kind === "microsoft" && (
            <>
              <label>{t("settings.add.tenant")}</label>
              <input autoComplete="off" aria-label={t("settings.add.tenant")} value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder="common" />
              <div className="muted small">{t("settings.add.tenantHint")}</div>
            </>
          )}
          <label>{t("settings.add.displayNameOpt")}</label>
          <input autoComplete="off" aria-label={t("settings.add.displayNameOpt")} placeholder={t("settings.add.yourName")} value={name} onChange={(e) => setName(e.target.value)} />
          {showCal && (
            <div className="also-cal">
              <label>
                <input type="checkbox" checked={alsoCal} disabled={busy || !!cal} aria-describedby={`also-cal-${kind}`} onChange={(e) => setAlsoCal(e.target.checked)} />
                <span>{t("settings.add.alsoCalendar")}</span>
              </label>
              <div id={`also-cal-${kind}`} className="muted small">{t("settings.add.alsoCalendarHint", { provider: cfg.label })}</div>
            </div>
          )}
          <div className="row-inline">
            <button ref={goBtn} className="btn primary" disabled={busy || !!cal || (!fromEnv && !cid)} onClick={() => void go()}>
              {busy || cal?.phase === "wait" ? t("settings.add.waitingFor", { provider: cfg.label }) : t("settings.add.signInWith", { provider: cfg.label })}
            </button>
            {busy && <button className="btn" autoFocus onClick={() => void api.oauthCancel()}>{t("common.cancel")}</button>}
            {cal?.phase === "wait" && <button className="btn" autoFocus onClick={skipCalendar}>{t("settings.add.calSkip")}</button>}
            {cal?.phase === "failed" && (
              <>
                <button className="btn primary" autoFocus onClick={() => void calendarStep(cal.acc)}>{t("common.retry")}</button>
                <button className="btn" onClick={skipCalendar}>{t("settings.add.calContinue")}</button>
              </>
            )}
          </div>
        </div>
      </div>
      {/* what the sign-in is doing or how it ended: ONE slot of fixed size under the card, so the button above never moves (it used to be rows above and below it) */}
      <div className="signin-slot" ref={slot}>
        {cal ? (
          cal.phase === "wait" ? <SignInWaiting provider={kind} lead={t("settings.add.calWaiting", { email: cal.acc.email })} />
            : cal.end ? <SignInEnded provider={kind} purpose="calendar" end={cal.end} />
            : <div className="notice bad" role="alert">{cal.err}</div>
        )
          : busy ? <SignInWaiting provider={kind} lead={t("signin.waiting.mail")} />
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
            <input autoComplete="off" aria-label={t("settings.add.email")} placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
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
          <input autoComplete="off" aria-label={t("settings.add.displayName")} placeholder={t("settings.add.yourName")} value={name} onChange={(e) => setName(e.target.value)} />
          <label>{t("settings.add.password")}</label>
          <input autoComplete="off" aria-label={t("settings.add.password")} type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
          {showAdv && (
            <>
              <label>{t("settings.add.username")}</label>
              <input autoComplete="off" aria-label={t("settings.add.username")} placeholder="name@example.com" value={username} onChange={(e) => setUsername(e.target.value)} />
              <label>{t("settings.add.imapServer")}</label>
              <div className="row-inline">
                <input autoComplete="off" aria-label={t("settings.add.imapHost")} placeholder="imap.example.com" value={adv.imapHost} onChange={(e) => setAdv({ ...adv, imapHost: e.target.value })} />
                <input autoComplete="off" type="text" inputMode="numeric" aria-label={t("settings.add.imapPort")} placeholder="993" value={portText(adv.imapPort)} onChange={(e) => setAdv({ ...adv, imapPort: portFromText(e.target.value, adv.imapPort) })} />
                <select aria-label={t("settings.add.imapSecurity")} value={adv.imapSsl ? "ssl" : "starttls"} onChange={(e) => setAdv({ ...adv, imapSsl: e.target.value === "ssl" })}>
                  {/* i18n-ok: protocol names */}
                  <option value="ssl">SSL/TLS</option><option value="starttls">STARTTLS</option>
                </select>
              </div>
              <label>{t("settings.add.smtpServer")}</label>
              <div className="row-inline">
                <input autoComplete="off" aria-label={t("settings.add.smtpHost")} placeholder="smtp.example.com" value={adv.smtpHost} onChange={(e) => setAdv({ ...adv, smtpHost: e.target.value })} />
                <input autoComplete="off" type="text" inputMode="numeric" aria-label={t("settings.add.smtpPort")} placeholder="465" value={portText(adv.smtpPort)} onChange={(e) => setAdv({ ...adv, smtpPort: portFromText(e.target.value, adv.smtpPort) })} />
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
                  <input autoComplete="off" aria-label={t("settings.add.smtpUsername")} value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} placeholder={username || email} />
                  <label>{t("settings.add.smtpPasswordLabel")}</label>
                  <input autoComplete="off" aria-label={t("settings.add.smtpPassword")} type="password" value={smtpPw} onChange={(e) => setSmtpPw(e.target.value)} />
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
      <h3 id="set-pg-add-account">{t("settings.add.addAccount")}</h3>
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
      <OvRow id="replyDefault" scope={scope} k="replyDefault" label={t("settings.composing.replyDefault")}>
        {(v, set) => (
          <select value={v} onChange={(e) => set(e.target.value as Prefs["replyDefault"])}>
            <option value="reply">{t("settings.action.reply")}</option>
            <option value="replyAll">{t("settings.composing.replyAll")}</option>
          </select>
        )}
      </OvRow>
      <OvRow id="undoSend" scope={scope} k="undoSeconds" label={t("settings.composing.undoSend")} hint={t("settings.composing.undoSendHint")}>
        {(v, set) => (
          <select value={v} onChange={(e) => set(Number(e.target.value))}>
            {[0, 5, 10, 20, 30, 60].map((n) => <option key={n} value={n}>{n === 0 ? t("common.off") : t("settings.unit.seconds", { n })}</option>)}
          </select>
        )}
      </OvRow>
      <OvRow id="autoCc" scope={scope} k="autoCc" label={t("settings.composing.autoCc")} hint={t("settings.composing.autoCcHint")}>
        {(v, set) => <input autoComplete="off" value={v} onChange={(e) => set(e.target.value)} placeholder="name@example.com" />}
      </OvRow>
      <OvRow id="autoBcc" scope={scope} k="autoBcc" label={t("settings.composing.autoBcc")}>
        {(v, set) => <input autoComplete="off" value={v} onChange={(e) => set(e.target.value)} placeholder="name@example.com" />}
      </OvRow>
      <OvRow id="signature" scope={scope} k="signatureId" label={t("settings.composing.signature")} hint={t("settings.composing.signatureHint")}>
        {(v, set) => (
          <select value={v} onChange={(e) => set(e.target.value)}>
            <option value="">{t("settings.composing.sigAuto")}</option>
            <option value="none">{t("settings.composing.sigNone")}</option>
            {usable.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
      </OvRow>
      <OvRow id="pictures" scope={scope} k="inlinePictures" label={t("settings.composing.pictures")} hint={t("settings.composing.picturesHint")}>
        {(v, set) => (
          <select value={v} onChange={(e) => set(e.target.value as Prefs["inlinePictures"])}>
            <option value="inline">{t("settings.composing.picInline")}</option>
            <option value="attach">{t("settings.composing.picAttach")}</option>
          </select>
        )}
      </OvRow>
      <OvRow id="resize" scope={scope} k="autoResizePictures" label={t("settings.composing.resize")} hint={t("settings.composing.resizeHint")}>
        {(v, set) => <Switch checked={v} onChange={set} />}
      </OvRow>
      <OvRow id="sigOnReply" scope={scope} k="signatureOnReply" label={t("settings.composing.sigOnReply")}>
        {(v, set) => <Switch checked={v} onChange={set} />}
      </OvRow>
      {/* one setting for the whole app, not per mailbox. Stored only: the compose window that reads it comes with WP6b (popout/entry.ts) */}
      {scope === null && (
        <Row id="popout" label={t("settings.composing.popout")} hint={t("settings.composing.popoutHint")}>
          <Switch checked={prefs.popoutCompose} onChange={(v) => setPrefs({ popoutCompose: v })} />
        </Row>
      )}
      {scope === null && (
        <Row id="altCheck" label={t("settings.composing.altCheck")} hint={t("settings.composing.altCheckHint")}>
          <Switch checked={prefs.altCheck} onChange={(v) => setPrefs({ altCheck: v })} />
        </Row>
      )}
      {scope === null && <DefaultFontRow />}
      {scope === null && <PasteDefaultRow />}
      {scope === null && <AutoFormatRow />}
      {scope === null && <MiniToolbarRow />}
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

/** Settings > Composing > AutoFormat as you type: typographic quotes, dashes, arrows and symbols in the rich editors (editor/autoFormat.ts); Ctrl+Z right after a change undoes it. */
function AutoFormatRow() {
  const t = useT();
  const { prefs, setPrefs } = useStore();
  const os = usePlatform((s) => s.os);
  return (
    <Row label={t("settings.composing.autoFormat")} hint={kbd(t("settings.composing.autoFormatHint"), os)} id="autoFormat">
      <Switch checked={prefs.autoFormat} onChange={(v) => setPrefs({ autoFormat: v })} />
    </Row>
  );
}

/** Settings > Composing > Show the mini toolbar when you select text (editor/MiniToolbar.tsx). */
function MiniToolbarRow() {
  const t = useT();
  const { prefs, setPrefs } = useStore();
  return (
    <Row label={t("settings.composing.miniToolbar")} hint={t("settings.composing.miniToolbarHint")} id="miniToolbar">
      <Switch checked={prefs.miniToolbar} onChange={(v) => setPrefs({ miniToolbar: v })} />
    </Row>
  );
}

function ScopedList<T extends { id: string; accountId?: string | null }>({
  scope, items, title, tags, render, extra, onOpen, onDelete, empty,
}: {
  scope: string | null;
  items: T[];
  title: (i: T) => ReactNode;
  /** badges of the row (default, off...): right-aligned, just before the action */
  tags?: (i: T) => ReactNode;
  render?: (i: T) => ReactNode;
  /** more buttons of the row, before Delete (the order and Run now of the rules) */
  extra?: (i: T) => ReactNode;
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
          {extra?.(i)}
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
          <input autoComplete="off" aria-label={t("settings.form.name")} placeholder={t("settings.sig.namePlaceholder")} value={cur.name} onChange={(e) => setCur({ ...cur, name: e.target.value })} />
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
          <input autoComplete="off" aria-label={t("settings.form.name")} placeholder={t("settings.tpl.namePlaceholder")} value={cur.name} onChange={(e) => setCur({ ...cur, name: e.target.value })} />
          <label>{t("settings.tpl.subjectOpt")}</label>
          <input autoComplete="off" aria-label={t("settings.tpl.subjectOpt")} placeholder={t("settings.tpl.subjectPlaceholder")} value={cur.subject} onChange={(e) => setCur({ ...cur, subject: e.target.value })} />
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

/** The rules (Settings > Mailboxes > Rules, 1.0.8): the ordered list with Move up / Move down / Run now / Delete on each row; a click on a row edits it; New rule and Edit rule open the rule dialog. */
function FiltersPanel({ scope }: { scope: string | null }) {
  const t = useT();
  const { folders, showToast, confirm, accounts } = useStore();
  const accountIds = accounts.map((a) => a.id);
  const tray = usePlatform((s) => s.tray);
  const [list, setList] = useState<Rule[]>([]);
  const [dlg, setDlg] = useState<{ rule?: Rule } | null>(null);
  const load = () => api.listRules().then(setList);
  useEffect(() => void load(), []);
  // a rule saved in another window (the Settings window and the main window's dialog, or a rule made from a message) shows here
  useEffect(() => {
    const off = listen<{ what?: string }>("data-changed", (e) => {
      if (e.payload?.what === "rules") void load();
    });
    return () => void off.then((f) => f()).catch(() => undefined);
  }, []);
  const own = list.filter((r) => (r.accountId ?? null) === scope);
  const move = async (r: Rule, down: boolean) => {
    await api.moveRule(r.id, down);
    void load();
  };
  const runNow = async (r: Rule) => {
    try {
      const scan = await api.ruleCount(r, "inbox");
      if (scan.n === 0 && !scan.capped) {
        showToast(t("settings.rules.runNone"), undefined, "info");
        return;
      }
      const ok = await confirm({
        title: t("settings.rules.runTitle", { name: ruleTitle(r) }),
        body: scan.capped ? undefined : t("settings.rules.runBody", { n: scan.n }),
        confirmLabel: t("settings.rules.run"),
      });
      if (ok) await runRule(r, "inbox");
    } catch (e) {
      showToast(() => t("errors.toast.failed", { error: friendlyError(e) }), undefined, "error");
    }
  };
  return (
    <>
      <div className="muted small pad">{t(filtersIntroKey(tray))}</div>
      <ScopedList
        scope={scope}
        items={list}
        empty={t("settings.filters.empty")}
        title={(r) => ruleTitle(r)}
        tags={(r) => {
          const problem = ruleTargetProblem(r, folders, accountIds);
          return (
            <>
              {!r.enabled && <span className="ov-tag">{t("settings.filters.off")}</span>}
              {problem === "no-junk" && <span className="ov-tag">{t("mail.junk.none")}</span>}
              {problem === "no-folder" && <span className="ov-tag">{t("settings.rules.folderMissing")}</span>}
            </>
          );
        }}
        render={(r) => <div className="muted small">{t(ACTION_WORD[r.action])}{r.arg && r.action === "move" ? ` → ${folderLabelIn(folders, r.arg, r.accountId)}` : ""}</div>}
        extra={(r) => {
          const i = own.findIndex((x) => x.id === r.id);
          return (
            <>
              <button className="icon-btn" title={t("mail.acct.moveUp")} aria-label={t("mail.acct.moveUp")} disabled={i <= 0} onClick={(e) => { e.stopPropagation(); void move(r, false); }}><ChevronUp size={15} /></button>
              <button className="icon-btn" title={t("mail.acct.moveDown")} aria-label={t("mail.acct.moveDown")} disabled={i < 0 || i >= own.length - 1} onClick={(e) => { e.stopPropagation(); void move(r, true); }}><ChevronDown size={15} /></button>
              <button className="icon-btn" title={t("settings.rules.runNow")} aria-label={t("settings.rules.runNow")} onClick={(e) => { e.stopPropagation(); void runNow(r); }}><Play size={15} /></button>
            </>
          );
        }}
        onOpen={(r) => setDlg({ rule: r })}
        onDelete={async (r) => {
          if (await confirm({ title: t("settings.filters.deleteTitle"), confirmLabel: t("common.delete"), danger: true })) {
            await api.deleteRule(r.id);
            void load();
          }
        }}
      />
      <button className="btn" onClick={() => setDlg({})}>
        <Plus size={14} /> {t("settings.filters.new")}
      </button>
      {dlg && <LazyRuleDialog key={dlg.rule?.id ?? "new"} rule={dlg.rule} scope={scope} onClose={() => setDlg(null)} onSaved={() => void load()} />}
    </>
  );
}

function NotifyPanel({ scope }: { scope: string | null }) {
  const t = useT();
  const os = usePlatform((s) => s.os);
  const windows = os === "windows";
  // (W5.4) do the notifications of this system have buttons? Windows always; macOS never; Linux when its notification service lists the capability (asked once per run)
  const [buttons, setButtons] = useState<boolean | null>(windows ? true : os === "macos" ? false : null);
  useEffect(() => {
    if (windows || os === "macos") return setButtons(windows);
    let live = true;
    api.notifyCaps().then((c) => live && setButtons(c.actions)).catch(() => live && setButtons(false));
    return () => {
      live = false;
    };
  }, [windows, os]);
  return (
    <>
      <OvRow id="notifyDesktop" scope={scope} k="notifications" label={t("settings.notify.desktop")}>
        {(v, set) => <Switch checked={v} onChange={set} />}
      </OvRow>
      {buttons === false && <div className="muted small">{os === "macos" ? t("settings.notify.noButtons", { os: "macOS" }) : t("settings.notify.noButtonsDesktop")}</div>}
      <OvRow id="smartNotify" scope={scope} k="smartNotifications" label={t("settings.notify.smart")} hint={t("settings.notify.smartHint")}>
        {(v, set) => <Switch checked={v} onChange={set} />}
      </OvRow>
      <OvRow id="notifyPreview" scope={scope} k="notifyPreview" label={t("settings.appearance.preview")}>
        {(v, set) => <Switch checked={v} onChange={set} />}
      </OvRow>
      <OvRow id="notifySound" scope={scope} k="notifySound" label={t("settings.notify.sound")} hint={t("settings.notify.soundOnHint")}>
        {(v, set) => <SoundControl value={v} onChange={set} />}
      </OvRow>
      {buttons === true && (
      <OvRow id="notifyButtons" scope={scope} k="notifyActions" label={t("settings.notify.buttons")} hint={t("settings.notify.buttonsHint")}>
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

/** Senders whose remote content always loads (1.0.10, remote_ok.rs): one list for every mailbox, so it looks the same in each scope. */
function TrustedSenders({ global }: { global: boolean }) {
  const t = useT();
  const confirm = useStore((x) => x.confirm);
  const showToast = useStore((x) => x.showToast);
  const list = useTrusted((x) => x.emails);
  const [added, setAdded] = useState<Record<string, number>>({});
  const [q, setQ] = useState("");
  useEffect(() => ensureTrustedLoaded(), []);
  // the dates come with the list; read again whenever the list changes (another window, the notice above a message)
  useEffect(() => {
    let live = true;
    void api.listRemoteOk().then((rows) => live && setAdded(Object.fromEntries(rows.map((r) => [r.email.toLowerCase(), r.added])))).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [list]);
  const all = [...list].sort();
  const needle = q.trim().toLowerCase();
  const shown = needle ? all.filter((e) => e.includes(needle)) : all;
  const day = (ms?: number) => (ms ? new Intl.DateTimeFormat(intlLocale(), { year: "numeric", month: "short", day: "numeric" }).format(new Date(ms)) : "");
  const fail = (e: unknown) => showToast(() => t("reading.trust.saveFailed", { error: friendlyError(e) }), undefined, "error");
  const clearAll = async () => {
    if (!(await confirm({ title: t("settings.reading.trustedRemoveAllTitle"), body: t("settings.reading.trustedRemoveAllBody", { n: all.length }), confirmLabel: t("settings.reading.trustedRemoveAllConfirm"), danger: true }))) return;
    try {
      await api.remoteOkClear();
      await reloadTrusted();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <>
      <Row id="trusted" label={t("settings.reading.trusted")} hint={t("settings.reading.trustedHint")}>
        {all.length >= 2 ? <button className="btn small" onClick={() => void clearAll()}>{t("settings.reading.trustedRemoveAll")}</button> : null}
      </Row>
      <div className="trusted-list">
        {global && <div className="muted small">{t("settings.reading.trustedGlobalOn")}</div>}
        {all.length === 0 && <div className="muted">{t("settings.reading.trustedNone")}</div>}
        {all.length > 8 && (
          <input type="search" className="trusted-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("settings.reading.trustedSearch")} aria-label={t("settings.reading.trustedSearch")} />
        )}
        {shown.map((e) => (
          <div key={e} className="list-row">
            <div className="lr-name">
              <span className="lr-title" title={e}>{e}</span>
              <span className="small muted">{t("settings.reading.trustedAdded", { date: day(added[e]) })}</span>
            </div>
            <button
              className="btn small"
              aria-label={t("settings.reading.trustedRemoveLabel", { email: e })}
              onClick={() => void removeTrusted(e).catch(fail)}
            >
              {t("common.remove")}
            </button>
          </div>
        ))}
        {all.length > 8 && shown.length === 0 && <div className="muted">{t("settings.reading.trustedNoMatch", { q: q.trim() })}</div>}
      </div>
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
      <TrustedSenders global={eff(prefs, scope, "loadRemote")} />
      <OvRow id="inlineAuto" scope={scope} k="inlineAutoLoadMB" label={t("settings.reading.inlineAuto")} hint={t("settings.reading.inlineAutoHint")}>
        {(v, set) => (
          <select value={v} onChange={(e) => set(Number(e.target.value) as Prefs["inlineAutoLoadMB"])}>
            <option value={2}>{t("settings.reading.mbEach", { n: 2 })}</option>
            <option value={5}>{t("settings.reading.mbEach", { n: 5 })}</option>
            <option value={0}>{t("settings.reading.always")}</option>
          </select>
        )}
      </OvRow>
      <OvRow id="fetchEvery" scope={scope} k="syncMinutes" label={t("settings.reading.fetchEvery")}>
        {(v, set) => (
          <select value={v} onChange={(e) => set(Number(e.target.value))}>
            {[1, 2, 5, 10, 15, 30].map((n) => <option key={n} value={n}>{t("settings.reading.minutes", { n })}</option>)}
          </select>
        )}
      </OvRow>
      <OvRow id="push" scope={scope} k="pushMail" label={t("settings.reading.push")} hint={t("settings.reading.pushHint")}>
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
  const keys = (scope ? folders.filter((f) => f.accountId === scope).map((f) => ({ key: f.key, label: folderTitle(f, folders) })) : ["inbox", "drafts", "sent", "archive", "junk", "trash"].map((k) => ({ key: k, label: folderLabel(k) }))).filter((k) => folderVisible(folders, scope, k.key));
  return (
    <>
      <div className="muted small pad">{scope ? t("settings.folders.account") : t("settings.folders.all")}</div>
      {keys.map(({ key, label }) => (
        // One Inbox (the Inbox of all accounts) is always in Favorites: its switch is on and locked
        <Row key={key} label={label} hint={!scope && key === "inbox" ? t("settings.folders.inboxAlways") : undefined} noSearch /* settings-search: skip – one row per folder, the Folders section itself is registered */>
          <Switch checked={!scope && key === "inbox" ? true : isFav(`${scope ?? "*"}|${key}`)} disabled={!scope && key === "inbox"} onChange={() => toggle(`${scope ?? "*"}|${key}`)} />
        </Row>
      ))}
    </>
  );
}

function ProfilePanel({ account }: { account: Account }) {
  const t = useT();
  const accent = useStore((s) => s.prefs.accent);
  const color = accountColor(account, accent);
  const accounts = useStore((s) => s.accounts);
  const [replyErr, setReplyErr] = useState<string | null>(null);
  const upd = async (patch: Partial<Account>) => {
    const n = { ...account, ...patch };
    await api.updateAccount(account.id, n.displayName, n.color ?? null, patch.replyTo);
    useStore.setState((s) => ({ accounts: s.accounts.map((x) => (x.id === account.id ? n : x)) }));
  };
  // Reply-To: saved when the field is left; a text that is not one address shows the error and leaves the saved value as it was
  const saveReplyTo = async (text: string) => {
    const v = parseReplyTo(text, singleLabelHostsOf(accounts));
    if (v === null) return setReplyErr(t("backend.EMAIL_INVALID"));
    if (v === (account.replyTo ?? "")) return setReplyErr(null);
    try {
      await upd({ replyTo: v });
      setReplyErr(null);
    } catch (e) {
      setReplyErr(backendText(String(e)) ?? friendlyError(e));
    }
  };
  return (
    <>
      <Row id="displayName" label={t("settings.add.displayName")} hint={t("settings.profile.displayNameHint")}><input autoComplete="off" defaultValue={account.displayName} placeholder={t("settings.add.yourName")} onBlur={(e) => void upd({ displayName: e.target.value })} /></Row>
      <Row label={t("settings.profile.replyTo")} hint={t("settings.profile.replyToHint")} id="replyTo">
        <input key={account.id} type="text" inputMode="email" autoComplete="off" spellCheck={false} defaultValue={account.replyTo ?? ""} aria-invalid={replyErr ? true : undefined} aria-describedby={replyErr ? "set-replyTo-err" : undefined} onChange={() => setReplyErr(null)} onBlur={(e) => void saveReplyTo(e.target.value)} />
        {replyErr && <div className="field-err" id="set-replyTo-err" role="alert">{replyErr}</div>}
      </Row>
      <Row id="color" label={t("settings.profile.color")} hint={t("settings.profile.colorHint")}>
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
      <Row id="signIn" label={t("settings.server.signIn")}>{account.auth === "oauth_google" ? "Google (OAuth 2.0)" : account.auth === "oauth_microsoft" ? "Microsoft (OAuth 2.0)" : t("settings.server.passwordStored", { store: credStore() })}</Row>
      <Row id="incoming" label={t("settings.server.incoming")}>{account.imapHost}:{account.imapPort}</Row>
      <Row id="newMail" label={t("settings.server.newMail")} hint={t("settings.server.newMailHint")}>{push === "push" ? t("settings.server.push") : t("settings.server.polling")}</Row>
      <Row id="outgoing" label={t("settings.server.outgoing")}>{account.smtpHost}:{account.smtpPort} ({account.smtpSecurity})</Row>
      {account.smtpUsername && <Row label={t("settings.server.smtpLogin")} noSearch /* settings-search: skip – shown for some mailboxes only, the Server section is registered */>{account.smtpUsername}</Row>}
      {account.tlsInsecure && <Row label={t("settings.server.cert")} hint={t("settings.server.certHint")} noSearch /* settings-search: skip – shown for some mailboxes only, the Server section is registered */>{t("settings.server.notVerified")}</Row>}
      <Row id="removeAccount" label={t("settings.server.removeAccount")} hint={t("settings.server.removeHint")}>
        <button className="btn danger" onClick={() => void remove()}><Trash2 size={14} /> {t("common.remove")}</button>
      </Row>
    </>
  );
}

/** Settings > mailbox > Calendar: a Google / Outlook mailbox syncs through its own service (a separate, calendar-only consent in the browser); any other mailbox through a CalDAV server (W7.4). */
function CalendarPanel({ account }: { account: Account }) {
  return calendarSyncKind(account) ? <OauthCalendarPanel account={account} /> : <DavCalendarPanel account={account} />;
}

/** The calendars of a synced mailbox with their Sync switches (the same list for every service), the colour of each, and New calendar where the service can make one. */
function CalendarsList({ account, src, onError }: { account: Account; src: CalSource; onError: (e: string | null) => void }) {
  const t = useT();
  const { bumpCal, loadCalSources, prefs } = useStore();
  const [colorOf, setColorOf] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const newBtn = useRef<HTMLButtonElement>(null);
  const service = sourceService(src);
  const setColor = (id: string, hex: string | null) => {
    onError(null);
    void api.calendarSetColor(id, hex).then(() => { bumpCal(); return loadCalSources(); }).catch((e) => onError(friendlyError(e)));
  };
  if (src.calendars.length === 0 && !canCreateCalendar(src.kind)) return null;
  return (
    <>
      <h4 style={{ margin: "16px 0 2px" }}>{t("settings.calendar.calendars")}</h4>
      <div className="muted small">{t("settings.calendar.calendarsHint")}</div>
      {src.calendars.map((c) => {
        const shown = c.color || accountColor(account, prefs.accent);
        return (
          <Fragment key={c.id}>
            {/* settings-search: skip – the calendars of a mailbox are the person's own data */}
            <div className="set-row" data-search-skip="">
              <div className="set-lbl">
                <div>
                  <button type="button" className="dot-btn" aria-label={t("settings.calendar.colorOf", { name: c.name })} aria-expanded={colorOf === c.id} aria-controls={`cal-color-${c.id}`} onClick={() => setColorOf(colorOf === c.id ? null : c.id)}>
                    <span className="dot" style={{ background: shown }} aria-hidden />
                  </button>
                  {c.name}
                  {c.primary && <span className="muted small"> · {t("settings.calendar.primary")}</span>}
                  {c.readOnly && <span className="muted small"> · {t("settings.calendar.readOnly")}</span>}
                </div>
              </div>
              <div className="set-ctl">
                <Switch checked={c.syncOn} ariaLabel={t("settings.calendar.syncCal", { name: c.name })} onChange={(v) => { onError(null); void api.calendarSetSync(c.id, v).then(() => { bumpCal(); return loadCalSources(); }).catch((e) => onError(friendlyError(e))); }} />
              </div>
            </div>
            {colorOf === c.id && (
              <div className="cal-color-row" id={`cal-color-${c.id}`}>
                <CalColorChoice value={c.customColor ? c.color : null} label={t("settings.calendar.colorOf", { name: c.name })} service={service} onChange={(hex) => setColor(c.id, hex)} />
              </div>
            )}
          </Fragment>
        );
      })}
      {canCreateCalendar(src.kind) && (
        <div className="row-inline set-actions">
          <button ref={newBtn} className="btn small" onClick={() => setMaking(true)}>{t("settings.calendar.newCalendar")}</button>
        </div>
      )}
      {making && (
        <NewCalendarDialog
          account={account}
          service={service}
          onClose={() => (setMaking(false), requestAnimationFrame(() => newBtn.current?.focus()))}
          onDone={() => (setMaking(false), bumpCal(), void loadCalSources(), requestAnimationFrame(() => newBtn.current?.focus()))}
        />
      )}
    </>
  );
}

/** Settings > mailbox > Calendar for a mailbox with no calendar service of its own: connect a CalDAV server (iCloud, Fastmail, Nextcloud, any), then the usual switch, status and calendars. */
function DavCalendarPanel({ account }: { account: Account }) {
  const t = useT();
  const { confirm, showToast, calSources, loadCalSources, bumpCal, calKinds, loadCalKinds } = useStore();
  const src: CalSource | undefined = calSources.find((s) => s.accountId === account.id && s.kind === "caldav");
  const [dialog, setDialog] = useState<"connect" | "password" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const setUp = useRef<HTMLButtonElement>(null);
  const passwordBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => void loadCalSources(), [loadCalSources]);
  useEffect(() => void (calKinds === null && loadCalKinds()), [calKinds, loadCalKinds]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 20_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setErr(null);
  }, [src?.status]);
  const clock = (sec: number) => new Intl.DateTimeFormat(intlLocale(), { hour: "2-digit", minute: "2-digit", timeZone: systemTz() }).format(new Date(sec * 1000));
  if (!src && !(calKinds ?? []).includes("caldav")) return <div className="muted">{t("settings.calendar.none")}</div>;
  const label = src?.dav ? src.dav.label || src.dav.host : "";
  const done = () => {
    const again = dialog === "password";
    setDialog(null);
    if (!again) showToast(t("settings.calendar.syncOn", { email: account.email }), undefined, "success");
    void loadCalSources();
    bumpCal();
  };
  const stop = async () => {
    const ok = await confirm({ title: t("settings.calendar.stopTitle", { email: account.email }), body: t("settings.calendar.stopBody", { service: label }), confirmLabel: t("settings.calendar.stopLabel"), danger: true });
    if (!ok) return;
    setErr(null);
    try {
      await api.calendarDisconnect(account.id);
    } catch (e) {
      setErr(friendlyError(e));
    }
    await loadCalSources();
    bumpCal();
    requestAnimationFrame(() => setUp.current?.focus());
  };
  const line = src ? statusLine(src, { email: account.email, nowSec: now, fmtTime: clock }) : null;
  const note = src ? truncatedNote(src) : null;
  return (
    <>
      {!src ? (
        <Row label={t("settings.calendar.davLabel")} hint={t("settings.calendar.davHint")} id="calendar">
          <button ref={setUp} className="btn small" onClick={() => setDialog("connect")}>{t("settings.calendar.davSetUp")}</button>
        </Row>
      ) : (
        <>
          <Row label={t("settings.calendar.syncWith", { provider: label })} hint={t("settings.calendar.syncHint", { service: label })} id="calendar">
            <Switch checked onChange={(v) => void (!v && stop())} />
          </Row>
          <div className="muted small dav-who">{src.dav?.username} · {src.dav?.host}</div>
          <div className="row-inline set-actions">
            {line?.enterPassword && <button ref={passwordBtn} className="btn primary" onClick={() => setDialog("password")}>{t("settings.calendar.davEnterPassword")}</button>}
            {line && line.syncNow !== "off" && (
              <button className="btn small" disabled={line.syncNow === "disabled"} onClick={() => void api.calendarSyncNow(account.id).then(() => loadCalSources())}>{t("settings.calendar.syncNow")}</button>
            )}
          </div>
        </>
      )}
      <div role="status" aria-live="polite" className="set-status">
        {err ? (
          <div className="field-err" role="alert">{err}</div>
        ) : line ? (
          <div className={line.tone === "bad" ? "notice bad" : "muted small"}>
            {line.text}
            {line.detail && <div style={{ marginTop: 2, fontSize: "0.9em", opacity: 0.8 }}>{line.detail}</div>}
            {note && <div>{note}</div>}
          </div>
        ) : null}
      </div>
      {src && <CalendarsList account={account} src={src} onError={setErr} />}
      {dialog && <CalDavDialog account={account} mode={dialog} source={src} onClose={() => setDialog(null)} onDone={done} />}
    </>
  );
}

function OauthCalendarPanel({ account }: { account: Account }) {
  const t = useT();
  const { confirm, showToast, calSources, loadCalSources, bumpCal } = useStore();
  const kind = calendarSyncKind(account);
  const src: CalSource | undefined = calSources.find((s) => s.accountId === account.id);
  const [connecting, setConnecting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ended, setEnded] = useState<SignInEnd | null>(null);
  // the services this build can connect (it has an OAuth client for them); null until known
  const [kinds, setKinds] = useState<string[] | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const cancelBtn = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null); // what started the consent (the switch or "Allow again"): it gets the focus back when the consent ends
  const switchBox = useRef<HTMLSpanElement>(null);
  const connectRef = useRef<(() => Promise<void>) | null>(null);
  const autostart = useStore((s) => s.calAutostart === account.id);
  useEffect(() => void loadCalSources(), [loadCalSources]);
  useEffect(() => {
    let live = true;
    api.calendarKindsAvailable().then((k) => live && setKinds(k)).catch(() => {});
    return () => void (live = false);
  }, []);
  // the sidebar offer's "Turn on...": the switch's own connect path starts as soon as the section is shown (it asks the W7.7 question first)
  useEffect(() => {
    if (!autostart || kinds === null) return;
    useStore.setState({ calAutostart: null });
    if (!src && kind && kinds.includes(kind)) void connectRef.current?.();
  }, [autostart, kinds, src, kind]);
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
    // (what started it is the switch or Allow access again; when the sidebar offer starts it nothing in the section has the focus: then the switch gets it back)
    const starter = document.activeElement instanceof HTMLElement && document.activeElement.matches("button, input") ? document.activeElement : null;
    // one question before the browser opens (every time: from the switch and from "Allow access again"); Cancel / Esc change nothing
    const go = await confirm({
      title: t("calendar.consent.title"),
      body: t("calendar.consent.body", { provider: providerName(kind), email: account.email }),
      confirmLabel: t("calendar.consent.open"),
    });
    if (!go) {
      // the question's own button is gone: focus goes back to what started it
      const back = starter && document.contains(starter) && !(starter as HTMLButtonElement).disabled ? starter : switchBox.current?.querySelector("input");
      back?.focus();
      return;
    }
    opener.current = starter;
    setConnecting(true);
    try {
      await api.calendarConnect(account.id);
      showToast(t("settings.calendar.syncOn", { email: account.email }), undefined, "success");
      void useStore.getState().answerCalOffer(); // a calendar is connected: the sidebar offer is over for every mailbox
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
  connectRef.current = connect;
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
  // this build has no OAuth client for the service: nothing to click into an error (a mailbox that already syncs can still be turned off)
  const noClient = !src && kinds !== null && !kinds.includes(kind);
  return (
    <>
      <Row
        label={t("settings.calendar.syncWith", { provider: providerName(kind) })}
        hint={t("settings.calendar.syncHint", { service })}
        id="calendar"
      >
        <span ref={switchBox}><Switch checked={on} disabled={connecting || noClient} onChange={(v) => void (v ? connect() : stop())} /></span>
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
        ) : noClient ? (
          <div className="muted small">{t("calendar.err.noClient", { provider: providerName(kind) })}</div>
        ) : null}
      </div>
      {src && <CalendarsList account={account} src={src} onError={setErr} />}
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
        <Row id="myKey" label={t("settings.security.myKey")} hint={t("settings.security.myKeyHint")}>
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
      <OvRow id="pgpEncryptDefault" scope={scope} k="pgpEncrypt" label={t("settings.security.encrypt")} hint={t("settings.security.encryptHint")}>
        {(v, set) => (
          <select value={v} onChange={(e) => set(e.target.value as Prefs["pgpEncrypt"])}>
            <option value="possible">{t("settings.security.whenPossible")}</option>
            <option value="never">{t("settings.security.neverEncrypt")}</option>
            <option value="always">{t("settings.security.alwaysEncrypt")}</option>
          </select>
        )}
      </OvRow>
      <OvRow id="pgpSignDefault" scope={scope} k="pgpSign" label={t("settings.security.sign")}>
        {(v, set) => <Switch checked={v} onChange={set} />}
      </OvRow>
      <OvRow id="attachKey" scope={scope} k="pgpAttachKey" label={t("settings.security.attachKey")} hint={t("settings.security.attachKeyHint")}>
        {(v, set) => <Switch checked={v} onChange={set} />}
      </OvRow>
      <OvRow id="encryptDrafts" scope={scope} k="pgpEncryptDrafts" label={t("settings.security.encryptDrafts")} hint={t("settings.security.encryptDraftsHint")}>
        {(v, set) => <Switch checked={v} onChange={set} />}
      </OvRow>
      <OvRow id="importKeys" scope={scope} k="pgpImportFromMail" label={t("settings.security.importKeys")} hint={t("settings.security.importKeysHint")}>
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

export type MbTab = "profile" | "composing" | "signatures" | "templates" | "filters" | "notifications" | "reading" | "calendar" | "security" | "folders" | "server";

/** The sections of a mailbox (scope = account id) or of "All accounts" (null). They are listed under the mailbox in the Settings navigation. */
function mailboxSections(scope: string | null, accounts: Account[]): [MbTab, Key][] {
  // a Google / Gmail / Microsoft mailbox has its own service to sync; any other mailbox can use a CalDAV server where this build offers it (W7.4)
  const dav = (useStore.getState().calKinds ?? []).includes("caldav");
  const calendar = scope !== null && accounts.some((a) => a.id === scope && (calendarSyncKind(a) !== null || (dav && calendarDavEligible(a))));
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
          <h3 id="set-pg-mb">{account ? account.email : t("settings.scope.allAccounts")}</h3>
          <div className="muted small">
            {account ? t("settings.mailbox.accountIntro") : t("settings.mailbox.allIntro")}
          </div>
        </div>
      </div>
      <div className="mb-body" id="set-sec" tabIndex={-1} role="region" aria-label={t(mailboxSections(scope, accounts).find(([k]) => k === active)![1])}>
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
  // (in the Microsoft Store version the switch is the package's startup task: Windows or the organisation may have turned it off for good, `locked`)
  const [autostart, setAutostart] = useState<AutostartInfo>({ enabled: false, locked: null });
  useEffect(() => void api.getAutostart().then(setAutostart).catch(() => undefined), []);
  // macOS: what the system lets the app do with notifications. Read when the tab opens and each time the window comes back to the front (the person may have changed it in System Settings)
  const [perm, setPerm] = useState<NotifyPermission>("unsupported");
  useEffect(() => {
    if (os !== "macos") return;
    let live = true;
    const read = () => void api.notifyPermission().then((s) => live && setPerm(s)).catch(() => undefined);
    read();
    window.addEventListener("focus", read);
    return () => {
      live = false;
      window.removeEventListener("focus", read);
    };
  }, [os]);
  const test = async () => {
    try {
      if (os === "macos") {
        // never asked: this asks (the system shows its dialog once); denied: nothing is sent, the note says why
        const state = await api.notifyPermission("sendTest");
        setPerm(state);
        if (state === "denied") {
          showToast(() => t("settings.tray.macDenied"), undefined, "info");
          return;
        }
      }
      await api.testNotification();
    } catch (e) {
      showToast(() => os === "windows" ? friendlyError(e) : t("settings.tray.testFailed", { error: friendlyError(e) }), undefined, "error");
    }
  };
  const toggleAuto = async (v: boolean) => {
    try {
      await api.setAutostart(v);
      setAutostart((a) => ({ ...a, enabled: v }));
    } catch (e) {
      showToast(() => friendlyError(e), undefined, "error");
      void api.getAutostart().then(setAutostart).catch(() => undefined); // (the state may have changed in Windows)
    }
  };
  return (
    <div>
      <h3 id="set-pg-tray">{t(trayTabTitleKey(tray, os))}</h3>
      <div className="muted small">{os === "windows" ? t("settings.tray.introWindows") : t("settings.tray.intro")}</div>
      <Row id="testNotify" label={t("settings.tray.test")}><button className="btn" onClick={() => void test()}>{t("settings.tray.sendTest")}</button></Row>
      {os === "macos" && perm === "denied" && (
        <div className="mac-notify-denied">
          <div className="muted small">{t("settings.tray.macDenied")}</div>
          <button className="btn" onClick={() => void api.openNotificationSettings().catch((e) => showToast(() => friendlyError(e), undefined, "error"))}>{t("settings.tray.macOpenSettings")}</button>
        </div>
      )}
      <Row id="sentSound" label={t("settings.tray.sentSound")}><Switch checked={prefs.sentSound} onChange={(v) => setPrefs({ sentSound: v })} /></Row>
      <Row
        id="keepRunning"
        label={t(keepRunningLabelKey(os))}
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
        <Row id="trayBadge" label={t(trayBadgeLabelKey(os))} hint={t("settings.tray.trayBadgeHint")}>
          <select value={prefs.trayBadge} onChange={(e) => setPrefs({ trayBadge: e.target.value as Prefs["trayBadge"] })}>
            <option value="number">{t("settings.tray.unreadNumber")}</option>
            <option value="dot">{t("settings.tray.dotOnly")}</option>
            <option value="off">{t("common.none")}</option>
          </select>
        </Row>
      )}
      {(os === "windows" || os === "macos") && (
        <Row id="taskbarBadge" label={os === "macos" ? t("settings.tray.dockBadge") : t("settings.tray.taskbarBadge")}>
          <select value={prefs.taskbarBadge} onChange={(e) => setPrefs({ taskbarBadge: e.target.value as Prefs["taskbarBadge"] })}>
            <option value="number">{t("settings.tray.unreadNumber")}</option>
            <option value="off">{t("common.none")}</option>
          </select>
        </Row>
      )}
      <Row id="countOther" label={t("settings.tray.countOther")} hint={t("settings.tray.countOtherHint")}>
        <Switch checked={prefs.countOtherMail} onChange={(v) => setPrefs({ countOtherMail: v })} />
      </Row>
      <Row
        id="autostart"
        label={os === "windows" ? t("settings.tray.autostartWindows") : t("settings.tray.autostart")}
        hint={autostart.locked === "user" ? t("settings.tray.autostartOffInWindows") : autostart.locked === "policy" ? t("settings.tray.autostartByPolicy") : os === "linux" && !tray ? t("settings.tray.startsOpen") : startsMinimizedHint(os) ? t(startsMinimizedKey(os)) : undefined}
      >
        <Switch checked={autostart.enabled} disabled={autostart.locked !== null} onChange={(v) => void toggleAuto(v)} />
      </Row>
      {startInTrayOffered(os, tray) && (
        <Row id="startInTray" label={t("settings.tray.startInTray")} hint={!autostart.enabled && autostart.locked === null ? t("settings.tray.startInTrayNeedsSignIn") : undefined}>
          <Switch checked={prefs.startInTray} disabled={!autostart.enabled} onChange={(v) => setPrefs({ startInTray: v })} />
        </Row>
      )}
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
      <h3 id="set-pg-actions">{t("settings.actions.title")}</h3>
      <div className="muted small">{t("settings.actions.intro")}</div>
      {ALL_ACTIONS.map(([k, l]) => (
        <Row key={k} id={`act-${k}`} label={t(l)}><Switch checked={prefs.hoverActions.includes(k)} onChange={() => toggle(k)} /></Row>
      ))}
    </div>
  );
}

function TimesTab() {
  const t = useT();
  const { prefs, setPrefs } = useStore();
  const times = prefs.snoozeTimes;
  const sel = (k: keyof typeof times, label: string) => (
    <Row id={`snooze-${k}`} label={label}>
      <select value={times[k]} onChange={(e) => setPrefs({ snoozeTimes: { ...times, [k]: Number(e.target.value) } })}>
        {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
      </select>
    </Row>
  );
  return (
    <div>
      <h3 id="set-pg-times">{t("settings.times.title")}</h3>
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
      <h3 id="set-pg-blocked">{t("settings.blocked.title")}</h3>
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
  const [fetchState, setFetchState] = useState<"idle" | "loading" | "error" | "invalid">("idle");
  const [modelsErr, setModelsErr] = useState("");
  const [ready, setReady] = useState(false);
  // the saved key, for the rule "ask only when the request changed" (aiModelsKey.ts): which one it is ("s" = the one that was saved before this tab opened; a key saved here keeps the tag of the text typed)
  const [savedTag, setSavedTag] = useState("s");
  // what the list was last asked for (after the 600 ms the typing has to rest): Save moves the typed key to the saved key, which is the same request, so it asks nothing
  const [asked, setAsked] = useState<{ k: string; endpoint: string; key: string; modelsUrl: string; keyOrigin: string; invalid: boolean } | null>(null);
  // "Advanced": the model list URL (W8.11) and the one other server the key may go to (the origin; "" = none). The disclosure is closed unless a list URL is saved
  const [modelsUrl, setModelsUrl] = useState("");
  const [keyOrigin, setKeyOrigin] = useState("");
  const [advOpen, setAdvOpen] = useState(false);
  const resolved = resolveModelsUrl(v.ai_endpoint, modelsUrl);
  const other = otherServer(v.ai_endpoint, modelsUrl, resolved);
  const sendKey = keyIsSent(v.ai_endpoint, modelsUrl, resolved, keyOrigin);
  const listHost = resolved.kind === "url" ? hostLabel(resolved.url) : "";
  const auto = resolveModelsUrl(v.ai_endpoint, "");
  const autoUrl = auto.kind === "url" ? auto.url : undefined; // (the placeholder of the field: where the list is asked when it stays empty)
  const fetchKey = modelsFetchKey(v.ai_endpoint, key, { has: hasKey, tag: savedTag }, resolved.kind === "none" ? undefined : { url: resolved.kind === "url" ? resolved.url : "invalid", sendKey });
  // Save (or Remove the saved key) failed: said in the slot under Save, in place of the model list's text, until something is typed or tried again
  const [saveErr, setSaveErr] = useState("");
  // the Model control is a list when the endpoint listed models and a text box otherwise. It is never swapped under the user's hands: while
  // it has focus it keeps its kind (the list that arrives, or goes, is adopted when focus leaves), so focus and caret stay where they are
  const [modelFocused, setModelFocused] = useState(false);
  const [heldList, setHeldList] = useState(false);
  const asList = modelFocused ? heldList : models.length > 0;
  const keyRef = useRef<HTMLInputElement>(null);
  // the request that is due: when the typing rests for 600 ms and it differs from the last one (so typing a letter and taking it back, Save, a second Save, ask nothing)
  useEffect(() => {
    if (!ready || fetchKey === asked?.k) return;
    const due = { k: fetchKey, endpoint: v.ai_endpoint.trim(), key: key.trim(), modelsUrl: modelsUrl.trim(), keyOrigin, invalid: resolved.kind === "invalid" };
    if (fetchKey === NO_LIST) return setAsked({ ...due, endpoint: "", key: "" }); // (an emptied Base URL clears the list at once, as it always did)
    const timer = setTimeout(() => setAsked(due), 600);
    return () => clearTimeout(timer);
  }, [ready, fetchKey, asked]); // eslint-disable-line react-hooks/exhaustive-deps
  // while the typing waits for its 600 ms the slot already says Loading (a change that is taken back before it ends leaves nothing behind)
  const modelsState = ready && fetchKey !== NO_LIST && fetchKey !== asked?.k ? "loading" : fetchState;
  useEffect(() => {
    if (!asked) return;
    if (asked.k === NO_LIST || asked.invalid) {
      // (no request: no Base URL, or a list URL that is none of the three forms - the slot says so, Save is not blocked, Model is a text box)
      setModels([]);
      setFetchState(asked.invalid ? "invalid" : "idle");
      return;
    }
    let stale = false;
    setFetchState("loading");
    api.aiListModels(asked.endpoint, asked.key || undefined, asked.modelsUrl || undefined, asked.keyOrigin || undefined)
      .then((ids) => {
        if (stale) return;
        setModels(ids);
        setFetchState("idle");
      })
      .catch((e) => {
        if (stale) return;
        setModels([]);
        setModelsErr(cutAtWord(friendlyError(e), 70)); // the status line below Save has two lines: a longer reason would push its second sentence out
        setFetchState("error");
      });
    return () => {
      stale = true;
    };
  }, [asked]);
  useEffect(() => {
    void Promise.all([api.getSetting("ai_endpoint"), api.getSetting("ai_model"), api.hasSecret("ai_key"), api.getSetting("ai_models_url"), api.getSetting("ai_models_key_origin")]).then(([a, c, h, u, o]) => {
      setV({ ai_endpoint: a ?? "", ai_model: c ?? "" });
      setHasKey(h);
      setModelsUrl(u ?? "");
      setKeyOrigin(o ?? "");
      setAdvOpen(!!u?.trim()); // (a list URL in effect is never hidden; it does not open by itself otherwise)
      setReady(true);
    });
  }, []);
  // typing clears it (an effect on the values would also clear an error that arrives right after Save emptied the key box)
  const edit = (patch: Partial<typeof v>) => (setSaveErr(""), setV({ ...v, ...patch }));
  /** what is stored for the permission: the list's origin while the switch is on for it, else nothing */
  const permitted = other && sendKey && resolved.kind === "url" ? (originOf(resolved.url) ?? "") : "";
  const save = async () => {
    setSaveErr("");
    try {
      await Promise.all([api.setSetting("ai_endpoint", v.ai_endpoint), api.setSetting("ai_model", v.ai_model), api.setSetting("ai_models_url", modelsUrl.trim()), api.setSetting("ai_models_key_origin", permitted)]);
      if (key.trim()) {
        await api.setSecret("ai_key", key.trim());
        setSavedTag(keyTag(key)); // (the typed key is now the saved one: the same key, so the list is not asked again)
        setHasKey(true);
        setKey("");
      }
      await refreshAi();
      aiSettingsSaved(); // (the toast "AI Assistant is not set up" is answered by this save)
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
    : modelsState === "invalid" ? t("backend.AI_MODELS_URL_BAD")
    : modelsState === "loading" ? t("settings.ai.loadingModels")
    : modelsState === "error" ? t("settings.ai.modelsError", { error: modelsErr })
    : models.length === 0 && v.ai_endpoint.trim() ? t("settings.ai.noModels") : "";
  return (
    <div>
      <h3 id="set-pg-ai">{t("settings.ai.title")}</h3>
      <div className="muted small">{t("settings.ai.intro")}</div>
      {/* the way to report harmful AI content (Microsoft Store policy 11.16): the help page of the language in use, the section "Content from the AI Assistant" */}
      <div style={{ margin: "4px 0 8px" }}><button className="link" onClick={() => void openUpdateLink(siteUrl("help.html#ai-report"))}>{t("settings.ai.report")}</button></div>
      <div className="form">
        <label>{t("settings.ai.baseUrl")}</label>
        <input autoComplete="off" id="set-aiBaseUrl" aria-label={t("settings.ai.baseUrl")} placeholder="https://api.openai.com/v1" value={v.ai_endpoint} onChange={(e) => edit({ ai_endpoint: e.target.value })} />
        {/* the link to remove the saved key sits on the label's line: it appears after Save without moving the fields below */}
        <div className="field">
          <div className="field-head">
            <label>{t("settings.ai.apiKey")}</label>
            {hasKey && (
              <button className="link small" onClick={() => void removeKey()}>{t("settings.ai.removeKey")}</button>
            )}
          </div>
          <input ref={keyRef} autoComplete="off" id="set-aiKey" aria-label={t("settings.ai.apiKey")} type="password" value={key} onChange={(e) => (setSaveErr(""), setKey(e.target.value))} placeholder={hasKey ? t("settings.add.savedIn", { store: credStore() }) : t("settings.ai.keyOptional")} />
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
          <input autoComplete="off" id="set-aiModel" aria-label={t("settings.ai.model")} value={v.ai_model} placeholder={t("settings.ai.modelPlaceholder")} onChange={(e) => edit({ ai_model: e.target.value })} {...modelFocus} />
        )}
        {/* Advanced (W8.11): between Model and Save, collapsed unless a list URL is saved: what Save stores is above it, and the status slot under Save stays the last thing of the form (opening Advanced pushes Save down, which is expected) */}
        <details className="advanced" open={advOpen} onToggle={(e) => setAdvOpen(e.currentTarget.open)}>
          <summary>{t("settings.add.advanced")}</summary>
          <div className="form">
            <label>{t("settings.ai.modelsUrl")}</label>
            <input id="set-aiModelsUrl" aria-label={t("settings.ai.modelsUrl")} aria-describedby="set-aiModelsUrlHint" spellCheck={false} autoComplete="off" placeholder={autoUrl} value={modelsUrl} onChange={(e) => (setSaveErr(""), setModelsUrl(e.target.value))} />
            <div id="set-aiModelsUrlHint" className="muted small">{t("settings.ai.modelsUrlHint")}</div>
            {other && (
              <>
                <div className="muted small"><ShieldAlert size={13} aria-hidden style={{ verticalAlign: "-2px", marginRight: 4 }} />{t("settings.ai.modelsUrlOtherHost", { host: listHost })}</div>
                <Switch checked={sendKey} onChange={(on) => setKeyOrigin(on && resolved.kind === "url" ? (originOf(resolved.url) ?? "") : "")} label={t("settings.ai.modelsUrlSendKey", { host: listHost })} />
              </>
            )}
          </div>
        </details>
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
      <h3 id="set-pg-pgp">{t("settings.pgp.title")}</h3>
      <div className="muted small">{t("settings.pgp.intro")}</div>
      {err && <div className="notice bad" role="alert" style={{ marginTop: 10 }}>{t("settings.pgp.loadFailed", { error: err })} <button className="link" onClick={bumpKeys}>{t("common.retry")}</button></div>}
      <div className="set-card-head" style={{ marginTop: 14 }}>
        <h4 style={{ margin: 0, flex: 1 }}>{t("settings.pgp.yourKeys")}</h4>
        <button id="set-pgpImport" className="btn small" onClick={() => setDialog({ type: "pgp-import", back: "pgp" })}><Upload size={13} /> {t("settings.pgp.import")}</button>
        <button id="set-pgpGenerate" className="btn small primary" onClick={() => setDialog({ type: "pgp-generate", back: "pgp" })}><Plus size={13} /> {t("settings.pgp.generate")}</button>
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
        <input autoComplete="off" id="set-pgpOthers" placeholder={t("settings.pgp.searchPlaceholder")} aria-label={t("settings.pgp.searchKeys")} style={{ width: 340, maxWidth: "100%" }} value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn small" onClick={() => setDialog({ type: "pgp-import", back: "pgp" })}><Upload size={13} /> {t("settings.pgp.import")}</button>
      </div>
      <div style={{ marginTop: 8 }}>
        {others.length === 0 && keys && <div className="muted small">{t("settings.pgp.othersEmpty")}</div>}
        {others.length > 0 && shown.length === 0 && <div className="muted small">{t("settings.pgp.noMatch", { q })}</div>}
        {shown.map((k) => <KeyRow key={k.fingerprint} k={k} onOpen={() => open(k.fingerprint)} />)}
      </div>
      <h4>{t("settings.pgp.passphrases")}</h4>
      <Row id="pgpRemember" label={t("settings.pgp.remember")} hint={t("settings.pgp.rememberHint")}>
        <select value={prefs.pgpRemember} onChange={(e) => setPrefs({ pgpRemember: e.target.value as Prefs["pgpRemember"] })}>
          <option value="session">{t("settings.pgp.untilQuit")}</option>
          <option value="never">{t("settings.pgp.askEveryTime")}</option>
        </select>
      </Row>
      <Row id="pgpLockAll" label={t("settings.pgp.lockAll")} hint={t("settings.pgp.lockAllHint")}>
        <button className="btn small" onClick={() => void api.pgpLockAll().then(() => (bumpKeys(), showToast(t("settings.pgp.allLocked"), undefined, "success")))}>{t("settings.pgp.lockNow")}</button>
      </Row>
    </div>
  );
}

function ShortcutsTab() {
  const t = useT();
  const os = usePlatform((s) => s.os);
  const rows: [string, Key][] = [
    ["c", "settings.keys.newMail"], ["Shift+C / R / A / F", "settings.keys.shiftCompose"], ["Ctrl+Shift+O", "settings.keys.popOutCompose"], ["Ctrl+Shift+O", "settings.keys.popInCompose"], ["/", "settings.keys.search"], ["Ctrl+F", "settings.search.label"], ["j / k", "settings.keys.nextPrev"], ["e", "settings.action.archive"], ["#", "common.delete"], ["!", "settings.filters.toJunk"],
    ["s", "settings.action.snooze"], ["p", "settings.action.pin"], ["*", "settings.action.flag"], ["u", "settings.keys.markUnread"], ["r", "settings.action.reply"], ["a", "settings.composing.replyAll"], ["f", "settings.keys.forward"],
    ["Ctrl+Enter", "settings.keys.send"], ["Ctrl+Shift+Enter", "settings.keys.sendLater"], ["Ctrl+Shift+P", "settings.keys.insertPicture"], ["Ctrl+Shift+E", "settings.keys.encrypt"], ["Ctrl+Shift+G", "settings.keys.sign"], ["Ctrl+Shift+C / Ctrl+Shift+B", "settings.keys.addCcBcc"],
    ["Space / Enter", "settings.keys.preview"], ["Ctrl+S", "settings.keys.saveAs"], ["Ctrl+Shift+S", "settings.keys.saveAll"],
    ["Ctrl+1 / Ctrl+2", "settings.keys.mailCalendar"], ["Ctrl+B", "settings.keys.sideMenu"], ["c · t · ← / → · m / w / a", "settings.keys.calendarKeys"], ["Ctrl+Enter", "settings.keys.editEvent"],
    ["Ctrl+] / Ctrl+[", "settings.keys.fontSize"], ["Ctrl+= / Ctrl+Shift+=", "settings.keys.subSuper"], [os === "macos" ? "Ctrl+\\" : "Ctrl+Space / Ctrl+\\", "compose.fmt.clear"], ["Alt+F10", "settings.keys.focusToolbar"],
    ["Ctrl+Shift+L / 8", "compose.fmt.bulleted"], ["Ctrl+Shift+7", "compose.fmt.numbered"], ["Ctrl+L / E / R / Shift+J", "settings.keys.align"], ["Ctrl+T / Ctrl+Shift+T", "settings.keys.indent"],
    ["Ctrl+Shift+S", "settings.keys.stylesMenu"], ["Ctrl+Shift+N / Ctrl+Alt+1-3", "settings.keys.styleKeys"], [os === "macos" ? "Ctrl+F / Ctrl+Shift+H" : "Ctrl+F / Ctrl+H", "compose.fmt.find"], ["Shift+F3", "compose.fmt.case"], ["Ctrl+Shift+D", "compose.fmt.painter"],
    ["Ctrl+A", "settings.keys.selectAll"], ["Ctrl+K", "settings.keys.commandBar"], ["Ctrl+Shift+K", "settings.keys.commandBarAnywhere"], ["F5", "settings.keys.syncNow"], ["Esc", "settings.keys.closeDeselect"], ["Shift+Enter", "settings.keys.openInWindow"], ["Ctrl+W", "settings.keys.closeWindow"],
    [os === "macos" ? "Ctrl+Shift+V / Ctrl+Option+Shift+V" : "Ctrl+Shift+V", "settings.keys.pasteText"], [os === "macos" ? "Cmd" : "Ctrl", "settings.keys.pasteOptions"],
    ["Ctrl+K", "settings.keys.insertLink"], ["Ctrl+Click", "settings.keys.openLink"], ["Tab / Shift+Tab", "settings.keys.tableCells"],
  ];
  return (
    <div>
      <h3 id="set-pg-shortcuts">{t("settings.keys.title")}</h3>
      {rows.map(([k, d]) => (
        // settings-search: skip – the Shortcuts table is searched as a page, not row by row
        <div key={k + d} className="set-row" data-search-skip=""><kbd>{kbd(os === "macos" && k === "#" ? "delete / #" : k, os)}</kbd><span>{t(d)}</span></div>
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
      <h3 id="set-pg-about">{t("settings.about.title")}</h3>
      <p>{tx("settings.about.tagline", { name: <b>Hey Look!</b> })}</p>
      {testData && <div className="notice info selectable">{t("settings.about.testBuild", { dir: testData })}</div>}
      <UpdatesBlock
        privacy={
          <p className="muted small">{t("settings.about.privacy")}</p>
        }
        autoSwitch={
          <Row
            id="autoCheck"
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

/**
 * Settings, as a dialog of the main window or (`windowed`, W4.6) as the page of the Settings window. `section`: the section of a mailbox page it opens on (a dialog that moved into
 * the window keeps it).
 */
export function Settings({ initial, focus, nonce, section, windowed }: { initial?: string; focus?: string; nonce?: number; section?: MbTab; windowed?: boolean }) {
  const t = useT();
  const trayHost = usePlatform((s) => s.tray);
  const os = usePlatform((s) => s.os);
  const managed = usePlatform((s) => s.managed);
  const { setDialog, accounts, prefs, calKinds, calSources } = useStore();
  // (which mailboxes get a Calendar section depends on what this build can connect)
  useEffect(() => void useStore.getState().loadCalKinds(), []);
  const start = initial === "accounts" ? "mb:all" : initial === "notifications" ? "tray" : initial;
  const [tab, setTab] = useState<string>(start || (accounts.length === 0 ? "add-account" : "general"));
  const [mbTab, setMbTab] = useState<MbTab>(section ?? (focus === "loadRemote" || focus === "maxDownload" ? "reading" : focus === "security" ? "security" : focus === "calendar" ? "calendar" : "composing"));
  const close = () => setDialog(null);
  /** "Open in new window": the Settings window opens on this tab and section, the dialog closes (REQ-4.6.8) */
  const popOut = async () => {
    if (await openPopout("settings", SETTINGS_KEY, { tab, section: mbTab })) setDialog(null);
  };
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
    if (section) (setMbTab(section), (focusSection.current = true));
  }, [initial, nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  // a deep link to a section of a mailbox (Manage rules…): the focus goes to the section once it is drawn
  const focusSection = useRef(!!section);
  useEffect(() => {
    if (!focusSection.current) return;
    const id = setTimeout(() => {
      focusSection.current = false;
      document.getElementById("set-sec")?.focus({ preventScroll: true });
    }, 150);
    return () => clearTimeout(id);
  }, [tab, mbTab, nonce]);
  // the deep link (`focus`): the same jump as a result of the search (src/settingsJump.ts), once per request
  const deepDone = useRef("");
  useEffect(() => {
    if (!focus) return;
    const timer = setTimeout(() => {
      const done = `${focus}|${nonce ?? ""}`;
      if (deepDone.current === done) return;
      // a field of the AI Assistant tab (an AI problem sends the person to the one it is about): the cursor goes in, nothing scrolls or moves
      if (focus.startsWith("ai")) {
        const el = document.getElementById(`set-${focus}`);
        if (el) (el.focus({ preventScroll: true }), (deepDone.current = done));
        return;
      }
      if (showSetting(focus)) deepDone.current = done;
    }, 80);
    return () => clearTimeout(timer);
  }, [focus, tab, mbTab, nonce]);

  // ---- search in Settings (W8.12): the index of this language, system and set of mailboxes; built once, not per key press
  const dav = (calKinds ?? []).includes("caldav");
  const calKey = calSources.filter((c) => c.kind === "caldav").map((c) => `${c.accountId}:${c.dav?.label || c.dav?.host || ""}`).join("|");
  const acctKey = accounts.map((a) => `${a.id}|${a.email}|${a.auth}|${a.imapHost}`).join("\n");
  // (the notification buttons of Linux depend on its notification service, which is asked once)
  const [linuxButtons, setLinuxButtons] = useState(false);
  useEffect(() => {
    if (os !== "linux") return;
    let live = true;
    api.notifyCaps().then((c) => live && setLinuxButtons(c.actions)).catch(() => undefined);
    return () => void (live = false);
  }, [os]);
  const notifyButtons = os === "windows" || (os === "linux" && linuxButtons);
  const index = useMemo(() => {
    const list: IndexAccount[] = accounts.map((a) => {
      const kind = calendarSyncKind(a);
      if (kind) return { id: a.id, email: a.email, cal: { kind } };
      if (!(dav && calendarDavEligible(a))) return { id: a.id, email: a.email, cal: null };
      const src = calSources.find((c) => c.accountId === a.id && c.kind === "caldav");
      return { id: a.id, email: a.email, cal: { kind: "dav" as const, label: src ? src.dav?.label || src.dav?.host || "" : null } };
    });
    return buildIndex({ os, tray: trayHost, managed: managed !== null, notifyButtons, accounts: list, kbd: (l) => kbd(l, os) });
  }, [langVersion(), os, trayHost, managed, notifyButtons, acctKey, dav, calKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const search = useSettingsSearch(index);
  const [pending, setPending] = useState<{ n: number; id: string; kind: EntryKind } | null>(null);
  const jumpN = useRef(0);
  /** A result was chosen: the page and the section are shown first, then (in the effect below, when they are drawn) the setting is lit up and gets the focus */
  const pick = (e: Entry) => {
    setTab(e.tab);
    if (e.section) setMbTab(e.section as MbTab);
    setPending({ n: ++jumpN.current, id: e.id, kind: e.kind });
  };
  useLayoutEffect(() => {
    if (!pending || showSetting(pending.id, pending.kind)) return;
    // a page that draws its rows late: look again on the next frames
    let frames = 0;
    let raf = 0;
    const again = () => {
      if (showSetting(pending.id, pending.kind) || ++frames > 60) return;
      raf = requestAnimationFrame(again);
    };
    raf = requestAnimationFrame(again);
    return () => cancelAnimationFrame(raf);
  }, [pending]);
  // Ctrl+F (Cmd+F on a Mac) from anywhere in Settings, and / outside a field, go to the box and select its text. Not while a question, the Command bar or a menu is on top, not for an input method.
  useEffect(() => {
    const mac = os === "macos";
    const onKey = (e: KeyboardEvent) => {
      if (isImeEvent(e) || e.altKey) return;
      const find = (e.key === "f" || e.key === "F") && !e.shiftKey && (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);
      const slash = e.key === "/" && !e.ctrlKey && !e.metaKey;
      if (!find && !slash) return;
      const target = e.target instanceof Element ? e.target : null;
      if (slash && target?.closest("input, textarea, select, [contenteditable]:not([contenteditable=\"false\"])")) return;
      if (target && target !== document.body && !target.closest(".modal, .modal-page")) return;
      const st = useStore.getState();
      if (st.ask || st.commandOpen || document.querySelector(".ctx-menu, [role=\"menu\"]") || document.querySelectorAll("[role=\"dialog\"]").length > 1) return;
      const box = search.boxRef.current;
      if (!box) return;
      e.preventDefault();
      e.stopPropagation();
      if (document.activeElement !== box && document.activeElement instanceof HTMLElement) search.before.current = document.activeElement;
      box.focus();
      box.select();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [os]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const item = (k: string, l: ReactNode, sub = false, movable = false, drag?: React.HTMLAttributes<HTMLElement>) => (
    <Fragment key={k}>
      <button data-reorder-focus={movable ? "" : undefined} {...drag} className={`${tab === k ? "active" : ""} ${sub ? "sub" : ""} ${tab === k && k.startsWith("mb:") ? "has-sub" : ""}`} aria-current={tab === k ? "page" : undefined} onClick={() => setTab(k)}>
        {l}
      </button>
      {tab === k && k.startsWith("mb:") && sections(k)}
    </Fragment>
  );

  return (
    <Modal
      title={t("settings.title")}
      onClose={close}
      wide
      windowed={windowed}
      headExtra={
        windowed ? undefined : (
          <button className="icon-btn" title={t("app.cmd.openInWindow")} aria-label={t("app.cmd.openInWindow")} onClick={() => void popOut()}>
            <ExternalLink size={14} />
          </button>
        )
      }
    >
      <div className="settings">
        <nav className="settings-nav" aria-label={t("settings.nav.sections")} ref={navRef}>
          <SearchBox s={search} onPick={pick} />
          {search.searching ? <SearchResults s={search} onPick={pick} /> : <>
          <div className="nav-label">{t("settings.nav.app")}</div>
          {item("general", t("settings.general.title"))}
          {item("appearance", t("settings.appearance.title"))}
          <div className="nav-label">{t("settings.nav.mailboxes")}</div>
          {item("mb:all", t("settings.scope.allAccounts"))}
          {accounts.map((a) => (
            // the mailboxes can be moved here too (grip, Alt+Up / Alt+Down, menu): AccountReorder.tsx
            <div key={a.id} className={`nav-acct ${reorder.dragging === a.id ? "reorder-src" : ""}`} data-reorder-id={a.id} {...reorder.entry(a.id)}>
              {accounts.length > 1 && <Grip email={a.email} bind={reorder.grip(a.id)} dragging={reorder.dragging === a.id} />}
              {item(`mb:${a.id}`, <><span className="dot" style={{ background: accountColor(a, prefs.accent) }} />{a.email}</>, true, true, reorder.row(a.id))}
            </div>
          ))}
          {item("add-account", t("settings.nav.addAccount"), true)}
          <div className="nav-label">{t("settings.nav.more")}</div>
          {MORE.map(([k, l]) => item(k, t(k === "tray" ? trayTabTitleKey(trayHost, os) : l)))}
          </>}
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
