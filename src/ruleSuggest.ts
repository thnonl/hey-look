// What the rule dialog fills in from a message (1.0.8, REQ-3.4 to 3.6): the sender (and "any address at that domain"), the core of the subject, and up to five suggested words.
// Pure and offline (no store, no DOM, no clock, no randomness), so scripts/test-rule-suggest.mjs runs it: the same message always gives the same result.
import { STOP_WORDS } from "./ruleStopwords.ts";

/**
 * Reply / forward prefixes of the 8 languages and common clients (lower case, without the colon). The same list is in src-tauri/src/mailrules.rs (`PREFIXES`); the shared table
 * scripts/data/rule-prefix-cases.json is run by both sides.
 */
const REPLY_PREFIXES: readonly string[] = [
  "re", "fw", "fwd", "aw", "wg", "sv", "vs", "tr", "rv", "res", "enc", "r", "i", "antw", "doorst", "odp", "отв", "ответ", "пересл", "回复", "回覆", "答复", "转发", "轉寄", "返信", "転送",
  "trả lời", "tl", "chuyển tiếp", "ct",
];

const prefixRe = new RegExp(`^\\s*(?:(?:${[...REPLY_PREFIXES].sort((a, b) => b.length - a.length).map((p) => p.replace(/\s+/g, "\\s+")).join("|")})\\s*(?:[\\[(]\\d+[\\])])?\\s*[:：]\\s*)+`, "iu");

/** The subject without the reply / forward prefixes in front of it (repeatedly), trimmed. */
export function stripReplyPrefixes(subject: string): string {
  return subject.replace(prefixRe, "").trim();
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const DIGIT = /\p{Nd}/u;
const BRACKETS = /[[\](){}（）【】「」『』《》〈〉<>]/u;
/** punctuation trimmed from both ends of the piece */
const EDGE = /^[\s\-–—:：|"'“”‘’«»「」『』,.;，。、!?！？]+|[\s\-–—:：|"'“”‘’«»「」『』,.;，。、!?！？]+$/gu;

/** A word that has digits is cut away. In text without spaces (CJK) a run of digits goes with the date and number characters next to it. */
function piecesOf(text: string): string[] {
  const out: string[] = [];
  for (const seg of text.split(BRACKETS)) {
    let cur: string[] = [];
    const flush = () => {
      if (cur.length) out.push(cur.join(" "));
      cur = [];
    };
    for (const word of seg.split(/\s+/).filter(Boolean)) {
      if (!DIGIT.test(word) && !word.includes("#")) {
        cur.push(word);
        continue;
      }
      if (!CJK.test(word)) {
        flush();
        continue;
      }
      // "会议纪要10月25日": the text before, between and after the numbers stays, the numbers and the date characters go
      flush();
      for (const p of word.split(/[#\p{Nd}]+[年月日号號時时分秒]*/u).filter(Boolean)) out.push(p);
    }
    flush();
  }
  return out;
}

const trimEdges = (s: string) => s.replace(EDGE, "");

/** A leading `[...]` list tag (e.g. `[dev-list]`) */
const LIST_TAG = /^\s*\[[^\]]*\]\s*/u;

/** "(no subject)" and nothing at all: no subject condition is offered. */
export function hasSubject(subject: string): boolean {
  const s = subject.trim();
  return s !== "" && !/^\(no subject\)$/i.test(s);
}

/**
 * The part of the subject a "Subject contains" condition starts with (REQ-3.5): reply prefixes off, a list tag off, cut at everything that has digits or brackets, the longest
 * piece kept (the first on a tie), trimmed; with fewer than 2 words (2 characters in CJK text) the subject without its prefixes. It is always a piece of the real subject.
 */
export function subjectCore(subject: string): string {
  const base = stripReplyPrefixes(subject);
  const noTag = base.replace(LIST_TAG, "");
  let best = "";
  for (const p of piecesOf(noTag)) {
    const t = trimEdges(p);
    if ([...t].length > [...best].length) best = t;
  }
  const ok = CJK.test(best) && !/\s/.test(best) ? [...best].length >= 2 : best.split(/\s+/).filter(Boolean).length >= 2;
  return ok ? best : base;
}

/** The value of "Subject is exactly": the subject without its reply prefixes (a list tag and the numbers stay: the engine compares the whole subject). */
export function subjectExact(subject: string): string {
  return stripReplyPrefixes(subject);
}

// ---------- the sender ----------

/** Mail domains that thousands of unrelated people use: "any address at gmail.com" is never offered for them. */
const PUBLIC_DOMAINS = /^(?:gmail\.com|googlemail\.com|outlook\.com|hotmail\.[a-z.]+|live\.[a-z.]+|msn\.com|yahoo\.[a-z.]+|ymail\.com|icloud\.com|me\.com|mac\.com|aol\.com|proton\.me|protonmail\.com|gmx\.[a-z.]+|web\.de|mail\.ru|yandex\.[a-z.]+|qq\.com|163\.com|126\.com|naver\.com)$/;

export const domainOf = (email: string): string => {
  const at = email.lastIndexOf("@");
  return at < 0 ? "" : email.slice(at + 1).trim().toLowerCase();
};

/** The domain to offer as "Any address at {domain}", or null (a public mail domain, my own mailbox, no domain). */
export function offeredDomain(email: string, mine: boolean): string | null {
  const d = domainOf(email);
  return !d || mine || PUBLIC_DOMAINS.test(d) ? null : d;
}

// ---------- suggested words ----------

const norm = (s: string) => s.normalize("NFKC").toLowerCase();

/** Letters needed for a word to be offered: 3 (Latin, Cyrillic, Vietnamese...) or 2 (Han, Kana, Hangul). */
function longEnough(w: string): boolean {
  const n = [...w].length;
  return CJK.test(w) ? n >= 2 : n >= 3;
}

type Segmenter = { segment(s: string): Iterable<{ segment: string; isWordLike?: boolean }> };

function wordsOf(text: string): string[] {
  const Seg = (Intl as unknown as { Segmenter?: new (l: undefined, o: { granularity: "word" }) => Segmenter }).Segmenter;
  if (Seg) {
    const out: string[] = [];
    for (const s of new Seg(undefined, { granularity: "word" }).segment(text)) if (s.isWordLike) out.push(s.segment);
    return out;
  }
  // no Intl.Segmenter (old WebKit): split on what is not a letter; runs of Han / Kana / Hangul give no words
  return text.split(/[^\p{L}\p{M}]+/u).filter((w) => w && !CJK.test(w));
}

/** The text a mail's words are taken from: no quoted lines, nothing after the signature line, no URLs, addresses or words with digits. */
export function bodyForWords(text: string): string {
  const head = text.slice(0, 2000);
  const lines: string[] = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^-- ?$/.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    lines.push(line);
  }
  return lines
    .join("\n")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ")
    .replace(/\S+@\S+/g, " ")
    .split(/\s+/)
    .filter((w) => !DIGIT.test(w))
    .join(" ");
}

export interface WordSource {
  subject: string;
  /** the message text (null: none, e.g. a locked encrypted message) */
  text: string | null;
  senderName: string;
  senderEmail: string;
  confidential?: boolean;
}

/**
 * Up to five words to offer (REQ-3.6): score 3 for a word of the subject plus its count in the text (at most 3); words with a score of 2 or more, best first (the first one
 * written first on a tie); if fewer than 3 qualify, the list is filled up to 3 with words of score 1 in the order they are written. Each word as first written in the message.
 */
export function suggestWords(src: WordSource): string[] {
  if (src.confidential || src.text === null) return [];
  const subject = stripReplyPrefixes(src.subject).replace(LIST_TAG, "");
  const body = bodyForWords(src.text);
  // what names the sender is not worth a rule word: its name, address and domain
  const own = new Set<string>();
  for (const part of `${src.senderName} ${src.senderEmail}`.split(/[^\p{L}\p{M}\p{Nd}]+/u)) if (part) own.add(norm(part));
  const info = new Map<string, { shown: string; first: number; inSubject: boolean; count: number }>();
  let pos = 0;
  const feed = (text: string, isSubject: boolean) => {
    for (const w of wordsOf(text)) {
      const key = norm(w);
      pos++;
      if (!longEnough(key) || STOP_WORDS.has(key) || own.has(key) || DIGIT.test(key)) continue;
      const cur = info.get(key) ?? { shown: w, first: pos, inSubject: false, count: 0 };
      if (isSubject) cur.inSubject = true;
      else cur.count++;
      info.set(key, cur);
    }
  };
  feed(subject, true);
  feed(body, false);
  const scored = [...info.values()].map((v) => ({ ...v, score: (v.inSubject ? 3 : 0) + Math.min(3, v.count) }));
  const good = scored.filter((v) => v.score >= 2).sort((a, b) => b.score - a.score || a.first - b.first).slice(0, 5);
  if (good.length < 3) {
    const rest = scored.filter((v) => v.score < 2).sort((a, b) => a.first - b.first);
    good.push(...rest.slice(0, 3 - good.length));
  }
  return good.map((v) => v.shown);
}

// ---------- the name ----------

/** The auto name of a rule made from a message's sender: `sender` is the display name, else the address, else `@domain`. */
export function senderLabel(name: string, address: string, domainForm: boolean): string {
  if (domainForm) return `@${domainOf(address)}`;
  return name.trim() || address;
}

// ---------- the typed text ----------

/** Split typed text into the values of a condition: on `,` `，` `、` `;`, trimmed, the empty ones dropped. */
export function splitValues(text: string): string[] {
  return text.split(/[,，、;]/).map((s) => s.trim()).filter(Boolean);
}
