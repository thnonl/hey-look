// The recipients of a message as text: ONE parser for typing, paste, drop and a reopened draft (Compose.tsx), so that
// `"Doe, John" <john@y.test>` stays one recipient wherever it comes from. Imports nothing, so a plain Node script can test it
// (scripts/test-recipients.mjs). The Rust side (smtp.rs `split_mailbox` / `parse_mailbox`) takes one recipient per entry, so the
// list is split here, once.
//
// RFC 5322 shapes handled: quoted display names (`"` and `\` escapes), comments `(like this)`, groups `Team: a@x, b@y;`
// (`undisclosed-recipients:;` is empty), angle addresses, bare addresses, and `, ; newline` as separators outside quotes, comments
// and angle brackets. Pasted spreadsheet rows (`Name<TAB>address`) and lists separated by blanks only are read too. Text that is not
// an address stays as typed (an invalid chip), nothing is thrown away.

/** Index of the character that closes the opener at `i` (a quote, a comment or an angle address), or -1 when it never closes on this line. */
function closeAt(text: string, i: number): number {
  const open = text[i];
  if (open === '"') {
    for (let j = i + 1; j < text.length; j++) {
      const c = text[j];
      if (c === "\\") j++;
      else if (c === '"') return j;
      else if (c === "\n" || c === "\r") return -1;
    }
    return -1;
  }
  if (open === "(") {
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (c === "\\") j++;
      else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) return j;
      else if (c === "\n" || c === "\r") return -1;
    }
    return -1;
  }
  // "<": a quoted local part may hold a `>`
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === '"') {
      const q = closeAt(text, j);
      if (q < 0) return -1;
      j = q;
    } else if (c === ">") return j;
    else if (c === "<" || c === "\n" || c === "\r") return -1;
  }
  return -1;
}

/** The text cut into raw entries at `, ; newline` outside quotes, comments and angle brackets; a group name before `:` is dropped. */
function segments(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c === '"' || c === "(" || c === "<") {
      const end = closeAt(text, i);
      if (end < 0) {
        cur += c; // never closed: an ordinary character
        i++;
      } else {
        cur += text.slice(i, end + 1);
        i = end + 1;
      }
    } else if (c === "," || c === ";" || c === "\n" || c === "\r") {
      out.push(cur);
      cur = "";
      i++;
    } else if (c === ":" && cur.trim() !== "" && !/[@<>]/.test(cur)) {
      cur = ""; // `Team:` / `mailto:` in front of the addresses
      i++;
    } else {
      cur += c;
      i++;
    }
  }
  out.push(cur);
  return out;
}

/** Whether the end of `text` is inside a quote, a comment or an angle address that is still open (a `,` typed there belongs to the name). */
export function openAtEnd(text: string): boolean {
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c === '"' || c === "(" || c === "<") {
      const end = closeAt(text, i);
      if (end < 0) return !/[\r\n]/.test(text.slice(i));
      i = end + 1;
    } else i++;
  }
  return false;
}

const unquote = (s: string): string => {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\(.)/g, "$1");
  return t;
};

/** `Name <address>`; the name is quoted only when it holds characters an unquoted name may not (`, ; : < > ( ) [ ] @ " \`). */
export function formatRecipient(name: string, address: string): string {
  const n = name.replace(/\s+/g, " ").trim();
  if (!n) return address;
  return /[",;:<>()[\]\\@]/.test(n) ? `"${n.replace(/["\\]/g, "\\$&")}" <${address}>` : `${n} <${address}>`;
}

const LOOKS_LIKE_ADDRESS = /^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+$/;

/** Comments of an entry (text in parentheses outside quotes) and the entry without them. */
function stripComments(s: string): { rest: string; comments: string[] } {
  let rest = "";
  const comments: string[] = [];
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    if (c === '"' || c === "<") {
      const end = closeAt(s, i);
      const stop = end < 0 ? i : end;
      rest += s.slice(i, stop + 1);
      i = stop + 1;
    } else if (c === "(") {
      const end = closeAt(s, i);
      if (end < 0) {
        rest += c;
        i++;
      } else {
        comments.push(s.slice(i + 1, end).replace(/\\(.)/g, "$1").trim());
        rest += " ";
        i = end + 1;
      }
    } else {
      rest += c;
      i++;
    }
  }
  return { rest: rest.replace(/[ \t]+/g, " ").trim(), comments: comments.filter(Boolean) };
}

/** One raw entry -> zero or more recipients as `Name <address>` / `address` / the text as typed (not an address). */
function entries(seg: string): string[] {
  const { rest, comments } = stripComments(seg);
  const s = rest.trim();
  if (!s) return [];
  const last = s.lastIndexOf("<");
  if (s.endsWith(">") && last >= 0) {
    const address = s.slice(last + 1, -1).trim();
    const name = unquote(s.slice(0, last)) || comments.join(" ");
    return [formatRecipient(name, address)];
  }
  // a spreadsheet row: `Name<TAB>address` (more fields: the ones that are not addresses are the name)
  if (s.includes("\t")) {
    const fields = s.split(/\t+/).map((f) => f.trim()).filter(Boolean);
    const mails = fields.filter((f) => LOOKS_LIKE_ADDRESS.test(f));
    if (mails.length === 1) return [formatRecipient(fields.filter((f) => f !== mails[0]).join(" ") || comments.join(" "), mails[0])];
    if (mails.length > 1 && mails.length === fields.length) return mails;
  }
  const words = s.split(/\s+/);
  // addresses separated by blanks only: `a@x.test b@y.test`
  if (words.length > 1 && words.every((w) => LOOKS_LIKE_ADDRESS.test(w))) return words;
  // `Ann Lee ann@x.test`: a name in front of a bare address
  const lastWord = words[words.length - 1];
  if (words.length > 1 && LOOKS_LIKE_ADDRESS.test(lastWord) && !words.slice(0, -1).some((w) => w.includes("@"))) {
    return [formatRecipient(unquote(words.slice(0, -1).join(" ")), lastWord)];
  }
  if (LOOKS_LIKE_ADDRESS.test(s) && comments.length) return [formatRecipient(comments.join(" "), s)];
  return [s];
}

/** The recipients in a text (what was typed, pasted, dropped or stored in a draft), in order, as `Name <address>` or `address`. */
export function splitRecipients(text: string): string[] {
  return segments(text).flatMap(entries);
}

/** The address of one recipient: the part in the last angle brackets, else the whole text (as `split_mailbox` in smtp.rs). */
export function addressOf(recipient: string): string {
  const t = recipient.trim();
  const lt = t.lastIndexOf("<");
  return t.endsWith(">") && lt >= 0 ? t.slice(lt + 1, -1).trim() : t;
}

/** The key two recipients are the same by: the address in lower case (the first spelling stays; see `addRecipients`). */
export const recipientKey = (recipient: string): string => addressOf(recipient).toLowerCase();

/** `list` with `more` added, in order, each address once (upper / lower case alike); the first spelling is kept. */
export function addRecipients(list: readonly string[], more: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of [...list, ...more]) {
    const k = recipientKey(r);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

export type RcptField = "to" | "cc" | "bcc";
export interface RcptFields {
  to: string[];
  cc: string[];
  bcc: string[];
}
const FIELD_ORDER: readonly RcptField[] = ["to", "cc", "bcc"];

/**
 * An address belongs to ONE field: the first of To, Cc, Bcc that has it (QA 19A R19A-2; the send already used one RCPT per address). `next`
 * is the new content of `field` (what was there plus what was typed, pasted, dropped or picked). An address that is new in it and already
 * sits in an EARLIER field is not added (`skipped`: it is already there); one that sits in a LATER field is taken from there (`moved`: the
 * field it was in), so the field the person is typing in wins whenever it comes first. Addresses that were in `field` before stay as they are.
 */
export function placeRecipients(
  fields: RcptFields,
  field: RcptField,
  next: readonly string[],
): { fields: RcptFields; skipped: { addr: string; in: RcptField }[]; moved: { addr: string; from: RcptField }[] } {
  const here = FIELD_ORDER.indexOf(field);
  const had = new Set(fields[field].map(recipientKey));
  const out: RcptFields = { to: [...fields.to], cc: [...fields.cc], bcc: [...fields.bcc] };
  const skipped: { addr: string; in: RcptField }[] = [];
  const moved: { addr: string; from: RcptField }[] = [];
  const kept: string[] = [];
  for (const r of next) {
    const k = recipientKey(r);
    if (!had.has(k)) {
      const earlier = FIELD_ORDER.slice(0, here).find((f) => fields[f].some((x) => recipientKey(x) === k));
      if (earlier) {
        if (!skipped.some((x) => recipientKey(x.addr) === k)) skipped.push({ addr: addressOf(r), in: earlier });
        continue;
      }
      for (const f of FIELD_ORDER.slice(here + 1)) {
        if (out[f].some((x) => recipientKey(x) === k)) {
          out[f] = out[f].filter((x) => recipientKey(x) !== k);
          moved.push({ addr: addressOf(r), from: f });
        }
      }
    }
    kept.push(r);
  }
  out[field] = kept;
  return { fields: out, skipped, moved };
}

/** Keyboard / input events of an input method: Enter that confirms a half-converted word must not become a chip. */
export function isImeEvent(e: { isComposing?: boolean; keyCode?: number; key?: string; nativeEvent?: { isComposing?: boolean; keyCode?: number } }): boolean {
  return !!(e.isComposing || e.nativeEvent?.isComposing || e.keyCode === 229 || e.nativeEvent?.keyCode === 229 || e.key === "Process");
}

/** What a chip shows: `Name <address>` without the quotes around a name that needed them. */
export function chipLabel(recipient: string): string {
  const t = recipient.trim();
  const lt = t.lastIndexOf("<");
  if (!t.endsWith(">") || lt < 0) return t;
  const name = unquote(t.slice(0, lt));
  return name ? `${name} ${t.slice(lt)}` : t.slice(lt + 1, -1).trim();
}

/** Whether a message has someone to go to: To may be empty when Cc or Bcc has a recipient (Bcc-only mail is allowed). */
export const hasRecipient = (d: { to: readonly string[]; cc: readonly string[]; bcc: readonly string[] }): boolean => d.to.length + d.cc.length + d.bcc.length > 0;
