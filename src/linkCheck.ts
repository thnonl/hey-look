// The warning before a link of a mail is opened (W6.14). A targeted check, not a phishing filter: a false alarm teaches people to click through.
// Pure: the reading pane and the reader window ask `linkWarning(text, href)` and word the answer (reading.body.linkWarn*).
//   L1  the text is a web address and its host differs from the host of the link
//   L2  the text is an e-mail address and the link goes to a web host that is not that address's domain
//   L3  the link's host has a look-alike label (letters of other alphabets that look like Latin ones)
//   L4  the link has a user name or password in front of the host (`https://bank.test@evil.test/`)
// Not warned: text in a sentence that merely contains a domain, words ("Click here") for a plain link, mailto: and tel: links.

export type LinkWarning =
  /** L1 / L2: it is shown as `text` but opens `target` */
  | { kind: "mismatch"; text: string; target: string }
  /** L3: `target` (its `xn--` form) uses letters of other alphabets that look like ordinary ones */
  | { kind: "lookalike"; target: string }
  /** L4: the link hides its real address and opens `target` */
  | { kind: "hidden"; target: string };

/** The letters of Cyrillic and Greek that look like Latin ones (lower case: host names are). Pinned in scripts/test-link-check.mjs. */
export const LOOKALIKES = new Set([..."аеорсухіјѕԁӏԛԝ", ..."οανρτυικϲ"]);

/** A parsed http(s) link, or null (any other scheme, not a URL). */
function webUrl(href: string): URL | null {
  try {
    const u = new URL(href);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/** A host as compared: lower case (the URL parser did it), no trailing dot, no leading `www.`. */
function bare(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

/** The same site: equal hosts, or `target` is a sub-domain of `shown` (`bank.test` -> `login.bank.test`). */
function sameSite(shown: string, target: string): boolean {
  return shown === target || target.endsWith("." + shown);
}

const QUOTES_AND_BRACKETS = "\"'“”‘’«»‹›<>()[]{}";
const INVISIBLE = /[​-‍⁠﻿]/g;

/** The text of a link as an address would be read from it: spaces, quotes, brackets and a final `.` or `,` taken off (repeatedly: `("bank.test").`). */
export function trimmedText(text: string): string {
  let s = text.replace(INVISIBLE, "").trim();
  for (;;) {
    const before = s;
    while (s && (QUOTES_AND_BRACKETS.includes(s[0]) || /\s/.test(s[0]))) s = s.slice(1);
    while (s && (QUOTES_AND_BRACKETS.includes(s[s.length - 1]) || /\s/.test(s[s.length - 1]) || ".,".includes(s[s.length - 1]))) s = s.slice(0, -1);
    if (s === before) return s;
  }
}

/** File extensions that are not top-level domains: `report.pdf` is a file name, not an address. */
const FILE_EXT = new Set(["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "rtf", "csv", "png", "jpg", "jpeg", "gif", "svg", "webp", "html", "htm", "php", "mp3", "mp4", "wav", "exe", "msi", "dmg", "rar", "tar", "gz", "7z", "ics", "eml", "log"]);

/** The host of a text that is a web address as a whole (with or without scheme), else null. */
export function addressHost(text: string): string | null {
  const s = trimmedText(text);
  const m = /^(https?:\/\/)?((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?)(?::\d{1,5})?(?:[/?#]\S*)?$/iu.exec(s);
  if (!m) return null;
  const labels = m[2].toLowerCase().split(".");
  if (!m[1] && !m[2].toLowerCase().startsWith("www.") && FILE_EXT.has(labels[labels.length - 1])) return null;
  const u = webUrl(`https://${m[2]}/`);
  return u ? bare(u.hostname) : null;
}

/** The domain of a text that is an e-mail address as a whole, else null. */
export function mailDomain(text: string): string | null {
  const s = trimmedText(text).replace(/^mailto:/i, "");
  const m = /^[^\s@<>()[\]\\,;:"]+@([\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+)$/u.exec(s);
  if (!m) return null;
  const u = webUrl(`https://${m[1]}/`);
  return u ? bare(u.hostname) : null;
}

// ---- Punycode (RFC 3492): the Unicode form of an `xn--` label, which the URL parser does not give back

const BASE = 36, T_MIN = 1, T_MAX = 26, SKEW = 38, DAMP = 700, INITIAL_BIAS = 72, INITIAL_N = 128;

function adapt(delta: number, count: number, first: boolean): number {
  delta = first ? Math.floor(delta / DAMP) : delta >> 1;
  delta += Math.floor(delta / count);
  let k = 0;
  while (delta > ((BASE - T_MIN) * T_MAX) >> 1) {
    delta = Math.floor(delta / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * delta) / (delta + SKEW));
}

/** The Unicode text of a Punycode string (without the `xn--`), or null when it is not valid. */
export function punycodeDecode(input: string): string | null {
  const out: number[] = [];
  const basic = input.lastIndexOf("-");
  for (let j = 0; j < Math.max(basic, 0); j++) {
    const c = input.charCodeAt(j);
    if (c >= 0x80) return null;
    out.push(c);
  }
  let n = INITIAL_N, i = 0, bias = INITIAL_BIAS;
  for (let idx = basic > 0 ? basic + 1 : 0; idx < input.length; ) {
    const oldi = i;
    for (let w = 1, k = BASE; ; k += BASE) {
      if (idx >= input.length) return null;
      const c = input.charCodeAt(idx++);
      const digit = c >= 48 && c <= 57 ? c - 22 : c >= 65 && c <= 90 ? c - 65 : c >= 97 && c <= 122 ? c - 97 : BASE;
      if (digit >= BASE) return null;
      i += digit * w;
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (digit < t) break;
      w *= BASE - t;
    }
    bias = adapt(i - oldi, out.length + 1, oldi === 0);
    n += Math.floor(i / (out.length + 1));
    i %= out.length + 1;
    if (n > 0x10ffff) return null;
    out.splice(i++, 0, n);
  }
  return String.fromCodePoint(...out);
}

/** The Unicode form of a host name label (an `xn--` label is decoded, any other is returned as it is). */
export function labelUnicode(label: string): string {
  if (!/^xn--/i.test(label)) return label;
  return punycodeDecode(label.slice(4)) ?? label;
}

/** Does a label use letters of other alphabets that look like ordinary ones: Latin mixed with Cyrillic or Greek, or Cyrillic / Greek letters that are all of the look-alike set? */
export function isLookalikeLabel(label: string): boolean {
  const u = labelUnicode(label).toLowerCase();
  const letters = Array.from(u).filter((c) => /\p{L}/u.test(c));
  if (!letters.length) return false;
  const latin = letters.some((c) => /\p{Script=Latin}/u.test(c));
  const other = letters.filter((c) => /\p{Script=Cyrillic}|\p{Script=Greek}/u.test(c));
  if (!other.length) return false;
  if (latin) return true;
  return other.length === letters.length && letters.every((c) => LOOKALIKES.has(c));
}

/** The warning for a link with this text and this target, or null. */
export function linkWarning(text: string, href: string): LinkWarning | null {
  const url = webUrl(href);
  if (!url) return null; // mailto:, tel: and anything else is not judged here
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const target = bare(host);
  if (url.username || url.password) return { kind: "hidden", target: host };
  if (host.split(".").some((l) => (/^xn--/i.test(l) || /[^\x00-\x7f]/.test(l)) && isLookalikeLabel(l))) return { kind: "lookalike", target: host };
  const shown = trimmedText(text).slice(0, 80);
  const address = addressHost(text);
  if (address) return sameSite(address, target) ? null : { kind: "mismatch", text: shown, target };
  const domain = mailDomain(text);
  if (domain) return sameSite(domain, target) ? null : { kind: "mismatch", text: shown, target };
  return null;
}
