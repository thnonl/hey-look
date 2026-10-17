// One listener for every right-click of the window (the rules are in contextPolicy.ts), and the same for a message's frame, which is a document of its
// own that never reaches the window's listener. The app's own menus (the mail list row, a mailbox of the folder pane) are marked `data-own-menu`: they
// answer the click themselves and this listener only swallows the native menu there. The ContextMenu key and Shift+F10 are answered the same way,
// at the selection or at the focused element.
import { create } from "zustand";
import { isContextMenuKey, isKeyEcho } from "./contextMenu";
import { decideContextMenu, emailAtOffset, fieldKind, INTERACTIVE, SELECT_SCOPE, safeLinkHref } from "./contextPolicy";
import { usePlatform } from "./platform";

export interface GuardMenu {
  at: { x: number; y: number };
  /** opened with the keyboard: the first entry is focused */
  keyboard: boolean;
  /** the selected text (the Copy entry); "" when nothing is selected (Copy is then greyed) */
  text: string;
  /** the link under the pointer (the Open link / Copy link address entries) and how to open it */
  link: { href: string; open: () => void } | null;
  /** an email address under the pointer or in the focused element (the Copy email address entry) */
  email: string | null;
  /** the Select all entry (null: none) */
  selectAll: (() => void) | null;
  /** where the focus goes when the menu closes */
  returnTo: HTMLElement | null;
}

export const useGuardMenu = create<{ menu: GuardMenu | null }>(() => ({ menu: null }));
export const closeGuardMenu = () => useGuardMenu.setState({ menu: null });

/**
 * Whether the webview's own menu stays: a `tauri dev` run (Vite's dev mode) and a debug build of the app (the backend reports its test-data folder
 * only then) keep it for Inspect. `#nativemenu=off` in the page's address turns it off so the release behaviour can be tried there too (in the dev
 * preview, and in a debug build: a release build has no such switch).
 */
export function nativeMenuStays(): boolean {
  const off = /(^|[#&])nativemenu=off(&|$)/.test(window.location.hash);
  if (import.meta.env.DEV) return !off;
  return usePlatform.getState().testData !== null && !off;
}

type Pt = { x: number; y: number };

/** The text node under the point when the point is on its text (not on blank space beside it), and the character offset there. */
function textAt(doc: Document, pt: Pt): { node: Text; offset: number } | null {
  const d = doc as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  let node: Node | null = null;
  let offset = 0;
  if (d.caretRangeFromPoint) {
    const r = d.caretRangeFromPoint(pt.x, pt.y);
    if (r) (node = r.startContainer, offset = r.startOffset);
  } else if (d.caretPositionFromPoint) {
    const c = d.caretPositionFromPoint(pt.x, pt.y);
    if (c) (node = c.offsetNode, offset = c.offset);
  }
  if (!node || node.nodeType !== 3 || !node.nodeValue?.trim()) return null;
  const range = doc.createRange();
  range.selectNodeContents(node);
  for (const r of Array.from(range.getClientRects())) if (pt.x >= r.left - 1 && pt.x <= r.right + 1 && pt.y >= r.top - 1 && pt.y <= r.bottom + 1) return { node: node as Text, offset };
  return null;
}

const selectable = (win: Window, el: Element) => {
  const cs = win.getComputedStyle(el) as CSSStyleDeclaration & { webkitUserSelect?: string };
  return cs.userSelect !== "none" && cs.webkitUserSelect !== "none";
};

/**
 * What is under the pointer (`pt`), or at the focus when the menu was asked for with the keyboard (`pt` null: the selection, the focused link or
 * the focused read-only field).
 */
function probe(doc: Document, target: EventTarget | null, pt: Pt | null) {
  const View = (doc.defaultView ?? window) as Window & typeof globalThis;
  const sel = doc.getSelection();
  const asEl = (n: Node | null | undefined): Element | null => (n instanceof View.Element ? n : (n?.parentElement ?? null));
  let el = target instanceof View.Element ? target : null;
  if (!pt) {
    // with the keyboard: the focused element, else where the selection ends
    const ae = doc.activeElement;
    el = ae && ae !== doc.body && ae !== doc.documentElement ? ae : sel && !sel.isCollapsed ? asEl(sel.focusNode) : null;
  }
  const field = el ? fieldKind({ tag: el.tagName, type: (el as HTMLInputElement).type, isContentEditable: (el as HTMLElement).isContentEditable, readOnly: (el as HTMLInputElement).readOnly, disabled: !!el.closest(":disabled") }) : "none";
  const a = (el?.closest("a[href]") as HTMLAnchorElement | null) ?? null;
  const href = a ? safeLinkHref(a.href) : null;
  let text = "";
  if (field === "readonly") {
    const i = el as HTMLInputElement;
    const s = i.selectionStart;
    const e = i.selectionEnd;
    if (s !== null && e !== null && e > s) text = i.value.slice(s, e);
  } else if (el && sel && !sel.isCollapsed && (!pt || sel.containsNode(el, true))) {
    // like the native menu: Copy is for the pointer on the selection, not anywhere in the window
    text = sel.toString().trim();
  }
  const hit = pt && field === "none" ? textAt(doc, pt) : null;
  const interactive = !!el?.closest(INTERACTIVE);
  const onText = !!hit && !!el && !interactive && selectable(View, el);
  const tagged = el?.closest("[data-email]")?.getAttribute("data-email") ?? null;
  const email = href ? null : (tagged || (hit && onText ? emailAtOffset(hit.node.data, hit.offset) : null) || null);
  const scope = field === "readonly" ? null : doc !== document ? doc.body : ((el?.closest(SELECT_SCOPE) as HTMLElement | null) ?? doc.body);
  return {
    field, a, href, text, email, onText, el,
    own: !!el?.closest("[data-own-menu]"),
    locked: !!el?.closest(".confidential, [data-no-copy]"),
    selectAll: field === "readonly" && el
      ? () => { (el as HTMLInputElement).focus(); (el as HTMLInputElement).select(); }
      : () => {
          const r = doc.createRange();
          r.selectNodeContents(scope ?? doc.body);
          const s = doc.getSelection();
          s?.removeAllRanges();
          s?.addRange(r);
          doc.defaultView?.focus(); // a message's frame: its selection shows as active only while the frame has the focus
        },
  };
}

/** When the last ContextMenu key / Shift+F10 press was answered: the contextmenu event that follows it (the system sends one) is the same request. */
let keyAt = 0;

/** `frame`: set for a message's frame - where it sits in the window. (The pointer position of an event in the frame is in the frame's own viewport pixels, also when a wide mail is zoomed out to fit: checked in the preview.) */
function handle(doc: Document, e: MouseEvent, frame?: HTMLIFrameElement) {
  if (nativeMenuStays()) return;
  const p = probe(doc, e.target, { x: e.clientX, y: e.clientY });
  const policy = decideContextMenu({ dev: false, field: p.field, locked: p.locked, link: p.href, email: p.email, selection: p.text.length > 0, onText: p.onText });
  if (policy === "native") return;
  e.preventDefault();
  if (p.own || policy === "block" || isKeyEcho(keyAt, Date.now())) return;
  const r = frame?.getBoundingClientRect();
  show(p, { x: (r?.left ?? 0) + e.clientX, y: (r?.top ?? 0) + e.clientY }, false);
}

function show(p: ReturnType<typeof probe>, at: Pt, keyboard: boolean) {
  const a = p.a;
  useGuardMenu.setState({
    menu: {
      at,
      keyboard,
      text: p.text,
      link: p.href && a ? { href: p.href, open: () => a.click() } : null,
      email: p.email,
      selectAll: p.selectAll,
      returnTo: (document.activeElement as HTMLElement | null) ?? null,
    },
  });
}

/** Where the menu of the ContextMenu key / Shift+F10 opens: below the end of the selection, else below the focused element (in the window's pixels). */
function keyAnchor(doc: Document, el: Element | null, frame?: HTMLIFrameElement): Pt | null {
  const off = frame?.getBoundingClientRect();
  const sel = doc.getSelection();
  let r: { left: number; right: number; bottom: number } | null = null;
  if (sel && !sel.isCollapsed && sel.rangeCount) {
    const rects = Array.from(sel.getRangeAt(sel.rangeCount - 1).getClientRects());
    const last = rects[rects.length - 1];
    if (last && (last.width || last.height)) r = { left: last.right, right: last.right, bottom: last.bottom };
  }
  if (!r && el) {
    const b = el.getBoundingClientRect();
    r = { left: b.left + Math.min(16, b.width / 2), right: b.right, bottom: b.bottom };
  }
  return r ? { x: (off?.left ?? 0) + r.left, y: (off?.top ?? 0) + r.bottom } : null;
}

function handleKey(doc: Document, e: KeyboardEvent, frame?: HTMLIFrameElement) {
  if (!isContextMenuKey(e) || nativeMenuStays()) return;
  const p = probe(doc, null, null);
  const policy = decideContextMenu({ dev: false, field: p.field, locked: p.locked, link: p.href, email: p.email, selection: p.text.length > 0, onText: false });
  if (policy === "native" || p.own) return; // a field answers its own key; the mail list does too
  e.preventDefault();
  keyAt = Date.now();
  if (policy === "block") return;
  const at = keyAnchor(doc, p.el, frame);
  if (at) show(p, at, true);
}

/** The window's listeners: capture phase, so they see the click / key before any component does. Returns the function that removes them. */
export function installContextGuard(): () => void {
  const onContext = (e: MouseEvent) => handle(document, e);
  const onKey = (e: KeyboardEvent) => handleKey(document, e);
  window.addEventListener("contextmenu", onContext, true);
  window.addEventListener("keydown", onKey, true);
  return () => {
    window.removeEventListener("contextmenu", onContext, true);
    window.removeEventListener("keydown", onKey, true);
  };
}

/**
 * The same for the document of a message's frame (same origin, filled with `srcDoc`). "Open link" clicks the anchor itself, which runs the reading
 * pane's own click handler: the look-alike-link warning, then the safe external opener - the webview never navigates. Returns the remover.
 */
export function guardFrame(frame: HTMLIFrameElement, doc: Document): () => void {
  const onContext = (e: MouseEvent) => handle(doc, e, frame);
  const onKey = (e: KeyboardEvent) => handleKey(doc, e, frame);
  const close = (e: KeyboardEvent) => isContextMenuKey(e) || closeGuardMenu();
  const closeAny = () => closeGuardMenu();
  doc.addEventListener("contextmenu", onContext, true);
  doc.addEventListener("keydown", onKey, true);
  doc.addEventListener("mousedown", closeAny, true);
  doc.addEventListener("keydown", close, true);
  doc.addEventListener("scroll", closeAny, true);
  return () => {
    doc.removeEventListener("contextmenu", onContext, true);
    doc.removeEventListener("keydown", onKey, true);
    doc.removeEventListener("mousedown", closeAny, true);
    doc.removeEventListener("keydown", close, true);
    doc.removeEventListener("scroll", closeAny, true);
  };
}
