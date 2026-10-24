// An email link (`mailto:`) in a received message opens a new message in Hey Look! (1.0.7 W8.10, RFC 6068). Pure, so scripts/test-mailto-link.mjs runs it with node.
// Only the recipients, the subject and the body are taken over: `attach`, `from`, `in-reply-to`, `references`, `x-*` and every other field of the link are ignored for safety.
import { cleanHeaderText } from "./headerText.ts";
import { escapeHtml } from "./quoteHeader.ts";

export interface MailtoFields {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  /** plain text */
  body: string;
}

/** Over To, Cc and Bcc together (the rest is dropped in that order). */
export const MAILTO_MAX_ADDRESSES = 50;
export const MAILTO_MAX_SUBJECT = 255;
export const MAILTO_MAX_BODY = 8000;

/** Percent-decoding as UTF-8 for one part; a part with a bad `%` keeps its raw text, and `+` stays a plus (RFC 6068 is not a form). */
function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const addresses = (list: string): string[] =>
  list
    .split(",")
    .map((a) => cleanHeaderText(decode(a)).trim())
    .filter(Boolean);

/** The fields of a `mailto:` link, or null when the text is not one. */
export function parseMailto(href: string): MailtoFields | null {
  const m = /^mailto:/i.exec(href.trim());
  if (!m) return null;
  const rest = href.trim().slice(m[0].length).replace(/#.*$/s, ""); // (a fragment is no part of the link)
  const q = rest.indexOf("?");
  const to = addresses(q < 0 ? rest : rest.slice(0, q));
  const cc: string[] = [];
  const bcc: string[] = [];
  let subject: string | null = null;
  let body: string | null = null;
  if (q >= 0) {
    for (const part of rest.slice(q + 1).split("&")) {
      if (!part) continue;
      const eq = part.indexOf("=");
      const key = decode(eq < 0 ? part : part.slice(0, eq)).trim().toLowerCase();
      const raw = eq < 0 ? "" : part.slice(eq + 1);
      if (key === "to") to.push(...addresses(raw));
      else if (key === "cc") cc.push(...addresses(raw));
      else if (key === "bcc") bcc.push(...addresses(raw));
      else if (key === "subject" && subject === null) subject = decode(raw);
      else if (key === "body" && body === null) body = decode(raw);
      // every other field is ignored
    }
  }
  // at most 50 addresses in all: To first, then Cc, then Bcc
  let room = MAILTO_MAX_ADDRESSES;
  const take = (list: string[]) => {
    const kept = list.slice(0, room);
    room -= kept.length;
    return kept;
  };
  const t = take(to);
  const c = take(cc);
  const b = take(bcc);
  return {
    to: t,
    cc: c,
    bcc: b,
    subject: cleanHeaderText(subject ?? "").slice(0, MAILTO_MAX_SUBJECT),
    body: (body ?? "").replace(/\r\n?/g, "\n").slice(0, MAILTO_MAX_BODY),
  };
}

/**
 * The body text as the HTML of the typing area: escaped, a blank line starts a paragraph, a single line break is a line break; an empty paragraph follows, so the caret has a line
 * of its own above the signature. "" for no text.
 */
export function bodyTextToHtml(text: string): string {
  const t = text.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "");
  if (!t) return "";
  const paragraphs = t.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`);
  return `${paragraphs.join("")}<p></p>`;
}
