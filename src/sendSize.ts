// How big a message is ON THE WIRE, and what the server accepts (QA round 17, G-07 / CF-21). A file is sent as base64 in lines of 76
// characters (+ CRLF), so 24.9 MiB of files is 34.07 MiB of data for the server, and most servers count that (their limit is on the whole
// message, e.g. "SIZE 26214400" in the EHLO reply). The composer counts the same way and shows the real number.
// Pure (no imports). Run: node --experimental-strip-types scripts/test-send-size.mjs

/** What most servers accept (Gmail, Outlook, Yahoo ... about 25 MB); used while the server's own SIZE limit is unknown. */
export const USUAL_LIMIT = 25 * 1024 * 1024;

/** Bytes of a base64 text of `n` characters once it is cut into lines of 76 characters with CRLF. */
export const base64Wire = (n: number): number => n + 2 * Math.ceil(n / 76);

/** Base64 characters needed for `rawBytes` bytes. */
export const base64Chars = (rawBytes: number): number => Math.ceil(rawBytes / 3) * 4;

const utf8Length = (s: string): number => new TextEncoder().encode(s).length;
const isAscii = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 126) return false;
  return true;
};

/** The headers of one MIME part: Content-Type / -Disposition / -Transfer-Encoding with the name (twice; a non-ASCII name is %-encoded: 3 bytes per byte). */
export const partHeaders = (filename: string): number => 220 + 2 * (isAscii(filename) ? filename.length : utf8Length(filename) * 3);

/** One file (given as the length of its base64 text, as the composer keeps it) as a MIME part on the wire. */
export const attachmentWire = (filename: string, base64Length: number): number => base64Wire(base64Length) + partHeaders(filename);

/** A picture in the body (its raw bytes; it travels as a related part). */
export const pictureWire = (rawBytes: number, filename = "picture.png"): number => base64Wire(base64Chars(rawBytes)) + partHeaders(filename);

/** An encrypted message is armored again (base64 of the whole MIME part, lines of 64). */
export const ARMOR = 1.37;

export interface SizeInput {
  attachments: { filename: string; base64Length: number }[];
  /** raw bytes of each picture in the body */
  pictures?: number[];
  /** length of the HTML and of the text part (0 while only the attachments are counted) */
  htmlLength?: number;
  textLength?: number;
  encrypted?: boolean;
}

/** Bytes the message takes on the wire (headers of the message and of its text parts included, roughly). */
export function wireSize(m: SizeInput): number {
  const files = m.attachments.reduce((n, a) => n + attachmentWire(a.filename, a.base64Length), 0);
  const pics = (m.pictures ?? []).reduce((n, b) => n + pictureWire(b), 0);
  const body = m.htmlLength || m.textLength ? 1500 + (m.htmlLength ?? 0) * 1.1 + (m.textLength ?? 0) * 1.1 : 0;
  const total = files + pics + body;
  return Math.ceil(m.encrypted ? total * ARMOR : total);
}

/**
 * The limit to check against: the smaller of the usual 25 MB and the server's SIZE when it named one (QA 19A BUG-16: a server that takes
 * 5 MB has to block a 5.4 MB message, and one that takes 35 MB still gets the usual 25 MB). `fromServer`: the server's own number is the limit.
 */
export function sendLimit(serverMax: number | null | undefined): { bytes: number; fromServer: boolean } {
  return serverMax && serverMax > 0 && serverMax < USUAL_LIMIT ? { bytes: serverMax, fromServer: true } : { bytes: USUAL_LIMIT, fromServer: false };
}

/**
 * Whether the server is asked again right before Send whatever the backend remembers: a message with files (or pictures) is the one a limit
 * matters for, and a limit the server changed a moment ago must be seen (QA round 20 BUG-01).
 */
export const askFreshBeforeSend = (fileCount: number, pictureCount: number): boolean => fileCount + pictureCount > 0;

/** What `showSizeToast` needs of the toast store (the store's own functions; a fake one in the test). */
export interface ToastHost {
  showToast(text: string, undo: undefined, kind: "error"): void;
  dismissToast(id: number): void;
  /** the id of the newest toast, null when there is none */
  lastToastId(): number | null;
}

/** Shows `text` as THE too-big toast: the one this showed before (files added, then Send pressed, or Send pressed twice) is taken away first. */
export function showSizeToast(host: ToastHost, last: { id: number | null }, text: string): void {
  if (last.id !== null) host.dismissToast(last.id);
  host.showToast(text, undefined, "error");
  last.id = host.lastToastId();
}

/** Whether a failed send was refused for its size (the backend's coded error `SMTP_TOO_LARGE`, smtp.rs explain_send_error). */
export const isSizeRefusal = (e: unknown): boolean => /^SMTP_TOO_LARGE(?![A-Z0-9_])/.test(String(e instanceof Error ? e.message : e).replace(/^Error:\s*/, "").trim());
