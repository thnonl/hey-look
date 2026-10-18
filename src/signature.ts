// The signature of a message being written is a block of its own in the editor (a marker node), not text the user can
// break: it is shown live from the chosen signature and only turned into HTML when the draft is built (saved or sent).

/** HTML of the marker node (`SignatureBlock` in Compose.tsx parses and renders exactly this). */
export const SIG_MARK = "<div data-sig-block></div>";

const LEAD = /^\s*--\s*(<br\s*\/?>)?\s*/i;
const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");

/** How the signature appears in the stored / sent message. */
export const sigBlockHtml = (sigHtml: string) => `<br><div class="sig">-- <br>${sigHtml}</div>`;

/** The HTML a signature gets compared by (browser-normalised). */
export function normalizeHtml(html: string): string {
  return parse(html).body.innerHTML.trim();
}

/**
 * A stored draft body -> editor content. The signature block of the stored message (`div.sig`) becomes the marker node (so it
 * is shown as the signature region again) and its HTML is returned; without one the marker is appended at the end.
 */
export function extractSignature(html: string): { html: string; sig: string | null } {
  const doc = parse(html);
  // The signature of the message being written, not one inside the quoted or forwarded message: not in a blockquote and not in a `div.hl-quote`.
  // The FIRST such block: the region is always above the quote, so a forwarded Hey Look! signature further down (a draft from before 1.0.6, whose
  // forward is a plain `div` without `hl-quote`) can never be taken for the person's own (W2.22 CF-14).
  const el = [...doc.querySelectorAll("div.sig")].find((d) => !d.closest("blockquote, div.hl-quote")) ?? null;
  if (!el) {
    // no signature in the stored message: the region goes where a new reply has it, above the quoted original (editor/quoteBlock.ts), else at the end
    const q = html.indexOf("<div data-quote-block=");
    return { html: q >= 0 ? html.slice(0, q) + SIG_MARK + html.slice(q) : html + SIG_MARK + "<p></p>", sig: null };
  }
  const sig = el.innerHTML.replace(LEAD, "").trim();
  const prev = el.previousElementSibling;
  if (prev && prev.tagName === "BR" && prev.nextSibling === el) prev.remove(); // the <br> sigBlockHtml put in front
  const mark = doc.createElement("div");
  mark.setAttribute("data-sig-block", "");
  el.replaceWith(mark);
  if (!doc.body.lastElementChild || doc.body.lastElementChild === mark) doc.body.append(doc.createElement("p"));
  return { html: doc.body.innerHTML, sig };
}

/** Replaces the marker node(s) of `doc` by the signature (or removes them) and drops empty paragraphs left at the very end. */
export function fillSignature(doc: Document, sigHtml: string | null): void {
  doc.querySelectorAll("[data-sig-block]").forEach((m) => {
    if (sigHtml && sigHtml.trim()) {
      const t = doc.createElement("template");
      t.innerHTML = sigBlockHtml(sigHtml);
      m.replaceWith(t.content);
    } else m.remove();
  });
  for (let last = doc.body.lastElementChild; last && last.tagName === "P" && !last.textContent?.trim() && !last.querySelector("img"); last = doc.body.lastElementChild) last.remove();
}

/** Same on a string (dev self-check). */
export function fillSignatureHtml(html: string, sigHtml: string | null): string {
  const doc = parse(html);
  fillSignature(doc, sigHtml);
  return doc.body.innerHTML;
}
