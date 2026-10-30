// srcset of a mail's pictures (1.0.11). A picture is shown from the one address the backend fetched (a data: URI in `src`). The webview prefers `srcset` to `src`, so a srcset that stays
// with the remote candidates makes it load those itself (the frame's CSP is img-src data:): a broken picture. So a shown picture has no srcset / sizes, and the <source> elements of its
// <picture> (each has a srcset of its own) keep ONE address, the fetched data: URI (settleSources; a dark-mode logo must still switch), or are dropped. Pure helpers here; scripts/test-picture-srcset.mjs runs them as they are.

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
function dropSrcset(img: Element): void {
  img.removeAttribute("srcset");
  img.removeAttribute("sizes");
}

/** A <source> that picks its picture by the colour scheme (a dark-mode logo); the reading pane rewrites its media and keeps the text in data-hm-orig-media. */
export function isSchemeSource(s: Element): boolean {
  return /prefers-color-scheme/i.test(`${s.getAttribute("media") ?? ""} ${s.getAttribute("data-hm-orig-media") ?? ""}`);
}

/**
 * The <source> elements of the <picture>s below `root` (a dark-mode logo: `media="(prefers-color-scheme: dark)"`, which the reading pane makes a constant for the message background)
 * are kept with ONE safe address as their srcset: the data: URI of the picture when `lookup` has the fetched one for the remote address, an address that is not remote as it is. A
 * <source> whose picture is not there (not fetched yet, blocked) is dropped: the webview would pick it for its media and the frame's CSP (img-src data:) would break the picture.
 */
export function settleSources(root: ParentNode, lookup: (remote: string) => string | null | undefined): void {
  root.querySelectorAll("picture > source").forEach((s) => {
    if (!isSchemeSource(s)) return s.remove(); // any other <source> (a width or a format choice) is dropped, as the <img> alone is what is fetched and shown
    const first = firstSrcsetUrl(s.getAttribute("srcset")) || (s.getAttribute("data-hl-srcset") ?? "");
    const remote = remoteUrl(first);
    const addr = remote ? lookup(remote) || lookup(first) || "" : first;
    s.removeAttribute("sizes");
    if (addr) {
      s.setAttribute("srcset", addr);
      s.removeAttribute("data-hl-srcset");
    } else if (remote && remote.length <= 4096) {
      // not fetched yet / pictures not shown: the <source> stays WITHOUT a srcset (the webview ignores it and asks for nothing) and keeps its address for the fetch that comes with the picture
      s.removeAttribute("srcset");
      s.setAttribute("data-hl-srcset", remote);
    } else s.remove();
  });
}

/** Makes every <img> below `root` show only its src: no srcset / sizes. An <img> without src gets the first candidate of its srcset as src. (The <source>s: `settleSources`.) */
export function dropSrcsets(root: ParentNode): void {
  root.querySelectorAll("img[srcset], img[sizes]").forEach((i) => {
    if (!(i.getAttribute("src") ?? "").trim()) {
      const first = firstSrcsetUrl(i.getAttribute("srcset"));
      if (first) i.setAttribute("src", first);
    }
    dropSrcset(i);
  });
}
