// Print a message on macOS (1.0.7 W5.3). WKWebView cannot print a frame of the app page, so the page builds a small document of its own from what the message frame shows (the same
// HTML and the same CSP, the light presentation, without the rules that only the frame needs: the clipped height of the frame and the picture spinner) and hands it to the backend
// (print_html), which loads it into a web view that is in no window, with no script, and shows the system print sheet on this window. Pure text building here, so a Node script tests it
// (scripts/test-print-doc.mjs); the part that talks to the backend is printNative.ts.
import { MAIL_FRAME_CSS } from "./mailFrameCss.ts";
import { rewriteMailHtml } from "./colorSchemeMedia.ts";

/** What the message frame was built from (ReadingPane.tsx): the HTML as shown (pictures as allowed, blocked ones as placeholders), its CSP and the subject. */
export interface PrintSource {
  html: string;
  csp: string;
  subject: string;
}

/** The colours of the light presentation (the same as frameBaseCss for a message that is not dark) and the rules for paper. */
const PRINT_CSS =
  "html{--hm-fg:#242424;--hm-link:#0f6cbd;--hm-bg:#ffffff;color-scheme:light}" +
  "body{padding:0}" +
  "img{cursor:auto;break-inside:avoid}tr,blockquote{break-inside:avoid}.hl-ph,.hl-bp{break-inside:avoid;cursor:default}" +
  // a hidden-picture box that is loading or failed when the print was asked for (1.0.12 BUG-2): the same box, same size, dashed and grey, with no spinner, no retry arrow and no status text
  ".hl-bp[data-state] .hl-bp-main,.hl-bp[data-state] .hl-bp-hint,.hl-bp[data-state] .hl-bp-sr{display:none!important}.hl-bp[data-state] .hl-bp-ico{visibility:hidden}.hl-bp[data-state].bad{border-color:#9aa3af;color:#5b6470}";

/** The CSP of the print document: the frame's own, and scripts, forms and connections are forbidden whatever it says. */
export function printCsp(csp: string): string {
  const base = csp.replace(/;?\s*(script-src|connect-src|form-action)\s[^;]*/g, "").trim();
  return `${base}${base.endsWith(";") ? "" : ";"} script-src 'none'; connect-src 'none'; form-action 'none'`;
}

/** The document that is printed. Always light; the mail's own prefers-color-scheme rules mean "light" (REQ-5.5.3). */
export function buildPrintDoc(src: PrintSource): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${printCsp(src.csp)}">` +
    `<title>${escapeText(src.subject)}</title><style>${MAIL_FRAME_CSS}\n${PRINT_CSS}</style></head><body>${lightBody(src.html)}</body></html>`
  );
}

/** The mail with its colour-scheme queries made constant (light), without the copies of the original text that the frame keeps to re-apply them. */
const lightBody = (html: string) => rewriteMailHtml(html, false).replace(/ data-hm-orig(-media)?="[^"]*"/g, "");

const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
