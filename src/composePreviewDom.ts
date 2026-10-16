// The DOM half of the composer's "Preview as recipient" (the colours and the choice are composePreview.ts).
// The signature region is the one part of the composer that holds a mail's own colours (the message body is a rich-text document
// without text colours), so in the dark preview it goes through the reading pane's dark transformation: darkMail.ts buildDarkSheet,
// the very function the message frame uses, limited to that region (`scope`). The region is not part of the editor's document
// (a node view the editor ignores) and buildDraft takes the signature from the chosen signature, not from this DOM.
import { buildDarkSheet, markDarkLogos } from "./darkMail";
import { DARK_CANVAS } from "./mailCanvas";

const sheets = new WeakMap<Element, HTMLStyleElement>();

/** Takes the dark recolouring off a region: its sheet and the tags the sheet used. */
export function clearDarkRegion(scope: Element): void {
  sheets.get(scope)?.remove();
  sheets.delete(scope);
  scope.querySelectorAll("[data-hm]").forEach((el) => el.removeAttribute("data-hm"));
  scope.querySelectorAll("[data-hm-chip]").forEach((el) => el.removeAttribute("data-hm-chip"));
}

/**
 * Shows a region on the preview surface: dark (recoloured from the region's own colours, which are read first, with the dark base
 * colours already in place) or as it is. Safe to call again after the region's content changed.
 */
export function setDarkRegion(scope: HTMLElement, dark: boolean): void {
  clearDarkRegion(scope);
  if (!dark || !scope.innerHTML.trim()) return;
  const doc = scope.ownerDocument;
  try {
    const style = doc.createElement("style");
    style.textContent = buildDarkSheet(doc, DARK_CANVAS, scope);
    doc.head.appendChild(style);
    sheets.set(scope, style);
    markDarkLogos(scope);
  } catch {
    clearDarkRegion(scope); // could not recolour: the original colours beat unreadable ones
  }
}
