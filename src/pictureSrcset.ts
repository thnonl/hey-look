// srcset of a mail's pictures (1.0.11). A picture is shown from the one address the backend fetched (a data: URI in `src`). The webview prefers `srcset` to `src`, so a srcset that stays
// with the remote candidates makes it load those itself (the frame's CSP is img-src data:): a broken picture. So a shown picture has no srcset / sizes, and the <source> elements of its
// <picture> (each has a srcset of its own) are dropped. Pure string helpers here; scripts/test-picture-srcset.mjs runs them as they are.

/** The address of the first candidate of a srcset ("  https://a/x.png,  https://a/x_2x.png 1.5x, ..." gives "https://a/x.png"), or "" when there is none. Leading white space is ignored. */
export function firstSrcsetUrl(srcset: string | null | undefined): string {
  const s = (srcset ?? "").replace(/^[\s,]+/, "");
  // a candidate's URL ends at white space (a comma inside it belongs to it); commas at its end separate it from the next candidate
  return s.split(/\s/, 1)[0].replace(/,+$/, "");
}

/** A remote address (http, https or protocol-relative) as an absolute one; "" for anything else. */
export function remoteUrl(u: string | null | undefined): string {
  const v = (u ?? "").trim();
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith("//")) return `https:${v}`;
  return "";
}

/** What an <img> shows: its own src, else the first candidate of its srcset (raw, not trimmed to remote). */
export function pictureAddress(src: string | null | undefined, srcset: string | null | undefined): string {
  const s = (src ?? "").trim();
  return s || firstSrcsetUrl(srcset);
}

/** Takes the srcset away from a picture (and its sizes). */
export function dropSrcset(img: Element): void {
  img.removeAttribute("srcset");
  img.removeAttribute("sizes");
}

/** Makes every <img> below `root` show only its src: no srcset / sizes, no <source> in a <picture>. An <img> without src gets the first candidate of its srcset as src. */
export function dropSrcsets(root: ParentNode): void {
  root.querySelectorAll("picture > source").forEach((s) => s.remove());
  root.querySelectorAll("img[srcset], img[sizes]").forEach((i) => {
    if (!(i.getAttribute("src") ?? "").trim()) {
      const first = firstSrcsetUrl(i.getAttribute("srcset"));
      if (first) i.setAttribute("src", first);
    }
    dropSrcset(i);
  });
}
