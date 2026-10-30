// How a mailbox is named as a short label in the main UI (folder pane, list header, search scope, command bar): the display name the
// person gave it, else its address. Pure, so a script can test it (scripts/test-account-label.mjs). What is sent (Compose's From, "Name <address>")
// and notification titles do not use it.

export interface Labelled {
  email: string;
  displayName?: string | null;
}

/**
 * `text`: what the label shows. `name`: the display name when it is what is shown (null when the address is). `tip`: the tooltip - the full name
 * (a long one is cut with an ellipsis) and the address under it; null when the address is shown, there is nothing more to tell
 * (a display name that is empty, only white space or the address itself counts as none).
 */
export function accountLabel(a: Labelled): { text: string; name: string | null; tip: string | null } {
  const name = (a.displayName ?? "").trim();
  if (!name || name.toLowerCase() === a.email.trim().toLowerCase()) return { text: a.email, name: null, tip: null };
  return { text: name, name, tip: `${name}\n${a.email}` };
}

/** "Name <address>" for a select that lists mailboxes (the event dialog's Calendar, the key dialog's mailbox); the address once when there is no name or the name is the address (BUG-3 of the 1.0.11 RC1 QA: "a@x.com <a@x.com>"). */
export function accountWithAddress(a: Labelled): string {
  const l = accountLabel(a);
  return l.name ? `${l.name} <${a.email}>` : a.email;
}
