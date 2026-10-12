import { MessageFull } from "./api";
import { eff } from "./prefs";
import { useStore } from "./store";
import { fmtFull, plainToHtml, quoteHtml, sanitizeHtml, splitAddrs } from "./util";

export function targets(): string[] {
  const { checked, selected } = useStore.getState();
  if (checked.size > 0) return Array.from(checked);
  return selected ? [selected] : [];
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
  });
}

export function forward(m: MessageFull) {
  useStore.getState().openCompose({
    accountId: m.accountId,
    subject: /^fwd?:/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`,
    bodyHtml: `<br><br>---------- Forwarded message ----------<br>From: ${m.fromName} &lt;${m.fromEmail}&gt;<br>Date: ${fmtFull(m.date)}<br>Subject: ${m.subject}<br>To: ${m.to}<br><br>${
      m.html ? sanitizeHtml(m.html, false).html : plainToHtml(m.text ?? "")
    }`,
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
