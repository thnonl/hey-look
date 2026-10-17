// Find and replace in the message body (spec-rich-text.md REQ-44, AC-67, AC-68): the matches are found in the text of the editable blocks (the signature
// region and the quoted message hold no editable text, so they are never searched), drawn as decorations, stepped through, replaced one at a time or
// all at once (one undo step). The search itself is pure on a ProseMirror document (scripts/test-find-replace.mjs). Part of the kit chunk (kit.ts):
// nothing of it is in the first bundle; FindBar.tsx, the panel, is fetched when Ctrl+F is first pressed.

import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

export interface Hit {
  from: number;
  to: number;
}

/** A character folded for a search that ignores case; one that would change the length of the text keeps its own form, so positions stay right. */
function fold(s: string): string {
  let out = "";
  for (const ch of s) {
    const l = ch.toLowerCase();
    out += l.length === ch.length ? l : ch;
  }
  return out;
}

/**
 * Every match of `query` in the text blocks of `doc`, in document order. Matches never cross a block, and do not overlap. An inline picture or a line
 * break counts as one character that no query matches.
 */
export function findMatches(doc: PmNode, query: string, matchCase: boolean): Hit[] {
  const out: Hit[] = [];
  if (!query) return out;
  const q = matchCase ? query : fold(query);
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const raw = node.textBetween(0, node.content.size, undefined, "￼");
    const text = matchCase ? raw : fold(raw);
    for (let at = text.indexOf(q); at >= 0; at = text.indexOf(q, at + q.length)) out.push({ from: pos + 1 + at, to: pos + 1 + at + q.length });
    return false;
  });
  return out;
}

export interface FindState {
  query: string;
  matchCase: boolean;
  /** which match is the current one (the one Replace changes), -1 when there is none */
  current: number;
  hits: Hit[];
}

const EMPTY: FindState = { query: "", matchCase: false, current: -1, hits: [] };
export const findKey = new PluginKey<FindState>("findReplace");

type Meta = { query?: string; matchCase?: boolean; current?: number; clear?: boolean };

/** The state after a transaction: the matches are searched again when the text, the query or the case changed; the current one stays at its place as far as it can. */
function next(prev: FindState, tr: Transaction, state: EditorState): FindState {
  const meta = tr.getMeta(findKey) as Meta | undefined;
  if (meta?.clear) return EMPTY;
  if (!meta && !tr.docChanged) return prev;
  const query = meta?.query ?? prev.query;
  const matchCase = meta?.matchCase ?? prev.matchCase;
  if (!query) return { ...EMPTY, matchCase };
  const hits = findMatches(state.doc, query, matchCase);
  let current = meta?.current ?? prev.current;
  if (meta?.query !== undefined || meta?.matchCase !== undefined) {
    // a new query: the first match at or after the caret
    const caret = state.selection.from;
    const i = hits.findIndex((h) => h.to >= caret);
    current = hits.length ? (i < 0 ? 0 : i) : -1;
  }
  if (!hits.length) current = -1;
  else current = Math.min(Math.max(current, 0), hits.length - 1);
  return { query, matchCase, current, hits };
}

/** The plugin on its own (the extension below adds it to an editor; a script builds an editor state with it). */
export const findPlugin = () =>
  new Plugin<FindState>({
    key: findKey,
    state: { init: () => EMPTY, apply: (tr, prev, _old, state) => next(prev, tr, state) },
    props: {
      decorations(state) {
        const s = findKey.getState(state);
        if (!s || !s.hits.length) return null;
        return DecorationSet.create(
          state.doc,
          s.hits.map((h, i) => Decoration.inline(h.from, h.to, { class: i === s.current ? "find-hit find-cur" : "find-hit" })),
        );
      },
    },
  });

export const FindReplace = Extension.create({
  name: "findReplace",
  addProseMirrorPlugins: () => [findPlugin()],
});

export const getFind = (state: EditorState): FindState => findKey.getState(state) ?? EMPTY;

/** Put the search text and the case rule in (the matches are drawn at once). */
export function setSearch(view: EditorView, query: string, matchCase: boolean): FindState {
  view.dispatch(view.state.tr.setMeta(findKey, { query, matchCase } satisfies Meta));
  const s = getFind(view.state);
  reveal(view, s);
  return s;
}

/** Remove the highlights (the panel was closed). */
export function clearSearch(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(findKey, { clear: true } satisfies Meta));
}

/** The match `dir` steps from the current one (round the end), scrolled into view; selected in the document, so Ctrl+C or a typed word works on it. */
export function stepSearch(view: EditorView, dir: 1 | -1): FindState {
  const s = getFind(view.state);
  if (!s.hits.length) return s;
  const current = (s.current + dir + s.hits.length) % s.hits.length;
  view.dispatch(view.state.tr.setMeta(findKey, { current } satisfies Meta));
  const n = getFind(view.state);
  reveal(view, n);
  return n;
}

/** Scroll the current match into view (the editor does not have to have the focus). */
function reveal(view: EditorView, s: FindState): void {
  const h = s.hits[s.current];
  if (!h) return;
  try {
    const at = view.domAtPos(h.from);
    const el = at.node.nodeType === 3 ? at.node.parentElement : (at.node as HTMLElement);
    el?.scrollIntoView?.({ block: "nearest" });
  } catch {
    /* a position the view does not draw (yet): nothing to scroll to */
  }
}

/** The text a replacement goes in with: the marks of the text it replaces (its first character), so a replaced word keeps its bold or colour. */
function replacement(state: EditorState, h: Hit, text: string) {
  const marks = state.doc.nodeAt(h.from)?.marks ?? [];
  return text ? state.schema.text(text, marks) : null;
}

/** Replace the current match, then move to the next one. Returns the state after it. */
export function replaceCurrent(view: EditorView, text: string): FindState {
  const s = getFind(view.state);
  const h = s.hits[s.current];
  if (!h) return s;
  const { state } = view;
  const tr = state.tr;
  const node = replacement(state, h, text);
  if (node) tr.replaceWith(h.from, h.to, node);
  else tr.delete(h.from, h.to);
  // the next match is the one that now sits where the replaced one was: the current index stays, the search is made again by the plugin
  tr.setMeta(findKey, { current: s.current } satisfies Meta);
  view.dispatch(tr);
  const n = getFind(view.state);
  reveal(view, n);
  return n;
}

/** Replace every match in one transaction (one undo step). Returns how many were replaced. */
export function replaceAll(view: EditorView, text: string): number {
  const s = getFind(view.state);
  if (!s.hits.length) return 0;
  const { state } = view;
  const tr = state.tr;
  // from the end, so the positions of the earlier matches hold
  for (let i = s.hits.length - 1; i >= 0; i--) {
    const h = s.hits[i];
    const node = replacement(state, h, text);
    if (node) tr.replaceWith(h.from, h.to, node);
    else tr.delete(h.from, h.to);
  }
  view.dispatch(tr);
  return s.hits.length;
}

/** The selected text of a single block, to start a search with (Ctrl+F with a word selected searches for it). */
export function selectedWord(state: EditorState): string {
  const { from, to, empty } = state.selection;
  if (empty || !(state.selection instanceof TextSelection)) return "";
  const text = state.doc.textBetween(from, to, "\n", "￼");
  return text.length <= 200 && !/[\n￼]/.test(text) ? text : "";
}
