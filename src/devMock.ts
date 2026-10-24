// Dev-only: lets the UI run in a plain browser (npm run dev) with fake data, no Tauri backend.
import { deleteScoped, expandRow, getScoped, saveScoped, type Row as SeriesRow, type Scope as SeriesScope } from "./devMockSeries";
import { emit } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { gmailSearchUrl, toGmailQuery, toWebmailQuery, webmailOf, webmailTargets, WebmailId } from "./webmail";
import { darkMessages, darkThreadRows } from "./devMockDark";
import { extractSignature, fillSignatureHtml, normalizeHtml, SIG_MARK } from "./signature";
import { ACCOUNT_PALETTE, accountColor, pickAccountColor } from "./prefs";
import { setSimulatedWindow } from "./winframe";
import { parseReplyTo } from "./replyTo";
import { nameInlinePicture } from "./editor/messageBody";
import type { LangPref } from "./i18n";
import { packThread } from "./threadPack";
import type { MessageFull } from "./api";

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
  t("tconf", "Board pack — Highly Confidential", ["Linh Tran"], "Revenue is down 12% and we plan to cut the Hanoi office.", 1 * H, { unread: 1, confidential: true, hasAttach: true }),
  t("t14", "Weekly sync notes", ["Bao Tran"], "Notes from today are below. Signed inline.", 9 * H, { signed: true }),
];

// a mailing-list style message whose Reply-To is not its From (Reply goes to the Reply-To address), with a quoted name in To
threads.push(t("trt", "Reply-To probe", ["Acme No Reply"], "Please answer to support, not to this address.", 3.5 * H, { unread: 0 }));

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
  t("tconf-inv", "Invitation: Board pack review — Highly Confidential", ["Linh Tran"], "Confidential message", 1.1 * H, { invite: "request", confidential: true }),
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
  trt: [secMsg("m-rt", "Reply-To probe", "Acme No Reply", "no-reply@acme.example", { to: "nam@example.com,john@acme.example,JOHN@acme.example,y@acme.example", cc: "cc@acme.example,nam@gmail.com" }, "<p>Please answer to support, not to this address.</p>")],
  t9: [lockedMsg()],
  t10: [secMsg("m-nokey", "Archive access", "Minh Pham", "minh@example.com", { security: { encrypted: true, partial: false, decryption: "no_key", encryptedFor: ["91AC4E0B5D7F2A31"], signature: null } }, null)],
  t11: [secMsg("m-bad", "Re: Contract changes (damaged)", "Legal Team", "legal@example.com", { security: { encrypted: true, partial: false, decryption: "error", error: "unsupported packet or corrupted transfer", encryptedFor: [], signature: null } }, null)],
  t12: [secMsg("m-inv", "Re: build pipeline", "Bao Tran", "bao@contoso.com", { security: { encrypted: false, partial: false, decryption: "none", encryptedFor: [], signature: { status: "invalid", signer: "Bao Tran", fingerprint: pgpKeys[3].fingerprint, keyId: pgpKeys[3].keyId, signedAt: now - 5 * H, verified: false, matchesFrom: true, inline: false } } }, "<p>The release is tagged. Please check the artifacts at <a href='https://example.com/release'>the release page</a>.</p>")],
  t13: [secMsg("m-unk", "Hello from a new contact", "Eve Park", "eve@example.org", { security: { encrypted: false, partial: false, decryption: "none", encryptedFor: [], signature: { status: "unknown_key", signer: null, fingerprint: null, keyId: "E21C0A9F33B07D12", signedAt: now - H, verified: false, matchesFrom: false, inline: false } } }, "<p>Nice to meet you! My public key is attached.</p>", [{ index: 0, name: "eve-public.asc", mime: "application/pgp-keys", size: 2900 }])],
  tconf: [secMsg("m-conf", "Board pack — Highly Confidential", "Linh Tran", "linh@example.com", { confidential: true }, "<p>Hi Nam,</p><p>Revenue is down 12% and we plan to cut the Hanoi office. Please do not share this.</p><p>— Linh</p>", [
    { index: 0, name: "board-pack.pdf", mime: "application/pdf", size: 2400000 },
    { index: 1, name: "cuts.xlsx", mime: "application/vnd.ms-excel", size: 51000 },
    { index: 2, name: "floorplan.png", mime: "image/png", size: 84000 },
  ])],
  t14: [secMsg("m-ok2", "Weekly sync notes", "Bao Tran", "bao@contoso.com", { security: { encrypted: false, partial: false, decryption: "none", encryptedFor: [], signature: { status: "valid", signer: "Bao Tran", fingerprint: pgpKeys[3].fingerprint, keyId: pgpKeys[3].keyId, signedAt: now - 8 * H, verified: false, matchesFrom: true, inline: true } } }, "<p>Notes from today are below. Signed inline.</p>")],
};

// message importance (F-24): one High and one Low message in the Inbox
threads.push(
  t("timp-hi", "Please approve the change window today", ["Linh Tran"], "We need your sign-off before 17:00 so the release can go out tonight.", 0.8 * H, { unread: 1, importance: "high" }),
  t("timp-lo", "FYI: newsletter archive has moved", ["Minh Pham"], "No action needed, just so you know where to find the old issues.", 1.4 * H, { importance: "low" }),
);
mockThreadMsgs["timp-hi"] = [secMsg("m-imp-hi", "Please approve the change window today", "Linh Tran", "linh@example.com", { importance: "high", seen: false }, "<p>Hi Nam,</p><p>We need your sign-off before 17:00 so the release can go out tonight.</p><p>— Linh</p>")];
mockThreadMsgs["timp-lo"] = [secMsg("m-imp-lo", "FYI: newsletter archive has moved", "Minh Pham", "minh@example.com", { importance: "low" }, "<p>Hi Nam,</p><p>No action needed, just so you know where to find the old issues.</p><p>— Minh</p>")];

// WP8a (W8.1, W8.10): `#wp8` adds two conversations at the top of the Inbox: one to select words in (the text menu's "Search mail for ..."), one with the email links of the acceptance criteria.
if (new URLSearchParams(window.location.hash.slice(1)).has("wp8")) {
  const many = Array.from({ length: 60 }, (_, i) => `u${i}@many.test`).join(",");
  threads.unshift(
    t("tw8-sel", "Budget notes", ["Linh Tran"], "Quarterly budget review moved to Friday", 0.1 * H, { unread: 1 }),
    t("tw8-mailto", "WP8 mailto links", ["Linh Tran"], "Email links for the new message", 0.2 * H, { unread: 1 }),
  );
  mockThreadMsgs["tw8-sel"] = [secMsg("m-wp8-sel", "Budget notes", "Linh Tran", "linh@example.com", { seen: false }, "<p id=\"q\">Quarterly budget review moved to Friday</p><p id=\"long\">one two three four five six seven eight nine ten eleven twelve</p><p id=\"ops\">from:boss subject:\"pay\" Re: invoice</p><p>Write to <a id=\"mail\" href=\"mailto:boss@example.test\">boss@example.test</a></p>")];
  mockThreadMsgs["tw8-mailto"] = [secMsg("m-wp8-mailto", "WP8 mailto links", "Linh Tran", "linh@example.com", { seen: false }, [
    "<p><a id=\"l1\" href=\"mailto:qa1@example.test\">one address</a></p>",
    "<p><a id=\"l2\" href=\"mailto:qa1@example.test,qa2@example.test?cc=qa3@example.test&amp;bcc=qa4@example.test&amp;subject=Hello%20there&amp;body=Line%201%0D%0ALine%202\">full link</a></p>",
    "<p><a id=\"l3\" href=\"mailto:?subject=Only%20subject\">only a subject</a></p>",
    "<p><a id=\"l4\" href=\"mailto:qa1@example.test?attach=C:%5CWindows%5Cwin.ini&amp;from=evil@example.test&amp;In-Reply-To=%3Cx@y%3E\">ignored fields</a></p>",
    `<p><a id="l5" href="mailto:${many}?body=${"x".repeat(10000)}">many addresses</a></p>`,
    "<p><a id=\"l9\" href=\"mailto:other@example.test\">bank.example.test</a></p>",
    "<p><a id=\"l10\" href=\"https://example.test/page\">a web link</a></p>",
  ].join(""))];
}

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

// A real (tiny) PDF for the attachment preview: the app only draws bytes that start with %PDF-
const MOCK_PDF = btoa("%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 43>>stream\nBT /F1 24 Tf 40 100 Td (Hello PDF) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

// A conversation of four messages whose FIRST one carries the attachments (a PDF, a text file, pictures): the preview and the picture viewer open
// from a message that has later messages (each with sticky Reply buttons) below it. test-preview-layer.mjs opens thread "tlayer".
const mockLayerMsgs = [
  { ...m4, id: "ml1", subject: "Layering check", date: now - 9 * H, attachments: [...m4.attachments, { index: 4, name: "notes.txt", mime: "text/plain", size: 120, inline: false, cid: null, referenced: false }] },
  ...[3, 2, 1].map((h, i) => ({ ...secMsg(`ml${i + 2}`, "Re: Layering check", i % 2 ? "Nam" : "Linh Tran", i % 2 ? "nam@example.com" : "linh@example.com", { date: now - h * H }, `<p>${["Thanks for the deck.", "One question about page 3.", "Answered below, ship it."][i]}</p>`) })),
];
mockThreadMsgs.tlayer = mockLayerMsgs;
threads.push(t("tlayer", "Layering check", ["Linh Tran"], "A conversation whose first message has attachments.", 1 * H, { count: 4, hasAttach: true }));

type MockFolder = { accountId: string; key: string; name: string; unread: number; total: number; listed?: boolean; unreadFocused?: number; unreadOther?: number };
const folders: MockFolder[] = ["inbox", "drafts", "sent", "archive", "junk", "trash"].flatMap((k, i) =>
  accounts.map((a) => ({ accountId: a.id, key: k, name: k, unread: k === "inbox" ? (a.id === "a1" ? 4 : 2) : 0, total: 10 + i })),
).concat([{ accountId: "a1", key: "f:Projects/Hey Look", name: "Projects/Hey Look", unread: 0, total: 5 }, { accountId: "a1", key: "f:Clients/International customers/Very long folder name for layout testing", name: "Clients/International customers/Very long folder name for layout testing", unread: 0, total: 3 }]);

// dev checks: `__mockAddFolder(accountId, serverName)` makes a folder on the mock server (as another client would); the page sees it at the next folder list
(window as unknown as { __mockAddFolder: unknown }).__mockAddFolder = (accountId: string, name: string) => void folders.push({ accountId, key: "f:" + name, name, unread: 0, total: 0 });

/** The delimiter and the namespace prefix of the mock server (`#dot`: "." with the INBOX namespace). */
function mockFolderMeta(): { delimiter: string; prefix: string } {
  return /(^|&)dot(=|&|$)/.test(window.location.hash.slice(1)) ? { delimiter: ".", prefix: "INBOX." } : { delimiter: "/", prefix: "" };
}
/** The folders with what the backend adds in `folder_infos` (W13.10): parent, depth, label (modified UTF-7 decoded is not needed here), canNest, delimiter. */
function placed(rows: MockFolder[]) {
  const { delimiter, prefix } = mockFolderMeta();
  const customNames = new Set(rows.filter((f) => f.key.startsWith("f:")).map((f) => f.accountId + "|" + f.name));
  return rows.map((f) => {
    if (!f.key.startsWith("f:")) return { ...f, parent: null, depth: 0, label: f.name, canNest: false, delimiter };
    const rest = prefix && f.name.toLowerCase().startsWith(prefix.toLowerCase()) ? f.name.slice(prefix.length) : f.name;
    const parts = rest.split(delimiter);
    const depth = parts.length - 1;
    const pname = depth > 0 ? f.name.slice(0, f.name.length - parts[parts.length - 1].length - delimiter.length) : "";
    return { ...f, parent: pname && customNames.has(f.accountId + "|" + pname) ? "f:" + pname : null, depth, label: parts[parts.length - 1], canNest: depth === 0, delimiter };
  });
}

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

// `#persist`: the stored settings survive a reload (localStorage), so a "restart" can be tested in the preview (e.g. the order of the mailboxes)
const persistSettings = /(^|&)persist(&|$)/.test(window.location.hash.slice(1));
const settings: Record<string, string> = (() => {
  try {
    return persistSettings ? JSON.parse(localStorage.getItem("hl-mock-settings") ?? "{}") : {};
  } catch {
    return {};
  }
})();

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
  organizer: null, attendees: [], rrule: null, recurrenceText: null, status: "confirmed", myStatus: null, respondedAt: null, reminderMin: 15, sourceMessageId: null, sequence: 0, confidential: false, ...over,
});
const you = { email: "nam@example.com", name: "Nam Hoang", role: "required", status: "needs-action", isYou: true };
const people = (list: [string, string][]) => list.map(([name, status]) => ({ email: `${name.split(" ")[0].toLowerCase()}@contoso.com`, name, role: "required", status, isYou: false }));
// `#caltwins` adds invitations whose synced copies the service may have put in the synced calendar (W7.11, see calendar.rs SyncedTwins)
const calTwins = /(^|&)caltwins(&|$)/.test(window.location.hash.slice(1));
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
  // #caltwins (W7.11): invitations that the service may or may not have put in the synced calendar by itself (their synced copies come with the sync state, see syncedEvents)
  ...(calTwins
    ? [
        ev("tw1", "Planning twin", at(5, 9), at(5, 10), { uid: "twin-a2@mock", calendarId: "invites:a2", accountId: "a2", myStatus: "needs-action", sourceMessageId: "m-inv-req", organizer: { email: "mai@contoso.com", name: "Mai Khanh" } }),
        ev("tw2", "Budget twin", at(5, 11), at(5, 12), { uid: "twin-a4@mock", calendarId: "invites:a4", accountId: "a4", myStatus: "needs-action", sourceMessageId: "m-inv-req", organizer: { email: "mai@contoso.com", name: "Mai Khanh" } }),
        ev("tw3", "Offsite title twin", at(6, 9), at(6, 10), { uid: "title-twin@mock", calendarId: "invites:a4", accountId: "a4", myStatus: "needs-action", sourceMessageId: "m-inv-req", organizer: { email: "mai@contoso.com", name: "Mai Khanh" } }),
        ev("tw4", "Only by mail (Outlook)", at(6, 11), at(6, 12), { uid: "mail-only-a4@mock", calendarId: "invites:a4", accountId: "a4", myStatus: "needs-action", sourceMessageId: "m-inv-req", organizer: { email: "mai@contoso.com", name: "Mai Khanh" } }),
        ev("tw5", "Only by mail (Google)", at(7, 9), at(7, 10), { uid: "mail-only-a2@mock", calendarId: "invites:a2", accountId: "a2", myStatus: "needs-action", sourceMessageId: "m-inv-req", organizer: { email: "mai@contoso.com", name: "Mai Khanh" } }),
      ]
    : []),
  ev("e17", "Yesterday's 1:1", at(-1, 14), at(-1, 14, 30), {}),
];
const hiddenCals = new Set<string>();
// W7.11: a mailbox whose calendar source has a primary calendar with Sync on shows its invitations as part of that calendar (the backend's `fold_targets`)
const foldedInto = (calendarId: string): string | null => {
  const m = /^invites:(.+)$/.exec(calendarId);
  const prim = m ? calSrcs[m[1]]?.calendars.find((c) => c.primary && c.syncOn) : undefined;
  return prim ? String(prim.id) : null;
};
// ... and its twin rule: an invitation that is also in a visible synced calendar of the same mailbox shows once, the synced copy wins (same UID; Outlook: or the same title at the same time)
const hiddenByTwin = (e: MockEvent): boolean =>
  String(e.calendarId).startsWith("invites:") &&
  calEvents.some((f) => {
    const cal = String(f.calendarId);
    if (!f.remoteMock || f.accountId !== e.accountId || hiddenCals.has(cal) || f.status === "cancelled") return false;
    return f.uid === e.uid || (cal.startsWith("ms:") && !e.rrule && f.summary === e.summary && f.start === e.start);
  });
/** Moves waiting out their Undo time (token -> thread ids): like the backend, the lists and the unread numbers leave these conversations out until Undo (or a refusal) gives them back. */
const mockQueued = new Map<string, string[]>();
const queuedIds = () => new Set([...mockQueued.values()].flat());
/** Drafts saved in this page (save_draft), by thread. */
const mockDrafts: Record<string, typeof messages> = {};
/** The row each saved draft has in the Drafts list (with its importance), by thread. */
const mockDraftRows: Record<string, ReturnType<typeof t>> = {};
/** The branded signature of the mock (id s4): a table and a highlighted note, so it is easy to find (and count) in a saved draft. */
const SIG_S4_HTML = '<table style="border-collapse:collapse"><tr><td style="background:#0f6cbd;color:#ffffff;padding:6px 10px;font-weight:600">Hey Look!</td><td style="padding:6px 10px;color:#000000">Nam Hoang<br><span style="color:#444444">Product, <a href="https://example.com" style="color:#0b57d0">example.com</a></span></td></tr></table><p style="background:#fff3bf;color:#5c4400;padding:4px 8px;margin:6px 0 0">A highlighted note in the signature</p>';
let mockDraftSeq = 0;
/** The data of big pictures and files the page sent ahead of `save_draft` (`draft_upload`; draftupload.rs), until the save asks for it. */
const mockUploads = new Map<string, string>();
/** Crash recovery in the page (recover.rs): kept in localStorage, so reloading the page without discarding is the "crash" of a check. */
const RECOVERY_KEY = "hl-mock-recovery";
interface MockSnap { id: string; accountId: string; savedAt: number; subject: string; preview: string; payload: string; files: unknown[] }
const recoveryRead = (): Record<string, MockSnap> => { try { return JSON.parse(localStorage.getItem(RECOVERY_KEY) ?? "{}"); } catch { return {}; } };
const recoveryWrite = (m: Record<string, MockSnap>) => { try { localStorage.setItem(RECOVERY_KEY, JSON.stringify(m)); } catch { /* private window */ } };
/** `mid:` references of the drafts saved in this page, by the thread they are in. */
const mockDraftRefs: Record<string, string> = {};
/** Remove the draft a reference names: `m:<message id>`, `mid:<account>|<Message-ID>` or a conversation id. */
function dropMockDraft(ref: string) {
  const tid = ref.startsWith("m:a1:drafts:") ? ref.slice("m:a1:drafts:".length) : mockDraftRefs[ref] ?? ref;
  delete mockDrafts[tid];
  delete mockDraftRows[tid];
}
/** The version of a draft as it was opened, by the reference of the draft the last save made (W2.2: `discard_draft_changes` puts it back). */
/** Drafts that another program expunged on the server (`__mockExpungeDraft`), by the reference of the opened draft, with what Discard changes needs to put them back. */
const mockLost: Record<string, { thread: typeof messages; row: ReturnType<typeof t>; headers: { to: string[]; cc: string[]; bcc: string[]; inReplyTo?: string | null; references?: string[]; meeting?: string | null; answers?: unknown } }> = {};
const mockOriginals: Record<string, { thread: typeof messages; row: ReturnType<typeof t>; headers: { to: string[]; cc: string[]; bcc: string[]; inReplyTo?: string | null; references?: string[]; meeting?: string | null; answers?: unknown } }> = {};
/** To / Cc / Bcc as the saved draft's headers have them, by message id (`draft_recipients`). */
const mockDraftHeaders: Record<string, { to: string[]; cc: string[]; bcc: string[]; inReplyTo?: string | null; references?: string[]; meeting?: string | null; answers?: unknown }> = {};
const dayOf = (sec: number) => Math.floor(sec / 86400);
void dayOf;
/** The repeating events of the preview: expansion and the scopes of a change (src/devMockSeries.ts). */
const asRow = (e: MockEvent) => e as unknown as SeriesRow;
/** `window.__mockSeriesDelay` = ms: the writes of a series answer that late (the tests of the pending states). */
const seriesDelay = <T,>(v: T): T | Promise<T> => {
  const ms = Number((window as unknown as { __mockSeriesDelay?: number }).__mockSeriesDelay) || 0;
  return ms ? new Promise<T>((r) => setTimeout(() => r(v), ms)) : v;
};

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
  "m-inv-conf": inviteMsg("m-inv-conf", "Invitation: Board pack review — Highly Confidential", "Linh Tran", "linh@example.com", mkInvite({ summary: "Board pack review", rrule: null, recurrenceText: null, eventId: null, conflicts: [], joinUrl: null, tzid: sysTz, organizer: { email: "linh@example.com", name: "Linh Tran" } }), 1.1 * H, { confidential: true }),
  "m-inv-flaky": inviteMsg("m-inv-flaky", "Invitation: Server check (sending fails once)", "Linh Tran", "linh@example.com", mkInvite({ summary: "Server check", start: at(6, 11), end: at(6, 12), rrule: null, recurrenceText: null, eventId: "e21", conflicts: [], joinUrl: null, tzid: sysTz, attendees: people([["Linh Tran", "accepted"]]).concat([you as never]), organizer: { email: "linh@example.com", name: "Linh Tran" } }), 13 * H),
};
const threadInvite: Record<string, string[]> = {
  t15: ["m-inv-req"], t16: ["m-inv-cancel"], t17: ["m-inv-upd0", "m-inv-upd1"], t18: ["m-reply"], t19: ["m-publish"], t20: ["m-broken"],
  t21: ["m-inv-allday"], t22: ["m-inv-fwd"], t23: ["m-inv-old"], t24: ["m-inv-flaky"], t26: ["m-inv-big"], "tconf-inv": ["m-inv-conf"],
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
    return darkCheck((id) => st().select(id), ids ?? ["dk1", "dk2", "dk3", "dk4", "dk5", "dk7", "dk8", "dk9", "dk10", "dk11", "dk12", "nl1", "nl2"]);
  };
  (window as unknown as { __darkCheck: typeof runCheck }).__darkCheck = runCheck;
  // `await __failedSendCheck()`: types a message, sends it three times against a server that rejects it, and reports what Compose looks like each time it reopens
  (window as unknown as { __failedSendCheck: typeof failedSendCheck }).__failedSendCheck = () => failedSendCheck(wait);
  const tokens = window.location.hash.slice(1).split("&").filter(Boolean);
  for (const tok of tokens) {
    const [k, v = ""] = tok.split("=");
    const val = decodeURIComponent(v);
    if (k === "dark" || k === "light") st().setPrefs({ theme: k });
    else if (k === "lang") st().setPrefs({ language: val as LangPref }); // `lang=fr` / `lang=vi` / `lang=en-XA` (pseudo-locale)
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
    else if (k === "nudge") {
      // the support reminder: `nudge=now` shows the toast at once; `nudge=due` makes it due and the app 3 minutes old, then asks the real
      // calm-moment check (focus, open dialogs, other toasts ...); the check also runs every 30 s. `nudge=state` prints the stored schedule.
      const host = await import("./supportNudgeHost");
      if (val === "now") host.showSupportNudge();
      else if (val === "due") {
        st().setPrefs({ supportNudge: { ...st().prefs.supportNudge, enabled: true, nextDueAt: Date.now() - 1000 } });
        host.setSessionStartForTest(Date.now() - 3 * 60_000);
        host.checkSupportNudge();
      } else if (val === "state") console.info("[mock] supportNudge", JSON.stringify(st().prefs.supportNudge), JSON.stringify(host.currentMoment()));
    }
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

// ---- update check (`#update=<kind>`, `#openfail`): fixed answers, read from the URL hash on every call.
// Kinds: available, uptodate (default), newer, norelease, offline, ratelimited, error, noasset, slow, empty, long.
// The throttle, the timing rules (launch, window return, retry) and the stored state are Rust only: here every manual call answers, automatic calls answer `disabled` when the switch is off.
const hashTokens = () => new Map(window.location.hash.slice(1).split("&").filter(Boolean).map((t) => { const [k, v = ""] = t.split("="); return [k, decodeURIComponent(v)] as [string, string]; }));
const UPDATE_SAMPLE_NOTES = [
  "## Highlights", "- Faster search in large mailboxes", "* **Bold** item with `code`", "[a link](https://example.com)", "",
  "### Fixes", "| Area | Fix |", "|---|---|", "| Sync | Fewer retries |", "<img src=x onerror=alert(1)>", "x".repeat(200),
].join("\n");
const UPDATE_LONG_NOTES = (() => {
  const out: string[] = ["## Everything that changed"];
  for (let i = 1; out.join("\n").length < 4000; i++) out.push(`- Change ${i}: a longer line of release notes that explains one improvement in a few words`);
  return out.join("\n").slice(0, 4000);
})();
// REQ-47 state: how many checks were answered (not `disabled`), the first answer's offer, and `dl=changed`'s pending "GitHub has 1.2.0 now".
let mockChecks = 0;
let mockFirstOffer: unknown = null;
let mockChangedPending = false;
let mockChangedDone = false;
async function mockCheckUpdate(trigger: string, prefsJson?: string) {
  const entry = logUpdateCall({ trigger });
  const token = hashTokens().get("update") || "uptodate";
  const now = Math.floor(Date.now() / 1000);
  const base = { kind: "upToDate", current: "1.0.0", platform: { os: "windows", arch: "x64", installer: "nsis", label: "Windows" }, checkedAt: now, message: null as string | null, info: null as unknown, fromCache: false };
  const info = (over: Record<string, unknown> = {}) => ({
    latest: "1.1.0", notes: UPDATE_SAMPLE_NOTES, notesTruncated: false, publishedAt: Math.floor(new Date(2026, 9, 12, 10, 0).getTime() / 1000),
    releaseUrl: "https://github.com/thnonl/hey-look/releases/tag/v1.1.0",
    asset: { name: "HeyLook_1.1.0_windows_x64-setup.exe", url: "https://github.com/thnonl/hey-look/releases/download/v1.1.0/HeyLook_1.1.0_windows_x64-setup.exe", size: 10276044, urlOk: true },
    ...over,
  });
  const enabled = (() => { try { return JSON.parse(prefsJson ?? "{}").checkUpdates !== false; } catch { return true; } })();
  let r: typeof base;
  if (trigger !== "manual" && !enabled) r = { ...base, kind: "disabled" };
  else {
    if (token === "slow") await new Promise((res) => setTimeout(res, 5000));
    switch (token) {
      case "available": case "slow": r = { ...base, kind: "available", info: info() }; break;
      case "noasset": r = { ...base, kind: "available", info: info({ asset: null }) }; break;
      case "empty": r = { ...base, kind: "available", info: info({ notes: "", publishedAt: null }) }; break;
      case "long": r = { ...base, kind: "available", info: info({ notes: UPDATE_LONG_NOTES, notesTruncated: true }) }; break;
      case "newer": r = { ...base, current: "1.2.0", info: info() }; break;
      case "norelease": r = { ...base, kind: "noRelease" }; break;
      case "offline": r = { ...base, kind: "offline" }; break;
      case "error": r = { ...base, kind: "error", message: "GitHub sent an unexpected answer" }; break;
      // the check fails, but the cache holds the 1.1.0 offer (REQ-47)
      case "offlinecached": r = { ...base, kind: "offline", info: info(), fromCache: true, cachedKind: "available" } as typeof base; break;
      case "errorcached": r = { ...base, kind: "error", message: "GitHub sent an unexpected answer", info: info(), fromCache: true, cachedKind: "available" } as typeof base; break;
      default: r = { ...base, info: info({ latest: "1.0.0", asset: null }) };
    }
    // `recheck=offline|error`: the first answer is per `update=`, every later one fails and carries the first answer's offer;
    // `dl=changed`: the check after the refused download finds 1.2.0 (once, over `recheck=`)
    const recheck = hashTokens().get("recheck");
    const first = mockChecks++ === 0;
    if (mockChangedPending) {
      mockChangedPending = false;
      r = { ...base, kind: "available", info: info({ latest: "1.2.0", releaseUrl: "https://github.com/thnonl/hey-look/releases/tag/v1.2.0", asset: { name: "HeyLook_1.2.0_windows_x64-setup.exe", url: "https://github.com/thnonl/hey-look/releases/download/v1.2.0/HeyLook_1.2.0_windows_x64-setup.exe", size: 10276044, urlOk: true } }) };
      mockFirstOffer = r.info;
    } else if (first) mockFirstOffer = r.kind === "available" ? r.info : null;
    else if (recheck === "offline" || recheck === "error") {
      r = { ...base, kind: recheck, message: recheck === "error" ? "GitHub sent an unexpected answer" : null, info: mockFirstOffer, fromCache: !!mockFirstOffer, cachedKind: mockFirstOffer ? "available" : null } as typeof base;
    }
  }
  entry.kind = r.kind;
  return r;
}

// ---- the update flow (`#dl=<mode>`, `#sending`, `#draftfail`, `#afterupdate=ok|draft|fail`): a pretend download with the same events as Rust's channel.
// Modes: ok (default; 9.8 MB over 6 s), fast (ready after 0.3 s), nolength (no total), slow (60 s), stall (stops at 30 %, fails after 10 s), fail (fails at 40 %),
// verifyfail, badurl, installfail, offline (fails at once), changed (the first one: GitHub has 1.2.0 now). `update_install` never restarts: it shows a toast and logs the call.
type UpdateLogEntry = { trigger?: string; cmd?: string; restart?: boolean; draftSaved?: boolean; note?: string; at: number; kind: string | null };
function logUpdateCall(e: { trigger?: string; cmd?: string; restart?: boolean; draftSaved?: boolean; note?: string }): UpdateLogEntry {
  const w = window as unknown as { __updateCalls?: UpdateLogEntry[] };
  const entry: UpdateLogEntry = { ...e, at: Date.now(), kind: null };
  (w.__updateCalls ??= []).push(entry);
  return entry;
}
let dlCancelled = false;
let busyUntil = 0;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function mockDownload(ch: { onmessage: (e: unknown) => void }) {
  const entry = logUpdateCall({ cmd: "download" });
  const mode = hashTokens().get("dl") || "ok";
  const send = (e: unknown) => ch.onmessage(e);
  dlCancelled = false;
  if (mode === "badurl") {
    send({ event: "failed", data: { stage: "badurl", message: "" } });
    entry.kind = "failed";
    return;
  }
  if (mode === "offline") {
    send({ event: "failed", data: { stage: "download", message: "You seem to be offline." } });
    entry.kind = "failed";
    return;
  }
  // `dl=changed`: the first download finds that GitHub has 1.2.0 now and downloads nothing; later ones behave as `ok` (for 1.2.0)
  if (mode === "changed" && !mockChangedDone) {
    mockChangedDone = mockChangedPending = true;
    send({ event: "failed", data: { stage: "changed", message: "1.2.0" } });
    entry.kind = "changed";
    return;
  }
  const full = 10276044;
  const total = mode === "nolength" ? null : full;
  send({ event: "started", data: { total, version: mode === "changed" ? "1.2.0" : "1.1.0" } });
  const steps = mode === "slow" ? 600 : mode === "fast" ? 2 : 60;
  const tick = 100;
  for (let i = 1; i <= steps; i++) {
    await wait(tick);
    if (dlCancelled) {
      send({ event: "cancelled" });
      entry.kind = "cancelled";
      return;
    }
    const f = i / steps;
    if (mode === "stall" && f > 0.3) {
      await wait(10_000);
      send({ event: "failed", data: { stage: "download", message: "The download stopped. Check your connection." } });
      entry.kind = "failed";
      return;
    }
    if (mode === "fail" && f > 0.4) {
      send({ event: "failed", data: { stage: "download", message: "The connection was lost." } });
      entry.kind = "failed";
      return;
    }
    send({ event: "progress", data: { received: Math.round(full * f) } });
  }
  send({ event: "verifying" });
  await wait(mode === "fast" ? 50 : 1000);
  if (mode === "verifyfail") {
    send({ event: "failed", data: { stage: "verify", message: "signature mismatch" } });
    entry.kind = "failed";
    return;
  }
  send({ event: "ready" });
  entry.kind = "ready";
}
async function mockInstall(restart: boolean, draftSaved: boolean) {
  const entry = logUpdateCall({ cmd: "install", restart, draftSaved }); // `draftSaved`: the next start says "Your message is in Drafts" only when true
  if (hashTokens().get("dl") === "installfail") {
    entry.kind = "failed";
    throw "The installer couldn’t start";
  }
  entry.kind = "ok";
  const { useStore } = await import("./store");
  useStore.getState().showToast("Mock: Hey Look! would restart now.", undefined, "info");
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
/** Delays a check sets on `window.__mockDelays` to make a slow server: see reply_headers and attachment_data. */
interface MockDelays { replyHeaders?: number; replyHeadersFail?: boolean; quote?: number; quoteFirst?: number; /** get_thread (the read of a conversation) takes that long, W13.6 */ thread?: number; /** get_thread ends with an error (the database could not be read), W13.6 */ threadFail?: boolean; /** any other command takes that long (ms), by name: `{ outbox_hold: 800 }`, W13.14 */ cmds?: Record<string, number> }
const later = <T,>(ms: number, f: () => T) => new Promise<T>((res, rej) => setTimeout(() => { try { res(f()); } catch (e) { rej(e); } }, ms));
/** Conversations a "move" of a secondary window took away (dev preview of the reader window). */
const mockGone = new Set<string>();
const newThreads = (accountId: string) =>
  [["Welcome to your new mailbox", "Mail Team", "Your account is connected. Everything arrives here.", 0.2 * H, 1], ["Getting started", "Mail Team", "Three quick tips for your inbox.", 3 * H, 0], ["Your first newsletter", "Digest", "Nothing to read yet, but this is how it looks.", 20 * H, 0]]
    .map(([subject, who, snippet, ago, unread], i) => t(`${accountId}-t${i}`, subject as string, [who as string], snippet as string, ago as number, { accountId, unread }));

// ---- a big mailbox for the list: virtual scrolling, scroll-to-load-older, search -> Gmail. Hash switches (all optional):
//   #smallmailbox      the original handful of threads only
//   #big=3000          threads on the "server" in total (spread over three Gmail-ish mailboxes), default 3000
//   #local=360         threads per mailbox already downloaded when the app starts (the rest arrives 50 at a time via load_older), default 360
//   #failolder=3       the 3rd load_older call from now on rejects (shows the error toast); `__mockMail.failIn = n` does the same later
//   #backfill          simulates the background download of 500 Inbox messages (event backfill-progress) for the first mailbox (never beyond the "Max emails to download" cap)
//                      the cap (setting max_download, Settings > Reading & sync) also makes load_older answer { limited: true } once a mailbox holds that many messages
// `__mockMail` in the console: { calls (every load_older), opened (urls given to the browser), local, total, failIn }
let mockAiCalls = 0;
/** the job ids the page cancelled (ai_cancel): a dev check can read them from window.__mockAiCancelled */
const mockSecrets = new Map<string, string>(); // the AI key saved in Settings (the real one is in the OS credential store)
const mockAiCancelled: string[] = ((window as unknown as { __mockAiCancelled?: string[] }).__mockAiCancelled = []);
/** Every call about a scheduled message is logged for checks: window.__outboxCalls = [{ cmd, id }] */
const logOutbox = (cmd: string, a: Record<string, unknown>) => ((window as unknown as { __outboxCalls?: unknown[] }).__outboxCalls ??= []).push({ cmd, id: a.id });
const hashHas = (k: string) => new RegExp(`(^|&)${k}(=|&|$)`).test(window.location.hash.slice(1));
const hashNum = (k: string, d: number) => {
  const m = new RegExp(`(^|&)${k}=(\\d+)`).exec(window.location.hash.slice(1));
  return m ? Number(m[2]) : d;
};
// #longmail[=chars]: the last message of "Q4 roadmap review" is a long text (default 30000 characters: numbered paragraphs of numbered sentences),
// to try the translation in parts. #slowai=3000 makes every part take 3 s. #failpart=3[&failtimes=2]: part 3 answers a 503 the first 2 times it is asked
// (one automatic second try, then the error with Retry, which goes on from that part). window.__mockAiRequests lists every ai_complete call (id, part, chars).
if (hashHas("longmail")) {
  const want = hashNum("longmail", 30000);
  let text = "";
  for (let n = 1; text.length < want; n++) {
    const sentences = Array.from({ length: 5 }, (_, k) => `Sentence ${k + 1} of paragraph ${n} says that the milestone review needs a decision before Thursday.`).join(" ");
    text += `${text ? "\n\n" : ""}Paragraph ${n}. ${sentences}`;
  }
  const last = messages[2];
  last.text = text.slice(0, want);
  last.html = `<div style="font-family:sans-serif">${last.text.split("\n\n").map((x) => `<p>${x}</p>`).join("")}</div>`;
}
const mockAiRequests: { id: string; part: number; chars: number }[] = ((window as unknown as { __mockAiRequests?: unknown[] }).__mockAiRequests = []) as never;
const mockPartFails = new Map<number, number>();
type MockRow = ReturnType<typeof t>;
/** The "Max emails to download" cap as the backend reads it (setting `max_download`: default 2000, clamped to 100..5000). */
const mockCap = () => {
  const n = Number(settings.max_download);
  return settings.max_download?.trim() && Number.isFinite(n) ? Math.min(5000, Math.max(100, Math.trunc(n))) : 2000;
};
let mockServerRun = 0;
const mockMail = {
  calls: [] as { accountId: string; role: string; limit: number; at: number }[],
  opened: [] as string[],
  copied: [] as string[], // texts given to navigator.clipboard.writeText (the "Search in <webmail>" buttons)
  local: {} as Record<string, number>,
  total: {} as Record<string, number>,
  failIn: 0,
};
const serverMail: Record<string, MockRow[]> = {}; // per mailbox, newest first
function buildBigMailbox(total: number, local: number) {
  let seed = 20260124;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const people = ["Linh Tran", "Minh Pham", "Bao Tran", "Mai Khanh", "Duc Pham", "Alice Lin", "Eve Park", "Support", "Billing", "GitHub", "Product Hunt", "Lotusmiles", "Calendar", "HR", "Vendor Ops", "Dana Smith"];
  const topics = ["invoice", "roadmap", "contract", "offsite", "release notes", "statement", "reservation", "budget", "feedback", "interview", "newsletter", "receipt", "security alert", "standup", "photos", "tax", "travel"];
  const verbs = ["Re:", "Fwd:", "Update on", "Reminder:", "Question about", "Your", "New", "Weekly", "Action needed:", "Thanks for"];
  const share = [["a1", 0.45], ["a2", 0.35], ["a3", 0.2]] as const;
  for (const [id, f] of share) {
    const n = Math.round(total * f);
    const list: MockRow[] = [];
    let ago = 8 * H;
    for (let i = 0; i < n; i++) {
      ago += (0.2 + 1.6 * rnd()) * 13 * H;
      const topic = pick(topics);
      const who = pick(people);
      list.push(t(`g${id}-${i}`, `${pick(verbs)} ${topic} #${1000 + Math.floor(rnd() * 9000)}`, [who], `${who} wrote about the ${topic}. Details are in the message; please have a look when you have a minute (${i}).`, ago, {
        accountId: id, unread: rnd() < 0.12 ? 1 : 0, count: rnd() < 0.18 ? 2 + Math.floor(rnd() * 5) : 1, hasAttach: rnd() < 0.15, flagged: rnd() < 0.03, bulk: rnd() < 0.15,
      }));
    }
    serverMail[id] = list;
    mockMail.total[id] = n;
    mockMail.local[id] = Math.min(n, local);
  }
}
/** The mailbox as the app has it on disk right now (what list_threads reads). */
const localMail = (id: string) => (serverMail[id] ?? []).slice(0, mockMail.local[id] ?? 0);

// ---- calendar sync (Settings > mailbox > Calendar): a fake Google mailbox (a2: three calendars, one read only) and a fake Outlook mailbox
// (a4: two calendars and the read-only Birthdays calendar, whose colour is "auto" so the mailbox colour shows).
// `#calsync=<state>` starts the Google mailbox with sync on in that state, `#calsyncms=<state>` the Outlook one:
// ok | syncing | first | offline | busy | auth | blocked | notsetup | error | truncated.
// `__mockCalSync.state("auth")` in the console switches the Google state later, `__mockCalSync.state("blocked", "a4")` the Outlook one;
// `#calfail=denied|wrong|partial|timeout|blocked` makes the next consent fail; `#calslow` keeps the consent open until Cancel.
// Titles with [conflict] / [offline] / [gone] in a synced calendar fail like the service would.
// `#calkinds=none|google|microsoft` sets what `calendar_kinds_available` answers (a build without the OAuth client of a service); `window.__mockCalConnects` lists the
// `calendar_connect` calls (the confirm before the browser opens must keep the list empty until Open browser); `window.__mockCalCancels` counts the `calendar_cancel_connect` calls.
// `__mockCalSync.connectResult = "ok" | "DENIED" | "TIMEOUT" | "WRONG_ACCOUNT" | "PARTIAL" | "BLOCKED" | "ERROR" | "NOT_SET_UP" | "hang"` decides how the next consents end (Add account > Google /
// Microsoft with "Also sync my calendar" and Settings > Calendar alike), `__mockCalSync.connectDelay` how long they wait first.
// `#unverified` adds four mails whose sender check failed (an update, a cancellation and an answer with a held change, and a new invitation: threads t30 to t33, subjects ending "(sender check failed)", the newest four rows of the first mailbox's Inbox; the hash is read when the page loads, so change it with a reload, not in the address bar alone); `#rdate` adds
// a series of My events that only has extra dates (RDATE).
type MockDav = { label: string; username: string; host: string; preset: string; scheduling: boolean };
type MockSrc = { id: string; accountId: string; kind: string; status: string; lastSync: number | null; lastError: string | null; retryAt: number | null; firstSync: boolean; calendars: Record<string, unknown>[]; dav?: MockDav };
type MockCalAccount = { account: string; kind: "google" | "microsoft" | "caldav"; prefix: string; email: string; service: string; dav?: MockDav };
const MOCK_CAL_ACCOUNTS: MockCalAccount[] = [
  { account: "a2", kind: "google", prefix: "google", email: "nam@gmail.com", service: "Google Calendar" },
  { account: "a4", kind: "microsoft", prefix: "ms", email: "nam@outlook.com", service: "Outlook" },
];
// `#calsyncdav=<state>` starts the custom-domain mailbox (a5) connected to a CalDAV server (a Nextcloud at cloud.example.org) in that state (the states of `#calsync=`; "auth" asks for the password again);
// `#calkinds=` (none | google | microsoft | caldav) narrows what `calendar_kinds_available` offers (CalDAV is in every build since W7.5). The connect dialog's answers follow its values: a password "wrong" is refused,
// an address containing "nowhere" has no server, "plain" is no CalDAV server, "empty" has no calendars, "redirect" sends the client elsewhere, "selfsigned" has an untrusted certificate (unless it is trusted),
// "slow" waits 3 s. `window.__mockDavConnects` lists the connect calls (their values, the password too, for the test), `window.__mockDavPasswords` the "enter password again" calls.
// `#davsched` makes the CalDAV server send invitations itself (else the app sends them: the dialog line says which). `__mockCalSync.colors` lists the colours chosen in Settings (`calendar_set_color`), `window.__mockMoves` the
// `calendar_move_event` calls, `window.__mockCreates` the `calendar_create_calendar` calls (a name containing "[needsaccess]" or "[fail]" ends in the error of that name); `__mockCalSync.moveDelay` / `createDelay` (ms) keep them pending.
// a mailbox added in the preview (Add account > Google / Microsoft) joins the list when its calendar is connected, so the step after the sign-in has a mailbox to sync
const extraCalAccounts: MockCalAccount[] = [];
const calAccounts = () => [...MOCK_CAL_ACCOUNTS, ...extraCalAccounts];
const mockCalAccount = (id: string) => {
  const known = calAccounts().find((m) => m.account === id);
  if (known) return known;
  const acc = accounts.find((x) => x.id === id);
  if (acc && (acc.auth === "oauth_google" || acc.auth === "oauth_microsoft")) {
    const g = acc.auth === "oauth_google";
    extraCalAccounts.push({ account: acc.id, kind: g ? "google" : "microsoft", prefix: g ? "google" : "ms", email: acc.email, service: g ? "Google Calendar" : "Outlook" });
    return extraCalAccounts[extraCalAccounts.length - 1];
  }
  return MOCK_CAL_ACCOUNTS[0];
};
const davOf = (service: string, url: string, username: string): MockDav => {
  const host = url.replace(/^https?:\/\//, "").replace(/[\/:].*$/, "");
  const label = service === "icloud" ? "iCloud" : service === "fastmail" ? "Fastmail" : service === "nextcloud" ? "Nextcloud" : host;
  return { label, username, host: service === "icloud" ? "caldav.icloud.com" : service === "fastmail" ? "caldav.fastmail.com" : host, preset: service, scheduling: calDavScheduling() };
};
/** The colours the person chose for synced calendars (Settings > Calendar), by calendar id. */
const calColors: Record<string, string> = {};
const calDavScheduling = () => /(^|&)davsched(&|$)/.test(window.location.hash.slice(1));
const mockCalOfId = (calendarId: string) => calAccounts().find((m) => calendarId.startsWith(`${m.prefix}:${m.account}:`));
const mockCalsOf = (m: MockCalAccount) =>
  m.kind === "caldav"
    ? [
        { id: `caldav:${m.account}:personal`, name: "Personal", color: "#0082c9", readOnly: false, primary: false, syncOn: true, eventCount: 2, truncated: false },
        { id: `caldav:${m.account}:work`, name: "Work", color: "#e9322d", readOnly: false, primary: false, syncOn: true, eventCount: 1, truncated: false },
        { id: `caldav:${m.account}:shared`, name: "Team (shared)", color: "", readOnly: true, primary: false, syncOn: true, eventCount: 1, truncated: false },
      ]
    : m.kind === "google"
    ? [
        { id: `google:${m.account}:primary`, name: "Nam", color: "#039be5", readOnly: false, primary: true, syncOn: true, eventCount: 3, truncated: false },
        { id: `google:${m.account}:work`, name: "Work", color: "#d50000", readOnly: false, primary: false, syncOn: true, eventCount: 2, truncated: false },
        { id: `google:${m.account}:holidays`, name: "Holidays in Vietnam", color: "#0b8043", readOnly: true, primary: false, syncOn: true, eventCount: 1, truncated: false },
      ]
    : [
        { id: `ms:${m.account}:primary`, name: "Calendar", color: "#0078d4", readOnly: false, primary: true, syncOn: true, eventCount: 3, truncated: false },
        { id: `ms:${m.account}:family`, name: "Family", color: "#c239b3", readOnly: false, primary: false, syncOn: true, eventCount: 1, truncated: false },
        { id: `ms:${m.account}:birthdays`, name: "Birthdays", color: "", readOnly: true, primary: false, syncOn: true, eventCount: 1, truncated: false },
      ];
const calSrcs: Record<string, MockSrc | null> = {};
let calConnectCancel: (() => void) | null = null;
// ---- mail sign-in (Add account > Google / Microsoft, and "Sign in again")
// `#signin=slow` keeps the browser sign-in waiting until Cancel; `#signin=timeout|denied|blocked|error` ends it that way after 1.5 s.
// `#reauth=again|blocked` starts the Google mailbox (a2) as one whose sign-in was rejected, `#reauthms=again|blocked` the Outlook one (a4):
// their sync fails like the backend does until "Sign in again" works. `__mockSignIn.flag("a2", "again")` does it later (and emits signin-state).
let oauthCancel: (() => void) | null = null;
const reauthNeeded: Record<string, string> = {};
const signinMode = () => /(^|&)signin=([a-z]+)/.exec(window.location.hash.slice(1))?.[2];
const reauthError = (acc: string) => {
  const label = acc === "a4" ? "Microsoft" : "Google";
  return reauthNeeded[acc] === "blocked"
    ? `OAUTH_BLOCKED|label=${label}: Your organization may need to approve Hey Look! for this ${label} account. Ask your IT admin. (AADSTS65001)`
    : `OAUTH_REAUTH|label=${label}: ${label} sign-in expired or revoked (invalid_grant). Sign in again.`;
};
/** The browser sign-in of the mock: ends the way the hash says; Cancel ends it at once. */
const mockBrowserSignIn = <T,>(label: string, done: () => T) =>
  new Promise<T>((resolve, reject) => {
    oauthCancel = () => reject(`OAUTH_CANCELLED|label=${label}: ${label} sign-in cancelled`);
    const mode = signinMode();
    if (mode === "slow") return;
    setTimeout(() => {
      const errs: Record<string, string> = {
        timeout: `OAUTH_TIMEOUT|label=${label}: ${label} sign-in timed out`,
        denied: `OAUTH_REFUSED|label=${label}|reason=access_denied: ${label} sign-in refused: access_denied`,
        blocked: `OAUTH_REFUSED|label=${label}|reason=access_denied - AADSTS65001%3A The user or administrator has not consented: ${label} sign-in refused: access_denied AADSTS65001`,
        error: `OAUTH_REFUSED|label=${label}|reason=redirect_uri_mismatch: ${label} sign-in refused: redirect_uri_mismatch`,
      };
      if (mode && errs[mode]) return reject(errs[mode]);
      resolve(done());
    }, 1500);
  });
const syncedEvents = (m: MockCalAccount): MockEvent[] => {
  const mk = (id: string, cal: string, summary: string, start: number, end: number, over: Record<string, unknown> = {}) =>
    ev(id, summary, start, end, { calendarId: `${m.prefix}:${m.account}:${cal}`, accountId: m.account, remoteMock: true, readOnly: null, reminderMin: 10, ...over });
  if (m.kind === "caldav") {
    return [
      mk("d1", "personal", "Climbing (CalDAV)", at(1, 18), at(1, 19, 30), { location: "Gym" }),
      mk("d2", "personal", "Plumber", at(4, 9), at(4, 10)),
      mk("d3", "work", "Quarterly planning", at(2, 10), at(2, 11)),
      mk("d4", "shared", "Team offsite", utcDay(8), utcDay(9), { allDay: true, tzid: null, readOnly: "calendar", reminderMin: null }),
    ];
  }
  if (m.kind === "microsoft") {
    return [
      mk("m1", "primary", "Standup (Outlook)", at(1, 9), at(1, 9, 15), { joinUrl: "https://teams.microsoft.com/l/meetup-join/xyz" }),
      // the calendar view lists each occurrence of a series as its own read-only row
      mk("m2", "primary", "Weekly review", at(2, 15), at(2, 16), { readOnly: "repeating" }),
      mk("m3", "primary", "Weekly review", at(9, 15), at(9, 16), { readOnly: "repeating" }),
      mk("m4", "family", "Family dinner", at(3, 18, 30), at(3, 20), { location: "Home" }),
      mk("m5", "birthdays", "Linh’s birthday", utcDay(6), utcDay(7), { allDay: true, tzid: null, readOnly: "calendar", reminderMin: null }),
      // (the backend decodes Outlook's hex ID of a meeting from another service to the invitation's UID: the copy arrives with that uid; the second one only matches by title and start)
      ...(calTwins ? [mk("m6", "primary", "Budget twin", at(5, 11), at(5, 12), { uid: "twin-a4@mock" }), mk("m7", "primary", "Offsite title twin", at(6, 9), at(6, 10), { uid: "uid-from-another-id" })] : []),
    ];
  }
  return [
    mk("g1", "primary", "Coffee with Minh", at(1, 8, 30), at(1, 9, 15), { location: "Cong Caphe" }),
    mk("g2", "primary", "Dentist (Google)", at(3, 16), at(3, 17)),
    mk("g3", "primary", "Weekly planning", at(0, 11), at(0, 11, 45), { rrule: "FREQ=WEEKLY;BYDAY=MO,WE", recurrenceText: "Every Monday and Wednesday", readOnly: "repeating", joinUrl: "https://meet.google.com/abc-defg-hij" }),
    mk("g4", "work", "Design crit", at(2, 14), at(2, 15), { organizer: { email: "mai@contoso.com", name: "Mai Khanh" }, readOnly: "organizer", attendees: people([["Mai Khanh", "accepted"]]).concat([{ ...you, email: "nam@gmail.com" } as never]) }),
    mk("g5", "work", "Sprint review", at(4, 10), at(4, 11), { myStatus: "organizer", organizer: { email: "nam@gmail.com", name: "Nam" } }),
    mk("g6", "holidays", "Reunification Day", utcDay(9), utcDay(10), { allDay: true, tzid: null, readOnly: "calendar", reminderMin: null }),
    ...(calTwins ? [mk("g7", "primary", "Planning twin", at(5, 9), at(5, 10), { uid: "twin-a2@mock" })] : []),
  ];
};
function mockCalState(state: string, accountId = "a2") {
  const m = mockCalAccount(accountId);
  const cals = mockCalsOf(m);
  if (state === "off") {
    calEvents = calEvents.filter((e) => !(e.remoteMock && e.accountId === m.account));
    calSrcs[m.account] = null;
    return;
  }
  if (!calSrcs[m.account]) calEvents = [...calEvents.filter((e) => !(e.remoteMock && e.accountId === m.account)), ...syncedEvents(m)];
  const base = { id: `${m.account}:${m.kind}`, accountId: m.account, kind: m.kind, lastSync: Math.floor(Date.now() / 1000) - 180, lastError: null, retryAt: null, firstSync: false, ...(m.dav ? { dav: m.dav } : {}) };
  const t = Math.floor(Date.now() / 1000);
  const by: Record<string, Partial<MockSrc>> = {
    ok: { status: "ok" },
    syncing: { status: "syncing" },
    first: { status: "syncing", firstSync: true, lastSync: null },
    offline: { status: "offline", retryAt: t + 60 },
    busy: { status: "busy", retryAt: t + 3 * 60 },
    auth: { status: "auth" },
    blocked: { status: "blocked", lastError: m.kind !== "microsoft" ? "admin_policy_enforced" : "AADSTS65001: The user or administrator has not consented to use the application" },
    notsetup: { status: "notsetup", lastError: m.kind === "google" ? "Google Calendar API has not been used in project 123456 before or it is disabled" : "The mailbox is either inactive, soft-deleted, or is hosted on-premise." },
    error: { status: "error", lastError: "HTTP 500: backend error", retryAt: t + 4 * 60 },
    truncated: { status: "ok" },
  };
  calSrcs[m.account] = { ...base, status: "ok", ...(by[state] ?? by.ok), calendars: state === "truncated" ? cals.map((c, i) => (i === 1 ? { ...c, truncated: true, eventCount: 25000 } : c)) : cals } as MockSrc;
}
const mockCalendars = () =>
  calAccounts().flatMap((m) =>
    (calSrcs[m.account]?.calendars ?? [])
      .filter((c) => c.syncOn)
      .map((c) => ({ id: c.id, name: `${c.name} · ${m.email}`, color: calColors[String(c.id)] ?? c.color, accountId: m.account, visible: !hiddenCals.has(String(c.id)), remote: true, writable: !c.readOnly, service: m.service, appInvites: m.kind === "caldav" && !m.dav?.scheduling, movesGuests: m.kind === "google" || (m.kind === "caldav" && !m.dav?.scheduling) })),
  );

export function installMock() {
  const frame = simulateWindowFrame();
  void import("./store").then(({ useStore }) => ((window as unknown as { __store: typeof useStore }).__store = useStore)); // dev preview: lets a script drive the app (language, dialogs, views) without reloading
  if (/(^|&)noaccounts(&|$)/.test(window.location.hash.slice(1))) {
    accounts.length = 0; // first-run: the Welcome screen
    folders.length = 0;
  }
  for (const [param, id] of [["reauth", "a2"], ["reauthms", "a4"]] as const) {
    const m = new RegExp(`(^|&)${param}=([a-z]+)`).exec(window.location.hash.slice(1))?.[2];
    if (m) reauthNeeded[id] = m;
  }
  (window as unknown as { __mockSignIn: unknown }).__mockSignIn = {
    flag: (id: string, kind: string | null) => {
      if (kind) reauthNeeded[id] = kind;
      else delete reauthNeeded[id];
      void emit("signin-state", { accountId: id, state: kind, error: kind ? reauthError(id) : undefined });
    },
  };
  // dev check of the calendar views: `__mockAddEvent("id", "Title", startSec, endSec, { calendarId, allDay, readOnly, ... })` adds an event (to My events unless told otherwise)
  (window as unknown as { __mockAddEvent: unknown }).__mockAddEvent = (id: string, summary: string, start: number, end: number, over: Record<string, unknown> = {}) => {
    calEvents = [...calEvents.filter((e) => e.id !== id), ev(id, summary, start, end, over)];
    void emit("calendar-changed", {});
  };
  (window as unknown as { __mockCalSync: unknown }).__mockCalSync = {
    state: (st: string, account = "a2") => { mockCalState(st, account); void emit("calendar-changed", {}); },
    get: (account = "a2") => calSrcs[account] ?? null,
    // how the next `calendar_connect` ends: "ok" (the default), a code of the backend ("DENIED", "TIMEOUT", "WRONG_ACCOUNT", "PARTIAL", "BLOCKED", "ERROR", "NOT_SET_UP"; with or
    // without "CAL_") or "hang" (waits for calendar_cancel_connect). It stays set until it is changed. Without it the hash decides (#calfail=, #calslow).
    connectResult: "" as string,
    // how long an explicit `connectResult` waits before it ends, in ms (400 by default; a test that looks at the waiting card raises it)
    connectDelay: 0 as number,
  };
  if (accounts.length && !hashHas("smallmailbox")) {
    // a second Gmail mailbox (password login on imap.gmail.com) next to the Google one: the search footer then names the address
    accounts.push({ id: "a3", email: "nam.work@gmail.com", displayName: "Nam Work", imapHost: "imap.gmail.com", imapPort: 993, imapSsl: true, smtpHost: "smtp.gmail.com", smtpPort: 465, smtpSecurity: "ssl", username: "nam.work@gmail.com", smtpUsername: "", tlsInsecure: false, auth: "password", color: "#2e7d32" });
    // an Outlook.com mailbox (Microsoft sign-in) and one on a custom domain and server: the first gets "Search in Outlook", the second no button
    accounts.push({ id: "a4", email: "nam@outlook.com", displayName: "Nam Outlook", imapHost: "outlook.office365.com", imapPort: 993, imapSsl: true, smtpHost: "smtp.office365.com", smtpPort: 587, smtpSecurity: "starttls", username: "nam@outlook.com", smtpUsername: "", tlsInsecure: false, auth: "oauth_microsoft", color: "#7b3fe4" });
    accounts.push({ id: "a5", email: "nam@pro66.emailserver.vn", displayName: "Nam Pro66", imapHost: "pro66.emailserver.vn", imapPort: 993, imapSsl: true, smtpHost: "pro66.emailserver.vn", smtpPort: 465, smtpSecurity: "ssl", username: "nam@pro66.emailserver.vn", smtpUsername: "", tlsInsecure: false, auth: "password", color: "#b45309" });
    for (const id of ["a4", "a5"]) for (const [i, k] of ["inbox", "drafts", "sent", "archive", "junk", "trash"].entries()) folders.push({ accountId: id, key: k, name: k, unread: 0, total: 10 + i });
    // what the "Search in <webmail>" buttons copy is recorded (and still copied when the browser allows it)
    const clip = navigator.clipboard;
    const realWrite = clip?.writeText?.bind(clip);
    if (clip) clip.writeText = async (text: string) => { mockMail.copied.push(text); try { await realWrite?.(text); } catch { /* no permission in this browser: the record is what counts */ } };
    for (const [i, k] of ["inbox", "drafts", "sent", "archive", "junk", "trash"].entries()) folders.push({ accountId: "a3", key: k, name: k, unread: k === "inbox" ? 2 : 0, total: 10 + i });
    buildBigMailbox(hashNum("big", 3000), hashNum("local", 360));
    const calsyncMs = /(^|&)calsyncms=([a-z]+)/.exec(window.location.hash.slice(1))?.[2];
    if (calsyncMs) mockCalState(calsyncMs, "a4");
    const calsyncDav = /(^|&)calsyncdav=([a-z]+)/.exec(window.location.hash.slice(1))?.[2];
    if (calsyncDav) {
      extraCalAccounts.push({ account: "a5", kind: "caldav", prefix: "caldav", email: "nam@pro66.emailserver.vn", service: "Nextcloud", dav: davOf("nextcloud", "https://cloud.example.org", "nam") });
      mockCalState(calsyncDav, "a5");
    }
    const failAt = hashNum("failolder", 0);
    if (failAt) mockMail.failIn = failAt;
    (window as unknown as { __mockMail: typeof mockMail }).__mockMail = mockMail;
    // dev check of the quote block (a reply / forward of any original): `__mockAddThread("q1", "Subject", { html, text, fromName, fromEmail, attachments })` adds a conversation with that one message to the first Inbox
    (window as unknown as { __mockAddThread: unknown }).__mockAddThread = (id: string, subject: string, over: Record<string, unknown> = {}) => {
      threads.unshift(t(id, subject, [String(over.fromName ?? "Sender")], "", 0.1 * H, (over.row as Record<string, unknown> | undefined) ?? {})); // (`over.row`: more of the list row, e.g. { bulk: true, accountId: "a2", unread: 1 })
      mockThreadMsgs[id] = [secMsg(`m-${id}`, subject, String(over.fromName ?? "Sender"), String(over.fromEmail ?? "sender@example.org"), over, (over.html as string | null | undefined) ?? null)];
    };
    if (hashHas("backfill")) {
      // the background download: 50 more Inbox messages of the first mailbox every 450 ms, up to 1000 (or what the server has)
      void (async () => {
        await new Promise((r) => setTimeout(r, 2500));
        const target = Math.min(500, mockMail.total.a1, mockCap());
        while (mockMail.local.a1 < target) {
          mockMail.local.a1 = Math.min(target, mockMail.local.a1 + 50);
          await emit("backfill-progress", { accountId: "a1", role: "inbox", have: mockMail.local.a1, target, done: mockMail.local.a1 >= target });
          await new Promise((r) => setTimeout(r, 450));
        }
      })();
    }
  }
  const calsync = /(^|&)calsync=([a-z]+)/.exec(window.location.hash.slice(1))?.[2];
  if (calsync && accounts.some((x) => x.id === "a2")) mockCalState(calsync, "a2");
  if (hashHas("rdate")) calEvents.push(ev("e-rdate", "Reading group", at(1, 16), at(1, 17), { hasRdates: true }));
  if (hashHas("unverified")) {
    // mails whose sender check failed (W7.3): the card says so; a held change can be applied by hand
    const bad = { unverified: true };
    const mk = (id: string, tid: string, subject: string, from: [string, string], inv: Record<string, unknown>, ago: number, extra: Record<string, unknown> = {}) => {
      inviteMsgs[id] = inviteMsg(id, subject, from[0], from[1], mkInvite({ ...bad, rrule: null, recurrenceText: null, conflicts: [], joinUrl: null, tzid: sysTz, ...inv }), ago, extra);
      threadInvite[tid] = [id];
      threads.push(t(tid, subject, [from[0]], "The sender check failed", ago, { invite: "request" }));
    };
    mk("m-unv-upd", "t30", "Updated invitation: Kick-off (sender check failed)", ["Mai Khanh", "mai@contoso.com"], { summary: "Kick-off", sequence: 1, start: at(4, 14), end: at(4, 15), eventId: "e20", held: true }, 0.02 * H);
    mk("m-unv-cancel", "t31", "Canceled: Vendor demo (sender check failed)", ["Vendor Ops", "ops@vendor.com"], { method: "CANCEL", summary: "Vendor demo", cancelled: false, start: at(3, 11), end: at(3, 12), eventId: "e7", held: true, organizer: { email: "ops@vendor.com", name: "Vendor Ops" }, attendees: [], you: { email: "nam@example.com", status: "needs-action", onList: true } }, 0.03 * H, { html: null, text: null });
    mk("m-unv-reply", "t32", "Accepted: 1:1 with Bao (sender check failed)", ["Bao Tran", "bao@contoso.com"], { method: "REPLY", summary: "1:1 with Bao", start: at(-1, 14), end: at(-1, 14, 30), eventId: "e3", held: true, location: null, you: null, reply: { from: { email: "bao@contoso.com", name: "Bao Tran" }, status: "accepted", comment: null }, attendees: [{ ...you, role: "chair", status: "accepted" }, ...people([["Bao Tran", "needs-action"]])] }, 0.04 * H, { html: null, text: null, attachments: [] });
    mk("m-unv-new", "t33", "Invitation: Budget review (sender check failed)", ["Mai Khanh", "mai@contoso.com"], { summary: "Budget review", start: at(5, 10), end: at(5, 11), eventId: null, held: false }, 0.05 * H);
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
    ok(pickAccountColor([ACCOUNT_PALETTE[0], "#123456", null]) === ACCOUNT_PALETTE[1], "far custom ignored, next unused");
    ok(pickAccountColor([null]) === ACCOUNT_PALETTE[1], "no stored color = primary = first palette color");
    ok(pickAccountColor(["#0e7c86", ACCOUNT_PALETTE[0], ACCOUNT_PALETTE[1], ACCOUNT_PALETTE[2], ACCOUNT_PALETTE[3], ACCOUNT_PALETTE[4]]) === ACCOUNT_PALETTE[6], "look-alike of palette[5] counts as taken");
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
  // `__webmailCheck()`: dev self-check of the app-query -> Gmail / webmail query conversion, the Gmail URL and which accounts get a "Search in <webmail>" button
  (window as unknown as { __webmailCheck: () => string[] }).__webmailCheck = () => {
    const out: string[] = [], ok = (c: boolean, m: string) => out.push((c ? "ok   " : "FAIL ") + m);
    const eq = (q: string, want: string, folder?: string) => {
      const got = toGmailQuery(q, folder);
      ok(got === want, `${JSON.stringify(q)}${folder ? ` in ${folder}` : ""} -> ${JSON.stringify(got)}${got === want ? "" : ` (wanted ${JSON.stringify(want)})`}`);
    };
    eq("invoice", "invoice");
    eq("from:linh subject:roadmap review", "from:linh subject:roadmap review");
    eq('from:"Linh Tran" subject:"q4 plan"', 'from:"Linh Tran" subject:"q4 plan"');
    eq("to:a@b.c cc:d@e.f", "to:a@b.c cc:d@e.f");
    eq("is:unread is:read is:starred is:flagged is:pinned", "is:unread is:read is:starred is:starred");
    eq("has:attachment has:att has:yes has:no", 'has:attachment has:attachment has:attachment "has:no"');
    eq("after:2026-01-31 before:2026-02-15", "after:2026/01/31 before:2026/02/15");
    eq("since:7d until:30d", "newer_than:7d older_than:30d");
    eq("after:yesterday before:2026-13", "");
    eq('body:budget body:"q4 plan" report', 'budget "q4 plan" report');
    eq("folder:sent report", "in:sent report");
    eq("in:spam in:bin in:drafts in:inbox", "in:spam in:trash in:drafts in:inbox");
    eq("in:archive x", "x");
    eq("folder:all x", "x");
    eq("folder:Projects/Hey x", "label:Projects/Hey x");
    eq("report", "report in:sent", "sent");
    eq("report", "report in:spam", "junk");
    eq("report", "report in:inbox", "unread");
    eq("report", "report label:Projects/Hey-Look", "f:Projects/Hey Look");
    eq("report", "report", "all");
    eq("report in:trash", "report in:trash", "inbox");
    eq("is:pinned", "", "inbox");
    eq("http://x.y", '"http://x.y"');
    eq("from: odd:", '"from:" "odd:"');
    ok(gmailSearchUrl("nam@gmail.com", "from:linh is:unread") === "https://mail.google.com/mail/?authuser=nam%40gmail.com#search/from%3Alinh%20is%3Aunread", "url: authuser + encoded search hash");
    ok(gmailSearchUrl("a+b@gmail.com", "x y") === "https://mail.google.com/mail/?authuser=a%2Bb%40gmail.com#search/x%20y", "url: + in the address is encoded");
    // which webmail an account has: server first, then sign-in provider, then address domain; unknown = none
    const wm = (email: string, imapHost: string, auth: "password" | "oauth_google" | "oauth_microsoft" = "password") => webmailOf({ email, imapHost, auth })?.id ?? null;
    const who = (want: WebmailId | null, got: WebmailId | null, m: string) => ok(want === got, `webmail of ${m}: ${got} (wanted ${want})`);
    who("gmail", wm("a@gmail.com", "imap.gmail.com"), "imap.gmail.com");
    who("gmail", wm("a@gmail.com", "x", "oauth_google"), "Google sign-in");
    who("gmail", wm("a@acme.io", "imap.gmail.com"), "Workspace address on imap.gmail.com");
    who("gmail", wm("a@googlemail.com", "mail.example.org"), "googlemail.com domain");
    who("outlook", wm("a@hotmail.com", "imap-mail.outlook.com"), "imap-mail.outlook.com");
    who("outlook", wm("a@outlook.com", "outlook.office365.com", "oauth_microsoft"), "Microsoft sign-in, outlook.com address");
    who("outlook", wm("a@live.nl", "outlook.office365.com", "oauth_microsoft"), "Microsoft sign-in, live.nl address");
    who("outlook", wm("a@msn.com", "outlook.office365.com"), "password login on outlook.office365.com, msn.com address");
    who("m365", wm("a@contoso.com", "outlook.office365.com", "oauth_microsoft"), "Microsoft sign-in, company address");
    who("m365", wm("a@contoso.com", "outlook.office365.com"), "outlook.office365.com, company address");
    who("yahoo", wm("a@yahoo.com", "imap.mail.yahoo.com"), "imap.mail.yahoo.com");
    who("yahoo", wm("a@ymail.com", "mail.example.org"), "ymail.com domain");
    who("yahoo", wm("a@yahoo.co.uk", "mail.example.org"), "yahoo.co.uk domain");
    who("icloud", wm("a@icloud.com", "imap.mail.me.com"), "imap.mail.me.com");
    who("icloud", wm("a@mac.com", "mail.example.org"), "mac.com domain");
    who("fastmail", wm("a@fastmail.com", "imap.fastmail.com"), "imap.fastmail.com");
    who("fastmail", wm("a@fastmail.fm", "mail.example.org"), "fastmail.fm domain");
    who("zoho", wm("a@zoho.com", "imap.zoho.com"), "imap.zoho.com");
    who("zoho", wm("a@acme.io", "imap.zoho.eu"), "imap.zoho.eu");
    who("zoho", wm("a@zohomail.in", "mail.example.org"), "zohomail.in domain");
    who(null, wm("nam@pro66.emailserver.vn", "pro66.emailserver.vn"), "custom domain and server");
    who(null, wm("a@proton.me", "127.0.0.1"), "Proton Bridge");
    // the query other webmails get: the words stay, only what the provider is known to understand is kept
    const web = (id: WebmailId, q: string, want: string) => {
      const got = toWebmailQuery(id, q);
      ok(got === want, `${id}: ${JSON.stringify(q)} -> ${JSON.stringify(got)}${got === want ? "" : ` (wanted ${JSON.stringify(want)})`}`);
    };
    const full = 'invoice from:linh to:a@b.c cc:d@e.f subject:"q4 plan" has:attachment after:2026-01-31 before:2026-02-15 since:7d is:unread is:pinned folder:sent body:budget';
    web("gmail", full, 'invoice from:linh to:a@b.c cc:d@e.f subject:"q4 plan" has:attachment after:2026/01/31 before:2026/02/15 newer_than:7d is:unread in:sent budget');
    web("fastmail", full, 'invoice from:linh to:a@b.c to:d@e.f subject:"q4 plan" has:attachment after:2026-01-31 before:2026-02-15 budget');
    web("yahoo", full, 'invoice from:linh to:a@b.c to:d@e.f subject:"q4 plan" has:attachment after:2026-01-31 before:2026-02-15 budget');
    web("outlook", full, 'invoice from:linh to:a@b.c cc:d@e.f subject:"q4 plan" hasattachment:yes budget');
    web("m365", full, 'invoice from:linh to:a@b.c cc:d@e.f subject:"q4 plan" hasattachment:yes budget');
    web("icloud", full, 'invoice linh a@b.c d@e.f "q4 plan" budget');
    web("zoho", full, 'invoice linh a@b.c d@e.f "q4 plan" budget');
    web("yahoo", "is:pinned folder:inbox", "");
    web("outlook", "report http://x.y has:no", 'report "http://x.y" "has:no"');
    web("fastmail", "after:yesterday before:2026-13-01 until:2026-03-01", "before:2026-03-01");
    // which accounts get a button: selected mailbox, or every mailbox with scope 'all' / none selected; unknown webmails get none
    const ids = (acc: string | null, sc: "current" | "account" | "all") => webmailTargets(accounts as never, acc, sc).map((x) => `${x.account.id}:${x.webmail.id}`).join();
    ok(ids("a2", "current") === "a2:gmail" && ids("a1", "current") === "" && ids("a5", "all") === "a2:gmail,a3:gmail,a4:outlook" && ids(null, "current") === "a2:gmail,a3:gmail,a4:outlook" && ids("a4", "account") === "a4:outlook" && ids("a5", "current") === "", `targets: ${ids(null, "current")} | custom domain: "${ids("a5", "current")}"`);
    return out;
  };
  (window as unknown as { __gmailCheck: () => string[] }).__gmailCheck = (window as unknown as { __webmailCheck: () => string[] }).__webmailCheck; // old name
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
  // `#autosave=3000`: the autosave waits 3 s instead of 30 s (and `#snapshot=1000` writes the crash-recovery snapshot every second): for a check
  const shortAutosave = Number(hashTokens().get("autosave"));
  if (shortAutosave > 0) (window as unknown as { __hlTiming: unknown }).__hlTiming = { autosaveMs: shortAutosave, snapshotMs: Number(hashTokens().get("snapshot")) || 1000 };
  // dev preview of the secondary windows: a script takes a conversation away (`__mockGone.add("t1")`) and says so (`__mockEmit("mail-synced", null)`)
  Object.assign(window, {
    __mockGone: mockGone,
    __mockEmit: (name: string, payload: unknown) => emit(name, payload),
    // the update flow of the page (`#update=available&dl=fast`): a check, then "Update" as the announcement toast's button does it; `flow()` is its state
    __mockUpdates: {
      start: async () => {
        const { useUpdates } = await import("./updates");
        await useUpdates.getState().checkUpdate("manual");
        await useUpdates.getState().startUpdate("toast");
      },
      cancel: async () => (await import("./updates")).useUpdates.getState().cancelUpdate(),
      flow: async () => (await import("./updates")).useUpdates.getState().flow.state,
    },
    // an IMAP EXPUNGE of a draft by another program: the server copy is gone, the page does not know yet (D-043: Discard changes before any save puts the opened version back)
    __mockExpungeDraft: (threadId: string) => {
      const ref = `m:a1:drafts:${threadId}`;
      const thread = mockDrafts[threadId];
      if (!thread) return false;
      mockLost[ref] = { thread, row: mockDraftRows[threadId], headers: mockDraftHeaders[`a1:drafts:${threadId}`] ?? { to: [], cc: [], bcc: [] } };
      dropMockDraft(ref);
      return true;
    },
  });
  // `#threaddelay=600`: the read of a conversation takes that long (a long mail on a slow disk; the status "Opening message…" of W13.6, also in the dev preview of the reader window)
  const threadDelay = Number(hashTokens().get("threaddelay"));
  if (threadDelay > 0) (window as unknown as { __mockDelays?: MockDelays }).__mockDelays = { thread: threadDelay };
  // a window object for `getCurrentWindow()` (a secondary window sets its title and theme; the label is the one the backend would give it)
  const which = new URLSearchParams(window.location.search).get("w");
  mockWindows(which === "reader" || which === "compose" ? `${which}-1` : "main");
  mockIPC(function handle(cmd, args): unknown {
    const a = (args ?? {}) as Record<string, unknown>;
    if (cmd.startsWith("calendar_")) (((window as unknown as { __mockCalls?: unknown[] }).__mockCalls) ??= []).push({ cmd, args: a }); // (dev check: which calendar commands the page called)
    // `window.__mockDelays.cmds[cmd]` (ms): a slow command (a big batch, a big message), answered after that time (W13.14 checks)
    const cmdWait = (window as unknown as { __mockDelays?: MockDelays }).__mockDelays?.cmds?.[cmd] ?? 0;
    if (cmdWait > 0 && !a.__waited) return later(cmdWait, () => handle(cmd, { ...a, __waited: true }));
    // the packed form of the same answer (threadPack.ts; the real command is get_thread_packed in lib.rs)
    if (cmd === "get_thread_packed") {
      const msgs = handle("get_thread", a);
      return msgs instanceof Promise ? msgs.then((m) => packThread(m as MessageFull[])) : packThread(msgs as MessageFull[]);
    }
    // a conversation's read / flag state is kept (as the server does), so the Unread and Flagged filters behave like the real list
    if (cmd === "get_thread" && !a.raw) {
      const delays = (window as unknown as { __mockDelays?: MockDelays }).__mockDelays;
      const wait = delays?.thread ?? 0;
      if (delays?.threadFail && !a.internal) return later(wait, () => { throw new Error("mock: the conversation could not be read"); });
      if (wait > 0 && !a.internal) return later(wait, () => handle(cmd, { ...a, internal: true }));
      const msgs = handle(cmd, { ...a, raw: true });
      const th = threads.find((x) => x.threadId === a.threadId);
      if (!th || !Array.isArray(msgs) || msgs.length === 0) return msgs;
      return msgs.map((m, i) => ({ ...m, seen: th.unread === 0 || i < msgs.length - 1, flagged: th.flagged || m.flagged }));
    }
    switch (cmd) {
      case "list_accounts": return accounts;
      case "idle_states": return { a1: "push" };
      // #aiset: the AI Assistant is set up (Translate / Summarize can be tried with #slowai / #failai)
      case "get_setting": return settings[a.key as string] ?? (a.key === "prefs" && hashTokens().has("lang") ? JSON.stringify({ language: hashTokens().get("lang") }) : null) ?? (hashHas("aiset") && (a.key === "ai_endpoint" || a.key === "ai_model") ? "mock" : null);
      case "first_run_hint": { const d = Number(hashTokens().get("firstrun")); return d > 0 ? Date.now() - d * 86_400_000 : null; } // `#firstrun=90`: the database is 90 days old (an install from before the support reminder)
      // a settings save that fails (Settings > AI Assistant shows it under Save): a Base URL with "savefail" in it, a key "keyfail", and #removefail for Remove the saved key
      case "set_setting": if (a.key === "ai_endpoint" && String(a.value).includes("savefail")) return later(200, () => { throw new Error("The settings database could not be written: disk I/O error (code 10)"); }); settings[a.key as string] = a.value as string; if (persistSettings) localStorage.setItem("hl-mock-settings", JSON.stringify(settings)); return null;
      // #nojunk: the second mailbox's server has no Junk folder (the saved list does not name one): its Junk row and the Junk actions go
      case "list_folders": {
        const rows = placed(hashHas("nojunk") ? folders.map((f) => (f.accountId === "a2" && f.key === "junk" ? { ...f, listed: false } : f)) : folders);
        // the Inbox rows carry the numbers of the Focused / Other tabs (W13.12), counted from the mock mail so a mock action changes them;
        // `#tabcounts=<focused>,<other>` forces fixed numbers (on the first mailbox) for layout checks, for example `#tabcounts=150,1234`
        const forced = /(^|&)tabcounts=(\d+),(\d+)/.exec(window.location.hash.slice(1));
        return rows.map((f) => {
          if (f.key !== "inbox") return f;
          if (forced) return { ...f, unreadFocused: f.accountId === "a1" ? Number(forced[2]) : 0, unreadOther: f.accountId === "a1" ? Number(forced[3]) : 0 };
          const gone = queuedIds();
          const unread = [...threads, ...localMail(f.accountId)].filter((x) => x.accountId === f.accountId && x.folder === "inbox" && !x.snoozedUntil && x.unread > 0 && !gone.has(x.threadId));
          // the side-menu number is the mock's fixed one, less the unread conversations that wait out their Undo time (the backend counts the rest itself)
          const waiting = gone.size ? [...threads, ...localMail(f.accountId)].filter((x) => x.accountId === f.accountId && x.folder === "inbox" && !x.snoozedUntil && x.unread > 0 && gone.has(x.threadId)).length : 0;
          return { ...f, unread: Math.max(0, f.unread - waiting), unreadFocused: unread.filter((x) => !x.bulk).length, unreadOther: unread.filter((x) => x.bulk).length };
        });
      }
      // W13.10: `#dot` = a server with the "." delimiter and the INBOX namespace (folders are INBOX.Clients, INBOX.Clients.Acme); `#createfail=noperm|exists|fail|slow` makes "New folder" fail;
      // `window.__mockFolderCreates` lists every create_mail_folder call
      case "create_mail_folder": {
        const own = a as { accountId: string; parentKey: string | null; name: string };
        (window as unknown as { __mockFolderCreates: unknown[] }).__mockFolderCreates ??= [];
        (window as unknown as { __mockFolderCreates: unknown[] }).__mockFolderCreates.push({ ...own });
        const mode = /(^|&)createfail=(\w+)/.exec(window.location.hash.slice(1))?.[2];
        const delay = mode === "slow" ? 2500 : 40;
        return later(delay, () => {
          if (mode === "noperm") throw "FOLDER_NOPERM: The server doesn’t let you create a folder here.";
          if (mode === "exists") throw "FOLDER_EXISTS: A folder with this name already exists here.";
          if (mode === "fail") throw "The server did not answer within 20 seconds.";
          const { delimiter, prefix } = mockFolderMeta();
          const rows = placed(folders);
          const parent = own.parentKey ? rows.find((f) => f.accountId === own.accountId && f.key === own.parentKey) : undefined;
          if (own.parentKey && !parent?.canNest) throw "FOLDER_PARENT: A subfolder can’t be made here.";
          const full = parent ? parent.name + delimiter + own.name.trim() : prefix + own.name.trim();
          if (folders.some((f) => f.accountId === own.accountId && f.name.toLowerCase() === full.toLowerCase())) throw "FOLDER_EXISTS: A folder with this name already exists here.";
          folders.push({ accountId: own.accountId, key: "f:" + full, name: full, unread: 0, total: 0 });
          return placed(folders).find((f) => f.accountId === own.accountId && f.key === "f:" + full);
        });
      }
      case "list_threads": {
        const f = a.filter as { folder: string; focus?: string; unreadOnly?: boolean; flaggedOnly?: boolean; sortAsc?: boolean; search?: string; scope?: string };
        const own = (a.filter as { accountId?: string | null }).accountId;
        const q = (f.search ?? "").trim();
        if (own && own.startsWith("n")) return f.folder === "inbox" && synced.has(own) ? newThreads(own) : []; // an added account: empty until its first sync is done
        if (f.folder === "drafts") return Object.values(mockDraftRows).reverse(); // newest saved first
        if (!(f.folder === "inbox" || f.folder === "unread" || f.folder === "all")) return [];
        // like the backend: a search over every mailbox ignores the selected one
        const scoped = own && !(q && f.scope === "all") ? own : null;
        let list = [...threads.filter((x) => !scoped || scoped === x.accountId), ...accounts.flatMap((x) => (!scoped || scoped === x.id ? localMail(x.id) : []))];
        if (mockQueued.size) { const gone = queuedIds(); list = list.filter((x) => !gone.has(x.threadId)); }
        if (f.focus === "other") list = list.filter((x) => x.bulk);
        else if (f.focus === "focused") list = list.filter((x) => !x.bulk);
        if (f.unreadOnly) list = list.filter((x) => x.unread);
        if (f.flaggedOnly) list = list.filter((x) => x.flagged);
        // mirror the Rust backend: every free word must appear in subject, snippet or participants
        const ops = q.toLowerCase().split(/\s+/).filter((w) => /^(from|is):\S+/.test(w));
        for (const o of ops) {
          const [k, v] = o.split(":");
          list = list.filter((x) => (k === "from" ? x.participants.join(" ").toLowerCase().includes(v) : v === "unread" ? x.unread > 0 : true));
        }
        const words = q.toLowerCase().split(/\s+/).filter((w) => w && !ops.includes(w));
        if (words.length) {
          list = list.filter((x) => {
            const hay = [x.subject, x.snippet, ...x.participants].join(" ").toLowerCase();
            return words.every((w) => hay.includes(w));
          });
        }
        // pinned first in the (newest-first) Inbox, then by date (newest first, or oldest first with sortAsc)
        const dir = f.sortAsc ? 1 : -1;
        return list.sort((x, y) => (f.folder === "inbox" && !f.sortAsc ? Number(y.pinned) - Number(x.pinned) : 0) || dir * (x.lastDate - y.lastDate));
      }
      case "locate_thread": {
        // like the backend: the list that has the conversation (the mock only has Inbox lists); null when it is not here (`__mockGone`, unknown)
        const id = String(a.threadId);
        const row = mockGone.has(id) ? undefined : [...threads, ...accounts.flatMap((x) => localMail(x.id))].find((x) => x.threadId === id);
        return row ? { accountId: row.accountId, folder: row.folder, focused: !row.bulk, other: !!row.bulk } : null;
      }
      case "get_thread":
        if (mockGone.has(a.threadId as string)) return []; // (dev preview of the reader: "This message was moved or deleted.")
        if (mockDrafts[a.threadId as string]) return mockDrafts[a.threadId as string];
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
        if (reauthNeeded[id]) return later(300, () => { throw new Error(reauthError(id)); });
        if (id.startsWith("n") && !synced.has(id)) return later(syncDelay, () => (synced.add(id), { added: 3, newInbox: [] }));
        return { added: 0, newInbox: [] };
      }
      case "add_account": {
        const inp = a.input as { email: string; displayName: string; imapHost: string; smtpHost: string };
        if (a.passwordValue === "wrong") return later(900, () => { throw new Error("AUTH: login failed: invalid credentials"); });
        // a locked system keyring: the password "locked" answers with the timeout after 2.5 s, "hang" does not answer within a minute (Cancel ends the wait)
        if (a.passwordValue === "locked") return later(2500, () => { throw new Error("KEYRING_TIMEOUT: Your system keyring is locked or not answering. Unlock it (Passwords and Keys / KWallet) and try again."); });
        if (a.passwordValue === "hang") return later(60000, () => { throw new Error("ADD_CANCELLED: Adding the account was cancelled."); });
        return later(1200, () => mockNewAccount(inp.email, inp.displayName || inp.email.split("@")[0], "password", inp.imapHost, inp.smtpHost));
      }
      case "google_sign_in": case "microsoft_sign_in": {
        const g = cmd === "google_sign_in";
        if (a.clientId === "fail") return later(900, () => { throw new Error("OAUTH: sign-in was cancelled in the browser"); });
        if (signinMode()) return mockBrowserSignIn(g ? "Google" : "Microsoft", () =>
          mockNewAccount(g ? `new.user${newSeq + 1}@gmail.com` : `new.user${newSeq + 1}@outlook.com`, String(a.displayName || "New User"), g ? "oauth_google" : "oauth_microsoft", g ? "imap.gmail.com" : "outlook.office365.com", g ? "smtp.gmail.com" : "smtp.office365.com"));
        return later(1200, () => mockNewAccount(g ? `new.user${newSeq + 1}@gmail.com` : `new.user${newSeq + 1}@outlook.com`, String(a.displayName || "New User"), g ? "oauth_google" : "oauth_microsoft", g ? "imap.gmail.com" : "outlook.office365.com", g ? "smtp.gmail.com" : "smtp.office365.com"));
      }
      case "cancel_add_account": return null;
      case "oauth_cancel": oauthCancel?.(); oauthCancel = null; return null;
      case "reauth_account": {
        const acc = accounts.find((x) => x.id === a.accountId);
        if (!acc) throw new Error("account not found");
        return mockBrowserSignIn(acc.auth === "oauth_microsoft" ? "Microsoft" : "Google", () => {
          delete reauthNeeded[acc.id];
          return acc;
        });
      }
      case "list_outbox": return mockOutbox.map((o) => ({ ...o })); // (copies: the page compares lists by reference, like an answer from the backend)
      case "outbox_pending_count": return { count: mockOutbox.filter((o) => o.status !== "failed").length, next: now + 3 * H };
      case "outbox_open_for_edit": {
        logOutbox(cmd, a);
        const o = mockOutbox.find((x) => x.id === a.id) ?? mockOutbox[0];
        const waiting = o.status === "pending" || o.status === "overdue";
        if (waiting) o.status = "held"; // (the backend pauses it: the row of the Scheduled list says so, D-039)
        return { draft: mockDraftOf(o), sendAt: o.sendAt, status: waiting ? "held" : o.status };
      }
      case "list_templates": return [{ id: "tp1", name: "Thanks", subject: "Thanks!", body: "<p>Thanks for your message.</p>" }, { id: "tp2", name: "Quarterly customer success follow-up with a deliberately very long template name", subject: "Follow-up", body: "<p>Hello</p>" }];
      case "list_signatures": return (hashHas("nodefaultsig") ? (l: Array<Record<string, unknown>>) => l.map((x) => ({ ...x, isDefault: false })) : (l: Array<Record<string, unknown>>) => l)([{ id: "s1", name: "Work", html: "Nam<br>Hey Look!", isDefault: true }, { id: "s2", name: "Personal signature with a very long name that has to be cut with an ellipsis before it reaches the tag", html: "Nam", isDefault: false }, { id: "s3", accountId: "a2", name: "Gmail", html: "Nam (via Gmail)<br><i>nam@gmail.com</i>", isDefault: true }, { id: "s4", name: "Branded (coloured)", html: SIG_S4_HTML, isDefault: false }]);
      case "list_senders": return [{ email: "news@ph.com", name: "Product Hunt", count: 42, unread: 12, canUnsubscribe: true, lastDate: now - H }];
      case "list_rules": return [{ id: "r1", accountId: null, name: "Move newsletters", field: "from", op: "contains", value: "newsletter@example.com", action: "archive", arg: null, enabled: true }, { id: "r2", accountId: null, name: "", field: "subject", op: "contains", value: "a very long rule text that should be truncated in the list row", action: "trash", arg: null, enabled: false }];
      case "list_blocked": return [];
      case "thread_action": {
        // like the backend: the state changes when the server has done it (not at the call), after the IMAP time;
        // `#slowflags` makes that time random (0.2 - 1.4 s) so calls finish out of order; every call is logged for checks
        const w = window as unknown as { __threadActionCalls?: { ids: string[]; action: string; at: number }[] };
        (w.__threadActionCalls ??= []).push({ ids: [...((a.threadIds ?? a.ids ?? []) as string[])], action: String(a.action), at: Date.now() });
        const ms = hashTokens().has("slowflags") ? 200 + Math.random() * 1200 : 600;
        return later(ms, () => {
          for (const id of (a.threadIds ?? a.ids ?? []) as string[]) {
            const th = threads.find((x) => x.threadId === id);
            if (!th) continue;
            if (a.action === "read") th.unread = 0;
            else if (a.action === "unread") th.unread = Math.max(1, th.unread);
            else if (a.action === "star") th.flagged = true;
            else if (a.action === "unstar") th.flagged = false;
            else if (a.action === "pin") th.pinned = true;
            else if (a.action === "unpin") th.pinned = false;
          }
          return null;
        });
      }
      case "update_account": {
        const x = accounts.find((y) => y.id === a.accountId);
        // like the backend: a Reply-To that is not one bare address is refused before anything is saved
        const rt = typeof a.replyTo === "string" ? parseReplyTo(a.replyTo) : undefined;
        if (rt === null) throw "EMAIL_INVALID: Enter a valid email address";
        if (x) { x.displayName = a.displayName as string; (x as { color: string | null }).color = (a.color as string | null) ?? null; if (rt !== undefined) (x as { replyTo?: string }).replyTo = rt; }
        return null;
      }
      // like the backend: the data of a big picture or file arrives in a request of its own, `save_draft` names it in `uploads` (draftUpload.ts)
      case "draft_upload": mockUploads.set(String(a.id), String(a.dataBase64)); return null;
      case "draft_data": throw "draft data is gone"; // (the mock never leaves data out: `deferred` is always empty)
      case "save_draft": {
        const ups = (a.uploads ?? []) as { inline: boolean; index: number; id: string }[];
        if (ups.length) {
          const d = a.draft as { inline?: { dataBase64: string }[]; attachments?: { dataBase64: string }[] };
          d.inline = d.inline?.map((p) => ({ ...p }));
          d.attachments = d.attachments?.map((p) => ({ ...p }));
          for (const u of ups) {
            const slot = (u.inline ? d.inline : d.attachments)?.[u.index];
            if (!slot || !mockUploads.has(u.id)) throw "draft upload missing: a picture or file of this draft did not arrive";
            slot.dataBase64 = mockUploads.get(u.id)!;
            mockUploads.delete(u.id);
          }
        }
        const w = window as unknown as { __draftSaveCalls?: number; __lastDraft: unknown };
        w.__draftSaveCalls = (w.__draftSaveCalls ?? 0) + 1; // counted, so a check can see that discarding writes none (AC-74)
        if (hashTokens().has("draftfail")) throw "mock: the server refused the draft"; // `#draftfail`: saving a draft fails (update restart asks what to do)
        // like the backend (lib.rs ensure_draft_has_content, W13.5): a draft with nothing in it is refused (the page checks first, so this is never reached by a check that passes)
        const empty = a.draft as { subject?: string; text?: string; attachments?: unknown[]; inline?: unknown[]; meeting?: { location?: string | null }; meetingForm?: string };
        if (hashTokens().has("draftempty") || (!empty.subject?.trim() && !empty.text?.trim() && !empty.attachments?.length && !empty.inline?.length && !empty.meeting?.location?.trim() && !empty.meetingForm))
          throw "DRAFT_EMPTY: There is nothing to save yet."; // (`#draftempty`: refused whatever it holds)
        w.__lastDraft = a.draft;
        // like the backend: the draft is a message of the Drafts folder, in the thread it gets from its Message-ID (the toast "Draft saved" opens it with Edit)
        const dr = a.draft as { to: string[]; cc: string[]; bcc?: string[]; inReplyTo?: string | null; references?: string[]; subject: string; html: string; text: string; accountId: string; importance?: string; meetingForm?: string };
        const tid = `dt${++mockDraftSeq}`;
        // the draft is replaced, not added to (the backend appends the new one, then deletes the one the reference names)
        let opened: (typeof mockOriginals)[string] | undefined;
        if (typeof a.replaces === "string") {
          // the first save of an opened draft keeps the version that was opened; a later save takes it along (draftmail.rs note_save)
          const first = a.replaces.startsWith("m:a1:drafts:") ? a.replaces.slice("m:a1:drafts:".length) : null;
          if (first && mockDrafts[first]) opened = { thread: mockDrafts[first], row: mockDraftRows[first], headers: mockDraftHeaders[`a1:drafts:${first}`] };
          else if (mockOriginals[a.replaces]) {
            opened = mockOriginals[a.replaces];
            delete mockOriginals[a.replaces];
          }
          dropMockDraft(a.replaces);
        }
        // the synced copy has bare To / Cc addresses and no Bcc; `draft_recipients` returns what the headers say
        const bareOf = (l: string[]) => l.map((x) => /<([^>]+)>/.exec(x)?.[1] ?? x);
        mockDrafts[tid] = [{ ...messages[0], id: `a1:drafts:${tid}`, accountId: dr.accountId, folder: "drafts", subject: dr.subject || "(no subject)", fromName: "Nam", fromEmail: "nam@example.com", to: bareOf(dr.to).join(", "), cc: bareOf(dr.cc).join(", "), html: dr.html, text: dr.text, attachments: [], seen: true, ...{ importance: dr.importance ?? "normal" } }];
        // the draft shows up in Drafts; reopening it gives back what was saved, the importance included (the backend reads it from the headers)
        mockDraftRows[tid] = t(tid, dr.subject || "(no subject)", [dr.to[0] ?? "(no recipient)"], dr.text.slice(0, 120), 0, { folder: "drafts", accountId: dr.accountId, importance: dr.importance ?? "normal" });
        mockDraftHeaders[`a1:drafts:${tid}`] = { to: dr.to, cc: dr.cc, bcc: dr.bcc ?? [], inReplyTo: dr.inReplyTo ?? null, references: dr.references ?? [], meeting: dr.meetingForm ?? null, answers: (a.draft as { answers?: unknown }).answers ?? null }; // (the private X-HeyLook-Meeting header)
        mockDraftRefs[`mid:a1|<${tid}@mock>`] = tid;
        (window as unknown as { __draftCount: () => number }).__draftCount = () => Object.keys(mockDrafts).length; // for a check: drafts the page holds
        if (opened) mockOriginals[`mid:a1|<${tid}@mock>`] = opened;
        const done = () => ({ threadId: tid, draftRef: `mid:a1|<${tid}@mock>` });
        return hashTokens().has("draftslow") ? later(1500, done) : done(); // `#draftslow`: the save takes 1.5 s
      }
      case "discard_draft": {
        const w = window as unknown as { __discardDrafts?: number };
        w.__discardDrafts = (w.__discardDrafts ?? 0) + 1; // counted, so a check can see how many times (and when) the saved copy was removed
        delete mockOriginals[String(a.reference)];
        dropMockDraft(String(a.reference));
        return null;
      }
      case "discard_draft_changes": {
        const ref = String(a.reference);
        if (ref.startsWith("m:")) {
          // an opened draft that no save has replaced yet (no autosave): there is nothing of the edits to take back; the opened version is put back only when the server lost it
          // (`__mockExpungeDraft(threadId)` takes the draft away like an IMAP EXPUNGE by another program). Counted apart from the restore below: `__discardUnsaved` lists the references.
          const w = window as unknown as { __discardUnsaved?: string[]; __discardUnsavedMs?: number };
          (w.__discardUnsaved ??= []).push(ref);
          if (hashTokens().has("restorefail")) throw "mock: the server refused the draft";
          return later(w.__discardUnsavedMs ?? 0, () => {
            const lost = mockLost[ref];
            if (!lost) return false;
            delete mockLost[ref];
            const tid = `dt${++mockDraftSeq}`;
            mockDrafts[tid] = lost.thread.map((m) => ({ ...m, id: `a1:drafts:${tid}` }));
            mockDraftRows[tid] = { ...lost.row, threadId: tid, rowKey: tid };
            mockDraftHeaders[`a1:drafts:${tid}`] = lost.headers;
            (window as unknown as { __draftCount: () => number }).__draftCount = () => Object.keys(mockDrafts).length;
            return true;
          });
        }
        // like the backend: the opened version is appended again, then the saved copy goes (`#restorefail`: the server refuses, nothing changes)
        const w = window as unknown as { __discardChanges?: number };
        w.__discardChanges = (w.__discardChanges ?? 0) + 1; // counted, so a check can see that no restore ran
        const o = mockOriginals[ref];
        if (hashTokens().has("restorefail")) throw "mock: the server refused the draft";
        if (!o || hashTokens().has("nokept")) return false; // none kept (`#nokept` makes it so): nothing written, the saved copy stays
        dropMockDraft(ref);
        delete mockOriginals[ref];
        const tid = `dt${++mockDraftSeq}`;
        mockDrafts[tid] = o.thread.map((m) => ({ ...m, id: `a1:drafts:${tid}` }));
        mockDraftRows[tid] = { ...o.row, threadId: tid, rowKey: tid };
        mockDraftHeaders[`a1:drafts:${tid}`] = o.headers;
        mockDraftRefs[`mid:a1|<${tid}@mock>`] = tid;
        (window as unknown as { __draftCount: () => number }).__draftCount = () => Object.keys(mockDrafts).length;
        return true;
      }
      case "recovery_save": {
        const sn = a.snap as MockSnap & { files: unknown[] | null };
        const all = recoveryRead();
        all[sn.id] = { ...sn, savedAt: Math.floor(Date.now() / 1000), files: sn.files ?? all[sn.id]?.files ?? [] }; // files not sent = the same as before
        recoveryWrite(all);
        const w = window as unknown as { __recoverySaves?: number };
        w.__recoverySaves = (w.__recoverySaves ?? 0) + 1; // counted for a check
        return null;
      }
      case "recovery_clear": { const all = recoveryRead(); delete all[String(a.id)]; recoveryWrite(all); return null; }
      case "recovery_list":
        return Object.values(recoveryRead()).filter((x) => accounts.some((acc) => acc.id === x.accountId)).sort((x, y) => y.savedAt - x.savedAt).map(({ payload: _p, files, ...i }) => ({ ...i, files: files.length }));
      case "recovery_load": return recoveryRead()[String(a.id)] ?? null;
      case "recovery_save_draft": {
        // like the backend: `#nodrafts` = the account has no Drafts folder, which is made now (W6.4) unless `#nocreate` (the server refuses to make it: the coded error,
        // the snapshot stays); else the snapshot is saved as a draft (the same as Save draft) and removed.
        if (hashTokens().has("nodrafts") && hashTokens().has("nocreate")) throw "DRAFTS_NOT_CREATED|why=not allowed: Couldn’t find or create the Drafts folder on this account (not allowed).";
        const saved = handle("save_draft", { draft: a.draft, replaces: a.replaces }) as { threadId: string; draftRef: string };
        const all = recoveryRead();
        delete all[String(a.id)];
        recoveryWrite(all);
        const w = window as unknown as { __recoveredDrafts?: string[] };
        (w.__recoveredDrafts ??= []).push(String(a.id));
        return { status: "saved", ...saved };
      }
      case "draft_recipients": return mockDraftHeaders[a.messageId as string] ?? { to: [], cc: [], bcc: [] };
      // what the backend assembles for Compose in one call (draftopen.rs): the body with the pictures put back as data: URIs (each with the name it was added with) and the
      // attachments that stay attachments. `window.__draftPartsDelay` (ms): the answer takes that long (a large draft: the status "Opening draft...")
      case "draft_editor_parts": {
        type Msg = { id: string; html: string | null; text: string | null; attachments: { index: number; name: string; mime: string; inline?: boolean; referenced?: boolean; cid?: string | null }[] };
        const m = ([...Object.values(mockDrafts).flat(), m4, ...messages, ...mockLayerMsgs] as unknown as Msg[]).find((x) => x.id === a.messageId);
        let html = m?.html ?? null;
        const attachments: { filename: string; mime: string; dataBase64: string }[] = [];
        for (const at of m?.attachments ?? []) {
          const d = handle("attachment_data", { messageId: a.messageId, index: at.index, internal: true }) as { name: string; mime: string; dataBase64: string };
          if (at.inline && at.referenced) {
            if (html && at.cid) {
              if (html.includes(`cid:${at.cid}`)) html = html.split(`cid:${at.cid}`).join(`data:${d.mime};base64,${d.dataBase64}`);
              html = nameInlinePicture(html, d.dataBase64, at.name || d.name);
            }
            continue;
          }
          attachments.push({ filename: d.name, mime: d.mime, dataBase64: d.dataBase64 });
        }
        const out = { html, text: m?.text ?? null, attachments, deferred: [] as string[] };
        const slow = Number((window as unknown as { __draftPartsDelay?: number }).__draftPartsDelay ?? 0);
        return slow > 0 ? later(slow, () => out) : out;
      }
      case "prepare_action": {
        // like the backend: the folder a move goes to is looked up before the move is queued. `#nocreate`: the server has no Archive / Trash
        // and refuses to create one (the error comes after the IMAP time, 1.2 s). `#stalefolder`: the saved folder list still names the
        // folder (the server deleted it since the last sync): no look-up now, the answer is `true` = "check it during the Undo window".
        // Every call is logged on `window.__prepareActionCalls`.
        const w = window as unknown as { __prepareActionCalls?: { ids: string[]; action: string; at: number }[] };
        (w.__prepareActionCalls ??= []).push({ ids: [...((a.threadIds ?? []) as string[])], action: String(a.action), at: Date.now() });
        const folder = a.action === "archive" ? "Archive" : a.action === "trash" ? "Trash" : null;
        if (folder && hashTokens().has("stalefolder")) return true;
        if (folder && hashTokens().has("nocreate")) {
          return later(1200, () => {
            throw `FOLDER_NOT_CREATED|folder=${folder}|why=CREATE denied: Couldn’t find or create the ${folder} folder on this account (CREATE denied). The mail stays where it is.`;
          });
        }
        return false;
      }
      case "queue_action": {
        // `verify` (the saved list was trusted): with `#stalefolder` + `#nocreate` the check finds the folder gone and not creatable after
        // `#stalefolder=<ms>` (default 1.2 s): the move is dropped and `action-verify-failed` comes, unless Undo was pressed first.
        const w = window as unknown as { __queueActionCalls?: { ids: string[]; action: string; at: number; verify: boolean }[]; __cancelledActions?: Set<string> };
        (w.__queueActionCalls ??= []).push({ ids: [...((a.threadIds ?? []) as string[])], action: String(a.action), at: Date.now(), verify: a.verify === true });
        const token = "token-" + Math.random().toString(36).slice(2);
        mockQueued.set(token, [...((a.threadIds ?? []) as string[])]);
        const folder = a.action === "archive" ? "Archive" : a.action === "trash" ? "Trash" : null;
        if (a.verify === true && folder && hashTokens().has("stalefolder") && hashTokens().has("nocreate")) {
          const ms = Number(hashTokens().get("stalefolder")) || 1200;
          setTimeout(() => {
            if (w.__cancelledActions?.has(token)) return; // Undo won
            mockQueued.delete(token); // dropped: the mail is back
            void emit("action-verify-failed", { id: token, error: `FOLDER_NOT_CREATED|folder=${folder}|why=CREATE denied: Couldn’t find or create the ${folder} folder on this account (CREATE denied). The mail stays where it is.` });
          }, ms);
        }
        // `#refusemove[=<ms>]`: the server refuses the MOVE itself, <ms> (default 500) after the Undo window ends: `action-failed` names the move
        // (the folder check passed, so this is not the `#stalefolder` path); unless Undo was pressed first
        if (hashTokens().has("refusemove") && folder) {
          const ms = Number(hashTokens().get("refusemove")) || 500;
          setTimeout(() => {
            if (w.__cancelledActions?.has(token)) return;
            mockQueued.delete(token); // refused: the mail is back
            void emit("action-failed", { id: token, error: "MOVE refused: [NO] Permission denied (mock server)" });
          }, Number(a.delaySecs ?? 6) * 1000 + ms);
        }
        return token;
      }
      case "cancel_action": {
        const w = window as unknown as { __cancelledActions?: Set<string> };
        (w.__cancelledActions ??= new Set()).add(String(a.id));
        mockQueued.delete(String(a.id));
        return true;
      }
      case "load_older": {
        // up to 50 older messages of one folder; rejects like an IMAP failure when `failIn` counts down to the call
        const id = String(a.accountId);
        const limit = Math.min(50, Number(a.limit ?? 50));
        mockMail.calls.push({ accountId: id, role: String(a.role), limit, at: Date.now() });
        return later(400, () => {
          if (mockMail.failIn > 0 && --mockMail.failIn === 0) throw "IMAP_FETCH: could not read older messages: connection timed out (mock failure)";
          const have = mockMail.local[id], total = mockMail.total[id];
          if (a.role !== "inbox" || have === undefined) return { added: 0, exhausted: true, limited: false };
          // the cap counts everything stored for the mailbox: at it, the answer comes without any "network"
          const cap = mockCap();
          if (have >= cap) return { added: 0, exhausted: false, limited: true };
          const added = Math.min(limit, total - have, cap - have);
          mockMail.local[id] = have + added;
          const exhausted = have + added >= total;
          return { added, exhausted, limited: !exhausted && have + added >= cap };
        });
      }
      // Search on the server (W6.7): `#serversearch[=capped|none|fail|slow|local]`. The answer is made of rows that this computer does not have; `__serverCalls` logs what the page asked
      // (search / cancel / open). `slow` answers after 6 s (Cancel in between makes the answer stale), `fail` says the second mailbox could not be searched.
      case "server_search": {
        const w = window as unknown as { __serverCalls?: { cmd: string; filter?: unknown; at: number }[] };
        (w.__serverCalls ??= []).push({ cmd: "search", filter: a.filter, at: Date.now() });
        const mode = hashTokens().get("serversearch") || "";
        const gen = ++mockServerRun;
        const rows = Array.from({ length: mode === "none" ? 0 : mode === "capped" ? 200 : 7 }, (_, i) => ({
          accountId: "a1", role: i % 3 === 2 ? "archive" : "inbox", uid: 5000 - i, validity: 1, subject: i === 0 ? "Báo cáo quý 3" : `Old invoice ${i + 1}`, fromName: i % 2 ? "Ann Lee" : "", fromEmail: "ann@x.test",
          date: Math.floor(Date.now() / 1000) - 86400 * 400 - i * 3600, seen: i % 2 === 0, flagged: i === 3, hasAttach: i === 1,
        }));
        return later(hashNum("serversearchdelay", mode === "slow" ? 6000 : 300), () => ({
          rows: gen === mockServerRun ? rows : [],
          capped: mode === "capped",
          errors: mode === "fail" ? [{ accountId: "a2", error: hashTokens().has("serversearchlong") ? "The server said: " + "unbroken-reply-text-".repeat(15) : "IMAP login failed: the mock server is down" }] : [], // (`#serversearchlong`: 300 characters without a space)
          localOnly: mode === "local",
          cancelled: gen !== mockServerRun,
        }));
      }
      case "server_search_cancel": {
        mockServerRun++;
        const w = window as unknown as { __serverCalls?: { cmd: string; at: number }[] };
        (w.__serverCalls ??= []).push({ cmd: "cancel", at: Date.now() });
        return null;
      }
      case "server_open": {
        const w = window as unknown as { __serverCalls?: { cmd: string; uid?: number; at: number }[] };
        (w.__serverCalls ??= []).push({ cmd: "open", uid: Number(a.uid), at: Date.now() });
        return later(hashNum("serveropenms", 250), () => {
          if (hashTokens().has("serveropenfail")) throw "MSG_NOT_ON_SERVER: message not found on server";
          return "t1";
        });
      }
      case "prune_to_limit": {
        // the person lowered the cap (W6.3): every mailbox is brought to it at once; the call is logged for a check (window.__pruneCalls = [{ keep, cap }])
        const w = window as unknown as { __pruneCalls?: { keep: unknown; cap: number }[] };
        (w.__pruneCalls ??= []).push({ keep: a.keepThreads, cap: mockCap() });
        const cap = mockCap();
        let removed = 0;
        for (const id of Object.keys(mockMail.local)) {
          if (mockMail.local[id] > cap) {
            removed += mockMail.local[id] - cap;
            mockMail.local[id] = cap;
          }
          if (mockMail.local[id] >= cap) void emit("mail-pruned", { accountId: id, removed });
        }
        void emit("mail-synced", null);
        return removed;
      }
      case "notify_caps": { // (W5.4) `#noactions`: a Linux notification service without buttons; macOS has none
        const os = hashTokens().get("os") || "windows";
        return { actions: os === "windows" || (os === "linux" && !hashTokens().has("noactions")) };
      }
      case "print_html": { // (macOS Print, W5.3) `#printfail` makes it fail; the documents are kept in window.__printed for a check
        (((window as unknown as { __printed?: { html: string; title: string }[] }).__printed ??= [])).push({ html: String(a.html), title: String(a.title) });
        if (hashTokens().has("printfail")) throw "mock: print failed";
        return null;
      }
      case "mac_menu_state": // (macOS File > Print…, W5.11) what the page said last and how often, for a check
        (window as unknown as { __macMenu?: { can: boolean; at: number }[] }).__macMenu = [...((window as unknown as { __macMenu?: { can: boolean; at: number }[] }).__macMenu ?? []), { can: a.canPrint === true, at: Math.round(performance.now()) }];
        return null;
      case "plugin:opener|open_url": // (Linux asks the backend: open_external)
      case "open_external":
        if (hashTokens().has("openfail")) throw "mock: no default browser"; // `#openfail` makes opening links fail (update check: copy-link path)
        mockMail.opened.push(String(a.url)); console.info("[mock] open in browser:", a.url); return null;
      // Unsubscribe (1.0.7 fix18): `#unsub=done|open|mailto|notarget|error` is the answer (default open), `#unsubms=<ms>` how long the backend takes; the calls
      // are logged in window.__unsubCalls (the message id) and window.__unsubOpened (what the page reported about the browser: [target, error])
      case "unsubscribe": {
        const w = window as unknown as { __unsubCalls?: string[] };
        (w.__unsubCalls ??= []).push(String(a.messageId));
        const kind = hashTokens().get("unsub") || "open";
        return later(hashNum("unsubms", 0), () => {
          if (kind === "error") throw "mock: the backend failed";
          if (kind === "notarget") throw "UNSUBSCRIBE_NO_TARGET: This message has no unsubscribe link.";
          if (kind === "mailto") return { kind: "mailto", target: "mailto:unsub-7f3a@lists.example.org?subject=unsubscribe%20T0K3N&body=Please%20remove%20me" };
          return { kind, target: "https://news.example.org/u/abc123" };
        });
      }
      case "unsubscribe_opened": {
        const w = window as unknown as { __unsubOpened?: [string, string | null][] };
        (w.__unsubOpened ??= []).push([String(a.target), (a.error as string | null) ?? null]);
        return null;
      }
      case "copy_text": // (Linux asks the backend for the clipboard; `#copyfail` makes it fail)
        if (hashTokens().has("copyfail")) throw "mock: no clipboard";
        console.info("[mock] clipboard:", a.text); return null;
      case "read_clipboard_text": // (macOS reads the clipboard for Cmd+Shift+V, Linux when Ctrl+Shift+V pasted nothing; a dev check sets window.__mockClipboard = { text, html }; window.__readCalls counts the reads)
        (window as unknown as { __readCalls?: number }).__readCalls = ((window as unknown as { __readCalls?: number }).__readCalls ?? 0) + 1;
        if ((window as unknown as { __readFails?: boolean }).__readFails) throw "mock: the clipboard cannot be read"; // (a check: the backend read fails)
        return (window as unknown as { __mockClipboard?: { text: string; html: string } }).__mockClipboard ?? { text: "", html: "" };
      case "plugin:app|version": return "1.0.0";
      // `#os=macos|linux` (per-OS copy and shortcut labels), `#notray` (Linux without a tray host), `#nonotify` (Send test fails)
      case "shell_info": { // `#pdf=frame|pdfjs|pdfjs-broken|card` picks the PDF preview (default: the frame on Windows, PDF.js elsewhere)
        const os = hashTokens().get("os") || "windows";
        return { os, tray: !hashTokens().has("notray"), testData: null, pdfView: hashTokens().get("pdf") || (os === "windows" ? "frame" : "pdfjs"), copyFail: hashTokens().has("copyfail"), openFail: hashTokens().has("openfail"), accountsDelayMs: hashNum("accountsdelay", 0), managed: hashTokens().get("managed") || null }; // `#managed=apt|snap|msstore`: this copy is updated by apt / the Snap Store / the Microsoft Store (Settings > About). `#accountsdelay=<ms>`: the store takes the mailboxes that late (New mail before they are read)
      }
      // Linux (W5.2): the desktop's scheme as the backend resolves it: `#osdark=1` / `#osdark=0` (default: nothing, the engine's media query decides, as on Windows and macOS); a check changes it with
      // window.__mockEmit("os-color-scheme", { dark: true })
      case "os_color_scheme": { const v = hashTokens().get("osdark"); return v === "1" ? { dark: true, source: "portal" } : v === "0" ? { dark: false, source: "portal" } : { dark: null, source: "engine" }; }
      case "test_notification":
        if (hashTokens().has("nonotify")) throw "no notification server is running";
        ((window as unknown as { __notifyLog?: string[] }).__notifyLog ??= []).push("test");
        return null;
      // macOS notification permission (W5.10): `#macnotify-denied` / `#macnotify-undetermined` (default granted); a check sets window.__mockPerm to change it ("System Settings"), window.__mockPermAnswer is what the
      // person answers when asked (default granted); window.__notifyLog lists the asks and the tests
      case "notify_permission": {
        const w = window as unknown as { __mockPerm?: string; __mockPermAnswer?: string; __notifyLog?: string[] };
        w.__mockPerm ??= hashTokens().has("macnotify-denied") ? "denied" : hashTokens().has("macnotify-undetermined") ? "undetermined" : "granted";
        if (a.ask === "sendTest" && w.__mockPerm === "undetermined") {
          (w.__notifyLog ??= []).push("ask");
          w.__mockPerm = w.__mockPermAnswer ?? "granted";
        }
        return w.__mockPerm;
      }
      case "open_notification_settings":
        ((window as unknown as { __notifyLog?: string[] }).__notifyLog ??= []).push("open-settings");
        return null;
      // `#nosound`: the preview cannot play (the toast "Couldn't play the sound"); `window.__mockSoundPlays` counts the calls
      case "play_notify_sound":
        (window as unknown as { __mockSoundPlays?: number }).__mockSoundPlays = ((window as unknown as { __mockSoundPlays?: number }).__mockSoundPlays ?? 0) + 1;
        if (hashTokens().has("nosound")) throw "no sound player was found";
        return null;
      case "check_update": return mockCheckUpdate(String(a.trigger), settings.prefs);
      case "update_download": return mockDownload(a.onEvent as { onmessage: (e: unknown) => void });
      case "update_cancel": dlCancelled = true; logUpdateCall({ cmd: "cancel" }).kind = "ok"; return null;
      case "update_note": logUpdateCall({ cmd: "note", note: String(a.text) }).kind = "ok"; return null;
      case "update_discard": logUpdateCall({ cmd: "discard" }).kind = "ok"; return null;
      // the last account can be removed in the mock (Settings > account > Remove): the Welcome screen returns
      case "remove_account": { const i = accounts.findIndex((x) => x.id === a.accountId); if (i >= 0) accounts.splice(i, 1); return null; }
      case "take_tray_compose": { const w = window as unknown as { __trayCompose?: boolean }; const pending = !!w.__trayCompose; w.__trayCompose = false; return pending; } // (a dev check sets window.__trayCompose = true)
      case "set_mail_available": ((window as unknown as { __mailAvailable?: boolean[] }).__mailAvailable ??= []).push(!!a.available); return null;
      // an Undo-window send is kept in the (mock) outbox until it is sent or taken back; every call is logged in window.__sendCalls
      case "outbox_hold": { const w = window as unknown as { __sendCalls?: unknown[]; __held?: Record<string, unknown> }; (w.__sendCalls ??= []).push({ cmd: "hold", dueAt: a.dueAt, draft: a.draft }); const id = `hold-${Date.now()}`; (w.__held ??= {})[id] = a.draft; return id; }
      case "outbox_hold_send": {
        const w = window as unknown as { __sendCalls?: unknown[]; __held?: Record<string, { subject?: string }> };
        (w.__sendCalls ??= []).push({ cmd: "holdSend", id: a.id, keep: a.keep });
        // a subject with [toolarge] is refused for its size like a server with a smaller limit does (dev check of the size message)
        if (String(w.__held?.[a.id as string]?.subject ?? "").includes("[smtpfail]")) throw "SMTP send failed: response error: incomplete response";
        if (String(w.__held?.[a.id as string]?.subject ?? "").includes("[toolarge]")) throw "SMTP_TOO_LARGE|reply=552 5.3.4 Message size exceeds fixed limit: The message is larger than this server accepts. Remove attachments or shrink pictures. (Server reply: 552 5.3.4 Message size exceeds fixed limit)";
        return null;
      }
      case "quit_dialog": case "quit_page_alive": case "quit_cancelled": case "sends_flushed": case "show_window": case "frontend_ready": case "page_state": return null;
      // secondary windows (src/popout): the dev preview of a pop-out is ?w=compose or ?w=reader in a plain browser tab
      case "popout_destroy": {
        const w = window as unknown as { __popoutDestroyed?: number; __popoutCalls?: string[] };
        w.__popoutDestroyed = (w.__popoutDestroyed ?? 0) + 1; // counted, so a check can see that a window ended
        (w.__popoutCalls ??= []).push(cmd);
        return true;
      }
      case "popout_park": case "popout_set_key": ((window as unknown as { __popoutCalls?: string[] }).__popoutCalls ??= []).push(cmd); return true;
      case "popout_note": case "window_theme_refresh": return null;
      // a reader goes on to show another conversation (W4.4): logged (window.__popoutShown); `#showother` answers that another window has it
      case "popout_show": ((window as unknown as { __popoutShown?: unknown[] }).__popoutShown ??= []).push({ key: a.key, init: a.init }); return hashHas("showother") ? { status: "focused", label: "reader-9" } : { status: "shown", label: null };
      case "popout_init": {
        const q = new URLSearchParams(window.location.search);
        const kind = q.get("w") ?? "compose";
        // the windows of W4.6 in a plain browser tab: ?w=event[&mock=new|&id=e3], ?w=settings[&tab=appearance&section=reading], ?w=search[&q=invoice&scope=all], ?w=scheduled
        if (kind === "event") return { kind, label: "event-1", key: null, init: q.get("mock") === "new" ? { init: { summary: "" } } : { eventId: q.get("id") ?? "e3" } };
        if (kind === "settings") return { kind, label: "settings-1", key: "settings", init: { tab: q.get("tab") ?? undefined, section: q.get("section") ?? undefined } };
        if (kind === "search") return { kind, label: "search-1", key: "search", init: { search: q.get("q") ?? "invoice", scope: q.get("scope") ?? "all", folder: q.get("folder") ?? "inbox", accountId: q.get("acct"), filter: q.get("filter") ?? "all" } };
        if (kind === "scheduled") return { kind, label: "scheduled-1", key: "scheduled", init: {} };
        // the compose window in a plain browser tab: ?w=compose[&mock=reply|draft|new|opened|openedcarried|openedsaved]
        // (opened*: a draft that was opened from Drafts and moved to this window; `carried` = the pane had changes; `openedsaved` = the pane had saved it, so it is a mid: reference)
        if (kind !== "reader") {
          const m = q.get("mock");
          const init =
            m === "reply" ? { accountId: "a1", to: ["linh.tran@acme.example"], subject: "Re: Q4 roadmap review", isReply: true, inReplyTo: "<m1@acme.example>", bodyHtml: "<p>On Mon, Linh wrote:</p><blockquote><p>Could you review the milestones before Thursday?</p></blockquote>" }
            : m === "draft" ? { accountId: "a1", to: ["alice@fabrikam.com"], subject: "Draft with text", replaces: "d1", bodyHtml: "<p>Saved draft text</p>" }
            : m === "opened" || m === "openedcarried" ? { accountId: "a1", to: ["alice@fabrikam.com"], subject: "D1", replaces: "m:a1:drafts:dx", openedDraft: true, bodyHtml: "<p>Original text</p>", ...(m === "openedcarried" ? { carried: true } : {}) }
            : m === "sigrestore" ? { accountId: "a1", to: ["alice@fabrikam.com"], subject: "Restored", sigId: "s4", carried: true, restore: { encrypt: "auto", sign: false, attachKey: false }, bodyHtml: "<p>Body of the message</p><br><div class=\"sig\">-- <br>" + (SIG_S4_HTML) + "</div>" }
            : m === "openedsaved" ? { accountId: "a1", to: ["alice@fabrikam.com"], subject: "D1", replaces: "mid:a1|<dx@mock>", openedDraft: true, carried: true, bodyHtml: "<p>Original text plus edits</p>" }
            : m === "prepare" ? { accountId: "a1", subject: "Re: Q4 roadmap review", isReply: true, preparing: { kind: "reply", id: "mock-shell", key: "re:m3", at: Date.now() } }
            : m === "preparefwd" ? { accountId: "a1", subject: "Fwd: Photos", preparing: { kind: "forward", id: "mock-shell", key: "fw:m4", at: Date.now(), fetching: true } }
            : m === "scheduled" ? { accountId: "a1", to: ["alice@fabrikam.com"], subject: "Scheduled one", bodyHtml: "<p>Scheduled text</p>", outboxId: "s1", sendAt: Math.floor(Date.now() / 1000) + 3 * 3600 }
            : m === "reloaded" ? { accountId: "a1", to: ["linh.tran@acme.example"], subject: "As it was opened", bodyHtml: "<p>Handed over</p>" }
            : m === "new" ? {} : null;
          // `mock=reloaded`: the page process of this window died and the window was loaded again (W4.2): the backend names the snapshot of the message (planted in localStorage by the test)
          return { kind, label: "compose-1", key: null, init, reloaded: m === "reloaded", recoveryId: m === "reloaded" ? "snap-1" : null };
        }
        // the reader window in a plain browser tab: ?w=reader&thread=t1[&folder=inbox][&view=inbox]
        const id = q.get("thread") ?? "t1";
        const th = threads.find((x) => x.threadId === id);
        const folder = q.get("folder") ?? th?.folder ?? "inbox";
        return { kind, label: "reader-1", key: id, init: { threadId: id, accountId: th?.accountId ?? "a1", folder, view: q.get("view") ?? folder, subject: th?.subject ?? "" } };
      }
      // the main page is not there in a plain tab: a request of a secondary window is logged (window.__popoutRequests), applied to the mock
      // conversations when it is a state change, and answered after a moment (`#reqfail` answers with an error, `#reqsilent` does not answer)
      case "popout_request": {
        const w = window as unknown as { __popoutRequests?: unknown[] };
        (w.__popoutRequests ??= []).push({ id: a.id, kind: a.kind, payload: a.payload });
        const p = (a.payload ?? {}) as Record<string, unknown>;
        if (a.kind === "thread-action") {
          const th = threads.find((x) => x.threadId === p.threadId);
          if (th) {
            const act = String(p.action);
            if (act === "read") th.unread = 0;
            else if (act === "unread") th.unread = Math.max(1, th.unread);
            else if (act === "star") th.flagged = true;
            else if (act === "unstar") th.flagged = false;
            else if (act === "pin") th.pinned = true;
            else if (act === "unpin") th.pinned = false;
            else mockGone.add(th.threadId); // a move: the conversation is not where it was
          }
          later(200, () => void emit("thread-state", { threadIds: [p.threadId], action: p.action }));
        }
        // Next / Previous of a reader (W4.4): the rows of the list the window was opened from, in the order of the mock list; drafts and Scheduled are skipped by the caller's rule
        let data: unknown = null;
        // Move to main window (W4.5): `#popinkeep` = the person chose Keep writing; `#popinasking` = the main window asks its question first (the result comes 800 ms later)
        // the light theme's session mail background (WP13g): the "main window" of this tab remembers it (`#canvasdark` starts dark), a test reads it with window.__mockCanvasSession
        if (a.kind === "canvas-session") {
          const cw = window as unknown as { __mockCanvasSession?: boolean };
          if (typeof p.dark === "boolean") cw.__mockCanvasSession = p.dark;
          data = { dark: cw.__mockCanvasSession ?? hashHas("canvasdark") };
        }
        if (a.kind === "cw-pop-in") data = hashHas("popinasking") ? { state: "asking" } : { opened: !hashHas("popinkeep") };
        if (a.kind === "cw-pop-in-result") {
          later(800, () => void emit("popout-reply", { id: a.id, ok: true, data: { opened: !hashHas("popinkeep") }, error: null }));
          return null;
        }
        if (a.kind === "neighbors" && !hashHas("reqsilent")) {
          // (the list the way the mock backend lists it; a conversation in `__mockGone` is not in it)
          const view = String(p.view || p.folder || "inbox");
          void (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<typeof threads> } }).__TAURI_INTERNALS__.invoke("list_threads", { filter: { accountId: null, folder: view, search: "", focus: null, flat: false, unreadOnly: false, flaggedOnly: false, sortAsc: false, scope: "current" } }).then((all) => {
            const rows = all.filter((x) => !mockGone.has(x.threadId) && x.folder !== "drafts");
            const at = rows.findIndex((x) => x.threadId === p.threadId);
            const one = (x?: (typeof rows)[number]) => (x ? { threadId: x.threadId, accountId: x.accountId, folder: x.folder, subject: x.subject, view } : null);
            void emit("popout-reply", { id: a.id, ok: true, data: at < 0 ? { prev: null, next: null } : { prev: one(rows[at - 1]), next: one(rows[at + 1]) }, error: null });
          });
          return null;
        }
        if (!hashHas("reqsilent")) later(hashHas("reqslow") ? 1500 : 150, () => void emit("popout-reply", { id: a.id, ok: !hashHas("reqfail"), data: hashHas("reqfail") ? null : data, error: hashHas("reqfail") ? "mock: the main window refused" : null }));
        return null;
      }
      case "thread_meta": return { pinned: !!threads.find((x) => x.threadId === a.threadId)?.pinned, snoozedUntil: null };
      case "popout_reply": ((window as unknown as { __popoutReplies?: unknown[] }).__popoutReplies ??= []).push({ to: a.to, id: a.id, ok: a.ok, data: a.data }); return null; // (the main window answers a request of a secondary window; the hand-over of a finished Reply, W13.13, travels this way: logged for checks)
      case "popout_open": {
        const w = window as unknown as { __popoutOpened?: unknown[]; __popoutOpens?: number; __popoutKeys?: Set<string> };
        (w.__popoutOpened ??= []).push({ kind: a.kind, key: a.key, init: a.init, focusOnly: !!a.focusOnly });
        // like the registry: a key that a window has is focused (and a "is one open?" question about another key finds none); windows never end in the preview
        const keys = (w.__popoutKeys ??= new Set<string>());
        const had = typeof a.key === "string" && a.key !== "" && keys.has(`${a.kind}|${a.key}`);
        if (had) return { status: "focused", label: "compose-1" };
        if (a.focusOnly) return { status: "none", label: null };
        w.__popoutOpens = (w.__popoutOpens ?? 0) + 1; // (windows asked for, not the "is one open?" questions)
        if (typeof a.key === "string" && a.key !== "") keys.add(`${a.kind}|${a.key}`);
        return { status: "created", label: "compose-1" };
      }
      case "popout_save_all": return true;
      // drag and drop between windows (W4.7): the registry of the backend (src-tauri/src/drag.rs), here in the memory of the page; `window.__dragCalls` logs the calls
      case "drag_begin": case "drag_peek": case "drag_take": case "drag_end": {
        const w = window as unknown as { __dragReg?: Map<string, unknown>; __dragCalls?: { cmd: string; token: unknown }[] };
        const reg = (w.__dragReg ??= new Map());
        (w.__dragCalls ??= []).push({ cmd, token: a.token });
        if (cmd === "drag_begin") reg.set(String(a.token), a.payload);
        const got = reg.get(String(a.token)) ?? null;
        if (cmd === "drag_take" || cmd === "drag_end") reg.delete(String(a.token));
        return cmd === "drag_peek" || cmd === "drag_take" ? got : null;
      }
      case "popout_focus": ((window as unknown as { __popoutCalls?: string[] }).__popoutCalls ??= []).push(cmd); return null;
      case "popout_ready": case "popout_flush_alive": case "popout_flush_dialog": case "popout_flush_done": case "popout_close": return null;
      case "update_defer": logUpdateCall({ cmd: "defer" }).kind = a.deferred ? "later" : "now"; return null;
      case "update_install": return mockInstall(!!a.restart, !!a.draftSaved);
      case "update_startup_ack": logUpdateCall({ cmd: "startupAck" }).kind = "ok"; return null;
      case "update_startup_state": {
        const t = hashTokens().get("afterupdate");
        return t === "fail" ? { outcome: "failed", version: "1.0.0", draft: false } : t ? { outcome: "updated", version: "1.0.0", draft: t === "draft" } : { outcome: null, version: null, draft: false };
      }
      case "outbox_busy": {
        // `#sending`: one message is "being sent" for 8 s after the first question
        if (!hashTokens().has("sending")) return false;
        if (!busyUntil) busyUntil = Date.now() + 8000;
        return Date.now() < busyUntil;
      }
      case "has_secret": return a.name === "ai_key" && mockSecrets.has("ai_key");
      case "google_env_configured": case "microsoft_env_configured": return false;
      case "microsoft_tenant": return "";
      case "discover_server": {
        const email = String(a.email ?? "");
        if (email.endsWith("@nowhere.test")) return null;
        const domain = email.split("@")[1] ?? "example.com";
        return { imapHost: `imap.${domain}`, imapPort: 993, imapSsl: true, smtpHost: `smtp.${domain}`, smtpPort: 587, smtpSecurity: "starttls", username: email, oauth: null, source: "autoconfig" };
      }
      case "set_secret": if (a.name === "ai_key" && (String(a.value ?? "") === "keyfail" || (!String(a.value ?? "") && hashHas("removefail")))) return later(200, () => { throw new Error("The credential store refused the request: the keychain is locked (OSStatus -25308)"); });
        if (a.name === "ai_key") { if (String(a.value ?? "")) mockSecrets.set("ai_key", String(a.value)); else mockSecrets.delete("ai_key"); } return null;
      // the headers an answer needs (the real command reads them from the server's copy): Reply-To only on the probe message
      // `window.__mockDelays.replyHeaders` (ms): the answer takes that long (a server round trip: connect, login, select, fetch; `replyHeadersFail`: it ends with an error then);
      // every call is counted on `window.__replyHeaderCalls` (1.0.7 W13.13)
      case "reply_headers": {
        const w = window as unknown as { __mockDelays?: MockDelays; __replyHeaderCalls?: { messageId: string; at: number }[] };
        (w.__replyHeaderCalls ??= []).push({ messageId: String(a.messageId), at: performance.now() });
        const out = a.messageId === "m-rt"
          ? { messageId: "<m-rt@acme.example>", references: ["<root@acme.example>", "<m-rt@acme.example>"], replyTo: ['"Acme Support" <support@acme.example>'], from: '"Acme No Reply" <no-reply@acme.example>', to: ["nam@example.com", '"Doe, John" <john@acme.example>', "JOHN@acme.example", "y@acme.example"], cc: ['"Cc, Person" <cc@acme.example>', "nam@gmail.com"] }
          : { messageId: `<${String(a.messageId)}@x>`, references: [`<${String(a.messageId)}@x>`], replyTo: [] };
        const ms = w.__mockDelays?.replyHeaders ?? 0;
        if (w.__mockDelays?.replyHeadersFail) return later(ms, () => { throw new Error("mock: the server did not answer"); });
        return ms > 0 ? later(ms, () => out) : out;
      }
      case "attachment_data": {
        // `window.__mockDelays.quote` (ms per call) and `.quoteFirst` (ms more for the first call of a message: the download of the raw message); `attachmentCalls` counts them
        const dw = window as unknown as { __mockDelays?: MockDelays; __attachmentCalls?: { messageId: string; index: number; at: number }[] };
        if (!a.internal && dw.__mockDelays && (dw.__mockDelays.quote || dw.__mockDelays.quoteFirst)) {
          const calls = (dw.__attachmentCalls ??= []);
          const first = !calls.some((c) => c.messageId === a.messageId);
          calls.push({ messageId: String(a.messageId), index: Number(a.index), at: performance.now() });
          return later((dw.__mockDelays.quote ?? 0) + (first ? dw.__mockDelays.quoteFirst ?? 0 : 0), () => handle("attachment_data", { ...a, internal: true }));
        }
        const att = ([m4, ...messages, ...mockLayerMsgs] as { id: string; attachments: { index: number; name: string; mime: string }[] }[]).find((x) => x.id === a.messageId)?.attachments.find((z) => z.index === a.index);
        const name = att?.name ?? "file.pdf";
        const mime = att?.mime ?? "application/pdf";
        // (a check sets window.__mockPdf = { "<attachment name>": "<base64>" } to preview another PDF: scripts/lib/pdf-fixtures.mjs)
        const own = (window as unknown as { __mockPdf?: Record<string, string> }).__mockPdf?.[name];
        return { name, mime, dataBase64: own ?? (mime.startsWith("image/") ? PIC : mime === "application/pdf" ? MOCK_PDF : btoa(`Mock contents of ${name}\n`)) };
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
            if (/^sign[-.]?only@/.test(addr)) return { address: addr, status: "signOnly" }; // (a key for sign-only@... can only sign: the dev preview's stand-in for the QA fixture sign-only.asc)
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
          { id: "local", name: "My events", color: "#8764b8", accountId: null, visible: !hiddenCals.has("local"), remote: false, writable: true },
          ...accounts.map((x) => { const into = foldedInto(`invites:${x.id}`); return { id: `invites:${x.id}`, name: `Invitations · ${x.email}`, color: x.color ?? "", accountId: x.id, visible: !hiddenCals.has(into ?? `invites:${x.id}`), remote: false, writable: false, foldedInto: into }; }),
          ...mockCalendars(),
        ];
      case "calendar_sources": return calAccounts().flatMap((m) => (calSrcs[m.account] ? [{ ...(calSrcs[m.account] as MockSrc), calendars: (calSrcs[m.account] as MockSrc).calendars.map((c) => ({ ...c, color: calColors[String(c.id)] ?? c.color, customColor: String(c.id) in calColors })) }] : []));
      case "calendar_kinds_available": {
        const k = /(^|&)calkinds=([a-z]+)/.exec(window.location.hash.slice(1))?.[2];
        // (CalDAV needs no OAuth client: it is in every build; `none` is a build without the Google and Microsoft clients)
        return k === "none" ? ["caldav"] : k === "google" || k === "microsoft" ? [k, "caldav"] : k === "caldav" ? ["caldav"] : ["google", "microsoft", "caldav"];
      }
      case "calendar_connect_caldav": {
        const w = window as unknown as { __mockDavConnects?: Record<string, unknown>[]; __mockCalSync?: { davDelay?: number } };
        const x = a.args as { accountId: string; service: string; url: string; username: string; password: string; useMailPassword: boolean; trustCert: boolean };
        (w.__mockDavConnects ??= []).push({ ...x });
        const url = x.service === "icloud" ? "https://caldav.icloud.com/" : x.service === "fastmail" ? "https://caldav.fastmail.com/" : x.url;
        const wait = Number(w.__mockCalSync?.davDelay) || (url.includes("slow") ? 3000 : 500);
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            if (!/^https:\/\//i.test(url)) return reject("CAL_DAV_HTTPS: Use an address that starts with https://.");
            if (url.includes("nowhere")) return reject("CAL_DAV_NOT_FOUND: No server answered at this address. Check the server address.");
            if (url.includes("plain")) return reject("CAL_DAV_NOT_CALDAV: This address doesn’t offer CalDAV calendars.");
            if (url.includes("empty")) return reject("CAL_DAV_NO_CALENDARS: This account has no calendars on the server.");
            if (url.includes("redirect")) return reject("CAL_DAV_REDIRECT: The server sent Hey Look! to another address (login.example.net). Hey Look! stopped there to keep your password safe.");
            if (url.includes("selfsigned") && !x.trustCert) return reject("CAL_DAV_CERT: The server’s certificate isn’t trusted.");
            if (x.password === "wrong") return reject("CAL_DAV_AUTH: Couldn’t sign in to the calendar server. Check the username and the password.");
            const acc = accounts.find((y) => y.id === x.accountId);
            let m = calAccounts().find((y) => y.account === x.accountId);
            if (!m) {
              m = { account: x.accountId, kind: "caldav", prefix: "caldav", email: acc?.email ?? "", service: "", dav: davOf(x.service, url, x.username) };
              extraCalAccounts.push(m);
            }
            m.dav = davOf(x.service, url, x.username);
            m.service = m.dav.label;
            mockCalState("ok", m.account);
            resolve(calSrcs[m.account]);
          }, wait);
        });
      }
      case "calendar_dav_password": {
        (((window as unknown as { __mockDavPasswords?: string[] }).__mockDavPasswords) ??= []).push(String(a.password));
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            if (a.password === "wrong") return reject("CAL_DAV_AUTH: Couldn’t sign in to the calendar server. Check the username and the password.");
            mockCalState("ok", String(a.accountId));
            resolve(calSrcs[String(a.accountId)]);
          }, 500);
        });
      }
      case "calendar_connect": {
        (((window as unknown as { __mockCalConnects?: string[] }).__mockCalConnects) ??= []).push(String(a.accountId));
        const target = mockCalAccount(String(a.accountId));
        const set = String(((window as unknown as { __mockCalSync?: { connectResult?: string } }).__mockCalSync?.connectResult) ?? "").replace(/^CAL_/i, "").toLowerCase();
        const fail = set && set !== "ok" && set !== "hang" ? (set === "wrong_account" ? "wrong" : set.replace("_", "")) : set ? undefined : /(^|&)calfail=([a-z]+)/.exec(window.location.hash.slice(1))?.[2];
        const slow = set === "hang" || (!set && hashHas("calslow"));
        const wait = Number((window as unknown as { __mockCalSync?: { connectDelay?: number } }).__mockCalSync?.connectDelay) || (set ? 400 : 1500);
        return new Promise((resolve, reject) => {
          calConnectCancel = () => reject("CAL_CANCELLED: Calendar sign-in was cancelled.");
          setTimeout(() => {
            if (slow) return; // waits for Cancel
            const errs: Record<string, string> = {
              denied: "CAL_DENIED: Calendar access wasn’t allowed. You can try again when you’re ready.",
              wrong: `CAL_WRONG_ACCOUNT: You allowed access for other@${target.email.split("@")[1]}. Sign in as ${target.email} to sync this mailbox’s calendar.`,
              partial: "CAL_PARTIAL: Hey Look! needs every calendar permission it asked for. Try again and keep all boxes ticked.",
              timeout: "CAL_TIMEOUT: Calendar sign-in timed out. You can try again when you’re ready.",
              blocked: `CAL_BLOCKED: ${target.email}’s organization may need to approve Hey Look! for calendar access. Ask your IT admin.`,
              error: "CAL_ERROR: Couldn’t turn on calendar sync: connection reset",
              notsetup: `CAL_NOT_SET_UP: This build of Hey Look! can’t sync calendars with ${target.kind === "google" ? "Google" : "Microsoft"}.`,
            };
            if (fail && errs[fail]) return reject(errs[fail]);
            mockCalState("ok", target.account);
            resolve(calSrcs[target.account]);
          }, wait);
        });
      }
      case "calendar_set_color": {
        const w = window as unknown as { __mockColors?: unknown[] };
        (w.__mockColors ??= []).push({ calendarId: a.calendarId, color: a.color ?? null });
        if (a.color) calColors[String(a.calendarId)] = String(a.color).toLowerCase();
        else delete calColors[String(a.calendarId)];
        return null;
      }
      case "calendar_create_calendar": {
        const w = window as unknown as { __mockCreates?: unknown[]; __mockCalSync?: { createDelay?: number } };
        (w.__mockCreates ??= []).push({ accountId: a.accountId, name: a.name, color: a.color ?? null });
        const m = calAccounts().find((y) => y.account === String(a.accountId));
        const src = m && calSrcs[m.account];
        if (!m || !src) throw "CAL_GONE: This calendar is no longer synced.";
        const name = String(a.name);
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            if (name.includes("[needsaccess]")) return reject(`CAL_NEEDS_ACCESS: To create calendars in ${m.service}, allow access again.`);
            if (name.includes("[fail]")) return reject(`CAL_ERROR: Couldn’t save to ${m.service}: the server refused it.`);
            const id = `${m.prefix}:${m.account}:new-${src.calendars.length + 1}`;
            src.calendars.push({ id, name, color: m.kind === "microsoft" ? "#0078d4" : "#0082c9", readOnly: false, primary: false, syncOn: true, eventCount: 0, truncated: false });
            if (a.color) calColors[id] = String(a.color).toLowerCase();
            resolve(src);
          }, Number(w.__mockCalSync?.createDelay) || 250);
        });
      }
      case "calendar_move_event": {
        const w = window as unknown as { __mockMoves?: unknown[]; __mockCalSync?: { moveDelay?: number } };
        (w.__mockMoves ??= []).push({ id: a.eventId, to: a.targetCalendarId });
        const e = calEvents.find((x) => x.id === a.eventId);
        const to = mockCalOfId(String(a.targetCalendarId));
        if (!e || !to) throw "CAL_GONE: This event is not part of a synced calendar.";
        const from = mockCalOfId(String(e.calendarId));
        if (((e.attendees as unknown[] | undefined) ?? []).length > 0 && (e.calendarId === "local" || from?.kind === "microsoft" || (from?.kind === "caldav" && from.dav?.scheduling))) {
          throw `CAL_MOVE_GUESTS: An event with guests can’t be moved to another calendar here. You can move it in ${to.service}.`;
        }
        if (String(e.summary).includes("[fail]")) throw `CAL_ERROR: Couldn’t save to ${to.service}: the server refused it.`;
        return new Promise((resolve) => {
          setTimeout(() => {
            e.calendarId = String(a.targetCalendarId);
            e.accountId = to.account;
            (e as unknown as Record<string, unknown>).remoteMock = true;
            (e as unknown as Record<string, unknown>).readOnly = null;
            resolve(e);
          }, Number(w.__mockCalSync?.moveDelay) || 250);
        });
      }
      case "calendar_cancel_connect": (window as unknown as { __mockCalCancels?: number }).__mockCalCancels = ((window as unknown as { __mockCalCancels?: number }).__mockCalCancels ?? 0) + 1; calConnectCancel?.(); calConnectCancel = null; return null;
      case "calendar_disconnect": mockCalState("off", String(a.accountId)); return null;
      case "calendar_set_sync": {
        const owner = mockCalOfId(String(a.calendarId));
        const c = owner && calSrcs[owner.account]?.calendars.find((x) => x.id === a.calendarId);
        if (owner && c) {
          c.syncOn = !!a.on;
          calEvents = calEvents.filter((e) => e.calendarId !== a.calendarId);
          if (a.on) calEvents = [...calEvents, ...syncedEvents(owner).filter((e) => e.calendarId === a.calendarId)];
        }
        return null;
      }
      case "calendar_sync_now": {
        for (const m of calAccounts()) {
          const cur = calSrcs[m.account];
          if (!cur || a.onlyIfStale || (a.accountId && a.accountId !== m.account)) continue;
          calSrcs[m.account] = { ...cur, status: "syncing", firstSync: false };
          setTimeout(() => { mockCalState("ok", m.account); void emit("calendar-changed", {}); }, 1200);
        }
        return null;
      }
      case "calendar_set_visible": if (a.visible) hiddenCals.delete(a.calendarId as string); else hiddenCals.add(a.calendarId as string); return null;
      case "calendar_list_events": {
        const from = a.from as number, to = a.to as number;
        return calEvents
          .filter((e) => !hiddenCals.has(foldedInto(e.calendarId) ?? e.calendarId) && !hiddenByTwin(e))
          .flatMap((e) => expandRow(asRow(e), from, to) as unknown as MockEvent[])
          .sort((x, y) => x.start - y.start);
      }
      case "calendar_get_event": {
        const e = calEvents.find((x) => x.id === a.id);
        if (!e) throw "event not found";
        if (a.scope) {
          const slot = typeof a.occurrenceStart === "number" ? a.occurrenceStart : null;
          // an Outlook series is asked for from the service: [offline] in its title is "no connection"
          const owner = mockCalOfId(String(e.calendarId));
          if (owner?.kind === "microsoft" && a.scope !== "occurrence" && String(e.summary).includes("[offline]")) {
            throw `CAL_OFFLINE: You’re offline. Changes to ${String(calSrcs[owner.account]?.calendars.find((c) => c.id === e.calendarId)?.name ?? "the calendar")} need a connection.`;
          }
          return getScoped(calEvents as unknown as SeriesRow[], e.id, a.scope as SeriesScope, slot);
        }
        return { ...e, series: !!(e.rrule || e.recurrenceId) };
      }
      case "calendar_save_event": {
        const inp = a.event as Record<string, unknown> & { id?: string | null; attendees: { email: string; name?: string }[]; accountId?: string };
        const guests = inp.attendees ?? [];
        const prev = inp.id ? calEvents.find((x) => x.id === inp.id) : undefined;
        const acct = accounts.find((x) => x.id === inp.accountId);
        const toCal = String(prev?.calendarId ?? (inp as { calendarId?: string }).calendarId ?? "local");
        const remote = mockCalOfId(toCal);
        if (remote) {
          // an event of a synced calendar: the "service" answers; no mail is sent by the app
          const title = String(inp.summary);
          const calName = String(calSrcs[remote.account]?.calendars.find((c) => c.id === toCal)?.name ?? "the calendar");
          if (title.includes("[offline]")) throw `CAL_OFFLINE: You’re offline. Changes to ${calName} need a connection.`;
          if (title.includes("[conflict]")) throw `CAL_CONFLICT: This event was changed in ${remote.service}, so its latest version is shown.`;
          if (title.includes("[gone]")) { calEvents = calEvents.filter((x) => x.id !== inp.id); throw `CAL_GONE: This event was deleted in ${remote.service}.`; }
          if (prev?.readOnly) throw "CAL_READ_ONLY: Only the organizer can change this event.";
          if (inp.scope) {
            const lockedRule = String(prev?.summary ?? "").includes("[pattern]");
            if (lockedRule && inp.scope !== "occurrence" && (inp.rrule ?? null) !== null) throw `CAL_READ_ONLY: Hey Look! can’t change this repeat rule. You can change it in ${remote.service}.`;
            const out = saveScoped(calEvents as unknown as SeriesRow[], inp as never, inp.scope as SeriesScope, () => `e${++eventSeq}`);
            calEvents = out.rows as unknown as MockEvent[];
            (((window as unknown as { __mockSeriesWrites?: unknown[] }).__mockSeriesWrites) ??= []).push({ scope: inp.scope, id: inp.id, occurrenceStart: inp.occurrenceStart ?? null });
            return seriesDelay(out.event);
          }
          const done = ev(prev?.id ?? `e${++eventSeq}`, title, inp.start as number, inp.end as number, {
            allDay: inp.allDay, tzid: inp.tzid ?? null, location: inp.location ?? null, description: inp.description ?? null, reminderMin: inp.reminderMin ?? null, rrule: inp.rrule ?? null, recurrenceText: inp.rrule ? "Repeats" : null,
            calendarId: toCal, accountId: remote.account, remoteMock: true, readOnly: null,
            attendees: guests.map((g) => ({ ...g, role: "required", status: "needs-action", isYou: false })),
          });
          calEvents = [...calEvents.filter((x) => x.id !== done.id), done];
          return done;
        }
        if (inp.scope) {
          const out = saveScoped(calEvents as unknown as SeriesRow[], inp as never, inp.scope as SeriesScope, () => `e${++eventSeq}`);
          calEvents = out.rows as unknown as MockEvent[];
          (((window as unknown as { __mockSeriesWrites?: unknown[] }).__mockSeriesWrites) ??= []).push({ scope: inp.scope, id: inp.id, occurrenceStart: inp.occurrenceStart ?? null, notify: !!a.notify });
          return seriesDelay(out.event);
        }
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
      case "calendar_delete_event": {
        const gone = calEvents.find((x) => x.id === a.id);
        if (gone?.readOnly) throw "CAL_READ_ONLY: Only the organizer can change this event.";
        (((window as unknown as { __mockDeletes?: unknown[] }).__mockDeletes) ??= []).push({ id: a.id, notify: !!a.notify, scope: a.scope ?? null, occurrenceStart: a.occurrenceStart ?? null });
        if (a.scope) {
          calEvents = deleteScoped(calEvents as unknown as SeriesRow[], String(a.id), a.scope as SeriesScope, typeof a.occurrenceStart === "number" ? a.occurrenceStart : null) as unknown as MockEvent[];
          return seriesDelay(null);
        }
        calEvents = calEvents.filter((x) => x.id !== a.id);
        return null;
      }
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
        (((window as unknown as { __mockApplied?: unknown[] }).__mockApplied) ??= []).push({ messageId: a.messageId, overrideAuth: !!a.overrideAuth });
        if (a.overrideAuth) {
          // Apply anyway: the held change is made, the card keeps its warning
          inv.held = false;
          if (inv.method === "CANCEL") inv.cancelled = true;
          else if (inv.method === "REPLY") inv.attendees = (inv.attendees as { email: string; status: string }[]).map((x) => (x.email === (inv.reply as { from: { email: string } }).from.email ? { ...x, status: (inv.reply as { status: string }).status } : x));
          else inv.changed = { fields: ["time"], previous: { start: inv.start as number, end: inv.end as number, location: null } };
          return calEvents.find((x) => x.id === inv.eventId) ?? ev(`e${++eventSeq}`, String(inv.summary), inv.start as number, inv.end as number, {});
        }
        const e = ev(`e${++eventSeq}`, String(inv.summary), inv.start as number, inv.end as number, { allDay: inv.allDay, tzid: inv.tzid, calendarId: "invites:a1", accountId: "a1", sourceMessageId: a.messageId as string, confidential: !!(inviteMsgs[a.messageId as string] as { confidential?: boolean }).confidential });
        calEvents = [...calEvents, e];
        inv.eventId = e.id;
        return e;
      }
      case "calendar_save_ics": return "C:/Users/Me/Documents/invite.ics";
      case "calendar_import_ics": return { added: 2, updated: 1 };
      case "calendar_open_message": return { threadId: "t15", folder: "inbox", accountId: "a1" };
      // the SIZE of the mail server (dev check of the size limit: window.__smtpSize = 10485760)
      // (__smtpSizeAfterRefusal: what the server says when it is asked again after a refused send, `refresh`)
      case "smtp_size_limit": { const w = window as unknown as { __smtpSize?: number; __smtpSizeAfterRefusal?: number; __sizeAsks?: boolean[] }; (w.__sizeAsks ??= []).push(!!a.refresh); return (a.refresh ? w.__smtpSizeAfterRefusal : undefined) ?? w.__smtpSize ?? null; }
      case "send_message": {
        // a subject with [fail] is rejected like Gmail rejects a program file (dev check of the failed-send path: __failedSendCheck)
        if (!a.sendAt && String((a.draft as { subject?: string }).subject).includes("[fail]")) throw "SMTP_ATTACHMENT_BLOCKED: The server rejected the attachment type. Gmail, Outlook and Yahoo refuse programs and scripts such as .exe, .bat, .js or .msi, even inside a zip file. Remove the attachment or share it as a link instead. (Server reply: (5.7.0 This message was blocked because its content presents a potential security issue. Please visit https://support.google.com/mail/?p=BlockedMessage to review our message content and attachment content guidelines. gsmtp)";
        // a subject with [smtpfail] is refused with the plain text a mail server gives (dev check of the failed-send path and its toast)
        if (!a.sendAt && String((a.draft as { subject?: string }).subject).includes("[smtpfail]")) throw "SMTP send failed: response error: incomplete response";
        if (!a.sendAt && String((a.draft as { subject?: string }).subject).includes("[toolarge]")) throw "SMTP_TOO_LARGE|reply=552 5.3.4 Message size exceeds fixed limit: The message is larger than this server accepts. Remove attachments or shrink pictures. (Server reply: 552 5.3.4 Message size exceeds fixed limit)";
        if (!a.sendAt) return (((window as unknown as { __sentMessages?: string[] }).__sentMessages ??= []).push(String((a.draft as { subject?: string }).subject)), "sent");
        // a scheduled message shows up in the Scheduled list
        const d = a.draft as { accountId: string; to: string[]; cc: string[]; subject: string; text?: string; attachments?: unknown[] };
        const id = `mock-${Math.random().toString(36).slice(2, 8)}`;
        mockOutbox.push({ id, accountId: d.accountId, to: d.to, cc: d.cc ?? [], subject: d.subject, snippet: (d.text ?? "").slice(0, 120), hasAttachments: !!d.attachments?.length, createdAt: now, attempts: 0, sendAt: a.sendAt as number, status: "pending", error: null });
        return `scheduled:${id}`;
      }
      case "suggest_contacts": return [{ name: "Linh Tran", email: "linh@example.com" }];
      case "ai_list_models": {
        // like the real command: a key typed in Settings but not saved yet wins over the saved one; `#modelsms=N` sets the answer time (500 ms default)
        const endpoint = String(a.endpoint);
        const key = String(a.key ?? "") || mockSecrets.get("ai_key") || "";
        if (endpoint.includes("bad")) throw "Models request failed (404 Not Found)"; // lets the error state be tried in the browser
        // a half-typed address cannot be reached; a "keyed" address needs a key (typed or saved); an "empty" one lists nothing
        if (!/^https?:\/\/[^/\s]+\.[a-z]{2,}(\/|$)/i.test(endpoint)) throw `error sending request for url (${endpoint}/models): error trying to connect: dns error: failed to lookup address information`;
        if (endpoint.includes("keyed") && !key) throw "Models request failed (401 Unauthorized)";
        return new Promise((r) => setTimeout(() => r(endpoint.includes("empty") ? [] : ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o3-mini", "text-embedding-3-small"]), hashNum("modelsms", 500)));
      }
      case "ai_complete": {
        // dev switches for the waiting states of an AI call: #slowai[=ms] answers after 20 s (or ms); #failai[=timeout|nokey|server|plain|auth|forbidden|model|url|busy|bad|network|total|cancelled|once] fails after 5 s (or #failaims=ms; "once": the first call only)
        const part = Number(/this is part (\d+)/.exec(String(a.system))?.[1] ?? 0);
        mockAiRequests.push({ id: String(a.jobId), part, chars: String(a.prompt).length });
        const reply = String(a.system).startsWith("Translate")
          ? `[${/into (.+?)\./.exec(String(a.system))?.[1] ?? "?"}${part ? ` · part ${part}` : ""}] ${String(a.prompt).slice(0, part ? 120 : 600)}`
          : "• Linh shared the Q4 roadmap\n• Review requested before Thursday";
        if (part && part === hashNum("failpart", 0) && (mockPartFails.get(part) ?? 0) < hashNum("failtimes", 2)) {
          mockPartFails.set(part, (mockPartFails.get(part) ?? 0) + 1);
          return new Promise((_, rej) => setTimeout(() => rej("AI_HTTP|status=503|detail=upstream overloaded: The AI Assistant returned an error (503): upstream overloaded"), 800));
        }
        const failMode = /(^|&)failai(?:=([a-z]+))?(&|$)/.exec(window.location.hash.slice(1));
        const failures: Record<string, string> = {
          timeout: "AI_TIMEOUT|secs=180: The AI Assistant didn’t answer within 180 seconds.",
          nokey: "AI_NOT_CONFIGURED: AI not configured: set endpoint and model in Settings > AI",
          server: "AI_HTTP|status=503|detail=upstream overloaded: The AI Assistant returned an error (503): upstream overloaded",
          plain: "AI_HTTP|v=plain|status=502: The AI Assistant returned an error (502).",
          // the problems the AI guidance toast sorts (src/aiProblem.ts); the words after the code are the backend's English text
          auth: "AI_HTTP|status=401|detail=Incorrect API key provided: …. You can find your API key at the provider.: The AI Assistant returned an error (401): Incorrect API key provided",
          forbidden: "AI_HTTP|v=plain|status=403: The AI Assistant returned an error (403).",
          model: "AI_HTTP|status=404|detail=The model `gpt-9` does not exist or you do not have access to it.: The AI Assistant returned an error (404): The model does not exist",
          url: "AI_HTTP|v=plain|status=404: The AI Assistant returned an error (404).",
          busy: "AI_HTTP|status=429|detail=Rate limit reached for requests.: The AI Assistant returned an error (429): Rate limit reached for requests.",
          bad: "AI_BAD_RESPONSE: The AI Assistant sent an answer the app can’t read.",
          network: "error sending request for url (https://api.example.com/v1/chat/completions): error trying to connect: dns error: failed to lookup address information",
          total: "AI_TIMEOUT_TOTAL|mins=15: The translation took longer than 15 minutes in all. Retry goes on where it stopped.",
          cancelled: "AI_CANCELLED: The AI Assistant request was cancelled.",
        };
        if (failMode && (failMode[2] !== "once" || ++mockAiCalls === 1)) {
          return new Promise((_, rej) => setTimeout(() => rej(failures[failMode[2] ?? ""] ?? failures.server), hashNum("failaims", 5000)));
        }
        if (hashHas("slowai")) return new Promise((r) => setTimeout(() => r(reply), hashNum("slowai", 20000)));
        return reply;
      }
      case "ai_cancel": mockAiCancelled.push(String(a.jobId)); return null;
      case "get_autostart": return { enabled: false, locked: hashTokens().get("autostartlock") === "user" || hashTokens().get("autostartlock") === "policy" ? hashTokens().get("autostartlock") : null }; // `#autostartlock=user|policy`: the Microsoft Store switch is locked (Settings > Notifications & tray)
      case "cancel_outbox": case "outbox_send_now": case "outbox_to_draft": {
        logOutbox(cmd, a);
        const i = mockOutbox.findIndex((x) => x.id === a.id);
        if (i >= 0) mockOutbox.splice(i, 1);
        return null;
      }
      case "outbox_update": case "outbox_reschedule": {
        logOutbox(cmd, a);
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
      case "outbox_release": {
        logOutbox(cmd, a);
        const o = mockOutbox.find((x) => x.id === a.id);
        if (o && o.status === "held") o.status = o.sendAt < now - 60 ? "overdue" : "pending";
        return null;
      }
      case "quit_now": return null;
      case "frame_info": return { custom: frame, snapLayouts: false };
      case "frame_caption_rect": return false; // no OS hit-testing in a browser: plain DOM buttons
      case "frame_system_menu": return null;
      default: return null;
    }
  }, { shouldMockEvents: true });
}
