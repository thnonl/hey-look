// The frame that shows a PDF attachment: what may go into it and how it is sandboxed. Imports only frameSandbox.ts, so a plain Node
// script can test it (scripts/test-pdf-frame.mjs).
import { isWebKit } from "./frameSandbox.ts";

/** Every PDF starts with this (ISO 32000: the header). Nothing before it is accepted: an app-made preview has no use for a file that hides its start. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

/** Whether the bytes begin with the PDF header. */
export function isPdfBytes(bytes: Uint8Array): boolean {
  return bytes.length > PDF_MAGIC.length && PDF_MAGIC.every((b, i) => bytes[i] === b);
}

/**
 * The sandbox of the PDF preview frame, `null` = no `sandbox` attribute.
 *
 * Chromium (WebView2 on Windows) never runs its PDF viewer inside a sandboxed frame, whatever tokens the sandbox allows: every set
 * from `""` up to all tokens shows the "blocked" page (tested in the real WebView2 window, QA 1.0.5/1.0.6; kit in the WP1b report). So there
 * the frame has NO sandbox, which is only acceptable because `pdfPreview` lets nothing but verified PDF bytes in, typed `application/pdf`:
 * a PDF is not HTML, so there is no document of ours whose scripts could run in the app's origin. A blob URL is same-origin with the app;
 * a mislabelled HTML file in a frame without sandbox WOULD run its scripts in the app, which is what the two checks in `pdfPreview` prevent.
 * (A side effect that the backend guard in src-tauri/src/navguard.rs removes: a link inside the PDF can no longer be stopped by the sandbox from
 * navigating the whole window.)
 * WebKit (WKWebView on macOS) keeps the sandbox it always had, so nothing changes there; Linux has no PDF preview at all (`previewable`).
 */
export function pdfFrameSandbox(userAgent: string): string | null {
  return isWebKit(userAgent) ? "allow-same-origin allow-scripts" : null;
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
