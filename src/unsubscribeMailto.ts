/** The compose fields an unsubscribe `mailto:` link asks for (RFC 2369 / 6068): the address, and the `subject` and `body` of its query. The subject often carries the
 *  sender's token for this reader (SendGrid: `?subject=1365094.XXXX`), so a message without it unsubscribes nobody. Nothing but those three is read. */
export function unsubscribeMailto(target: string): { to: string; subject: string; body?: string } {
  const rest = target.replace(/^mailto:/i, "");
  const q = rest.indexOf("?");
  const dec = (s: string) => {
    try {
      return decodeURIComponent(s.replace(/\+/g, "%20"));
    } catch {
      return s;
    }
  };
  const to = dec(q < 0 ? rest : rest.slice(0, q)).split(",")[0].trim();
  let subject = "unsubscribe";
  let body: string | undefined;
  if (q >= 0) {
    for (const part of rest.slice(q + 1).split("&")) {
      const eq = part.indexOf("=");
      const key = (eq < 0 ? part : part.slice(0, eq)).toLowerCase();
      const val = eq < 0 ? "" : dec(part.slice(eq + 1));
      if (key === "subject" && val.trim()) subject = val;
      else if (key === "body" && val.trim()) body = val;
    }
  }
  return { to, subject, body };
}
