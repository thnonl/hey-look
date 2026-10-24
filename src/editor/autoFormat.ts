// AutoFormat as you type (spec-107-wp3.md W3.2, spec-rich-text.md REQ-46): typographic quotes of the app language, the dash, the ellipsis, arrows and (c) (r) (tm), made as the
// character that completes the pattern is typed. Not built on TipTap's input rules (they also run on `compositionend` and Backspace undoes them): this is a small plugin with
// `handleTextInput`, which a keystroke reaches and a paste, a drop, an input-method commit, Find and replace, Change case, Insert and a template never do.
//
//  - `autoFormatFor` is the pure part: the text before the caret and the typed character in, the edit out. It needs no editor and no DOM (scripts/test-autoformat.mjs).
//  - `autoFormatPlugin` is the editor part: the typed character is put in as usual (one undo group with the typing around it), then the replacement is a second transaction in an undo
//    group of its own. Ctrl+Z right after it (`undoAutoFormat`, the Mod-z key of the extension, ahead of the history key) is the history's undo of that one group: the typed
//    characters are back, the caret is behind them, and nothing is converted again; a second Ctrl+Z is the ordinary undo of the typing. Backspace is not touched (it deletes the
//    character before the caret as usual).
//  - Never: in the Code style or inline code, in link text, in a run of non-space characters that is an address or a URL, while an input method composes.
//
// Pure apart from the plugin (imports ProseMirror only): the options (`enabled`, `lang`) come from extensions.ts, so a plain Node script runs the very plugin the editor uses.

import { Extension } from "@tiptap/core";
import { closeHistory, undo, undoDepth } from "@tiptap/pm/history";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

/** The characters of one language (spec-107-wp3.md T-Q). `dash` null: `--` is not replaced. */
export interface QuoteStyle {
  dOpen: string;
  dClose: string;
  sOpen: string;
  sClose: string;
  /** the apostrophe after a letter or digit */
  apos: string;
  dash: string | null;
}

const NBSP = " ";
const EN: QuoteStyle = { dOpen: "“", dClose: "”", sOpen: "‘", sClose: "’", apos: "’", dash: "–" };

/** T-Q: the quotes and the dash per app language (French: the guillemets hold a no-break space; Russian: `'` is always the apostrophe). */
export const QUOTE_STYLES: Record<string, QuoteStyle> = {
  en: EN,
  vi: EN,
  fr: { ...EN, dOpen: `«${NBSP}`, dClose: `${NBSP}»` },
  "zh-Hans": { ...EN, dash: "——" },
  es: { ...EN, dOpen: "«", dClose: "»", dash: "—" },
  ja: { ...EN, dash: null },
  de: { dOpen: "„", dClose: "“", sOpen: "‚", sClose: "‘", apos: "’", dash: "–" },
  ru: { ...EN, dOpen: "«", dClose: "»", sOpen: "’", sClose: "’", dash: "—" },
};

/** The style of a language code; an unknown one (and the pseudo-locale) is English. */
export const styleFor = (lang: string): QuoteStyle => QUOTE_STYLES[lang] ?? EN;

/** What to do for a typed character: the `del` characters before the caret AND the typed character are replaced by `insert` (which holds the typed character when it is kept). */
export interface AutoEdit {
  del: number;
  insert: string;
}

/** Where the caret is, as the plugin knows it: the Code style and inline code and link text never get a replacement. */
export interface AutoCtx {
  code?: boolean;
  link?: boolean;
}

// an opening quote follows: the start of the paragraph, a space, one of these, or an opening quote of any language
const OPENERS = new Set(["(", "[", "{", "<", "/", "–", "—", "“", "‘", "„", "‚", "«", "‹"]);
/**
 * The last character that is SEEN: invisible format characters (a zero-width space or joiner, a direction mark, a word joiner, a BOM) at the end do not count, so a paragraph that
 * starts with one (a marker some editors, signatures and pasted texts leave) still opens with an opening quote (D-091: the first quote typed after focusing the body must not be
 * taken for a closing one because of what is invisible before it).
 */
const lastChar = (s: string): string => s.replace(/\p{Cf}+$/u, "").slice(-1);
const opensAfter = (prev: string): boolean => prev === "" || /\s/u.test(prev) || OPENERS.has(prev);
const alnum = (c: string): boolean => /[\p{L}\p{N}]/u.test(c);
/** A run of non-space characters that is an address or a URL (or is on its way to be one): nothing in it is replaced. */
const addressRun = (before: string): boolean => {
  const run = /\S*$/u.exec(before)![0];
  return /^(?:https?:\/\/|www\.|mailto:)/i.test(run) || run.includes("@");
};

function doubleQuote(before: string, s: QuoteStyle): AutoEdit {
  const prev = lastChar(before);
  if (opensAfter(prev)) return { del: 0, insert: s.dOpen };
  // (French: the closing mark brings its own no-break space; a plain space before the quote is an opening context, so there is never a double space)
  return { del: 0, insert: s.dClose };
}

function singleQuote(before: string, s: QuoteStyle, lang: string): AutoEdit {
  if (lang === "ru") return { del: 0, insert: s.apos };
  const prev = lastChar(before);
  if (prev && alnum(prev)) {
    // after a letter or digit: the closing mark when this paragraph has an opening one that nothing closed, else the apostrophe
    const open = before.lastIndexOf(s.sOpen);
    return { del: 0, insert: open >= 0 && !before.slice(open + 1).includes(s.sClose) ? s.sClose : s.apos };
  }
  return { del: 0, insert: opensAfter(prev) ? s.sOpen : s.sClose };
}

/** The replacements that do not depend on a dash waiting before the caret. */
function core(before: string, typed: string, s: QuoteStyle, lang: string): AutoEdit | null {
  switch (typed) {
    case '"':
      return doubleQuote(before, s);
    case "'":
      return singleQuote(before, s, lang);
    case ".":
      return before.endsWith("..") && !before.endsWith("...") ? { del: 2, insert: "…" } : null;
    case ">":
      // --> and -> (exactly two or one hyphen)
      if (before.endsWith("--") && !before.endsWith("---")) return { del: 2, insert: "→" };
      if (before.endsWith("-") && !before.endsWith("--")) return { del: 1, insert: "→" };
      return null;
    case "-":
      return before.endsWith("<") ? { del: 1, insert: "←" } : null;
    case ")":
      if (before.endsWith("(c")) return { del: 2, insert: "©" };
      if (before.endsWith("(r")) return { del: 2, insert: "®" };
      if (before.endsWith("(tm")) return { del: 3, insert: "™" };
      return null;
    default:
      return null;
  }
}

/**
 * `before`: the text of the paragraph before the caret (a line break counts as "\n"); `typed`: the one character that was typed; `lang`: the app language.
 * Null: nothing to do (the character goes in as typed).
 *
 * `--` becomes the dash of the language when the next character is typed and it is not a hyphen, a letter or a digit (so `qa--1@example.test` and `a---b` stay as typed), and
 * only with a non-space character before the hyphens (so `-- ` at the start of a paragraph, a plain-text signature separator, stays). `---` + Enter at the start of an empty
 * paragraph is the Markdown rule of the editor and is not touched (Enter is no text input).
 */
export function autoFormatFor(before: string, typed: string, lang: string, ctx: AutoCtx = {}): AutoEdit | null {
  if (ctx.code || ctx.link) return null;
  if ([...typed].length !== 1) return null;
  if (addressRun(before)) return null;
  const s = styleFor(lang);
  const dash =
    s.dash !== null && typed !== ">" && typed !== "-" && !alnum(typed) && before.endsWith("--") && !before.endsWith("---") && /\S/u.test(before.slice(0, -2));
  if (dash) {
    // the dash first, then the typed character as it would be typed behind the dash (a quote, a bracket ...)
    const after = before.slice(0, -2) + s.dash;
    const e = core(after, typed, s, lang);
    return { del: 2 + (e?.del ?? 0), insert: s.dash + (e ? e.insert : typed) };
  }
  return core(before, typed, s, lang);
}

// ---------------------------------------------------------------- the editor part

/** The last replacement while nothing else has happened: where it stands and what it is, so Ctrl+Z can tell it is the very last thing done. */
interface Last {
  pos: number;
  insert: string;
}

export const autoFormatKey = new PluginKey<Last | null>("autoFormat");

export interface AutoFormatOptions {
  /** the switch of Settings > Composing, read at every keystroke */
  enabled: () => boolean;
  /** the app language, read at every keystroke (a switch changes new replacements only) */
  lang: () => string;
}

export function autoFormatPlugin(o: AutoFormatOptions): Plugin {
  // an input method commits through the same path as a key: while it composes, and for a moment after it ends, nothing is replaced
  let composing = false;
  let endedAt = -1e9;
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  return new Plugin<Last | null>({
    key: autoFormatKey,
    state: {
      init: () => null,
      apply: (tr, prev) => {
        const m = tr.getMeta(autoFormatKey) as Last | null | undefined;
        if (m !== undefined) return m;
        return tr.docChanged || tr.selectionSet ? null : prev;
      },
    },
    props: {
      handleDOMEvents: {
        compositionstart: () => ((composing = true), false),
        compositionend: () => ((composing = false), (endedAt = now()), false),
      },
      handleTextInput(view, from, to, text) {
        if (from !== to || !o.enabled() || composing || view.composing || now() - endedAt < 150) return false;
        const { state } = view;
        if ([...text].length !== 1) return false;
        const $from = state.doc.resolve(from);
        const parent = $from.parent;
        if (!parent.isTextblock) return false;
        const marks = state.storedMarks ?? $from.marks();
        const ctx: AutoCtx = { code: Boolean(parent.type.spec.code) || marks.some((m) => m.type.name === "code"), link: marks.some((m) => m.type.name === "link") };
        const before = state.doc.textBetween($from.start(), from, undefined, "\n");
        const e = autoFormatFor(before, text, o.lang(), ctx);
        if (!e) return false;
        // the typed character goes in as usual (the typing around it stays one undo group) ...
        view.dispatch(state.tr.insertText(text, from, to).setMeta("uiEvent", "input"));
        // ... and the replacement is a step of its own: one Ctrl+Z gives the typed characters back
        const start = from - e.del;
        const tr = view.state.tr.insertText(e.insert, start, from + text.length);
        tr.setSelection(TextSelection.create(tr.doc, start + e.insert.length));
        closeHistory(tr);
        tr.setMeta(autoFormatKey, { pos: start, insert: e.insert } satisfies Last).scrollIntoView();
        view.dispatch(tr);
        return true;
      },
    },
  });
}

/**
 * Ctrl+Z right after a replacement: the history's undo of that one step, so the typed characters are back with the caret behind them. False when the last thing done is anything
 * else (the key then goes on to the history as always).
 */
export function undoAutoFormat(view: EditorView): boolean {
  const last = autoFormatKey.getState(view.state);
  if (!last) return false;
  const { selection: sel, doc } = view.state;
  if (!sel.empty || sel.from !== last.pos + last.insert.length || doc.textBetween(last.pos, sel.from, undefined, "\n") !== last.insert) return false;
  if (undoDepth(view.state) === 0) return false;
  return undo(view.state, (tr) => view.dispatch(tr));
}

/** The extension every rich editor has (extensions.ts): the plugin, and Mod-z ahead of the history's key. */
export const AutoFormat = (o: AutoFormatOptions) =>
  Extension.create({
    name: "autoFormat",
    priority: 1000,
    addProseMirrorPlugins: () => [autoFormatPlugin(o)],
    addKeyboardShortcuts() {
      return { "Mod-z": () => undoAutoFormat(this.editor.view) };
    },
  });
