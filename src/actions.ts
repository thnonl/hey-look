import { api, AnswersRef, MessageFull, ReplyHeaders } from "./api";
import { t } from "./i18n";
import { eff } from "./prefs";
import { friendlyError, useStore, type ComposeInit } from "./store";
import { actionTargets } from "./composeSelection";
import { cleanHeaderText } from "./headerText";
import { fmtFull, fmtSize } from "./util";
import { fallbackReferences, replyTargets } from "./replyTargets";
import { forwardFiles, MAX_FORWARD_BYTES, type ForwardFiles } from "./forwardAttachments";
import { quoteSentHtml } from "./editor/quoteBlock";
import { forwardHeadHtml, headerValueHtml, senderHtml } from "./quoteHeader";
import { fromAccountFor } from "./fromAccount";
import { hasMailAccounts } from "./mailControls";
import { NewMailQueue } from "./newMailQueue";
import { focusDraftWindow, startCompose, startShell, type StartOpts } from "./popout/composeOpen";
import { fills } from "./popout/composeFills";
import { createAnswerShell } from "./answerShell";
import { afterPaint, shellDone, statusRemaining, wait } from "./composeShell";
import { setAnswerBusy } from "./answerBusy";
import { answerKey } from "./popout/entry";
import { shiftNow } from "./popout/modifier";

export function targets(): string[] {
  const { checked, selected, compose } = useStore.getState();
  return actionTargets(checked, selected, !!compose); // none while a message is being written (F-21)
}

/**
 * Account a NEW message is written from: the open mailbox (or one of its folders / quick views) when one is selected;
 * in the combined view the "Default account" setting (if it still exists); otherwise undefined (Compose takes the first).
 * Reply / Reply all / Forward do not use this: they always use the account that owns the message.
 */
export function newMailAccount(): string | undefined {
  const st = useStore.getState();
  if (st.accountId && st.accounts.some((a) => a.id === st.accountId)) return st.accountId;
  const d = st.prefs.defaultAccount;
  return d && st.accounts.some((a) => a.id === d) ? d : undefined;
}

/** How long Reply waits for the headers of the message before it answers to From without them. */
const REPLY_HEADERS_WAIT_MS = 5000;

/**
 * The headers of the message itself (Reply-To, its Message-ID, the References of the answer). The stored message only knows its
 * Message-ID: when the headers cannot be read (the server is not reachable and the message is not on this computer) the answer
 * still goes out, to From, linked by the ids the conversation has (	hread: the open one, or the one the list's context menu answers).
 */
async function headersOf(m: MessageFull, thread: MessageFull[]): Promise<ReplyHeaders> {
  try {
    // a server that does not answer must not keep the answer from opening
    return await Promise.race([api.replyHeaders(m.id), new Promise<never>((_, no) => setTimeout(() => no(new Error("timeout")), REPLY_HEADERS_WAIT_MS))]);
  } catch {
    return fallbackHeaders(m, thread);
  }
}

function fallbackHeaders(m: MessageFull, thread: MessageFull[]): ReplyHeaders {
  return { messageId: m.messageId, replyTo: [], references: fallbackReferences(thread.map((x) => x.messageId), m.messageId) };
}

/**
 * A secondary window (the reader) does not write messages itself: it sets these once, and an answer / forward is handed to the main window
 * (src/popout/ReaderView.tsx; the main window never sets them).
 */
export const answerVia: { importKey?: (m: MessageFull, index: number) => void | Promise<void>; reply?: (m: MessageFull, all: boolean, thread: MessageFull[]) => void | Promise<void>; forward?: (m: MessageFull, thread: MessageFull[]) => void | Promise<void> } = {};

/** How long a reply waits for the pictures of the message it quotes (they are fetched from the server when they are large), and how many bytes of them it takes. */
const QUOTE_PICTURES_WAIT_MS = 8000;
const QUOTE_PICTURES_MAX = 8 * 1024 * 1024;

type QuoteClean = typeof import("./editor/quoteClean");
/** The module that cleans the quote: loaded now, not at start (the composer does not need it before an answer is made); the import runs beside the other steps of Reply / Forward. */
const loadQuoteClean = (): Promise<QuoteClean> => import("./editor/quoteClean");
// (fetched once the first screen is up, so that the first Reply after the start does not wait for the chunk, REQ-13.13.9)
if (typeof window !== "undefined") setTimeout(() => void loadQuoteClean().catch(() => undefined), 4000);

/**
 * The quote block of an answer, in the form a stored message has it (editor/quoteBlock.ts): the original message cleaned to what can be sent
 * (editor/quoteClean.ts) with `head` above it. Compose turns it into the protected block. `html`: the body of the original, pictures already in it.
 */
function quoteBlockOf(clean: QuoteClean, kind: "reply" | "forward", head: string, m: { html: string | null; text: string | null }): string {
  return quoteSentHtml({ kind, head, html: clean.quoteOf(m, t("compose.quote.cut")).html });
}

/** The pictures the body of `m` shows but only references (cid:) come along into the quote, so they are not left as broken boxes in the answer (null: none to fetch, or they did not come in time). */
function quotePictures(m: MessageFull): Promise<ForwardFiles | null> {
  if (!(m.html && m.attachments.some((a) => a.inline && a.referenced && a.cid && m.html?.includes(`cid:${a.cid}`)))) return Promise.resolve(null);
  return Promise.race([
    forwardFiles(m, (i) => api.attachmentData(m.id, i), QUOTE_PICTURES_MAX, "pictures").catch(() => null),
    new Promise<null>((r) => setTimeout(() => r(null), QUOTE_PICTURES_WAIT_MS)),
  ]);
}

/**
 * Reply / Reply all / Forward open at once (1.0.7 W13.13, answerShell.ts): a shell first, the message when its steps are done. This wires the shell to the app: the pane or a window
 * (composeOpen.ts), the hand-over to a window (popout/composeFill.ts), the status minimum (composeShell.ts), the toast of a failure.
 */
const answers = createAnswerShell({
  open: (init, o) => startShell(init, o),
  paneHas: (id) => useStore.getState().compose?.preparing?.id === id,
  // in place: the Compose and the editor made for the shell take the message (WP13f-3); false = the shell is not the compose any more, the result is dropped
  fillPane: async (id, init) => void useStore.getState().fillCompose(id, init),
  fillWindow: (label, init) => {
    if (label) fills.deliver(label, init);
  },
  // the same answer again: the shell in the pane, or the window that has the answer, comes forward; nothing new starts
  focusPrepared: async (key, id) => {
    if (useStore.getState().compose?.preparing?.id === id) {
      document.querySelector<HTMLElement>(".compose-pane .cp-prep")?.focus({ preventScroll: true });
      return true;
    }
    return focusDraftWindow(key);
  },
  paint: afterPaint,
  wait,
  remaining: (id) => statusRemaining(id),
  done: shellDone,
  newId: () => crypto.randomUUID(),
  busy: setAnswerBusy,
  fail: (e) => useStore.getState().showToast(() => friendlyError(e), undefined, "error"),
});

const NEW_MAIL_TOAST = "new-mail";

/**
 * New mail never ends silently (newMailQueue.ts): while the mailboxes are being read (the first second of a start) the request is kept, with a message that
 * has a spinner, and opens when they are read; 30 s without that, the message says it could not be done and has Retry - and when they are read after that, the message goes and the
 * message the person asked for opens (once). No mailbox at all: nothing, the Welcome screen is the answer.
 */
const newMailQueue = new NewMailQueue<StartOpts>({
  ready: () => {
    const s = useStore.getState();
    return !s.loaded ? "wait" : hasMailAccounts(s.accounts.length) ? "ready" : "none";
  },
  serve: (o) => void startCompose({ accountId: newMailAccount() }, o),
  say: (s) => {
    const st = useStore.getState();
    if (s === "waiting") st.setStickyToast(NEW_MAIL_TOAST, { text: () => t("app.newMail.waiting"), kind: "info", busy: true, hideClose: true });
    else if (s === "failed") st.setStickyToast(NEW_MAIL_TOAST, { text: () => t("app.newMail.failed"), kind: "error", actions: [{ label: () => t("common.retry"), run: () => newMailQueue.request(newMailQueue.retryOptions() ?? {}) }], onDismiss: () => newMailQueue.dismiss(), closeLabel: () => t("app.toast.dismiss") });
    else st.setStickyToast(NEW_MAIL_TOAST, null);
  },
  now: Date.now,
  later: (ms, f) => {
    const id = setTimeout(f, ms);
    return () => clearTimeout(id);
  },
});
useStore.subscribe(() => newMailQueue.check()); // (the mailboxes were read: a kept request opens)

/** A new message from the open mailbox: in the main window, or in a window of its own when the setting or Shift says so (REQ-C1, C2). */
export function newMail(o: StartOpts = {}): void {
  newMailQueue.request({ ...o, shift: o.shift ?? shiftNow() }); // (Shift is read now, from the click or key being handled)
}

/** The original an answer or a forward flags once it is sent: its account and its Message-ID (the header read from the message when known). Null without an id. */
function answersRef(kind: "answered" | "forwarded", m: MessageFull, headerId: string | null | undefined): AnswersRef | undefined {
  const messageId = headerId ?? m.messageId;
  return messageId ? { kind, accountId: m.accountId, messageId } : undefined;
}

/**
 * `thread`: the conversation the message belongs to (its Message-IDs are the fallback References of the answer); the open one unless the caller
 * answers a conversation that is not open (the list's context menu). `o`: where the answer opens (composeOpen.ts): by the setting and Shift unless
 * the caller says (the reader window always opens a compose window, REQ-R5). Shift is read now, from the click or key being handled.
 * The compose opens at once as a shell; the headers, the pictures of the quote and the quote itself are made beside each other and fill it in one step (answerShell.ts).
 */
export async function replyTo(m: MessageFull, all: boolean, thread: MessageFull[] = useStore.getState().messages, o: StartOpts = {}) {
  if (answerVia.reply) return answerVia.reply(m, all, thread);
  const shift = o.shift ?? shiftNow();
  const st = useStore.getState();
  const key = answerKey(all ? "replyAll" : "reply", m.id);
  // what is written into the headers of the answer comes from the message answered: no line break or control character gets through (headerText.ts)
  const subject = cleanHeaderText(m.subject);
  const reSubject = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
  // the sender name, address and date come from the original message: escaped, never markup (quoteHeader.ts)
  const head = t("app.quote.wrote", { date: headerValueHtml(fmtFull(m.date)), who: senderHtml(m.fromName, m.fromEmail) });
  const message = (h: ReplyHeaders, bodyHtml: string): ComposeInit => {
    const now = useStore.getState();
    const mine = new Set(now.accounts.map((a) => a.email.toLowerCase()));
    const targets = replyTargets({ fromEmail: m.fromEmail, fromName: m.fromName, to: m.to, cc: m.cc, mine, replyTo: h.replyTo, headerFrom: h.from, headerTo: h.to, headerCc: h.cc, all });
    return {
      accountId: fromAccountFor(now.accounts, m.accountId, now.prefs.defaultAccount),
      to: targets.to.map(cleanHeaderText),
      cc: targets.cc.map(cleanHeaderText),
      subject: reSubject,
      bodyHtml,
      // the id of the message answered: its own (a mail you sent has the id this app gave it; a received one keeps the server's)
      inReplyTo: h.messageId ?? m.messageId,
      references: h.references,
      isReply: true,
      // sending this flags the message answered on its server
      answers: answersRef("answered", m, h.messageId),
      // the sender asked for answers to go to another address than From: Compose says so
      replyNote: targets.viaReplyTo ?? undefined,
      // an answer to confidential mail is confidential too
      confidential: m.confidential,
      // an answer to encrypted mail is encrypted too
      security: m.security?.encrypted
        ? { encrypt: true, sign: eff(now.prefs, m.accountId, "pgpSign"), attachPublicKey: eff(now.prefs, m.accountId, "pgpAttachKey") }
        : undefined,
    };
  };
  await answers.open({
    kind: "reply",
    key,
    o: { ...o, shift, key },
    // Reply all with Cc recipients (as the message is stored; the headers of the server change names, not who): the Cc and Bcc rows are in the shell, nothing appears at the fill (REQ-13.13.12)
    cc: all && (message(fallbackHeaders(m, thread), "").cc?.length ?? 0) > 0,
    shell: { accountId: fromAccountFor(st.accounts, m.accountId, st.prefs.defaultAccount), subject: reSubject, isReply: true, confidential: m.confidential },
    prepare: async (painted) => {
      // the three slow steps start together (REQ-13.13.3); the quote is cleaned when the pictures are in it and the shell was painted
      const [h, pics, clean] = await Promise.all([headersOf(m, thread), quotePictures(m), loadQuoteClean()]);
      await painted;
      try {
        return { h, quote: quoteBlockOf(clean, "reply", head, { html: pics?.html ?? m.html, text: m.text }), quoteError: null as unknown };
      } catch (e) {
        return { h, quote: "", quoteError: e as unknown }; // the answer opens without the quote and says why (REQ-13.13.8)
      }
    },
    build: (r) => message(r.h, r.quote),
    fallback: () => message(fallbackHeaders(m, thread), ""),
    after: (r) => {
      if (r.quoteError) useStore.getState().showToast(() => friendlyError(r.quoteError), undefined, "error");
    },
  });
}

export async function forward(m: MessageFull, thread: MessageFull[] = useStore.getState().messages, o: StartOpts = {}) {
  if (answerVia.forward) return answerVia.forward(m, thread);
  const shift = o.shift ?? shiftNow();
  const st = useStore.getState();
  if (m.confidential) return st.showToast(t("app.forward.confidential"), undefined, "info");
  const key = answerKey("forward", m.id);
  const subject = cleanHeaderText(m.subject);
  const fwdSubject = /^fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`;
  // the attachments of the message go along (pictures in the body stay in the body); a file that cannot be fetched is told about, the rest comes
  const hasFiles = m.attachments.some((a) => !(a.inline && a.referenced) || (a.cid && m.html?.includes(`cid:${a.cid}`)));
  // from the account that received the message, like Reply (the default account only when that one is gone)
  const message = (h: ReplyHeaders, files: ForwardFiles | null, bodyHtml: string): ComposeInit => {
    const now = useStore.getState();
    return {
      accountId: fromAccountFor(now.accounts, m.accountId, now.prefs.defaultAccount),
      references: h.references,
      // sending this flags the message forwarded on its server
      answers: answersRef("forwarded", m, h.messageId),
      subject: fwdSubject,
      attachments: files?.attachments,
      bodyHtml,
    };
  };
  await answers.open({
    kind: "forward",
    key,
    o: { ...o, shift, key },
    fetching: hasFiles,
    shell: { accountId: fromAccountFor(st.accounts, m.accountId, st.prefs.defaultAccount), subject: fwdSubject },
    prepare: async (painted) => {
      // a forward is linked to the message it forwards (References, no In-Reply-To), also when that is a mail you sent yourself
      const [h, files, clean] = await Promise.all([headersOf(m, thread), hasFiles ? forwardFiles(m, (i) => api.attachmentData(m.id, i)) : Promise.resolve(null), loadQuoteClean()]);
      await painted;
      const head = forwardHeadHtml(
        { header: t("app.forward.header"), from: t("app.forward.from"), date: t("app.forward.date"), subject: t("app.forward.subject"), to: t("app.forward.to") },
        { fromName: m.fromName, fromEmail: m.fromEmail, dateText: fmtFull(m.date), subject: m.subject, to: m.to },
      );
      try {
        return { h, files, quote: quoteBlockOf(clean, "forward", head, { html: files?.html ?? m.html, text: m.text }), quoteError: null as unknown };
      } catch (e) {
        return { h, files, quote: "", quoteError: e as unknown };
      }
    },
    build: (r) => message(r.h, r.files, r.quote),
    fallback: () => message(fallbackHeaders(m, thread), null, ""),
    // after the message is filled in: what could not come along
    after: (r) => {
      const now = useStore.getState();
      if (r.quoteError) now.showToast(() => friendlyError(r.quoteError), undefined, "error");
      for (const f of r.files?.failed ?? []) now.showToast(() => t("compose.fwd.failed", { name: f.name, error: friendlyError(f.error) }), undefined, "error");
      if (r.files?.skipped.length) now.showToast(() => t("compose.fwd.tooBig", { max: fmtSize(MAX_FORWARD_BYTES), names: (r.files?.skipped ?? []).join(", ") }), undefined, "error");
    },
  });
}

/** Reply / reply-all using the user's default (or the explicit choice) on the last message of the open thread. */
export function replyLast(all?: boolean, o?: StartOpts) {
  const st = useStore.getState();
  const last = st.messages[st.messages.length - 1];
  if (!last) return;
  void replyTo(last, all ?? eff(st.prefs, last.accountId, "replyDefault") === "replyAll", undefined, o);
}

export function forwardLast() {
  const st = useStore.getState();
  const last = st.messages[st.messages.length - 1];
  if (last) void forward(last);
}
