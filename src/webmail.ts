// "Search in <webmail>": which accounts have a webmail we know, and the search to carry there (see parse_query in src-tauri/src/lib.rs
// for the app's operators). Only Gmail has a documented search link; for the others the query is copied and the webmail home is opened.
// Pure on purpose (no store, no Tauri): the dev preview checks it with `__webmailCheck()` (devMock.ts), the repo has no test runner.
import type { Account, SearchScope } from "./api";

export type WebmailId = "gmail" | "outlook" | "m365" | "yahoo" | "icloud" | "fastmail" | "zoho";

export interface Webmail {
  id: WebmailId;
  /** shown on the button and in the toast */
  name: string;
  /** where the webmail lives (the sign-in page when the browser has no session) */
  home: string;
}

/** The providers with a webmail we can name. A custom domain on an unknown server is not in the table: no button, we do not know its URL. */
const WEBMAIL: Record<WebmailId, Webmail> = {
  gmail: { id: "gmail", name: "Gmail", home: "https://mail.google.com/mail/" },
  outlook: { id: "outlook", name: "Outlook", home: "https://outlook.live.com/mail/" },
  m365: { id: "m365", name: "Microsoft 365", home: "https://outlook.office.com/mail/" },
  yahoo: { id: "yahoo", name: "Yahoo", home: "https://mail.yahoo.com/" },
  icloud: { id: "icloud", name: "iCloud", home: "https://www.icloud.com/mail" },
  fastmail: { id: "fastmail", name: "Fastmail", home: "https://app.fastmail.com/mail/" },
  zoho: { id: "zoho", name: "Zoho", home: "https://mail.zoho.com/" },
};

/** Personal Microsoft addresses live on outlook.live.com; every other address that signs in with Microsoft is Exchange Online. */
const MS_PERSONAL = /^(hotmail|outlook|live|msn)\./;

/**
 * The webmail of an account: its IMAP server first (that is where the mailbox really is), then the sign-in provider, then the
 * address domain. null = unknown (custom server and domain).
 */
export function webmailOf(a: Pick<Account, "imapHost" | "auth" | "email">): Webmail | null {
  const host = a.imapHost.trim().toLowerCase();
  const domain = a.email.slice(a.email.lastIndexOf("@") + 1).trim().toLowerCase();
  if (host === "imap.gmail.com" || a.auth === "oauth_google") return WEBMAIL.gmail;
  // Outlook.com / Hotmail accounts use outlook.office365.com for OAuth too, so the address decides there
  if (a.auth === "oauth_microsoft" || host === "outlook.office365.com") return MS_PERSONAL.test(domain) ? WEBMAIL.outlook : WEBMAIL.m365;
  if (host === "imap-mail.outlook.com") return WEBMAIL.outlook;
  if (host === "imap.mail.yahoo.com") return WEBMAIL.yahoo;
  if (host === "imap.mail.me.com") return WEBMAIL.icloud;
  if (host === "imap.fastmail.com") return WEBMAIL.fastmail;
  if (/^imap\.zoho\.[a-z.]+$/.test(host)) return WEBMAIL.zoho;
  if (domain === "gmail.com" || domain === "googlemail.com") return WEBMAIL.gmail;
  if (MS_PERSONAL.test(domain)) return WEBMAIL.outlook;
  if (/^yahoo\./.test(domain) || domain === "ymail.com" || domain === "rocketmail.com") return WEBMAIL.yahoo;
  if (domain === "icloud.com" || domain === "me.com" || domain === "mac.com") return WEBMAIL.icloud;
  if (/^fastmail\./.test(domain)) return WEBMAIL.fastmail;
  if (/^zoho(mail)?\./.test(domain)) return WEBMAIL.zoho;
  return null;
}

export interface WebmailTarget {
  account: Account;
  webmail: Webmail;
}

/** The accounts a search covers that have a known webmail: the selected mailbox, or every mailbox when none is selected or the scope is "all". */
export function webmailTargets(accounts: Account[], accountId: string | null, scope: SearchScope): WebmailTarget[] {
  const inScope = accountId && scope !== "all" ? accounts.filter((a) => a.id === accountId) : accounts;
  return inScope.flatMap((account) => {
    const webmail = webmailOf(account);
    return webmail ? [{ account, webmail }] : [];
  });
}

/** Same split as the backend's split_tokens: whitespace separates words, double quotes group them (and are dropped). */
function tokens(q: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of q) {
    if (ch === '"') quoted = !quoted;
    else if (/\s/.test(ch) && !quoted) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** A value with spaces becomes a phrase; Gmail would otherwise take only its first word as the operator's value. */
const val = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
/** Plain text: if it contains a colon Gmail would read it as an operator, so it is searched as a phrase. */
const word = (s: string) => (/[\s:]/.test(s) ? `"${s}"` : s);

/** The app's folder name (folder:X / in:X, or the open folder) as a Gmail term; "" when Gmail has no such place. */
function folderTerm(name: string): string {
  const k = name.trim().replace(/^f:/i, "");
  switch (k.toLowerCase()) {
    case "inbox": case "unread": return "in:inbox";
    case "sent": return "in:sent";
    case "drafts": return "in:drafts";
    case "trash": case "deleted": case "bin": return "in:trash";
    case "junk": case "spam": return "in:spam";
    // The app's Archive of a Gmail mailbox IS "All Mail" (`[Gmail]/All Mail`: Inbox mail included, Spam and Trash left out), and that is exactly what a plain Gmail search covers: no
    // folder term. `in:anywhere` would also search Spam and Trash, which the app's own Archive search does not (W8.9). The same for the "all" view.
    case "archive": case "all": return "";
    case "": return "";
    default: return `label:${k.replace(/\s+/g, "-")}`;
  }
}

/** A real calendar day written YYYY-MM-DD (the backend ignores anything else). */
function isoDay(v: string): RegExpExecArray | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? m : null;
}

/** `7d` = that many days ago, `2026-01-31` = that day (the only two forms the app accepts); anything else is ignored like the app does. */
function when(v: string, after: boolean): string {
  const rel = /^(\d+)d$/i.exec(v);
  if (rel) return `${after ? "newer_than" : "older_than"}:${rel[1]}d`;
  const day = isoDay(v);
  return day ? `${after ? "after" : "before"}:${day[1]}/${day[2]}/${day[3]}` : "";
}

/**
 * `from:` `to:` `subject:` `is:unread|read|starred` `has:attachment` `after:` `before:` carry over (flagged = starred, dates and
 * `Nd` are rewritten), `folder:`/`in:` become `in:` or `label:`, `body:x` is just the words, `is:pinned` has no Gmail equivalent
 * and is dropped. `openFolder` is added when the search is limited to the open folder and the query names none.
 */
export function toGmailQuery(query: string, openFolder?: string): string {
  const out: string[] = [];
  let hasFolder = false;
  for (const tok of tokens(query)) {
    const i = tok.indexOf(":");
    const key = i > 0 ? tok.slice(0, i).toLowerCase() : "";
    const v = i > 0 ? tok.slice(i + 1) : "";
    if (!key || !v) {
      out.push(word(tok));
      continue;
    }
    const lv = v.toLowerCase();
    let term: string;
    switch (key) {
      case "from": term = `from:${val(v)}`; break;
      case "to": term = `to:${val(v)}`; break;
      case "cc": term = `cc:${val(v)}`; break;
      case "subject": term = `subject:${val(v)}`; break;
      case "body": term = word(v); break;
      case "has": case "hasattachment": case "hasattachments":
        term = lv.startsWith("att") || lv === "yes" || lv === "true" ? "has:attachment" : word(tok);
        break;
      case "is":
        term = lv === "unread" ? "is:unread" : lv === "read" ? "is:read" : lv === "flagged" || lv === "starred" ? "is:starred" : lv === "pinned" ? "" : word(tok);
        break;
      case "after": case "since": term = when(lv, true); break;
      case "before": case "until": term = when(lv, false); break;
      case "folder": case "in":
        hasFolder = true;
        term = folderTerm(v);
        break;
      default: term = word(tok);
    }
    if (term) out.push(term);
  }
  if (!hasFolder && openFolder) {
    // the virtual "all" view is no folder to stay in
    const f = openFolder === "starred" ? "is:starred" : openFolder === "all" ? "" : folderTerm(openFolder);
    if (f && out.length) out.push(f);
  }
  return out.join(" ");
}

/**
 * Opens the search in that account's Gmail (authuser picks the signed-in Google account in the browser).
 * Privacy (W8.9, decided after round-22 O1): nothing else may be added to this address. `authuser=<address>` is the only reliable way to open the right Google account when the browser is
 * signed in to several (an index would open the wrong mailbox), and google.com already knows the address; the search text sits in the fragment (`#…`), which the browser does not send in
 * the request line, and Gmail's own search puts the same text in the same place, so the history gets nothing that searching in Gmail directly would not give it.
 */
export const gmailSearchUrl = (email: string, gmailQuery: string): string =>
  `https://mail.google.com/mail/?authuser=${encodeURIComponent(email)}#search/${encodeURIComponent(gmailQuery)}`;

/** What each webmail (other than Gmail) is known to understand; nothing is invented, so this stays small. */
interface Dialect {
  /** from: / to: / subject: are kept as operators (cc: becomes to: unless `cc`) */
  fields: boolean;
  cc?: boolean;
  /** the operator for "has an attachment" ("" = not known) */
  attach: string;
  /** after: / before: with a YYYY-MM-DD date */
  dates: boolean;
}
const DIALECT: Record<Exclude<WebmailId, "gmail">, Dialect> = {
  fastmail: { fields: true, attach: "has:attachment", dates: true },
  yahoo: { fields: true, attach: "has:attachment", dates: true },
  outlook: { fields: true, cc: true, attach: "hasattachment:yes", dates: false },
  m365: { fields: true, cc: true, attach: "hasattachment:yes", dates: false },
  // no documented operators: the words are searched wherever the webmail looks, so sender and subject text stay as plain words
  icloud: { fields: false, attach: "", dates: false },
  zoho: { fields: false, attach: "", dates: false },
};

/**
 * The search to paste into a webmail other than Gmail. The words stay; `from:` `to:` `subject:` (and, where known, `has:attachment`
 * and ISO `after:`/`before:`) are kept as typed; app-only terms (`is:`, `folder:`/`in:`, relative dates like `7d`) are dropped; `body:x`
 * is just the words. Where the webmail has no known operators (iCloud, Zoho) the values of from/to/subject become plain words.
 */
export function toWebmailQuery(id: WebmailId, query: string): string {
  if (id === "gmail") return toGmailQuery(query);
  const d = DIALECT[id];
  const out: string[] = [];
  for (const tok of tokens(query)) {
    const i = tok.indexOf(":");
    const key = i > 0 ? tok.slice(0, i).toLowerCase() : "";
    const v = i > 0 ? tok.slice(i + 1) : "";
    if (!key || !v) {
      out.push(word(tok));
      continue;
    }
    const lv = v.toLowerCase();
    let term = "";
    switch (key) {
      case "from": case "to": case "subject": term = d.fields ? `${key}:${val(v)}` : val(v); break;
      case "cc": term = d.fields ? `${d.cc ? "cc" : "to"}:${val(v)}` : val(v); break;
      case "body": term = word(v); break;
      case "has": case "hasattachment": case "hasattachments":
        if (lv.startsWith("att") || lv === "yes" || lv === "true") term = d.attach;
        else term = word(tok);
        break;
      case "after": case "since": case "before": case "until":
        term = d.dates && isoDay(lv) ? `${key === "after" || key === "since" ? "after" : "before"}:${lv}` : "";
        break;
      case "is": case "folder": case "in": break; // app-only
      default: term = word(tok);
    }
    if (term) out.push(term);
  }
  return out.join(" ");
}

/** The search text for an account's webmail ("" = nothing left to search for, no button). */
export const webmailQuery = (w: Webmail, query: string, openFolder?: string): string => (w.id === "gmail" ? toGmailQuery(query, openFolder) : toWebmailQuery(w.id, query));
