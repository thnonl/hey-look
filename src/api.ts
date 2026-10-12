import { invoke } from "@tauri-apps/api/core";

export interface Account {
  id: string;
  email: string;
  displayName: string;
  imapHost: string;
  imapPort: number;
  imapSsl: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: "ssl" | "starttls" | "none";
  username: string;
}
export type AccountInput = Omit<Account, "id">;

export interface ThreadSummary {
  threadId: string;
  accountId: string;
  subject: string;
  participants: string[];
  snippet: string;
  lastDate: number;
  count: number;
  unread: number;
  flagged: boolean;
  pinned: boolean;
  snoozedUntil: number | null;
  hasAttach: boolean;
}

export interface MessageFull {
  id: string;
  accountId: string;
  folder: string;
  messageId: string | null;
  subject: string;
  fromName: string;
  fromEmail: string;
  to: string;
  cc: string;
  date: number;
  html: string | null;
  text: string | null;
  seen: boolean;
  flagged: boolean;
  hasAttach: boolean;
  canUnsubscribe: boolean;
}

export interface Att {
  filename: string;
  mime: string;
  dataBase64: string;
}

export interface Draft {
  accountId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  text: string;
  inReplyTo?: string | null;
  references: string[];
  attachments: Att[];
}

export interface OutboxItem {
  id: string;
  accountId: string;
  subject: string;
  to: string[];
  sendAt: number;
  status: string;
  error: string | null;
}

export interface Template {
  id: string;
  name: string;
  subject: string;
  body: string;
}
export interface Signature {
  id: string;
  name: string;
  html: string;
  isDefault: boolean;
}
export interface Contact {
  name: string;
  email: string;
}

export type FolderKey =
  | "inbox"
  | "unread"
  | "starred"
  | "pinned"
  | "snoozed"
  | "scheduled"
  | "sent"
  | "drafts"
  | "archive"
  | "trash"
  | "junk"
  | "all";

export const api = {
  listAccounts: () => invoke<Account[]>("list_accounts"),
  addAccount: (input: AccountInput, passwordValue: string) =>
    invoke<Account>("add_account", { input, passwordValue }),
  removeAccount: (accountId: string) => invoke<void>("remove_account", { accountId }),
  syncAccount: (accountId: string) => invoke<number>("sync_account", { accountId }),
  listThreads: (filter: { accountId?: string | null; folder: string; search?: string }) =>
    invoke<ThreadSummary[]>("list_threads", { filter }),
  getThread: (threadId: string) => invoke<MessageFull[]>("get_thread", { threadId }),
  threadAction: (threadIds: string[], action: string, arg?: string) =>
    invoke<void>("thread_action", { threadIds, action, arg: arg ?? null }),
  sendMessage: (draft: Draft, sendAt?: number | null) =>
    invoke<string>("send_message", { draft, sendAt: sendAt ?? null }),
  listOutbox: () => invoke<OutboxItem[]>("list_outbox"),
  cancelOutbox: (id: string) => invoke<void>("cancel_outbox", { id }),
  listTemplates: () => invoke<Template[]>("list_templates"),
  saveTemplate: (template: Template) => invoke<void>("save_template", { template }),
  deleteTemplate: (id: string) => invoke<void>("delete_template", { id }),
  listSignatures: () => invoke<Signature[]>("list_signatures"),
  saveSignature: (signature: Signature) => invoke<void>("save_signature", { signature }),
  deleteSignature: (id: string) => invoke<void>("delete_signature", { id }),
  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  setSetting: (key: string, value: string) => invoke<void>("set_setting", { key, value }),
  suggestContacts: (prefix: string) => invoke<Contact[]>("suggest_contacts", { prefix }),
  unsubscribe: (messageId: string) =>
    invoke<{ kind: "done" | "open" | "mailto"; target: string }>("unsubscribe", { messageId }),
  aiComplete: (system: string, prompt: string) => invoke<string>("ai_complete", { system, prompt }),
};

export const PROVIDERS: Record<
  string,
  { label: string; imapHost: string; imapPort: number; smtpHost: string; smtpPort: number; smtpSecurity: "ssl" | "starttls"; hint?: string }
> = {
  gmail: {
    label: "Gmail",
    imapHost: "imap.gmail.com",
    imapPort: 993,
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
    smtpSecurity: "ssl",
    hint: "Needs a Google App Password (2-Step Verification on).",
  },
  outlook: {
    label: "Outlook / Microsoft 365",
    imapHost: "outlook.office365.com",
    imapPort: 993,
    smtpHost: "smtp.office365.com",
    smtpPort: 587,
    smtpSecurity: "starttls",
    hint: "Basic auth must be enabled on the tenant; personal accounts need an app password.",
  },
  icloud: {
    label: "iCloud",
    imapHost: "imap.mail.me.com",
    imapPort: 993,
    smtpHost: "smtp.mail.me.com",
    smtpPort: 587,
    smtpSecurity: "starttls",
    hint: "Use an app-specific password from appleid.apple.com.",
  },
  yahoo: {
    label: "Yahoo",
    imapHost: "imap.mail.yahoo.com",
    imapPort: 993,
    smtpHost: "smtp.mail.yahoo.com",
    smtpPort: 465,
    smtpSecurity: "ssl",
    hint: "Use a Yahoo app password.",
  },
  custom: {
    label: "Other (IMAP/SMTP)",
    imapHost: "",
    imapPort: 993,
    smtpHost: "",
    smtpPort: 465,
    smtpSecurity: "ssl",
  },
};
