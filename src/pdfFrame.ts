// The frame that shows a PDF attachment: what may go into it, how it is sandboxed and when it counts as failed. Imports only frameSandbox.ts, so
// a plain Node script can test it (scripts/test-pdf-frame.mjs).
import { isWebKit } from "./frameSandbox.ts";

/** Every PDF starts with this (ISO 32000: the header). Nothing before it is accepted: an app-made preview has no use for a file that hides its start. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

/** Whether the bytes begin with the PDF header. */
export function isPdfBytes(bytes: Uint8Array): boolean {
  return bytes.length > PDF_MAGIC.length && PDF_MAGIC.every((b, i) => bytes[i] === b);
}

/** WKWebView on macOS (not WebKitGTK on Linux, which has no PDF preview at all): the user agent of Safari's engine on a Mac. */
export function isMacWebView(userAgent: string): boolean {
  return isWebKit(userAgent) && /Macintosh|Mac OS X/i.test(userAgent);
}

/**
 * The sandbox of the PDF preview frame, `null` = no `sandbox` attribute.
 *
 * Neither engine that has a PDF preview draws a PDF inside a sandboxed frame, whatever tokens the sandbox allows:
 * - Chromium (WebView2 on Windows): every token set from `""` up to all of them shows the "blocked" page (tested in the real WebView2 window,
 *   QA 1.0.5/1.0.6; kit in the WP1b report);
 * - WebKit (WKWebView on macOS): the frame stays blank white (Mac QA 1.0.6: the sheet opened, 5 s later still blank, the PDF was valid).
 * So on both the frame has NO sandbox, which is only acceptable because `pdfPreview` lets nothing but verified PDF bytes in, typed
 * `application/pdf`: a PDF is not HTML, so there is no document of ours whose scripts could run in the app's origin. A blob URL is same-origin
 * with the app; a mislabelled HTML file in a frame without sandbox WOULD run its scripts in the app, which is what the two checks in
 * `pdfPreview` prevent. The other thing the sandbox did, stopping a link inside the PDF from taking the window away, is done by the
 * navigation guard in src-tauri/src/navguard.rs, which is registered on exactly those two systems (Windows, macOS).
 * Linux (WebKitGTK) has no PDF preview (`previewable`) and no guard, so if a frame is ever made there it keeps the sandbox it always had.
 */
export function pdfFrameSandbox(userAgent: string): string | null {
  return isWebKit(userAgent) && !isMacWebView(userAgent) ? "allow-same-origin allow-scripts" : null;
}

export type PdfPreview = { ok: true; blob: Blob; sandbox: string | null } | { ok: false };

/**
 * The preview of a PDF attachment, or `ok: false` when the bytes are not a PDF (a file called .pdf that holds anything else is not drawn:
 * the person can still Open or Save it). The blob's type is forced to `application/pdf` here and nowhere else, whatever the mail said.
 */
export function pdfPreview(bytes: Uint8Array, userAgent: string): PdfPreview {
  if (!isPdfBytes(bytes)) return { ok: false };
  return { ok: true, blob: new Blob([bytes as BlobPart], { type: "application/pdf" }), sandbox: pdfFrameSandbox(userAgent) };
}

// ---------------------------------------------------------------- a preview that cannot draw says so

/** How long the engine has to report that the PDF frame loaded before the preview counts as failed. */
export const PDF_DRAW_WAIT_MS = 8000;

export type PdfFrameState = "loading" | "loaded" | "failed";
export type PdfFrameEvent = "load" | "blocked" | "timeout";

/**
 * The state of a PDF frame. `load`: the engine finished loading it; `blocked`: the page's content security policy refused it (a
 * `securitypolicyviolation` for the frame); `timeout`: nothing was reported in [`PDF_DRAW_WAIT_MS`]. A failed frame is replaced by a message with
 * an Open button, so the outcome is never a blank page. (A frame that loads but draws nothing cannot be seen from the page: the dialog's own
 * Open button is the way out then.)
 */
export function nextPdfState(s: PdfFrameState, ev: PdfFrameEvent): PdfFrameState {
  if (ev === "blocked") return "failed";
  if (s !== "loading") return s;
  return ev === "load" ? "loaded" : "failed";
}

/** Is this `securitypolicyviolation` the refusal of the PDF frame (a blob: address refused by the frame / child / object rule)? */
export function isFrameRefusal(v: { blockedURI?: string; effectiveDirective?: string }): boolean {
  const blocked = (v.blockedURI ?? "").toLowerCase();
  return blocked.startsWith("blob") && ["frame-src", "child-src", "object-src"].includes(v.effectiveDirective ?? "");
}
