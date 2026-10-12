// Dev-only: lets the UI run in a plain browser (npm run dev) with fake data, no Tauri backend.
import { mockIPC } from "@tauri-apps/api/mocks";
import { darkMessages, darkThreadRows } from "./devMockDark";
import { extractSignature, fillSignatureHtml, normalizeHtml, SIG_MARK } from "./signature";
import { ACCOUNT_PALETTE, accountColor, pickAccountColor } from "./prefs";
import { setSimulatedWindow } from "./winframe";

const now = Math.floor(Date.now() / 1000);
const H = 3600;

const accounts = [
  { id: "a1", email: "nam@example.com", displayName: "Nam", imapHost: "imap.example.com", imapPort: 993, imapSsl: true, smtpHost: "smtp.example.com", smtpPort: 465, smtpSecurity: "ssl", username: "nam@example.com", smtpUsername: "", tlsInsecure: false, auth: "password", color: "#0f6cbd" },
  { id: "a2", email: "nam@gmail.com", displayName: "Nam", imapHost: "imap.gmail.com", imapPort: 993, imapSsl: true, smtpHost: "smtp.gmail.com", smtpPort: 465, smtpSecurity: "ssl", username: "nam@gmail.com", smtpUsername: "", tlsInsecure: false, auth: "oauth_google", color: "#c5221f" },
];

const t = (id: string, subject: string, who: string[], snippet: string, ago: number, extra: Record<string, unknown> = {}) => ({
  threadId: id, rowKey: id, accountId: "a1", folder: "inbox", subject, participants: who, snippet, lastDate: now - ago,
  count: 1, unread: 0, flagged: false, pinned: false, snoozedUntil: null, hasAttach: false, bulk: false, ...extra,
});

const threads = [
  t("t1", "Q4 roadmap review", ["Linh Tran"], "Hi Nam, attaching the latest roadmap deck. Could you review the milestones before Thursday?", 0.5 * H, { unread: 2, count: 3, hasAttach: true, pinned: true }),
  t("t2", "Invoice #4821 is ready", ["Billing"], "Your invoice for October is now available to download.", 2 * H, { unread: 1, flagged: true }),
  t("t3", "Lunch tomorrow?", ["Minh Pham", "You"], "Pho at 12:30 works for me. Let me know if you want to go earlier.", 5 * H, { count: 4 }),
  t("t4", "Your weekly digest", ["Product Hunt"], "Top launches this week: AI mail clients, note apps and more.", 26 * H, { bulk: true, unread: 1 }),
  t("t5", "Re: Contract changes", ["Legal Team"], "Thanks, we've updated clause 4.2 as discussed. Please confirm.", 30 * H, { count: 2 }),
  t("nl1", "Lotusmiles 10.2026 Account Statement", ["Lotusmiles"], "Your October statement: miles earned, activity and offers. View it in your browser if it does not display.", 6 * H, { unread: 1, hasAttach: false }),
  t("nl2", "Monthly digest (620px layout)", ["Digest"], "A typical 620px wide newsletter layout, several screens tall.", 7 * H),
  ...darkThreadRows.map(([id, subject, snippet, ago]) => t(id, subject, ["Dark fixtures"], snippet, ago * H)),
  t("t6", "Welcome to Hey Look!", ["Hey Look!"], "Everything is unlocked: no plans, no limits.", 80 * H),
  t("t7", "Photos from the offsite", ["Linh Tran"], "Here are the photos and the agenda. Thanks!", 4 * H, { hasAttach: true }),
  t("t8", "Q4 contract — confidential", ["Linh Tran"], "Encrypted message", 3 * H, { unread: 1, encrypted: true, signed: true, hasAttach: true }),
  t("t9", "Salary review (encrypted)", ["Linh Tran"], "Encrypted message", 2.5 * H, { encrypted: true }),
  t("t10", "Archive access", ["Minh Pham"], "Encrypted message", 6 * H, { encrypted: true }),
  t("t11", "Re: Contract changes (damaged)", ["Legal Team"], "Encrypted message", 7 * H, { encrypted: true }),
  t("t12", "Re: build pipeline", ["Bao Tran"], "The release is tagged, please check the artifacts.", 5 * H, { signed: true }),
  t("t13", "Hello from a new contact", ["Eve Park"], "Nice to meet you! My public key is attached.", 8 * H, { signed: true, hasAttach: true }),
  t("t14", "Weekly sync notes", ["Bao Tran"], "Notes from today are below. Signed inline.", 9 * H, { signed: true }),
];

// calendar invitations in every state (the messages are built further down)
threads.push(
  t("t15", "Invitation: Product sync", ["Mai Khanh"], "Wed 14 Oct 10:00–11:00 · Room 4B", 1.2 * H, { unread: 1, invite: "request" }),
  t("t16", "Canceled: Vendor demo", ["Vendor Ops"], "This event has been cancelled", 1.6 * H, { invite: "cancel" }),
  t("t17", "Updated invitation: Kick-off", ["Mai Khanh"], "Thu 15 Oct 14:00–15:00", 1.8 * H, { unread: 1, invite: "request", count: 2 }),
  t("t18", "Accepted: 1:1 with Bao", ["Bao Tran"], "Bao Tran accepted your invitation", 2.2 * H, { invite: "reply" }),
  t("t19", "Company holiday", ["HR"], "Published event", 9 * H, { invite: "request" }),
  t("t20", "Invitation (damaged calendar data)", ["Eve Park"], "Calendar data could not be read", 9.5 * H),
  t("t21", "Invitation: Team offsite", ["Mai Khanh"], "14 – 16 Oct · All day", 10 * H, { invite: "request" }),
  t("t22", "Invitation: Q4 planning (forwarded)", ["Duc Pham"], "Fri 16 Oct 09:00–10:00", 11 * H, { invite: "request" }),
  t("t23", "Invitation: Kick-off (last month)", ["Mai Khanh"], "Wed 30 Sep 09:00–10:00", 12 * H, { invite: "request" }),
  t("t25", "Invitation: Salary review meeting (encrypted)", ["Linh Tran"], "Encrypted message", 14 * H, { encrypted: true }),
  t("t24", "Invitation: Server check (sending fails once)", ["Linh Tran"], "Sat 17 Oct 11:00–12:00", 13 * H, { invite: "request" }),
  t("t26", "Invitation: Company all-hands (huge guest list)", ["Mai Khanh"], "Mon 19 Oct 15:00–16:00", 15 * H, { invite: "request" }),
);

const body = (n: string) =>
  `<p>Hi Nam,</p><p>${n}</p><p>Best regards,<br>Linh</p><blockquote>Earlier message quoted here.</blockquote>`;

const fpr = (seed: string) => {
  // the whole seed goes into the hash (two keys whose names start alike must not share a fingerprint)
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  let out = "";
  for (let i = 0; out.length < 40; i++) {
    h = Math.imul(h ^ (i + 1), 16777619) >>> 0;
    h = (h ^ (h >>> 15)) >>> 0;
    out += h.toString(16).toUpperCase().padStart(8, "0");
  }
  return out.slice(0, 40);
};
type MockKey = {
  fingerprint: string; keyId: string; userIds: string[]; algo: string; created: number; expires: number | null; expired: boolean; revoked: boolean;
  hasSecret: boolean; verified: boolean; source: string; passphraseRemembered: boolean; unlocked: boolean; defaultFor: string[]; protected: boolean;
};
const mkKey = (uid: string, over: Partial<MockKey> = {}, salt = ""): MockKey => {
  const f = fpr(uid + salt);
  return { fingerprint: f, keyId: f.slice(-16), userIds: [uid], algo: "Ed25519 / Curve25519", created: now - 40 * 86400, expires: now + 700 * 86400, expired: false, revoked: false, hasSecret: false, verified: false, source: "paste", passphraseRemembered: false, unlocked: false, defaultFor: [], protected: true, ...over };
};
// keys: your own (a1 has one, a2 has none, so Encrypt is unavailable there) and other people's
let pgpKeys: MockKey[] = [
  mkKey("Nam <nam@example.com>", { hasSecret: true, verified: true, source: "generated", defaultFor: ["a1"] }),
  mkKey("Nam <nam@personal.vn>", { hasSecret: true, verified: true, source: "generated", algo: "RSA 3072", expired: true, expires: now - 90 * 86400 }),
  mkKey("Linh Tran <linh@example.com>", { verified: true, source: "email" }),
  mkKey("Bao Tran <bao@contoso.com>", { source: "file" }),
  mkKey("old-ops@northwind.io", { revoked: true }),
];
const keyFor = (addr: string) => pgpKeys.find((k) => !k.hasSecret && k.userIds.some((u) => u.toLowerCase().includes(`<${addr}>`) || u.toLowerCase() === addr));
let pgpAttempts = 0;
let keySeq = 0; // a newly generated key never shares a fingerprint with an existing one
const OWN_FPR = pgpKeys[0].fingerprint;
let ownLocked = true; // starts locked; the passphrase of the mock key is "secret123"

const sigOk = { status: "valid", signer: "Linh Tran", fingerprint: pgpKeys[2].fingerprint, keyId: pgpKeys[2].keyId, signedAt: now - 3 * H, verified: true, matchesFrom: true, inline: false };
const secMsg = (id: string, subject: string, fromName: string, fromEmail: string, over: Record<string, unknown>, html: string | null, atts: unknown[] = []) => ({
  id, accountId: "a1", folder: "inbox", messageId: `<${id}@x>`, subject, fromName, fromEmail, to: "nam@example.com", cc: "", date: now - 2 * H,
  html, text: html ? html.replace(/<[^>]+>/g, " ") : null, seen: true, flagged: false, attachments: atts, canUnsubscribe: false, ...over,
});
const lockedMsg = () => secMsg("m-locked", "Salary review (encrypted)", "Linh Tran", "linh@example.com", { security: { encrypted: true, partial: false, decryption: "locked", lockedKey: OWN_FPR, lockedLabel: "nam@example.com", encryptedFor: [OWN_FPR.slice(-16)], signature: null } }, null);
const openedMsg = () => secMsg("m-locked", "Salary review (encrypted)", "Linh Tran", "linh@example.com", { security: { encrypted: true, partial: false, decryption: "ok", encryptedFor: [OWN_FPR.slice(-16)], signature: sigOk } }, "<p>Hi Nam,</p><p>The new salary bands are attached to the plan. Please keep this between us.</p>");
const mockThreadMsgs: Record<string, unknown[]> = {
  t8: [secMsg("m-enc", "Q4 contract — confidential", "Linh Tran", "linh@example.com", { security: { encrypted: true, partial: false, decryption: "ok", encryptedFor: [OWN_FPR.slice(-16), "3B1D77F00C2E9A11"], signature: sigOk } }, "<p>Hi Nam,</p><p>Here are the final redlines. Clauses 7 and 12 changed; everything else is as agreed.</p><p>— Linh</p>", [
    { index: 0, name: "Q4-contract-v7.pdf", mime: "application/pdf", size: 1200000 },
    { index: 1, name: "linh-public.asc", mime: "application/pgp-keys", size: 3100 },
  ])],
  t9: [lockedMsg()],
  t10: [secMsg("m-nokey", "Archive access", "Minh Pham", "minh@example.com", { security: { encrypted: true, partial: false, decryption: "no_key", encryptedFor: ["91AC4E0B5D7F2A31"], signature: null } }, null)],
  t11: [secMsg("m-bad", "Re: Contract changes (damaged)", "Legal Team", "legal@example.com", { security: { encrypted: true, partial: false, decryption: "error", error: "unsupported packet or corrupted transfer", encryptedFor: [], signature: null } }, null)],
  t12: [secMsg("m-inv", "Re: build pipeline", "Bao Tran", "bao@contoso.com", { security: { encrypted: false, partial: false, decryption: "none", encryptedFor: [], signature: { status: "invalid", signer: "Bao Tran", fingerprint: pgpKeys[3].fingerprint, keyId: pgpKeys[3].keyId, signedAt: now - 5 * H, verified: false, matchesFrom: true, inline: false } } }, "<p>The release is tagged. Please check the artifacts at <a href='https://example.com/release'>the release page</a>.</p>")],
  t13: [secMsg("m-unk", "Hello from a new contact", "Eve Park", "eve@example.org", { security: { encrypted: false, partial: false, decryption: "none", encryptedFor: [], signature: { status: "unknown_key", signer: null, fingerprint: null, keyId: "E21C0A9F33B07D12", signedAt: now - H, verified: false, matchesFrom: false, inline: false } } }, "<p>Nice to meet you! My public key is attached.</p>", [{ index: 0, name: "eve-public.asc", mime: "application/pgp-keys", size: 2900 }])],
  t14: [secMsg("m-ok2", "Weekly sync notes", "Bao Tran", "bao@contoso.com", { security: { encrypted: false, partial: false, decryption: "none", encryptedFor: [], signature: { status: "valid", signer: "Bao Tran", fingerprint: pgpKeys[3].fingerprint, keyId: pgpKeys[3].keyId, signedAt: now - 8 * H, verified: false, matchesFrom: true, inline: true } } }, "<p>Notes from today are below. Signed inline.</p>")],
};

const messages = [
  { id: "m1", accountId: "a1", folder: "inbox", messageId: "<1@x>", subject: "Q4 roadmap review", fromName: "Linh Tran", fromEmail: "linh@example.com", to: "nam@example.com", cc: "", date: now - 3 * H, html: body("Attaching the latest roadmap deck."), text: "Attaching the latest roadmap deck.", seen: true, flagged: false, attachments: [{ index: 0, name: "roadmap-q4.pdf", mime: "application/pdf", size: 482113 }], canUnsubscribe: false },
  { id: "m2", accountId: "a1", folder: "inbox", messageId: "<2@x>", subject: "Re: Q4 roadmap review", fromName: "Nam", fromEmail: "nam@example.com", to: "linh@example.com", cc: "", date: now - 2 * H, html: body("Thanks, looking now."), text: "Thanks, looking now.", seen: true, flagged: false, attachments: [], canUnsubscribe: false },
  { id: "m3", accountId: "a1", folder: "inbox", messageId: "<3@x>", subject: "Re: Q4 roadmap review", fromName: "Linh Tran", fromEmail: "linh@example.com", to: "nam@example.com", cc: "", date: now - 0.5 * H, html: body("Could you review the milestones before Thursday? Also see the newsletter link <a href='https://example.com'>here</a>.<br><img id='remote1' src='https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png' width='200'>"), text: "Could you review the milestones before Thursday?", seen: false, flagged: false, attachments: [], canUnsubscribe: true },
];

// a 1x1 PNG, used for mock pictures
const PIC = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

// pictures in the body: one small (embedded by the backend, shown here as cid: and loaded on demand), one large
// (not embedded), one picture that nothing refers to, and a real PDF
const m4 = {
  id: "m4", accountId: "a1", folder: "inbox", messageId: "<4@x>", subject: "Photos from the offsite", fromName: "Linh Tran", fromEmail: "linh@example.com",
  to: "nam@example.com", cc: "", date: now - 4 * H, seen: true, flagged: false, canUnsubscribe: false,
  html: `<p>Here are the photos and the agenda.</p><p><img src="cid:logo@x" alt="Office logo" width="240"></p><p><img src="cid:big@x" alt="Whiteboard"></p><p>Thanks!</p>`,
  text: "Here are the photos and the agenda.",
  attachments: [
    { index: 0, name: "logo.png", mime: "image/png", size: 1024, inline: true, cid: "logo@x", referenced: true },
    { index: 1, name: "whiteboard.jpg", mime: "image/jpeg", size: 3400000, inline: true, cid: "big@x", referenced: true },
    { index: 2, name: "agenda.pdf", mime: "application/pdf", size: 482113, inline: false, cid: null, referenced: false },
    { index: 3, name: "photo-orphan.png", mime: "image/png", size: 2048, inline: true, cid: "orphan@x", referenced: false },
  ],
};

const folders = ["inbox", "drafts", "sent", "archive", "junk", "trash"].flatMap((k, i) =>
  accounts.map((a) => ({ accountId: a.id, key: k, name: k, unread: k === "inbox" ? (a.id === "a1" ? 4 : 2) : 0, total: 10 + i })),
).concat([{ accountId: "a1", key: "f:Projects/Hey Look", name: "Projects/Hey Look", unread: 0, total: 5 }, { accountId: "a1", key: "f:Clients/International customers/Very long folder name for layout testing", name: "Clients/International customers/Very long folder name for layout testing", unread: 0, total: 3 }]);

// A long, real-looking newsletter (several screens tall, 800px wide table, big images, web font, 100vh / height:100% / overflow in the mail's own CSS)
// so the body-frame sizing can be tried in the browser: the frame must show all of it with no scrollbar of its own.
const svg = (w: number, h: number, c: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'><rect width='100%' height='100%' fill='${c}'/><text x='20' y='${h / 2}' font-size='28' fill='white'>${w}x${h}</text></svg>`)}`;
const section = (n: number) =>
  `<tr><td style="padding:24px 32px;font-family:'Lotus Sans',Georgia,serif"><h2 style="margin:0 0 8px">Section ${n}: your miles activity</h2>` +
  `<p style="margin:0 0 12px">Posted ${n} Oct. Flight to Hanoi, partner purchase and bonus promotions are summarised below. This paragraph is intentionally long so it wraps over several lines in a narrow reading pane and makes the whole mail several screens tall.</p>` +
  `<img src="${svg(736, 220, ["#0a6", "#c60", "#46c", "#a3a", "#388"][n % 5])}" style="display:block;width:100%"><p style="font-size:12px;color:#888">Terms apply. Miles expire after 36 months.</p></td></tr>`;
const longMail = (w: number) =>
  `<style>@font-face{font-family:'Lotus Sans';src:local('Arial')}html,body{height:100%;overflow:auto;background:#eee}.wrap{min-height:100vh;background:#fff}</style>` +
  `<div class="wrap"><table width="${w}" cellpadding="0" cellspacing="0" style="width:${w}px;min-width:${w}px;margin:0 auto;background:#fff">` +
  `<tr><td style="padding:0"><img src="${svg(w, 260, "#0a3d62")}" width="${w}" height="260" style="display:block"></td></tr>` +
  Array.from({ length: 9 }, (_, i) => section(i + 1)).join("") +
  `<tr><td style="padding:24px 32px;font-size:12px;color:#666">You are receiving this because you are a Lotusmiles member. <img src="https://example.com/open-pixel.gif" width="1" height="1"> Unsubscribe or manage preferences in your account.</td></tr></table></div>`;

const darkThreads = darkMessages(messages[0], svg);

const settings: Record<string, string> = {};

// scheduled messages in every state the worker can be in
const mockOutbox = (() => {
  const base = { accountId: "a1", cc: [] as string[], snippet: "Shared the agenda for Thursday and the budget draft.", hasAttachments: false, createdAt: now - H, attempts: 0 };
  return [
    { ...base, id: "s1", subject: "Agenda for Thursday", to: ["linh@example.com"], sendAt: now + 3 * H, status: "pending", error: null },
    { ...base, id: "s2", subject: "Budget draft v3", to: ["minh@example.com", "anna@example.com"], cc: ["finance@example.com"], sendAt: now + 26 * H, status: "pending", error: null, hasAttachments: true },
    { ...base, id: "s3", subject: "Happy birthday!", to: ["team@example.com"], sendAt: now - 2 * H, status: "overdue", error: null },
    { ...base, id: "s4", subject: "Contract redlines", to: ["legal@example.com"], sendAt: now - 40 * 60, status: "failed", error: "SMTP send failed: connection timed out", attempts: 3 },
    { ...base, id: "s5", subject: "Lunch on Monday?", to: ["minh@example.com"], sendAt: now + 2 * 24 * H, status: "held", error: null },
    { ...base, id: "s6", subject: "Release notes", to: ["dev@example.com"], sendAt: now + 5 * 60, status: "sending", error: null },
  ];
})();
const mockDraftOf = (o: (typeof mockOutbox)[number]) => ({
  accountId: o.accountId, to: o.to, cc: o.cc, bcc: [] as string[], subject: o.subject, html: `<p>${o.snippet}</p>`, text: o.snippet,
  references: [] as string[], attachments: [], inline: [],
});

// ---- calendar mock: events relative to today, invitations whose answers change in memory
const dayStart = (offset: number) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return Math.floor(d.getTime() / 1000);
};
const at = (offset: number, h: number, m = 0) => dayStart(offset) + h * 3600 + m * 60;
const utcDay = (offset: number) => {
  const d = new Date();
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate() + offset) / 1000;
};
const sysTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
type MockEvent = Record<string, unknown> & { id: string; start: number; end: number; calendarId: string; rrule: string | null; allDay: boolean };
const ev = (id: string, summary: string, start: number, end: number, over: Record<string, unknown> = {}): MockEvent => ({
  id, uid: `${id}@mock`, calendarId: "local", accountId: null, summary, start, end, allDay: false, tzid: sysTz, location: null, joinUrl: null, description: null,
  organizer: null, attendees: [], rrule: null, recurrenceText: null, status: "confirmed", myStatus: null, respondedAt: null, reminderMin: 15, sourceMessageId: null, sequence: 0, ...over,
});
const you = { email: "nam@example.com", name: "Nam Hoang", role: "required", status: "needs-action", isYou: true };
const people = (list: [string, string][]) => list.map(([name, status]) => ({ email: `${name.split(" ")[0].toLowerCase()}@contoso.com`, name, role: "required", status, isYou: false }));
let calEvents: MockEvent[] = [
  ev("e1", "Standup", at(0, 9, 30), at(0, 10), { calendarId: "invites:a1", accountId: "a1", myStatus: "accepted", rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", recurrenceText: "Every Monday, Tuesday, Wednesday, Thursday and Friday", location: "https://teams.microsoft.com/l/meetup-join/xyz", joinUrl: "https://teams.microsoft.com/l/meetup-join/xyz" }),
  ev("e2", "Design review", at(1, 10, 30), at(1, 11, 30), { calendarId: "invites:a1", accountId: "a1", myStatus: "tentative", location: "Room 2", organizer: { email: "mai@contoso.com", name: "Mai Khanh" }, attendees: people([["Mai Khanh", "accepted"], ["Bao Tran", "accepted"]]).concat([you as never]), sourceMessageId: "m-inv-req" }),
  ev("e3", "Q4 contract call", at(0, 15), at(0, 16), { myStatus: "organizer", accountId: "a1", organizer: { email: "nam@example.com", name: "Nam Hoang" }, attendees: [{ ...you, role: "chair", status: "accepted" }, ...people([["Alice Lin", "accepted"], ["Bao Tran", "needs-action"]])] }),
  ev("e4", "Lunch with Alice", at(1, 12), at(1, 13, 30), { location: "Pho 24" }),
  ev("e5", "Product sync", at(2, 10), at(2, 11), { calendarId: "invites:a1", accountId: "a1", myStatus: "needs-action", location: "Room 4B", rrule: "FREQ=WEEKLY;BYDAY=WE", recurrenceText: "Every Wednesday", joinUrl: "https://teams.microsoft.com/l/meetup-join/abc", organizer: { email: "mai@contoso.com", name: "Mai Khanh" }, attendees: people([["Mai Khanh", "accepted"], ["Bao Tran", "accepted"], ["Alice Lin", "accepted"], ["Duc Pham", "declined"], ["Linh Vo", "tentative"]]).concat([you as never]), sourceMessageId: "m-inv-req" }),
  ev("e6", "Retro", at(2, 10, 30), at(2, 11), { myStatus: "accepted", calendarId: "invites:a1", accountId: "a1" }),
  ev("e7", "Vendor demo", at(3, 11), at(3, 12), { calendarId: "invites:a2", accountId: "a2", status: "cancelled", myStatus: "needs-action", sourceMessageId: "m-inv-cancel" }),
  ev("e8", "Release 1.4", utcDay(4), utcDay(5), { allDay: true, tzid: null }),
  ev("e9", "Team offsite", utcDay(6), utcDay(9), { allDay: true, tzid: null, calendarId: "invites:a1", accountId: "a1", myStatus: "needs-action", sourceMessageId: "m-inv-allday" }),
  ev("e10", "Focus time", at(5, 14), at(5, 17), {}),
  ev("e11", "Board prep", at(7, 13), at(7, 14)),
  ev("e12", "Hiring panel", at(7, 16), at(7, 17), { calendarId: "invites:a2", accountId: "a2", myStatus: "accepted" }),
  ev("e13", "Gym", at(7, 18), at(7, 19)),
  ev("e14", "Dentist", at(7, 8), at(7, 9)),
  ev("e15", "Flight SGN → HAN", at(8, 7, 15), at(8, 9, 30), { location: "Tan Son Nhat", description: "Gate to be announced." }),
  ev("e16", "Kick-off", at(-12, 9), at(-12, 10), { calendarId: "invites:a1", accountId: "a1", myStatus: "accepted" }),
  ev("e17", "Yesterday's 1:1", at(-1, 14), at(-1, 14, 30), {}),
];
const hiddenCals = new Set<string>();
const dayOf = (sec: number) => Math.floor(sec / 86400);
/** Repeats for the mock: daily / weekly with BYDAY, from the event's own start. */
function expandMock(e: MockEvent, from: number, to: number): MockEvent[] {
  if (!e.rrule) return e.end > from && e.start < to ? [e] : [];
  const days = (/BYDAY=([A-Z,]+)/.exec(e.rrule)?.[1] ?? "").split(",").filter(Boolean);
  const map = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  const out: MockEvent[] = [];
  const startDay = new Date(e.start * 1000);
  for (let d = Math.floor(from / 86400) - 1; d <= Math.floor(to / 86400) + 1; d++) {
    const base = new Date(d * 86400 * 1000);
    const dow = base.getDay();
    const hit = e.rrule.includes("FREQ=DAILY") || (days.length ? days.includes(map[dow]) : dow === startDay.getDay());
    if (!hit) continue;
    const s = new Date(base);
    s.setHours(startDay.getHours(), startDay.getMinutes(), 0, 0);
    const st = Math.floor(s.getTime() / 1000);
    if (st < e.start || st >= to || st + (e.end - e.start) <= from) continue;
    out.push({ ...e, start: st, end: st + (e.end - e.start), instanceStart: st });
  }
  return out;
}
void dayOf;

const mkInvite = (over: Record<string, unknown>) => ({
  method: "REQUEST", uid: "inv@mock", sequence: 0, summary: "Product sync", start: at(2, 10), end: at(2, 11), allDay: false, tzid: "Europe/Berlin",
  location: "Room 4B", joinUrl: "https://teams.microsoft.com/l/meetup-join/abc", description: null, organizer: { email: "mai@contoso.com", name: "Mai Khanh" },
  attendees: people([["Mai Khanh", "accepted"], ["Bao Tran", "accepted"], ["Alice Lin", "accepted"], ["Duc Pham", "declined"], ["Linh Vo", "tentative"]]).map((a, i) => (i === 0 ? { ...a, role: "chair" } : a)).concat([you as never]),
  rrule: "FREQ=WEEKLY;BYDAY=WE", recurrenceText: "Every Wednesday", you: { email: "nam@example.com", status: "needs-action", onList: true }, responded: null, changed: null, reply: null,
  eventId: "e5", ended: false, cancelled: false, outdated: false, trimmed: false, conflicts: [{ eventId: "e6", summary: "Retro", start: at(2, 10, 30), end: at(2, 11) }], parseError: null, ...over,
});
const inviteMsg = (id: string, subject: string, fromName: string, fromEmail: string, invite: Record<string, unknown> | null, ago = 2 * H, extra: Record<string, unknown> = {}) => ({
  id, accountId: "a1", folder: "inbox", messageId: `<${id}@x>`, subject, fromName, fromEmail, to: "nam@example.com", cc: "", date: now - ago, seen: false, flagged: false,
  html: `<p>Weekly product sync. Agenda is in the shared doc.</p>`, text: "Weekly product sync. Agenda is in the shared doc.", attachments: [{ index: 0, name: "invite.ics", mime: "application/ics", size: 1850 }],
  canUnsubscribe: false, invite, ...extra,
});
const inviteMsgs: Record<string, ReturnType<typeof inviteMsg>> = {
  "m-inv-req": inviteMsg("m-inv-req", "Invitation: Product sync", "Mai Khanh", "mai@contoso.com", mkInvite({}), 1.2 * H),
  "m-inv-cancel": inviteMsg("m-inv-cancel", "Canceled: Vendor demo", "Vendor Ops", "ops@vendor.com", mkInvite({ method: "CANCEL", summary: "Vendor demo", cancelled: true, start: at(3, 11), end: at(3, 12), rrule: null, recurrenceText: null, eventId: "e7", location: null, joinUrl: null, tzid: sysTz, conflicts: [], organizer: { email: "ops@vendor.com", name: "Vendor Ops" }, attendees: [], you: { email: "nam@example.com", status: "needs-action", onList: true } }), 1.6 * H, { html: null, text: null }),
  "m-inv-upd0": inviteMsg("m-inv-upd0", "Invitation: Kick-off", "Mai Khanh", "mai@contoso.com", mkInvite({ summary: "Kick-off", start: at(3, 14), end: at(3, 15), rrule: null, recurrenceText: null, eventId: "e20", outdated: true, conflicts: [], joinUrl: null, tzid: sysTz }), 20 * H),
  "m-inv-upd1": inviteMsg("m-inv-upd1", "Updated invitation: Kick-off", "Mai Khanh", "mai@contoso.com", mkInvite({ summary: "Kick-off", sequence: 1, start: at(4, 14), end: at(4, 15), rrule: null, recurrenceText: null, eventId: "e20", conflicts: [], joinUrl: null, tzid: sysTz, changed: { fields: ["time"], previous: { start: at(3, 14), end: at(3, 15), location: "Room 4B" } } }), 1.8 * H),
  "m-reply": inviteMsg("m-reply", "Accepted: 1:1 with Bao", "Bao Tran", "bao@contoso.com", mkInvite({ method: "REPLY", summary: "1:1 with Bao", start: at(-1, 14), end: at(-1, 14, 30), rrule: null, recurrenceText: null, eventId: "e3", reply: { from: { email: "bao@contoso.com", name: "Bao Tran" }, status: "accepted", comment: "See you there — I’ll bring the numbers." }, attendees: [{ ...you, role: "chair", status: "accepted" }, ...people([["Bao Tran", "accepted"], ["Alice Lin", "tentative"], ["Duc Pham", "needs-action"]])], you: null, conflicts: [], joinUrl: null, location: null }), 2.2 * H, { html: null, text: null, attachments: [] }),
  "m-publish": inviteMsg("m-publish", "Company holiday", "HR", "hr@example.com", mkInvite({ method: "PUBLISH", summary: "Company holiday", allDay: true, start: utcDay(20), end: utcDay(21), tzid: null, location: null, joinUrl: null, rrule: null, recurrenceText: null, eventId: null, attendees: [], you: null, conflicts: [], organizer: { email: "hr@example.com", name: "HR" } }), 9 * H),
  "m-broken": inviteMsg("m-broken", "Invitation (damaged calendar data)", "Eve Park", "eve@example.org", mkInvite({ method: "OTHER", parseError: "no event", attendees: [], conflicts: [], eventId: null }), 9.5 * H),
  "m-inv-allday": inviteMsg("m-inv-allday", "Invitation: Team offsite", "Mai Khanh", "mai@contoso.com", mkInvite({ summary: "Team offsite", allDay: true, start: utcDay(6), end: utcDay(9), tzid: null, location: "Da Lat", joinUrl: null, rrule: null, recurrenceText: null, eventId: "e9", conflicts: [] }), 10 * H),
  "m-inv-fwd": inviteMsg("m-inv-fwd", "Invitation: Q4 planning (forwarded)", "Duc Pham", "duc@contoso.com", mkInvite({ summary: "Q4 planning", start: at(5, 9), end: at(5, 10), rrule: null, recurrenceText: null, eventId: null, you: { email: "nam@example.com", status: "needs-action", onList: false }, attendees: people([["Mai Khanh", "accepted"], ["Duc Pham", "accepted"]]), conflicts: [], joinUrl: null, organizer: { email: "mai@contoso.com", name: "Mai Khanh" } }), 11 * H),
  "m-inv-old": inviteMsg("m-inv-old", "Invitation: Kick-off (last month)", "Mai Khanh", "mai@contoso.com", mkInvite({ summary: "Kick-off", start: at(-12, 9), end: at(-12, 10), rrule: null, recurrenceText: null, eventId: "e16", ended: true, conflicts: [], joinUrl: null, tzid: sysTz, you: { email: "nam@example.com", status: "accepted", onList: true }, responded: { status: "accepted", sentAt: at(-14, 9) } }), 12 * H),
  "m-inv-big": inviteMsg("m-inv-big", "Invitation: Company all-hands (huge guest list)", "Mai Khanh", "mai@contoso.com", mkInvite({ summary: "Company all-hands", start: at(7, 15), end: at(7, 16), rrule: null, recurrenceText: null, eventId: null, conflicts: [], joinUrl: null, tzid: sysTz, trimmed: true, attendees: people([["Mai Khanh", "accepted"], ["Duc Pham", "accepted"]]).concat([you as never]), organizer: { email: "mai@contoso.com", name: "Mai Khanh" } }), 15 * H),
  "m-inv-flaky": inviteMsg("m-inv-flaky", "Invitation: Server check (sending fails once)", "Linh Tran", "linh@example.com", mkInvite({ summary: "Server check", start: at(6, 11), end: at(6, 12), rrule: null, recurrenceText: null, eventId: "e21", conflicts: [], joinUrl: null, tzid: sysTz, attendees: people([["Linh Tran", "accepted"]]).concat([you as never]), organizer: { email: "linh@example.com", name: "Linh Tran" } }), 13 * H),
};
const threadInvite: Record<string, string[]> = {
  t15: ["m-inv-req"], t16: ["m-inv-cancel"], t17: ["m-inv-upd0", "m-inv-upd1"], t18: ["m-reply"], t19: ["m-publish"], t20: ["m-broken"],
  t21: ["m-inv-allday"], t22: ["m-inv-fwd"], t23: ["m-inv-old"], t24: ["m-inv-flaky"], t26: ["m-inv-big"],
};
// an encrypted invitation: locked until the key is unlocked, then it shows the same card
const encInvite = (locked: boolean) => ({
  ...inviteMsg("m-enc-inv", "Invitation: Salary review meeting (encrypted)", "Linh Tran", "linh@example.com", locked ? null : mkInvite({ summary: "Salary review meeting", start: at(3, 16), end: at(3, 17), rrule: null, recurrenceText: null, eventId: "e22", conflicts: [], joinUrl: null, location: "HR room", tzid: sysTz, organizer: { email: "linh@example.com", name: "Linh Tran" } }), 14 * H, locked ? { html: null, text: null, attachments: [] } : {}),
  security: locked
    ? { encrypted: true, partial: false, decryption: "locked", lockedKey: pgpKeys[0].fingerprint, lockedLabel: "nam@example.com", encryptedFor: [pgpKeys[0].fingerprint.slice(-16)], signature: null }
    : { encrypted: true, partial: false, decryption: "ok", encryptedFor: [pgpKeys[0].fingerprint.slice(-16)], signature: null },
});
let flakyFailed = false;
let eventSeq = 100;

/** The editor of the open Compose as plain facts: the typed text, how many signature regions, which signature, the Encrypt / Sign toggles. */
function composeFacts() {
  const ed = document.querySelector<HTMLElement>(".editor .tiptap");
  const regions = ed ? [...ed.querySelectorAll<HTMLElement>(".sig-block")] : [];
  return {
    open: !!ed,
    text: ed ? [...ed.children].filter((x) => !x.classList.contains("sig-block")).map((x) => x.textContent ?? "").join("|") : "",
    regions: regions.length,
    sigText: regions.map((r) => r.querySelector(".sig-body")?.textContent ?? "").join("|"),
    signatureTextInBody: (ed?.textContent ?? "").split("-- ").length - 1,
    // the toolbar buttons are named "Encrypt…" / "Sign…" and carry aria-pressed
    pressed: [...document.querySelectorAll<HTMLElement>(".cp-bar [aria-pressed]")].map((b) => `${b.getAttribute("aria-label") ?? b.title}=${b.getAttribute("aria-pressed")}`).join(";"),
    order: ed ? [...ed.children].map((x) => (x.classList.contains("sig-block") ? "SIG" : x.localName)).join(",") : "",
  };
}

async function failedSendCheck(wait: (ms: number) => Promise<unknown>) {
  const { useStore } = await import("./store");
  const st = () => useStore.getState();
  const out: string[] = [];
  const ok = (c: boolean, m: string) => out.push((c ? "ok   " : "FAIL ") + m);
  st().setPrefs({ undoSeconds: 0 });
  await st().openCompose({ accountId: "a1", to: ["alice@fabrikam.com"], subject: "Report [fail]" });
  await wait(900);
  const ed = () => document.querySelector<HTMLElement>(".editor .tiptap");
  ed()?.focus();
  document.execCommand("insertText", false, "Hello body line one");
  await wait(300);
  // flip Encrypt (and Sign) so a reset to the default after a failure would show
  [...document.querySelectorAll<HTMLElement>(".cp-bar [aria-pressed]")].find((b) => (b.title || b.getAttribute("aria-label") || "").startsWith("Encrypt"))?.click();
  await wait(300);
  const before = composeFacts();
  ok(before.regions === 1 && before.sigText.includes("Hey Look!"), "new message: one signature region with the default signature");
  for (let i = 1; i <= 3; i++) {
    const key = st().composeKey;
    [...document.querySelectorAll<HTMLButtonElement>(".cp-bar button")].find((b) => b.title.startsWith("Send ("))?.click();
    await wait(400);
    // Encrypt is on and the recipient has no key: Send asks; the person sends it unencrypted anyway
    if (st().ask) st().resolveAsk("plain");
    await wait(1200);
    ok(st().composeKey >= key + 2, `send ${i}: Compose really closed and was opened again (key ${key} -> ${st().composeKey})`);
    const f = composeFacts();
    ok(f.open, `send ${i}: Compose is back after the failure`);
    ok(f.regions === 1, `reopen ${i}: one signature region (${f.regions})`);
    ok(f.signatureTextInBody === 0, `reopen ${i}: no signature text in the body`);
    ok(f.text === before.text, `reopen ${i}: body unchanged (${JSON.stringify(f.text)})`);
    ok(f.sigText === before.sigText, `reopen ${i}: same signature (${JSON.stringify(f.sigText)})`);
    ok(f.order === before.order, `reopen ${i}: same block order (${f.order})`);
    ok(f.pressed === before.pressed, `reopen ${i}: toggles as they were (${f.pressed})`);
  }
  await st().openCompose(null);
  return out;
}

/**
 * Dev preview only. `#dark&cal=week&date=2026-10-14&thread=t15&event=new&chip=Standup&compose=meeting` drives the mock app
 * into a state once it has loaded, so a screenshot of that state can be taken from a plain URL.
 */
export async function applyDemoHash() {
  const { useStore } = await import("./store");
  const { parseDate } = await import("./calendar");
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 100 && !useStore.getState().loaded; i++) await wait(50);
  await wait(300);
  const st = () => useStore.getState();
  // dev self-check of the dark mail rendering: `await __darkCheck()` in the console (see devDarkCheck.ts); `#darkcheck` runs it and prints the report on the page
  const runCheck = async (ids?: string[]) => {
    const { darkCheck } = await import("./devDarkCheck");
    return darkCheck((id) => st().select(id), ids ?? ["dk1", "dk2", "dk3", "dk4", "dk5", "dk7", "dk8", "dk9", "dk10", "nl1", "nl2"]);
  };
  (window as unknown as { __darkCheck: typeof runCheck }).__darkCheck = runCheck;
  // `await __failedSendCheck()`: types a message, sends it three times against a server that rejects it, and reports what Compose looks like each time it reopens
  (window as unknown as { __failedSendCheck: typeof failedSendCheck }).__failedSendCheck = () => failedSendCheck(wait);
  const tokens = window.location.hash.slice(1).split("&").filter(Boolean);
  for (const tok of tokens) {
    const [k, v = ""] = tok.split("=");
    const val = decodeURIComponent(v);
    if (k === "dark" || k === "light") st().setPrefs({ theme: k });
    else if (k === "pane") st().setPrefs({ readingPane: val as "right" | "bottom" });
    else if (k === "settings") st().setDialog({ type: "settings", tab: val });
    else if (k === "density") st().setPrefs({ density: val as "full" | "medium" | "compact" });
    else if (k === "cal") {
      st().setPrefs({ calView: (val || "month") as "month" | "week" | "agenda" });
      st().setModule("calendar");
    } else if (k === "date") {
      const d = parseDate(val);
      if (d) st().setCalDate(d);
    } else if (k === "folder") await st().setView(val, val === "scheduled" ? null : "a1");
    else if (k === "thread") await st().select(val);
    else if (k === "failcheck") {
      const rep = await failedSendCheck(wait);
      const pre = document.createElement("pre");
      pre.id = "failcheck";
      pre.style.cssText = "position:fixed;inset:60px 20px 20px 20px;z-index:9999;overflow:auto;background:#000;color:#0f0;padding:10px;font:12px/1.35 monospace;white-space:pre-wrap";
      pre.textContent = rep.join("\n");
      document.body.appendChild(pre);
    } else if (k === "darkcheck") {
      const rep = await runCheck();
      const pre = document.createElement("pre");
      pre.style.cssText = "position:fixed;inset:60px 20px 20px 20px;z-index:9999;overflow:auto;background:#000;color:#0f0;padding:10px;font:12px/1.35 monospace;white-space:pre-wrap";
      pre.textContent = rep.map((r) => `${r.id}: ${r.elements} elements, paper=${r.paper.length} kept=${r.kept.length} text<AA=${r.text.length}${[...r.paper, ...r.kept, ...r.text].map((x) => "\n    " + x).join("")}`).join("\n");
      document.body.appendChild(pre);
    } else if (k === "slowsync") syncDelay = 60000;
    else if (k === "addacct") {
      // `addacct=imap` / `addacct=google` / `addacct=microsoft`: adds an account the way the Settings dialog does (then opens its Inbox)
      const { api } = await import("./api");
      const acc = val === "google" ? await api.googleSignIn("id", "", "") : val === "microsoft" ? await api.microsoftSignIn("id", "", "", "") : await api.addAccount({ email: "sam@fastmail.test", displayName: "Sam", imapHost: "imap.fastmail.test", imapPort: 993, imapSsl: true, smtpHost: "smtp.fastmail.test", smtpPort: 465, smtpSecurity: "ssl", username: "sam@fastmail.test", smtpUsername: "", tlsInsecure: false }, "pw");
      void st().accountAdded(acc);
    }
    else if (k === "event") st().setDialog({ type: "event", eventId: val === "new" ? undefined : val });
    else if (k === "compose") await st().openCompose(val === "draft" || val === "draftcustom" ? { accountId: "a1", to: ["alice@fabrikam.com"], subject: "Draft with signature", replaces: "d1", bodyHtml: `<p>Saved draft text</p><br><div class="sig">-- <br>${val === "draft" ? "Nam<br>Hey Look!" : "Old signature<br>no longer in the list"}</div>` } : val === "new" ? { accountId: "a1", to: ["alice@fabrikam.com"], subject: "Hello" } : { accountId: "a1", to: ["alice@fabrikam.com"], cc: ["bob@northwind.io"], subject: "Q4 contract call", meeting: { on: true } });
    else if (k === "type") { await wait(400); const ed = document.querySelector<HTMLElement>(".editor .tiptap"); ed?.focus(); document.execCommand("insertText", false, val); } // types into the open Compose body
    else if (k === "chip") {
      await wait(600);
      const el = [...document.querySelectorAll<HTMLElement>(".ev-chip, .wk-ev, .ag-row")].find((x) => x.textContent?.includes(val));
      el?.click();
    } else if (k === "click") {
      // `click=Snooze` presses the first button with that title, label or text (e.g. to screenshot an open ribbon menu)
      await wait(300);
      [...document.querySelectorAll<HTMLElement>("button")].find((b) => (b.getAttribute("aria-label") ?? b.title) === val || b.textContent?.trim() === val)?.click();
    } else if (k === "wait") await wait(Number(val) || 300);
    await wait(250);
  }
}

/** `?frame=win` previews the Windows title bar: a pretend window (maximize/restore, focus, fullscreen) stands in for Tauri's. */
function simulateWindowFrame(): boolean {
  if (new URLSearchParams(window.location.search).get("frame") !== "win") return false;
  const st = { maximized: false, fullscreen: false, focused: true };
  const resized = new Set<() => void>();
  const focus = new Set<(f: boolean) => void>();
  const ping = () => resized.forEach((cb) => cb());
  window.addEventListener("focus", () => (st.focused = true, focus.forEach((cb) => cb(true))));
  window.addEventListener("blur", () => (st.focused = false, focus.forEach((cb) => cb(false))));
  setSimulatedWindow({
    minimize: async () => undefined,
    toggleMaximize: async () => ((st.maximized = !st.maximized), ping()),
    close: async () => undefined,
    isMaximized: async () => st.maximized,
    isFullscreen: async () => st.fullscreen,
    setFullscreen: async (on) => ((st.fullscreen = on), ping()),
    isFocused: async () => st.focused,
    onResized: async (cb) => (resized.add(cb), () => void resized.delete(cb)),
    onFocusChanged: async (cb) => (focus.add(cb), () => void focus.delete(cb)),
  });
  return true;
}

// ---- adding accounts (Settings > Add account, Welcome): the mock backend creates the account after a short delay.
// Failures to try: password `wrong` (IMAP), client id `fail` (Google / Microsoft). Its first sync takes 2.5 s, then three messages appear.
const synced = new Set<string>();
let syncDelay = 2500; // `#slowsync` holds the first sync open (to screenshot the loading state)
let newSeq = 0;
function mockNewAccount(email: string, displayName: string, auth: string, imapHost: string, smtpHost: string) {
  if (accounts.some((x) => x.email.toLowerCase() === email.toLowerCase())) throw new Error("ACCOUNT_EXISTS: this account is already added");
  const acc = {
    id: `n${++newSeq}`, email, displayName, imapHost, imapPort: 993, imapSsl: true, smtpHost, smtpPort: 465, smtpSecurity: "ssl",
    username: email, smtpUsername: "", tlsInsecure: false, auth, color: pickAccountColor(accounts.map((x) => x.color)),
  };
  accounts.push(acc);
  for (const [i, k] of ["inbox", "drafts", "sent", "archive", "junk", "trash"].entries()) folders.push({ accountId: acc.id, key: k, name: k, unread: k === "inbox" ? 3 : 0, total: k === "inbox" ? 3 : i });
  return acc;
}
const later = <T,>(ms: number, f: () => T) => new Promise<T>((res, rej) => setTimeout(() => { try { res(f()); } catch (e) { rej(e); } }, ms));
const newThreads = (accountId: string) =>
  [["Welcome to your new mailbox", "Mail Team", "Your account is connected. Everything arrives here.", 0.2 * H, 1], ["Getting started", "Mail Team", "Three quick tips for your inbox.", 3 * H, 0], ["Your first newsletter", "Digest", "Nothing to read yet, but this is how it looks.", 20 * H, 0]]
    .map(([subject, who, snippet, ago, unread], i) => t(`${accountId}-t${i}`, subject as string, [who as string], snippet as string, ago as number, { accountId, unread }));

export function installMock() {
  const frame = simulateWindowFrame();
  if (/(^|&)noaccounts(&|$)/.test(window.location.hash.slice(1))) {
    accounts.length = 0; // first-run: the Welcome screen
    folders.length = 0;
  }
  // `#legacycolor=<hex>`: accounts as an older version stored them (no color) and that primary color: shows the one-time migration
  const legacy = /(^|&)legacycolor=(%23)?([0-9a-f]{6})(&|$)/i.exec(window.location.hash.slice(1));
  if (legacy) {
    settings.prefs = JSON.stringify({ accent: "#" + legacy[3] });
    for (const x of accounts) (x as { color: string | null }).color = null;
  }
  // `__colorCheck()` in the console: dev self-check of the picker and the resolver
  (window as unknown as { __colorCheck: () => string[] }).__colorCheck = () => {
    const out: string[] = [], ok = (c: boolean, m: string) => out.push((c ? "ok   " : "FAIL ") + m);
    ok(pickAccountColor([]) === ACCOUNT_PALETTE[0], "empty -> first");
    ok(pickAccountColor([ACCOUNT_PALETTE[0], "#123456", null]) === ACCOUNT_PALETTE[1], "custom/null ignored, next unused");
    ok(pickAccountColor([ACCOUNT_PALETTE[0].toUpperCase(), ACCOUNT_PALETTE[1]]) === ACCOUNT_PALETTE[2], "case-insensitive");
    const all = [...ACCOUNT_PALETTE, ACCOUNT_PALETTE[0], ACCOUNT_PALETTE[1]];
    ok(pickAccountColor(all) === ACCOUNT_PALETTE[2], "all used -> least used, earliest");
    ok(accountColor({ color: "#ABCDEF" }, "#6d4aff") === "#abcdef", "stored color wins (lowercased)");
    ok(accountColor({ color: null }, "#0f6cbd") === accountColor(undefined, "#0f6cbd"), "no stored color -> primary color");
    ok(accountColor({ color: "red" }, "#0f6cbd").startsWith("#"), "invalid stored value -> primary color");
    return out;
  };
  // `await __textCheck()`: dev self-check of the catch-up toast grammar and of how long error texts are shortened
  (window as unknown as { __textCheck: () => Promise<string[]> }).__textCheck = async () => {
    const { catchupText } = await import("./util");
    const { cutAtWord, friendlyError, fullErrorFor, shortenError } = await import("./store");
    const out: string[] = [], ok = (c: boolean, m: string) => out.push((c ? "ok   " : "FAIL ") + m);
    ok(catchupText(1) === "Sent 1 scheduled message that was due while Hey Look! was closed.", "catch-up toast, one message: was");
    ok(catchupText(2) === "Sent 2 scheduled messages that were due while Hey Look! was closed.", "catch-up toast, several: were");
    const advice = "The server rejected the attachment type. Gmail, Outlook and Yahoo refuse programs and scripts such as .exe, .bat, .js or .msi, even inside a zip file. Remove the attachment or share it as a link instead.";
    const reply = "Server reply: 5.7.0 This message was blocked because its content presents a potential security issue. Please visit https://support.google.com/mail/?p=BlockedMessage to review our guidelines. gsmtp";
    const shown = friendlyError(`SMTP_ATTACHMENT_BLOCKED: ${advice} (${reply})`);
    ok(shown.startsWith(advice + " (Server reply: 5.7.0"), "friendly advice is shown whole");
    const cut = shown.slice(shown.indexOf("(Server reply: ") + 1, -1).replace(/…$/, "");
    ok(shown.endsWith("…)") && cut.length <= 120 && reply.startsWith(cut), "server text is cut with an ellipsis, a prefix of the original, at most 120 characters");
    ok(reply.charAt(cut.length) === " ", "the cut falls on a word boundary");
    ok(fullErrorFor(`Send failed: ${shown}`) === `Send failed: ${advice} (${reply})`, "the whole text is kept for the tooltip");
    ok(shortenError("short error") === "short error" && fullErrorFor("short error") === undefined, "short texts are untouched");
    ok(cutAtWord("alpha beta gamma delta", 14) === "alpha beta…", "cut at a word");
    ok(friendlyError("x ".repeat(300)).length <= 221, "other long errors are cut at 220");
    return out;
  };
  // `__sigCheck()`: dev self-check of the signature region <-> stored HTML conversion
  (window as unknown as { __sigCheck: () => string[] }).__sigCheck = () => {
    const out: string[] = [], ok = (c: boolean, m: string) => out.push((c ? "ok   " : "FAIL ") + m);
    const sig = "Nam<br><b>Hey Look!</b>";
    const stored = fillSignatureHtml(`<p>Hi</p>${SIG_MARK}<p></p>`, sig);
    ok(stored === `<p>Hi</p><br><div class="sig">-- <br>${sig}</div>`, "marker -> stored signature, trailing empty paragraph dropped");
    const back = extractSignature(stored);
    ok(back.sig === sig, "stored signature -> its html");
    ok(normalizeHtml(back.html) === normalizeHtml(`<p>Hi</p>${SIG_MARK}<p></p>`), "stored signature -> marker again (no <br> left behind)");
    ok(fillSignatureHtml(back.html, sig) === stored, "round trip is stable");
    ok(fillSignatureHtml(`<p>Hi</p>${SIG_MARK}<p></p>`, null) === "<p>Hi</p>", "no signature: nothing added");
    const reply = fillSignatureHtml(`<p>Thanks</p>${SIG_MARK}<br><br><div>On Mon wrote:</div><blockquote>q</blockquote>`, sig);
    ok(reply.indexOf('class="sig"') > reply.indexOf("Thanks") && reply.indexOf('class="sig"') < reply.indexOf("<blockquote"), "reply: signature sits between the answer and the quote");
    // a reply whose quoted message has a signature of its own: only the writer's region is the signature
    const quoted = `<p>Thanks</p><br><div class="sig">-- <br>${sig}</div><br><br><div>On Mon wrote:</div><blockquote><p>q</p><div class="sig">-- <br>Other</div></blockquote>`;
    const q = extractSignature(quoted);
    ok(q.sig === sig && q.html.includes("Other") && q.html.split("data-sig-block").length === 2, "reply: the quoted message's signature stays quoted text");
    // a failed send reopens the draft again and again: one signature, the same body every time
    const html = `<p>Hi</p><p>second paragraph</p>${SIG_MARK}<br><br><div>On Mon wrote:</div><blockquote><p>q</p></blockquote>`;
    const first = fillSignatureHtml(html, sig);
    let cur = first;
    for (let i = 1; i <= 3; i++) {
      const re = extractSignature(cur);
      ok(re.sig === sig && re.html.split("data-sig-block").length === 2, `reopen ${i}: one signature region`);
      cur = fillSignatureHtml(re.html, re.sig);
      ok(cur === first && cur.split("class=\"sig\"").length === 2, `reopen ${i}: stored body unchanged, one signature`);
    }
    const none = extractSignature("<p>Old draft</p>");
    ok(none.sig === null && none.html.includes(SIG_MARK), "draft without signature gets an empty region");
    return out;
  };
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "list_accounts": return accounts;
      case "get_setting": return settings[a.key as string] ?? null;
      case "set_setting": settings[a.key as string] = a.value as string; return null;
      case "list_folders": return folders;
      case "list_threads": {
        const f = a.filter as { folder: string; focus?: string; unreadOnly?: boolean; search?: string };
        let list = threads;
        if (f.focus === "other") list = threads.filter((x) => x.bulk);
        else if (f.focus === "focused") list = threads.filter((x) => !x.bulk);
        if (f.unreadOnly) list = list.filter((x) => x.unread);
        // mirror the Rust backend: every free word must appear in subject, snippet or participants
        const words = (f.search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        if (words.length) {
          list = list.filter((x) => {
            const hay = [x.subject, x.snippet, ...x.participants].join(" ").toLowerCase();
            return words.every((w) => hay.includes(w));
          });
        }
        const own = (a.filter as { accountId?: string | null }).accountId;
        if (own && own.startsWith("n")) return f.folder === "inbox" && synced.has(own) ? newThreads(own) : []; // an added account: empty until its first sync is done
        return f.folder === "inbox" || f.folder === "unread" || f.folder === "all" ? list : [];
      }
      case "get_thread":
        if (a.threadId === "t9") return [ownLocked ? lockedMsg() : openedMsg()];
        if (a.threadId === "t25") return [encInvite(ownLocked)];
        if (threadInvite[a.threadId as string]) return threadInvite[a.threadId as string].map((id) => inviteMsgs[id]);
        if (mockThreadMsgs[a.threadId as string]) return mockThreadMsgs[a.threadId as string];
        if (darkThreads[a.threadId as string]) return darkThreads[a.threadId as string];
        if (a.threadId === "nl1") return [{ ...messages[0], id: "ml", subject: "Lotusmiles 10.2026 Account Statement", fromName: "Lotusmiles", fromEmail: "news@lotusmiles.example", html: longMail(800), attachments: [], canUnsubscribe: true }];
        if (a.threadId === "nl2") return [{ ...messages[0], id: "ml2", subject: "Monthly digest (620px layout)", fromName: "Digest", fromEmail: "digest@example.com", html: longMail(620), attachments: [], canUnsubscribe: false }];
        return a.threadId === "t7" ? [m4] : a.threadId === "t1" ? messages : a.threadId === "t4"
        ? [{ ...messages[0], id: "mt", subject: "Tall newsletter", html: "<html><head><style>html,body{height:100%;margin:0}</style></head><body><table width='100%' height='100%'><tr><td style='background:#f4f4f8'><div style='height:900px;background:linear-gradient(#e8a317,#2aa)'>tall block</div><p id='endmark'>THE END</p></td></tr></table></body></html>", attachments: [] }]
        : [{ ...messages[0], id: "mx", subject: "Hello", html: "<p>Hello from the mock backend.</p>", attachments: [] }];
      case "sync_account": {
        const id = String(a.accountId ?? a.id ?? "");
        if (id.startsWith("n") && !synced.has(id)) return later(syncDelay, () => (synced.add(id), { added: 3, newInbox: [] }));
        return { added: 0, newInbox: [] };
      }
      case "add_account": {
        const inp = a.input as { email: string; displayName: string; imapHost: string; smtpHost: string };
        if (a.passwordValue === "wrong") return later(900, () => { throw new Error("AUTH: login failed: invalid credentials"); });
        return later(1200, () => mockNewAccount(inp.email, inp.displayName || inp.email.split("@")[0], "password", inp.imapHost, inp.smtpHost));
      }
      case "google_sign_in": case "microsoft_sign_in": {
        const g = cmd === "google_sign_in";
        if (a.clientId === "fail") return later(900, () => { throw new Error("OAUTH: sign-in was cancelled in the browser"); });
        return later(1200, () => mockNewAccount(g ? `new.user${newSeq + 1}@gmail.com` : `new.user${newSeq + 1}@outlook.com`, String(a.displayName || "New User"), g ? "oauth_google" : "oauth_microsoft", g ? "imap.gmail.com" : "outlook.office365.com", g ? "smtp.gmail.com" : "smtp.office365.com"));
      }
      case "list_outbox": return mockOutbox;
      case "outbox_pending_count": return { count: mockOutbox.filter((o) => o.status !== "failed").length, next: now + 3 * H };
      case "outbox_open_for_edit": {
        const o = mockOutbox.find((x) => x.id === a.id) ?? mockOutbox[0];
        return { draft: mockDraftOf(o), sendAt: o.sendAt, status: o.status === "pending" || o.status === "overdue" ? "held" : o.status };
      }
      case "list_templates": return [{ id: "tp1", name: "Thanks", subject: "Thanks!", body: "<p>Thanks for your message.</p>" }, { id: "tp2", name: "Quarterly customer success follow-up with a deliberately very long template name", subject: "Follow-up", body: "<p>Hello</p>" }];
      case "list_signatures": return [{ id: "s1", name: "Work", html: "Nam<br>Hey Look!", isDefault: true }, { id: "s2", name: "Personal signature with a very long name that has to be cut with an ellipsis before it reaches the tag", html: "Nam", isDefault: false }, { id: "s3", accountId: "a2", name: "Gmail", html: "Nam (via Gmail)<br><i>nam@gmail.com</i>", isDefault: true }];
      case "list_senders": return [{ email: "news@ph.com", name: "Product Hunt", count: 42, unread: 12, canUnsubscribe: true, lastDate: now - H }];
      case "list_rules": return [{ id: "r1", accountId: null, name: "Move newsletters", field: "from", op: "contains", value: "newsletter@example.com", action: "archive", arg: null, enabled: true }, { id: "r2", accountId: null, name: "", field: "subject", op: "contains", value: "a very long rule text that should be truncated in the list row", action: "trash", arg: null, enabled: false }];
      case "list_blocked": return [];
      case "thread_action": return new Promise((r) => setTimeout(() => r(null), 600)); // slow like IMAP
      case "update_account": {
        const x = accounts.find((y) => y.id === a.accountId);
        if (x) { x.displayName = a.displayName as string; (x as { color: string | null }).color = (a.color as string | null) ?? null; }
        return null;
      }
      case "save_draft": (window as unknown as { __lastDraft: unknown }).__lastDraft = a.draft; return null;
      case "queue_action": return "token-" + Math.random().toString(36).slice(2);
      case "cancel_action": return true;
      case "load_older": return 0;
      case "has_secret": return false;
      case "google_env_configured": case "microsoft_env_configured": return false;
      case "microsoft_tenant": return "";
      case "discover_server": {
        const email = String(a.email ?? "");
        if (email.endsWith("@nowhere.test")) return null;
        const domain = email.split("@")[1] ?? "example.com";
        return { imapHost: `imap.${domain}`, imapPort: 993, imapSsl: true, smtpHost: `smtp.${domain}`, smtpPort: 587, smtpSecurity: "starttls", username: email, oauth: null, source: "autoconfig" };
      }
      case "set_secret": return null;
      case "attachment_data": {
        const att = [m4, ...messages].find((x) => x.id === a.messageId)?.attachments.find((z) => z.index === a.index);
        const name = att?.name ?? "file.pdf";
        const mime = att?.mime ?? "application/pdf";
        return { name, mime, dataBase64: mime.startsWith("image/") ? PIC : btoa(`Mock contents of ${name}\n`) };
      }
      case "inline_image": return { mime: "image/png", dataBase64: PIC, name: "picture.png" };
      case "save_attachments": return ["C:/Users/Me/Downloads/logo.png"];
      case "attachment_save_as": return "C:/Users/Me/Downloads/logo.png";
      case "attachment_save_all": return { dir: "C:/Users/Me/Downloads", saved: ["C:/Users/Me/Downloads/logo.png", "C:/Users/Me/Downloads/agenda.pdf"], failed: [] };
      case "attachment_open": return "C:/Users/Me/AppData/Local/Temp/HeyLook/m4/logo.png";
      case "attachment_reveal": return null;
      case "pick_folder": return "C:/Users/Me/Documents/Attachments";
      case "pgp_list_keys": return pgpKeys.map((k) => ({ ...k, unlocked: k.fingerprint === OWN_FPR && !ownLocked, passphraseRemembered: k.fingerprint === OWN_FPR && !ownLocked }));
      case "pgp_generate_key": return new Promise((res, rej) => setTimeout(() => {
        const acct = accounts.find((x) => x.id === a.accountId);
        if (!acct) return rej("account not found");
        const k = mkKey(`${acct.displayName} <${acct.email}>`, { hasSecret: true, verified: true, source: "generated", algo: a.algo === "rsa3072" ? "RSA 3072" : "Ed25519 / Curve25519", defaultFor: [acct.id], expires: a.expiresDays ? now + (a.expiresDays as number) * 86400 : null, created: now }, `#${++keySeq}`);
        pgpKeys = [k, ...pgpKeys.map((x) => ({ ...x, defaultFor: x.defaultFor.filter((d) => d !== acct.id) }))];
        res(k);
      }, 1400));
      case "pgp_inspect_key": {
        const t = String(a.armored ?? a.path ?? "");
        if (a.path) return { keys: [mkKey("Dana Smith <dana@example.org>", { source: "file" })], isSecret: false, needsNewPassphrase: false, alreadyKnown: [] };
        if (!t.includes("-----BEGIN PGP")) throw "This doesn't look like an OpenPGP key.";
        if (/PRIVATE KEY/.test(t)) return { keys: [mkKey("Nam <nam@example.com>", { hasSecret: true })], isSecret: true, needsNewPassphrase: false, alreadyKnown: [pgpKeys[0].fingerprint] };
        if (/revoked/i.test(t)) return { keys: [mkKey("Rev Oked <rev@example.org>", { revoked: true })], isSecret: false, needsNewPassphrase: false, alreadyKnown: [] };
        if (/expired/i.test(t)) return { keys: [mkKey("Ex Pired <exp@example.org>", { expired: true, expires: now - 120 * 86400 })], isSecret: false, needsNewPassphrase: false, alreadyKnown: [] };
        return { keys: [mkKey("Bao Tran <bao@contoso.com>")], isSecret: false, needsNewPassphrase: false, alreadyKnown: /known/i.test(t) ? [pgpKeys[3].fingerprint] : [] };
      }
      case "pgp_import_key": {
        if (a.passphrase === "wrong") throw "PGP_BAD_PASSPHRASE: Wrong passphrase for this secret key.";
        const k = mkKey(a.path ? "Dana Smith <dana@example.org>" : "Bao Tran <bao@contoso.com>", { verified: !!a.verified, source: a.path ? "file" : "paste" });
        pgpKeys = [...pgpKeys.filter((x) => x.fingerprint !== k.fingerprint), k];
        return [k];
      }
      case "pgp_import_from_message": {
        const k = mkKey("Eve Park <eve@example.org>", { source: "email" });
        pgpKeys = [...pgpKeys.filter((x) => x.fingerprint !== k.fingerprint), k];
        return [k];
      }
      case "pgp_pick_key_file": return "C:/Users/Me/Documents/dana-public.asc";
      case "pgp_public_armored": return "-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nmDMEZx...\n-----END PGP PUBLIC KEY BLOCK-----";
      case "pgp_export_public": return "C:/Users/Me/Documents/key-public.asc";
      case "pgp_export_secret": return "C:/Users/Me/Documents/key-secret-BACKUP.asc";
      case "pgp_delete_key": pgpKeys = a.includeSecret ? pgpKeys.filter((k) => k.fingerprint !== a.fingerprint) : pgpKeys.map((k) => (k.fingerprint === a.fingerprint ? { ...k, hasSecret: false } : k)); return null;
      case "pgp_set_verified": pgpKeys = pgpKeys.map((k) => (k.fingerprint === a.fingerprint ? { ...k, verified: !!a.verified } : k)); return null;
      case "pgp_set_default": pgpKeys = pgpKeys.map((k) => ({ ...k, defaultFor: k.defaultFor.filter((x) => x !== a.accountId).concat(k.fingerprint === a.fingerprint ? [a.accountId as string] : []) })); return null;
      case "pgp_change_passphrase": if (a.oldPassphrase !== "secret123") throw "PGP_BAD_PASSPHRASE: Wrong passphrase. Try again."; return null;
      case "pgp_set_expiry": {
        if (a.passphrase !== "secret123") throw "PGP_BAD_PASSPHRASE: Wrong passphrase. Try again.";
        pgpKeys = pgpKeys.map((k) => (k.fingerprint === a.fingerprint ? { ...k, expired: false, expires: a.expiresDays ? now + (a.expiresDays as number) * 86400 : null } : k));
        return pgpKeys.find((k) => k.fingerprint === a.fingerprint);
      }
      case "pgp_unlock": {
        if (pgpAttempts >= 5) throw "PGP_LOCKED_OUT: Too many attempts. Wait 30 seconds.";
        if (a.passphrase !== "secret123") {
          pgpAttempts++;
          throw pgpAttempts >= 5 ? "PGP_LOCKED_OUT: Too many attempts. Wait 30 seconds." : "PGP_BAD_PASSPHRASE: Wrong passphrase. Try again.";
        }
        pgpAttempts = 0;
        ownLocked = false;
        return null;
      }
      case "pgp_lock_all": ownLocked = true; return null;
      case "pgp_recipient_status": {
        const ownKey = pgpKeys.find((k) => k.hasSecret && !k.expired && k.defaultFor.includes(a.accountId as string));
        return {
          own: ownKey ? { fingerprint: ownKey.fingerprint, canSign: true, canEncrypt: true, unlocked: !ownLocked, expired: false } : null,
          recipients: (a.addresses as string[]).map((addr) => {
            const k = keyFor(addr.toLowerCase());
            if (!k) return { address: addr, status: "missing" };
            return { address: addr, status: k.revoked ? "revoked" : k.expired ? "expired" : "ok", fingerprint: k.fingerprint, verified: k.verified, expires: k.expires };
          }),
        };
      }
      case "pgp_decrypt_message": {
        if (a.passphrase !== null && a.passphrase !== undefined && a.passphrase !== "secret123") {
          pgpAttempts++;
          throw pgpAttempts >= 5 ? "PGP_LOCKED_OUT: Too many attempts. Wait 30 seconds." : "PGP_BAD_PASSPHRASE: Wrong passphrase. Try again.";
        }
        pgpAttempts = 0;
        if (a.passphrase) ownLocked = false;
        return a.messageId === "m-enc-inv" ? encInvite(false) : openedMsg();
      }
      case "calendar_list_calendars":
        return [
          { id: "local", name: "My events", color: "#8764b8", accountId: null, visible: !hiddenCals.has("local") },
          ...accounts.map((x) => ({ id: `invites:${x.id}`, name: `Invitations · ${x.email}`, color: x.color ?? "", accountId: x.id, visible: !hiddenCals.has(`invites:${x.id}`) })),
        ];
      case "calendar_set_visible": if (a.visible) hiddenCals.delete(a.calendarId as string); else hiddenCals.add(a.calendarId as string); return null;
      case "calendar_list_events": {
        const from = a.from as number, to = a.to as number;
        return calEvents
          .filter((e) => !hiddenCals.has(e.calendarId))
          .flatMap((e) => (e.allDay ? (e.end > from - 86400 && e.start < to + 86400 ? [e] : []) : expandMock(e, from, to)))
          .sort((x, y) => x.start - y.start);
      }
      case "calendar_get_event": {
        const e = calEvents.find((x) => x.id === a.id);
        if (!e) throw "event not found";
        return e;
      }
      case "calendar_save_event": {
        const inp = a.event as Record<string, unknown> & { id?: string | null; attendees: { email: string; name?: string }[]; accountId?: string };
        const guests = inp.attendees ?? [];
        const prev = inp.id ? calEvents.find((x) => x.id === inp.id) : undefined;
        const acct = accounts.find((x) => x.id === inp.accountId);
        const saved = ev(prev?.id ?? `e${++eventSeq}`, String(inp.summary), inp.start as number, inp.end as number, {
          allDay: inp.allDay, tzid: inp.tzid ?? null, location: inp.location ?? null, description: inp.description ?? null, rrule: inp.rrule ?? null, reminderMin: inp.reminderMin ?? null,
          accountId: inp.accountId ?? null, recurrenceText: inp.rrule ? "Repeats" : null, sequence: (prev?.sequence as number ?? 0) + (guests.length ? 1 : 0),
          myStatus: guests.length ? "organizer" : null,
          organizer: guests.length && acct ? { email: acct.email, name: acct.displayName } : null,
          attendees: guests.length && acct ? [{ email: acct.email, name: acct.displayName, role: "chair", status: "accepted", isYou: true }, ...guests.map((g) => ({ ...g, role: "required", status: "needs-action", isYou: false }))] : [],
        });
        if (guests.some((g) => g.email.includes("fail")) && a.notify) {
          calEvents = [...calEvents.filter((x) => x.id !== saved.id), saved];
          throw "CAL_SEND_FAILED: The event was saved, but the invitations weren't sent: SMTP send failed: connection timed out";
        }
        calEvents = [...calEvents.filter((x) => x.id !== saved.id), saved];
        return saved;
      }
      case "calendar_delete_event": calEvents = calEvents.filter((x) => x.id !== a.id); return null;
      case "calendar_respond": {
        const m = inviteMsgs[a.messageId as string];
        if (!m) throw "message not found";
        if (a.messageId === "m-inv-flaky" && a.send && !flakyFailed) {
          flakyFailed = true;
          throw "CAL_SEND_FAILED: SMTP send failed: authentication failed";
        }
        const inv = m.invite as Record<string, unknown>;
        const status = a.response as string;
        inv.responded = { status, sentAt: a.send ? Math.floor(Date.now() / 1000) : null };
        inv.you = { ...(inv.you as object), status };
        const row = calEvents.find((x) => x.id === inv.eventId);
        if (row) row.myStatus = status;
        return inv;
      }
      case "calendar_add_from_message": {
        const inv = inviteMsgs[a.messageId as string].invite as Record<string, unknown>;
        const e = ev(`e${++eventSeq}`, String(inv.summary), inv.start as number, inv.end as number, { allDay: inv.allDay, tzid: inv.tzid, calendarId: "invites:a1", accountId: "a1", sourceMessageId: a.messageId as string });
        calEvents = [...calEvents, e];
        inv.eventId = e.id;
        return e;
      }
      case "calendar_save_ics": return "C:/Users/Me/Documents/invite.ics";
      case "calendar_import_ics": return { added: 2, updated: 1 };
      case "calendar_open_message": return { threadId: "t15", folder: "inbox", accountId: "a1" };
      case "send_message": {
        // a subject with [fail] is rejected like Gmail rejects a program file (dev check of the failed-send path: __failedSendCheck)
        if (!a.sendAt && String((a.draft as { subject?: string }).subject).includes("[fail]")) throw "SMTP_ATTACHMENT_BLOCKED: The server rejected the attachment type. Gmail, Outlook and Yahoo refuse programs and scripts such as .exe, .bat, .js or .msi, even inside a zip file. Remove the attachment or share it as a link instead. (Server reply: (5.7.0 This message was blocked because its content presents a potential security issue. Please visit https://support.google.com/mail/?p=BlockedMessage to review our message content and attachment content guidelines. gsmtp)";
        if (!a.sendAt) return "sent";
        // a scheduled message shows up in the Scheduled list
        const d = a.draft as { accountId: string; to: string[]; cc: string[]; subject: string; text?: string; attachments?: unknown[] };
        const id = `mock-${Math.random().toString(36).slice(2, 8)}`;
        mockOutbox.push({ id, accountId: d.accountId, to: d.to, cc: d.cc ?? [], subject: d.subject, snippet: (d.text ?? "").slice(0, 120), hasAttachments: !!d.attachments?.length, createdAt: now, attempts: 0, sendAt: a.sendAt as number, status: "pending", error: null });
        return `scheduled:${id}`;
      }
      case "suggest_contacts": return [{ name: "Linh Tran", email: "linh@example.com" }];
      case "ai_list_models": {
        if (String(a.endpoint).includes("bad")) throw "Models request failed (404 Not Found)"; // lets the error state be tried in the browser
        return new Promise((r) => setTimeout(() => r(["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o3-mini", "text-embedding-3-small"]), 500));
      }
      case "ai_complete": return "• Linh shared the Q4 roadmap\n• Review requested before Thursday";
      case "get_autostart": return false;
      case "cancel_outbox": case "outbox_send_now": case "outbox_to_draft": {
        const i = mockOutbox.findIndex((x) => x.id === a.id);
        if (i >= 0) mockOutbox.splice(i, 1);
        return null;
      }
      case "outbox_update": case "outbox_reschedule": {
        const o = mockOutbox.find((x) => x.id === a.id);
        if (o) {
          o.sendAt = a.sendAt as number;
          o.status = "pending";
          o.error = null;
          const d = a.draft as { to?: string[]; cc?: string[]; subject?: string } | undefined;
          if (d?.subject !== undefined) o.subject = d.subject;
          if (d?.to) o.to = d.to;
          if (d?.cc) o.cc = d.cc;
        }
        return null;
      }
      case "outbox_retry": {
        const o = mockOutbox.find((x) => x.id === a.id);
        if (o) (o.status = "pending", o.error = null);
        return null;
      }
      case "outbox_release": case "quit_now": return null;
      case "frame_info": return { custom: frame, snapLayouts: false };
      case "frame_caption_rect": return false; // no OS hit-testing in a browser: plain DOM buttons
      case "frame_system_menu": return null;
      default: return null;
    }
  });
}
