// The measurement of the website's Support page (docs/support.html and its 7 translations), as one JavaScript expression that runs inside the page.
// Used by scripts/test-site-appearance.mjs (headless Chrome) and meant for any other browser too (Safari / WKWebView on a Mac, WebKitGTK on Linux):
//
//   node scripts/lib/site-support-probe.mjs        prints the expression; paste it into the web inspector's console on the Support page, in any language
//
// It returns plain JSON: the numbers measured (columns, tops, widths, the lowest contrast) and `bad`, the list of broken rules (empty = the page is as designed):
//   - the page does not scroll sideways; no text box is cut (scrollWidth <= clientWidth + 1); nothing sticks out of <main>
//   - .support-top has 2 columns above 1020 px, 1 below; .more-ways has 4 columns above 1020 px, 2 up to 720 px, 1 below; there are four cards
//   - above 1020 px the letter and the coffee card start at the same height (1 px) and the four card links are on one line (1 px)
//   - up to 480 px the coffee buttons are full width; from 481 to 1020 px they sit in one row when they fit
//   - the Ko-fi button is at least 44 px high; the text a person reads has at least 4.5:1 contrast with the background it sits on
// Engine features the page relies on: CSS grid with minmax(0, 1fr), flex, color-mix() (the dark accent colours; a browser without it shows the plain colours), `hyphens: auto` (with -webkit-).
export const SUPPORT_PROBE = `(() => {
  const bad = [], de = document.documentElement, q = (s) => document.querySelector(s), R = (e) => e.getBoundingClientRect();
  const cols = (s) => { const e = q(s); return e ? getComputedStyle(e).gridTemplateColumns.split(' ').filter(Boolean).length : 0; };
  const w = de.clientWidth, want = { top: w > 1020 ? 2 : 1, more: w > 1020 ? 4 : w > 720 ? 2 : 1 };
  const m = { width: w, scrollWidth: de.scrollWidth, topCols: cols('.support-top'), moreCols: cols('.more-ways'), cards: document.querySelectorAll('.more-ways li').length };
  if (de.scrollWidth > de.clientWidth + 1) bad.push('the page scrolls sideways (' + de.scrollWidth + ' > ' + de.clientWidth + ')');
  if (m.topCols !== want.top) bad.push('.support-top has ' + m.topCols + ' columns at ' + w + ' px, expected ' + want.top);
  if (m.moreCols !== want.more) bad.push('.more-ways has ' + m.moreCols + ' columns at ' + w + ' px, expected ' + want.more);
  if (m.cards !== 4) bad.push('not four cards');
  m.cut = 0;
  for (const e of document.querySelectorAll('main *')) {
    if (e.closest('svg') || !e.clientWidth) continue; // (inline text has no box of its own: its block parent is measured)
    if (e.scrollWidth > e.clientWidth + 1) { m.cut++; bad.push('<' + e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? ' class="' + e.className + '"' : '') + '> is cut: ' + e.scrollWidth + ' > ' + e.clientWidth + ' ("' + (e.textContent || '').trim().slice(0, 30) + '")'); }
  }
  const main = R(q('main')); m.outside = 0;
  for (const e of document.querySelectorAll('.support-top > *, .more-ways li, .support .btn, .help-pointer')) { const b = R(e); if (b.right > main.right + 1 || b.left < main.left - 1) { m.outside++; bad.push('<' + e.tagName.toLowerCase() + ' class="' + e.className + '"> sticks out of the page'); } }
  const a = R(q('.letter')), k = R(q('.way.kofi'));
  m.letter = [Math.round(a.left), Math.round(a.top), Math.round(a.width), Math.round(a.height)]; m.coffee = [Math.round(k.left), Math.round(k.top), Math.round(k.width), Math.round(k.height)];
  const tops = [...document.querySelectorAll('.more-ways .go a')].map((e) => R(e).top); m.linkTopSpread = +(Math.max(...tops) - Math.min(...tops)).toFixed(1);
  m.cardHeights = [...document.querySelectorAll('.more-ways li')].map((e) => Math.round(R(e).height)); m.h3Lines = [...document.querySelectorAll('.more-ways h3')].map((e) => Math.round(R(e).height / parseFloat(getComputedStyle(e).lineHeight)));
  if (w > 1020) {
    if (Math.abs(a.top - k.top) > 1) bad.push('letter and coffee card tops differ by ' + Math.abs(a.top - k.top).toFixed(1) + ' px');
    if (m.linkTopSpread > 1) bad.push('the card links are not on one line: ' + tops.map((t) => t.toFixed(0)).join(','));
  }
  const bs = [...document.querySelectorAll('.kofi .btn-row .btn')].filter((e) => R(e).height); m.buttons = bs.map((e) => [Math.round(R(e).width), Math.round(R(e).height)]);
  if (w <= 480) { for (const e of bs) if (R(e).width < k.width - 60) bad.push('the coffee buttons are not full width at ' + w + ' px (' + R(e).width.toFixed(0) + ')'); }
  else if (w <= 1020 && bs.length === 2 && R(bs[1]).top >= R(bs[0]).bottom - 1 && R(bs[0]).width + R(bs[1]).width + 10 < k.width - 44) bad.push('the coffee buttons wrap although they would fit in one row');
  const kofi = q('#kofi-link'); if (!kofi || R(kofi).height < 44) bad.push('the Ko-fi button is smaller than 44 px');
  // contrast of the text a person reads (WCAG 2.x), against the first opaque background above it
  const rgba = (c) => { const n = c.match(/-?[\\d.]+/g).map(Number); return c.startsWith('color(') ? [n[0] * 255, n[1] * 255, n[2] * 255, n[3] ?? 1] : [n[0], n[1], n[2], n[3] ?? 1]; };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const bg = (e) => { for (; e; e = e.parentElement) { const c = rgba(getComputedStyle(e).backgroundColor); if (c[3] > 0.99) return c; } return [255, 255, 255, 1]; };
  m.contrast = {};
  for (const sel of ['.letter p:not(.sign)', '.letter h2', '.way h2', '.way > p', '.more-lead', '.more-ways h3', '.more-ways li > p:not(.go)', '.more-ways .go a', '.help-pointer', '.help-pointer a', '.fine-s']) {
    const e = q(sel); if (!e) { bad.push('no element for ' + sel); continue; }
    const f = rgba(getComputedStyle(e).color), b = bg(e), l1 = lum(f), l2 = lum(b), ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    m.contrast[sel] = +ratio.toFixed(2);
    if (ratio < 4.5) bad.push('contrast ' + ratio.toFixed(2) + ':1 for ' + sel);
  }
  m.minContrast = Math.min(...Object.values(m.contrast));
  m.bad = bad;
  return m;
})()`;

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('lib/site-support-probe.mjs')) console.log(SUPPORT_PROBE);
