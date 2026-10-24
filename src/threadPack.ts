// The packed form of a conversation (src-tauri/src/lib.rs `get_thread_packed`, D-103): ONE raw buffer instead of a JSON string with the bodies in it. WKWebView kept big JSON answers of the
// backend alive long after the page was done with them (about the size of each one: Mac QA bisect), so the bodies travel as raw bytes and become strings here, once; the buffer itself is
// not kept by anyone (this function returns strings and plain objects, the caller drops the buffer).
// Layout (little-endian): u32 length of the metadata JSON, the metadata JSON (an array of messages whose `html` and `text` are null), then for each message in the same order: u32 html code,
// u32 text code (0 = none, n + 1 = n bytes), the html bytes, the text bytes (UTF-8). Plain TypeScript with a type-only import, so scripts/test-thread-pack.mjs loads it in Node.
import type { MessageFull } from "./api";

// (`ignoreBOM`: a body that starts with U+FEFF keeps it, as it did in the JSON string)
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** Reads a packed conversation. Throws on a buffer that does not add up (a short or cut answer). */
export function unpackThread(input: ArrayBuffer | ArrayLike<number>): MessageFull[] {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : Uint8Array.from(input); // (an older backend or a mock may hand over a plain list of bytes)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = (end: number) => {
    if (end > bytes.byteLength) throw new Error("the conversation answer is cut short");
  };
  need(4);
  const metaLen = view.getUint32(0, true);
  need(4 + metaLen);
  const messages = JSON.parse(decoder.decode(bytes.subarray(4, 4 + metaLen))) as MessageFull[];
  let at = 4 + metaLen;
  for (const m of messages) {
    need(at + 8);
    const htmlCode = view.getUint32(at, true);
    const textCode = view.getUint32(at + 4, true);
    at += 8;
    const part = (code: number): string | null => {
      if (code === 0) return null;
      const end = at + code - 1;
      need(end);
      const s = decoder.decode(bytes.subarray(at, end));
      at = end;
      return s;
    };
    m.html = part(htmlCode);
    m.text = part(textCode);
  }
  if (at !== bytes.byteLength) throw new Error("the conversation answer has bytes left over");
  return messages;
}

/** The same packing in TypeScript: the backend of the dev preview (src/devMock.ts) and the tests use it; the app never does. */
export function packThread(messages: MessageFull[]): ArrayBuffer {
  const enc = new TextEncoder();
  const meta = enc.encode(JSON.stringify(messages.map((m) => ({ ...m, html: null, text: null }))));
  const parts: Uint8Array[] = [];
  const u32 = (n: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return b;
  };
  parts.push(u32(meta.length), meta);
  for (const m of messages) {
    const h = m.html == null ? null : enc.encode(m.html);
    const t = m.text == null ? null : enc.encode(m.text);
    parts.push(u32(h ? h.length + 1 : 0), u32(t ? t.length + 1 : 0), h ?? new Uint8Array(0), t ?? new Uint8Array(0));
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out.buffer;
}
