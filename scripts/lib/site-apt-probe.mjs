// The measurement of the "Install with APT" block of the download page (WP15, <details id="apt"> in #card-linux). One expression, DOM calls only:
// opens the block, measures it and returns { bad: [problems], info: {...} }. Used by scripts/test-site-appearance.mjs (--only=apt, Chrome) and meant to be
// pasted into the console of Safari (macOS) or of any WebKit browser on Linux (QA: webkit-checks-107.md WK-15.2), so it must not need anything from a test.
// Pass criteria (numbers): the page never scrolls sideways (documentElement.scrollWidth <= innerWidth); five copy boxes; each command box (the <code>) and
// its Copy button lie inside the card, and the box shows the end of the command by scrolling inside itself (overflow-x), never by widening the page; each
// Copy button is at least 24 x 24 px; the summary is at most 3 lines; no paragraph of the block is wider than its box; the fingerprint is 10 groups of 4.
export const APT_PROBE = `(() => {
  const bad = [];
  const apt = document.getElementById('apt');
  if (!apt) return { bad: ['no <details id="apt">'], info: {} };
  apt.open = true;
  const de = document.documentElement, R = (e) => e.getBoundingClientRect();
  const card = R(document.getElementById('card-linux'));
  if (de.scrollWidth > innerWidth) bad.push('the page scrolls sideways (' + de.scrollWidth + ' > ' + innerWidth + ')');
  const boxes = [...apt.querySelectorAll('.copy')];
  if (boxes.length !== 5) bad.push('expected 5 copy boxes, found ' + boxes.length);
  const inside = (r) => r.left >= card.left - 0.5 && r.right <= card.right + 0.5;
  const scrolls = [];
  boxes.forEach((b, i) => {
    const code = b.querySelector('code'), btn = b.querySelector('button');
    const c = R(code), k = R(btn);
    if (!inside(c)) bad.push('box ' + (i + 1) + ': the command box leaves the card (' + c.left.toFixed(1) + '..' + c.right.toFixed(1) + ' of ' + card.left.toFixed(1) + '..' + card.right.toFixed(1) + ')');
    if (!inside(k)) bad.push('box ' + (i + 1) + ': the Copy button leaves the card');
    if (k.width < 24 || k.height < 24) bad.push('box ' + (i + 1) + ': the Copy button is ' + k.width.toFixed(1) + ' x ' + k.height.toFixed(1) + ' px, at least 24 x 24');
    if (getComputedStyle(code).overflowX !== 'auto') bad.push('box ' + (i + 1) + ': the command box does not scroll inside itself (overflow-x ' + getComputedStyle(code).overflowX + ')');
    scrolls.push(code.scrollWidth - code.clientWidth);
  });
  const s = R(apt.querySelector('summary')), sp = parseFloat(getComputedStyle(apt.querySelector('summary')).lineHeight) || parseFloat(getComputedStyle(apt.querySelector('summary')).fontSize) * 1.3;
  if (s.height > sp * 3 + 8) bad.push('the summary takes ' + s.height.toFixed(1) + ' px, more than three lines');
  for (const p of apt.querySelectorAll('p')) if (p.scrollWidth > p.clientWidth + 1) bad.push('a paragraph is wider than its box: ' + p.textContent.slice(0, 40));
  const fp = [...apt.querySelectorAll('p code')].map((c) => c.textContent.trim()).find((t) => /^([0-9A-F]{4} ){9}[0-9A-F]{4}$/.test(t));
  if (!fp) bad.push('no fingerprint of 10 groups of 4 hex digits');
  const fpEl = [...apt.querySelectorAll('p code')].find((c) => c.textContent.trim() === fp);
  if (fpEl && !inside(R(fpEl))) bad.push('the fingerprint leaves the card');
  return {
    bad,
    info: {
      pageScrollWidth: de.scrollWidth, innerWidth, card: [card.left, card.right].map((n) => Math.round(n)), summaryHeight: Math.round(s.height),
      commandScroll: scrolls.map((n) => Math.max(0, Math.round(n))), copyButtons: boxes.map((b) => { const k = R(b.querySelector('button')); return [Math.round(k.width), Math.round(k.height)]; }),
      bodyFont: getComputedStyle(document.body).fontFamily, codeFont: boxes[0] ? getComputedStyle(boxes[0].querySelector('code')).fontFamily : null,
      fingerprintLines: fpEl ? Math.round(R(fpEl).height / (parseFloat(getComputedStyle(fpEl).lineHeight) || parseFloat(getComputedStyle(fpEl).fontSize) * 1.3)) : null,
    },
  };
})()`;
