// What a right-click does anywhere in the window (v1.0.6): the webview's own menu (Back, Reload, Inspect, "Save image as", "Open link in new window" ...)
// is not wanted in a release build, so every right-click is stopped unless something else answers it. Pure, so a script can test it
// (scripts/test-context-guard.mjs); the listener that applies it is contextGuard.ts.

/**
 * - `native`: leave the webview's menu: a development / debug build (Inspect), and editable fields (see below).
 * - `link`: the app's link menu (Open link, Copy link address, and Copy when text is selected).
 * - `copy`: the app's one-entry menu (Copy) on selected text.
 * - `block`: nothing; the right-click is swallowed.
 *
 * Editable fields (inputs, textareas, contenteditable: the compose body, the search box, every setting) keep the native menu on purpose:
 * (1) spell checking is on there (nothing turns `spellcheck` off in Compose or the editor) and the spelling suggestions of a misspelled
 * word are only reachable through the engine's own menu; (2) Paste cannot be done reliably from an app menu: `navigator.clipboard.readText()`
 * asks the user for a permission in WebView2, is refused in WebKitGTK and in WKWebView outside a trusted paste, and
 * `document.execCommand("paste")` is blocked by Chromium for web content. Cut / Copy / Select all would work, Paste would not.
 */
export type MenuPolicy = "native" | "link" | "copy" | "block";

export interface Probe {
  /** a development / debug build: the native menu stays so that Inspect works */
  dev: boolean;
  /** the target is a field that takes text */
  editable: boolean;
  /** the link under the pointer (already checked with safeLinkHref), if any */
  link: string | null;
  /** some text is selected (outside of an editable field) */
  selection: boolean;
}

export function decideContextMenu(p: Probe): MenuPolicy {
  if (p.dev) return "native";
  if (p.editable) return "native";
  if (p.link) return "link";
  if (p.selection) return "copy";
  return "block";
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
}

const TEXT_INPUTS = new Set(["", "text", "search", "email", "url", "tel", "password", "number", "date", "datetime-local", "month", "time", "week"]);

/** Whether this element takes text: a text-like input, a textarea, or content that is editable. (A checkbox, button or range is not.) */
export function isEditableNode(n: NodeInfo): boolean {
  if (n.isContentEditable) return true;
  const tag = n.tag.toLowerCase();
  if (tag === "textarea") return true;
  return tag === "input" && TEXT_INPUTS.has((n.type ?? "").toLowerCase());
}
