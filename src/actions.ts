import { api, MessageFull, ReplyHeaders } from "./api";
import { t } from "./i18n";
import { eff } from "./prefs";
import { friendlyError, useStore } from "./store";
import { actionTargets } from "./composeSelection";
import { fmtFull, fmtSize, plainToHtml, quoteHtml, sanitizeHtml } from "./util";
import { fallbackReferences, replyTargets } from "./replyTargets";
import { forwardFiles, MAX_FORWARD_BYTES } from "./forwardAttachments";
import { forwardHeaderHtml } from "./quoteHeader";
import { fromAccountFor } from "./fromAccount";

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

/** `thread`: the conversation the message belongs to (its Message-IDs are the fallback References of the answer); the open one unless the caller answers a conversation that is not open (the list's context menu). */
export async function replyTo(m: MessageFull, all: boolean, thread: MessageFull[] = useStore.getState().messages) {
  const st = useStore.getState();
  const h = await headersOf(m, thread);
  const mine = new Set(st.accounts.map((a) => a.email.toLowerCase()));
  const { to, cc, viaReplyTo } = replyTargets({ fromEmail: m.fromEmail, fromName: m.fromName, to: m.to, cc: m.cc, mine, replyTo: h.replyTo, headerFrom: h.from, headerTo: h.to, headerCc: h.cc, all });
  st.openCompose({
    accountId: fromAccountFor(st.accounts, m.accountId, st.prefs.defaultAccount),
    to,
    cc,
    subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
    bodyHtml: quoteHtml(m),
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
  });
}

export async function forward(m: MessageFull, thread: MessageFull[] = useStore.getState().messages) {
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
  // from the account that received the message, like Reply (the default account only when that one is gone)
  await st.openCompose({
    accountId: fromAccountFor(st.accounts, m.accountId, st.prefs.defaultAccount),
    references: h.references,
    subject: /^fwd?:/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`,
    attachments: files?.attachments,
    bodyHtml:
      forwardHeaderHtml(
        { header: t("app.forward.header"), from: t("app.forward.from"), date: t("app.forward.date"), subject: t("app.forward.subject"), to: t("app.forward.to") },
        { fromName: m.fromName, fromEmail: m.fromEmail, dateText: fmtFull(m.date), subject: m.subject, to: m.to },
      ) + (html ? sanitizeHtml(html, false).html : plainToHtml(m.text ?? "")),
  });
  // after Compose is open: what could not come along
  for (const f of files?.failed ?? []) st.showToast(t("compose.fwd.failed", { name: f.name, error: friendlyError(f.error) }), undefined, "error");
  if (files?.skipped.length) st.showToast(t("compose.fwd.tooBig", { max: fmtSize(MAX_FORWARD_BYTES), names: files.skipped.join(", ") }), undefined, "error");
}

/** Reply / reply-all using the user's default (or the explicit choice) on the last message of the open thread. */
export function replyLast(all?: boolean) {
  const st = useStore.getState();
  const last = st.messages[st.messages.length - 1];
  if (!last) return;
  void replyTo(last, all ?? eff(st.prefs, last.accountId, "replyDefault") === "replyAll");
}

export function forwardLast() {
  const st = useStore.getState();
  const last = st.messages[st.messages.length - 1];
  if (last) void forward(last);
}
