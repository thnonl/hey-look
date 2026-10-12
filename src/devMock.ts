// Dev-only: lets the UI run in a plain browser (npm run dev) with fake data, no Tauri backend.
import { mockIPC } from "@tauri-apps/api/mocks";
import { darkMessages, darkThreadRows } from "./devMockDark";

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
  t("t7", "Lotusmiles 10.2026 Account Statement", ["Lotusmiles"], "Your October statement: miles earned, activity and offers. View it in your browser if it does not display.", 6 * H, { unread: 1, hasAttach: false }),
  t("t8", "Monthly digest (620px layout)", ["Digest"], "A typical 620px wide newsletter layout, several screens tall.", 7 * H),
  ...darkThreadRows.map(([id, subject, snippet, ago]) => t(id, subject, ["Dark fixtures"], snippet, ago * H)),
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
        return darkThreads[a.threadId as string] ?? (a.threadId === "t1" ? messages : a.threadId === "t7"
        ? [{ ...messages[0], id: "ml", subject: "Lotusmiles 10.2026 Account Statement", fromName: "Lotusmiles", fromEmail: "news@lotusmiles.example", html: longMail(800), attachments: [], canUnsubscribe: true }]
        : a.threadId === "t8"
        ? [{ ...messages[0], id: "ml2", subject: "Monthly digest (620px layout)", fromName: "Digest", fromEmail: "digest@example.com", html: longMail(620), attachments: [], canUnsubscribe: false }]
        : a.threadId === "t4"
        ? [{ ...messages[0], id: "mt", subject: "Tall newsletter", html: "<html><head><style>html,body{height:100%;margin:0}</style></head><body><table width='100%' height='100%'><tr><td style='background:#f4f4f8'><div style='height:900px;background:linear-gradient(#e8a317,#2aa)'>tall block</div><p id='endmark'>THE END</p></td></tr></table></body></html>", attachments: [] }]
        : [{ ...messages[0], id: "mx", subject: "Hello", html: "<p>Hello from the mock backend.</p>", attachments: [] }]);
      case "sync_account": return { added: 0, newInbox: [] };
      case "list_outbox": return [];
      case "list_templates": return [{ id: "tp1", name: "Thanks", subject: "Thanks!", body: "<p>Thanks for your message.</p>" }, { id: "tp2", name: "Quarterly customer success follow-up with a deliberately very long template name", subject: "Follow-up", body: "<p>Hello</p>" }];
      case "list_signatures": return [{ id: "s1", name: "Work", html: "Nam<br>Hey Look!", isDefault: true }, { id: "s2", name: "Personal signature with a very long name that has to be cut with an ellipsis before it reaches the tag", html: "Nam", isDefault: false }];
      case "list_senders": return [{ email: "news@ph.com", name: "Product Hunt", count: 42, unread: 12, canUnsubscribe: true, lastDate: now - H }];
      case "list_rules": return [{ id: "r1", accountId: null, name: "Move newsletters", field: "from", op: "contains", value: "newsletter@example.com", action: "archive", arg: null, enabled: true }, { id: "r2", accountId: null, name: "", field: "subject", op: "contains", value: "a very long rule text that should be truncated in the list row", action: "trash", arg: null, enabled: false }];
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
