/**
 * A long email is translated in parts: the text is cut into pieces of about CHUNK_CHARS characters, each piece is one request, and the
 * answers are put together in the same order (src/translate.ts runs them, src/translateJobs.ts keeps the state). Pure: no store, no UI.
 *
 * Where it is cut, best place first: between paragraphs (blank lines), then between sentences, then at a line break or a space, and
 * only when the text has none of these within reach (a long run of letters, a data dump) in the middle of it. Whatever stood between two
 * pieces (blank line, space, nothing) is kept, so the translated parts join the way the original was laid out.
 */

/** Characters in one request. The single request of the earlier versions (12,000) worked on every provider; a piece is well inside that,
 *  so even a language that needs more tokens per character (Japanese, Russian, Vietnamese) stays far from a provider's output limit. */
export const CHUNK_CHARS = 8_000;
/** The most that is translated of one message. A longer text is cut at a paragraph or sentence near here and the person is told. */
export const MAX_CHARS = 60_000;

export interface ChunkPlan {
  /** the pieces, in order (at least one, empty only for an empty text) */
  parts: string[];
  /** what stood between piece i and piece i+1 in the original (`parts.length - 1` entries) */
  seps: string[];
  /** the text was longer than `cap`: only its beginning is in `parts` */
  truncated: boolean;
}

interface Range {
  start: number;
  end: number;
}

// a blank line (the lines may hold spaces) ends a paragraph
const PARAGRAPH_BREAK = /[ \t]*\n(?:[ \t]*\n)+/g;
// a sentence ends at . ! ? … followed by white space (closing quotes and brackets stay with it), or at an East Asian full stop
const SENTENCE_BREAK = /[.!?…]+["'”’)\]»]*\s+|[。！？]+[」』”’）]*/g;

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;

/** The ranges of `text[start, end)` between the matches of `re`: white space around a range is not part of it. */
function between(text: string, start: number, end: number, re: RegExp): Range[] {
  const out: Range[] = [];
  const slice = text.slice(start, end);
  let from = 0;
  const push = (a: number, b: number) => {
    const piece = slice.slice(a, b);
    const lead = piece.length - piece.trimStart().length;
    const trimmed = piece.trim();
    if (trimmed) out.push({ start: start + a + lead, end: start + a + lead + trimmed.length });
  };
  for (const m of slice.matchAll(new RegExp(re.source, "g"))) {
    // the full stop stays with its sentence: for a sentence break the match is the end of the sentence plus the space after it
    const cut = re === SENTENCE_BREAK ? m.index + m[0].trimEnd().length : m.index;
    push(from, cut);
    from = m.index + m[0].length;
  }
  push(from, slice.length);
  return out;
}

/** A range longer than `size` with no paragraph or sentence break in it: cut at a line break or a space near the end, else anywhere. */
function hardSplit(text: string, start: number, end: number, size: number): Range[] {
  const out: Range[] = [];
  let pos = start;
  while (end - pos > size) {
    const limit = pos + size;
    const floor = pos + Math.floor(size / 2);
    let cut = -1;
    for (let i = limit; i > floor; i--) {
      if (text[i - 1] === "\n") {
        cut = i;
        break;
      }
    }
    if (cut < 0) {
      for (let i = limit; i > floor; i--) {
        if (/\s/.test(text[i - 1])) {
          cut = i;
          break;
        }
      }
    }
    if (cut < 0) cut = isHigh(text.charCodeAt(limit - 1)) ? limit - 1 : limit; // never in the middle of a surrogate pair
    const piece = text.slice(pos, cut);
    const trimmed = piece.trim();
    if (trimmed) {
      const lead = piece.length - piece.trimStart().length;
      out.push({ start: pos + lead, end: pos + lead + trimmed.length });
    }
    pos = cut;
  }
  const rest = text.slice(pos, end);
  const trimmed = rest.trim();
  if (trimmed) {
    const lead = rest.length - rest.trimStart().length;
    out.push({ start: pos + lead, end: pos + lead + trimmed.length });
  }
  return out;
}

/** The smallest pieces the text is built from, none longer than `size`: paragraphs, else their sentences, else hard cuts. */
function units(text: string, size: number): Range[] {
  const out: Range[] = [];
  for (const para of between(text, 0, text.length, PARAGRAPH_BREAK)) {
    if (para.end - para.start <= size) {
      out.push(para);
      continue;
    }
    for (const s of between(text, para.start, para.end, SENTENCE_BREAK)) {
      if (s.end - s.start <= size) out.push(s);
      else out.push(...hardSplit(text, s.start, s.end, size));
    }
  }
  return out;
}

/** Where a text longer than `cap` is cut: at a paragraph break, else a sentence end, else a space, in the last 30% before `cap`. */
export function capCut(text: string, cap: number): number {
  const window = text.slice(0, cap);
  const floor = Math.floor(cap * 0.7);
  const last = (re: RegExp): number => {
    let at = -1;
    for (const m of window.matchAll(new RegExp(re.source, "g"))) at = m.index;
    return at;
  };
  const para = last(PARAGRAPH_BREAK);
  if (para >= floor) return para;
  let sentence = -1;
  for (const m of window.matchAll(new RegExp(SENTENCE_BREAK.source, "g"))) sentence = m.index + m[0].trimEnd().length;
  if (sentence >= floor) return sentence;
  for (let i = cap; i > floor; i--) if (/\s/.test(window[i - 1])) return i - 1;
  return isHigh(window.charCodeAt(cap - 1)) ? cap - 1 : cap;
}

/**
 * Cut `text` for translation. Pieces are at most `size` characters (white space at their edges is dropped; it is in `seps`), packed
 * greedily so that there are as few as possible. A text longer than `cap` is cut first (`truncated`).
 */
export function planChunks(text: string, size = CHUNK_CHARS, cap = MAX_CHARS): ChunkPlan {
  let src = text.replace(/\r\n?/g, "\n");
  let truncated = false;
  if (src.length > cap) {
    src = src.slice(0, capCut(src, cap));
    truncated = true;
  }
  const us = units(src, size);
  if (us.length === 0) return { parts: [src.trim()], seps: [], truncated };
  const parts: string[] = [];
  const seps: string[] = [];
  let cur = { ...us[0] };
  for (const u of us.slice(1)) {
    if (u.end - cur.start <= size) {
      cur.end = u.end;
      continue;
    }
    parts.push(src.slice(cur.start, cur.end));
    seps.push(src.slice(cur.end, u.start));
    cur = { ...u };
  }
  parts.push(src.slice(cur.start, cur.end));
  return { parts, seps, truncated };
}

/** The translated parts as one text, in the layout of the original (a blank line where there was one, a space where it was a sentence). */
export function joinParts(translated: readonly string[], seps: readonly string[]): string {
  let out = "";
  translated.forEach((p, i) => {
    out += p.trim();
    if (i < translated.length - 1) out += seps[i] ?? "\n\n";
  });
  return out;
}
