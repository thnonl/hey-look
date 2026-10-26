import { GripVertical } from "lucide-react";
import { ReactNode, RefObject, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { accountColor } from "../prefs";
import { accountLabel } from "../accountLabel";
import { autoScrollStep, dropIndex, moveAccountTo, stepAccount } from "../accountOrder";
import { isContextMenuKey } from "../contextMenu";
import { useT } from "../i18n/react";
import { osNow } from "../platform";
import { useStore } from "../store";
import { ContextMenu, CtxItem } from "./ContextMenu";

/*
 * Reordering the mailboxes (v1.0.6). The window has `dragDropEnabled: false` (tauri.conf.json), so the webview does get HTML5 drag events -
 * that is how attachments are dropped into Compose - and a mailbox could be dragged that way too. It is done with pointer events instead:
 * HTML5 drag has no say over the preview, the insertion line, the auto-scroll at the edges or Escape on some engines (WKWebView, WebKitGTK),
 * and a drag of a list entry must never reach Compose's / Pgp's file-drop zones (they show their "drop files here" state on any dragenter).
 *
 *  - Pointer: press the grip at the left of a mailbox, or (1.0.10) the mailbox's own header / avatar / Settings entry, and move; a preview follows the pointer, a line shows where it lands, the list scrolls
 *    near its edges, Escape cancels, releasing drops it.
 *  - Keyboard: Alt+Up / Alt+Down on the focused mailbox (also in its menu: right-click, ContextMenu key or Shift+F10 -> Move up / Move down).
 *    Every move is announced through a live region ("<address> moved to position 2 of 3").
 * The order is saved in `prefs.accountOrder`; the store applies it to `accounts`, which every screen reads.
 */

/** The nearest ancestor that scrolls vertically. */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === "auto" || o === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

interface DragView {
  id: string;
  x: number;
  y: number;
  /** index it would land at */
  to: number;
  line: { top: number; left: number; width: number } | null;
}

const THRESHOLD = 4; // px the pointer has to move before a press on the grip becomes a drag

/**
 * `containerRef` holds the entries; each entry has `data-reorder-id="<account id>"` and its focus target `data-reorder-focus`.
 * Returns the props to spread on an entry's grip (`grip`), on the part of the entry that is a handle too (`row`: the header button, the avatar), on the entry (`entry`), and `overlay` to render once (preview, line, live region, menu).
 * `extraItems` adds entries after Move up / Move down, behind a divider (the side menu adds "New folder…", W13.10).
 */
export function useAccountReorder(containerRef: RefObject<HTMLElement | null>, extraItems?: (accountId: string) => CtxItem[]) {
  const t = useT();
  const accounts = useStore((s) => s.accounts);
  const accent = useStore((s) => s.prefs.accent);
  const setPrefs = useStore((s) => s.setPrefs);
  const [view, setView] = useState<DragView | null>(null);
  const [live, setLive] = useState("");
  const [menu, setMenu] = useState<{ id: string; at: { x: number; y: number }; keyboard: boolean; from: HTMLElement | null } | null>(null);
  const drag = useRef<{ id: string; pointerId: number; x0: number; y0: number; x: number; y: number; started: boolean } | null>(null);
  const raf = useRef(0);
  const focusAfter = useRef<string | null>(null);
  const ids = accounts.map((a) => a.id);
  const label = (id: string) => {
    const a = accounts.find((x) => x.id === id);
    return a ? accountLabel(a).text : id;
  };

  const items = () => Array.from(containerRef.current?.querySelectorAll<HTMLElement>("[data-reorder-id]") ?? []);

  /** Where the dragged entry would land for the current pointer position, and the line that shows it. */
  const measure = useCallback((): DragView | null => {
    const d = drag.current;
    if (!d?.started) return null;
    const els = items();
    const rects = els.map((el) => el.getBoundingClientRect());
    const from = els.findIndex((el) => el.dataset.reorderId === d.id);
    if (from < 0) return null;
    const to = dropIndex(rects.map((r) => (r.top + r.bottom) / 2), from, d.y);
    const others = rects.filter((_, i) => i !== from);
    // the box the line spans: the list that scrolls, else the nearest ancestor that has a size (the tree itself is `display: contents`: with everything collapsed nothing scrolls and its own box is empty)
    let sized: HTMLElement | null = els[0]?.parentElement ?? null;
    while (sized && sized.getBoundingClientRect().width === 0) sized = sized.parentElement;
    const box = (scrollParent(els[0]) ?? sized ?? containerRef.current)?.getBoundingClientRect();
    const edge = others.length === 0 ? null : to === 0 ? others[0].top : others[to - 1].bottom;
    return { id: d.id, x: d.x, y: d.y, to, line: edge !== null && box ? { top: edge - 1, left: box.left + 6, width: box.width - 12 } : null };
  }, [containerRef]); // eslint-disable-line react-hooks/exhaustive-deps

  const announce = (id: string, pos: number) => setLive(t("mail.acct.moved", { email: label(id), n: pos + 1, total: ids.length }));

  const commit = (next: string[], id: string) => {
    if (next.join() === ids.join()) return;
    focusAfter.current = id;
    setPrefs({ accountOrder: next });
    announce(id, next.indexOf(id));
  };

  // one listener object for the whole life of the hook, so the Escape handler that was added is the one that is removed
  const escHandler = useRef<(e: KeyboardEvent) => void>(() => undefined);
  const esc = useRef((e: KeyboardEvent) => escHandler.current(e)).current;
  const stop = useCallback(() => {
    drag.current = null;
    cancelAnimationFrame(raf.current);
    document.body.classList.remove("reordering");
    window.removeEventListener("keydown", esc, true);
    setView(null);
  }, [esc]);
  escHandler.current = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation(); // Escape only cancels the drag
    stop();
    setLive(t("mail.acct.cancelled"));
  };

  // while the pointer rests near an edge the list keeps scrolling, and the landing place is measured again
  const loop = useCallback(() => {
    const d = drag.current;
    if (!d?.started) return;
    const sp = scrollParent(items()[0] ?? null);
    if (sp) {
      const r = sp.getBoundingClientRect();
      const step = autoScrollStep(d.y, r.top, r.bottom);
      if (step) sp.scrollTop += step;
    }
    setView(measure());
    raf.current = requestAnimationFrame(loop);
  }, [measure]); // eslint-disable-line react-hooks/exhaustive-deps

  // the pointer handlers, shared by the grip and by the whole entry (`row`); they take the plain fields of a pointer event
  const onMove = (e: { pointerId: number; clientX: number; clientY: number }) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    d.x = e.clientX;
    d.y = e.clientY;
    if (!d.started && Math.hypot(d.x - d.x0, d.y - d.y0) >= THRESHOLD) {
      d.started = true;
      document.body.classList.add("reordering");
      window.addEventListener("keydown", esc, true);
      raf.current = requestAnimationFrame(loop);
    }
    if (d.started) setView(measure());
  };
  const onUp = (e: { pointerId: number }) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const landed = d.started ? measure() : null;
    stop();
    if (landed) commit(moveAccountTo(ids, d.id, landed.to), d.id);
  };
  const onCancel = () => {
    if (drag.current?.started) setLive(t("mail.acct.cancelled"));
    stop();
  };

  const grip = (id: string) => ({
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || ids.length < 2) return;
      e.preventDefault(); // no text selection while dragging
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { id, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, started: false };
    },
    onPointerMove: onMove,
    onPointerUp: onUp,
    onPointerCancel: onCancel,
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  });

  /**
   * The whole mailbox entry as a handle (1.0.10): the header button, the avatar of the icon column and a mailbox of the Settings navigation start the same drag as the grip
   * when the primary button of a mouse or a pen is pressed on them and the pointer moves 4 px. A press that stays under 4 px is the click it always was (collapse, open the
   * Inbox, open the page); after a drag the click that follows the release is swallowed, whether it dropped or was cancelled with Escape. Not a drag start: another button,
   * any modifier (Ctrl+click is the right-click of macOS), a press on an interactive child (the warning icon), and touch (a touch drag on the entry scrolls the list; the
   * grip is its handle). Nothing is prevented on the press, so the focus and the click are the browser's own; the pointer is captured once the drag starts, so the mail frames
   * under it cannot take its events.
   */
  const rowEnd = useRef<(() => void) | null>(null);
  const row = (id: string) => ({
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.pointerType === "touch" || e.button !== 0 || ids.length < 2 || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const el = e.currentTarget;
      const hit = (e.target as Element).closest('a, input, select, textarea, button, [role="button"]');
      if (hit && hit !== el) return;
      rowEnd.current?.();
      const pid = e.pointerId;
      drag.current = { id, pointerId: pid, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, started: false };
      const swallow = (ev: Event) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      let swallowing = false;
      const move = (ev: PointerEvent) => {
        if (ev.pointerId !== pid) return;
        onMove(ev);
        if (!swallowing && drag.current?.started) {
          swallowing = true;
          window.addEventListener("click", swallow, true);
          try {
            el.setPointerCapture(pid);
          } catch {
            /* the pointer is gone: the release below ends it */
          }
        }
      };
      const end = (ev: PointerEvent) => {
        if (ev.pointerId !== pid) return;
        if (ev.type === "pointerup") onUp(ev);
        else onCancel();
        finish();
      };
      const finish = () => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", end, true);
        window.removeEventListener("pointercancel", end, true);
        if (swallowing) window.setTimeout(() => window.removeEventListener("click", swallow, true), 80); // (the click comes right after the release)
        rowEnd.current = null;
      };
      rowEnd.current = finish;
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", end, true);
      window.addEventListener("pointercancel", end, true);
    },
  });

  const entry = (id: string) => ({
    "data-own-menu": "", // the window's right-click guard (contextGuard.ts) leaves this menu to us
    onKeyDown: (e: React.KeyboardEvent) => {
      if (!(e.target as Element).closest("[data-reorder-focus]")) return;
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        e.stopPropagation();
        commit(stepAccount(ids, id, e.key === "ArrowUp" ? -1 : 1), id);
      } else if (isContextMenuKey(e)) {
        e.preventDefault();
        const r = (e.target as Element).closest("[data-reorder-focus]")!.getBoundingClientRect();
        setMenu({ id, at: { x: r.left + Math.min(40, r.width / 2), y: r.bottom - 4 }, keyboard: true, from: e.target as HTMLElement });
      }
    },
    onContextMenu: (e: React.MouseEvent) => {
      const t = e.target as Element;
      // (1.0.10) the grip sits over the left edge of the avatar in the icon column (12 px of its 40), and the row around the button has a few pixels of its own: a right-click there is a right-click on the mailbox
      const from = t.closest<HTMLElement>("[data-reorder-focus]") ?? (t.closest(".reorder-grip, .fp-headrow") ? e.currentTarget.querySelector<HTMLElement>("[data-reorder-focus]") : null);
      if (!from) return; // a folder row: the app has nothing to offer there
      e.preventDefault();
      setMenu({ id, at: { x: e.clientX, y: e.clientY }, keyboard: false, from });
    },
  });

  // the DOM node of a moved entry is re-inserted, which drops its focus: the keyboard user stays where they were
  const order = ids.join();
  useEffect(() => {
    const id = focusAfter.current;
    if (!id) return;
    focusAfter.current = null;
    containerRef.current?.querySelector<HTMLElement>(`[data-reorder-id="${CSS.escape(id)}"] [data-reorder-focus], [data-reorder-id="${CSS.escape(id)}"][data-reorder-focus]`)?.focus({ preventScroll: false });
  }, [order, containerRef]);

  useEffect(() => () => { rowEnd.current?.(); stop(); }, [stop]);

  const dragged = view ? accounts.find((a) => a.id === view.id) : null;
  const mac = osNow() === "macos";
  const menuItems = (id: string): CtxItem[] => {
    const i = ids.indexOf(id);
    return [
      { label: t("mail.acct.moveUp"), hint: mac ? "⌥↑" : "Alt+↑", disabled: i <= 0, onClick: () => commit(stepAccount(ids, id, -1), id) },
      { label: t("mail.acct.moveDown"), hint: mac ? "⌥↓" : "Alt+↓", disabled: i < 0 || i >= ids.length - 1, onClick: () => commit(stepAccount(ids, id, 1), id) },
      ...(extraItems ? [{ divider: true }, ...extraItems(id)] : []),
    ];
  };
  const overlay: ReactNode = (
    <>
      <div className="sr-only" role="status" aria-live="polite">{live}</div>
      {view && dragged && createPortal(
        <>
          <div className="reorder-ghost" style={{ left: view.x + 12, top: view.y - 14 }} aria-hidden>
            <span className="dot" style={{ background: accountColor(dragged, accent) }} />
            <span className="ellipsis">{accountLabel(dragged).text}</span>
          </div>
          {view.line && <div className="reorder-line" style={view.line} aria-hidden />}
        </>,
        document.body,
      )}
      {menu && <ContextMenu key={menu.id} at={menu.at} items={menuItems(menu.id)} label={label(menu.id)} keyboard={menu.keyboard} returnTo={menu.from} onClose={() => setMenu(null)} />}
    </>
  );
  return { grip, row, entry, overlay, dragging: view?.id ?? null, menuOpen: !!menu };
}

/** The grip a mailbox is picked up by (`bind` is what `useAccountReorder().grip(id)` returns). Hidden from assistive technology: Alt+Up / Alt+Down and the menu are the keyboard way. */
export function Grip({ email, bind, dragging }: { email: string; bind: React.HTMLAttributes<HTMLElement>; dragging: boolean }) {
  const t = useT();
  return (
    <span className={`reorder-grip ${dragging ? "on" : ""}`} title={t("mail.acct.drag", { email })} aria-hidden {...bind}>
      <GripVertical size={12} />
    </span>
  );
}
