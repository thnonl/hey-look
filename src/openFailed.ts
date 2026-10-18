// What a link that no program could open says and copies (src/updates.ts `openUpdateLink`). Pure, so scripts/test-open-failed-text.mjs runs it as it is.
// A `mailto:` link names the default mail app and copies only the address (what can be pasted into a To field); any other link keeps the browser texts.

/** The address part of a `mailto:` link: `mailto:` and everything from `?` removed, percent-decoded (several addresses stay comma-separated). Null when the link is no mailto link or has no address. */
export function mailtoAddress(url: string): string | null {
  const m = /^mailto:([^?]*)/i.exec(url.trim());
  if (!m) return null;
  let address = m[1];
  try {
    address = decodeURIComponent(address);
  } catch {
    /* a stray % : keep the text as it is */
  }
  address = address.trim();
  return address || null;
}

/** What goes on the clipboard when the link could not be opened. */
export const linkToCopy = (url: string): string => mailtoAddress(url) ?? url;

const cut = (s: string) => (s.length > 100 ? s.slice(0, 100) + "…" : s);

/** The toast after a failed open: the dictionary key and its values, for whether `linkToCopy(url)` reached the clipboard. */
export function failedOpenText(url: string, copied: boolean):
  | { key: "updates.toast.mailtoFailedCopied" | "updates.toast.openFailedCopied"; vars?: undefined }
  | { key: "updates.toast.mailtoFailedNotCopied"; vars: { address: string } }
  | { key: "updates.toast.openFailedNotCopied"; vars: { url: string } } {
  const address = mailtoAddress(url);
  if (address) return copied ? { key: "updates.toast.mailtoFailedCopied" } : { key: "updates.toast.mailtoFailedNotCopied", vars: { address: cut(address) } };
  return copied ? { key: "updates.toast.openFailedCopied" } : { key: "updates.toast.openFailedNotCopied", vars: { url: cut(url) } };
}
