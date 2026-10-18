// The own Reply-To of a mailbox (Settings > mailbox, 1.0.7 W2.21): empty, or ONE bare address. The same parser as the recipient fields
// (recipients.ts) reads it, so what a chip would accept is accepted here; a name part (`Team <team@x.test>`) or a list is not. The Rust side
// (smtp.rs `check_reply_to`) says the same for the saved value. Imports only the two pure modules, so a plain Node script can test it
// (scripts/test-reply-to.mjs).
import { addressOf, splitRecipients } from "./recipients.ts";
import { isEmail } from "./addresses.ts";

/** The address to save ("" = no Reply-To), or null when the text is not one address. `hosts`: one-label hosts that count (the mailboxes' own). */
export function parseReplyTo(text: string, hosts: readonly string[] = []): string | null {
  const t = text.trim();
  if (t === "") return "";
  const parts = splitRecipients(t);
  if (parts.length !== 1) return null;
  const address = addressOf(parts[0]);
  if (parts[0].trim() !== address) return null; // a name part
  return isEmail(address, hosts) ? address : null;
}
