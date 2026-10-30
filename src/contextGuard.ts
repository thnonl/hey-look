// One listener for every right-click of the window (the rules are in contextPolicy.ts), and the same for a message's frame, which is a document of its
// own that never reaches the window's listener. The app's own menus (the mail list row, a mailbox of the folder pane) are marked `data-own-menu`: they
// answer the click themselves and this listener only swallows the native menu there. The ContextMenu key and Shift+F10 are answered the same way,
// at the selection or at the focused element.
import { create } from "zustand";
import { isContextMenuKey, isKeyEcho } from "./contextMenu";
import { guardFrameQuitKey } from "./quitKey";
import { decideContextMenu, emailAtOffset, isMacControlClick, fieldKind, INTERACTIVE, nativeMenuWanted, PLUGIN_HOST, SELECT_SCOPE, safeLinkHref } from "./contextPolicy";
import { usePlatform } from "./platform";
import { selectionQuery } from "./selectionSearch";

/** What the menu of a hidden picture can do (the reading pane gives these to `guardFrame`): show this one (null: it has no address to fetch), show all, and "always show from this sender" (null: not offered). */
export interface PictureMenu {
  /** the box itself: the focus returns to it when the menu closes (Esc) */
  box: HTMLElement;
  showOne: (() => void) | null;
  showAll: () => void;
  always: (() => void) | null;
}

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
  /** the subject as shown, when the menu was opened on the subject heading of the reading pane or of a reader window (the Copy subject entry, W8.1) */
  subject: string | null;
  /** the search for the selected text (the "Search mail for ..." entry, W8.1); null outside the reading areas or with nothing selected */
  search: string | null;
  /** the box of a hidden picture under the pointer or at the focus (Show this picture, Show all pictures, Always show from this sender); null elsewhere */
  picture: PictureMenu | null;
  /** where the focus goes when the menu closes */
  returnTo: HTMLElement | null;
}

export const useGuardMenu = create<{ menu: GuardMenu | null }>(() => ({ menu: null }));
export const closeGuardMenu = () => useGuardMenu.setState({ menu: null });

/**
 * Whether the webview's own menu stays (D-036). A `tauri dev` run (Vite's dev mode) keeps it for Inspect; `#nativemenu=off` in the page's address turns
 * it off there. A built app, debug or release, behaves like the release: no native menu outside of fields that take text. The QA builds are
 * debug builds (test bridge, HEYLOOK_DATA_DIR): until 1.0.7 they kept the native menu too, so QA saw WebKit's own menu in the message and on every label
 * and could not tell whether the release has it. A debug build can still ask for the native menu with `#nativemenu=on`; a release build has no such switch.
 * "Inspect Element" is in the engine's menu of a text field only where the engine has an inspector: a `tauri dev` run, or a debug build started with
 * `HEYLOOK_DEVTOOLS=1`. A QA build is made without one (identity.rs `devtools_off`, D-037) and a release build never has one, so its Subject / body menus are the release's.
 */
export function nativeMenuStays(): boolean {
  return nativeMenuWanted(window.location.hash, import.meta.env.DEV, usePlatform.getState().testData !== null);
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
function probe(doc: Document, target: EventTarget | null, pt: Pt | null, inMessageFrame = false, pictureOf?: (box: HTMLElement) => PictureMenu | null) {
  const View = (doc.defaultView ?? window) as Window & typeof globalThis;
  const sel = doc.getSelection();
  const asEl = (n: Node | null | undefined): Element | null => (n instanceof View.Element ? n : (n?.parentElement ?? null));
  // (a contextmenu event of a mouse always has an element as its target; a synthetic one - the QA bridge, a script - may be dispatched on a text node, which has no closest(): WebKit then lost the box
  // and the menu was blocked. A text node counts as its parent element; a node of another realm is looked up by the point.)
  let el = target instanceof View.Element ? target : target instanceof View.Node ? asEl(target as Node) : null;
  if (!el && pt && target) el = doc.elementFromPoint(pt.x, pt.y);
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
  // the subject heading of the reading pane and of a reader window (data-subject): "Copy subject"; and the places where a selection can be searched for: the message's frame, the reading pane
  // (header, subject, sender line, the AI box) and a reader window's message area (it is a reading pane too)
  const subject = field === "none" ? (el?.closest("[data-subject]")?.getAttribute("data-subject") ?? null) : null;
  const searchArea = field === "none" && (inMessageFrame || !!el?.closest(".reading-pane, [data-mail-search]"));
  const picBox = field === "none" && pictureOf ? (el?.closest(".hl-bp[data-hl-pic]") as HTMLElement | null) : null;
  const picture = picBox && pictureOf ? pictureOf(picBox) : null;
  const scope = field === "readonly" ? null : doc !== document ? doc.body : ((el?.closest(SELECT_SCOPE) as HTMLElement | null) ?? doc.body);
  return {
    field, a, href, text, email, onText, el, subject, searchArea, picture,
    own: !!el?.closest("[data-own-menu]"),
    plugin: !!el?.closest(PLUGIN_HOST),
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
function handle(doc: Document, e: MouseEvent, frame?: HTMLIFrameElement, searchable = false, pictureOf?: (box: HTMLElement) => PictureMenu | null) {
  if (nativeMenuStays()) return;
  try {
    const p = probe(doc, e.target, { x: e.clientX, y: e.clientY }, searchable, pictureOf);
    // (the subject heading is text to the menu even where the engine would not select it: a reader window's title is draggable)
    const policy = decideContextMenu({ dev: false, field: p.field, locked: p.locked, link: p.href, picture: !!p.picture, email: p.email, selection: p.text.length > 0, onText: p.onText || p.subject !== null, plugin: p.plugin });
    if (policy === "native") return;
    e.preventDefault();
    if (p.own || policy === "block" || isKeyEcho(keyAt, Date.now())) return;
    const r = frame?.getBoundingClientRect();
    show(p, { x: (r?.left ?? 0) + e.clientX, y: (r?.top ?? 0) + e.clientY }, false);
  } catch {
    // a probe that throws (an odd node, an engine without caretRangeFromPoint) must not let the webview's menu through: fail closed, except in a field that takes text
    if (!isEditableTarget(e.target)) e.preventDefault();
  }
}

/** Whether the target is a field that takes text (its native menu is wanted): the same rule as the probe's, without anything that can throw. */
function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as (Element & { isContentEditable?: boolean }) | null;
  if (!el || typeof el.tagName !== "string") return false;
  return fieldKind({ tag: el.tagName, type: (el as HTMLInputElement).type, isContentEditable: el.isContentEditable, readOnly: (el as HTMLInputElement).readOnly, disabled: false }) === "editable";
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
      subject: p.subject,
      search: p.searchArea && p.text ? selectionQuery(p.text) : null,
      picture: p.picture,
      returnTo: p.picture?.box ?? (document.activeElement as HTMLElement | null) ?? null,
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

function handleKey(doc: Document, e: KeyboardEvent, frame?: HTMLIFrameElement, searchable = false, pictureOf?: (box: HTMLElement) => PictureMenu | null) {
  if (!isContextMenuKey(e) || nativeMenuStays()) return;
  const p = probe(doc, null, null, searchable, pictureOf);
  const policy = decideContextMenu({ dev: false, field: p.field, locked: p.locked, link: p.href, picture: !!p.picture, email: p.email, selection: p.text.length > 0, onText: p.subject !== null });
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
  // macOS: the click that follows a Ctrl+click (the right-click) is not a click (contextPolicy.ts `isMacControlClick`)
  const onClick = (e: MouseEvent) => {
    if (!isMacControlClick(usePlatform.getState().os, e)) return;
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener("contextmenu", onContext, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("click", onClick, true);
  return () => {
    window.removeEventListener("contextmenu", onContext, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("click", onClick, true);
  };
}

/**
 * The same for the document of a message's frame (same origin, filled with `srcDoc`). "Open link" clicks the anchor itself, which runs the reading
 * pane's own click handler: the look-alike-link warning, then the safe external opener - the webview never navigates. Returns the remover.
 */
export function guardFrame(frame: HTMLIFrameElement, doc: Document, opts?: { search?: boolean; picture?: (box: HTMLElement) => PictureMenu | null }): () => void {
  const searchable = !!opts?.search; // (the frame of a message: its selection can be searched for, W8.1; the frame of an attachment preview cannot)
  const onContext = (e: MouseEvent) => handle(doc, e, frame, searchable, opts?.picture);
  const onKey = (e: KeyboardEvent) => handleKey(doc, e, frame, searchable, opts?.picture);
  const close = (e: KeyboardEvent) => isContextMenuKey(e) || closeGuardMenu();
  const closeAny = () => closeGuardMenu();
  // a press in the frame never reaches the window's document: tell the popovers of the main window (their outside-press listeners are on document, capture phase)
  const press = () => {
    closeGuardMenu();
    frame.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  };
  doc.addEventListener("contextmenu", onContext, true);
  doc.addEventListener("keydown", onKey, true);
  doc.addEventListener("mousedown", press, true);
  doc.addEventListener("keydown", close, true);
  doc.addEventListener("scroll", closeAny, true);
  const dropQuitKey = guardFrameQuitKey(doc); // Linux Ctrl+Q while the focus is in the message (D-021)
  return () => {
    dropQuitKey();
    doc.removeEventListener("contextmenu", onContext, true);
    doc.removeEventListener("keydown", onKey, true);
    doc.removeEventListener("mousedown", press, true);
    doc.removeEventListener("keydown", close, true);
    doc.removeEventListener("scroll", closeAny, true);
  };
}
