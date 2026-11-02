// Which account a message is written from (the From field). Pure, so a script can test it (scripts/test-from-account.mjs).
//
// An answer or a forward of a received message goes out from the account that RECEIVED it (Reply and Forward alike, QA round 20 Q3); a new
// message from the account the caller names (the open mailbox, else the default); an account that does not exist (removed) or cannot send
// gives way to the default account, then to the first one. `replyAccountFor` (below) says which account received a message that sits in two mailboxes.

import { addressOf, splitRecipients } from "./recipients.ts";

/** The id of the account to write from. `wanted`: the account that received the message (or the caller's choice); `sendable`: the accounts a message can be sent from. */
export function fromAccountFor(sendable: readonly { id: string }[], wanted: string | undefined | null, defaultId?: string | null): string {
  if (wanted && sendable.some((a) => a.id === wanted)) return wanted;
  if (defaultId && sendable.some((a) => a.id === defaultId)) return defaultId;
  return sendable[0]?.id || wanted || "";
}

/**
 * The account an answer to a RECEIVED message is written from (1.0.12, owner): the address the message was written TO. A message addressed to one mailbox and copied (Cc) to another sits in both;
 * answering the copy of the Cc mailbox goes out from the To address. Among the person's accounts: the one that holds the opened copy when its address is in To, else another account whose
 * address is in To, else (nobody of mine in To: Cc, Bcc, a list, an alias) the account that holds the copy. A message I sent (From is one of my addresses) is answered from the account that holds it,
 * as before. The result is the `wanted` argument of `fromAccountFor`, which keeps the fallbacks (default account, first account).
 */
export function replyAccountFor(accounts: readonly { id: string; email: string }[], m: { accountId: string; fromEmail: string; to: string }): string {
  const lower = (s: string) => s.trim().toLowerCase();
  if (accounts.some((a) => lower(a.email) === lower(m.fromEmail))) return m.accountId;
  const to = new Set(splitRecipients(m.to ?? "").map((r) => lower(addressOf(r))));
  const holder = accounts.find((a) => a.id === m.accountId);
  if (holder && to.has(lower(holder.email))) return holder.id;
  return accounts.find((a) => to.has(lower(a.email)))?.id ?? m.accountId;
}
