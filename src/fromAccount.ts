// Which account a message is written from (the From field). Pure, so a script can test it (scripts/test-from-account.mjs).
//
// An answer or a forward of a received message goes out from the account that RECEIVED it (Reply and Forward alike, QA round 20 Q3); a new
// message from the account the caller names (the open mailbox, else the default); an account that does not exist (removed) or cannot send
// gives way to the default account, then to the first one.

/** The id of the account to write from. `wanted`: the account that received the message (or the caller's choice); `sendable`: the accounts a message can be sent from. */
export function fromAccountFor(sendable: readonly { id: string }[], wanted: string | undefined | null, defaultId?: string | null): string {
  if (wanted && sendable.some((a) => a.id === wanted)) return wanted;
  if (defaultId && sendable.some((a) => a.id === defaultId)) return defaultId;
  return sendable[0]?.id || wanted || "";
}
