// Measures, in the page, the pictures of the quoted original in the compose pane (1.0.8 reply-images, test-reply-images.mjs; the WebKit rows WK-RI.* in webkit-checks-107.md). DOM only: it needs
// the quote block of a Reply / Reply all / Forward on screen (`.compose-pane .quote-host`, a shadow tree).
//
// `QUOTE_PROBE_JS` is an expression: it evaluates to a JSON string, so it runs through a CDP `Runtime.evaluate` and through the test bridge's `/eval` alike (`scripts/test-bridge.md`).
//
// The result: { found, imgs, boxes, note, load, external, host, engine }
//   imgs[i]:  a picture the quote shows: { data (its src is a data: copy), loaded (decoded: naturalWidth > 0), nw (naturalWidth), w, h (drawn size, px), over (it is wider than the quote) }
//   boxes[i]: a picture that is not shown (a box of the reading pane's look): { alt (its text), w, h (px), pending (the fetch is on its way), icon (the box's icon has a background image),
//             clipped (the alt text is cut by an ellipsis: scrollWidth > clientWidth) }
//   note:     the text of the note above the quote (null when it is hidden); load: the note has a "Load content" button
//   external: how many elements of the quote hold an http(s) address (must be 0: the webview never requests a picture of the original itself)
//   host:     { w, scrollW } the quote's own width and the width of its content (scrollW > w + 1: the quote scrolls sideways)
//   engine:   { closest, attachShadow, replaceWith } (the functions the quote's script needs)
export const QUOTE_PROBE_JS = `(() => {
  const host = document.querySelector('.compose-pane .quote-host');
  const root = host && host.shadowRoot;
  if (!root) return JSON.stringify({ found: false });
  const q = root.querySelector('.q');
  const note = document.querySelector('.compose-pane .quote-note');
  const rect = (e) => e.getBoundingClientRect();
  return JSON.stringify({
    found: true,
    imgs: [...root.querySelectorAll('img')].map((i) => ({ data: (i.getAttribute('src') || '').startsWith('data:'), loaded: i.complete && i.naturalWidth > 0, nw: i.naturalWidth, w: Math.round(rect(i).width), h: Math.round(rect(i).height), over: rect(i).right > rect(q).right + 1 })),
    boxes: [...root.querySelectorAll('.hl-bp')].map((b) => {
      const alt = b.querySelector('.hl-bp-alt');
      const ico = b.querySelector('.hl-bp-ico');
      return { alt: b.textContent, w: Math.round(rect(b).width), h: Math.round(rect(b).height), pending: b.hasAttribute('data-pending'), icon: !!ico && getComputedStyle(ico).backgroundImage.startsWith('url('), clipped: !!alt && alt.scrollWidth > alt.clientWidth + 1 };
    }),
    note: note && !note.hidden ? note.textContent.replace(/\\s+/g, ' ').trim() : null,
    load: !!(note && note.querySelector('button[data-act="load"]')),
    external: [...root.querySelectorAll('[src]')].filter((e) => /^https?:/i.test(e.getAttribute('src'))).length,
    host: { w: Math.round(rect(q).width), scrollW: q.scrollWidth },
    engine: { closest: typeof Element.prototype.closest, attachShadow: typeof Element.prototype.attachShadow, replaceWith: typeof Element.prototype.replaceWith },
  });
})()`;


if (process.argv[1]?.endsWith("reply-images-probe.mjs")) console.log(QUOTE_PROBE_JS);
