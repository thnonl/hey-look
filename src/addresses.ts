// Is this text an email address the app lets through? Imports nothing, so a plain Node script can test it (scripts/test-addresses.mjs).

const FULL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const SINGLE_LABEL = /^[^\s@<>"]+@[^\s@<>".]+$/;

/**
 * `name@domain.tld` always; `name@host` (one label, no dot) only for `localhost` and for hosts the person's own accounts use
 * (`singleLabelHosts`): a local or intranet mail server has addresses like `qa@localhost`, while `ann@gmail` is most likely a typo
 * (QA BUG-M3: `qa@localhost` was refused with "Check the address" although it is the account's own address).
 */
export function isEmail(addr: string, singleLabelHosts: readonly string[] = []): boolean {
  if (FULL.test(addr)) return true;
  if (!SINGLE_LABEL.test(addr)) return false;
  const host = addr.slice(addr.indexOf("@") + 1).toLowerCase();
  return host === "localhost" || singleLabelHosts.some((h) => h.toLowerCase() === host);
}

/** The one-label hosts of the accounts: the domain of each address and its IMAP / SMTP servers. */
export function singleLabelHostsOf(accounts: readonly { email: string; imapHost?: string; smtpHost?: string }[]): string[] {
  return accounts
    .flatMap((a) => [a.email.split("@")[1] ?? "", a.imapHost ?? "", a.smtpHost ?? ""])
    .filter((h) => h !== "" && !h.includes("."));
}
