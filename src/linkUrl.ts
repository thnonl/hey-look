// The address typed in the link popover of the composer and the signature editor (QA round 17, CF-12 / BUG-21): which links may be made, and
// what they are written as. Only web (http, https), email (mailto) and phone (tel) links; a bare domain gets https://, a bare email
// address gets mailto:. Everything that can run or read local files (javascript:, data:, file:, vbscript:, ftp: ...) is refused here, in
// the sent HTML (outgoing.rs) and in the editor's own link rules.
// Pure (no imports). Run: node --experimental-strip-types scripts/test-link-url.mjs

export type LinkCheck =
  | { ok: true; href: string }
  | { ok: false; reason: "empty" | "scheme" | "invalid" };

export const LINK_SCHEMES = ["http", "https", "mailto", "tel"] as const;
const MAX_LENGTH = 2000;
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/u;

/** A host that can be a web address: a name with a dot, `localhost`, an IPv4 or [IPv6] address. */
function plausibleHost(host: string): boolean {
  if (!host) return false;
  if (host.startsWith("[")) return /^\[[0-9A-Fa-f:.]+\]$/.test(host);
  return host === "localhost" || (host.includes(".") && !host.startsWith(".") && !host.endsWith(".") && !host.includes(".."));
}

function webLink(text: string): LinkCheck {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  // `https://bank.com@evil.test` reads as bank.com but goes to evil.test: no credentials in a link
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || !plausibleHost(url.hostname)) return { ok: false, reason: "invalid" };
  return { ok: true, href: url.href };
}

/** What the person typed -> the address the link gets, or why it cannot be one. */
export function checkLinkUrl(input: string): LinkCheck {
  // eslint-disable-next-line no-control-regex
  const s = input.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (!s) return { ok: false, reason: "empty" };
  if (s.length > MAX_LENGTH) return { ok: false, reason: "invalid" };
  // `example.com:8080/path`, `localhost:3000` look like a scheme but are a host and a port
  const hostPort = /^(?:localhost|(?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+):\d{1,5}(?:[/?#]|$)/i.test(s);
  const scheme = hostPort ? null : /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(s)?.[1]?.toLowerCase();
  if (scheme && !(LINK_SCHEMES as readonly string[]).includes(scheme)) return { ok: false, reason: "scheme" };
  if (/\s/u.test(s) || /[<>"\\]/.test(s)) return { ok: false, reason: "invalid" };
  if (scheme) {
    const rest = s.slice(scheme.length + 1);
    if (scheme === "mailto") {
      const addr = rest.split("?")[0];
      return EMAIL.test(decodeURIComponentSafe(addr)) ? { ok: true, href: `mailto:${rest}` } : { ok: false, reason: "invalid" };
    }
    if (scheme === "tel") return /^\+?[0-9().-]{3,30}$/.test(rest) && (rest.match(/[0-9]/g) ?? []).length >= 3 ? { ok: true, href: `tel:${rest}` } : { ok: false, reason: "invalid" };
    return webLink(`${scheme}:${rest}`);
  }
  if (s.startsWith("//")) return webLink(`https:${s}`);
  if (EMAIL.test(s)) return { ok: true, href: `mailto:${s}` };
  if (s.includes("@") || s.startsWith("/") || s.startsWith("#") || s.startsWith("?")) return { ok: false, reason: "invalid" };
  return webLink(`https://${s}`);
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The text a link without text of its own shows: the address without `mailto:` / `tel:`. */
export const linkDisplayText = (href: string): string => href.replace(/^(mailto|tel):/i, "");

export type LinkPlan = { kind: "insert"; text: string } | { kind: "replace"; text: string } | { kind: "mark" };

/**
 * What applying the popover does. At a bare caret the link text is inserted (the typed text, else the address). On a selection or in a
 * link the text stays as it is unless a different text was typed, which replaces it; the address is set on it either way.
 */
export function planLinkEdit(i: { rangeEmpty: boolean; original: string; typed: string; href: string }): LinkPlan {
  const typed = i.typed.trim();
  if (i.rangeEmpty) return { kind: "insert", text: typed || linkDisplayText(i.href) };
  if (typed && typed !== i.original.trim()) return { kind: "replace", text: typed };
  return { kind: "mark" };
}
