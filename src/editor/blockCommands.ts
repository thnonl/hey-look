// The commands of the paragraph formats (spec-rich-text.md REQ-17 .. REQ-21) as ProseMirror commands, `(state, dispatch?) => boolean`: alignment,
// indent, line spacing, space after, the marker style of lists and the paragraph style (Normal, Heading 1-3, Quote, Code), and the questions the
// toolbar asks ("what is the alignment over the selection?"). They need a state and a schema, no editor and no DOM, so a plain Node script tests
// them on real documents (scripts/test-block-commands.mjs); the toolbar and the key maps run them through `editor.chain().command(...)`.

import type { Node as PmNode, NodeType } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { liftListItem, sinkListItem } from "@tiptap/pm/schema-list";
import { findWrapping, liftTarget } from "@tiptap/pm/transform";
import { clampIndent, defaultListStyle, normAlign, normListStyle, type Align } from "./blockFormat.ts";

export type Command = (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean;
type Attrs = Record<string, unknown>;

/** What one property is over the selection: the same everywhere (`value`), or mixed. */
export interface Same<T> {
  mixed: boolean;
  value: T;
}

export type StyleName = "normal" | "h1" | "h2" | "h3" | "quote" | "code";

const FORMATTED = new Set(["paragraph", "heading"]);

// ---------------------------------------------------------------- which blocks the selection covers

export interface Blk {
  node: PmNode;
  pos: number;
}

/**
 * The text blocks the selection touches, a caret's paragraph for a caret. A selection that ends at the very start of a block does not take that
 * block in (a triple click selects up to the start of the next paragraph).
 */
export function textblocksOf(state: EditorState): Blk[] {
  const { from, to, empty, $to } = state.selection;
  const out: Blk[] = [];
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.isTextblock) out.push({ node, pos });
    return !node.isTextblock;
  });
  if (!empty && $to.parentOffset === 0 && $to.parent.isTextblock && out.length > 1) {
    const last = out[out.length - 1];
    if (last.pos === $to.before()) out.pop();
  }
  return out;
}

const formatted = (state: EditorState): Blk[] => textblocksOf(state).filter((b) => FORMATTED.has(b.node.type.name));
const insideItem = (state: EditorState, pos: number): boolean => {
  const $p = state.doc.resolve(pos);
  for (let d = $p.depth; d > 0; d--) if ($p.node(d).type.name === "listItem") return true;
  return false;
};

function same<T>(list: T[], eq: (a: T, b: T) => boolean = (a, b) => a === b): Same<T | null> {
  if (!list.length) return { mixed: false, value: null };
  return list.every((x) => eq(x, list[0])) ? { mixed: false, value: list[0] } : { mixed: true, value: null };
}

// ---------------------------------------------------------------- setting an attribute of the paragraphs

/** Change the attributes of every paragraph and heading of the selection; true when there is one (even when nothing changed). */
function updateBlocks(state: EditorState, dispatch: ((tr: Transaction) => void) | undefined, patch: (node: PmNode) => Attrs | null): boolean {
  const blocks = formatted(state);
  if (!blocks.length) return false;
  if (dispatch) {
    const tr = state.tr;
    for (const b of blocks) {
      const p = patch(b.node);
      if (p && Object.entries(p).some(([k, v]) => (b.node.attrs[k] ?? null) !== v)) tr.setNodeMarkup(b.pos, undefined, { ...b.node.attrs, ...p });
    }
    dispatch(tr);
  }
  return true;
}

// ---------------------------------------------------------------- alignment

export function selectionAlign(state: EditorState): Same<Align | "left"> {
  const u = same(formatted(state).map((b) => normAlign(b.node.attrs.textAlign as string) ?? "left"));
  return { mixed: u.mixed, value: u.value ?? "left" };
}

/** Left is no attribute. */
export const setAlign = (value: Align | "left"): Command => (state, dispatch) => updateBlocks(state, dispatch, () => ({ textAlign: value === "left" ? null : value }));

// ---------------------------------------------------------------- indent

/** One step (40 px) more or less on these blocks; 0 stays 0, 8 stays 8. */
function applyIndent(state: EditorState, dispatch: ((tr: Transaction) => void) | undefined, blocks: Blk[], dir: 1 | -1): boolean {
  if (dispatch) {
    const tr = state.tr;
    for (const b of blocks) {
      const cur = clampIndent(b.node.attrs.indent);
      const next = clampIndent(cur + dir);
      if (next !== cur) tr.setNodeMarkup(b.pos, undefined, { ...b.node.attrs, indent: next });
    }
    dispatch(tr);
  }
  return true;
}

/** Whether the selection touches a list item. */
export const touchesList = (state: EditorState): boolean => textblocksOf(state).some((b) => insideItem(state, b.pos));

/** The paragraphs and headings of the selection that are not list items go one step (40 px) in / out; false when there are none. */
export const indentPlain = (dir: 1 | -1): Command => (state, dispatch) => {
  const plain = formatted(state).filter((b) => !insideItem(state, b.pos));
  return plain.length > 0 && applyIndent(state, dispatch, plain, dir);
};

/** The list items of the selection go one level in / out (Tab, Shift+Tab do the same); false when the selection has no list item or cannot move. */
export const indentList = (dir: 1 | -1): Command => (state, dispatch) => {
  const item = state.schema.nodes.listItem as NodeType | undefined;
  return !!item && touchesList(state) && (dir > 0 ? sinkListItem(item) : liftListItem(item))(state, dispatch);
};

// ---------------------------------------------------------------- line spacing and space after

/** `null` is single spacing. */
export const setLineHeight = (value: string | null): Command => (state, dispatch) => updateBlocks(state, dispatch, () => ({ lineHeight: value }));

export function selectionLineHeight(state: EditorState): Same<string | null> {
  const u = same(formatted(state).map((b) => (b.node.attrs.lineHeight as string | null) ?? null));
  return { mixed: u.mixed, value: u.value ?? null };
}

const hasSpaceAfter = (n: PmNode): boolean => (n.type.name === "heading" ? n.attrs.spaceAfter !== "none" : n.attrs.spaceAfter === "add");

/** "Remove space after paragraph" is offered when every block of the selection has some. */
export function selectionHasSpaceAfter(state: EditorState): boolean {
  const blocks = formatted(state);
  return blocks.length > 0 && blocks.every((b) => hasSpaceAfter(b.node));
}

/** Add (10pt) or remove the space after; a paragraph back to nothing is the default (null), a heading without space is "none". */
export const setSpaceAfter = (add: boolean): Command => (state, dispatch) =>
  updateBlocks(state, dispatch, (n) => ({ spaceAfter: add ? "add" : n.type.name === "heading" ? "none" : null }));

// ---------------------------------------------------------------- paragraph formats off (clear formatting)

/** Alignment, indent, line spacing and space after back to the defaults. */
export const resetBlockFormats: Command = (state, dispatch) => updateBlocks(state, dispatch, () => ({ textAlign: null, indent: 0, lineHeight: null, spaceAfter: null }));

// ---------------------------------------------------------------- styles

const HEADINGS: Record<string, number> = { h1: 1, h2: 2, h3: 3 };

function styleAt(state: EditorState, b: Blk): StyleName {
  const t = b.node.type.name;
  if (t === "heading") return (["h1", "h2", "h3"][Number(b.node.attrs.level) - 1] as StyleName | undefined) ?? "h3";
  if (t === "codeBlock") return "code";
  const $p = state.doc.resolve(b.pos);
  for (let d = $p.depth; d > 0; d--) if ($p.node(d).type.name === "blockquote") return "quote";
  return "normal";
}

/** The style over the selection; a mixed selection has no style. */
export function selectionStyle(state: EditorState): Same<StyleName | null> {
  return same(textblocksOf(state).map((b) => styleAt(state, b)));
}

/** Out of every quote the selection is in. */
function liftOutOfQuotes(tr: Transaction): void {
  for (let i = 0; i < 8; i++) {
    let quote = -1;
    tr.doc.nodesBetween(tr.selection.from, tr.selection.to, (node, pos) => {
      if (quote < 0 && node.type.name === "blockquote") quote = pos;
      return quote < 0;
    });
    if (quote < 0) return;
    const node = tr.doc.nodeAt(quote)!;
    const range = tr.doc.resolve(quote + 1).blockRange(tr.doc.resolve(quote + node.nodeSize - 1));
    const target = range ? liftTarget(range) : null;
    if (!range || target === null) return;
    tr.lift(range, target);
  }
}

const CARRY = ["textAlign", "indent", "lineHeight", "spaceAfter"] as const;

/**
 * Styles menu: Normal, Heading 1-3, Quote, Code on every block of the selection. The styles exclude each other (a heading is taken out of a quote),
 * a paragraph keeps its alignment, indent and spacing through Normal and Heading, and Code (no formats) drops them.
 */
export const setStyle = (name: StyleName): Command => (state, dispatch) => {
  const blocks = textblocksOf(state).filter((b) => FORMATTED.has(b.node.type.name) || b.node.type.name === "codeBlock");
  if (!blocks.length) return false;
  if (!dispatch) return true;
  const { paragraph, heading, codeBlock, blockquote } = state.schema.nodes;
  const tr = state.tr;
  const target = name === "code" ? codeBlock : HEADINGS[name] ? heading : paragraph;
  const attrsFor = (n: PmNode): Attrs => {
    if (target === codeBlock) return {};
    const carry: Attrs = {};
    for (const k of CARRY) carry[k] = n.attrs[k] ?? null;
    if (carry.indent == null) carry.indent = 0;
    if (target === paragraph && carry.spaceAfter === "none") carry.spaceAfter = null;
    return target === heading ? { ...carry, level: HEADINGS[name] } : carry;
  };
  tr.setBlockType(blocks[0].pos, blocks[blocks.length - 1].pos + blocks[blocks.length - 1].node.nodeSize, target, (n) => (n.isTextblock ? attrsFor(n) : null));
  if (name !== "quote") liftOutOfQuotes(tr);
  else {
    liftOutOfQuotes(tr);
    const { $from, $to } = tr.selection;
    const range = $from.blockRange($to);
    const wrapping = range ? findWrapping(range, blockquote) : null;
    if (range && wrapping) tr.wrap(range, wrapping);
  }
  dispatch(tr);
  return true;
};

// ---------------------------------------------------------------- lists

const isList = (n: PmNode): boolean => n.type.name === "bulletList" || n.type.name === "orderedList";

interface ListAt {
  node: PmNode;
  pos: number;
  /** how many lists are around it */
  depth: number;
}

/** The innermost list around a text block. */
function listAround(state: EditorState, b: Blk): ListAt | null {
  const $p = state.doc.resolve(b.pos);
  let depth = 0;
  let found: ListAt | null = null;
  for (let d = $p.depth; d > 0; d--) {
    if (isList($p.node(d))) {
      if (!found) found = { node: $p.node(d), pos: $p.before(d), depth: 0 };
      depth++;
    }
  }
  return found ? { ...found, depth: depth - 1 } : null;
}

/** The lists the selection is in (the innermost of each text block), without repeats. */
export function listsOf(state: EditorState): ListAt[] {
  const out: ListAt[] = [];
  for (const b of textblocksOf(state)) {
    const l = listAround(state, b);
    if (l && !out.some((x) => x.pos === l.pos)) out.push(l);
  }
  return out;
}

/** The marker style of the selection's lists of this kind (bulleted or numbered): the shown style at their nesting level; mixed when they differ. */
export function selectionListStyle(state: EditorState, ordered: boolean): Same<string | null> {
  const kind = ordered ? "orderedList" : "bulletList";
  const lists = listsOf(state).filter((l) => l.node.type.name === kind);
  return same(lists.map((l) => normListStyle(ordered, l.node.attrs.listStyle as string) ?? defaultListStyle(ordered, l.depth)));
}

/** The kind of the innermost list at the caret: "bullet", "ordered" or null. */
export function listKind(state: EditorState): "bullet" | "ordered" | null {
  const l = listsOf(state)[0];
  return l ? (l.node.type.name === "orderedList" ? "ordered" : "bullet") : null;
}

/**
 * Give the selection's lists of this kind a marker style (null = the one their nesting level gives). A style that is the level's own is stored as
 * null, so the marker still follows the list when it is moved to another level.
 */
export const setListStyle = (ordered: boolean, style: string | null): Command => (state, dispatch) => {
  const kind = ordered ? "orderedList" : "bulletList";
  const lists = listsOf(state).filter((l) => l.node.type.name === kind);
  if (!lists.length) return false;
  if (dispatch) {
    const tr = state.tr;
    for (const l of lists) {
      const s = normListStyle(ordered, style);
      const stored = s && s !== defaultListStyle(ordered, l.depth) ? s : null;
      tr.setNodeMarkup(l.pos, undefined, { ...l.node.attrs, listStyle: stored, ...(ordered ? { type: null } : {}) });
    }
    dispatch(tr);
  }
  return true;
};
