// Paste and drop in every rich-text editor of the app (spec-rich-text.md REQ-23, design 4.3): what comes from the clipboard or from another program is cleaned
// (pasteClean.ts) according to the person's choice, and after a rich paste a small "Paste options" button sits at the end of the pasted text.
//
//   Ctrl+V        the paste default (Settings > Composing > When pasting from other apps): Keep source formatting, Merge formatting or Keep text only
//   Ctrl+Shift+V  always text only (ProseMirror hands us the plain text; a Word list still gets its markers, from the HTML we read ourselves)
//   in Code style text only (ProseMirror does that itself)
//   a drop        the same cleaning as a paste, with the default; no button
//   the button    appears after a rich paste, opens with a click or with the Ctrl (Cmd on a Mac) key pressed and released alone, shows the three
//                 choices; choosing one does the paste again from the clipboard text we kept, in place. It goes away when the person types, presses
//                 Esc or edits anything else.
//
// Pictures in the clipboard (a screenshot) are Compose's own paste handler; pictures that are not data: pictures never get here (pasteClean.ts).

import { Extension } from "@tiptap/core";
import { DOMParser as PmParser, type ResolvedPos, type Slice } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { ChevronDown, ClipboardPaste } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FloatingMenu, type MenuItem } from "../components/ui";
import { useT } from "../i18n/react";
import { osNow } from "../platform";
import { useStore } from "../store";
import type { BaseFont } from "./emailHtml";
import type { PasteMode } from "./pasteClean";
import { inherit } from "./pasteMarks";

interface Payload {
  html: string;
  text: string;
  /** what applies to this paste: the default, or text only for Ctrl+Shift+V */
  mode: PasteMode;
  plain?: boolean;
}

/** The last rich paste, while its button is shown: the clipboard we read, the range it went to, the choice that was applied. */
interface PasteInfo {
  payload: Payload;
  from: number;
  to: number;
  mode: PasteMode;
}

const key = new PluginKey<PasteInfo | null>("pasteOptions");
const MODES: PasteMode[] = ["source", "merge", "text"];
const MODE_LABEL = { source: "compose.paste.keepSource", merge: "compose.paste.merge", text: "compose.paste.textOnly" } as const;

/**
 * The cleaner (pasteClean.ts and the reader under it, about 14 KB) is a chunk of its own: it is fetched when the first editor opens, long before anything is
 * pasted. A paste that is faster than that (never seen: the chunk is part of the app) is left to ProseMirror, with Compose's own cleaning of pictures.
 */
type Core = typeof import("./pasteClean");
let core: Core | null = null;
const loadCore = () => void import("./pasteClean").then((m) => (core = m));

/** The slice for a clipboard in a mode, parsed like ProseMirror parses a paste (used to do a paste again with another choice). */
function sliceFor(c: Core, view: EditorView, p: Payload, mode: PasteMode, $at: ResolvedPos, base: BaseFont): Slice {
  const html = c.editorHtml(p, mode, Boolean(view.state.schema.nodes.table), base);
  const dom = new window.DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body; // (an inert document: nothing in it is loaded or run)
  return inherit(PmParser.fromSchema(view.state.schema).parseSlice(dom, { context: $at }), $at, mode);
}

/** Do the paste again in another mode, in place. */
function switchTo(view: EditorView, info: PasteInfo, mode: PasteMode, base: BaseFont) {
  const size = view.state.doc.content.size;
  const from = Math.min(info.from, size);
  const to = Math.min(info.to, size);
  if (!core) return;
  const slice = sliceFor(core, view, info.payload, mode, view.state.doc.resolve(from), base);
  const tr = view.state.tr.replaceRange(from, to, slice);
  const end = tr.mapping.map(to, 1);
  tr.setSelection(TextSelection.near(tr.doc.resolve(end), -1)).setMeta("paste", true).setMeta("uiEvent", "paste").setMeta(key, { ...info, mode, from, to: end }).scrollIntoView();
  view.dispatch(tr);
  view.focus();
}

// ---------------------------------------------------------------- the button

const BUTTON_H = 26;
const scrollParent = (el: HTMLElement): HTMLElement => {
  for (let p = el.parentElement; p; p = p.parentElement) if (/auto|scroll/.test(getComputedStyle(p).overflowY)) return p;
  return document.documentElement;
};

/** The caret rectangle at `to` and the box of the editor's scroll area, or null when the position is gone. */
function caretAt(view: EditorView, to: number) {
  try {
    return { c: view.coordsAtPos(Math.min(to, view.state.doc.content.size)), box: scrollParent(view.dom as HTMLElement).getBoundingClientRect() };
  } catch {
    return null;
  }
}

/** Where the button goes: under the end of the pasted text; beside that end when the editing area is too low for it (a small window); none when the end is not on the screen. */
function place(view: EditorView, to: number): { left: number; top: number } | null {
  const at = caretAt(view, to);
  if (!at) return null;
  const { c, box } = at;
  if (c.bottom < box.top || c.top > box.bottom || c.right < box.left || c.left > box.right) return null;
  const left = Math.max(box.left + 4, Math.min(c.right + 4, box.right - 52));
  if (c.bottom + 3 + BUTTON_H <= box.bottom) return { left, top: c.bottom + 3 };
  if (c.right + 52 <= box.right) return { left: c.right + 6, top: Math.max(box.top, Math.min((c.top + c.bottom) / 2 - BUTTON_H / 2, box.bottom - BUTTON_H)) };
  const top = c.top - BUTTON_H - 3;
  return top < box.top ? null : { left, top };
}

/** A long paste ends at the very bottom edge: scroll so there is room under its last line for the button (and the toast that may come with it). */
function reveal(view: EditorView, to: number) {
  const at = caretAt(view, to);
  if (!at) return;
  const need = at.c.bottom - (at.box.bottom - 90);
  if (need > 0) scrollParent(view.dom as HTMLElement).scrollTop += need;
}

function PasteButton({ view, info, nonce, base }: { view: EditorView; info: PasteInfo; nonce: number; base: BaseFont }) {
  const t = useT();
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLElement | null>(view.dom as HTMLElement);
  useEffect(() => {
    if (nonce) setOpen(true);
  }, [nonce]);
  const at = place(view, info.to);
  const items: MenuItem[] = MODES.map((m) => ({ label: t(MODE_LABEL[m]), checked: info.mode === m, onClick: () => switchTo(view, info, m, base) }));
  const mod = osNow() === "macos" ? "Cmd" : "Ctrl";
  return (
    <>
      <div className="sr-only" role="status">{t("compose.paste.available", { key: mod })}</div>
      {at && (
        <button
          ref={btn}
          type="button"
          className="icon-btn paste-opt"
          style={at}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t("compose.paste.options")}
          title={t("compose.paste.optionsTip", { key: mod })}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpen((o) => !o)}
        >
          <ClipboardPaste size={14} />
          <ChevronDown size={11} />
        </button>
      )}
      {open && at && <FloatingMenu anchor={btn} trigger={trigger} items={items} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Draws the button of the plugin state in a box on <body> (a menu may not be cut off by the editor's own scrolling box), and follows the page. */
class Overlay {
  host = document.createElement("div");
  root: Root;
  nonce = 0;
  shown: Payload | null = null;
  stop: () => void;
  constructor(public view: EditorView, public base: () => BaseFont) {
    this.host.style.display = "contents";
    view.dom.ownerDocument.body.appendChild(this.host);
    this.root = createRoot(this.host);
    const again = () => this.draw();
    window.addEventListener("scroll", again, true);
    window.addEventListener("resize", again);
    this.stop = () => {
      window.removeEventListener("scroll", again, true);
      window.removeEventListener("resize", again);
    };
  }
  open() {
    this.nonce++;
    this.draw();
  }
  draw() {
    const info = key.getState(this.view.state);
    if (info && info.payload !== this.shown) reveal(this.view, info.to); // (a new paste, not a change of its option)
    this.shown = info?.payload ?? null;
    this.root.render(info ? <PasteButton view={this.view} info={info} nonce={this.nonce} base={this.base()} /> : null);
  }
  destroy() {
    this.stop();
    const { root, host } = this;
    queueMicrotask(() => (root.unmount(), host.remove())); // (not while React is busy with the editor's own update)
  }
}

// ---------------------------------------------------------------- the extension

const readClipboard = (dt: DataTransfer | null): Payload | null => (dt ? { html: dt.getData("text/html"), text: dt.getData("text/plain"), mode: useStore.getState().prefs.pasteDefault } : null);

export const PasteHandling = Extension.create<{ getBase: () => BaseFont }>({
  name: "pasteHandling",
  addOptions: () => ({ getBase: () => ({ family: "Calibri", size: 11 }) }),
  addProseMirrorPlugins() {
    const { getBase } = this.options;
    loadCore();
    /** the clipboard of the paste or drop being handled (ProseMirror calls our hooks inside the event) */
    let current: (Payload & { drop: boolean }) | null = null;
    let overlay: Overlay | null = null;
    let lone = false; // the Ctrl key went down and nothing else since
    let shift = false; // Ctrl+Shift+V (ProseMirror reads it the same way)
    const isMod = (e: KeyboardEvent) => e.key === "Control" || (osNow() === "macos" && e.key === "Meta");
    const begin = (e: ClipboardEvent | DragEvent, drop: boolean) => {
      const p = readClipboard("clipboardData" in e ? e.clipboardData : (e as DragEvent).dataTransfer);
      current = p && { ...p, drop, ...(shift && !drop ? { mode: "text" as const, plain: true } : {}) };
      queueMicrotask(() => (current = null));
      return false;
    };
    return [
      new Plugin<PasteInfo | null>({
        key,
        state: {
          init: () => null,
          apply(tr, prev, old, state) {
            const meta = tr.getMeta(key) as PasteInfo | null | undefined;
            if (meta !== undefined) return meta;
            if (tr.getMeta("uiEvent") === "paste" && current && !current.drop && !current.plain && current.html) {
              return { payload: current, from: tr.mapping.map(old.selection.from, -1), to: state.selection.to, mode: current.mode };
            }
            if (!prev) return null;
            if (tr.docChanged && !tr.getMeta("appendedTransaction")) return null; // typing or any other edit
            return tr.docChanged ? { ...prev, from: tr.mapping.map(prev.from, -1), to: tr.mapping.map(prev.to, 1) } : prev;
          },
        },
        props: {
          handleDOMEvents: {
            paste: (_v, e) => begin(e, false),
            drop: (_v, e) => begin(e, true),
            keydown: (_v, e) => {
              shift = e.shiftKey;
              lone = isMod(e) ? lone || !e.repeat : false;
              return false;
            },
            keyup: (v, e) => {
              shift = e.shiftKey;
              const was = lone;
              lone = false;
              if (was && isMod(e) && key.getState(v.state)) overlay?.open();
              return false;
            },
          },
          handleKeyDown: (v, e) => {
            if (e.key !== "Escape" || !key.getState(v.state)) return false;
            e.stopPropagation(); // the button goes; Esc does nothing else this time
            v.dispatch(v.state.tr.setMeta(key, null));
            return true;
          },
          // The clipboard HTML: Compose has already taken the pictures from the web out (pastedHtml.ts); this is the cleaning of the chosen mode.
          transformPastedHTML: (html, v) => (core ? core.editorHtml({ html, text: current?.text ?? "" }, current?.mode ?? useStore.getState().prefs.pasteDefault, Boolean(v.state.schema.nodes.table), getBase()) : html),
          // Text with no HTML (or Ctrl+Shift+V): one paragraph per line, blank lines kept (ProseMirror's own parser drops them)
          clipboardTextParser: (text, $ctx, plain, v) => {
            if (!core) return undefined as unknown as Slice; // (ProseMirror's own parser then)
            const src = plain && current?.html ? core.pasteText(current.html, Boolean(v.state.schema.nodes.table)) || text : text;
            const dom = new window.DOMParser().parseFromString(`<body>${core.textToHtml(src)}</body>`, "text/html").body;
            return PmParser.fromSchema(v.state.schema).parseSlice(dom, { preserveWhitespace: false, context: $ctx });
          },
          // Merge and Text only take the format around the caret; typed-like text (no HTML) always does
          transformPasted: (slice, v, plain) => (current && !current.drop ? inherit(slice, v.state.selection.$from, plain || !current.html ? "text" : current.mode) : slice),
        },
        view: (v) => {
          overlay = new Overlay(v, getBase);
          return { update: () => overlay?.draw(), destroy: () => (overlay?.destroy(), (overlay = null)) };
        },
      }),
    ];
  },
});
