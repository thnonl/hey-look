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
];

const body = (n: string) =>
  `<p>Hi Nam,</p><p>${n}</p><p>Best regards,<br>Linh</p><blockquote>Earlier message quoted here.</blockquote>`;

const messages = [
  { id: "m1", accountId: "a1", folder: "inbox", messageId: "<1@x>", subject: "Q4 roadmap review", fromName: "Linh Tran", fromEmail: "linh@example.com", to: "nam@example.com", cc: "", date: now - 3 * H, html: body("Attaching the latest roadmap deck."), text: "Attaching the latest roadmap deck.", seen: true, flagged: false, attachments: [{ index: 0, name: "roadmap-q4.pdf", mime: "application/pdf", size: 482113 }], canUnsubscribe: false },
  { id: "m2", accountId: "a1", folder: "inbox", messageId: "<2@x>", subject: "Re: Q4 roadmap review", fromName: "Nam", fromEmail: "nam@example.com", to: "linh@example.com", cc: "", date: now - 2 * H, html: body("Thanks, looking now."), text: "Thanks, looking now.", seen: true, flagged: false, attachments: [], canUnsubscribe: false },
  { id: "m3", accountId: "a1", folder: "inbox", messageId: "<3@x>", subject: "Re: Q4 roadmap review", fromName: "Linh Tran", fromEmail: "linh@example.com", to: "nam@example.com", cc: "", date: now - 0.5 * H, html: body("Could you review the milestones before Thursday? Also see the newsletter link <a href='https://example.com'>here</a>.<br><img id='remote1' src='https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png' width='200'>"), text: "Could you review the milestones before Thursday?", seen: false, flagged: false, attachments: [], canUnsubscribe: true },
];

const folders = ["inbox", "drafts", "sent", "archive", "junk", "trash"].flatMap((k, i) =>
  accounts.map((a) => ({ accountId: a.id, key: k, name: k, unread: k === "inbox" ? (a.id === "a1" ? 4 : 2) : 0, total: 10 + i })),
).concat([{ accountId: "a1", key: "f:Projects/Hey Look", name: "Projects/Hey Look", unread: 0, total: 5 }]);

const settings: Record<string, string> = {};

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
        return a.threadId === "t1" ? messages : a.threadId === "t4"
        ? [{ ...messages[0], id: "mt", subject: "Tall newsletter", html: "<html><head><style>html,body{height:100%;margin:0}</style></head><body><table width='100%' height='100%'><tr><td style='background:#f4f4f8'><div style='height:900px;background:linear-gradient(#e8a317,#2aa)'>tall block</div><p id='endmark'>THE END</p></td></tr></table></body></html>", attachments: [] }]
        : [{ ...messages[0], id: "mx", subject: "Hello", html: "<p>Hello from the mock backend.</p>", attachments: [] }];
      case "sync_account": return { added: 0, newInbox: [] };
      case "list_outbox": return [];
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
      case "attachment_data": return { name: "file.pdf", mime: "application/pdf", dataBase64: "" };
      case "send_message": return "sent";
      case "suggest_contacts": return [{ name: "Linh Tran", email: "linh@example.com" }];
      case "ai_list_models": {
        if (String(a.endpoint).includes("bad")) throw "Models request failed (404 Not Found)"; // lets the error state be tried in the browser
        return new Promise((r) => setTimeout(() => r(["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o3-mini", "text-embedding-3-small"]), 500));
      }
      case "ai_complete": return "• Linh shared the Q4 roadmap\n• Review requested before Thursday";
      case "get_autostart": return false;
      default: return null;
    }
  });
}
