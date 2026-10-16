// One listener for every right-click of the window (the rules are in contextPolicy.ts), and the same for a message's frame, which is a document of its
// own that never reaches the window's listener. The app's own menus (the mail list row, a mailbox of the folder pane) are marked `data-own-menu`: they
// answer the click themselves and this listener only swallows the native menu there.
import { create } from "zustand";
import { decideContextMenu, isEditableNode, safeLinkHref } from "./contextPolicy";
import { usePlatform } from "./platform";

export interface GuardMenu {
  at: { x: number; y: number };
  /** the selected text (the Copy entry) */
  text: string;
  /** the link under the pointer (the Open link / Copy link address entries) and how to open it */
  link: { href: string; open: () => void } | null;
  /** where the focus goes when the menu closes */
  returnTo: HTMLElement | null;
}

export const useGuardMenu = create<{ menu: GuardMenu | null }>(() => ({ menu: null }));
export const closeGuardMenu = () => useGuardMenu.setState({ menu: null });

/**
 * Whether the webview's own menu stays: a `tauri dev` run (Vite's dev mode) and a debug build of the app (the backend reports its test-data folder
 * only then) keep it for Inspect. In the dev preview `#nativemenu=off` turns it off so the release behaviour can be tried there too.
 */
export function nativeMenuStays(): boolean {
  if (import.meta.env.DEV) return !/(^|[#&])nativemenu=off(&|$)/.test(window.location.hash);
  return usePlatform.getState().testData !== null;
}

function probe(doc: Document, target: EventTarget | null) {
  const View = (doc.defaultView ?? window) as Window & typeof globalThis;
  const el = target instanceof View.Element ? target : null;
  const editable = !!el && isEditableNode({ tag: el.tagName, type: (el as HTMLInputElement).type, isContentEditable: (el as HTMLElement).isContentEditable });
  const a = (el?.closest("a[href]") as HTMLAnchorElement | null) ?? null;
  const href = a ? safeLinkHref(a.href) : null;
  // like the native menu: Copy is offered when the pointer is on the selection, not anywhere in the window
  const sel = doc.getSelection();
  const text = el && sel && !sel.isCollapsed && sel.containsNode(el, true) ? sel.toString().trim() : "";
  return { editable, a, href, text, own: !!el?.closest("[data-own-menu]") };
}

/** `frame`: set for a message's frame - where it sits in the window. (The pointer position of an event in the frame is in the frame's own viewport pixels, also when a wide mail is zoomed out to fit: checked in the preview.) */
function handle(doc: Document, e: MouseEvent, frame?: { left: number; top: number }) {
  if (nativeMenuStays()) return;
  const p = probe(doc, e.target);
  const policy = decideContextMenu({ dev: false, editable: p.editable, link: p.href, selection: p.text.length > 0 });
  if (policy === "native") return;
  e.preventDefault();
  if (p.own || policy === "block") return;
  const at = { x: (frame?.left ?? 0) + e.clientX, y: (frame?.top ?? 0) + e.clientY };
  const a = p.a;
  useGuardMenu.setState({
    menu: {
      at,
      text: p.text,
      link: p.href && a ? { href: p.href, open: () => a.click() } : null,
      returnTo: (document.activeElement as HTMLElement | null) ?? null,
    },
  });
}

/** The window's listener: capture phase, so it sees the click before any component does. Returns the function that removes it. */
export function installContextGuard(): () => void {
  const onContext = (e: MouseEvent) => handle(document, e);
  window.addEventListener("contextmenu", onContext, true);
  return () => window.removeEventListener("contextmenu", onContext, true);
}

/**
 * The same for the document of a message's frame (same origin, filled with `srcDoc`). "Open link" clicks the anchor itself, which runs the reading
 * pane's own click handler: the look-alike-link warning, then the safe external opener - the webview never navigates. Returns the remover.
 */
export function guardFrame(frame: HTMLIFrameElement, doc: Document): () => void {
  const onContext = (e: MouseEvent) => {
    const r = frame.getBoundingClientRect();
    handle(doc, e, { left: r.left, top: r.top });
  };
  const close = () => closeGuardMenu();
  doc.addEventListener("contextmenu", onContext, true);
  doc.addEventListener("mousedown", close, true);
  doc.addEventListener("keydown", close, true);
  doc.addEventListener("scroll", close, true);
  return () => {
    doc.removeEventListener("contextmenu", onContext, true);
    doc.removeEventListener("mousedown", close, true);
    doc.removeEventListener("keydown", close, true);
    doc.removeEventListener("scroll", close, true);
  };
}
