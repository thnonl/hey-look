import { MessageFull } from "./api";
import { t } from "./i18n";
import { eff } from "./prefs";
import { useStore } from "./store";
import { actionTargets } from "./composeSelection";
import { fmtFull, plainToHtml, quoteHtml, sanitizeHtml, splitAddrs } from "./util";
import { forwardHeaderHtml } from "./quoteHeader";

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

export function replyTo(m: MessageFull, all: boolean) {
  const st = useStore.getState();
  const mine = new Set(st.accounts.map((a) => a.email.toLowerCase()));
  const fromMe = mine.has(m.fromEmail.toLowerCase());
  const base = fromMe ? splitAddrs(m.to) : [m.fromEmail];
  const to = (all ? [...base, ...splitAddrs(m.to)] : base).filter((e) => !mine.has(e.toLowerCase()));
  st.openCompose({
    accountId: m.accountId,
    to: Array.from(new Set(to)),
    cc: all ? splitAddrs(m.cc).filter((e) => !mine.has(e.toLowerCase())) : [],
    subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
    bodyHtml: quoteHtml(m),
    inReplyTo: m.messageId,
    references: st.messages.map((x) => x.messageId).filter(Boolean) as string[],
    isReply: true,
    // an answer to confidential mail is confidential too
    confidential: m.confidential,
    // an answer to encrypted mail is encrypted too
    security: m.security?.encrypted
      ? { encrypt: true, sign: eff(st.prefs, m.accountId, "pgpSign"), attachPublicKey: eff(st.prefs, m.accountId, "pgpAttachKey") }
      : undefined,
  });
}

export function forward(m: MessageFull) {
  if (m.confidential) return useStore.getState().showToast(t("app.forward.confidential"), undefined, "info");
  useStore.getState().openCompose({
    accountId: m.accountId,
    subject: /^fwd?:/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`,
    bodyHtml:
      forwardHeaderHtml(
        { header: t("app.forward.header"), from: t("app.forward.from"), date: t("app.forward.date"), subject: t("app.forward.subject"), to: t("app.forward.to") },
        { fromName: m.fromName, fromEmail: m.fromEmail, dateText: fmtFull(m.date), subject: m.subject, to: m.to },
      ) + (m.html ? sanitizeHtml(m.html, false).html : plainToHtml(m.text ?? "")),
  });
}

/** Reply / reply-all using the user's default (or the explicit choice) on the last message of the open thread. */
export function replyLast(all?: boolean) {
  const st = useStore.getState();
  const last = st.messages[st.messages.length - 1];
  if (!last) return;
  replyTo(last, all ?? eff(st.prefs, last.accountId, "replyDefault") === "replyAll");
}

export function forwardLast() {
  const st = useStore.getState();
  const last = st.messages[st.messages.length - 1];
  if (last) forward(last);
}
