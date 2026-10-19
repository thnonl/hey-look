// Measures, in the page, where the baseline of an inline link (a `.link` button) sits against the baseline of the sentence it stands in
// (test-notice-baseline.mjs). The text is measured, not guessed: the box of a character (Range.getClientRects) is the font's content area, so its
// bottom edge minus the font's descent (a canvas with the same font reports it) is the baseline of that text, whatever the line-height of the box
// around it is. Nothing is added to the page, so the layout that is measured is the layout the person sees.
//
// `window.__baselines(root)` returns one entry for every `.link` in `root` that has text in front of it in the same block:
//   { label, sameLine, offset, pitch, refPitch, lineH, w, h }
//   offset   baseline of the link minus baseline of the text in front of it, in px (positive: the link is lower), only when both are on one line
//   pitch    when the link starts a new line: distance between the baseline of the text above and the baseline of the link
//   refPitch the distance two lines of plain text of that block have
//   lineH    what the link adds to its line (its margin box, per line of text in it): a link that is part of the line adds no more than a line of plain text
//   w, h     the box that takes the click (px)
export const PROBE_JS = `(() => {
  const ctx = document.createElement('canvas').getContext('2d');
  const descentOf = (el) => { ctx.font = getComputedStyle(el).font; return ctx.measureText('x').fontBoundingBoxDescent; };
  const visibleText = (n) => n.nodeType === 3 && /\\S/.test(n.data);
  const texts = (root) => { const out = []; const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) if (visibleText(n)) out.push(n); return out; };
  // the rectangle of one character, and the baseline of it
  const charRect = (node, i) => { const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + 1); const rs = r.getClientRects(); return rs[rs.length - 1] || r.getBoundingClientRect(); };
  const baseline = (node, i) => { const rc = charRect(node, i); return { y: rc.bottom - descentOf(node.parentElement), top: rc.top, bottom: rc.bottom }; };
  const refPitch = (el) => {
    const d = document.createElement('div');
    d.style.cssText = 'position:absolute;visibility:hidden;left:0;top:0;width:1px;overflow:visible;white-space:normal';
    d.innerHTML = 'x<br>x';
    el.appendChild(d); const h = d.getBoundingClientRect().height / 2; d.remove(); return h;
  };
  window.__baselines = (root) => {
    const out = [];
    for (const link of root.querySelectorAll('.link')) {
      const block = link.closest('.notice, .summary, .sec-strip, .cp-banner, .rp-msg-body, div') || link.parentElement;
      const before = texts(block).filter((n) => !link.contains(n) && (n.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING) && !n.parentElement.closest('.link'));
      const inner = texts(link)[0];
      const label = (link.textContent || '').trim();
      const box = link.getBoundingClientRect();
      const cs = getComputedStyle(link);
      const marginH = box.height + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
      if (!before.length || !inner) { out.push({ label, sameLine: null, offset: null, pitch: null, refPitch: null, lineH: null, w: box.width, h: box.height }); continue; }
      const prev = before[before.length - 1];
      const a = baseline(prev, prev.data.search(/\\S\\s*$/));
      const b = baseline(inner, inner.data.search(/\\S/));
      const sameLine = Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) < Math.min(a.bottom - a.top, b.bottom - b.top) / 2;
      const ref = refPitch(prev.parentElement);
      out.push({ label, sameLine, offset: sameLine ? +(b.y - a.y).toFixed(2) : null, pitch: sameLine ? null : +(b.y - a.y).toFixed(2), refPitch: +ref.toFixed(2), lineH: +(marginH / Math.max(1, Math.round(marginH / ref))).toFixed(2), w: +box.width.toFixed(1), h: +box.height.toFixed(1) });
    }
    return out;
  };
  return 1;
})()`;
