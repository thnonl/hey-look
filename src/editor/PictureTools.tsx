import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { AlignCenter, AlignLeft, AlignRight, Link2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { usePinnedBelow } from "../components/ui";
import { useT } from "../i18n/react";
import { kbd } from "../platform";
import { placePictureTools, type PictureToolsInput } from "../pictureToolsLayout";
import { sizeForKey, type PictureSize } from "./pictureSizes";

// The toolbar under a selected picture, for the message body (Compose) and for the signature / template editor (RichEditor): sizes, alignment, link, alt text, (as attachment,) remove.
// One component, so the behaviour and the keyboard are the same in both editors (W2.15, W2.18). The placement is measured (pictureToolsLayout.ts), the alt text popover is a layer of
// its own. The toolbar is ONE Tab stop with a roving tabindex like the formatting bar (FormatBar.tsx): Alt+F10 with a picture selected moves the focus to its first control,
// Left / Right / Home / End move between the controls (the size and alignment radio groups included), Enter / Space press, Esc returns to the text with the picture still selected.

export interface PictureSel {
  pos: number;
  width: number | null;
  alt: string;
  name: string;
  /** "center" / "right", else left; the address of the link on the picture, "" for none */
  align: string | null;
  href: string;
  /** where the picture is in the scrolling body (see pictureToolsLayout.ts); the toolbar is placed from it once it is measured */
  geo: Omit<PictureToolsInput, "width" | "height">;
}

/** The selected picture (a NodeSelection of an `image`) and where it is in `body`, or null. */
export function readPictureSel(ed: Editor, body: HTMLElement | null): PictureSel | null {
  const sel = ed.state.selection;
  if (!(sel instanceof NodeSelection) || sel.node.type.name !== "image" || !body) return null;
  const dom = ed.view.nodeDOM(sel.from) as HTMLElement | null;
  if (!dom) return null;
  const box = body.getBoundingClientRect();
  const r = dom.getBoundingClientRect();
  const scroll = body.scrollTop;
  return {
    pos: sel.from,
    width: (sel.node.attrs.width as number | null) ?? null,
    alt: (sel.node.attrs.alt as string | null) ?? "",
    name: (sel.node.attrs["data-name"] as string | null) ?? "picture",
    align: (sel.node.attrs.align as string | null) ?? null,
    href: (sel.node.attrs.href as string | null) ?? "",
    geo: {
      imgLeft: r.left - box.left,
      imgWidth: r.width,
      imgTop: r.top - box.top + scroll,
      imgBottom: r.bottom - box.top + scroll,
      scrollTop: scroll,
      paneWidth: body.clientWidth,
      paneHeight: body.clientHeight,
    },
  };
}

export interface PictureToolsOptions {
  editor: Editor | null;
  /** the positioned (and, in Compose, scrolling) box the toolbar floats in; the toolbar is drawn by the caller inside it */
  bodyRef: RefObject<HTMLElement | null>;
  sizes: readonly PictureSize[];
  /** Ctrl+K on the picture: the link UI of the editor */
  onLink: () => void;
  /** "As attachment" (the message body only); the button is not there without it. The picture is removed from the text by the caller's handler. */
  onAttachment?: (sel: PictureSel) => void;
  /** the alt text was saved (an edit of the message) */
  onAltSaved?: () => void;
}

export interface PictureTools {
  sel: PictureSel | null;
  /** the toolbar and its alt text popover: put it inside `bodyRef` */
  node: ReactNode;
  /** measure the selected picture again (the body scrolled, the window resized, a picture loaded) */
  sync: () => void;
  /** Ctrl/Cmd+1, 2, 3, 0 and Alt+Enter while a picture is selected; true when the key was used */
  handleKey: (e: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "key" | "preventDefault">) => boolean;
  /** Alt+F10: the focus goes to the first control of the toolbar; false when no picture is selected (the formatting bar takes it) */
  focus: () => boolean;
  /** opens the alt text popover (the check before sending selects the first picture without one) */
  openAlt: (text: string) => void;
}

export function usePictureTools({ editor, bodyRef, sizes, onLink, onAttachment, onAltSaved }: PictureToolsOptions): PictureTools {
  const t = useT();
  const [sel, setSel] = useState<PictureSel | null>(null);
  const [altOpen, setAltOpen] = useState(false);
  const [altText, setAltText] = useState("");
  const [active, setActive] = useState("size:0"); // the roving tab stop
  const toolsRef = useRef<HTMLDivElement>(null);
  const toolsBoxRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const altPopRef = useRef<HTMLDivElement>(null);
  const live = useRef({ editor, sel, onLink });
  live.current = { editor, sel, onLink };

  const sync = useCallback(() => {
    const ed = live.current.editor;
    setSel(ed && !ed.isDestroyed ? readPictureSel(ed, bodyRef.current) : null);
  }, [bodyRef]);
  useEffect(() => {
    if (!editor) return;
    editor.on("selectionUpdate", sync);
    editor.on("update", sync);
    // a resized window changes the pane the toolbar has to fit in, and a picture that has just loaded gets its real height
    const dom = editor.view.dom;
    window.addEventListener("resize", sync);
    dom.addEventListener("load", sync, true);
    return () => {
      editor.off("selectionUpdate", sync);
      editor.off("update", sync);
      window.removeEventListener("resize", sync);
      dom.removeEventListener("load", sync, true);
    };
  }, [editor, sync]);

  // the alt text popover is a layer of its own (a portal on <body>, fixed): under the toolbar or above it, inside the window and above a toast, scrolling when it is taller than the room
  usePinnedBelow(altPopRef, toolsBoxRef, altOpen && !!sel);
  // The toolbar is placed after it has been laid out: it wraps to more rows in a narrow pane, so its size is measured, then it goes above / below the picture and inside the pane.
  useLayoutEffect(() => {
    const anchor = toolsRef.current;
    if (!sel || !anchor) return;
    const box = anchor.firstElementChild as HTMLElement;
    box.style.marginLeft = "";
    const { left, top } = placePictureTools({ ...sel.geo, width: box.offsetWidth, height: box.offsetHeight });
    box.style.marginLeft = `${left}px`;
    anchor.style.top = `${top}px`;
  });

  const setSize = (w: number | null) => {
    if (!sel || !editor) return;
    editor.chain().setNodeSelection(sel.pos).updateAttributes("image", { width: w }).run();
  };
  const setAlign = (a: "center" | "right" | null) => {
    if (!sel || !editor) return;
    editor.chain().focus().setNodeSelection(sel.pos).updateAttributes("image", { align: a }).run(); // (the editor has the focus again: Ctrl+K links the picture next)
  };
  const toggleAlt = (from = sel) => {
    setAltText(from?.alt ?? "");
    setAltOpen((o) => !o);
  };
  const saveAlt = () => {
    if (!sel || !editor) return;
    editor.chain().setNodeSelection(sel.pos).updateAttributes("image", { alt: altText.trim() }).run();
    setAltOpen(false);
    onAltSaved?.();
  };
  const remove = () => {
    if (!sel || !editor) return;
    editor.chain().setNodeSelection(sel.pos).deleteSelection().run();
    setSel(null);
    setAltOpen(false);
  };

  /**
   * Esc from the toolbar: the focus goes back to the text and the picture stays selected (so Delete removes it, AC-2.18.1). Focusing the editor makes some engines (WebKitGTK, D-033)
   * put the caret at the start of the text a moment later, which turned the picture selection into a text selection and took the toolbar away. So the selection is set again
   * after the focus call and again on the next frames and a few milliseconds on, if it is not the picture any more; the focus is taken without scrolling.
   */
  const backToEditor = (pos: number) => {
    if (!editor) return;
    let live = true; // (until the person does something themselves)
    const stop = () => (live = false);
    document.addEventListener("keydown", stop, { once: true, capture: true });
    document.addEventListener("pointerdown", stop, { once: true, capture: true });
    const want = () => {
      if (!live || editor.isDestroyed) return;
      const s = editor.state.selection;
      if (!(s instanceof NodeSelection && s.from === pos && s.node.type.name === "image")) editor.chain().setNodeSelection(pos).run();
    };
    want();
    editor.view.focus();
    want();
    for (const ms of [0, 30, 90, 200]) setTimeout(want, ms);
    requestAnimationFrame(want);
  };

  const rove = (id: string) => ({ "data-rove": id, tabIndex: id === active ? 0 : -1, onFocus: () => setActive(id) });

  const onBarKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = barRef.current;
    // keys of the alt text popover (a portal) reach this handler through the React tree: they are not ours
    if (!el || !(e.target instanceof Node) || !el.contains(e.target) || e.altKey || e.ctrlKey || e.metaKey) return;
    const items = Array.from(el.querySelectorAll<HTMLElement>("[data-rove]"));
    const at = items.indexOf((e.target as HTMLElement).closest<HTMLElement>("[data-rove]") as HTMLElement);
    if (at < 0) return;
    let to = -1;
    if (e.key === "ArrowRight") to = (at + 1) % items.length;
    else if (e.key === "ArrowLeft") to = (at - 1 + items.length) % items.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = items.length - 1;
    if (to >= 0) {
      e.preventDefault();
      items[to].focus();
    }
  };

  const handleKey: PictureTools["handleKey"] = (e) => {
    if (!sel) return false;
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const w = sizeForKey(sizes, e.key);
      if (w !== undefined) {
        e.preventDefault();
        setSize(w);
        return true;
      }
    }
    if (e.altKey && e.key === "Enter") {
      e.preventDefault();
      toggleAlt();
      return true;
    }
    return false;
  };

  const focus = () => {
    const first = barRef.current?.querySelector<HTMLElement>("[data-rove]");
    if (!sel || !first) return false;
    first.focus();
    return true;
  };

  const align = [[null, "compose.fmt.alignLeft", <AlignLeft key="l" size={14} />], ["center", "compose.fmt.alignCenter", <AlignCenter key="c" size={14} />], ["right", "compose.fmt.alignRight", <AlignRight key="r" size={14} />]] as const;
  const node = sel && (
    <div
      className="img-tools-anchor"
      ref={toolsRef}
      onKeyDown={(e) => {
        // Esc leaves the toolbar (or just the alt text popover) and returns to the editor, the picture still selected
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        setAltOpen(false);
        backToEditor(sel.pos);
      }}
    >
      <div className="img-tools-box" ref={toolsBoxRef}>
        <div className="img-tools" role="toolbar" aria-label={t("compose.pic.options")} aria-orientation="horizontal" ref={barRef} onKeyDown={onBarKeyDown}>
          <div className="seg" role="radiogroup" aria-label={t("compose.pic.size")}>
            {sizes.map(([label, w], i) => (
              <button key={label} type="button" role="radio" aria-checked={sel.width === w} className={sel.width === w ? "on" : ""} {...rove(`size:${i}`)} onClick={() => setSize(w)}>
                {t(label)}
              </button>
            ))}
          </div>
          <div className="seg" role="radiogroup" aria-label={t("compose.pic.align")}>
            {align.map(([a, label, icon]) => (
              <button key={label} type="button" role="radio" aria-checked={(sel.align ?? null) === a} aria-label={t(label)} title={t(label)} className={(sel.align ?? null) === a ? "on" : ""} {...rove(`align:${a ?? "left"}`)} onClick={() => setAlign(a)}>
                {icon}
              </button>
            ))}
          </div>
          <button type="button" className={`icon-btn${sel.href ? " on" : ""}`} aria-label={t("compose.fmt.link")} aria-pressed={!!sel.href} title={kbd(t("compose.pic.linkTip"))} {...rove("link")} onClick={() => live.current.onLink()}>
            <Link2 size={14} />
          </button>
          <button
            type="button"
            className={`tool-btn ${sel.alt ? "" : "no-alt"}`}
            title={sel.alt ? t("compose.pic.editAlt") : t("compose.pic.addAlt")}
            aria-haspopup="dialog"
            aria-expanded={altOpen}
            {...rove("alt")}
            onClick={() => toggleAlt()}
          >
            {t("compose.pic.altText")}
          </button>
          {onAttachment && <button type="button" className="tool-btn" {...rove("attach")} onClick={() => (onAttachment(sel), setSel(null))}>{t("compose.pic.asAttachment")}</button>}
          <button type="button" className="icon-btn" aria-label={t("compose.pic.remove")} title={t("compose.pic.removeTip")} {...rove("remove")} onClick={remove}><Trash2 size={14} /></button>
        </div>
        {altOpen && createPortal(
          <div className="popover alt-pop pinned" role="dialog" aria-label={t("compose.pic.altText")} ref={altPopRef}>
            <label className="small muted" htmlFor="alt-text-field">{t("compose.pic.altText")}</label>
            <textarea id="alt-text-field" value={altText} onChange={(e) => setAltText(e.target.value)} autoFocus placeholder={t("compose.pic.altPlaceholder")} />
            <div className="helper">{t("compose.pic.altHelp")}</div>
            <div className="row-inline" style={{ justifyContent: "flex-end", margin: 0 }}>
              <button className="btn small" onClick={() => setAltOpen(false)}>{t("common.cancel")}</button>
              <button className="btn primary small" onClick={saveAlt}>{t("common.save")}</button>
            </div>
          </div>,
          document.body,
        )}
      </div>
    </div>
  );

  return { sel, node, sync, handleKey, focus, openAlt: (text) => (setAltText(text), setAltOpen(true)) };
}
