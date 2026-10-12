// Dev-only: lets the UI run in a plain browser (npm run dev) with fake data, no Tauri backend.
import { mockIPC } from "@tauri-apps/api/mocks";

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

const body = (n: string) =>
  `<p>Hi Nam,</p><p>${n}</p><p>Best regards,<br>Linh</p><blockquote>Earlier message quoted here.</blockquote>`;

const fpr = (seed: string) => {
  let h = 0x811c9dc5;
  let out = "";
  for (let i = 0; out.length < 40; i++) {
    h = Math.imul(h ^ (seed.charCodeAt(i % seed.length) + i), 16777619) >>> 0;
    out += h.toString(16).toUpperCase().padStart(8, "0");
  }
  return out.slice(0, 40);
};
type MockKey = {
  fingerprint: string; keyId: string; userIds: string[]; algo: string; created: number; expires: number | null; expired: boolean; revoked: boolean;
  hasSecret: boolean; verified: boolean; source: string; passphraseRemembered: boolean; unlocked: boolean; defaultFor: string[]; protected: boolean;
};
const mkKey = (uid: string, over: Partial<MockKey> = {}): MockKey => {
  const f = fpr(uid);
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
).concat([{ accountId: "a1", key: "f:Projects/Hey Look", name: "Projects/Hey Look", unread: 0, total: 5 }]);

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

export function installMock() {
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
        return f.folder === "inbox" || f.folder === "unread" || f.folder === "all" ? list : [];
      }
      case "get_thread":
        if (a.threadId === "t9") return [ownLocked ? lockedMsg() : openedMsg()];
        if (mockThreadMsgs[a.threadId as string]) return mockThreadMsgs[a.threadId as string];
        return a.threadId === "t7" ? [m4] : a.threadId === "t1" ? messages : a.threadId === "t4"
        ? [{ ...messages[0], id: "mt", subject: "Tall newsletter", html: "<html><head><style>html,body{height:100%;margin:0}</style></head><body><table width='100%' height='100%'><tr><td style='background:#f4f4f8'><div style='height:900px;background:linear-gradient(#e8a317,#2aa)'>tall block</div><p id='endmark'>THE END</p></td></tr></table></body></html>", attachments: [] }]
        : [{ ...messages[0], id: "mx", subject: "Hello", html: "<p>Hello from the mock backend.</p>", attachments: [] }];
      case "sync_account": return { added: 0, newInbox: [] };
      case "list_outbox": return mockOutbox;
      case "outbox_pending_count": return { count: mockOutbox.filter((o) => o.status !== "failed").length, next: now + 3 * H };
      case "outbox_open_for_edit": {
        const o = mockOutbox.find((x) => x.id === a.id) ?? mockOutbox[0];
        return { draft: mockDraftOf(o), sendAt: o.sendAt, status: o.status === "pending" || o.status === "overdue" ? "held" : o.status };
      }
      case "list_templates": return [{ id: "tp1", name: "Thanks", subject: "Thanks!", body: "<p>Thanks for your message.</p>" }];
      case "list_signatures": return [{ id: "s1", name: "Work", html: "Nam<br>Hey Look!", isDefault: true }];
      case "list_senders": return [{ email: "news@ph.com", name: "Product Hunt", count: 42, unread: 12, canUnsubscribe: true, lastDate: now - H }];
      case "list_rules": return [];
      case "list_blocked": return [];
      case "thread_action": return new Promise((r) => setTimeout(() => r(null), 600)); // slow like IMAP
      case "save_draft": case "update_account": return null;
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
        const k = mkKey(`${acct.displayName} <${acct.email}>`, { hasSecret: true, verified: true, source: "generated", algo: a.algo === "rsa3072" ? "RSA 3072" : "Ed25519 / Curve25519", defaultFor: [acct.id], expires: a.expiresDays ? now + (a.expiresDays as number) * 86400 : null, created: now });
        pgpKeys = [k, ...pgpKeys.filter((x) => x.fingerprint !== k.fingerprint)];
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
        return openedMsg();
      }
      case "send_message": return a.sendAt ? `scheduled:mock-${Math.random().toString(36).slice(2, 8)}` : "sent";
      case "suggest_contacts": return [{ name: "Linh Tran", email: "linh@example.com" }];
      case "ai_list_models": {
        if (String(a.endpoint).includes("bad")) throw "Models request failed (404 Not Found)"; // lets the error state be tried in the browser
        return new Promise((r) => setTimeout(() => r(["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o3-mini", "text-embedding-3-small"]), 500));
      }
      case "ai_complete": return "• Linh shared the Q4 roadmap\n• Review requested before Thursday";
      case "get_autostart": return false;
      case "outbox_to_draft": case "cancel_outbox": case "outbox_release": case "outbox_update": case "outbox_reschedule":
      case "outbox_retry": case "outbox_send_now": case "quit_now": return null;
      default: return null;
    }
  });
}
