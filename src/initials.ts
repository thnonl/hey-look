// The letters shown in an avatar (pure, so scripts/test-initials.mjs can test it).
//
// The first letter or digit of the first word and of the last word that has one; never an emoji, a symbol, a joiner or a variation selector, and never half of a surrogate pair (the name is read by
// code point, not by UTF-16 unit). A letter keeps the accents written after it (Vietnamese). A name without any letter or digit gives "?".
const FIRST = /[\p{L}\p{N}]\p{M}*/u;

export function initials(s: string): string {
  const letters = s
    .replace(/<.*>/, "")
    .trim()
    .split(/\s+/)
    .map((w) => FIRST.exec(w)?.[0] ?? "")
    .filter(Boolean);
  if (letters.length === 0) return "?";
  return (letters.length > 1 ? letters[0] + letters[letters.length - 1] : letters[0]).toUpperCase();
}
