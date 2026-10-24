import { create } from "zustand";
import { api, Account, AnswersRef, Att, BackfillProgress, CalendarInfo, CalEvent, CalSource, DraftSecurity, FolderInfo, Meeting, MessageFull, OutboxItem, SearchScope, ThreadSummary } from "./api";
import { loadPlatform, usePlatform } from "./platform";
import { orderAccounts } from "./accountOrder";
import { hasMailAccounts } from "./mailControls";
import { applyBackfill } from "./backfill";
import { holdOpenThread } from "./openThread";
import { planOpen } from "./notifyOpen";
import { withThreadsGone, withUnreadChange } from "./focusCounts";
import { hlMark } from "./perfMarks";
import { startPending, type Pending } from "./pendingCore";
import { addArrivals, clearByCounts, clearOnOpen, type Arrivals, type NewMap } from "./newMail";
import { QueuedMoves } from "./queuedMoves";
import { pushRecent, removeRecent } from "./recentSearches";
import { Latest } from "./latestOnly";
import { StateIntents, type IntentKind } from "./readIntent";
import { calendarErrorText, CAL_OFFER_DONE } from "./calendarSync";
import { backendText } from "./backendErrors";
import { needsSignIn } from "./signIn";
import type { Jobs } from "./translateJobs";
import { AdvanceTracker, startAdvance } from "./autoAdvance";
import type { Importance } from "./importance";
import type { MeetingWire } from "./meetingDraft";
import { accountsOf, canMoveToJunk, JUNK_ACTIONS } from "./junk";
import { addToast, lazyText, refreshed, toastTexts, trimToasts, type Lazy } from "./toastStack";
import { mayOpenMail, selectionAfterCompose } from "./composeSelection";
import { leaveCompose as leaveComposePane, nothingToKeep, type ComposeProbe, type SavedDraft } from "./leaveCompose";
export { lazyText, type Lazy };
import { getLang, isReady, loadLanguage, resolveLang, setLangPref, t } from "./i18n";
import type { Lang } from "./i18n";
import { fmtNumber } from "./i18n/format";
import { calTz, CalView, Day, rangeFor, systemTz, today } from "./calendar";
import { accentText, accountColor, buttonAccent, clampMaxDownload, DEFAULT_PREFS, lightened, mergePrefs, Prefs, readableOn, staleAccountPrefs, topBar, validHex } from "./prefs";
import { systemThemeAttribute } from "./osTheme";
import type { MailCanvasSession } from "./mailCanvas";
import { captionColors, gradientT } from "./captionColors";
import { settingsWindowOpen } from "./popout/popoutCount";
import { SETTINGS_KEY, settingsTarget } from "./popout/windowKinds";
import { darkTopBar } from "./topBarDark";
import { applyColorFallback } from "./colorFallback";

/** `quiet`: the caller tells a failure itself. `onSaved`: the caller says "Draft saved" itself (the pane makes no toast). */
export interface ComposeSaveOpts {
  quiet?: boolean;
  onSaved?: (d: SavedDraft) => void;
}

/**
 * What ends a message without a send (Compose's `composeEnd`): the snapshot goes; with `dropDraft` (Discard) the draft a save made of a new
 * message goes too, and an opened draft is put back as it was opened; with `emptied` (everything typed was deleted again, W2.3) the copy of a
 * NEW message goes and an opened draft keeps the version last saved. Resolves to false when it could not be done (Compose stays, the toast said why).
 */
export interface ComposeEndOpts {
  dropDraft?: boolean;
  emptied?: boolean;
}

export interface ComposeInit {
  accountId?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  bodyHtml?: string;
  inReplyTo?: string | null;
  references?: string[];
  replaces?: string; // draft thread id being edited
  /**
   * The message is a draft that was opened from Drafts (`replaces` is `m:<id>`), or a window / Undo / reopen of one after a save made `replaces` a
   * `mid:` reference: Discard puts the opened version back instead of leaving the autosaved edits (W2.2).
   */
  openedDraft?: boolean;
  /**
   * The window key of the draft this message was opened from (`draftKey(thread)`): a pane that is moved to a window gives it to the window, so the draft is
   * open in one editor only from the moment the window exists (before the window's first save has given it a key of its own), 1.0.7 WP2a retest BUG-2.
   */
  draftKey?: string;
  isReply?: boolean;
  /** the message this one answers (Reply, Reply all) or forwards: it gets `\Answered` / `$Forwarded` on its server once this one is sent (W2.22 CF-18) */
  answers?: AnswersRef;
  /** the sender asked for answers to go to `replyTo` instead of the address of From: Compose says so (and offers From) */
  replyNote?: { replyTo: string[]; from: string };
  attachments?: Att[];
  /** a scheduled message opened for editing (paused while open) */
  outboxId?: string;
  /** the scheduled time of that message */
  sendAt?: number;
  /** open the "Send later" picker straight away (Change time from the Scheduled list) */
  openSchedule?: boolean;
  /** why the scheduled message failed (shown in the Compose banner) */
  outboxError?: string;
  /** encryption / signing of a reopened draft or scheduled message */
  security?: DraftSecurity;
  /**
   * Compose reopened after a send failed or was undone: `bodyHtml` is the exact HTML that was built (the signature region included,
   * as in a stored draft), and Encrypt / Sign / public key are as the user had set them.
   */
  restore?: { encrypt: "on" | "off" | "auto"; sign: boolean; attachKey: boolean };
  /**
   * What the signature picker showed when this message was taken out of an editor (Undo of a send, a failed send, a move into a window, a crash snapshot):
   * "" = Automatic, "none" = No signature, else a signature id. Compose starts with exactly that value (W2.7); without it an opened draft derives it from
   * the signature found in its stored text.
   */
  sigId?: string;
  /** how far the header, the body and the tail of the inline pane were scrolled when Send closed it: Undo opens the pane again at the same places (D-053) */
  scrolls?: { head: number; editor: number; tail: number };
  /** send as confidential (an answer to confidential mail starts that way) */
  confidential?: boolean;
  /**
   * The shell of a Reply / Reply all / Forward whose recipients, quote and attachments are still being prepared (1.0.7 W13.13): Compose shows the header rows with the
   * recipient fields and Send off and the status "Preparing reply…" in the body; the full message replaces it IN PLACE (`fillCompose`: the same Compose and editor, WP13f-3; the
   * remount of `openCompose` is the fallback) when it is ready. `id` names this preparation,
   * `key` the answer (`answerKey`: a second press on the same answer only focuses it), `at` the press (ms: the status shows 100 ms after it, not after the pane was built), `fetching`: the attachments of a forward are being fetched ("Getting the attachments…"),
   * `cc`: a Reply all that is known (from the message as stored) to have Cc recipients: the Cc and Bcc rows are in the shell, so nothing moves when the message is filled in (REQ-13.13.12).
   */
  preparing?: { kind: "reply" | "forward"; id: string; key: string; at: number; fetching?: boolean; rcpt?: { to: string[]; cc: string[] } };
  /** this message replaces a shell that was on screen (W13.13): Compose does not fade in again */
  afterShell?: boolean;
  /** a message restored after the app ended unexpectedly: it keeps the id of its snapshot, so the next snapshot replaces it (recovery.ts) */
  recoveryId?: string;
  /** a message that was moved here from another editor (moved to a window of its own, back after Undo): all of it is the person's writing, so it counts as changed and is never closed unasked */
  carried?: boolean;
  /** only a reopened draft / scheduled message carries one; a new message, reply and forward start Normal */
  importance?: Importance;
  /** start Compose as a meeting invitation ("Meeting" switched on) */
  meeting?: Partial<Meeting> & { on?: boolean };
  /** the meeting of a reopened draft, snapshot or moved message, as the strip had it (it wins over `meeting`; meetingDraft.ts) */
  meetingForm?: MeetingWire;
}

/** What the New / Edit event dialog starts with. */
export interface EventInit {
  summary?: string;
  start?: number;
  end?: number;
  allDay?: boolean;
  location?: string;
  description?: string;
  attendees?: string[];
}

export type Dialog =
  | null
  | { type: "settings"; tab?: string; focus?: string; nonce?: number }
  | { type: "cleaner" }
  | { type: "original"; messageId: string }
  | { type: "pgp-generate"; accountId?: string; back?: string }
  | { type: "pgp-import"; armored?: string; paste?: boolean; back?: string }
  | { type: "pgp-key"; fingerprint: string; back?: string }
  | { type: "event"; eventId?: string; init?: EventInit; scope?: "occurrence" | "following" | "series"; occurrenceStart?: number | null }
  /** (W13.10) New folder (`parentKey` null) / New subfolder (the key of the folder it goes under) in a mailbox */
  | { type: "folder-new"; accountId: string; parentKey: string | null };

/** Why a PGP key has to be unlocked right now (the title of the passphrase prompt). */
export type UnlockReason = "sign" | "decrypt" | "draft" | "schedule";

export interface PassphraseAsk {
  fingerprint: string;
  reason: UnlockReason;
  /** e.g. the address the key belongs to */
  label?: string;
  resolve: (unlocked: boolean) => void;
}

export type RibbonTab = "home" | "view" | "help";

export interface ToastAction {
  label: Lazy;
  run: () => void;
}

export interface Toast {
  id: number;
  /** the text when the toast was made (also what an identical error is recognised by); drawn through `textFn` when there is one */
  text: string;
  /** makes the text in the current language: set by a toast made with a function (translation progress / ready / error) */
  textFn?: () => string;
  kind: "info" | "success" | "error";
  undo?: () => void;
  /** up to two buttons, e.g. Open / Show in folder / Retry */
  actions?: ToastAction[];
  ttl: number;
  /** stays until it is answered (no timer, no countdown bar); `key` names it so a new one replaces the old */
  sticky?: boolean;
  key?: string;
  /** what the "×" does for a sticky toast (default: just close it) */
  onDismiss?: () => void;
  /** accessible name of the "×" (default: "Later" when `onDismiss` is set, else "Dismiss") */
  closeLabel?: Lazy;
  /** Esc closes it (when nothing else that Esc closes is open) */
  escCloses?: boolean;
  /** text on top, buttons in a row below it (a longer text), with the coffee icon: the support reminder */
  support?: boolean;
  /** a small text link after the buttons (the support reminder: "Don't remind me again"); pressing it closes the toast */
  link?: ToastAction;
  /** no "×": the buttons already close it */
  hideClose?: boolean;
  /** work in progress: a spinner instead of the icon (static dots under reduced motion) */
  busy?: boolean;
  /** what a screen reader reads instead of the text: a text with a number that changes every second (the Undo countdown) is drawn `aria-hidden` and this is read once */
  readAs?: Lazy;
  /** a problem with guidance (the AI Assistant, src/aiGuide.ts): the text is lines (title in bold, what happened, what to do), the buttons sit below it */
  guide?: boolean;
}

export interface Choice {
  id: string;
  label: string;
  kind?: "primary" | "danger";
}
export interface AskState {
  title: string;
  body?: string;
  choices: Choice[];
  /** the answer of Esc and of a click outside; the first choice when not given (a question whose first button does something must give another) */
  dismiss?: string;
  resolve: (id: string) => void;
}

const VIRTUAL = new Set(["starred", "pinned", "snoozed", "all", "scheduled"]);
/** A move, mark or flag of this many conversations or more can take long: a sticky toast with the count says that it works (W13.14 A8, RULE-3 d / e). */
export const BUSY_MANY = 20;
const MOVE_LIKE = new Set(["archive", "trash", "junk", "block", "move", "inbox", "delete_forever"]);

/** The IMAP-side folder a move should act on (undefined for cross-folder views). */
export function scopeOf(folder: string): string | undefined {
  if (folder === "unread") return "inbox";
  return VIRTUAL.has(folder) ? undefined : folder;
}

/** Turn backend / network errors into something a person can act on. */
export function friendlyError(e: unknown): string {
  let raw = String(e instanceof Error ? e.message : e).replace(/^Error:\s*/, "").trim();
  // calendar sync errors come with their sentence ("CAL_CONFLICT: This event was changed in …"): shown as they are
  const calendarText = calendarErrorText(raw);
  if (calendarText) return calendarText;
  // backend errors are "CODE: human text" (or "CODE|name=value: text"); a few PGP ones carry data instead ("PGP_MISSING_KEYS:a@b.c,d@e.f")
  if (/^PGP_LOCKED:/.test(raw)) return t("errors.pgp.locked");
  if (/^PGP_MISSING_KEYS:/.test(raw)) return t("errors.pgp.missingKeys", { list: raw.slice("PGP_MISSING_KEYS:".length).split(",").join(", ") });
  const coded = backendText(raw);
  if (coded) return coded;
  raw = raw.replace(/^[A-Z][A-Z0-9_]+(?:\|[A-Za-z]\w*=[^|:]*)*:\s+/, "");
  // the backend already explained a server that does not do SSL/TLS or STARTTLS (mail.rs): keep its words
  if (/^Couldn[’']t start a secure connection to /.test(raw)) return shortenError(raw);
  if (/login failed|authenticationfailed|invalid credentials|auth.*fail/i.test(raw))
    return t("errors.signIn");
  if (/no stored (password|\w+ token)/i.test(raw)) return t("errors.noCredentials");
  if (/timed out|timeout|10060|did not properly respond/i.test(raw)) return t("errors.timeout");
  if (/lookup|dns|no such host|name or service not known|11001/i.test(raw)) return t("errors.unreachable");
  if (/certificate|tls|ssl/i.test(raw) && /invalid|verify|unknown|expired/i.test(raw)) return t("errors.certificate");
  // the server (or the connection to it) refused the message in words only a mail server writes ("response error: incomplete response"): a sentence a person can use
  // first, the technical text as the detail
  const smtp = /^SMTP send failed:\s*([\s\S]+)$/.exec(raw);
  if (smtp) {
    const detail = smtp[1].trim();
    const shown = t("errors.sendRefused", { detail: cutAtWord(detail, 120) });
    if (detail.length > 120) {
      if (fullErrors.size > 20) fullErrors.delete(fullErrors.keys().next().value as string);
      fullErrors.set(shown, t("errors.sendRefused", { detail }));
    }
    return shown;
  }
  return shortenError(raw);
}

/** Longer texts are cut for the toast; the whole text is kept here so the toast can show it as a tooltip. */
const fullErrors = new Map<string, string>();
export const fullErrorFor = (shown: string): string | undefined => {
  for (const [k, v] of fullErrors) if (shown.includes(k)) return shown.replace(k, v);
  return undefined;
};

/** `text` cut to at most `max` characters at a word boundary, with an ellipsis. */
export function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const sp = head.search(/\s\S*$/);
  return `${(sp > max * 0.5 ? head.slice(0, sp) : head).replace(/[\s,;:.(\-]+$/, "")}…`;
}

/**
 * The words we wrote ("CODE: advice (Server reply: …)") are shown whole; only what the server said is cut, at a word, and
 * the complete text stays available (tooltip). Any other long error is cut at a word at 220 characters.
 */
export function shortenError(raw: string): string {
  const m = raw.match(/^([\s\S]*?)\s*\((Server reply: [\s\S]*?)\)\s*$/);
  const shown = m ? `${m[1]} (${cutAtWord(m[2], 120)})` : cutAtWord(raw, 220);
  if (shown !== raw) {
    if (fullErrors.size > 20) fullErrors.delete(fullErrors.keys().next().value as string);
    fullErrors.set(shown, raw);
  }
  return shown;
}

interface State {
  accounts: Account[];
  accountId: string | null; // null = all accounts
  folder: string;
  search: string;
  searchScope: SearchScope;
  focus: "focused" | "other";
  filter: "all" | "unread" | "flagged";
  threads: ThreadSummary[];
  outbox: OutboxItem[];
  folders: FolderInfo[];
  /** (W13.2) mailboxes and folders that got new mail since the person last looked, for the dot in the side menu; session only */
  newMail: NewMap;
  /** (W13.6, RULE-5) the read of this conversation failed: the status "Opening message…" ends and the error is told (toast) */
  openError: string | null;
  selected: string | null;
  checked: Set<string>;
  messages: MessageFull[];
  loading: boolean;
  /** `loadMore` is fetching older mail right now (re-entrancy guard and the "Loading…" footer) */
  loadingMore: boolean;
  /** the last `loadMore` failed: scrolling stops retrying, the footer button is the retry */
  moreError: boolean;
  /** "accountId|role" the server has nothing older for; cleared by a sync */
  exhausted: Record<string, true>;
  /** "accountId|role" the "Max emails to download" cap stopped; cleared by a sync and when the cap changes */
  limited: Record<string, true>;
  /** background download of older Inbox mail per account (`backfill-progress`), only while it runs */
  backfill: Record<string, BackfillProgress>;
  syncing: boolean;
  /** account whose first sync runs right now (after it was added): its empty Inbox says so instead of "all caught up" */
  firstSync: string | null;
  syncErrors: Record<string, string>;
  /** mailboxes whose sign-in was rejected (Google / Microsoft): they show "Sign in again"; "blocked" = the organization has to approve the app */
  reauth: Record<string, "again" | "blocked">;
  setReauth: (accountId: string, kind: "again" | "blocked" | null) => void;
  toasts: Toast[];
  /** Translations of messages, running and finished, by message and language (src/translateJobs.ts); they outlive the reading pane. */
  translations: Jobs;
  setTranslations: (f: (j: Jobs) => Jobs) => void;
  ask: AskState | null;
  passphrase: PassphraseAsk | null;
  /** bumps whenever keys are added, removed or unlocked, so key-dependent views refetch */
  keysRev: number;
  compose: ComposeInit | null;
  composeKey: number; // changes on every open so a new message never inherits the old one's state
  /** The conversation of the Drafts folder that is being opened in Compose (REQ-13.7.1): its row shows a ring at once, the pane a status after 150 ms. null when none is. */
  openingDraft: string | null;
  setOpeningDraft: (threadId: string | null) => void;
  /** The person asked for the message list while a message is written in a narrow window (a folder pressed, a search started, Ctrl/Cmd+1): the list stays next to it (W2.26). Cleared when the message is closed or another one opens. */
  listAsked: boolean;
  askList: () => void;
  composeDirty: boolean;
  /** Saves the open message as a draft; resolves true when it was saved (false: the save failed, the message is still open). */
  composeSaver: ((opts?: ComposeSaveOpts) => Promise<boolean | void>) | null;
  /**
   * The message in the pane is over without being sent (saved, discarded, or the app is about to end): its crash-recovery snapshot goes, and
   * with `dropDraft` the draft that an autosave made of a NEW message goes too (Discard).
   */
  composeEnd: ((o?: ComposeEndOpts) => Promise<boolean | void>) | null;
  /** What the open message says about itself (written something? files still coming in?), for `leaveCompose`. */
  composeProbe: (() => ComposeProbe) | null;
  dialog: Dialog;
  commandOpen: boolean;
  /** counts the Ctrl+B / Cmd+B presses: the side menu answers each one (FolderPane.tsx) */
  sidebarToggle: number;
  ribbonTab: RibbonTab;
  prefs: Prefs;
  /** The light theme's session-only mail background (WP13g): "dark" after the button was pressed in the light theme, never stored; any switch of the app theme clears it (mailCanvasSync.ts). */
  mailCanvasSession: MailCanvasSession;
  /** The language the person just picked while its chunk is being fetched (src/i18n/lang-<code>.ts); `prefs.language` and the texts stay as they were until it is there. null when no switch is under way. */
  langLoading: Lang | null;
  aiConfigured: boolean;
  loaded: boolean;
  /** Mail or Calendar */
  module: "mail" | "calendar";
  /** the day the calendar is centred on */
  calDate: Day;
  calEvents: CalEvent[];
  calendars: CalendarInfo[];
  /** calendar sync state of the mailboxes that turned it on (Settings, the calendar sidebar) */
  calSources: CalSource[];
  /** `calSources` was read at least once (the sidebar offer waits for it) */
  calSourcesReady: boolean;
  /** the services this build can connect (`calendar_kinds_available`); null until read (Settings shows the CalDAV option of a mailbox from it) */
  calKinds: string[] | null;
  loadCalKinds: () => Promise<void>;
  /** the sidebar offer for existing mailboxes was answered: "1"; null = not yet; undefined = the setting is not read yet (W7.9) */
  calOfferDone: string | null | undefined;
  /** the mailbox whose Settings > Calendar switch starts its connect path as soon as the section is shown (the sidebar offer's "Turn on...") */
  calAutostart: string | null;
  calLoading: boolean;
  calError: string | null;
  /** bumps when the calendar changed behind the view's back (sync, respond, save) */
  calRev: number;
  /** Messages being sent right now: waiting in the undo window or handed to the backend and not answered yet (an update restart waits for them). */
  sendsInFlight: number;
  /** Attachment saves / opens under way (the support reminder waits for them). */
  transfers: number;
  /** The app is flushing sends because it is about to quit (a failed send then goes to Drafts). */
  quitting: boolean;
  /** Why the last draft save failed (the quit dialog says it). */
  draftError: string;

  init: () => Promise<void>;
  setView: (folder: string, accountId?: string | null) => Promise<void>;
  /** (W13.2) `mail-arrived`: mark the folders that got new mail, unless the folder is on screen and the window is in front */
  noteArrivals: (a: Arrivals, front: boolean) => void;
  /** (W13.2) the main window came to the front: the folder on screen is looked at */
  lookedAtFolder: () => void;
  setSearch: (q: string, remember?: boolean) => Promise<void>;
  setSearchScope: (s: SearchScope) => Promise<void>;
  /** (W13.10) a folder that was just created is in the side menu at once (no full sync needed); its parent is expanded */
  addFolder: (f: FolderInfo) => void;
  /** (W13.4) one entry of the recent searches goes, at once and without a question */
  removeRecentSearch: (q: string) => void;
  clearRecentSearches: () => void;
  setFocus: (f: "focused" | "other") => Promise<void>;
  setFilter: (f: "all" | "unread" | "flagged") => Promise<void>;
  refresh: () => Promise<void>;
  sync: () => Promise<void>;
  /** A new account was added: close the dialogs, show its Inbox, start its first sync with a visible loading state. */
  /** A mailbox was added: it joins the folder pane, closes the dialog, opens its Inbox and starts its first sync. `deferEnd`: only the first and the last, see accountAddedDone. */
  accountAdded: (acc: Account, deferEnd?: boolean) => Promise<void>;
  /** The end of a deferred accountAdded (the calendar step of Add account is over): closes the dialog, toasts, opens the Inbox of the new mailbox. */
  accountAddedDone: (acc: Account, withCalendar: boolean) => Promise<void>;
  /** Older mail of the open folder: up to MORE_CHUNKS x 50 per account, one request at a time. `manual` = the button (retry, ignores a previous error). */
  loadMore: (manual?: boolean) => Promise<void>;
  onBackfill: (p: BackfillProgress) => void;
  select: (id: string | null) => Promise<void>;
  /** The person opens a conversation (click, Enter, j / k, a notification): the message being written is left first (`leaveCompose`). */
  openMail: (id: string) => Promise<void>;
  /**
   * A click on the notification of a new message (D-051): the conversation opens wherever it is. A window of its own that shows it comes to the front; else the
   * list that has it (mailbox, folder, the Focused / Other tab) is shown, the row is revealed and selected and the conversation opens. Resolves to false (with a
   * word) when it is not on this computer any more.
   */
  openNotified: (id: string) => Promise<boolean>;
  /**
   * Leave the message being written to read something else (F-21). Nothing written: it closes. Something written: it is saved as a draft
   * ("Draft saved" with Edit) and closes; when the save fails it stays open and nothing is lost. Resolves true when no message is open.
   */
  leaveCompose: () => Promise<boolean>;
  toggleCheck: (id: string) => void;
  setChecked: (ids: string[]) => void;
  /** `view`: the view the person acts from, when it is not the open one (a reader window asks for a move from the view it was opened in). */
  act: (ids: string[], action: string, arg?: string, label?: Lazy, view?: string) => Promise<void>;
  /** `act` without the pending state: `busy` is ended as soon as the result is shown (W13.14 A8) */
  actNow: (ids: string[], action: string, arg: string | undefined, label: Lazy | undefined, view: string | undefined, busy: Pending | null) => Promise<void>;
  /** `restore: false` (closing): the reading pane is not given back the mail that was open before writing (the caller opens another).
   *  `sending`: the message is on its way, not over (the Undo time in seconds, 0 for none or a scheduled message); only a compose window reads it. */
  openCompose: (c: ComposeInit | null, opts?: { restore?: boolean; sending?: number }) => Promise<void>;
  /**
   * The finished message of a Reply / Reply all / Forward replaces its shell (the compose whose `preparing.id` is `id`) IN PLACE: the same Compose and editor stay (`composeKey` is not bumped),
   * they take the new `ComposeInit` as their props (WP13f-3, DEC-023). False = that shell is not the compose any more (Discard, another message): nothing was done.
   */
  fillCompose: (id: string, full: ComposeInit) => boolean;
  setComposeDirty: (d: boolean) => void;
  setComposeSaver: (f: ((opts?: ComposeSaveOpts) => Promise<boolean | void>) | null) => void;
  setComposeEnd: (f: ((o?: ComposeEndOpts) => Promise<boolean | void>) | null) => void;
  setComposeProbe: (f: (() => ComposeProbe) | null) => void;
  setDialog: (d: Dialog) => void;
  setCommandOpen: (o: boolean) => void;
  setRibbonTab: (t: RibbonTab) => void;
  /** `text` as a function is drawn each time the toast is painted (a toast made from a translation key follows a language switch); a plain string stays as it is */
  /** `ttl` (ms): how long it stays; without it a toast with Undo stays `undoActionSeconds` (at least 5 s). The send's Undo toast stays exactly the Undo send time (W13.1). */
  showToast: (text: Lazy, undo?: () => void, kind?: Toast["kind"], actions?: ToastAction[], ttl?: number) => void;
  dismissToast: (id: number) => void;
  /** The backend finished moving these conversations (their Undo time is over): they leave the open list now, without a re-read. */
  dropThreads: (ids: string[]) => void;
  /** (W6.1) `folder-reset`: the server renumbered a folder and its mail was read again. A selection, a checked row or an open conversation of that folder is dropped (the ids of its messages name other mail now) and the list is read again. */
  folderReset: (accountId: string, role: string) => void;
  /** (W6.3) `mail-pruned`: the mailbox is at its download limit after a prune (a sync, a push, the limit lowered): its folders show the notice "Download limit reached" at the end of the list without a sync. */
  onPruned: (accountId: string) => void;
  /** A toast that stays until it is answered (or `null` to remove it); one per `key`, a new text replaces the old in place. */
  setStickyToast: (
    key: string,
    spec: { text: Lazy; kind?: Toast["kind"]; actions?: ToastAction[]; onDismiss?: () => void; closeLabel?: Lazy; escCloses?: boolean; support?: boolean; link?: ToastAction; hideClose?: boolean; busy?: boolean; guide?: boolean; ttl?: number; undo?: () => void; readAs?: Lazy } | null,
  ) => void;
  /** Count a message as being sent from now until `done()` is called. */
  /** A send is under way (its undo window counts). `flush` makes it go out at once (a quit); it is dropped when the send ends. */
  beginSend: (flush?: () => void) => () => void;
  /** Count an attachment save / open as under way until the returned function is called. */
  beginTransfer: () => () => void;
  confirm: (o: { title: string; body?: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>;
  choose: (o: { title: string; body?: string; choices: Choice[]; dismiss?: string }) => Promise<string>;
  resolveAsk: (id: string) => void;
  /** Asks for the passphrase of a key and unlocks it. Resolves true when it is unlocked, false when cancelled. */
  askPassphrase: (o: { fingerprint: string; reason: UnlockReason; label?: string }) => Promise<boolean>;
  resolvePassphrase: (unlocked: boolean) => void;
  bumpKeys: () => void;
  /** Swap one message of the open conversation (after it was decrypted). */
  replaceMessage: (m: MessageFull) => void;
  setPrefs: (p: Partial<Prefs>) => void;
  setMailCanvasSession: (v: MailCanvasSession) => void;
  refreshAi: () => Promise<void>;
  setModule: (m: "mail" | "calendar") => void;
  setCalView: (v: CalView) => void;
  setCalDate: (d: Day) => void;
  loadCalendar: () => Promise<void>;
  bumpCal: () => void;
  loadCalSources: () => Promise<void>;
  /** Read the sidebar offer's setting (once). */
  loadCalOffer: () => Promise<void>;
  /** The offer is answered (Turn on, Not now, a calendar was connected, the Add account step ended without one): it is never shown again. */
  answerCalOffer: () => Promise<void>;
  /** Re-read the open conversation without clearing it (an invitation's state changed). */
  reloadMessages: () => Promise<void>;
}

/** The leave-compose run in progress: a second click while the draft is being saved waits for the same run. */
let leaving: Promise<boolean> | null = null;
/** The conversation that was open when the message being written was started (given back when it closes). */
let composeBefore: string | null = null;
let toastSeq = 0;
let readTimer: ReturnType<typeof setTimeout> | undefined;
/** The view (folder, mailbox, search, filter ...) the shown list was read for, and the conversation `refresh` held in it (F-12). */
let listKey = "";
let heldOpen: string | null = null;
/** (OBS-1) Conversations whose move target is being looked up on the server. */
const preparing = new Set<string>();
/** The re-reads of the list that are running: only the last one started lays its answer over the list (a stale answer must not bring back a moved message). */
const listReads = new Latest();
/** (BUG-1) Moves waiting out their Undo window: see queuedMoves.ts. */
const queued = new QueuedMoves();

/** Where the selection went after a queued move, and the one way back when the move does not stay done (autoAdvance.ts). */
const advances = new AdvanceTracker();
/** Set while the app itself marks the mail it just opened as read: that is not the person touching it. */
let autoMarking = false;

/** The mail of a move is back in the list (refused, dropped or undone): the selection and the unread state the app changed go back too. */
function mailBack(token: string): Promise<unknown> {
  const st = () => useStore.getState();
  return advances.mailBack(token, {
    now: Date.now,
    selected: () => st().selected,
    isUnread: (id) => (st().threads.find((x) => x.threadId === id)?.unread ?? 0) > 0,
    select: (id) => st().select(id),
    markUnread: (id) => st().act([id], "unread"),
  });
}

/** The backend dropped a queued move because its folder is gone and cannot be made: the toast goes, the mail is back, the error is shown. Undo wins. */
export function moveDropped(token: string, error: string) {
  const d = queued.dropped(token);
  if (!d) return; // Undo won
  const st = useStore.getState();
  if (d.dismiss != null) st.dismissToast(d.dismiss);
  st.showToast(() => t("errors.toast.failed", { error: friendlyError(error) }), undefined, "error");
  void st.refresh().then(() => mailBack(token));
}

/** The server refused the move after the Undo window (the Undo toast is gone by then): the error is shown, the mail is back. */
export function moveRefused(token: string, error: string) {
  const st = useStore.getState();
  st.showToast(() => t("app.toast.actionFailed", { error: friendlyError(error) }), undefined, "error");
  void st.refresh().then(() => mailBack(token));
}
/** The action a yes/no state is set with: [yes, no] (always a set, never a toggle: a repeated call is harmless and the last one wins). */
const INTENT_ACTION: Record<IntentKind, [string, string]> = { read: ["read", "unread"], flag: ["star", "unstar"], pin: ["pin", "unpin"] };
/** The action as a state: `read`/`unread`, `star`/`unstar`, `pin`/`unpin`. */
const INTENT_OF = new Map<string, { kind: IntentKind; want: boolean }>(
  (Object.entries(INTENT_ACTION) as [IntentKind, [string, string]][]).flatMap(([kind, [yes, no]]) => [[yes, { kind, want: true }], [no, { kind, want: false }]] as const),
);
/**
 * F-16/F-17 (read, 1.0.4 also flag and pin): the state asked for, until the server has it; lists and conversations read meanwhile are shown
 * through it.
 */
const intents = new StateIntents((ids, want, kind) => api.threadAction(ids, INTENT_ACTION[kind][want ? 0 : 1], undefined, scopeOf(useStore.getState().folder)));

/** Folders `loadMore` cannot page back (cross-folder views and the outbox have no single IMAP folder). */
const NO_PAGING = new Set(["starred", "pinned", "snoozed", "all", "scheduled"]);
export const canPageBack = (folder: string, searching: boolean) => !searching && !NO_PAGING.has(folder);
/** The IMAP-side role `load_older` takes for a view (the Unread view reads the Inbox). */
const roleOf = (folder: string) => (folder === "unread" ? "inbox" : folder);
export const exhaustedKey = (accountId: string, folder: string) => `${accountId}|${roleOf(folder)}`;

/** Shown where the "Max emails to download" cap stopped the list (toast of "Load older messages"; the list footer words it the same). */
const limitMessage = (n: number) => t("errors.limit", { n: fmtNumber(n) });

const MORE_CHUNKS = 4; // one scroll to the end = up to 4 x 50 = 200 older messages in total, however many mailboxes are open
const MORE_PAUSE_MS = 700; // between two requests, so the server and the list can breathe
const BACKFILL_REFRESH_MS = 1000; // the list is re-read at most this often while the background download runs
/** Bumped whenever the open view changes: a `loadMore` loop that sees a newer number stops without touching the state. */
let moreRun = 0;
let backfillTimer: ReturnType<typeof setTimeout> | undefined;
let backfillLast = 0;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** The mailbox to page next: the one whose oldest loaded thread is the most recent (one with nothing loaded goes first). */
function nextMailbox(ids: Set<string>, threads: { accountId: string; lastDate: number }[]): string {
  const oldest = new Map<string, number>();
  for (const t of threads) if (ids.has(t.accountId)) oldest.set(t.accountId, Math.min(oldest.get(t.accountId) ?? Infinity, t.lastDate));
  let best = "";
  let bestAt = -Infinity;
  for (const id of ids) {
    const at = oldest.get(id) ?? Infinity;
    if (at > bestAt) [best, bestAt] = [id, at];
  }
  return best;
}

/** The `limited` keys ("<account>|<folder key>") of every folder of a mailbox: the standard ones and the ones the folder pane lists. */
export function limitedKeys(accountId: string, folders: { accountId: string; key: string }[]): string[] {
  const keys = new Set(["inbox", "sent", "drafts", "archive", "trash", "junk", ...folders.filter((f) => f.accountId === accountId).map((f) => f.key)]);
  return [...keys].map((k) => `${accountId}|${k}`);
}

/** `limited` keys a sync in progress was told about (`mail-pruned`): they survive the clearing that ends the sync. */
const prunedDuringSync = new Set<string>();

/** Preferences the backend acts on (saving, retries, quit) are also stored as plain settings. */
const BACKEND_SETTINGS: [keyof Prefs, string, (v: unknown) => string][] = [
  ["downloadDir", "download_dir", (v) => (typeof v === "string" ? v : "")],
  ["warnExecutables", "warn_executables", (v) => (v ? "1" : "0")],
  ["scheduledCatchUp", "scheduled_catchup", (v) => String(v)],
  ["retryScheduled", "scheduled_retry", (v) => (v ? "1" : "0")],
  ["maxDownload", "max_download", (v) => String(clampMaxDownload(v))],
  ["autoAddInvites", "auto_add_invites", (v) => (v ? "1" : "0")],
  ["eventReminderMin", "event_reminder_min", (v) => (typeof v === "number" ? String(v) : "")],
  // the language the tray menu and native notifications are written in: en / vi / fr (the pseudo-locale counts as English)
  ["language", "ui_language", (v) => resolveLang(String(v))],
];

/** Writes the changed ones; the returned promises settle when the backend has stored them. */
function mirrorSettings(p: Partial<Prefs>): Promise<unknown>[] {
  const pending: Promise<unknown>[] = [];
  for (const [pref, key, fmt] of BACKEND_SETTINGS) {
    if (pref in p) pending.push(api.setSetting(key, fmt(p[pref])).catch(() => undefined));
  }
  return pending;
}

/** The last Language choice made through setPrefs: a choice that is still loading when a newer one comes is dropped. */
let langSeq = 0;

export function applyPrefs(p: Prefs) {
  if (isReady(p.language)) setLangPref(p.language); // (a language that is not loaded yet is switched to by setPrefs / PopoutRoot once its chunk is there)
  const root = document.documentElement;
  // System: the CSS follows the OS by itself (no attribute) - except where the backend decides what the OS is (Linux, W5.2): then the resolved theme is written like a chosen one
  const os = systemThemeAttribute();
  if (p.theme === "system" && os === null) root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", p.theme === "system" ? (os as string) : p.theme);
  root.setAttribute("data-density", p.density);
  root.style.setProperty("--fs", `${p.fontSize}px`);
  const accent = buttonAccent(validHex(p.accent) ? p.accent : DEFAULT_PREFS.accent);
  // the start screen of the next start (index.html, public/theme-boot.js) reads the theme and the accent before anything else can be asked of the backend
  try { localStorage.setItem("heylook.boot", JSON.stringify({ theme: p.theme, accent, os })); } catch { /* storage unavailable: the OS theme and the default accent */ }
  root.style.setProperty("--accent-base", accent);
  root.style.setProperty("--accent-fg-lt", readableOn(accent));
  root.style.setProperty("--accent-fg-dk", readableOn(lightened(accent)));
  root.style.setProperty("--accent-text-lt", accentText(accent, false));
  root.style.setProperty("--accent-text-dk", accentText(accent, true));
  const top = topBar(accent);
  root.style.setProperty("--top-lt", top.bg);
  root.style.setProperty("--top-fg-lt", top.fg);
  root.style.setProperty("--top-field-lt", top.field);
  root.style.setProperty("--top-field-h-lt", top.fieldHover);
  root.style.setProperty("--top-hover-lt", top.hover);
  // dark theme: the primary colour as a dark tint of the bar (hue only, capped lightness; see topBarDark.ts)
  const topDk = darkTopBar(validHex(p.accent) ? p.accent : DEFAULT_PREFS.accent);
  root.style.setProperty("--top-dk-start", topDk.start);
  root.style.setProperty("--top-dk-end", topDk.end);
  applyColorFallback(); // (an engine without color-mix(): the theme tokens that App.css builds with it, W9.7)
}

let captionSent = "";
/** Where the minimize button of the main window sits on the 135deg gradient of the band (1 = the end, also when the page has no custom frame). */
function captionT(): number {
  const bar = document.querySelector(".topbar")?.getBoundingClientRect();
  const min = document.querySelector(".wc-min")?.getBoundingClientRect();
  if (!bar || !min || bar.width <= 0 || min.width <= 0) return 1;
  return Math.round(gradientT(min.left + min.width / 2 - bar.left, min.top + min.height / 2 - bar.top, bar.width, bar.height) * 100) / 100;
}

/**
 * The main page tells the backend the colours of the native title bar of the secondary windows (Windows 11, W4.3): the colour of its own band behind its caption
 * buttons, in Light and in Dark. Called where the main page applies its preferences (start, every change of the accent) and when the caption buttons move
 * (WindowControls.tsx: a resize); only when the colours changed. The backend ignores it where a native caption is kept (Windows 10, high contrast, macOS, Linux).
 */
export function publishCaptionColors(p: Prefs) {
  const colors = captionColors(validHex(p.accent) ? p.accent : DEFAULT_PREFS.accent, captionT());
  const key = JSON.stringify(colors);
  if (key === captionSent) return;
  captionSent = key;
  void api.windowCaptionColors(colors).catch(() => { captionSent = ""; });
}

/** Apply read/unread/flag/pin changes to the lists right away; the backend call (IMAP) follows. */
function applyOptimistic(ids: string[], action: string) {
  if (!["read", "unread", "star", "unstar", "pin", "unpin"].includes(action)) return;
  const idset = new Set(ids);
  const st = useStore.getState();
  const folders = st.folders.map((f) => ({ ...f }));
  // bulk mail is in the side-menu Inbox number only when "Count Other (bulk) mail" is on (or Focused Inbox is off); the tab numbers always count it
  const countsBulk = st.prefs.countOtherMail || !st.prefs.focused;
  const bump = (t: ThreadSummary, delta: 1 | -1) => {
    const i = folders.findIndex((x) => x.accountId === t.accountId && x.key === t.folder);
    if (i < 0) return;
    folders[i] = t.folder === "inbox" ? withUnreadChange(folders[i], t.bulk, delta, countsBulk) : { ...folders[i], unread: Math.max(0, folders[i].unread + delta) };
  };
  const threads = st.threads.map((t) => {
    if (!idset.has(t.threadId)) return t;
    const n = { ...t };
    if (action === "read") n.unread = 0;
    else if (action === "unread") n.unread = Math.max(1, t.unread);
    else if (action === "star") n.flagged = true;
    else if (action === "unstar") n.flagged = false;
    else if (action === "pin") n.pinned = true;
    else if (action === "unpin") n.pinned = false;
    if (t.unread > 0 !== n.unread > 0) bump(t, n.unread > 0 ? 1 : -1);
    return n;
  });
  const messages =
    st.selected && idset.has(st.selected) && (action === "read" || action === "unread")
      ? st.messages.map((m, i) => ({ ...m, seen: action === "read" ? true : i < st.messages.length - 1 ? m.seen : false }))
      : st.messages;
  useStore.setState({ threads, folders, messages });
}

/**
 * One-time migration: an account without a stored color has always been drawn in the primary color, so that exact color is stored
 * for it now (what the user sees does not change) and every place - dots, avatars, Settings > Profile - reads the stored value.
 */
/** The sends still waiting out their "Undo" time: each can be told to go out now. */
const sendFlushers = new Set<() => void>();

/**
 * The app is about to quit: let every message that is still in its Undo window go out at once and wait (at most `maxMs`) until no send is
 * under way. A quit used to throw such a message away (the timer lives only here). Resolves true when nothing is left.
 */
export async function flushSends(maxMs = 25_000): Promise<boolean> {
  useStore.setState({ quitting: true });
  try {
    for (const f of [...sendFlushers]) f();
    const until = Date.now() + maxMs;
    while (useStore.getState().sendsInFlight > 0) {
      if (Date.now() > until) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
    return true;
  } finally {
    useStore.setState({ quitting: false });
  }
}

function storeMissingColors(accounts: Account[], accent: string): Account[] {
  return accounts.map((a) => {
    if (a.color) return a;
    const color = accountColor(a, accent);
    void api.updateAccount(a.id, a.displayName, color).catch(() => {});
    return { ...a, color };
  });
}

/** The open view changed: a running `loadMore` is abandoned (its answer is ignored) and a new one may start. */
function cancelMore() {
  moreRun++;
  useStore.setState({ loadingMore: false, moreError: false });
}

export const useStore = create<State>((set, get) => ({
  accounts: [],
  accountId: null,
  folder: "inbox",
  search: "",
  searchScope: "current",
  focus: "focused",
  filter: "all",
  threads: [],
  outbox: [],
  folders: [],
  newMail: {},
  openError: null,
  selected: null,
  checked: new Set(),
  messages: [],
  loading: true,
  loadingMore: false,
  moreError: false,
  exhausted: {},
  limited: {},
  backfill: {},
  syncing: false,
  firstSync: null,
  syncErrors: {},
  reauth: {},
  setReauth: (accountId, kind) =>
    set((s) => {
      const next = { ...s.reauth };
      if (kind) next[accountId] = kind;
      else delete next[accountId];
      return { reauth: next };
    }),
  toasts: [],
  translations: {},
  setTranslations: (f) => set((s) => ({ translations: f(s.translations) })),
  ask: null,
  passphrase: null,
  keysRev: 0,
  compose: null,
  composeKey: 0,
  openingDraft: null,
  setOpeningDraft: (openingDraft) => set({ openingDraft }),
  listAsked: false,
  askList: () => set({ listAsked: true }),
  composeDirty: false,
  composeSaver: null,
  composeEnd: null,
  composeProbe: null,
  dialog: null,
  commandOpen: false,
  sidebarToggle: 0,
  ribbonTab: "home",
  prefs: { ...DEFAULT_PREFS },
  mailCanvasSession: null,
  langLoading: null,
  aiConfigured: false,
  loaded: false,
  module: "mail",
  calDate: today(systemTz()),
  calEvents: [],
  calSources: [],
  calSourcesReady: false,
  calKinds: null,
  loadCalKinds: async () => {
    try {
      set({ calKinds: await api.calendarKindsAvailable() });
    } catch {
      set({ calKinds: [] });
    }
  },
  calOfferDone: undefined,
  calAutostart: null,
  calendars: [],
  calLoading: false,
  calError: null,
  calRev: 0,
  sendsInFlight: 0,
  transfers: 0,
  quitting: false,
  draftError: "",

  init: async () => {
    const [rawAccounts, rawPrefs] = await Promise.all([api.listAccounts(), api.getSetting("prefs"), loadPlatform()]);
    let prefs = mergePrefs(rawPrefs);
    // the saved language is normally there already (main.tsx waited for it before the first render); one more try when that failed, else the setting goes back to the language in use
    let langError: unknown = null;
    if (!isReady(prefs.language)) {
      try {
        await loadLanguage(resolveLang(prefs.language));
      } catch (e) {
        langError = e;
        prefs = { ...prefs, language: getLang() };
        void api.setSetting("prefs", JSON.stringify(prefs)).catch(() => undefined);
      }
    }
    // settings that point at an account that was removed (default account, overrides, favorites) are dropped
    const stale = staleAccountPrefs(prefs, rawAccounts.map((a) => a.id));
    if (Object.keys(stale).length) {
      prefs = { ...prefs, ...stale };
      void api.setSetting("prefs", JSON.stringify(prefs)).catch(() => undefined);
    }
    const accounts = orderAccounts(storeMissingColors(rawAccounts, prefs.accent), prefs.accountOrder); // the person's order (empty: as the backend gives them)
    applyPrefs(prefs);
    publishCaptionColors(prefs);
    mirrorSettings(prefs);
    const wait = usePlatform.getState().accountsDelayMs; // (a debug build can slow the start down on purpose, to try "New mail" before the mailboxes are read)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    set({ accounts, prefs, loaded: true, module: prefs.lastModule === "calendar" ? "calendar" : "mail", calDate: today(calTz(prefs)) });
    if (langError) get().showToast(() => t("errors.toast.failed", { error: friendlyError(langError) }), undefined, "error");
    if (prefs.lastModule === "calendar") void get().loadCalendar();
    void get().refreshAi();
    await get().refresh();
    void get().sync();
  },

  refreshAi: async () => {
    try {
      const [ep, model] = await Promise.all([api.getSetting("ai_endpoint"), api.getSetting("ai_model")]);
      set({ aiConfigured: !!ep?.trim() && !!model?.trim() });
    } catch {
      set({ aiConfigured: false });
    }
  },

  setModule: (module) => {
    if (get().module === module) return;
    set({ module });
    get().setPrefs({ lastModule: module });
    if (module === "calendar") void get().loadCalendar();
  },

  setCalView: (v) => {
    get().setPrefs({ calView: v });
    void get().loadCalendar();
  },

  setCalDate: (calDate) => {
    set({ calDate });
    void get().loadCalendar();
  },

  bumpCal: () => {
    set((s) => ({ calRev: s.calRev + 1 }));
    if (get().module === "calendar") void get().loadCalendar();
    else void get().loadCalSources();
  },

  loadCalSources: async () => {
    try {
      set({ calSources: await api.calendarSources(), calSourcesReady: true });
    } catch {
      /* keep what is shown */
    }
  },

  loadCalOffer: async () => {
    if (get().calOfferDone !== undefined) return;
    const v = await api.getSetting(CAL_OFFER_DONE).catch(() => "1"); // (unreadable: no offer rather than a notice that cannot be answered)
    set((s) => (s.calOfferDone === undefined ? { calOfferDone: v } : {}));
  },

  answerCalOffer: async () => {
    if (get().calOfferDone === "1") return;
    set({ calOfferDone: "1" });
    await api.setSetting(CAL_OFFER_DONE, "1").catch(() => undefined);
  },

  loadCalendar: async () => {
    const { prefs, calDate } = get();
    const tz = calTz(prefs);
    const { from, to } = rangeFor(prefs.calView, calDate, prefs.weekStart, tz);
    set({ calLoading: true });
    try {
      const [events, calendars, calSources] = await Promise.all([api.calendarListEvents(from, to), api.calendarListCalendars(), api.calendarSources().catch(() => get().calSources)]);
      // ignore a slow answer for a range the user already left
      const now = get();
      const cur = rangeFor(now.prefs.calView, now.calDate, now.prefs.weekStart, calTz(now.prefs));
      if (cur.from === from && cur.to === to) set({ calEvents: events, calendars, calSources, calError: null });
    } catch (e) {
      set({ calError: friendlyError(e) });
    } finally {
      set({ calLoading: false });
    }
  },

  reloadMessages: async () => {
    const { selected, folder } = get();
    if (!selected) return;
    const tok = intents.begin();
    try {
      const messages = intents.messages(selected, await api.getThread(selected, scopeOf(folder)), tok);
      if (get().selected === selected) set({ messages });
    } catch {
      /* keep what is shown */
    } finally {
      intents.end(tok);
    }
  },

  setView: async (folder, accountId = null) => {
    cancelMore();
    // (a folder pressed while a message is written in a narrow window: the person wants to see it, so the list comes back next to the message, W2.26)
    set({ folder, accountId, newMail: clearOnOpen(get().newMail, folder, accountId), selected: null, messages: [], threads: [], loading: true, checked: new Set(), search: "", module: "mail", ...(get().compose ? { listAsked: true } : {}) });
    if (get().prefs.lastModule !== "mail") get().setPrefs({ lastModule: "mail" });
    await get().refresh();
  },

  noteArrivals: (a, front) => {
    const { folder, accountId, newMail } = get();
    const next = addArrivals(newMail, a, { folder, accountId, front }, Date.now());
    if (next !== newMail) set({ newMail: next });
  },

  lookedAtFolder: () => {
    const { folder, accountId, newMail, module } = get();
    if (module !== "mail") return;
    const next = clearOnOpen(newMail, folder, accountId);
    if (next !== newMail) set({ newMail: next });
  },

  setSearch: async (search, remember = false) => {
    // searching is a mail thing: leave the calendar
    if (get().module !== "mail") get().setModule("mail");
    cancelMore();
    set({ search, selected: null, messages: [], loading: true, ...(search.trim() && get().compose ? { listAsked: true } : {}) });
    if (remember && search.trim()) {
      get().setPrefs({ recentSearches: pushRecent(get().prefs.recentSearches, search) });
    }
    await get().refresh();
  },

  setSearchScope: async (searchScope) => {
    cancelMore();
    set({ searchScope });
    if (get().search.trim()) {
      set({ loading: true });
      await get().refresh();
    }
  },

  addFolder: (f) => {
    set((s) => ({ folders: [...s.folders.filter((x) => !(x.accountId === f.accountId && x.key === f.key)), f] }));
    // (a new folder may have taken folders that were there already as its children: the list is read again, which gives every folder its parent)
    void api.listFolders().then((folders) => set({ folders })).catch(() => undefined);
    // a collapsed parent opens, so the new row is in view
    const pk = f.parent ? f.accountId + "|" + f.parent : null;
    if (pk && get().prefs.collapsed[pk]) get().setPrefs({ collapsed: { ...get().prefs.collapsed, [pk]: false } });
  },
  removeRecentSearch: (q) => get().setPrefs({ recentSearches: removeRecent(get().prefs.recentSearches, q) }),
  clearRecentSearches: () => get().setPrefs({ recentSearches: [] }),

  setFocus: async (focus) => {
    set({ focus, loading: true });
    await get().refresh();
  },

  setFilter: async (filter) => {
    set({ filter, loading: true });
    await get().refresh();
  },

  refresh: async () => {
    const { folder, accountId, search, searchScope, focus, filter, prefs } = get();
    // (F-16/F-17) what is asked of the server while this read runs is laid over its answer; folder counts that predate it are not shown
    const tok = intents.begin();
    const run = listReads.start();
    const readAt = Date.now();
    const foldersP = api.listFolders().then((folders) => {
      // (W13.2: a folder with no unread mail left has nothing new; an arrival noted after this read began is newer than its numbers)
      if (!intents.changedSince(tok)) set((s) => ({ folders, newMail: clearByCounts(s.newMail, folders, readAt) }));
    });
    // scheduled messages feed the Scheduled view and its badge, so they are read on every refresh
    const outboxP = api.listOutbox().then((outbox) => set({ outbox })).catch(() => undefined);
    void api.refreshBadge().catch(() => undefined);
    try {
      if (folder === "scheduled") {
        set({ threads: [] });
        await Promise.all([foldersP, outboxP]);
        return;
      }
      const fresh = intents.threads(await api.listThreads({
        accountId,
        folder,
        search,
        focus: folder === "inbox" && prefs.focused && !search.trim() ? focus : null,
        flat: !prefs.conversations,
        unreadOnly: filter === "unread",
        flaggedOnly: filter === "flagged",
        sortAsc: prefs.sortAsc,
        scope: search.trim() ? searchScope : "current",
      }), tok);
      // ignore a slow answer for a view the user already left
      const now = get();
      if (now.folder === folder && now.accountId === accountId && now.search === search && listReads.current(run)) {
        // F-12: reading the open mail can take it out of an Unread / Flagged list; it stays (and stays open) until the person leaves it
        const view = [folder, accountId, search, searchScope, focus, filter, prefs.conversations, prefs.sortAsc].join("|");
        const { threads, kept } = holdOpenThread(fresh, now.threads, now.selected, view === listKey);
        listKey = view;
        heldOpen = kept;
        set({ threads });
      }
      await Promise.all([foldersP, outboxP]);
    } finally {
      intents.end(tok);
      set({ loading: false });
    }
  },

  sync: async () => {
    const { accounts, syncing } = get();
    if (syncing || accounts.length === 0) return;
    set({ syncing: true });
    try {
      // toasts and the tray badge are handled by the backend (it keeps syncing while the window is hidden)
      const results = await Promise.allSettled(accounts.map((a) => api.syncAccount(a.id)));
      const errors: Record<string, string> = {};
      const reasons: Record<string, unknown> = {}; // what failed, as it came (the toast writes it in the language in use when it is drawn)
      const reauth: Record<string, "again" | "blocked"> = {};
      results.forEach((r, i) => {
        if (r.status !== "rejected") return;
        errors[accounts[i].id] = friendlyError(r.reason);
        reasons[accounts[i].id] = r.reason;
        const again = needsSignIn(String(r.reason));
        if (again) reauth[accounts[i].id] = again;
      });
      set({ syncErrors: errors, reauth });
      const first = Object.entries(errors)[0];
      if (first) {
        const acct = accounts.find((a) => a.id === first[0]);
        get().showToast(() => t("errors.toast.withAccount", { account: acct?.email ?? t("errors.toast.accountFallback"), error: friendlyError(reasons[first[0]]) }), undefined, "error");
      }
    } finally {
      // new mail may have arrived and a failed fetch may work now: scrolling may ask the server for older mail again (except where this very sync pruned at the cap: those stay marked)
      set({ syncing: false, exhausted: {}, limited: Object.fromEntries([...prunedDuringSync].map((k) => [k, true as const])), moreError: false });
      prunedDuringSync.clear();
      await get().refresh();
    }
  },

  accountAdded: async (acc, deferEnd = false) => {
    // the backend list is the truth (it also assigns the colour); fall back to what we were given
    let accounts = await api.listAccounts().catch(() => get().accounts);
    if (!accounts.some((a) => a.id === acc.id)) accounts = [...accounts.filter((a) => a.email !== acc.email), acc];
    accounts = orderAccounts(storeMissingColors(accounts, get().prefs.accent), get().prefs.accountOrder); // a new account goes after the ones in the saved order
    // the selection moves to the new mailbox: a stale search / filter of the old view must not hide it
    // (deferEnd: Add account has a second step, the calendar consent: the mailbox is in the folder pane and syncs now, the dialog stays,
    // and accountAddedDone closes it and opens the Inbox when that step ends)
    set(deferEnd ? { accounts, firstSync: acc.id } : { accounts, dialog: null, firstSync: acc.id, filter: "all" });
    if (!deferEnd) {
      get().showToast(t("errors.toast.accountAdded", { email: acc.email }), undefined, "success");
      await get().setView("inbox", acc.id);
    }
    try {
      await api.syncAccount(acc.id);
      set((s) => ({ syncErrors: Object.fromEntries(Object.entries(s.syncErrors).filter(([k]) => k !== acc.id)) }));
      get().setReauth(acc.id, null);
    } catch (e) {
      const msg = friendlyError(e);
      set((s) => ({ syncErrors: { ...s.syncErrors, [acc.id]: msg } }));
      get().setReauth(acc.id, needsSignIn(String(e)));
      get().showToast(() => t("errors.toast.withAccount", { account: acc.email, error: friendlyError(e) }), undefined, "error");
    } finally {
      set({ firstSync: null });
      await get().refresh();
    }
  },

  accountAddedDone: async (acc, withCalendar) => {
    set({ dialog: null, filter: "all" });
    get().showToast(t(withCalendar ? "errors.toast.accountAddedCal" : "errors.toast.accountAdded", { email: acc.email }), undefined, "success");
    await get().setView("inbox", acc.id);
  },

  loadMore: async (manual = false) => {
    const { accountId, accounts, folder, search, loadingMore, moreError } = get();
    if (loadingMore || !canPageBack(folder, search.trim().length > 0)) return;
    if (moreError && !manual) return;
    const role = roleOf(folder);
    const targets = accountId ? [accountId] : accounts.map((a) => a.id);
    // the button asks again even where the server said "nothing older" (it may have been wrong or things changed) or the cap
    // stopped it (answered at once by the backend, without any network)
    let { exhausted, limited } = get();
    const mine = (k: string) => targets.some((id) => k === `${id}|${role}`);
    if (manual) {
      exhausted = Object.fromEntries(Object.entries(exhausted).filter(([k]) => !mine(k)));
      limited = Object.fromEntries(Object.entries(limited).filter(([k]) => !mine(k)));
    }
    const pending = targets.filter((id) => !exhausted[`${id}|${role}`] && !limited[`${id}|${role}`]);
    if (manual) set({ exhausted, limited });
    if (pending.length === 0) return;
    const run = ++moreRun;
    set({ loadingMore: true, moreError: false });
    const alive = () => run === moreRun;
    let added = 0;
    let failing = "";
    try {
      // MORE_CHUNKS requests in all, shared by the mailboxes: each goes to the one whose loaded mail ends most recently,
      // so the merged timeline grows evenly instead of one mailbox racing ahead
      const active = new Set(pending);
      for (let i = 0; i < MORE_CHUNKS && active.size > 0; i++) {
        if (i > 0) await sleep(MORE_PAUSE_MS);
        if (!alive()) return;
        const id = nextMailbox(active, get().threads);
        failing = id;
        const r = await api.loadOlder(id, role, 50);
        if (!alive()) return;
        added += r.added;
        if (r.exhausted) {
          active.delete(id);
          set((s) => ({ exhausted: { ...s.exhausted, [`${id}|${role}`]: true } }));
        } else if (r.limited) {
          // the cap, not the server: a mailbox stops being asked just like an exhausted one, but the footer says why
          active.delete(id);
          set((s) => ({ limited: { ...s.limited, [`${id}|${role}`]: true } }));
        }
        // the list grows chunk by chunk (the viewport keeps its place)
        if (r.added > 0) await get().refresh();
        if (!alive()) return;
      }
      const stopped = (id: string) => get().exhausted[`${id}|${role}`] || get().limited[`${id}|${role}`];
      const done = pending.every(stopped);
      if (manual) {
        if (added > 0) get().showToast(t("errors.toast.loadedOlder", { n: added }), undefined, "success");
        else if (done) {
          const capped = targets.some((id) => get().limited[`${id}|${role}`]);
          get().showToast(capped ? limitMessage(get().prefs.maxDownload) : t("errors.toast.noOlder"), undefined, "info");
        }
      }
      // nothing came back although the server did not say it was done: stop scrolling from asking again and again (the button still can)
      if (added === 0 && !done) set({ moreError: true });
    } catch (e) {
      if (!alive()) return;
      // with several mailboxes say which one failed
      const acct = targets.length > 1 ? get().accounts.find((x) => x.id === failing)?.email : undefined;
      get().showToast(() => acct ? t("errors.toast.withAccount", { account: acct, error: friendlyError(e) }) : friendlyError(e), undefined, "error");
      set({ moreError: true });
    } finally {
      if (alive()) set({ loadingMore: false });
    }
  },

  onBackfill: (p) => {
    set((s) => ({ backfill: applyBackfill(s.backfill, p) }));
    // the list is re-read quietly (same scroll position, same selection), at most once a second; the last chunk always is
    clearTimeout(backfillTimer);
    const wait = p.done ? 0 : Math.max(0, backfillLast + BACKFILL_REFRESH_MS - Date.now());
    backfillTimer = setTimeout(() => {
      backfillLast = Date.now();
      void get().refresh();
    }, wait);
  },

  select: async (id) => {
    if (!mayOpenMail(id, !!get().compose)) return; // while writing only `openMail` (which leaves the message first) opens a mail
    clearTimeout(readTimer);
    // the person moves on: the conversation `refresh` held in the list (F-12) goes now
    const held = heldOpen && heldOpen !== id ? heldOpen : null;
    if (held) heldOpen = null;
    set((s) => ({ selected: id, messages: [], openError: null, ...(held ? { threads: s.threads.filter((t) => t.threadId !== held) } : {}) }));
    if (!id) return;
    const { folder, prefs } = get();
    const tok = intents.begin();
    let messages: MessageFull[];
    hlMark("open:thread:start");
    try {
      messages = intents.messages(id, await api.getThread(id, scopeOf(folder)), tok);
    } catch (e) {
      // (W13.6, RULE-5) a read that fails ends the status "Opening message…" and says why, instead of leaving a blank pane for the safety end
      if (get().selected === id) {
        set({ openError: id });
        get().showToast(() => t("errors.toast.failed", { error: friendlyError(e) }), undefined, "error");
      }
      return;
    } finally {
      intents.end(tok);
    }
    hlMark("open:thread:end");
    if (get().selected !== id) return;
    set({ messages });
    if (messages.some((m) => !m.seen) && prefs.markReadDelay >= 0) {
      const mark = () => {
        if (get().selected === id) {
          autoMarking = true; // the app's own mark-as-read of the mail it opened (see autoAdvance.ts): not the person's doing
          try {
            void get().act([id], "read");
          } finally {
            autoMarking = false;
          }
        }
      };
      if (prefs.markReadDelay === 0) mark();
      else readTimer = setTimeout(mark, prefs.markReadDelay * 1000);
    }
  },

  openMail: async (id) => {
    if (get().compose && !(await get().leaveCompose())) return;
    await get().select(id);
  },

  openNotified: async (id) => {
    // a window of its own already shows it: that window comes to the front, nothing else changes
    try {
      if ((await api.popoutOpen("reader", id, null, true)).status === "focused") return true;
    } catch {
      /* nothing to ask (a plain tab, an old backend): the main window shows it */
    }
    if (get().module !== "mail") get().setModule("mail");
    const listed = () => get().threads.some((x) => x.threadId === id);
    if (!listed()) await get().refresh(); // (a message that arrived since the list was read)
    if (!listed()) {
      const home = await api.locateThread(id).catch(() => null);
      if (!home) {
        get().showToast(() => t("reading.popout.gone"), undefined, "error");
        return false;
      }
      const { folder, accountId, search, filter, focus, prefs } = get();
      const plan = planOpen(home, { folder, accountId, search, filter, focus, focusedInbox: prefs.focused });
      if (plan.view) await get().setView(plan.view.folder, plan.view.accountId);
      if (plan.focus && get().focus !== plan.focus) await get().setFocus(plan.focus);
      if (!listed() && plan.clearFilter) await get().setFilter("all");
      if (!listed()) await get().refresh();
      if (!listed()) {
        get().showToast(() => t("reading.popout.gone"), undefined, "error");
        return false;
      }
    }
    await get().openMail(id);
    return get().selected === id;
  },

  leaveCompose: () => {
    leaving ??= (async () => {
      const outcome = await leaveComposePane({
        open: () => !!get().compose,
        scheduled: () => !!get().compose?.outboxId,
        dirty: () => get().composeDirty,
        probe: () => get().composeProbe?.() ?? null,
        // files being read in: up to 20 s, then the message stays open with a word about it
        attached: async () => {
          for (let i = 0; i < 200; i++) {
            if (!get().composeProbe?.().attaching) return true;
            await new Promise((r) => setTimeout(r, 100));
          }
          return false;
        },
        save: async (onSaved) => (get().composeSaver ? await get().composeSaver!({ onSaved }) : false),
        askScheduled: async () =>
          (await get().choose({
            title: t("compose.leave.scheduledTitle"),
            body: t("app.quit.discardBody"),
            choices: [
              { id: "keep", label: t("app.quit.keepEditing"), kind: "primary" },
              { id: "discard", label: t("errors.ask.discard"), kind: "danger" },
            ],
          })) === "discard"
            ? "discard"
            : "keep",
        dropEmptied: async () => void (await get().composeEnd?.({ emptied: true })),
        close: () => get().openCompose(null, { restore: false }),
      });
      if (outcome.kind === "saved") {
        const d = outcome.saved;
        get().showToast(() => d?.plain ? t("compose.toast.draftSavedPlain") : t("compose.toast.draftSaved"), undefined, d?.plain ? "info" : "success", d ? [{ label: () => t("common.edit"), run: d.edit }] : undefined);
      } else if (outcome.kind === "stay" && outcome.why === "attaching") {
        get().showToast(t("compose.leave.attaching"), undefined, "info");
      }
      return !get().compose;
    })().finally(() => {
      leaving = null;
    });
    return leaving;
  },

  toggleCheck: (id) => {
    const c = new Set(get().checked);
    if (c.has(id)) c.delete(id);
    else c.add(id);
    set({ checked: c });
  },

  setChecked: (ids) => set({ checked: new Set(ids) }),

  act: async (ids, action, arg, label, view) => {
    // a big selection: the work (looking up the folder, the optimistic update, the server) can take long, so one sticky toast with the count shows after 100 ms and goes with the result (W13.14 A8)
    const n = ids.length;
    const busy = n >= BUSY_MANY
      ? startPending(() => get().setStickyToast("busy-many", { text: () => t("app.busy.many", { count: n }), kind: "info", busy: true, hideClose: true }), () => get().setStickyToast("busy-many", null))
      : null;
    try {
      await get().actNow(ids, action, arg, label, view, busy);
    } finally {
      busy?.end();
    }
  },

  actNow: async (ids, action, arg, label, view, busy) => {
    if (ids.length === 0) return;
    // (1.0.5) no Junk folder on the account: the buttons are off already; this is for the keyboard and any other way in
    if (JUNK_ACTIONS.has(action) && !canMoveToJunk(get().folders, accountsOf(get().threads, ids))) {
      get().showToast(t("mail.junk.noneTip"), undefined, "info");
      return;
    }
    if (!autoMarking) advances.touch(ids); // the person acts on the mail the app advanced to
    applyOptimistic(ids, action);
    const intent = INTENT_OF.get(action);
    if (intent) {
      // (F-16/F-17, flag and pin too) last write wins, one idempotent call per conversation at a time; see readIntent.ts
      const r = await intents.set(ids, intent.want, intent.kind);
      if (r.superseded) return; // a later click on the same conversations reports for both
      busy?.end();
      if (r.failed.length > 0) {
        get().showToast(() => t("errors.toast.failed", { error: friendlyError(r.error) }), undefined, "error");
        const open = get().selected;
        if (intent.kind === "read" && open && r.failed.includes(open)) void get().reloadMessages();
      } else if (label) {
        get().showToast(label, undefined, "success");
      }
      await get().refresh();
      return;
    }
    const moveLike = MOVE_LIKE.has(action);
    // the view the person acted from (a move only touches the mail in it), and the action as the backend runs it
    const scope = scopeOf(view ?? get().folder);
    const real = moveLike && action === "trash" && scope === "trash" ? "delete_forever" : action;
    let verify = false; // the saved folder list was trusted: the backend checks it during the Undo window
    if (moveLike) {
      // (OBS-1) the folder the mail goes to is looked up (and a missing Archive / Trash created) on the server BEFORE the mail leaves the
      // list and "Archived" is shown: when that cannot be done the mail stays and the error comes at once, not after the Undo time.
      // The saved folder list names the usual folder, so this costs no server call then.
      const todo = ids.filter((id) => !preparing.has(id)); // a second press while the first one is still looking
      if (todo.length === 0) return;
      ids = todo;
      if (real !== "delete_forever") {
        for (const id of ids) preparing.add(id);
        try {
          verify = await api.prepareAction(ids, real, arg ?? null, scope ?? null);
        } catch (e) {
          get().showToast(() => t("errors.toast.failed", { error: friendlyError(e) }), undefined, "error");
          return;
        } finally {
          for (const id of ids) preparing.delete(id);
        }
      }
    }
    const { threads, selected, prefs, folder } = get();
    const removing = moveLike || action === "snooze";
    let nextSel = selected;
    let nextUnread = false; // the mail the selection moves to was unread (the app marks it read as it opens)
    if (removing) {
      if (selected && ids.includes(selected)) {
        const idx = threads.findIndex((t) => t.threadId === selected);
        const rest = threads.filter((t) => !ids.includes(t.threadId));
        const pick = prefs.afterAction === "list" ? null : prefs.afterAction === "previous" ? rest[Math.max(idx - 1, 0)] : rest[Math.min(idx, rest.length - 1)];
        nextSel = pick?.threadId ?? null;
        nextUnread = !!pick && pick.unread > 0;
      }
      // the row leaves the list and the unread numbers (side menu, tabs) drop with it; Undo and the refresh after it bring them back (the backend leaves a waiting conversation out of its numbers too)
      const gone = threads.filter((t) => ids.includes(t.threadId));
      set({ threads: threads.filter((t) => !ids.includes(t.threadId)), folders: withThreadsGone(get().folders, gone, prefs.countOtherMail || !prefs.focused), checked: new Set() });
    }

    if (moveLike) {
      // hide now, run on the server after the Undo window (the backend also flushes this on quit)
      let advance = true; // the selection moves on to the next mail; not when the move is already refused
      try {
        const token = await api.queueAction(ids, real, arg ?? null, scope ?? null, prefs.undoActionSeconds, verify);
        // a folder check that already failed (a fast server) has shown its error and brought the mail back: no "Archived" toast then,
        // and the person stays on the mail (nothing to move on from)
        advance = queued.queued(token);
        if (advance && selected && ids.includes(selected)) {
          // what to put back if the move is refused or undone while the person is still on the next mail (see autoAdvance.ts)
          advances.record(token, startAdvance(selected, nextSel, nextUnread, Date.now()));
        }
        busy?.end();
        if (advance && label) {
          get().showToast(
            label, // i18n-ok: a function (Lazy) like the text of every toast
            () => {
              queued.undo(token); // Undo wins over a folder check that ends later
              void api.cancelAction(token).then(() => get().refresh()).then(() => mailBack(token));
            },
            "success",
          );
          queued.shown(token, toastSeq); // the id `showToast` just gave it (it counts up synchronously)
        }
      } catch (e) {
        advance = false;
        get().showToast(() => t("errors.toast.failed", { error: friendlyError(e) }), undefined, "error");
        await get().refresh();
      }
      if (advance && selected && ids.includes(selected)) await get().select(nextSel);
      return;
    }

    try {
      await api.threadAction(ids, action, arg, scopeOf(view ?? folder));
      busy?.end();
      if (label) {
        get().showToast(label, action === "snooze" ? () => void get().act(ids, "unsnooze") : undefined, "success"); // i18n-ok: a function (Lazy)
      }
    } catch (e) {
      get().showToast(() => t("errors.toast.failed", { error: friendlyError(e) }), undefined, "error");
    }
    if (removing && selected && ids.includes(selected)) await get().select(nextSel);
    await get().refresh();
  },

  openCompose: async (compose, opts) => {
    const st = get();
    if (compose && !hasMailAccounts(st.accounts.length)) return; // no account: there is nothing to send with
    // Nothing worth a draft: everything typed was deleted again, or only recipients were typed (W13.5). Nothing to keep, nothing to ask. The copy an
    // autosave made of a new message goes with it (W2.3).
    const emptied = !!compose && !!st.compose && !st.compose.outboxId && st.composeDirty && nothingToKeep(st.composeProbe?.());
    if (emptied) await get().composeEnd?.({ emptied: true });
    else if (compose && st.compose && st.composeDirty) {
      const choice = await st.choose({
        title: t("errors.ask.unsentTitle"),
        body: t("errors.ask.unsentBody"),
        choices: [
          { id: "keep", label: t("errors.ask.keepWriting") },
          { id: "save", label: t("errors.ask.saveContinue"), kind: "primary" },
          { id: "discard", label: t("errors.ask.discard"), kind: "danger" },
        ],
      });
      if (choice === "keep") return;
      if (choice === "save") await get().composeSaver?.();
      else if ((await get().composeEnd?.({ dropDraft: true })) === false) return; // discarded: no snapshot is kept, no draft an autosave made of it, an opened draft is put back (false: that failed, the message stays)
    }
    // While writing, no mail is selected: nothing that works on "the selected mail" can reach the old one (F-21). Whoever opens a reply
    // or a forward has built it from that mail already. It comes back when writing ends and no other mail was picked.
    const before = get().compose ? composeBefore : get().selected;
    composeBefore = compose ? before : null;
    set({ compose, composeKey: get().composeKey + 1, listAsked: false, composeDirty: false, composeSaver: null, composeEnd: null, ...(compose ? { selected: null, messages: [], checked: new Set<string>() } : {}) });
    if (!compose && opts?.restore !== false) {
      const back = selectionAfterCompose(before, get().selected, get().threads.map((x) => x.threadId));
      if (back) await get().select(back);
    }
  },

  fillCompose: (id, full) => {
    if (get().compose?.preparing?.id !== id) return false;
    set({ compose: full }); // (a shell has nothing to save, ask or select: composeKey, composeDirty, the saver and the end hook stay as the live Compose made them)
    return true;
  },
  setComposeDirty: (composeDirty) => set({ composeDirty }),
  setComposeSaver: (composeSaver) => set({ composeSaver }),
  setComposeEnd: (composeEnd) => set({ composeEnd }),
  setComposeProbe: (composeProbe) => set({ composeProbe }),
  setDialog: (dialog) => {
    // while the Settings window exists every way of opening Settings (the gear, the command bar, a toast, the links of other windows) brings that window to the front on the asked tab
    if (dialog?.type === "settings" && settingsTarget(settingsWindowOpen()) === "window") {
      void import("./popout/open").then((m) => m.openPopout("settings", SETTINGS_KEY, { tab: dialog.tab, focus: dialog.focus, nonce: dialog.nonce ?? Date.now() }));
      return;
    }
    set({ dialog });
  },
  setCommandOpen: (commandOpen) => set({ commandOpen }),
  setRibbonTab: (ribbonTab) => set({ ribbonTab }),

  showToast: (text, undo, kind, actions, ttlMs) => {
    const { text: first, textFn } = toastTexts(text);
    // i18n note: this guess reads the English start of the text; a caller whose text is translated must pass `kind` itself
    const k: Toast["kind"] = kind ?? (/^(failed|sync error|send failed|schedule failed|save|unsubscribe failed|cannot)/i.test(first) ? "error" : "info");
    const acts = actions?.slice(0, 2);
    // a toast with buttons stays long enough to be read and clicked
    const ttl = ttlMs ?? (undo ? Math.max(5000, get().prefs.undoActionSeconds * 1000) : acts?.length || k === "error" ? 8000 : 4500);
    const id = ++toastSeq;
    // newest last; at most 5 timed toasts (the oldest without Undo go first), a toast that stays until it is answered is never evicted
    // (an identical error is recognised by its text in the language in use now, not the one the older toast was made in)
    set((s) => ({ toasts: trimToasts(addToast(s.toasts.map(refreshed), { id, text: first, textFn, kind: k, undo, actions: acts, ttl })) }));
    setTimeout(() => get().dismissToast(id), ttl);
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  onPruned: (accountId) => {
    const keys = limitedKeys(accountId, get().folders);
    // (a sync clears `limited` when it ends; what it pruned meanwhile is put back then)
    if (get().syncing) for (const k of keys) prunedDuringSync.add(k);
    set((s) => ({ limited: { ...s.limited, ...Object.fromEntries(keys.map((k) => [k, true as const])) } }));
  },

  folderReset: (accountId, role) => {
    const s = get();
    if (s.folder !== role || (s.accountId !== null && s.accountId !== accountId)) return;
    set({ checked: new Set() });
    if (s.selected) void get().select(null);
    void get().refresh();
  },

  dropThreads: (ids) => {
    const gone = new Set(ids);
    if (!get().threads.some((x) => gone.has(x.threadId))) return;
    set((s) => ({ threads: s.threads.filter((x) => !gone.has(x.threadId)), checked: new Set([...s.checked].filter((x) => !gone.has(x))) }));
  },

  setStickyToast: (key, spec) =>
    set((s) => {
      const others = s.toasts.filter((t) => t.key !== key);
      if (!spec) return { toasts: others };
      const old = s.toasts.find((t) => t.key === key);
      const toast: Toast = { id: old?.id ?? ++toastSeq, ...toastTexts(spec.text), kind: spec.kind ?? "info", actions: spec.actions, ttl: spec.ttl ?? 0, sticky: true, key, onDismiss: spec.onDismiss, closeLabel: spec.closeLabel, escCloses: spec.escCloses, support: spec.support, link: spec.link, hideClose: spec.hideClose, busy: spec.busy, guide: spec.guide, undo: spec.undo, readAs: spec.readAs };
      // in place when it exists (the countdown changes its text every second), else on top of the stack
      return { toasts: old ? s.toasts.map((t) => (t.key === key ? toast : t)) : [...others, toast] };
    }),

  beginSend: (flush) => {
    set((s) => ({ sendsInFlight: s.sendsInFlight + 1 }));
    if (flush) sendFlushers.add(flush);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (flush) sendFlushers.delete(flush);
      set((s) => ({ sendsInFlight: Math.max(0, s.sendsInFlight - 1) }));
    };
  },

  beginTransfer: () => {
    set((s) => ({ transfers: s.transfers + 1 }));
    let done = false;
    return () => {
      if (done) return;
      done = true;
      set((s) => ({ transfers: Math.max(0, s.transfers - 1) }));
    };
  },

  choose: (o) =>
    new Promise<string>((resolve) => {
      // One question at a time. A question that is open and gets replaced is answered as dismissed (what Esc does), not left waiting for ever: whoever asked it would hang
      // with its guards set (a Discard that never ends, a window that cannot be closed)
      const open = get().ask;
      if (open) open.resolve(open.dismiss ?? open.choices[0].id);
      set({ ask: { title: o.title, body: o.body, choices: o.choices, dismiss: o.dismiss, resolve } });
    }),

  confirm: async (o) => {
    const id = await get().choose({
      title: o.title,
      body: o.body,
      choices: [
        { id: "no", label: t("common.cancel") },
        { id: "yes", label: o.confirmLabel ?? t("common.ok"), kind: o.danger ? "danger" : "primary" },
      ],
    });
    return id === "yes";
  },

  resolveAsk: (id) => {
    const a = get().ask;
    set({ ask: null });
    a?.resolve(id);
  },

  askPassphrase: (o) =>
    new Promise<boolean>((resolve) => {
      set({ passphrase: { ...o, resolve } });
    }),

  resolvePassphrase: (unlocked) => {
    const p = get().passphrase;
    set({ passphrase: null });
    if (unlocked) get().bumpKeys();
    p?.resolve(unlocked);
  },

  bumpKeys: () => set((s) => ({ keysRev: s.keysRev + 1 })),

  replaceMessage: (m) => set((s) => ({ messages: s.messages.map((x) => (x.id === m.id ? m : x)) })),

  setMailCanvasSession: (v) => {
    if (get().mailCanvasSession !== v) set({ mailCanvasSession: v });
  },
  setPrefs: (patch) => {
    if ("language" in patch) {
      const seq = ++langSeq;
      const want = patch.language as Prefs["language"];
      if (!isReady(want)) {
        // a language that is not loaded: its chunk is fetched first and the whole window switches in one step; until then everything stays in
        // the language in use. A newer choice made meanwhile wins. A chunk that cannot be fetched leaves the language (and the setting) as it was.
        set({ langLoading: resolveLang(want) });
        void loadLanguage(resolveLang(want)).then(
          () => {
            if (seq !== langSeq) return;
            set({ langLoading: null });
            get().setPrefs({ language: want });
          },
          (e) => {
            if (seq !== langSeq) return;
            set({ langLoading: null });
            get().showToast(() => t("errors.toast.failed", { error: friendlyError(e) }), undefined, "error");
          },
        );
        const { language: _language, ...rest } = patch;
        if (!Object.keys(rest).length) return;
        patch = rest;
      } else if (get().langLoading) set({ langLoading: null });
    }
    const before = get().prefs;
    const prefs = { ...before, ...patch };
    // a new cap: mailboxes that were stopped by the old one are asked again
    if ("maxDownload" in patch && patch.maxDownload !== get().prefs.maxDownload) set({ limited: {} });
    // (W6.3) a LOWER cap: the extra local mail goes at once, in the background, once the backend has the new value; the conversation in the pane stays
    const lowered = "maxDownload" in patch && patch.maxDownload !== undefined && patch.maxDownload < get().prefs.maxDownload;
    const languageChanged = "language" in patch && patch.language !== get().prefs.language;
    set({ prefs });
    // every screen reads `accounts`: a new order shows everywhere at once (folder pane, Compose From, Settings)
    if ("accountOrder" in patch) set((s) => ({ accounts: orderAccounts(s.accounts, prefs.accountOrder) }));
    applyPrefs(prefs);
    publishCaptionColors(prefs);
    const saved = api.setSetting("prefs", JSON.stringify(prefs));
    void saved.catch(() => undefined);
    const mirrored = mirrorSettings(patch);
    if (lowered) {
      const keep = get().selected;
      void Promise.all(mirrored).then(() => api.pruneToLimit(keep ? [keep] : [])).catch(() => undefined);
    }
    if (languageChanged) {
      // texts the backend writes in the chosen language (repeat descriptions of events) are read again once it knows the new language
      void Promise.all(mirrored).then(() => {
        const s = get();
        if (s.module === "calendar") void s.loadCalendar();
        if (s.selected) void s.reloadMessages();
      });
    }
    // the tray, taskbar and Dock numbers and the Inbox number are read from the saved setting: refresh once it is stored, not before
    if ("countOtherMail" in patch && patch.countOtherMail !== before.countOtherMail) void saved.catch(() => undefined).then(() => get().refresh());
    const layoutKeys: (keyof Prefs)[] = ["conversations", "focused", "sortAsc"];
    if (layoutKeys.some((k) => k in patch)) {
      // a different list (order, grouping): the old lines are dropped so the list starts at the top instead of keeping a place that no longer means anything
      set({ threads: [], loading: true });
      void get().refresh();
    }
  },
}));

// The account list decides whether mail controls exist (see mailControls.ts). When the last account goes, whatever belonged to it
// (an open search, selection, compose window, calendar module) is dropped, so the first account added later starts clean; the tray's
// "New mail" and "Check mail now" follow the same state.
useStore.subscribe((s, prev) => {
  if (!s.loaded) return;
  const had = hasMailAccounts(prev.accounts.length);
  const has = hasMailAccounts(s.accounts.length);
  if (had === has && prev.loaded) return;
  void api.setMailAvailable(has).catch(() => undefined);
  if (!prev.loaded) return; // the first read at start-up is not a change
  // the saved module is Mail in the zero-account state and after the first account (Calendar is a mail-app module)
  if (had !== has) useStore.getState().setModule("mail");
  if (had && !has) {
    // an open Compose is closed WITHOUT saving: the account's local copy is gone, and the pane unmounts with the workspace
    useStore.setState({
      search: "", selected: null, messages: [], threads: [], checked: new Set(), compose: null, composeDirty: false, composeSaver: null, composeProbe: null,
      commandOpen: false, accountId: null, folder: "inbox", filter: "all", firstSync: null, dialog: s.dialog?.type === "settings" ? { type: "settings", tab: "add-account", nonce: Date.now() } : s.dialog,
    });
  }
});
