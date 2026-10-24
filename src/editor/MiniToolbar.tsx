import type { Editor } from "@tiptap/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toastBox } from "../components/ui";
import { useT } from "../i18n/react";
import { placePopover } from "../popoverRoom";
import { focusText } from "./commands";
import { CONTROLS, type Ctx, type Rove } from "./controls";
import type { MiniShown } from "./useMiniShow";

// The mini toolbar (spec-107-wp3.md W3.3, spec-rich-text.md REQ-52): Bold, Italic, Underline | Font color, Highlight | Link in a small box over the text the person has just selected with the
// mouse. The buttons are the very controls of the formatting toolbar (controls.tsx: same icons, names, tips, pressed states and commands), with a roving tabindex of their own. A press on it never
// takes the focus or the selection out of the text. It is app chrome (the app theme, also over the compose preview), drawn on <body> above dialogs and below the menus and palettes it opens.
// It is not announced when it shows (no live region: it would talk on every selection); Alt+F10 is the way in. When it is on screen is decided in useMiniShow.ts, where it goes in popoverRoom.ts.

const control = (id: string) => CONTROLS.find((c) => c.id === id)!;

/** What the formatting toolbar asks of it. */
export interface MiniApi {
  /** Alt+F10 in the text: the focus goes to the first button; false when the toolbar has no place to be shown */
  focus: () => boolean;
}

export default function MiniToolbar({ editor, ctx, shown, onHide, onFocusBar, apiRef }: {
  editor: Editor;
  ctx: Ctx;
  shown: MiniShown;
  onHide: () => void;
  /** Alt+F10 inside it: the formatting toolbar gets the focus */
  onFocusBar: () => void;
  apiRef: { current: MiniApi | null };
}) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const linkBtn = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [active, setActive] = useState<string>("bold");

  // where it goes: centred on the selection, above it, below it when there is no room above (in a table: below first), nowhere when neither side has the room
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const p = placePopover(shown.box, { w: el.offsetWidth, h: el.offsetHeight }, { w: window.innerWidth, h: window.innerHeight }, {
      edge: 8, gap: 8, align: "center", prefer: shown.inTable ? "below" : "above", cover: false, toasts: toastBox(),
    });
    setPos(p ? { top: p.top, left: p.left } : null);
  }, [shown]);

  const placed = pos !== null;
  useEffect(() => {
    apiRef.current = { focus: () => (placed ? (box.current?.querySelector<HTMLElement>('[data-rove="mini:bold"]')?.focus(), true) : false) };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, placed]);

  const rove = (id: string): Rove => ({ "data-rove": `mini:${id}`, tabIndex: id === active ? 0 : -1, onFocus: () => setActive(id) });
  const openLink = () => {
    // the toolbar is gone when the popover places itself: it hangs under the box the Link button was in
    const r = linkBtn.current?.getBoundingClientRect() ?? shown.box;
    const rect = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    onHide();
    ctx.host.link.open({ getBoundingClientRect: () => rect });
  };
  const mini: Ctx = {
    ...ctx,
    rove,
    open: null,
    openVia: null,
    setOpen: () => undefined,
    openPicker: () => undefined,
    host: { ...ctx.host, link: { open: openLink, isOpen: false, btnRef: linkBtn } },
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const el = box.current;
    // keys of a palette drawn in a portal reach this handler through the React tree: they are not ours
    if (!el || !(e.target instanceof Node) || !el.contains(e.target)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      focusText(editor);
      onHide();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      focusText(editor); // the text has the focus again; the toolbar stays
      return;
    }
    if (e.altKey && e.key === "F10") {
      e.preventDefault();
      e.stopPropagation();
      onHide();
      onFocusBar();
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
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

  return createPortal(
    <div
      ref={box}
      className="mini-tb"
      role="toolbar"
      aria-label={t("compose.mini.toolbar")}
      aria-orientation="horizontal"
      style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: "hidden" }}
      onMouseDown={(e) => e.target instanceof Node && e.currentTarget.contains(e.target) && e.preventDefault()}
      onKeyDown={onKeyDown}
    >
      {control("bold").bar(mini)}
      {control("italic").bar(mini)}
      {control("underline").bar(mini)}
      <span className="fmt-sep" role="separator" aria-orientation="vertical" />
      {control("fontColor").bar(mini)}
      {control("highlight").bar(mini)}
      <span className="fmt-sep" role="separator" aria-orientation="vertical" />
      {control("link").bar(mini)}
    </div>,
    document.body,
  );
}
