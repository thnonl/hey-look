import { api, MessageFull, ReplyHeaders } from "./api";
import { t } from "./i18n";
import { eff } from "./prefs";
import { friendlyError, useStore } from "./store";
import { actionTargets } from "./composeSelection";
import { cleanHeaderText } from "./headerText";
import { fmtFull, fmtSize } from "./util";
import { fallbackReferences, replyTargets } from "./replyTargets";
import { forwardFiles, MAX_FORWARD_BYTES } from "./forwardAttachments";
import { quoteSentHtml } from "./editor/quoteBlock";
import { forwardHeadHtml, headerValueHtml, senderHtml } from "./quoteHeader";
import { fromAccountFor } from "./fromAccount";
import { startCompose, type StartOpts } from "./popout/composeOpen";
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
    return { messageId: m.messageId, replyTo: [], references: fallbackReferences(thread.map((x) => x.messageId), m.messageId) };
  }
}

/**
 * A secondary window (the reader) does not write messages itself: it sets these once, and an answer / forward is handed to the main window
 * (src/popout/ReaderView.tsx; the main window never sets them).
 */
export const answerVia: { importKey?: (m: MessageFull, index: number) => void | Promise<void>; reply?: (m: MessageFull, all: boolean, thread: MessageFull[]) => void | Promise<void>; forward?: (m: MessageFull, thread: MessageFull[]) => void | Promise<void> } = {};

/** How long a reply waits for the pictures of the message it quotes (they are fetched from the server when they are large), and how many bytes of them it takes. */
const QUOTE_PICTURES_WAIT_MS = 8000;
const QUOTE_PICTURES_MAX = 8 * 1024 * 1024;

/**
 * The quote block of an answer, in the form a stored message has it (editor/quoteBlock.ts): the original message cleaned to what can be sent
 * (editor/quoteClean.ts, loaded now: the composer does not need it before a reply is made), with `head` above it. Compose turns it into the protected
 * block. `html`: the body of the original, pictures already in it.
 */
async function quoteBlockOf(kind: "reply" | "forward", head: string, m: { html: string | null; text: string | null }): Promise<string> {
  const { quoteOf } = await import("./editor/quoteClean");
  return quoteSentHtml({ kind, head, html: quoteOf(m, t("compose.quote.cut")).html });
}

/** A new message from the open mailbox: in the main window, or in a window of its own when the setting or Shift says so (REQ-C1, C2). */
export function newMail(o: StartOpts = {}) {
  return startCompose({ accountId: newMailAccount() }, { ...o, shift: o.shift ?? shiftNow() });
}

/**
 * `thread`: the conversation the message belongs to (its Message-IDs are the fallback References of the answer); the open one unless the caller
 * answers a conversation that is not open (the list's context menu). `o`: where the answer opens (composeOpen.ts): by the setting and Shift unless
 * the caller says (the reader window always opens a compose window, REQ-R5). Shift is read now, from the click or key being handled.
 */
export async function replyTo(m: MessageFull, all: boolean, thread: MessageFull[] = useStore.getState().messages, o: StartOpts = {}) {
  if (answerVia.reply) return answerVia.reply(m, all, thread);
  const shift = o.shift ?? shiftNow();
  const st = useStore.getState();
  const h = await headersOf(m, thread);
  const mine = new Set(st.accounts.map((a) => a.email.toLowerCase()));
  const targets = replyTargets({ fromEmail: m.fromEmail, fromName: m.fromName, to: m.to, cc: m.cc, mine, replyTo: h.replyTo, headerFrom: h.from, headerTo: h.to, headerCc: h.cc, all });
  // what is written into the headers of the answer comes from the message answered: no line break or control character gets through (headerText.ts)
  const to = targets.to.map(cleanHeaderText);
  const cc = targets.cc.map(cleanHeaderText);
  const viaReplyTo = targets.viaReplyTo;
  const subject = cleanHeaderText(m.subject);
  // the pictures the body shows but only references (cid:) come along into the quote, so they are not left as broken boxes in the answer
  const pics = m.html && m.attachments.some((a) => a.inline && a.referenced && a.cid && m.html?.includes(`cid:${a.cid}`))
    ? await Promise.race([
        forwardFiles(m, (i) => api.attachmentData(m.id, i), QUOTE_PICTURES_MAX, "pictures").catch(() => null),
        new Promise<null>((r) => setTimeout(() => r(null), QUOTE_PICTURES_WAIT_MS)),
      ])
    : null;
  // the sender name, address and date come from the original message: escaped, never markup (quoteHeader.ts)
  const head = t("app.quote.wrote", { date: headerValueHtml(fmtFull(m.date)), who: senderHtml(m.fromName, m.fromEmail) });
  void startCompose({
    accountId: fromAccountFor(st.accounts, m.accountId, st.prefs.defaultAccount),
    to,
    cc,
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    bodyHtml: await quoteBlockOf("reply", head, { html: pics?.html ?? m.html, text: m.text }),
    // the id of the message answered: its own (a mail you sent has the id this app gave it; a received one keeps the server's)
    inReplyTo: h.messageId ?? m.messageId,
    references: h.references,
    isReply: true,
    // the sender asked for answers to go to another address than From: Compose says so
    replyNote: viaReplyTo ?? undefined,
    // an answer to confidential mail is confidential too
    confidential: m.confidential,
    // an answer to encrypted mail is encrypted too
    security: m.security?.encrypted
      ? { encrypt: true, sign: eff(st.prefs, m.accountId, "pgpSign"), attachPublicKey: eff(st.prefs, m.accountId, "pgpAttachKey") }
      : undefined,
  }, { ...o, shift, key: answerKey(all ? "replyAll" : "reply", m.id) });
}

export async function forward(m: MessageFull, thread: MessageFull[] = useStore.getState().messages, o: StartOpts = {}) {
  if (answerVia.forward) return answerVia.forward(m, thread);
  const shift = o.shift ?? shiftNow();
  const st = useStore.getState();
  if (m.confidential) return st.showToast(t("app.forward.confidential"), undefined, "info");
  // a forward is linked to the message it forwards (References, no In-Reply-To), also when that is a mail you sent yourself
  const h = await headersOf(m, thread);
  // the attachments of the message go along (pictures in the body stay in the body); a file that cannot be fetched is told about, the rest comes
  const files = m.attachments.some((a) => !(a.inline && a.referenced) || (a.cid && m.html?.includes(`cid:${a.cid}`)))
    ? await (async () => {
        const slow = setTimeout(() => st.showToast(t("compose.fwd.fetching"), undefined, "info"), 700);
        try {
          return await forwardFiles(m, (i) => api.attachmentData(m.id, i));
        } finally {
          clearTimeout(slow);
        }
      })()
    : null;
  const html = files?.html ?? m.html;
  const subject = cleanHeaderText(m.subject);
  // from the account that received the message, like Reply (the default account only when that one is gone)
  await startCompose({
    accountId: fromAccountFor(st.accounts, m.accountId, st.prefs.defaultAccount),
    references: h.references,
    subject: /^fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`,
    attachments: files?.attachments,
    bodyHtml: await quoteBlockOf(
      "forward",
      forwardHeadHtml(
        { header: t("app.forward.header"), from: t("app.forward.from"), date: t("app.forward.date"), subject: t("app.forward.subject"), to: t("app.forward.to") },
        { fromName: m.fromName, fromEmail: m.fromEmail, dateText: fmtFull(m.date), subject: m.subject, to: m.to },
      ),
      { html, text: m.text },
    ),
  }, { ...o, shift, key: answerKey("forward", m.id) });
  // after Compose is open: what could not come along
  for (const f of files?.failed ?? []) st.showToast(() => t("compose.fwd.failed", { name: f.name, error: friendlyError(f.error) }), undefined, "error");
  if (files?.skipped.length) st.showToast(() => t("compose.fwd.tooBig", { max: fmtSize(MAX_FORWARD_BYTES), names: files.skipped.join(", ") }), undefined, "error");
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
