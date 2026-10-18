// Change case (spec-rich-text.md REQ-50): Sentence case., lowercase, UPPERCASE, Capitalize Each Word, tOGGLE cASE, and Shift+F3, which goes round
// lowercase -> UPPERCASE -> Capitalize Each Word. The text changes, the marks of the text stay. Lazy: fetched when the first case is chosen
// (controls.tsx), nothing of it is in the first bundle. The transforms are pure (a plain Node script tests them: scripts/test-change-case.mjs).

import type { Mark } from "@tiptap/pm/model";
import type { Editor } from "@tiptap/react";

export type CaseMode = "sentence" | "lower" | "upper" | "title" | "toggle";

const LETTER = /\p{L}/u;
const isLetter = (c: string) => LETTER.test(c);
const lower = (s: string) => s.toLocaleLowerCase();
const upper = (s: string) => s.toLocaleUpperCase();

/** The first letter of each word in capitals, the rest in lowercase (an apostrophe or a hyphen inside a word does not start a new one). */
export function titleCase(s: string): string {
  let out = "";
  let inWord = false;
  for (const ch of s) {
    if (isLetter(ch)) {
      out += inWord ? lower(ch) : upper(ch);
      inWord = true;
    } else {
      out += ch;
      // (a digit is part of a word: "3rd" stays; an apostrophe or a hyphen inside a word does not end it)
      inWord = /\p{N}/u.test(ch) || (inWord && (ch === "'" || ch === "’" || ch === "-"));
    }
  }
  return out;
}

/** Everything lowercase except the first letter of the text and of each sentence (after . ! ? … and a line break). */
export function sentenceCase(s: string): string {
  let out = "";
  let start = true;
  for (const ch of lower(s)) {
    if (start && isLetter(ch)) {
      out += upper(ch);
      start = false;
    } else {
      out += ch;
      if (/[.!?…\n\r]/.test(ch)) start = true;
      else if (isLetter(ch) || /\p{N}/u.test(ch)) start = false;
    }
  }
  return out;
}

export function toggleCase(s: string): string {
  let out = "";
  for (const ch of s) out += ch === upper(ch) ? lower(ch) : upper(ch);
  return out;
}

export function applyCase(s: string, mode: CaseMode): string {
  switch (mode) {
    case "lower": return lower(s);
    case "upper": return upper(s);
    case "title": return titleCase(s);
    case "toggle": return toggleCase(s);
    default: return sentenceCase(s);
  }
}

const CYCLE: readonly CaseMode[] = ["lower", "upper", "title"];

/** The mode Shift+F3 applies next: the one after the case the text has now (a text that has none of the three starts with lowercase). */
export function nextInCycle(s: string): CaseMode {
  const at = CYCLE.findIndex((m) => applyCase(s, m) === s);
  return CYCLE[(at + 1) % CYCLE.length];
}

/** A caret inside a word takes that word; the selection otherwise. Returns the range or null when there is nothing to change. */
function range(editor: Editor): { from: number; to: number } | null {
  const { from, to, empty, $from } = editor.state.selection;
  if (!empty) return { from, to };
  const block = $from.parent;
  if (!block.isTextblock) return null;
  const text = block.textBetween(0, block.content.size, "\n", "￼");
  const at = $from.parentOffset;
  const word = (c: string | undefined) => !!c && (isLetter(c) || /\p{N}/u.test(c));
  let a = at;
  let b = at;
  while (a > 0 && word(text[a - 1])) a--;
  while (b < text.length && word(text[b])) b++;
  return a === b ? null : { from: $from.start() + a, to: $from.start() + b };
}

/** Change the case of the selection (of the word at the caret when nothing is selected). `mode` null: Shift+F3, the next case of the cycle. True when there was text. */
export function changeCase(editor: Editor, mode: CaseMode | null): boolean {
  const r = range(editor);
  if (!r) return false;
  const { state } = editor;
  const whole = state.doc.textBetween(r.from, r.to, "\n", "￼");
  const how = mode ?? nextInCycle(whole);
  const tr = state.tr;
  // every run of text keeps its marks; the replacements go from the end so the earlier positions hold. Sentence case needs the text of the
  // whole range (a run that starts mid-sentence is not capitalised), so the result is cut back into the runs by their lengths.
  const runs: { pos: number; text: string; marks: readonly Mark[] }[] = [];
  state.doc.nodesBetween(r.from, r.to, (node, pos) => {
    if (!node.isText) return true;
    const from = Math.max(r.from, pos);
    const to = Math.min(r.to, pos + node.nodeSize);
    runs.push({ pos: from, text: node.text!.slice(from - pos, to - pos), marks: node.marks });
    return false;
  });
  const joined = runs.map((x) => x.text).join("");
  const out = applyCase(joined, how);
  // (a case change can change the length: "ß" -> "SS". Then the first run takes the whole result and the others go: the marks of the first one win.)
  let used = 0;
  const parts = runs.map((x, i) => {
    if (out.length !== joined.length) return i === 0 ? out : "";
    const piece = out.slice(used, used + x.text.length);
    used += x.text.length;
    return piece;
  });
  for (let i = runs.length - 1; i >= 0; i--) {
    const x = runs[i];
    if (parts[i] === x.text) continue;
    tr.replaceWith(x.pos, x.pos + x.text.length, parts[i] ? state.schema.text(parts[i], x.marks) : []);
  }
  if (tr.docChanged) {
    // the selection stays on the changed text
    editor.view.dispatch(tr.scrollIntoView());
  }
  return true;
}
