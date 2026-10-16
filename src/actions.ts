import { api, MessageFull, ReplyHeaders } from "./api";
import { t } from "./i18n";
import { eff } from "./prefs";
import { useStore } from "./store";
import { actionTargets } from "./composeSelection";
import { fmtFull, plainToHtml, quoteHtml, sanitizeHtml, splitAddrs } from "./util";
import { fallbackReferences } from "./replyTargets";

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
 * still goes out, to From, linked by the ids the open conversation has.
 */
async function headersOf(m: MessageFull): Promise<ReplyHeaders> {
  try {
    // a server that does not answer must not keep the answer from opening
    return await Promise.race([api.replyHeaders(m.id), new Promise<never>((_, no) => setTimeout(() => no(new Error("timeout")), REPLY_HEADERS_WAIT_MS))]);
  } catch {
    const thread = useStore.getState().messages.map((x) => x.messageId);
    return { messageId: m.messageId, replyTo: [], references: fallbackReferences(thread, m.messageId) };
  }
}

export async function replyTo(m: MessageFull, all: boolean) {
  const st = useStore.getState();
  const h = await headersOf(m);
  const mine = new Set(st.accounts.map((a) => a.email.toLowerCase()));
  const fromMe = mine.has(m.fromEmail.toLowerCase());
  const base = fromMe ? splitAddrs(m.to) : [m.fromEmail];
  const to = Array.from(new Set((all ? [...base, ...splitAddrs(m.to)] : base).filter((e) => !mine.has(e.toLowerCase()))));
  const cc = all ? splitAddrs(m.cc).filter((e) => !mine.has(e.toLowerCase())) : [];
  st.openCompose({
    accountId: m.accountId,
    to,
    cc,
    subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
    bodyHtml: quoteHtml(m),
    // the id of the message answered: its own (a mail you sent has the id this app gave it; a received one keeps the server's)
    inReplyTo: h.messageId ?? m.messageId,
    references: h.references,
    isReply: true,
    // an answer to confidential mail is confidential too
    confidential: m.confidential,
    // an answer to encrypted mail is encrypted too
    security: m.security?.encrypted
      ? { encrypt: true, sign: eff(st.prefs, m.accountId, "pgpSign"), attachPublicKey: eff(st.prefs, m.accountId, "pgpAttachKey") }
      : undefined,
  });
}

export async function forward(m: MessageFull) {
  if (m.confidential) return useStore.getState().showToast(t("app.forward.confidential"), undefined, "info");
  // a forward is linked to the message it forwards (References, no In-Reply-To), also when that is a mail you sent yourself
  const h = await headersOf(m);
  useStore.getState().openCompose({
    accountId: m.accountId,
    references: h.references,
    subject: /^fwd?:/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`,
    bodyHtml: `<br><br>${t("app.forward.header")}<br>${t("app.forward.from")} ${m.fromName} &lt;${m.fromEmail}&gt;<br>${t("app.forward.date")} ${fmtFull(m.date)}<br>${t("app.forward.subject")} ${m.subject}<br>${t("app.forward.to")} ${m.to}<br><br>${
      m.html ? sanitizeHtml(m.html, false).html : plainToHtml(m.text ?? "")
    }`,
  });
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
