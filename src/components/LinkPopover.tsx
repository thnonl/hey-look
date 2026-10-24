import { NodeSelection } from "@tiptap/pm/state";
import { getMarkRange, type Editor } from "@tiptap/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { checkLinkUrl, planLinkEdit } from "../linkUrl";
import { useT } from "../i18n/react";
import { openExternal } from "../open";
import { placePopover, type PlaceBox } from "../popoverRoom";
import { toastBox, useOutside } from "./ui";

// The link UI of the composer and of the signature / template editor: a small popover with the address and (optionally) the text, opened by
// the toolbar button and by Ctrl/Cmd+K. It replaces the native `window.prompt` (title "tauri.localhost says", blocks the renderer, may not work in
// WKWebView). Text to display above Address (the focus is in Address); Insert (a new link) or Save (an edit) with Cancel, and Remove link / Open link when the caret is in a link; Enter is the primary
// button, Esc is Cancel, the focus goes back to the editor with the selection as it was (W2.16, Outlook's Insert Hyperlink). Only http, https, mailto, tel
// (linkUrl.ts); a bare domain gets https://.

/** What the link popover hangs under: a button, or (the mini toolbar, which is gone by then) the box it was at. */
export interface LinkAnchor {
  getBoundingClientRect(): PlaceBox;
}

/** The link UI is about this range of the document. */
export interface LinkTarget {
  from: number;
  to: number;
  /** the text of the range (the selection, or the whole link the caret is in) */
  text: string;
  /** the address of the link the caret / selection is in, else "" */
  href: string;
  inLink: boolean;
  /** the text can be changed here: nothing is selected, or the selection is inside one paragraph */
  canEditText: boolean;
  /** the link is on a selected picture (its `href` attribute), not on text */
  picture?: boolean;
}

/** Where the link UI works: the selection, or the whole link when the caret is inside one. */
export function readLinkTarget(editor: Editor): LinkTarget {
  const { state } = editor;
  const sel = state.selection;
  if (sel instanceof NodeSelection && sel.node.type.name === "image") {
    const href = typeof sel.node.attrs.href === "string" ? sel.node.attrs.href : "";
    return { from: sel.from, to: sel.to, text: "", href, inLink: !!href, canEditText: false, picture: true };
  }
  const inLink = editor.isActive("link");
  const range = inLink ? getMarkRange(sel.$from, state.schema.marks.link) : null;
  const from = range ? range.from : sel.from;
  const to = range ? range.to : sel.to;
  return {
    from,
    to,
    text: from === to ? "" : state.doc.textBetween(from, to, " "),
    href: inLink ? ((editor.getAttributes("link").href as string | undefined) ?? "") : "",
    inLink,
    canEditText: from === to || state.doc.resolve(from).sameParent(state.doc.resolve(to)),
  };
}

/** Makes (or changes) the link in `target`; the text of a bare caret / a replaced text is inserted with the link on it. */
function applyLinkTarget(editor: Editor, target: LinkTarget, href: string, typedText: string): void {
  if (target.picture) {
    editor.chain().focus().setNodeSelection(target.from).updateAttributes("image", { href }).run();
    return;
  }
  const plan = planLinkEdit({ rangeEmpty: target.from === target.to, original: target.text, typed: typedText, href });
  const chain = editor.chain().focus();
  if (plan.kind === "mark") {
    chain.setTextSelection({ from: target.from, to: target.to }).setLink({ href }).setTextSelection(target.to).run();
    return;
  }
  const content = { type: "text", text: plan.text, marks: [{ type: "link", attrs: { href } }] };
  chain.insertContentAt(plan.kind === "insert" ? target.from : { from: target.from, to: target.to }, content).run();
}

export function removeLinkTarget(editor: Editor, target: LinkTarget): void {
  if (target.picture) {
    editor.chain().focus().setNodeSelection(target.from).updateAttributes("image", { href: null }).run();
    return;
  }
  editor.chain().focus().setTextSelection({ from: target.from, to: target.to }).unsetLink().setTextSelection(target.to).run();
}

/**
 * The state of the link UI of one editor. `open()` is what the toolbar button and Ctrl/Cmd+K call; `node` goes anywhere in the JSX of the
 * component (it is drawn in a portal on <body>, placed under `anchor`, so no clipping parent can hide it).
 */
export function useLinkEditor(editor: Editor | null, anchor: React.RefObject<HTMLElement | null>) {
  const [target, setTarget] = useState<LinkTarget | null>(null);
  // `open(at)`: under `at` (the Link button of the mini toolbar, W3.3) instead of the toolbar's Link button. A click handler may hand over its event or a count: only a box counts.
  const [at, setAt] = useState<LinkAnchor | null>(null);
  const open = useCallback((at?: unknown) => {
    setAt(at && typeof (at as LinkAnchor).getBoundingClientRect === "function" ? (at as LinkAnchor) : null);
    if (editor) setTarget(readLinkTarget(editor));
  }, [editor]);
  const placed = { get current(): LinkAnchor | null { return at ?? anchor.current; } };
  const close = useCallback(() => {
    setTarget(null);
    editor?.commands.focus();
  }, [editor]);
  const node =
    target && editor
      ? createPortal(<LinkPopover target={target} anchor={placed} onApply={(href, text) => (applyLinkTarget(editor, target, href, text), setTarget(null))} onRemove={() => (removeLinkTarget(editor, target), setTarget(null))} onClose={close} />, document.body)
      : null;
  return { open, node, isOpen: !!target };
}

const WIDTH = 300;

function LinkPopover({
  target, anchor, onApply, onRemove, onClose,
}: {
  target: LinkTarget;
  anchor: { current: LinkAnchor | null };
  onApply: (href: string, text: string) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const addr = useRef<HTMLInputElement>(null);
  const [href, setHref] = useState(target.href);
  const [text, setText] = useState(target.canEditText ? target.text : "");
  const [shown, setShown] = useState(false); // an error is shown after the first try to apply, or once the person has typed
  const check = checkLinkUrl(href);
  // a refused scheme is said as soon as it is typed; a malformed address after the first try to apply
  const err = !check.ok && check.reason !== "empty" && (shown || check.reason === "scheme") ? check.reason : null;
  useOutside(box, onClose, true);

  // under the toolbar, inside the window
  useLayoutEffect(() => {
    const el = box.current;
    const a = anchor.current;
    if (!el || !a) return;
    const r = a.getBoundingClientRect();
    const w = Math.min(WIDTH, window.innerWidth - 16);
    el.style.width = `${w}px`;
    el.style.maxHeight = "";
    // (popoverRoom.ts: below the button or above it, inside the window and above a toast; a popover taller than the room scrolls)
    const p = placePopover(r, { w, h: el.offsetHeight }, { w: window.innerWidth, h: window.innerHeight }, { edge: 8, gap: 6, toasts: toastBox(), minRoom: 96 });
    el.style.maxHeight = `${p.max}px`;
    el.style.overflowY = "auto";
    el.style.left = `${p.left}px`;
    el.style.top = `${p.top}px`;
  });
  useEffect(() => {
    addr.current?.focus();
    addr.current?.select();
  }, []);

  const apply = () => {
    setShown(true);
    if (check.ok) onApply(check.href, text);
    else addr.current?.focus();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Enter" && !e.shiftKey && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      apply();
    } else if (e.key === "Tab" && box.current) {
      // the popover is outside the window it was opened from: Tab stays inside it
      const items = Array.from(box.current.querySelectorAll<HTMLElement>("input, button:not([disabled])"));
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
      else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
    }
  };

  const title = t(target.inLink ? "compose.link.editTitle" : "compose.link.insertTitle");
  return (
    <div ref={box} className="popover link-pop" role="dialog" aria-label={title} onKeyDown={onKeyDown}>
      <div className="link-pop-title">{title}</div>
      {target.canEditText && (
        <label className="link-pop-field">
          <span>{t("compose.link.text")}</span>
          <input type="text" autoComplete="off" value={text} placeholder={t("compose.link.textPlaceholder")} onChange={(e) => setText(e.target.value)} />
        </label>
      )}
      <label className="link-pop-field">
        <span>{t("compose.link.address")}</span>
        <input
          ref={addr}
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={href}
          placeholder={t("compose.link.addressPlaceholder")}
          aria-invalid={!!err}
          aria-describedby={err ? "link-pop-err" : undefined}
          onChange={(e) => (setHref(e.target.value), setShown(false))}
        />
      </label>
      {err && <div id="link-pop-err" className="link-pop-err" role="alert">{t(err === "scheme" ? "compose.link.errScheme" : "compose.link.errInvalid")}</div>}
      <div className="link-pop-btns">
        {target.inLink && <button type="button" className="btn link-pop-remove" onClick={onRemove}>{t("compose.link.remove")}</button>}
        {target.inLink && checkLinkUrl(target.href).ok && (
          <button type="button" className="btn link-pop-remove" onClick={() => void openExternal(target.href).catch(() => undefined)}>{t("compose.link.open")}</button>
        )}
        <span className="grow" />
        <button type="button" className="btn" onClick={onClose}>{t("common.cancel")}</button>
        <button type="button" className="btn primary" disabled={!check.ok && check.reason === "empty"} onClick={apply}>{t(target.inLink ? "common.save" : "compose.link.insert")}</button>
      </div>
    </div>
  );
}
