// The header lines of a reply ("On <date>, <who> wrote:") and of a forwarded message ("From / Date / Subject / To"). Every value in
// them comes from the ORIGINAL message (the sender controls it), so it is escaped here before it becomes HTML: a sender name or
// subject of `<img src=x onerror=...>` or `<b>x</b>` is shown as text, never as markup (QA round 17, CF-26 / O-08).
// Pure (no imports): the labels are passed in already translated. Run: node --experimental-strip-types scripts/test-quote-header.mjs

/** `&`, `<`, `>`, `"` and `'` as entities. Safe for text and for a quoted attribute value. */
export function escapeHtml(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"));
}

/** One header value as one line of HTML text: control characters (CR, LF, tab, NUL ...) become a space, then the text is escaped. */
export function headerValueHtml(s: string): string {
  // eslint-disable-next-line no-control-regex
  return escapeHtml(String(s ?? "").replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, " "));
}

/** `Name <address>`, or just the address when there is no name. Both parts are escaped. */
export function senderHtml(fromName: string, fromEmail: string): string {
  return fromName ? `${headerValueHtml(fromName)} &lt;${headerValueHtml(fromEmail)}&gt;` : headerValueHtml(fromEmail);
}

export interface ForwardLabels {
  header: string;
  from: string;
  date: string;
  subject: string;
  to: string;
}

/** The block above a forwarded message, ending with a blank line. `dateText` is the already formatted date. */
export function forwardHeaderHtml(labels: ForwardLabels, m: { fromName: string; fromEmail: string; dateText: string; subject: string; to: string }): string {
  return (
    `<br><br>${headerValueHtml(labels.header)}` +
    `<br>${headerValueHtml(labels.from)} ${senderHtml(m.fromName, m.fromEmail)}` +
    `<br>${headerValueHtml(labels.date)} ${headerValueHtml(m.dateText)}` +
    `<br>${headerValueHtml(labels.subject)} ${headerValueHtml(m.subject)}` +
    `<br>${headerValueHtml(labels.to)} ${headerValueHtml(m.to)}<br><br>`
  );
}
