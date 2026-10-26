// Dev preview only (never in a release build: main.tsx imports devMock.ts only under import.meta.env.DEV, and devMock.ts calls this).
// The Store listing screenshots (scripts/store-screenshots.mjs): a script sets `window.__hlShots` before the page loads and the mock mailbox is replaced by
// the sample mail of the listing md (E:\hey-mail\reports\v1-0-1\store-listing-109\<lang>.md, "Sample mail for screenshots"): two mailboxes, the 8 mails,
// standard folders, no scheduled / failed mail, an empty rule list, a few calendar events in the language of the listing, one key for the sender of mail 1,
// and a fixed canned answer for the AI summary (the stub never calls an AI service). Nothing here is reachable without `__hlShots`.

export type ShotsMail = { n: number; fromName: string; fromEmail: string; subject: string; preview: string; minutesAgo: number; unread: boolean; attach?: string[]; body?: string };
export type ShotsEvent = { title: string; day: number; h: number; m: number; endH: number; endM: number; invite?: boolean };
export type ShotsData = {
  me: { name: string; name2: string; email: string; email2: string };
  mails: ShotsMail[];
  events: ShotsEvent[];
  /** The canned answer of the AI stub (a summary or a translation alike). */
  answer: string;
};

type Obj = Record<string, unknown>;
/** The module state of devMock.ts that the replacement needs (references, so the mock's own commands see the new data). */
export type ShotsHost = {
  accounts: Obj[];
  threads: Obj[];
  threadMsgs: Record<string, unknown[]>;
  folders: Obj[];
  outbox: unknown[];
  rules: unknown[];
  settings: Record<string, string>;
  secrets: Map<string, string>;
  pgpKeys: Obj[];
  mkKey: (uid: string, over?: Obj) => Obj;
  row: (id: string, subject: string, who: string[], snippet: string, ago: number, extra?: Obj) => Obj;
  msg: (id: string, subject: string, fromName: string, fromEmail: string, over: Obj, html: string | null, atts?: unknown[]) => Obj;
  setEvents: (list: Obj[]) => void;
  ev: (id: string, summary: string, start: number, end: number, over?: Obj) => Obj;
  now: number;
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A small lake at sunset (an inline SVG picture for the mail "Photos from the lake"; drawn here, nothing is downloaded). */
const LAKE = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='640' height='360'><defs><linearGradient id='s' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#2b3a67'/><stop offset='.55' stop-color='#e07a5f'/><stop offset='1' stop-color='#f2cc8f'/></linearGradient><linearGradient id='w' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#f2cc8f'/><stop offset='1' stop-color='#3d5a80'/></linearGradient></defs><rect width='640' height='200' fill='url(#s)'/><circle cx='430' cy='170' r='34' fill='#fff3c4'/><rect y='200' width='640' height='160' fill='url(#w)'/><path d='M0 200 L90 150 L170 195 L260 140 L360 200 Z' fill='#1d2a44'/><rect x='400' y='205' width='60' height='6' rx='3' fill='#fff3c4' opacity='.7'/><rect x='410' y='222' width='40' height='5' rx='2' fill='#fff3c4' opacity='.5'/></svg>`,
)}`;

export function applyShots(d: ShotsData, h: ShotsHost): void {
  // the two mailboxes
  h.accounts.length = 2;
  Object.assign(h.accounts[0], { email: d.me.email, displayName: d.me.name, username: d.me.email });
  // (a password mailbox on an ordinary server: a Google one would offer to turn on Google Calendar in the calendar sidebar)
  Object.assign(h.accounts[1], { email: d.me.email2, displayName: d.me.name2, username: d.me.email2, auth: "password", imapHost: "imap.example.org", smtpHost: "smtp.example.org" });
  // standard folders only, nothing in Drafts / Scheduled / the other folders, the Inbox number is the unread mail
  const unread = d.mails.filter((m) => m.unread).length;
  h.folders.length = 0;
  for (const a of h.accounts) for (const k of ["inbox", "drafts", "sent", "archive", "junk", "trash"]) h.folders.push({ accountId: a.id, key: k, name: k, unread: k === "inbox" && a.id === "a1" ? unread : 0, total: k === "inbox" && a.id === "a1" ? d.mails.length : 0 });
  h.outbox.length = 0;
  h.rules.length = 0;
  // the mail
  h.threads.length = 0;
  for (const k of Object.keys(h.threadMsgs)) delete h.threadMsgs[k];
  for (const m of d.mails) {
    const id = `shot${m.n}`;
    const atts = (m.attach ?? []).map((name, index) => ({ index, name, mime: name.endsWith(".pdf") ? "application/pdf" : "image/jpeg", size: name.endsWith(".pdf") ? 96000 : 1480000, inline: false, cid: null, referenced: false }));
    h.threads.push(h.row(id, m.subject, [m.fromName], m.preview, (m.minutesAgo * 60) / 1, { accountId: "a1", unread: m.unread ? 1 : 0, hasAttach: atts.length > 0 }));
    const html = `<p>${esc(m.preview)}</p>${m.n === 3 ? `<p><img src="${LAKE}" alt="" width="480"></p>` : ""}<p>${esc(m.fromName)}</p>`;
    h.threadMsgs[id] = [h.msg(`msg${m.n}`, m.subject, m.fromName, m.fromEmail, { date: h.now - m.minutesAgo * 60, seen: !m.unread, to: d.me.email }, html, atts)];
  }
  // the AI Assistant is set up, and answers with the fixed text (ai_complete in devMock.ts reads `answer`)
  h.settings.ai_endpoint = "mock";
  h.settings.ai_model = "mock";
  h.secrets.set("ai_key", "mock");
  (window as unknown as { __hlShotsAnswer?: string }).__hlShotsAnswer = d.answer;
  // one key for the sender of mail 1, so Encrypt works for a reply or a new message to her
  const first = d.mails[0];
  h.pgpKeys.splice(1, h.pgpKeys.length - 1, h.mkKey(`${first.fromName} <${first.fromEmail}>`, { verified: true, source: "email" }));
  h.pgpKeys[0].userIds = [`${d.me.name} <${d.me.email}>`];
  // the week of the calendar: Monday = day 0 of the week that holds "today"
  const t0 = new Date(h.now * 1000);
  const mon = new Date(t0.getFullYear(), t0.getMonth(), t0.getDate() - ((t0.getDay() + 6) % 7), 0, 0, 0, 0);
  const sec = (day: number, hh: number, mm: number) => Math.floor(new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + day, hh, mm, 0, 0).getTime() / 1000);
  h.setEvents(d.events.map((e, i) => h.ev(`shotev${i + 1}`, e.title, sec(e.day, e.h, e.m), sec(e.day, e.endH, e.endM), e.invite ? { calendarId: "invites:a1", accountId: "a1", myStatus: "accepted" } : {})));
}
