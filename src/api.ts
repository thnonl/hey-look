import { Channel, invoke } from "@tauri-apps/api/core";
import { t } from "./i18n";
import type { RecoveredDraft, RecoveryInfo, RecoveryLoaded, SnapshotOut } from "./recovery";
import type { Importance } from "./importance";

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
  /** SMTP login when it differs from `username` (empty = same). */
  smtpUsername: string;
  /** Server certificate is not verified (self-signed / private CA). */
  tlsInsecure: boolean;
  auth: "password" | "oauth_google" | "oauth_microsoft";
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
  /** PGP: at least one message of the conversation is encrypted / signed */
  encrypted?: boolean;
  signed?: boolean;
  /** the sender labelled a message of the conversation confidential */
  confidential?: boolean;
  /** a message of the conversation carries a calendar invitation / reply / cancellation */
  invite?: "request" | "reply" | "cancel" | null;
  /** the sender marked a message of the conversation High or Low importance (high wins); absent = normal */
  importance?: Importance;
}

/** What an answer to a message needs from the message's own headers (read from the server's copy). */
export interface ReplyHeaders {
  messageId: string | null;
  /** References of the answer: the message's References (else its In-Reply-To) plus its Message-ID, cut to a sensible length */
  references: string[];
  /** the Reply-To addresses that are real addresses, as `Name <address>` / `address` */
  replyTo: string[];
  /** From / To / Cc as the headers write them (`"Doe, John" <john@x.test>`): the stored message keeps the addresses only */
  from?: string | null;
  to?: string[];
  cc?: string[];
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
  /** PGP state; null for ordinary mail */
  security?: MessageSecurity | null;
  /** labelled confidential by the sender: no screen capture, copy, print, save or forward */
  confidential?: boolean;
  /** calendar invitation, update, cancellation or reply carried by this message */
  invite?: CalInvite | null;
  /** how the sender marked it; a reopened draft starts Compose with it */
  importance?: Importance;
}

export type SigStatus = "valid" | "invalid" | "unknown_key" | "expired_key" | "revoked_key";

export interface SigInfo {
  status: SigStatus;
  signer?: string | null;
  fingerprint?: string | null;
  keyId: string;
  signedAt?: number | null;
  verified: boolean;
  matchesFrom: boolean;
  inline: boolean;
}

export interface MessageSecurity {
  encrypted: boolean;
  partial: boolean;
  decryption: "ok" | "locked" | "no_key" | "error" | "none";
  lockedKey?: string | null;
  lockedLabel?: string | null;
  encryptedFor: string[];
  error?: string | null;
  cipher?: string | null;
  signature?: SigInfo | null;
}

// ---- calendar
export type Rsvp = "accepted" | "tentative" | "declined";
export type PartStat = Rsvp | "needs-action" | "delegated";
export interface CalPerson { email: string; name?: string | null }
export interface CalAttendee extends CalPerson {
  role: "chair" | "required" | "optional";
  status: PartStat;
  isYou?: boolean;
}
export interface CalInvite {
  method: "REQUEST" | "CANCEL" | "REPLY" | "PUBLISH" | "COUNTER" | "OTHER";
  uid: string;
  sequence: number;
  summary: string;
  /** epoch seconds (UTC). All-day events: UTC midnight of the date. */
  start: number;
  end: number;
  allDay: boolean;
  /** IANA zone the organizer wrote the time in */
  tzid: string | null;
  location: string | null;
  joinUrl: string | null;
  description: string | null;
  organizer: CalPerson | null;
  attendees: CalAttendee[];
  rrule: string | null;
  recurrenceText: string | null;
  you: { email: string; status: PartStat | "organizer"; onList: boolean } | null;
  responded: { status: Rsvp; sentAt: number | null } | null;
  changed: null | { fields: ("time" | "location" | "details")[]; previous: { start: number; end: number; location: string | null } };
  reply: null | { from: CalPerson; status: PartStat; comment: string | null };
  eventId: string | null;
  ended: boolean;
  cancelled: boolean;
  /** a newer version of this invitation arrived */
  outdated: boolean;
  conflicts: { eventId: string; summary: string; start: number; end: number }[];
  parseError: string | null;
  /** the invitation was over a size cap and some details (repeat rule, guests, excluded dates) were not imported */
  trimmed?: boolean;
}
export interface CalEvent {
  id: string;
  uid: string;
  /** "local" | "invites:<accountId>" */
  calendarId: string;
  accountId: string | null;
  summary: string;
  start: number;
  end: number;
  allDay: boolean;
  tzid: string | null;
  location: string | null;
  joinUrl: string | null;
  description: string | null;
  organizer: CalPerson | null;
  attendees: CalAttendee[];
  rrule: string | null;
  recurrenceText: string | null;
  status: "confirmed" | "tentative" | "cancelled";
  myStatus: PartStat | "organizer" | null;
  respondedAt: number | null;
  reminderMin: number | null;
  sourceMessageId: string | null;
  sequence: number;
  /** made from confidential mail: can't be exported or copied */
  confidential?: boolean;
  /** set on expanded occurrences of a repeating event */
  instanceStart?: number | null;
  /** an event of a synced calendar that can't be changed here, and why */
  readOnly?: "calendar" | "repeating" | "organizer" | null;
}
export interface CalEventInput {
  id?: string | null;
  accountId?: string | null;
  summary: string;
  start: number;
  end: number;
  allDay: boolean;
  tzid?: string | null;
  location?: string | null;
  description?: string | null;
  attendees: { email: string; name?: string | null; role: "required" | "optional" }[];
  rrule?: string | null;
  reminderMin?: number | null;
  /** the calendar a new event goes to ("local" or null = My events); fixed when editing */
  calendarId?: string | null;
}
export interface CalendarInfo {
  id: string;
  name: string;
  color: string;
  accountId: string | null;
  visible: boolean;
  /** a calendar synced from Google Calendar / Outlook */
  remote?: boolean;
  /** new events can be added to it */
  writable?: boolean;
  /** "Google Calendar" / "Outlook" for a synced calendar */
  service?: string | null;
}
/** One calendar of a synced mailbox, as Settings lists it. */
export interface CalendarSyncInfo { id: string; name: string; color: string; readOnly: boolean; primary: boolean; syncOn: boolean; eventCount: number; truncated: boolean }
/** The calendar sync of one mailbox: its state and calendars. */
export interface CalSource {
  id: string;
  accountId: string;
  kind: "google" | "microsoft" | "caldav";
  status: "ok" | "syncing" | "offline" | "busy" | "auth" | "blocked" | "notsetup" | "error";
  lastSync: number | null;
  lastError: string | null;
  retryAt: number | null;
  /** the first download is running */
  firstSync: boolean;
  calendars: CalendarSyncInfo[];
}
export interface Meeting {
  start: number;
  end: number;
  allDay: boolean;
  tzid: string | null;
  location: string | null;
  rrule?: string | null;
}

export type KeyAlgo = "cv25519" | "rsa3072";
export type KeyStatus = "ok" | "missing" | "expired" | "revoked";

export interface PgpKey {
  /** 40 hex characters, no spaces */
  fingerprint: string;
  keyId: string;
  userIds: string[];
  algo: string;
  created: number;
  expires: number | null;
  expired: boolean;
  revoked: boolean;
  hasSecret: boolean;
  verified: boolean;
  source: "generated" | "file" | "paste" | "email";
  passphraseRemembered: boolean;
  unlocked: boolean;
  defaultFor: string[];
  /** the stored secret key is passphrase-protected */
  protected: boolean;
}

export interface KeyInspect {
  keys: PgpKey[];
  isSecret: boolean;
  needsNewPassphrase: boolean;
  alreadyKnown: string[];
}

export interface RecipientStatus {
  address: string;
  status: KeyStatus;
  fingerprint?: string | null;
  verified?: boolean | null;
  expires?: number | null;
}

export interface OwnKeyStatus {
  fingerprint: string;
  canSign: boolean;
  canEncrypt: boolean;
  unlocked: boolean;
  expired: boolean;
}

export interface DraftSecurity {
  encrypt: boolean;
  sign: boolean;
  attachPublicKey: boolean;
}

export interface AttMeta {
  index: number;
  name: string;
  mime: string;
  size: number;
  /** the part has a Content-ID (a picture placed in the body, or another cid part) */
  inline?: boolean;
  cid?: string | null;
  /** the message body refers to the part (cid:) */
  referenced?: boolean;
}

/** A picture inside the message body (sent as a related part with Content-ID). */
export interface InlineImage {
  cid: string;
  filename: string;
  mime: string;
  dataBase64: string;
}

export interface FolderInfo {
  accountId: string;
  key: string;
  name: string;
  unread: number;
  total: number;
  /** the account's saved folder list names a server folder for this row (false for Junk: hide it, Junk is never created) */
  listed?: boolean;
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

export interface LoadOlderResult {
  added: number;
  /** the server has nothing older in that folder */
  exhausted: boolean;
  /** the "Max emails to download" cap stopped it (not the server): raising the cap lets it continue */
  limited: boolean;
}

/** Event `backfill-progress`: the background download of older Inbox mail (in chunks of 50). */
export interface BackfillProgress {
  accountId: string;
  role: string;
  have: number;
  target: number;
  done: boolean;
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
  /** pictures in the body; the html refers to them as cid:<cid> */
  inline?: InlineImage[];
  /** Encrypt / sign (PGP/MIME). Errors: PGP_MISSING_KEYS:<a,b> / PGP_LOCKED:<fpr> / PGP_NO_KEY / PGP_FAILED */
  security?: DraftSecurity;
  /** a meeting made in Compose: the backend creates the event and adds the calendar invitation */
  meeting?: Meeting;
  /** send as confidential (Sensitivity: Company-Confidential) */
  confidential?: boolean;
  /** High / Low add the importance headers; absent = Normal (no header) */
  importance?: Importance;
  /** only for Save draft: the id of the message's crash-recovery snapshot, written into the draft's Message-ID so the next start finds it again (recover.rs) */
  recoveryId?: string;
  /** the meeting switch of Compose as saved with a draft (base64url JSON, meetingDraft.ts): the draft's private header `X-HeyLook-Meeting`; never part of a sent message */
  meetingForm?: string;
}

/** What Save draft says: the conversation the draft will be in once the sync has read it, and the reference that makes the next save (or a send) replace exactly this draft. */
export interface DraftSaveResult {
  threadId: string | null;
  draftRef: string | null;
}

export type OutboxStatus = "pending" | "held" | "sending" | "failed" | "overdue";

export interface OutboxItem {
  id: string;
  accountId: string;
  subject: string;
  to: string[];
  cc: string[];
  snippet: string;
  hasAttachments: boolean;
  sendAt: number;
  createdAt: number;
  status: OutboxStatus;
  error: string | null;
  attempts: number;
}

export interface OutboxEdit {
  draft: Draft;
  sendAt: number;
  status: OutboxStatus;
}

export interface SaveAllResult {
  dir: string;
  saved: string[];
  failed: { index: number; name: string; error: string }[];
}

/** Backend errors look like "CODE: human text". Returns the code, or null. */
export function errorCode(e: unknown): string | null {
  const m = String(e instanceof Error ? e.message : e).match(/^([A-Z][A-Z0-9_]+)(?:\|[A-Za-z]\w*=[^|:]*)*:/);
  return m ? m[1] : null;
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

/** Result of the server-settings lookup for an email address. */
export interface Discovered {
  imapHost: string;
  imapPort: number;
  imapSsl: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: "ssl" | "starttls";
  username: string;
  oauth: "google" | "microsoft" | null;
  source: "built-in" | "autoconfig" | "ispdb" | "dns-srv" | "mx" | "guess";
}

export type SecretName = "ai_key" | "google_client_secret" | "microsoft_client_secret";

export interface FrameInfo {
  custom: boolean;
  snapLayouts: boolean;
}

/** What `popout_open` answers: a window was made, one that already shows the key was focused, the cap of 8 windows is reached, or (focus-only ask) no window has the key. */
export interface PopoutOpened {
  status: "created" | "focused" | "tooMany" | "none";
  label: string | null;
}
/** What a secondary window learns about itself (`popout_init`). */
export interface PopoutInfo {
  kind: "compose" | "reader";
  label: string;
  key: string | null;
  /** the hand-off data the opener left in the backend (never in the address) */
  init: unknown;
}

export const api = {
  frameInfo: () => invoke<FrameInfo>("frame_info"),
  /** Reports the caption button group (CSS px); true = the OS hit-tests it (Snap Layouts, press/hover via events). */
  frameCaptionRect: (r: { x: number; y: number; w: number; h: number }) => invoke<boolean>("frame_caption_rect", { ...r, dpr: window.devicePixelRatio || 1 }),
  frameSystemMenu: (x: number, y: number) => invoke<void>("frame_system_menu", { x, y, dpr: window.devicePixelRatio || 1 }),
  listAccounts: () => invoke<Account[]>("list_accounts"),
  /** account id -> "push" (IMAP IDLE is running) or "polling"; an account without an entry is polled */
  idleStates: () => invoke<Record<string, string>>("idle_states"),
  addAccount: (input: AccountInput, passwordValue: string, smtpPassword?: string) =>
    invoke<Account>("add_account", { input, passwordValue, smtpPassword: smtpPassword || null }),
  /** "Cancel" while the add account form waits: the attempt stops before it stores anything */
  cancelAddAccount: () => invoke<void>("cancel_add_account"),
  discoverServer: (email: string) => invoke<Discovered | null>("discover_server", { email }),
  googleEnvConfigured: () => invoke<boolean>("google_env_configured"),
  googleSignIn: (clientId: string, clientSecret: string, displayName: string) =>
    invoke<Account>("google_sign_in", { clientId, clientSecret, displayName }),
  microsoftEnvConfigured: () => invoke<boolean>("microsoft_env_configured"),
  microsoftTenant: () => invoke<string>("microsoft_tenant"),
  microsoftSignIn: (clientId: string, clientSecret: string, tenant: string, displayName: string) =>
    invoke<Account>("microsoft_sign_in", { clientId, clientSecret, tenant, displayName }),
  /** End the wait for the browser of a mail sign-in (Add account, Sign in again); that command then fails with OAUTH_CANCELLED. */
  oauthCancel: () => invoke<void>("oauth_cancel"),
  /** Sign in again to a mailbox whose sign-in ended: the same address, the same account (nothing is added). */
  reauthAccount: (accountId: string) => invoke<Account>("reauth_account", { accountId }),
  updateAccount: (accountId: string, displayName: string, color: string | null) =>
    invoke<void>("update_account", { accountId, displayName, color }),
  removeAccount: (accountId: string) => invoke<void>("remove_account", { accountId }),
  refreshBadge: () => invoke<void>("refresh_badge"),
  testNotification: () => invoke<void>("test_notification"),
  /** a link in the default browser or mail program, with a checked launch (Linux only; see open.ts) */
  openExternal: (url: string) => invoke<void>("open_external", { url }),
  /** text on the system clipboard through the backend (Linux only; see open.ts) */
  copyText: (text: string) => invoke<void>("copy_text", { text }),
  /** the text and the HTML on the system clipboard through the backend (macOS only: Cmd+Shift+V in the editors, see editor/pasteOptions.tsx) */
  readClipboardText: () => invoke<{ text: string; html: string }>("read_clipboard_text"),
  getAutostart: () => invoke<boolean>("get_autostart"),
  setAutostart: (enabled: boolean) => invoke<void>("set_autostart", { enabled }),
  syncAccount: (accountId: string) => invoke<SyncResult>("sync_account", { accountId }),
  listFolders: () => invoke<FolderInfo[]>("list_folders"),
  listThreads: (filter: ThreadFilter) => invoke<ThreadSummary[]>("list_threads", { filter }),
  getThread: (threadId: string, scope?: string) =>
    invoke<MessageFull[]>("get_thread", { threadId, scope: scope ?? null }),
  threadAction: (threadIds: string[], action: string, arg?: string, scope?: string) =>
    invoke<void>("thread_action", { threadIds, action, arg: arg ?? null, scope: scope ?? null }),
  /**
   * Finds or creates the folder a move goes to, on the server, before the move is queued; rejects when it cannot (nothing is moved).
   * Resolves true when the saved folder list was trusted for a folder: pass that to `queueAction` as `verify`.
   */
  prepareAction: (threadIds: string[], action: string, arg: string | null, scope: string | null) =>
    invoke<boolean>("prepare_action", { threadIds, action, arg, scope }),
  /** `verify`: the backend checks the saved folder on the server during the Undo window and drops the move (`action-verify-failed`) when it is gone. */
  queueAction: (threadIds: string[], action: string, arg: string | null, scope: string | null, delaySecs: number, verify = false) =>
    invoke<string>("queue_action", { threadIds, action, arg, scope, delaySecs, verify }),
  cancelAction: (id: string) => invoke<boolean>("cancel_action", { id }),
  /** Downloads up to `limit` (max 50) messages older than what is stored. Rejects with the server's error; never turns it into "none". */
  loadOlder: (accountId: string, role: string, limit = 50) => invoke<LoadOlderResult>("load_older", { accountId, role, limit }),
  attachmentData: (messageId: string, index: number) =>
    invoke<{ name: string; mime: string; dataBase64: string }>("attachment_data", { messageId, index }),
  setSecret: (name: SecretName, value: string) => invoke<void>("set_secret", { name, value }),
  hasSecret: (name: SecretName) => invoke<boolean>("has_secret", { name }),
  listSenders: (accountId?: string | null) => invoke<SenderInfo[]>("list_senders", { accountId: accountId ?? null }),
  senderAction: (accountId: string | null, email: string, action: string, arg?: string) =>
    invoke<number>("sender_action", { accountId, email, action, arg: arg ?? null }),
  listBlocked: () => invoke<string[]>("list_blocked"),
  unblock: (email: string) => invoke<void>("unblock", { email }),
  listRules: () => invoke<Rule[]>("list_rules"),
  saveRule: (rule: Rule) => invoke<void>("save_rule", { rule }),
  deleteRule: (id: string) => invoke<void>("delete_rule", { id }),
  getRaw: (messageId: string) => invoke<string>("get_raw", { messageId }),
  replyHeaders: (messageId: string) => invoke<ReplyHeaders>("reply_headers", { messageId }),
  saveAttachments: (messageId: string, index?: number) =>
    invoke<string[]>("save_attachments", { messageId, index: index ?? null }),
  attachmentSaveAs: (messageId: string, index: number) =>
    invoke<string | null>("attachment_save_as", { messageId, index }),
  attachmentSaveAll: (messageId: string, ask: boolean, jobId?: string) =>
    invoke<SaveAllResult | null>("attachment_save_all", { messageId, ask, jobId: jobId ?? null }),
  /** Opens a temp copy with the default app. Programs and scripts need confirmed = true. */
  attachmentOpen: (messageId: string, index: number, confirmed = false) =>
    invoke<string>("attachment_open", { messageId, index, confirmed }),
  attachmentReveal: (path: string) => invoke<void>("attachment_reveal", { path }),
  pickFolder: (title?: string) => invoke<string | null>("pick_folder", { title: title ?? null }),
  inlineImage: (messageId: string, cid: string) =>
    invoke<{ mime: string; dataBase64: string; name: string }>("inline_image", { messageId, cid }),
  /** The SIZE the SMTP server of the account names in its EHLO reply (bytes); null when it names none or could not be asked. */
  smtpSizeLimit: (accountId: string, refresh = false) => invoke<number | null>("smtp_size_limit", { accountId, refresh }),
  sendMessage: (draft: Draft, sendAt?: number | null, replaces?: string | null) =>
    invoke<string>("send_message", { draft, sendAt: sendAt ?? null, replaces: replaces ?? null }),
  /**
   * `replaces`: the draft this one takes the place of, a reference: `m:<message id>` of a draft that was opened, or the `draftRef` of an
   * earlier save. Only that message is removed (a plain conversation id removes every draft of the conversation).
   */
  saveDraft: (draft: Draft, replaces?: string | null) =>
    invoke<DraftSaveResult>("save_draft", { draft, replaces: replaces ?? null }),
  /** Remove the draft a reference names (Discard on a new message whose save made a draft). */
  discardDraft: (reference: string) => invoke<void>("discard_draft", { reference }),
  /** Crash recovery of the message being written (recover.rs): the snapshot is kept until the message is sent, discarded or saved. */
  recoverySave: (snap: SnapshotOut) => invoke<void>("recovery_save", { snap }),
  /** `why` is for startup.log only ("draft saved" = the server has the text, otherwise the message is over). */
  recoveryClear: (id: string, why?: string) => invoke<void>("recovery_clear", { id, why: why ?? null }),
  recoveryList: () => invoke<RecoveryInfo[]>("recovery_list"),
  recoveryLoad: (id: string) => invoke<RecoveryLoaded | null>("recovery_load", { id }),
  /** The start saves a snapshot as a real draft (replacing the draft it takes the place of, never joining a draft of the same message) and removes it once the draft is confirmed. Rejects when that cannot be done: the snapshot stays. */
  recoverySaveDraft: (id: string, draft: Draft, replaces: string | null) => invoke<RecoveredDraft>("recovery_save_draft", { id, draft, replaces }),
  /** To / Cc / Bcc of a saved draft with the display names, read from the draft's own headers (the synced copy has bare addresses and no Bcc). */
  draftRecipients: (messageId: string) => invoke<{ to: string[]; cc: string[]; bcc: string[]; inReplyTo?: string | null; references?: string[]; meeting?: string | null }>("draft_recipients", { messageId }),
  listOutbox: () => invoke<OutboxItem[]>("list_outbox"),
  cancelOutbox: (id: string) => invoke<void>("cancel_outbox", { id }),
  /** Send was pressed with an Undo time: the message goes into the local outbox (not a scheduled message) until `dueAt` (unix seconds). */
  outboxHold: (draft: Draft, dueAt: number, replaces?: string | null) => invoke<string>("outbox_hold", { draft, dueAt, replaces: replaces ?? null }),
  /** The Undo time of a held message is over (or a quit ends it): send it. `keep`: if that fails the row stays for the next start (quit). */
  outboxHoldSend: (id: string, keep: boolean) => invoke<void>("outbox_hold_send", { id, keep }),
  /** The page got the quit's `flush-sends` request and is doing its part: the backend then waits for the work, not just for a first sign. */
  quitPageAlive: () => invoke<void>("quit_page_alive"),
  /** The quit waits (`true`, for 60 s at most, and the window is brought to the front) or no longer waits (`false`) for an answer of the person. */
  quitDialog: (open: boolean) => invoke<void>("quit_dialog", { open }),
  /** Open a secondary window ("compose" | "reader"), or focus the one that already shows `key`; `init` waits in the backend for the new page. */
  popoutOpen: (kind: "compose" | "reader", key?: string | null, init?: unknown, focusOnly?: boolean) => invoke<PopoutOpened>("popout_open", { kind, key: key ?? null, init: init ?? null, focusOnly: focusOnly ?? null }),
  /** A secondary window asks who it is; `token` is the one in its address. */
  popoutInit: (token: string) => invoke<PopoutInfo>("popout_init", { token }),
  /** A secondary window's page is up (it listens for the quit request): the backend shows the window. */
  popoutReady: () => invoke<void>("popout_ready"),
  popoutFocus: (label: string) => invoke<boolean>("popout_focus", { label }),
  popoutClose: (label: string) => invoke<boolean>("popout_close", { label }),
  /** A secondary window asks the main page for something it owns (`popout-request`; the answer comes as the event `popout-reply`, see src/popout/request.ts). */
  popoutRequest: (id: string, kind: string, payload: unknown) => invoke<void>("popout_request", { id, kind, payload: payload ?? null }),
  /** The main page answers a request of the secondary window `to`. */
  popoutReply: (to: string, id: string, ok: boolean, data: unknown, error: string | null) => invoke<void>("popout_reply", { to, id, ok, data: data ?? null, error }),
  /** The pin and the snooze of a conversation (the messages carry the rest). */
  threadMeta: (threadId: string) => invoke<{ pinned: boolean; snoozedUntil: number | null }>("thread_meta", { threadId }),
  /** The calling window goes out of sight and keeps running (its message is still in the Undo time or on its way); it ends itself with `popoutDestroy`. */
  popoutPark: () => invoke<boolean>("popout_park"),
  /** The calling window ends now (its page has decided: saved, discarded or sent). */
  popoutDestroy: () => invoke<boolean>("popout_destroy"),
  /** A line for startup.log from a secondary window: "content" (the view was drawn), "error" (a script error), "info". */
  popoutNote: (kind: "content" | "error" | "info" | "strip", text: string) => invoke<void>("popout_note", { kind, text }),
  /** The page changed its own theme (or its colour scheme changed): the backend applies the frame theme of this window again (macOS title bar; the second way next to the backend's own triggers). What the page sees goes to startup.log. */
  windowThemeRefresh: (pageTheme: string, prefersDark: boolean) => invoke<void>("window_theme_refresh", { pageTheme, prefersDark }),
  /** The calling window shows another thing now (a draft that was saved is another draft): its key follows. False when another window has that key. */
  popoutSetKey: (key: string | null) => invoke<boolean>("popout_set_key", { key }),
  /** The update restart: every open secondary window saves what it holds. False = a person keeps a window open (the restart must stop). */
  popoutSaveAll: () => invoke<boolean>("popout_save_all"),
  /** A secondary window's part of a quit (the counterparts of quitPageAlive / quitDialog / sendsFlushed, which the main page uses). */
  popoutFlushAlive: () => invoke<void>("popout_flush_alive"),
  popoutFlushDialog: (open: boolean) => invoke<void>("popout_flush_dialog", { open }),
  popoutFlushDone: (go: boolean) => invoke<void>("popout_flush_done", { go }),
  /** The person cancelled the scheduled-messages question of a quit. */
  quitCancelled: () => invoke<void>("quit_cancelled"),
  outboxPendingCount: () => invoke<{ count: number; next: number | null }>("outbox_pending_count"),
  outboxOpenForEdit: (id: string) => invoke<OutboxEdit>("outbox_open_for_edit", { id }),
  outboxRelease: (id: string) => invoke<void>("outbox_release", { id }),
  outboxUpdate: (id: string, draft: Draft, sendAt: number) => invoke<void>("outbox_update", { id, draft, sendAt }),
  outboxReschedule: (id: string, sendAt: number) => invoke<void>("outbox_reschedule", { id, sendAt }),
  outboxRetry: (id: string) => invoke<void>("outbox_retry", { id }),
  outboxToDraft: (id: string) => invoke<void>("outbox_to_draft", { id }),
  outboxSendNow: (id: string) => invoke<void>("outbox_send_now", { id }),
  quitNow: () => invoke<void>("quit_now"),
  // calendar
  calendarListCalendars: () => invoke<CalendarInfo[]>("calendar_list_calendars"),
  calendarSetVisible: (calendarId: string, visible: boolean) => invoke<void>("calendar_set_visible", { calendarId, visible }),
  /** Events touching [from, to) (epoch seconds), repeats expanded. All-day events come with a day of slack. */
  calendarListEvents: (from: number, to: number) => invoke<CalEvent[]>("calendar_list_events", { from, to }),
  calendarGetEvent: (id: string) => invoke<CalEvent>("calendar_get_event", { id }),
  calendarSaveEvent: (event: CalEventInput, notify: boolean) => invoke<CalEvent>("calendar_save_event", { event, notify }),
  calendarDeleteEvent: (id: string, notify: boolean) => invoke<void>("calendar_delete_event", { id, notify }),
  calendarRespond: (messageId: string, response: Rsvp, comment: string | null, send: boolean) =>
    invoke<CalInvite>("calendar_respond", { messageId, response, comment, send }),
  calendarAddFromMessage: (messageId: string) => invoke<CalEvent>("calendar_add_from_message", { messageId }),
  calendarSaveIcs: (target: { messageId?: string; eventId?: string }) =>
    invoke<string | null>("calendar_save_ics", { messageId: target.messageId ?? null, eventId: target.eventId ?? null }),
  calendarImportIcs: () => invoke<{ added: number; updated: number } | null>("calendar_import_ics"),
  // calendar sync (Google Calendar / Outlook)
  calendarSources: () => invoke<CalSource[]>("calendar_sources"),
  calendarConnect: (accountId: string) => invoke<CalSource>("calendar_connect", { accountId }),
  calendarCancelConnect: () => invoke<void>("calendar_cancel_connect"),
  calendarDisconnect: (accountId: string) => invoke<void>("calendar_disconnect", { accountId }),
  calendarSetSync: (calendarId: string, on: boolean) => invoke<void>("calendar_set_sync", { calendarId, on }),
  calendarSyncNow: (accountId: string | null, onlyIfStale = false) => invoke<void>("calendar_sync_now", { accountId, onlyIfStale }),
  calendarOpenMessage: (messageId: string) => invoke<{ threadId: string; folder: string; accountId: string }>("calendar_open_message", { messageId }),
  // PGP
  pgpListKeys: () => invoke<PgpKey[]>("pgp_list_keys"),
  pgpGenerateKey: (accountId: string, algo: KeyAlgo, expiresDays: number | null, passphrase: string, remember: "never" | "session") =>
    invoke<PgpKey>("pgp_generate_key", { accountId, algo, expiresDays, passphrase, remember }),
  pgpInspectKey: (src: { armored?: string; path?: string }) => invoke<KeyInspect>("pgp_inspect_key", { armored: src.armored ?? null, path: src.path ?? null }),
  pgpImportKey: (src: { armored?: string; path?: string }, passphrase: string | null, verified: boolean) =>
    invoke<PgpKey[]>("pgp_import_key", { armored: src.armored ?? null, path: src.path ?? null, passphrase, verified }),
  pgpImportFromMessage: (messageId: string, index: number) => invoke<PgpKey[]>("pgp_import_from_message", { messageId, index }),
  pgpPickKeyFile: () => invoke<string | null>("pgp_pick_key_file"),
  pgpPublicArmored: (fingerprint: string) => invoke<string>("pgp_public_armored", { fingerprint }),
  pgpExportPublic: (fingerprint: string) => invoke<string | null>("pgp_export_public", { fingerprint }),
  pgpExportSecret: (fingerprint: string, passphrase?: string) => invoke<string | null>("pgp_export_secret", { fingerprint, passphrase: passphrase ?? null }),
  pgpDeleteKey: (fingerprint: string, includeSecret: boolean) => invoke<void>("pgp_delete_key", { fingerprint, includeSecret }),
  pgpSetVerified: (fingerprint: string, verified: boolean) => invoke<void>("pgp_set_verified", { fingerprint, verified }),
  pgpSetDefault: (accountId: string, fingerprint: string | null) => invoke<void>("pgp_set_default", { accountId, fingerprint }),
  pgpChangePassphrase: (fingerprint: string, oldPassphrase: string, newPassphrase: string) =>
    invoke<void>("pgp_change_passphrase", { fingerprint, oldPassphrase, newPassphrase }),
  pgpSetExpiry: (fingerprint: string, passphrase: string, expiresDays: number | null) =>
    invoke<PgpKey>("pgp_set_expiry", { fingerprint, passphrase, expiresDays }),
  pgpUnlock: (fingerprint: string, passphrase: string, remember: boolean) => invoke<void>("pgp_unlock", { fingerprint, passphrase, remember }),
  pgpLockAll: () => invoke<void>("pgp_lock_all"),
  pgpRecipientStatus: (accountId: string, addresses: string[]) =>
    invoke<{ own: OwnKeyStatus | null; recipients: RecipientStatus[] }>("pgp_recipient_status", { accountId, addresses }),
  pgpDecryptMessage: (messageId: string, passphrase?: string, remember?: boolean) =>
    invoke<MessageFull>("pgp_decrypt_message", { messageId, passphrase: passphrase ?? null, remember: remember ?? null }),
  listTemplates: () => invoke<Template[]>("list_templates"),
  saveTemplate: (template: Template) => invoke<void>("save_template", { template }),
  deleteTemplate: (id: string) => invoke<void>("delete_template", { id }),
  listSignatures: () => invoke<Signature[]>("list_signatures"),
  saveSignature: (signature: Signature) => invoke<void>("save_signature", { signature }),
  deleteSignature: (id: string) => invoke<void>("delete_signature", { id }),
  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  setSetting: (key: string, value: string) => invoke<void>("set_setting", { key, value }),
  /** Creation time (ms since the epoch) of the local database file, or null when the system cannot tell: the first-run date of the support reminder for an older install. */
  firstRunHint: () => invoke<number | null>("first_run_hint"),
  suggestContacts: (prefix: string) => invoke<Contact[]>("suggest_contacts", { prefix }),
  unsubscribe: (messageId: string) =>
    invoke<{ kind: "done" | "open" | "mailto"; target: string }>("unsubscribe", { messageId }),
  fetchRemoteImages: (urls: string[]) => invoke<Record<string, string>>("fetch_remote_images", { urls }),
  /** `jobId` makes the call cancellable: `aiCancel(jobId)` drops the request to the provider (the call then fails with AI_CANCELLED). */
  aiComplete: (system: string, prompt: string, jobId?: string) => invoke<string>("ai_complete", { system, prompt, jobId: jobId ?? null }),
  aiCancel: (jobId: string) => invoke<void>("ai_cancel", { jobId }),
  aiListModels: (endpoint: string, key?: string) => invoke<string[]>("ai_list_models", { endpoint, key: key ?? null }),
  /** Whether any account exists: the tray menu items "New mail" and "Check mail now" are enabled only then. */
  /** The UI has painted its first screen: the backend may show the window (it reloads the page when this never comes). */
  frontendReady: () => invoke<void>("frontend_ready"),
  /** The page has let its sends go out and saved its draft (answer to the quit's `flush-sends`); `go` false = keep the window open. */
  sendsFlushed: (go: boolean) => invoke<void>("sends_flushed", { go }),
  /** Bring the window to the front (a question while the app sat in the tray). */
  showWindow: () => invoke<void>("show_window"),
  /** What the page sees a moment after the window was shown: `visibilityState` and whether an animation frame arrived. */
  pageState: (visibility: string, frames: boolean) => invoke<void>("page_state", { visibility, frames }),
  setMailAvailable: (available: boolean) => invoke<void>("set_mail_available", { available }),
  shellInfo: () => invoke<{ os: string; tray: boolean; testData?: string | null; pdfView?: string; pdfTest?: boolean }>("shell_info"),
  checkUpdate: (trigger: UpdateTrigger) => invoke<UpdateResult>("check_update", { trigger }),
  /** Download and verify the update; progress arrives on `onEvent`. Resolves when the download has ended (ready, failed or cancelled). */
  updateDownload: (version: string, onEvent: (e: DlEvent) => void) => {
    const channel = new Channel<DlEvent>();
    channel.onmessage = onEvent;
    // `version` is the one the user agreed to (the card's): the backend downloads nothing else and answers stage "changed" otherwise
    return invoke<void>("update_download", { version, onEvent: channel });
  },
  updateCancel: () => invoke<void>("update_cancel"),
  updateDiscard: () => invoke<void>("update_discard"),
  /** The user chose Later / Not now (true) or took it back (false): only then the kept package is installed when the app quits. */
  updateDefer: (deferred: boolean) => invoke<void>("update_defer", { deferred }),
  /** A line for `startup.log` (tag `update`): why a restart did not start. */
  updateNote: (text: string) => invoke<void>("update_note", { text }),
  /** Install the downloaded update. `draftSaved`: a draft was saved for the restart (the next start says so). */
  updateInstall: (restart: boolean, draftSaved: boolean) => invoke<void>("update_install", { restart, draftSaved }),
  updateStartupState: () => invoke<UpdateStartupState>("update_startup_state"),
  /** The result of the last install was shown: the backend forgets it (until then every start tells it again). */
  updateStartupAck: () => invoke<void>("update_startup_ack"),
  /** A scheduled message is being delivered right now. */
  outboxBusy: () => invoke<boolean>("outbox_busy"),
};

export type UpdateTrigger = "startup" | "shown" | "manual";
export interface UpdateAsset {
  name: string;
  url: string;
  size: number | null;
  /** the link passes the allow-list (a github.com release download of this version) */
  urlOk: boolean;
}
export interface UpdateInfo {
  latest: string;
  notes: string;
  notesTruncated: boolean;
  /** unix seconds */
  publishedAt: number | null;
  releaseUrl: string;
  asset: UpdateAsset | null;
}
/** `disabled` and `throttled` are internal: the UI shows the cached `info` instead (see `cachedKind`). */
export type UpdateKind = "available" | "upToDate" | "noRelease" | "offline" | "error" | "disabled" | "throttled";
export interface UpdateResult {
  kind: UpdateKind;
  current: string;
  /** `installer`: how this copy was installed (nsis, msi, app, appimage, deb, rpm, unknown) */
  platform: { os: string; arch: string; installer: string; label: string };
  /** last attempt, unix seconds */
  checkedAt: number | null;
  message?: string | null;
  info: UpdateInfo | null;
  fromCache: boolean;
  /** for `throttled` / `disabled` results that carry cached `info`: `available` or `upToDate` */
  cachedKind?: UpdateKind | null;
}
/** Progress of `updateDownload` (the Rust side sends `{ event, data }`). */
export type DlEvent =
  | { event: "started"; data: { total: number | null; version: string } }
  | { event: "progress"; data: { received: number } }
  | { event: "verifying" }
  | { event: "ready" }
  | { event: "failed"; data: { stage: "download" | "badurl" | "verify" | "install" | "changed"; message: string } }
  | { event: "cancelled" };
export interface UpdateStartupState {
  outcome: "updated" | "failed" | null;
  version: string | null;
  draft: boolean;
}

// `hint` and the "Other" `label` are getters: they are read while a component renders, so they follow the language.
export const PROVIDERS: Record<
  string,
  {
    label: string; imapHost: string; imapPort: number; imapSsl?: boolean; smtpHost: string; smtpPort: number;
    smtpSecurity: "ssl" | "starttls"; hint?: string; insecure?: boolean;
  }
> = {
  gmail: {
    label: "Gmail",
    imapHost: "imap.gmail.com",
    imapPort: 993,
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
    smtpSecurity: "ssl",
    get hint() {
      return t("errors.provider.gmail.hint");
    },
  },
  outlook: {
    label: "Outlook / Microsoft 365", // i18n-ok: product name
    imapHost: "outlook.office365.com",
    imapPort: 993,
    smtpHost: "smtp.office365.com",
    smtpPort: 587,
    smtpSecurity: "starttls",
    get hint() {
      return t("errors.provider.outlook.hint");
    },
  },
  icloud: {
    label: "iCloud",
    imapHost: "imap.mail.me.com",
    imapPort: 993,
    smtpHost: "smtp.mail.me.com",
    smtpPort: 587,
    smtpSecurity: "starttls",
    get hint() {
      return t("errors.provider.icloud.hint");
    },
  },
  yahoo: {
    label: "Yahoo",
    imapHost: "imap.mail.yahoo.com",
    imapPort: 993,
    smtpHost: "smtp.mail.yahoo.com",
    smtpPort: 465,
    smtpSecurity: "ssl",
    get hint() {
      return t("errors.provider.yahoo.hint");
    },
  },
  bridge: {
    label: "Proton Mail Bridge", // i18n-ok: product name
    imapHost: "127.0.0.1",
    imapPort: 1143,
    imapSsl: false,
    smtpHost: "127.0.0.1",
    smtpPort: 1025,
    smtpSecurity: "starttls",
    insecure: true,
    get hint() {
      return t("errors.provider.bridge.hint");
    },
  },
  custom: {
    get label() {
      return t("errors.provider.custom.label");
    },
    imapHost: "",
    imapPort: 993,
    smtpHost: "",
    smtpPort: 465,
    smtpSecurity: "ssl",
  },
};
