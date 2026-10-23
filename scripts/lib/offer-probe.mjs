// Measures, in the page, the offer "Also show the {service} calendars of {email} here?" of the Calendar side menu (1.0.7 fix18 D-066, test-calendar-at-signin.mjs;
// the WebKit rows WK-F18.* in webkit-checks-107.md). DOM only: it needs the offer on screen (`.cal-offer`), measures COPIES of it inside hidden boxes of a given width
// that it adds to the offer's parent and removes again, so nothing is changed for good and no side-menu width has to be set with the mouse.
//
// `OFFER_JS` is an expression: it evaluates to a JSON string, so it runs through a CDP `Runtime.evaluate` and through the test bridge's `/eval` alike (`scripts/test-bridge.md`).
//
// The result: { found, lang, font (computed font family of the notice), fontSize, lineHeight, text (the live notice), live: { width, lines }, rows: [...] }
//   rows[i]: { w (box width in px: 248 is the default side menu, 180 the narrowest), email ('real' = the mailbox's own address, 'long' = a 52 character one), lines (the notice's
//              content height / its line height, rounded), over (scrollWidth - clientWidth of the notice), inside (the notice and both buttons lie inside the box),
//              buttons (how many link buttons), emailLines, emailCut (the address ends in an ellipsis), emailTitleOk (title = the whole address), emailNowrap }
// `verdict(p)` lists what breaks the pass criteria of DEC-021 (empty = pass): at most 4 lines at 248 px, nothing clipped sideways and both buttons reachable at 248 and 180 px,
// the address is one line with the whole address as its title.
export const LONG_ADDRESS = "a.very.long.address.for.testing@example-company.com";

export const OFFER_JS = `(() => {
  const n = document.querySelector('.cal-offer');
  if (!n) return JSON.stringify({ found: false });
  const LONG = ${JSON.stringify(LONG_ADDRESS)};
  const parent = n.parentElement;
  const cs0 = getComputedStyle(n);
  const lhOf = (el) => { const cs = getComputedStyle(el); return parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4; };
  const measure = (w, long) => {
    const box = document.createElement('div');
    box.style.cssText = 'width:' + w + 'px;box-sizing:border-box;position:absolute;visibility:hidden;left:0;top:0';
    const c = n.cloneNode(true);
    const em = c.querySelector('.cal-email');
    const whole = long ? LONG : em ? em.textContent : '';
    if (long && em) { em.textContent = LONG; em.setAttribute('title', LONG); }
    box.appendChild(c);
    parent.appendChild(box);
    const cs = getComputedStyle(c), lh = lhOf(c);
    const r = c.getBoundingClientRect(), b = box.getBoundingClientRect();
    const btns = [...c.querySelectorAll('button.link')];
    const inB = (x) => x.left >= b.left - 1 && x.right <= b.right + 1 && x.width > 0;
    const o = {
      w, email: long ? 'long' : 'real',
      lines: Math.round((r.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / lh),
      over: c.scrollWidth - c.clientWidth,
      inside: inB(r) && btns.every((x) => inB(x.getBoundingClientRect())),
      buttons: btns.length,
    };
    if (em) {
      const ecs = getComputedStyle(em), er = em.getBoundingClientRect();
      o.emailLines = Math.round(er.height / lhOf(em));
      o.emailCut = em.scrollWidth > em.clientWidth;
      o.emailTitleOk = em.getAttribute('title') === whole && em.textContent === whole;
      o.emailNowrap = ecs.whiteSpace === 'nowrap' && ecs.textOverflow === 'ellipsis' && ecs.overflow === 'hidden';
    }
    box.remove();
    return o;
  };
  const rows = [];
  for (const w of [248, 180]) for (const long of [false, true]) rows.push(measure(w, long));
  const lr = n.getBoundingClientRect();
  return JSON.stringify({
    found: true, lang: document.documentElement.lang, font: cs0.fontFamily, fontSize: cs0.fontSize, lineHeight: cs0.lineHeight,
    text: n.textContent.replace(/\\s+/g, ' ').trim(), live: { width: Math.round(lr.width), lines: Math.round((lr.height - parseFloat(cs0.paddingTop) - parseFloat(cs0.paddingBottom)) / lhOf(n)) }, rows,
  });
})()`;

/** The problems against the pass criteria (empty = pass). */
export function verdict(p) {
  const bad = [];
  if (!p || !p.found) return ['no offer on screen'];
  for (const r of p.rows) {
    const tag = `${r.w}px ${r.email}`;
    if (r.w === 248 && r.lines > 4) bad.push(`${tag}: ${r.lines} lines (at most 4)`);
    if (r.over > 1) bad.push(`${tag}: clipped sideways by ${r.over} px`);
    if (!r.inside) bad.push(`${tag}: the notice or a button is outside the box`);
    if (r.buttons !== 2) bad.push(`${tag}: ${r.buttons} buttons (2)`);
    if (r.emailLines !== 1) bad.push(`${tag}: the address takes ${r.emailLines} lines (1)`);
    if (!r.emailTitleOk) bad.push(`${tag}: the title is not the whole address`);
    if (!r.emailNowrap) bad.push(`${tag}: the address element is not nowrap + ellipsis + hidden`);
    if (r.email === 'long' && !r.emailCut) bad.push(`${tag}: the long address is not cut (an ellipsis is expected)`);
  }
  return bad;
}
