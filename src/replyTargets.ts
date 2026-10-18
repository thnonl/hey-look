// Who an answer goes to, and which headers link it to the message it answers (RFC 5322 3.6.2 / 3.6.4). Pure, so a plain Node script
// can test it (scripts/test-reply-targets.mjs); actions.ts reads the message and opens Compose with the result.
import { addRecipients, addressOf, formatRecipient, recipientKey, splitRecipients } from "./recipients.ts";

export interface ReplyInput {
  fromEmail: string;
  /** display name of the sender (the stored message keeps it apart from the address) */
  fromName?: string;
  /** the To / Cc of the message as stored (comma separated) */
  to: string;
  cc: string;
  /** lower-case addresses of the person's own accounts */
  mine: ReadonlySet<string>;
  /** Reply-To of the message as `Name <address>` / `address` (only real addresses; empty when there is none) */
  replyTo: readonly string[];
  /**
   * From / To / Cc as the message's own headers write them (`"Doe, John" <john@x.test>`). The stored To / Cc keep bare addresses, so
   * the names come from here when the headers could be read (QA 19A R19A-1); without them the stored text is used.
   */
  headerFrom?: string | null;
  headerTo?: readonly string[];
  headerCc?: readonly string[];
  all: boolean;
}

export interface ReplyTargets {
  to: string[];
  cc: string[];
  /** the sender asked for answers to go elsewhere: the Reply-To addresses used and the address of From (shown in Compose) */
  viaReplyTo: { replyTo: string[]; from: string } | null;
}

/**
 * Reply goes to the Reply-To address when the message has a usable one, else to From; to your own sent message it goes to the
 * people you wrote to. Reply all adds the original From and the original To / Cc. Your own addresses (every account) are never
 * in the result, an address is in it once (upper / lower case alike), and an address in To is not repeated in Cc.
 */
export function replyTargets(i: ReplyInput): ReplyTargets {
  const own = (r: string) => i.mine.has(addressOf(r).toLowerCase());
  const fromMe = i.mine.has(i.fromEmail.toLowerCase());
  const asked = fromMe ? [] : i.replyTo.filter((r) => addressOf(r) !== "" && !own(r));
  const sender = senderMailbox(i);
  const origTo = i.headerTo?.length ? i.headerTo : splitRecipients(i.to);
  const origCc = i.headerCc?.length ? i.headerCc : splitRecipients(i.cc);
  const base = fromMe ? origTo : asked.length ? asked : [sender];
  const viaReplyTo = asked.length && !asked.some((r) => recipientKey(r) === i.fromEmail.toLowerCase()) ? { replyTo: asked, from: i.fromEmail } : null;
  const to = addRecipients([], (i.all ? [...base, ...(fromMe ? [] : [sender]), ...origTo] : base).filter((r) => !own(r)));
  const seen = new Set(to.map(recipientKey));
  const cc = i.all ? addRecipients([], origCc.filter((r) => !own(r) && !seen.has(recipientKey(r)))) : [];
  return { to, cc, viaReplyTo };
}

/** The sender as a recipient: with the name of the From header (or the stored name) when there is one, else the bare address. */
function senderMailbox(i: ReplyInput): string {
  if (i.headerFrom && recipientKey(i.headerFrom) === i.fromEmail.toLowerCase()) return i.headerFrom;
  const name = i.fromName?.trim();
  return name && name.toLowerCase() !== i.fromEmail.toLowerCase() ? formatRecipient(name, i.fromEmail) : i.fromEmail;
}

/** The ids of the message and of the conversation before it, when the backend could not read the headers: the ids of the thread. */
export function fallbackReferences(thread: readonly (string | null)[], parent: string | null): string[] {
  const ids = thread.filter((x): x is string => !!x);
  if (parent && !ids.includes(parent)) ids.push(parent);
  return ids;
}
