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
  auth: "password" | "oauth_google";
  color?: string | null;
}
export type AccountInput = Omit<Account, "id" | "auth" | "color">;

export interface ThreadSummary {
  threadId: string;
  rowKey: string;
  accountId: string;
  folder: string;
  bulk: boolean;
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
  attachments: AttMeta[];
  canUnsubscribe: boolean;
}

export interface AttMeta {
  index: number;
  name: string;
  mime: string;
  size: number;
}

export interface FolderInfo {
  accountId: string;
  key: string;
  name: string;
  unread: number;
  total: number;
}

export interface SenderInfo {
  email: string;
  name: string;
  count: number;
  unread: number;
  canUnsubscribe: boolean;
  lastDate: number;
}

export interface Rule {
  id: string;
  accountId?: string | null; // null = all accounts
  name: string;
  field: "from" | "to" | "subject" | "any";
  op: "contains" | "equals";
  value: string;
  action: "archive" | "trash" | "junk" | "read" | "star" | "pin" | "move";
  arg: string | null;
  enabled: boolean;
}

export interface NewMsg {
  threadId: string;
  accountId: string;
  from: string;
  subject: string;
  snippet: string;
  bulk: boolean;
}
export interface SyncResult {
  added: number;
  newInbox: NewMsg[];
}

export interface ThreadFilter {
  accountId?: string | null;
  folder: string;
  search?: string;
  focus?: "focused" | "other" | null;
  flat?: boolean;
  unreadOnly?: boolean;
  flaggedOnly?: boolean;
  sortAsc?: boolean;
  /** where a search looks: the open folder, every folder of the mailbox, or every folder of every account */
  scope?: SearchScope;
}

export type SearchScope = "current" | "account" | "all";

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
  accountId?: string | null; // null = all accounts
  name: string;
  subject: string;
  body: string;
}
export interface Signature {
  id: string;
  accountId?: string | null; // null = all accounts
  name: string;
  html: string;
  isDefault: boolean;
}
export interface Contact {
  name: string;
  email: string;
}

export type FolderKey = string;

export const api = {
  listAccounts: () => invoke<Account[]>("list_accounts"),
  addAccount: (input: AccountInput, passwordValue: string) =>
    invoke<Account>("add_account", { input, passwordValue }),
  googleEnvConfigured: () => invoke<boolean>("google_env_configured"),
  googleSignIn: (clientId: string, clientSecret: string, displayName: string) =>
    invoke<Account>("google_sign_in", { clientId, clientSecret, displayName }),
  updateAccount: (accountId: string, displayName: string, color: string | null) =>
    invoke<void>("update_account", { accountId, displayName, color }),
  removeAccount: (accountId: string) => invoke<void>("remove_account", { accountId }),
  refreshBadge: () => invoke<void>("refresh_badge"),
  testNotification: () => invoke<void>("test_notification"),
  getAutostart: () => invoke<boolean>("get_autostart"),
  setAutostart: (enabled: boolean) => invoke<void>("set_autostart", { enabled }),
  syncAccount: (accountId: string) => invoke<SyncResult>("sync_account", { accountId }),
  listFolders: () => invoke<FolderInfo[]>("list_folders"),
  listThreads: (filter: ThreadFilter) => invoke<ThreadSummary[]>("list_threads", { filter }),
  getThread: (threadId: string, scope?: string) =>
    invoke<MessageFull[]>("get_thread", { threadId, scope: scope ?? null }),
  threadAction: (threadIds: string[], action: string, arg?: string, scope?: string) =>
    invoke<void>("thread_action", { threadIds, action, arg: arg ?? null, scope: scope ?? null }),
  queueAction: (threadIds: string[], action: string, arg: string | null, scope: string | null, delaySecs: number) =>
    invoke<string>("queue_action", { threadIds, action, arg, scope, delaySecs }),
  cancelAction: (id: string) => invoke<boolean>("cancel_action", { id }),
  loadOlder: (accountId: string, role: string) => invoke<number>("load_older", { accountId, role }),
  attachmentData: (messageId: string, index: number) =>
    invoke<{ name: string; mime: string; dataBase64: string }>("attachment_data", { messageId, index }),
  setSecret: (name: "ai_key" | "google_client_secret", value: string) => invoke<void>("set_secret", { name, value }),
  hasSecret: (name: "ai_key" | "google_client_secret") => invoke<boolean>("has_secret", { name }),
  listSenders: (accountId?: string | null) => invoke<SenderInfo[]>("list_senders", { accountId: accountId ?? null }),
  senderAction: (accountId: string | null, email: string, action: string, arg?: string) =>
    invoke<number>("sender_action", { accountId, email, action, arg: arg ?? null }),
  listBlocked: () => invoke<string[]>("list_blocked"),
  unblock: (email: string) => invoke<void>("unblock", { email }),
  listRules: () => invoke<Rule[]>("list_rules"),
  saveRule: (rule: Rule) => invoke<void>("save_rule", { rule }),
  deleteRule: (id: string) => invoke<void>("delete_rule", { id }),
  getRaw: (messageId: string) => invoke<string>("get_raw", { messageId }),
  saveAttachments: (messageId: string, index?: number) =>
    invoke<string[]>("save_attachments", { messageId, index: index ?? null }),
  sendMessage: (draft: Draft, sendAt?: number | null, replaces?: string | null) =>
    invoke<string>("send_message", { draft, sendAt: sendAt ?? null, replaces: replaces ?? null }),
  saveDraft: (draft: Draft, replaces?: string | null) =>
    invoke<void>("save_draft", { draft, replaces: replaces ?? null }),
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
  fetchRemoteImages: (urls: string[]) => invoke<Record<string, string>>("fetch_remote_images", { urls }),
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
