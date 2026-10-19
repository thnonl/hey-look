// Searching the emoji picker (W2.17): by the name and the keywords of the emoji in the app's language and in English. The names are Unicode CLDR annotations
// (src/editor/emojiNames/<lang>.json, made by scripts/gen-emoji-names.mjs) and are fetched with the picker (`loadEmojiNames`), never part of the main bundle.
// The matching is pure (scripts/test-emoji-search.mjs).

/** emoji -> [short name, keyword, keyword ...] */
export type EmojiNames = Readonly<Record<string, readonly string[]>>;

const NOT_LATIN = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;
const LETTERS: Record<string, string> = { œ: "oe", æ: "ae", ß: "ss", ø: "o", đ: "d", ł: "l", ð: "d", þ: "th" };

/** Lower case and, for text in the Latin script, without accents (Herz = herz, cœur = coeur = coeur, tìm = tim). Other scripts are only lower-cased: の and ゛, й and и are different letters. */
export function foldForSearch(s: string): string {
  const lower = s.toLowerCase();
  if (NOT_LATIN.test(lower)) return lower;
  return lower.normalize("NFD").replace(/\p{M}/gu, "").replace(/[œæßøđłðþ]/g, (c) => LETTERS[c]);
}

/**
 * The emoji of `emoji` (in the order given) whose name or keywords, in any of the `tables` (the UI language, then English), contain every word typed. For Chinese and
 * Japanese the words are plain substrings, so a single character finds its emoji.
 */
export function searchEmoji(query: string, emoji: readonly string[], tables: readonly EmojiNames[]): string[] {
  const words = foldForSearch(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return emoji.filter((e) => {
    const hay = foldForSearch(tables.flatMap((t) => t[e] ?? []).join(" "));
    return words.every((w) => hay.includes(w));
  });
}

/** The short name of an emoji in the first table that has it (the accessible name and the tooltip), else undefined. */
export const emojiName = (e: string, tables: readonly EmojiNames[]): string | undefined => tables.map((t) => t[e]?.[0]).find((n) => !!n);

const FILES: Record<string, () => Promise<{ default: { names: EmojiNames } }>> = {
  en: () => import("./emojiNames/en.json"),
  vi: () => import("./emojiNames/vi.json"),
  fr: () => import("./emojiNames/fr.json"),
  "zh-Hans": () => import("./emojiNames/zh-Hans.json"),
  es: () => import("./emojiNames/es.json"),
  ja: () => import("./emojiNames/ja.json"),
  de: () => import("./emojiNames/de.json"),
  ru: () => import("./emojiNames/ru.json"),
};
const loaded = new Map<string, Promise<EmojiNames>>();
const one = (lang: string): Promise<EmojiNames> => {
  const key = lang in FILES ? lang : "en"; // (the pseudo-locale and anything unknown read as English)
  let p = loaded.get(key);
  if (!p) loaded.set(key, (p = FILES[key]().then((m) => m.default.names)));
  return p;
};

/** The names for the picker: the app language's, then English (a search in German also finds "heart"). The files are separate chunks, fetched when the picker opens. */
export async function loadEmojiNames(lang: string): Promise<EmojiNames[]> {
  return lang === "en" || !(lang in FILES) ? [await one("en")] : [await one(lang), await one("en")];
}
