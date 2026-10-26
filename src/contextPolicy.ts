// What a right-click does anywhere in the window (v1.0.6): the webview's own menu (Back, Reload, Inspect, "Save image as", "Open link in new window" ...)
// is not wanted in a release build, so every right-click is stopped unless something else answers it. Pure, so a script can test it
// (scripts/test-context-guard.mjs); the listener that applies it is contextGuard.ts.

/**
 * - `native`: leave the webview's menu: a development / debug build (Inspect), and fields that take text (see below).
 * - `link`: the app's link menu (Open link, Copy link address, and Copy when text is selected).
 * - `text`: the app's text menu: Copy (greyed when nothing is selected), Select all, and Copy email address when an address is under the pointer.
 *   Also the menu of a read-only field (Copy / Select all of the field).
 * - `block`: nothing; the right-click is swallowed.
 *
 * Fields that take text and can be changed (inputs, textareas, contenteditable: the compose body, the search box, every setting) keep the native
 * menu on purpose: (1) spell checking is on there (nothing turns `spellcheck` off in Compose or the editor) and the spelling suggestions of a
 * misspelled word are only reachable through the engine's own menu; (2) Paste cannot be done reliably from an app menu:
 * `navigator.clipboard.readText()` asks the user for a permission in WebView2, is refused in WebKitGTK and in WKWebView outside a trusted paste,
 * and `document.execCommand("paste")` is blocked by Chromium for web content. Cut / Copy / Select all would work, Paste would not.
 */
export type MenuPolicy = "native" | "link" | "text" | "block";

/**
 * What kind of control the pointer is on:
 * - `none`: not a field;
 * - `editable`: a text field, or text that is being edited, that can be changed;
 * - `readonly`: a text field with the `readonly` attribute (its text can be selected and copied, not changed);
 * - `secret`: a read-only password field (its text must never reach the clipboard);
 * - `disabled`: a disabled control (greyed out: nothing to offer).
 */
export type FieldKind = "none" | "editable" | "readonly" | "secret" | "disabled";

export interface Probe {
  /** a development / debug build: the native menu stays so that Inspect works */
  dev: boolean;
  field: FieldKind;
  /** the target is inside content that must not be copied (confidential mail) */
  locked: boolean;
  /** the link under the pointer (already checked with safeLinkHref), if any */
  link: string | null;
  /** an email address under the pointer (a recipient chip, or an address written in the text), if any */
  email: string | null;
  /** some text is selected (outside of an editable field) */
  selection: boolean;
  /** the pointer is on text that can be selected (not on a button, a picture, empty space, or text that is not selectable) */
  onText: boolean;
  /** the pointer is on a document the engine draws itself (a PDF in its viewer): its menu (Rotate, Print, Save as ...) stays */
  plugin?: boolean;
}

export function decideContextMenu(p: Probe): MenuPolicy {
  if (p.dev) return "native";
  if (p.locked) return "block";
  if (p.plugin) return "native";
  switch (p.field) {
    case "editable": return "native";
    case "readonly": return "text";
    case "secret":
    case "disabled": return "block";
  }
  if (p.link) return "link";
  if (p.email || p.selection || p.onText) return "text";
  return "block";
}

/**
 * Whether the webview's own menu stays everywhere (the Inspect menu of a developer), by the address's hash, `dev` (Vite's dev mode: `tauri dev`, the
 * browser preview) and `debugBuild` (a built app that the backend says is a debug build). A release build never keeps it. `#nativemenu=off` turns it off in
 * dev mode; `#nativemenu=on` turns it on in a debug build. Without a switch a built app, debug or not, is the release (D-036: the QA builds are debug builds).
 */
export function nativeMenuWanted(hash: string, dev: boolean, debugBuild: boolean): boolean {
  const m = /(^|[#&])nativemenu=(on|off)(&|$)/.exec(hash)?.[2];
  if (dev) return m !== "off";
  return debugBuild && m === "on";
}

/** A link the app may offer to open: http(s) and mailto, the schemes the "open link" path of the reading pane handles. Never `javascript:`, `data:`, `file:`, `blob:`. */
export function safeLinkHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const h = href.trim();
  return /^(https?:\/\/|mailto:)/i.test(h) ? h : null;
}

export interface NodeInfo {
  tag: string;
  type?: string;
  isContentEditable?: boolean;
  readOnly?: boolean;
  disabled?: boolean;
}

const TEXT_INPUTS = new Set(["", "text", "search", "email", "url", "tel", "password", "number", "date", "datetime-local", "month", "time", "week"]);

/** Whether this element takes text: a text-like input, a textarea, or content that is editable. (A checkbox, button or range is not.) */
export function isEditableNode(n: NodeInfo): boolean {
  if (n.isContentEditable) return true;
  const tag = n.tag.toLowerCase();
  if (tag === "textarea") return true;
  return tag === "input" && TEXT_INPUTS.has((n.type ?? "").toLowerCase());
}

/** The kind of control (see FieldKind). `disabled` also covers a button, a select ... that is greyed out. */
export function fieldKind(n: NodeInfo): FieldKind {
  if (n.disabled) return "disabled";
  if (!isEditableNode(n)) return "none";
  if (!n.readOnly || n.isContentEditable) return "editable";
  return (n.type ?? "").toLowerCase() === "password" ? "secret" : "readonly";
}

/** The part of `text` that is an address around the character `offset`: delimited by white space, `<>()[]",;:`; null when that word is not an address. */
export function emailAtOffset(text: string, offset: number): string | null {
  const stop = /[\s<>()[\]",;:]/;
  for (const at of [offset, offset - 1]) {
    if (at < 0 || at >= text.length || stop.test(text[at])) continue;
    let a = at;
    let b = at;
    while (a > 0 && !stop.test(text[a - 1])) a--;
    while (b < text.length - 1 && !stop.test(text[b + 1])) b++;
    const word = text.slice(a, b + 1).replace(/^mailto:/i, "").replace(/[.!?'']+$/, "");
    if (/^[^@\s]+@[^@\s]+\.[^@\s.]+$/.test(word)) return word;
  }
  return null;
}

/** How far "Select all" reaches from the text it was asked on (W13.3: the header line or the body of a message, not the whole page): the closest of these (a message's frame has its whole body instead; see contextGuard.ts). */
export const SELECT_SCOPE = "[data-select-scope], .rp-head h2, .rp-from, .rp-to, .rp-date, .rp-msg-body, [role=dialog], [role=alertdialog], [role=alert], [role=status], .summary, .rp-msg, .toast, .popover, .pv-text, .sig-block, section, aside";

/** The hosts of a document the engine draws itself (a PDF in its viewer): the engine's menu stays there (`Probe.plugin`). */
export const PLUGIN_HOST = "object, embed, iframe.pv-pdf";

/** Elements a click on their text means something else than reading it: no text menu on a button's label. */
export const INTERACTIVE = "button, select, summary, input, textarea, [role=button], [role=tab], [role=menuitem], [role=option], [role=switch], [role=checkbox], [role=radio], [role=treeitem], [role=slider], [draggable=true]";

/**
 * macOS: Ctrl+click is the right-click (1.0.10). WKWebView sends the `contextmenu` and then still a `click` with `ctrlKey`, which collapsed the mailbox whose menu had
 * just opened (and would press any button the menu opened on). That click is swallowed. Windows and Linux: Ctrl+click is a click with a modifier, as it always was.
 */
export function isMacControlClick(os: string, e: { ctrlKey: boolean; button: number }): boolean {
  return os === "macos" && e.ctrlKey && e.button === 0;
}
