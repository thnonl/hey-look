// When the mini toolbar is on screen (spec-107-wp3.md W3.3, REQ-3.3.1 / REQ-3.3.5). The listeners of the editor: the pointer that made the selection (a mouse press and release; touch and pen never
// show it), the keyboard (any key that changes the text or the selection hides it; Ctrl+B / I / U keep it), a scroll of the editor or the pane, a resize, the window losing the focus, the
// focus moving to a field outside the editor and the toolbar, a press outside, an input method composing, Esc. It shows within a tick of the release of the button, never while it is held.
// Part of the editor chunk (FormatBar.tsx); the toolbar itself is MiniToolbar.tsx, loaded the first time it shows.

import type { Editor } from "@tiptap/react";
import type { Mark } from "@tiptap/pm/model";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { useCallback, useEffect, useRef, useState } from "react";
import { keyKeepsMini, miniShouldShow, selectionBox, type Rect, type SelectionKind } from "./miniRules";

/** Where the toolbar is shown: the selection box (clipped to the scroll area) and the selection it was made for. */
export interface MiniShown {
  box: Rect;
  from: number;
  to: number;
  inTable: boolean;
}

export interface MiniFlags {
  enabled: boolean;
  painterOn: boolean;
  /** a menu, palette or popover of the editor's own toolbar is open */
  blocked: boolean;
}

/** Parts of the page that belong to the mini toolbar and the editor around it: a press or focus in them is not "outside". */
const OWN = ".mini-tb, .fmt-pop, .link-pop, .dd-fixed";

/** The client rects of the text the selection covers (the lines, not the boxes of the paragraphs around them). */
function textRects(root: Document | ShadowRoot, range: Range): Rect[] {
  const doc = range.commonAncestorContainer.ownerDocument ?? (root as Document);
  const out: Rect[] = [];
  const walker = doc.createTreeWalker(range.commonAncestorContainer.nodeType === 3 ? range.commonAncestorContainer.parentNode! : range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!range.intersectsNode(n)) continue;
    const sub = doc.createRange();
    sub.selectNodeContents(n);
    if (n === range.startContainer) sub.setStart(n, range.startOffset);
    if (n === range.endContainer) sub.setEnd(n, range.endOffset);
    for (const r of Array.from(sub.getClientRects())) out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  }
  return out;
}

/** The visible part of the editor's scroll area (the nearest ancestor that scrolls) and the window. */
function visibleArea(el: HTMLElement): Rect {
  let clip: Rect = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === "auto" || o === "scroll") {
      const r = p.getBoundingClientRect();
      clip = { left: Math.max(clip.left, r.left), top: Math.max(clip.top, r.top), right: Math.min(clip.right, r.right), bottom: Math.min(clip.bottom, r.bottom) };
      break;
    }
  }
  return clip;
}

/** Every character of the range has the same link: the link bubble owns that case. */
function insideOneLink(editor: Editor, from: number, to: number): boolean {
  let link: Mark | null = null;
  let all = true;
  editor.state.doc.nodesBetween(from, to, (n) => {
    if (!n.isInline) return true;
    const m = n.marks.find((x) => x.type.name === "link") ?? null;
    if (!n.isText || !m || (link && !link.eq(m))) all = false;
    else link ??= m;
    return false;
  });
  return all && link !== null;
}

export function useMiniShow(editor: Editor | null, flags: MiniFlags): { shown: MiniShown | null; hide: () => void } {
  const [shown, setShown] = useState<MiniShown | null>(null);
  const live = useRef({ flags, shown: null as MiniShown | null, pressing: false, composing: false });
  live.current.flags = flags;
  live.current.shown = shown;
  const hide = useCallback(() => setShown(null), []);

  // switched off, or the painter takes over: gone
  useEffect(() => {
    if (!flags.enabled || flags.painterOn) setShown(null);
  }, [flags.enabled, flags.painterOn]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const view = editor.view;
    const dom = view.dom;
    const doc = dom.ownerDocument;
    const win = doc.defaultView!;
    const st = live.current;

    /** The selection has just been made with the mouse: show the toolbar when everything allows it. */
    const evaluate = () => {
      if (editor.isDestroyed) return;
      const sel = editor.state.selection;
      let kind: SelectionKind = "empty";
      if (sel instanceof NodeSelection) kind = "node";
      else if (sel instanceof TextSelection) kind = sel.empty ? "empty" : "text";
      else if (!sel.empty) kind = "cells";
      const inOneLink = kind === "text" && insideOneLink(editor, sel.from, sel.to);
      const ok = miniShouldShow({ enabled: st.flags.enabled, source: "mouse", selection: kind, inOneLink, painterOn: st.flags.painterOn, composing: st.composing || view.composing, blocked: st.flags.blocked });
      const range = ok ? win.getSelection()?.rangeCount ? win.getSelection()!.getRangeAt(0) : null : null;
      const box = range ? selectionBox(textRects(doc, range), visibleArea(dom)) : null;
      setShown(box ? { box, from: sel.from, to: sel.to, inTable: editor.isActive("table") } : null);
    };

    const down = (e: PointerEvent) => {
      // a press hides it (a new mouse selection shows it again on release); touch and pen selections never show it
      st.pressing = e.pointerType === "mouse" && e.button === 0;
      setShown(null);
    };
    const up = (e: PointerEvent) => {
      if (!st.pressing) return;
      st.pressing = false;
      if (e.pointerType !== "mouse") return;
      // (the editor reads the selection the browser made a moment after the button is released; a double or triple click selects on the press and the editor may not have it yet)
      setTimeout(() => {
        const d = win.getSelection();
        if (editor.state.selection.empty && d && !d.isCollapsed) setTimeout(evaluate, 60);
        else evaluate();
      }, 0);
    };
    const cancel = () => (st.pressing = false);
    const press = (e: PointerEvent) => {
      const t = e.target;
      if (st.shown && t instanceof Element && !t.closest(OWN) && !dom.contains(t)) setShown(null); // (a press in the editor is `down`)
    };
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest(OWN)) return; // (the keys of the toolbar and its palettes are theirs)
      if (e.key === "Escape") {
        // Esc: hidden, the focus stays in the text with the selection as it was, and nothing else happens on that press (the paste button, the compose pane get the next one)
        if (st.shown && dom.contains(e.target as Node)) {
          setShown(null);
          e.stopPropagation();
          e.preventDefault();
        }
        return;
      }
      if (!keyKeepsMini(e)) setShown(null);
    };
    const scroll = (e: Event) => {
      const t = e.target;
      if (st.shown && (t === doc || (t instanceof Node && t.contains(dom)))) setShown(null);
    };
    const gone = () => setShown(null);
    const focusin = (e: FocusEvent) => {
      const t = e.target;
      if (st.shown && t instanceof Element && !dom.contains(t) && !t.closest(OWN)) setShown(null);
    };
    const compStart = () => ((st.composing = true), setShown(null));
    const compEnd = () => (st.composing = false);
    // text that changes, or a selection that is not the one the toolbar was made for
    const txn = ({ transaction }: { transaction: { steps: { toJSON(): { stepType?: string } }[]; selectionSet: boolean } }) => {
      if (!st.shown) return;
      const text = transaction.steps.some((s) => {
        const k = s.toJSON().stepType;
        return k === "replace" || k === "replaceAround";
      });
      if (text) return setShown(null);
      const sel = editor.state.selection;
      if (transaction.selectionSet && (sel.from !== st.shown.from || sel.to !== st.shown.to)) setShown(null);
    };

    dom.addEventListener("pointerdown", down, true);
    doc.addEventListener("pointerup", up, true);
    doc.addEventListener("pointercancel", cancel, true);
    doc.addEventListener("pointerdown", press, true);
    doc.addEventListener("keydown", key, true);
    win.addEventListener("scroll", scroll, true);
    win.addEventListener("resize", gone);
    win.addEventListener("blur", gone);
    doc.addEventListener("focusin", focusin);
    dom.addEventListener("compositionstart", compStart);
    dom.addEventListener("compositionend", compEnd);
    editor.on("transaction", txn);
    return () => {
      dom.removeEventListener("pointerdown", down, true);
      doc.removeEventListener("pointerup", up, true);
      doc.removeEventListener("pointercancel", cancel, true);
      doc.removeEventListener("pointerdown", press, true);
      doc.removeEventListener("keydown", key, true);
      win.removeEventListener("scroll", scroll, true);
      win.removeEventListener("resize", gone);
      win.removeEventListener("blur", gone);
      doc.removeEventListener("focusin", focusin);
      dom.removeEventListener("compositionstart", compStart);
      dom.removeEventListener("compositionend", compEnd);
      editor.off("transaction", txn);
    };
  }, [editor]);

  return { shown, hide };
}
