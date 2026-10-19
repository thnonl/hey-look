// A body with pictures in it (the 14 pictures of a 19 MB draft: 25 million characters of base64) is read by several steps before the editor has it (the base font box, the
// quoted original, the signature region: some parse the whole text with the browser's HTML parser and write it out again). None of them looks at a picture, so they are given
// the body without the picture data and the data goes back afterwards (1.0.7 D-044: those steps were 0.4 s of the 2 s of opening that draft).

/** A picture of less than this many characters is left where it is (a small one costs nothing, and a signature's logo stays readable to the steps that look at it). */
const MIN = 2000;

/**
 * `html` with the base64 data of every `data:` picture source longer than `MIN` characters replaced by a short marker, and the way back: `restore` puts the data into any
 * text that was made from the shortened one (the markers are kept by the steps above: they are inside an attribute value and look like nothing else).
 */
export function detachPictures(html: string): { html: string; restore: (text: string) => string } {
  const found: { data: string }[] = [];
  let out = "";
  let last = 0;
  for (let at = html.indexOf(";base64,"); at >= 0; at = html.indexOf(";base64,", at)) {
    const from = at + 8;
    const start = html.lastIndexOf("data:", at);
    const quote = start > 0 ? html[start - 1] : "";
    if (start < 0 || at - start > 100 || (quote !== '"' && quote !== "'")) {
      at = from;
      continue;
    }
    const end = html.indexOf(quote, from);
    if (end < 0 || end - from < MIN) {
      at = from;
      continue;
    }
    out += html.slice(last, from) + `hl-detached-${found.length}-end`;
    found.push({ data: html.slice(from, end) });
    last = end;
    at = end;
  }
  if (!found.length) return { html, restore: (text) => text };
  out += html.slice(last);
  // (one pass: a copy of the text for each of the markers would copy the 25 MB once per picture)
  return { html: out, restore: (text) => text.replace(/hl-detached-(\d+)-end/g, (m, n: string) => found[Number(n)]?.data ?? m) };
}
