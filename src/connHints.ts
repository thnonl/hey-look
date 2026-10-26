// "Test connection" of the manual account form (Settings > Add account > iCloud, Yahoo, other): everything that is decided without the page.
// The Rust side (src-tauri/src/conntest.rs) reports per server (incoming IMAP, outgoing SMTP) one `kind` out of 21; this file turns a kind into the
// words, the field to fix and the one-click fixes, says when the button is enabled, which hints show before a test, which result is stale after an
// edit, and when sign-ins are paused. Pure, no React: scripts/test-conn-hints.mjs runs it with node.
import { parseCoded } from "./backendErrors.ts";
import { t, type Key } from "./i18n/index.ts";

// ---------------------------------------------------------------- what the backend reports (src-tauri/src/conntest.rs)

export type PartName = "imap" | "smtp";
export type PartStatus = "ok" | "warn" | "error" | "cancelled";

export interface PartReport {
  status: PartStatus;
  /** "ok", or one of KINDS */
  kind: string;
  host: string;
  port: number;
  security: string;
  /** IMAP: folders the server lists */
  folders?: number;
  /** names in the server's certificate (an SSL/TLS port with a certificate failure) */
  certNames: string[];
  /** the protocol a wrong port answered like ("smtp" on the IMAP port, "imap" on the SMTP port) */
  sees?: string;
  /** the technical text (library error, server reply), scrubbed of the passwords */
  detail: string;
  ms: number;
}
export interface ConnTestReport {
  imap?: PartReport | null;
  smtp?: PartReport | null;
}

/** The 21 kinds of a failed part (src-tauri/src/conntest.rs `KINDS`). */
export const KINDS = [
  "dns", "refused", "unreachable", "timeout", "secure", "certUntrusted", "certName", "certExpired", "notImap", "notSmtp", "busy", "auth", "appPassword",
  "microsoftPassword", "smtpAuthOff", "imapOff", "webLogin", "tooMany", "noAuth", "listFailed", "unknown",
] as const;
export type Kind = (typeof KINDS)[number];

/** How long one part may take (conntest.rs PART_TIMEOUT), for the sentence "did not answer within {s} seconds". */
const PART_SECONDS = 20;

// ---------------------------------------------------------------- the form

/** What the test needs to know about the form (all of it is typed by the person, except `showAdv`: the provider presets hide the server fields). */
export interface ConnForm {
  provider: string;
  /** the server fields are visible (Other, Bridge) */
  showAdv: boolean;
  email: string;
  pw: string;
  username: string;
  imapHost: string;
  imapPort: number;
  imapSsl: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: "ssl" | "starttls";
  sepSmtp: boolean;
  smtpUser: string;
  smtpPw: string;
  insecure: boolean;
}

export type FieldId = "email" | "password" | "username" | "imapHost" | "imapPort" | "imapSecurity" | "smtpHost" | "smtpPort" | "smtpSecurity" | "smtpUsername" | "smtpPassword";

/** The label of each field, as the form shows it (the `{field}` of "Show field: {field}"). */
export const FIELD_LABEL: Record<FieldId, Key> = {
  email: "settings.add.email",
  password: "settings.add.password",
  username: "settings.add.username",
  imapHost: "settings.add.imapHost",
  imapPort: "settings.add.imapPort",
  imapSecurity: "settings.add.imapSecurity",
  smtpHost: "settings.add.smtpHost",
  smtpPort: "settings.add.smtpPort",
  smtpSecurity: "settings.add.smtpSecurity",
  smtpUsername: "settings.add.smtpUsername",
  smtpPassword: "settings.add.smtpPassword",
};

/** The value of a field, as the person sees it (to know that a field was edited). */
export function fieldValue(f: ConnForm, id: FieldId): string {
  switch (id) {
    case "email": return f.email;
    case "password": return f.pw;
    case "username": return f.username;
    case "imapHost": return f.imapHost;
    case "imapPort": return String(f.imapPort);
    case "imapSecurity": return f.imapSsl ? "ssl" : "starttls";
    case "smtpHost": return f.smtpHost;
    case "smtpPort": return String(f.smtpPort);
    case "smtpSecurity": return f.smtpSecurity;
    case "smtpUsername": return f.smtpUser;
    case "smtpPassword": return f.smtpPw;
  }
}

/** The fields that exist only when the server fields are shown. */
const ADV_FIELDS = new Set<FieldId>(["username", "imapHost", "imapPort", "imapSecurity", "smtpHost", "smtpPort", "smtpSecurity", "smtpUsername", "smtpPassword"]);
/** Whether the form shows this field now. */
function fieldShown(f: ConnForm, id: FieldId): boolean {
  if (id === "smtpUsername" || id === "smtpPassword") return f.showAdv && f.sepSmtp;
  return f.showAdv || !ADV_FIELDS.has(id);
}

// ---------------------------------------------------------------- enabling (REQ-2, REQ-17)

/** A host with a scheme, a path, an @, a space inside or a :port is not a server name. */
export function hostProblem(host: string): boolean {
  const h = host.trim();
  return /:\/\/|\/|@|\s/.test(h) || /^[^:]+:\d+$/.test(h);
}

const portOk = (n: number) => Number.isInteger(n) && n >= 1 && n <= 65535;

export type NeedKey = "need.email" | "need.password" | "need.imapHost" | "need.smtpHost" | "need.port" | "need.hostFormat";

/** Why "Test connection" is disabled: the first reason in field order, or null when it can run. */
export function needReason(f: ConnForm): NeedKey | null {
  const e = f.email.trim();
  const at = e.indexOf("@");
  if (at < 1 || at > e.length - 2) return "need.email";
  if (!f.pw) return "need.password";
  if (f.showAdv) {
    if (!f.imapHost.trim()) return "need.imapHost";
    if (!f.smtpHost.trim()) return "need.smtpHost";
    if (!portOk(f.imapPort) || !portOk(f.smtpPort)) return "need.port";
    if (hostProblem(f.imapHost) || hostProblem(f.smtpHost)) return "need.hostFormat";
  }
  return null;
}

/** The host fields with a format problem (they get aria-invalid and the red border). */
export function badHosts(f: ConnForm): FieldId[] {
  if (!f.showAdv) return [];
  const out: FieldId[] = [];
  if (f.imapHost.trim() && hostProblem(f.imapHost)) out.push("imapHost");
  if (f.smtpHost.trim() && hostProblem(f.smtpHost)) out.push("smtpHost");
  return out;
}

/** "Add account" keeps its own rules (email and password filled) plus the host format. */
export function addBlocked(f: ConnForm): boolean {
  return !f.email || !f.pw || (f.showAdv && (hostProblem(f.imapHost) || hostProblem(f.smtpHost)));
}

// ---------------------------------------------------------------- pre-test hints (REQ-18) and the fixes

export type Fix =
  | { id: "useSsl" | "useStarttls"; part: PartName; port: number }
  | { id: "swapHosts" }
  | { id: "trust" }
  | { id: "appPassword"; url: string }
  | { id: "google" }
  | { id: "microsoft" };

export interface Msg {
  key: Key;
  params?: Record<string, string | number>;
}
export interface PreHint {
  id: "imapPortSecurity" | "smtpPortSecurity" | "smtp25" | "swapped";
  part: PartName;
  msg: Msg;
  fixes: Fix[];
}

const SSL_PORT = { imap: 993, smtp: 465 } as const;
const STARTTLS_PORT = { imap: 143, smtp: 587 } as const;
const secure = (part: PartName, f: ConnForm): "ssl" | "starttls" => (part === "imap" ? (f.imapSsl ? "ssl" : "starttls") : f.smtpSecurity);
const portOf = (part: PartName, f: ConnForm) => (part === "imap" ? f.imapPort : f.smtpPort);

/** "Use SSL/TLS on port 993" and "Use STARTTLS on port 143" for a part, except the one already chosen. */
function portFixes(part: PartName, f: ConnForm): Fix[] {
  const now = secure(part, f);
  const port = portOf(part, f);
  const out: Fix[] = [];
  if (!(now === "ssl" && port === SSL_PORT[part])) out.push({ id: "useSsl", part, port: SSL_PORT[part] });
  if (!(now === "starttls" && port === STARTTLS_PORT[part])) out.push({ id: "useStarttls", part, port: STARTTLS_PORT[part] });
  return out;
}

/** The port is a well-known one for this part (so the fixes make sense). */
const wellKnown = (part: PartName, f: ConnForm): boolean => [SSL_PORT[part], STARTTLS_PORT[part]].some((p) => p === portOf(part, f));

/** A port normally used with the other security setting. */
function mismatch(part: PartName, f: ConnForm): "ssl" | "starttls" | null {
  const p = portOf(part, f);
  const now = secure(part, f);
  if (p === SSL_PORT[part] && now === "starttls") return "ssl";
  if (p === STARTTLS_PORT[part] && now === "ssl") return "starttls";
  return null;
}

/** The IMAP host looks like a mail-out host, or the SMTP host like an IMAP one. */
export function hostsLookSwapped(f: ConnForm): boolean {
  const i = f.imapHost.trim().toLowerCase();
  const s = f.smtpHost.trim().toLowerCase();
  return /^(smtp[a-z0-9-]*\.|mail-out|smtpout)/.test(i) || /^imap[a-z0-9-]*\./.test(s);
}

/** Hints that need no test, under the IMAP or SMTP row (only while the server fields are shown). */
export function preHints(f: ConnForm): PreHint[] {
  if (!f.showAdv) return [];
  const out: PreHint[] = [];
  for (const part of ["imap", "smtp"] as const) {
    const m = mismatch(part, f);
    if (m) {
      const port = portOf(part, f);
      out.push({
        id: part === "imap" ? "imapPortSecurity" : "smtpPortSecurity",
        part,
        msg: { key: part === "imap" ? "settings.test.pre.imapPortSecurity" : "settings.test.pre.smtpPortSecurity", params: { port, security: m === "ssl" ? "SSL/TLS" : "STARTTLS" } },
        fixes: portFixes(part, f),
      });
    }
  }
  if (f.smtpPort === 25) out.push({ id: "smtp25", part: "smtp", msg: { key: "settings.test.pre.smtp25" }, fixes: [] });
  if (hostsLookSwapped(f)) out.push({ id: "swapped", part: "imap", msg: { key: "settings.test.pre.swapped" }, fixes: [{ id: "swapHosts" }] });
  return out;
}

/** What a fix changes in the form (only the form: nothing is saved and no test runs). */
export function applyFix(f: ConnForm, fix: Fix): Partial<ConnForm> {
  switch (fix.id) {
    case "useSsl": return fix.part === "imap" ? { imapSsl: true, imapPort: fix.port } : { smtpSecurity: "ssl", smtpPort: fix.port };
    case "useStarttls": return fix.part === "imap" ? { imapSsl: false, imapPort: fix.port } : { smtpSecurity: "starttls", smtpPort: fix.port };
    case "swapHosts": return { imapHost: f.smtpHost, smtpHost: f.imapHost };
    case "trust": return { insecure: true };
    default: return {};
  }
}

// ---------------------------------------------------------------- the words of a result (REQ-14, REQ-19, REQ-20, REQ-22)

export type Provider = "gmail" | "icloud" | "yahoo" | "microsoft";

/** The provider a server name belongs to (the presets and the same names typed by hand). */
export function providerOf(host: string): Provider | null {
  const h = host.trim().toLowerCase();
  const under = (d: string) => h === d || h.endsWith(`.${d}`);
  if (under("gmail.com") || under("googlemail.com")) return "gmail";
  if (under("me.com") || under("icloud.com") || under("mac.com")) return "icloud";
  if (under("yahoo.com") || under("yahoodns.net") || under("ymail.com")) return "yahoo";
  if (under("office365.com") || under("outlook.com") || under("hotmail.com") || under("live.com") || under("office.com")) return "microsoft";
  return null;
}
const PROVIDER_NAME: Record<Provider, string> = { gmail: "Gmail", icloud: "iCloud", yahoo: "Yahoo", microsoft: "Microsoft" };
/** Where to make an app password (the Google one is the URL of the site's Help page too). */
const APP_PASSWORD_URL: Record<Exclude<Provider, "microsoft">, string> = {
  gmail: "https://myaccount.google.com/apppasswords",
  icloud: "https://account.apple.com",
  yahoo: "https://login.yahoo.com/account/security",
};

export interface Line {
  /** the sentence ("Sign-in failed.") */
  msg: Msg;
  /** what to do about it, one sentence each */
  hints: Msg[];
  /** the field to fix (null: none, or hidden) */
  field: FieldId | null;
  fixes: Fix[];
  /** the kind is `unknown`: the details open by themselves */
  openDetails: boolean;
}

const effectiveUser = (f: ConnForm) => (f.username.trim() || f.email.trim());

/** The field a failure is about, or null when it is not about one (or the form does not show it). */
export function fieldFor(part: PartName, kind: string, f: ConnForm): FieldId | null {
  const p = part === "imap";
  let id: FieldId | null = null;
  switch (kind) {
    case "dns": case "unreachable": case "timeout": case "certUntrusted": case "certName": id = p ? "imapHost" : "smtpHost"; break;
    case "refused": case "notImap": case "notSmtp": case "noAuth": id = p ? "imapPort" : "smtpPort"; break;
    case "secure": id = p ? "imapSecurity" : "smtpSecurity"; break;
    case "auth": case "appPassword":
      if (!p && f.sepSmtp) id = "smtpPassword";
      else if (!effectiveUser(f).includes("@") && f.showAdv) id = "username";
      else id = "password";
      break;
    default: id = null;
  }
  return id && fieldShown(f, id) ? id : null;
}

/** The message, the hints, the field and the fixes of one part's result. `f` is the form as it is now (presets hide the server fields). */
export function describe(part: PartName, r: PartReport, f: ConnForm): Line {
  const p = part === "imap";
  const hints: Msg[] = [];
  let msg: Msg = { key: "settings.test.err.unknown" };
  let fixes: Fix[] = [];
  const host = r.host;
  const prov = providerOf(host);
  const kind = r.kind;
  const trust = (): Fix[] => (f.showAdv && !f.insecure ? [{ id: "trust" }] : []);
  switch (kind) {
    case "dns":
      msg = { key: "settings.test.err.dns" };
      hints.push({ key: !f.showAdv ? "settings.test.hint.dns.preset" : p ? "settings.test.hint.dns.imap" : "settings.test.hint.dns.smtp" });
      break;
    case "refused":
      msg = { key: "settings.test.err.refused", params: { port: r.port } };
      hints.push({ key: "settings.test.hint.refused" });
      if (f.showAdv && mismatch(part, f)) fixes = portFixes(part, f);
      break;
    case "unreachable":
      msg = { key: "settings.test.err.unreachable" };
      hints.push({ key: "settings.test.hint.unreachable" });
      break;
    case "timeout":
      msg = { key: "settings.test.err.timeout", params: { s: PART_SECONDS } };
      hints.push({ key: p ? "settings.test.hint.timeout.imap" : "settings.test.hint.timeout.smtp" });
      break;
    case "secure":
      msg = { key: "settings.test.err.secure", params: { port: r.port } };
      hints.push({ key: "settings.test.hint.secure" });
      if (f.showAdv && wellKnown(part, f)) fixes = portFixes(part, f);
      break;
    case "certUntrusted":
      msg = { key: "settings.test.err.certUntrusted" };
      hints.push({ key: f.showAdv ? "settings.test.hint.certUntrusted.custom" : "settings.test.hint.certUntrusted.preset" });
      fixes = trust();
      break;
    case "certName":
      msg = { key: "settings.test.err.certName", params: { host } };
      hints.push({ key: "settings.test.hint.certName" });
      if (r.certNames.length) hints.push({ key: "settings.test.hint.certNameSeen", params: { names: r.certNames.join(", ") } });
      fixes = trust();
      break;
    case "certExpired":
      msg = { key: "settings.test.err.certExpired" };
      hints.push({ key: "settings.test.hint.certExpired" });
      fixes = trust();
      break;
    case "notImap":
      msg = { key: "settings.test.err.notImap" };
      hints.push({ key: r.sees === "smtp" ? "settings.test.hint.notImap.isSmtp" : "settings.test.hint.notImap.other" });
      if (r.sees === "smtp" && f.showAdv && hostsLookSwapped(f)) fixes = [{ id: "swapHosts" }];
      break;
    case "notSmtp":
      msg = { key: "settings.test.err.notSmtp" };
      hints.push({ key: r.sees === "imap" ? "settings.test.hint.notSmtp.isImap" : "settings.test.hint.notSmtp.other" });
      break;
    case "busy":
      msg = { key: "settings.test.err.busy" };
      hints.push({ key: "settings.test.hint.busy" });
      break;
    case "auth": {
      msg = { key: "settings.test.err.auth" };
      const sepSmtp = !p && f.sepSmtp;
      hints.push({ key: sepSmtp ? "settings.test.hint.auth.smtpSep" : "settings.test.hint.auth" });
      if (!sepSmtp && !effectiveUser(f).includes("@")) hints.push({ key: "settings.test.hint.auth.fullAddress" });
      const secret = sepSmtp ? f.smtpPw : f.pw;
      if (secret && secret !== secret.trim()) hints.push({ key: "settings.test.hint.auth.spaces" });
      if (prov === "gmail" || prov === "icloud" || prov === "yahoo") {
        hints.push({ key: "settings.test.hint.auth.provider", params: { provider: PROVIDER_NAME[prov] } });
        fixes = [{ id: "appPassword", url: APP_PASSWORD_URL[prov] }];
        if (prov === "gmail") fixes.push({ id: "google" });
      }
      break;
    }
    case "appPassword": {
      const named = prov && prov !== "microsoft" ? PROVIDER_NAME[prov] : host;
      msg = { key: "settings.test.err.appPassword", params: { provider: named } };
      hints.push({ key: "settings.test.hint.appPassword" });
      if (prov === "gmail" || prov === "icloud" || prov === "yahoo") {
        fixes = [{ id: "appPassword", url: APP_PASSWORD_URL[prov] }];
        if (prov === "gmail") fixes.push({ id: "google" });
      }
      break;
    }
    case "microsoftPassword":
      msg = { key: "settings.test.err.microsoftPassword" };
      hints.push({ key: "settings.test.hint.microsoftPassword" });
      fixes = [{ id: "microsoft" }];
      break;
    case "smtpAuthOff":
      msg = { key: "settings.test.err.smtpAuthOff" };
      hints.push({ key: "settings.test.hint.smtpAuthOff" });
      fixes = [{ id: "microsoft" }];
      break;
    case "imapOff":
      msg = { key: "settings.test.err.imapOff" };
      hints.push({ key: "settings.test.hint.imapOff" });
      break;
    case "webLogin":
      msg = { key: "settings.test.err.webLogin" };
      hints.push({ key: "settings.test.hint.webLogin" });
      break;
    case "tooMany":
      msg = { key: "settings.test.err.tooMany" };
      hints.push({ key: "settings.test.hint.tooMany" });
      break;
    case "noAuth":
      msg = { key: "settings.test.err.noAuth" };
      hints.push({ key: "settings.test.hint.noAuth" });
      if (f.showAdv) fixes = portFixes("smtp", f);
      break;
    case "listFailed":
      msg = { key: "settings.test.warn.listFailed" };
      break;
    default:
      msg = { key: "settings.test.err.unknown" };
      hints.push({ key: "settings.test.hint.unknown" });
  }
  return { msg, hints, field: fieldFor(part, kind, f), fixes, openDetails: !(KINDS as readonly string[]).includes(kind) || kind === "unknown" };
}

/** The label of a one-click fix. */
export function fixMsg(fix: Fix): Msg {
  switch (fix.id) {
    case "useSsl": return { key: "settings.test.fix.useSsl", params: { port: fix.port } };
    case "useStarttls": return { key: "settings.test.fix.useStarttls", params: { port: fix.port } };
    case "swapHosts": return { key: "settings.test.fix.swapHosts" };
    case "trust": return { key: "settings.test.fix.trust" };
    case "appPassword": return { key: "settings.test.fix.appPassword" };
    case "google": return { key: "settings.test.fix.google" };
    case "microsoft": return { key: "settings.test.fix.microsoft" };
  }
}

/** The text of a message in the language in use. */
export const say = (m: Msg): string => t(m.key, m.params);

/** The line of a part that worked. */
export function okMsg(part: PartName, r: PartReport): Msg {
  return part === "imap" && r.folders !== undefined ? { key: "settings.test.ok.imap", params: { n: r.folders } } : { key: "settings.test.ok.smtp" };
}

// ---------------------------------------------------------------- the block under the card (REQ-14 to REQ-16, REQ-24)

export interface PartView {
  state: "checking" | "done" | "notChecked" | "cancelled";
  report?: PartReport;
}
export interface Sigs {
  both: string;
  imap: string;
  smtp: string;
}
export interface Block {
  /** a test, or the failed "Add account" */
  source: "test" | "add";
  imap: PartView;
  smtp: PartView;
  /** the form as it was when the result was made */
  sigs: Sigs;
}

/** What each kind of edit changes: the settings of both servers, of one of them. */
export function sigsOf(f: ConnForm): Sigs {
  return {
    both: JSON.stringify([f.email.trim(), f.pw, f.username.trim(), f.provider, f.insecure, f.sepSmtp]),
    imap: JSON.stringify([f.imapHost.trim(), f.imapPort, f.imapSsl]),
    smtp: JSON.stringify([f.smtpHost.trim(), f.smtpPort, f.smtpSecurity, f.sepSmtp ? f.smtpUser.trim() : "", f.sepSmtp ? f.smtpPw : ""]),
  };
}

/** Which parts of a block are out of date against the form as it is now. */
export function staleParts(b: Block, now: Sigs): Record<PartName, boolean> {
  const both = b.sigs.both !== now.both;
  return { imap: both || b.sigs.imap !== now.imap, smtp: both || b.sigs.smtp !== now.smtp };
}

/** A settings change while a test runs ends it (no mix of old and new). */
export const changedWhileChecking = (b: Block, now: Sigs): boolean => b.source === "test" && (b.imap.state === "checking" || b.smtp.state === "checking") && (b.sigs.both !== now.both || b.sigs.imap !== now.imap || b.sigs.smtp !== now.smtp);

export type SummaryKey =
  | "settings.test.summary.checking" | "settings.test.summary.ok" | "settings.test.summary.warn" | "settings.test.summary.failed"
  | "settings.test.summary.offline" | "settings.test.summary.stale" | "settings.test.summary.addFailed" | "settings.test.cancelled";
export type Tone = "info" | "good" | "bad" | "warn";

const OFFLINE = new Set(["dns", "unreachable"]);

/** The summary line of a block and the colour of its notice. */
export function summaryOf(b: Block, stale: Record<PartName, boolean>): { key: SummaryKey; tone: Tone } {
  const views = [b.imap, b.smtp];
  if (views.some((v) => v.state === "checking")) return { key: "settings.test.summary.checking", tone: "info" };
  if (b.source === "add") return { key: "settings.test.summary.addFailed", tone: "bad" };
  if (views.every((v) => v.state === "cancelled")) return { key: "settings.test.cancelled", tone: "warn" };
  if (stale.imap || stale.smtp) return { key: "settings.test.summary.stale", tone: "warn" };
  const reports = views.map((v) => v.report);
  if (reports.every((r) => r && r.status === "error" && OFFLINE.has(r.kind))) return { key: "settings.test.summary.offline", tone: "bad" };
  if (reports.some((r) => r?.status === "error")) return { key: "settings.test.summary.failed", tone: "bad" };
  if (reports.some((r) => r?.status === "warn" || r?.status === "cancelled")) return { key: "settings.test.summary.warn", tone: "warn" };
  return { key: "settings.test.summary.ok", tone: "good" };
}

/** The shared SMTP login was refused, the incoming server is fine: Add account still adds the account (unchanged), and the line says so. */
export function smtpSharedNote(b: Block, f: ConnForm): boolean {
  const s = b.smtp.report;
  const i = b.imap.report;
  return b.source === "test" && !f.sepSmtp && !!s && s.status === "error" && s.kind !== "secure" && !!i && (i.status === "ok" || i.status === "warn");
}

// ---------------------------------------------------------------- a failed "Add account" (REQ-10, REQ-24)

/** The coded error of a refused part of Add account (`ACCOUNT_CHECK|part=imap|kind=auth|host=…: English`), or null for any other error. */
export function parseAccountCheck(raw: unknown): { part: PartName; report: PartReport } | null {
  const c = parseCoded(String(raw instanceof Error ? raw.message : raw).replace(/^Error:\s*/, "").trim());
  if (!c || c.code !== "ACCOUNT_CHECK") return null;
  const part = c.params.part === "smtp" ? "smtp" : c.params.part === "imap" ? "imap" : null;
  if (!part) return null;
  return {
    part,
    report: {
      status: "error",
      kind: c.params.kind || "unknown",
      host: c.params.host ?? "",
      port: Number(c.params.port) || 0,
      security: c.params.sec ?? "",
      certNames: c.params.names ? c.params.names.split(",").filter(Boolean) : [],
      sees: c.params.sees || undefined,
      detail: c.params.detail ?? "",
      ms: 0,
    },
  };
}

/** A form that knows nothing but the failed part (for the toast and friendlyError, where there is no form at hand). */
const NEUTRAL: ConnForm = {
  provider: "custom", showAdv: true, email: "", pw: "", username: "", imapHost: "", imapPort: 0, imapSsl: true, smtpHost: "", smtpPort: 0, smtpSecurity: "ssl",
  sepSmtp: false, smtpUser: "", smtpPw: "", insecure: false,
};

/** One sentence for a toast or a plain error: "Outgoing (SMTP): Sign-in failed. Check the username and password." (null when the error is not an ACCOUNT_CHECK). */
export function accountCheckText(raw: unknown): string | null {
  const p = parseAccountCheck(raw);
  if (!p) return null;
  const line = describe(p.part, p.report, NEUTRAL);
  const name = t(p.part === "imap" ? "settings.server.incoming" : "settings.server.outgoing");
  return `${name}: ${[line.msg, ...line.hints].map(say).join(" ")}`;
}

// ---------------------------------------------------------------- Details and Copy (REQ-21)

/** The technical text under "Details", the same that Copy puts on the clipboard. */
export function detailsText(b: Block, product: string): string {
  const out: string[] = [];
  for (const part of ["imap", "smtp"] as const) {
    const r = (part === "imap" ? b.imap : b.smtp).report;
    if (!r || !r.host) continue;
    const name = t(part === "imap" ? "settings.server.incoming" : "settings.server.outgoing");
    out.push(`${name}: ${r.host}:${r.port} ${r.security === "ssl" ? "SSL/TLS" : r.security === "starttls" ? "STARTTLS" : r.security}`);
    out.push(`  ${r.status === "ok" ? "ok" : r.kind}${r.folders !== undefined ? ` (${r.folders})` : ""}${r.certNames.length ? ` [${r.certNames.join(", ")}]` : ""}${r.ms ? ` ${r.ms} ms` : ""}`);
    if (r.detail) out.push(...r.detail.split("\n").map((l) => `  ${l}`));
  }
  out.push(product);
  return out.join("\n");
}

// ---------------------------------------------------------------- the pause after failed sign-ins (D5)

/** The kinds that count as a failed sign-in. */
const SIGNIN_KINDS: ReadonlySet<string> = new Set(["auth", "appPassword", "microsoftPassword", "tooMany"]);
export const COOLDOWN_AFTER = 3;
const COOLDOWN_SECONDS = 60;

export interface Streak {
  key: string;
  count: number;
}
export const NO_STREAK: Streak = { key: "", count: 0 };

/** The server + user a streak belongs to. */
export const streakKey = (f: ConnForm): string => `${f.imapHost.trim().toLowerCase()}|${effectiveUser(f).toLowerCase()}`;

/** After a result: the new streak and whether sign-ins pause now. Three failed sign-ins in a row pause; `tooMany` from the server pauses at once; a sign-in that worked resets. */
export function nextStreak(prev: Streak, key: string, reports: readonly (PartReport | null | undefined)[]): { streak: Streak; pause: boolean } {
  const base = prev.key === key ? prev.count : 0;
  const rs = reports.filter((r): r is PartReport => !!r);
  if (rs.some((r) => r.kind === "tooMany")) return { streak: { key, count: 0 }, pause: true };
  if (rs.some((r) => r.status === "error" && SIGNIN_KINDS.has(r.kind))) {
    const count = base + 1;
    return count >= COOLDOWN_AFTER ? { streak: { key, count: 0 }, pause: true } : { streak: { key, count }, pause: false };
  }
  if (rs.some((r) => r.status === "ok" || r.status === "warn")) return { streak: { key, count: 0 }, pause: false };
  return { streak: { key, count: base }, pause: false };
}

/** The pause in seconds. A variable only so the dev preview can make it short for the UI test (src/devMock.ts, `conncooldown=` in the page address); the app never changes it. */
export const cooldown = { seconds: COOLDOWN_SECONDS };
