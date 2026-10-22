// Measures, in the page, the frame that shows a mail in the reading pane (or the reader window): which classes the mail document has, whether anything hides it,
// whether it is still loading, and for every element that has text of its own the colour of the text, what it sits on and the contrast between them (1.0.7 D-052,
// scripts/test-reader-dark.mjs; WebKit rows WK-F7.01 / .02 in webkit-checks-107.md). DOM only; nothing is added to the page.
//
// `darkFrameProbe(base)` is an expression that evaluates to a JSON string, so it runs through a CDP `Runtime.evaluate` and through the test bridge's `/eval` alike
// (scripts/test-bridge.md). `base` is the colour the frame sits on: [27, 28, 32] for the dark background, [255, 255, 255] for the original one.
//   node scripts/lib/dark-frame-probe.mjs            prints the expression for the dark background (paste it into a console)
//   node scripts/lib/dark-frame-probe.mjs original   the same for the original background
//
// The answer (`null` when no mail frame is there yet): { cls (class of <html> in the frame: "hm-dark" = recoloured, "hm-pend" = hidden until it is), bodyVis (computed
// visibility of its body), bodyBg, bodyColor, rs (the frame document's readyState), text (characters of visible text), sheets (style elements), hmAttr (elements that
// carry a recolouring), n (elements with text), min (the lowest text contrast), rows: [[element, colour, background, contrast], ...] }
export const darkFrameProbe = (base = [27, 28, 32]) => `(() => {
  const f = document.querySelector('.msg-frame'); const d = f && f.contentDocument;
  if (!d || !d.body || !d.documentElement.hasAttribute('data-hm-doc')) return 'null';
  const w = d.defaultView, base = ${JSON.stringify(base)};
  const parse = (s) => { const m = /rgba?\\(([^)]+)\\)/.exec(s); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const over = (c, b) => [c[0] * c[3] + b[0] * (1 - c[3]), c[1] * c[3] + b[1] * (1 - c[3]), c[2] * c[3] + b[2] * (1 - c[3])];
  const rows = [];
  for (const el of d.body.querySelectorAll('*')) {
    if (!Array.from(el.childNodes).some((n) => n.nodeType === 3 && /\\S/.test(n.textContent))) continue;
    const cs = w.getComputedStyle(el); if (cs.display === 'none') continue;
    const chain = []; for (let e = el; e; e = e.parentElement) chain.unshift(e);
    let bg = base; for (const e of chain) { const c = parse(w.getComputedStyle(e).backgroundColor); if (c && c[3] > 0) bg = over(c, bg); }
    const fg = parse(cs.color); const seen = fg[3] < 1 ? over(fg, bg) : fg;
    rows.push([el.localName + (el.className ? '.' + el.className : ''), cs.color, 'rgb(' + bg.map(Math.round).join(',') + ')', Math.round(ratio(seen, bg) * 100) / 100]);
  }
  const bodyCs = w.getComputedStyle(d.body);
  return JSON.stringify({ cls: d.documentElement.className, bodyVis: bodyCs.visibility, bodyBg: bodyCs.backgroundColor, bodyColor: bodyCs.color, rs: d.readyState, text: d.body.innerText.length, sheets: d.querySelectorAll('style').length,
    min: rows.length ? Math.min(...rows.map((r) => r[3])) : null, n: rows.length, rows, hmAttr: d.querySelectorAll('[data-hm]').length });
})()`;

if (process.argv[1] && process.argv[1].endsWith('dark-frame-probe.mjs')) console.log(darkFrameProbe(process.argv[2] === 'original' ? [255, 255, 255] : [27, 28, 32]));
