// The probe of the message list header (1.0.8: the mailbox name sits on a line of its own ABOVE the Focused / Other tabs or the folder title).
// `LIST_HEAD_JS` is an expression for `evaluate` (the test bridge's `eval` of a QA session on macOS / Linux runs it as it is): it prints JSON with the boxes of the
// header parts, so the pass criteria are numbers. `headVerdict(p, want)` turns one probe result into the list of problems (empty = pass).
//   acct      the account line (.ml-acct): null when there is none
//   row       the title row (.ml-title: the tabs or the folder title, and the Filter)
//   gap       px between the bottom of the name's text and the top of the text of the row's first control (tab label / folder title): what the eye sees, padding included
//   acctCut   the name is cut with an ellipsis (scrollWidth > clientWidth)
//   filterTop top of the Filter button (it stays on the tabs row at the right, or on a line below the tabs)
export const LIST_HEAD_JS = `(() => {
  const list = document.querySelector('.msg-list'), head = list.querySelector('.ml-head');
  const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  const acctEl = head.querySelector('.ml-acct'), row = head.querySelector('.ml-title');
  const first = row && (row.querySelector('.pivots [role=tab]') || row.querySelector('h2'));
  const tabs = [...head.querySelectorAll('.pivots [role=tab]')];
  const filter = row && row.querySelector('.ml-tools .dd > button');
  const textBottom = acctEl ? (() => { const r = document.createRange(); r.selectNodeContents(acctEl); return r.getBoundingClientRect().bottom; })() : null;
  const firstText = first ? (() => { const r = document.createRange(); r.selectNodeContents(first); const b = r.getBoundingClientRect(); return b.top; })() : null;
  const lb = box(list), hb = box(head), ab = box(acctEl), rb = box(row), fb = box(first), flb = box(filter);
  const active = head.querySelector('.pivots [role=tab].active');
  const underline = active ? (() => { const r = active.getBoundingClientRect(); return { bottom: r.bottom, borderBottom: getComputedStyle(active).borderBottomWidth }; })() : null;
  return JSON.stringify({
    lang: document.documentElement.lang, theme: document.documentElement.getAttribute('data-theme'), listW: Math.round(lb.width),
    acct: ab && { text: acctEl.textContent.trim(), title: acctEl.title || null, top: ab.top, bottom: ab.bottom, left: ab.left, right: ab.right, height: ab.height, font: getComputedStyle(acctEl).fontSize, color: getComputedStyle(acctEl).color, overflow: getComputedStyle(acctEl).textOverflow, ws: getComputedStyle(acctEl).whiteSpace },
    acctCut: !!acctEl && acctEl.scrollWidth > acctEl.clientWidth + 0.5,
    row: rb, firstTop: fb && fb.top, gap: ab && fb ? firstText - textBottom : null,
    tabs: tabs.map((t) => { const b = box(t); return { name: t.textContent.trim(), top: b.top, bottom: b.bottom, left: b.left, right: b.right }; }),
    h2: row && row.querySelector('h2') ? row.querySelector('h2').textContent.trim() : null,
    filter: flb && { top: flb.top, bottom: flb.bottom, left: flb.left, right: flb.right },
    head: hb, headH: Math.round(hb.height * 10) / 10, headScrollX: head.scrollWidth > head.clientWidth + 1, rowScrollX: row ? row.scrollWidth > row.clientWidth + 1 : false,
    listLeft: lb.left, listRight: lb.right, underline, acctVisible: !!acctEl && getComputedStyle(acctEl).visibility !== 'hidden',
    sub: !!head.querySelector('.ml-sub'),
  });
})()`;

/**
 * Pass criteria on one probe result. `want`: { acct: expected text (or null when the view has none, e.g. all mailboxes / a search), tabs: true when the
 * Focused / Other tabs are expected (else the folder title h2), minGap: smallest px between the name's text and the text of the tabs / title (default 8) }.
 * The numbers: the name's box is above the row (bottom <= the row's first control top), inside the header and the list, never overlaps a tab or
 * the Filter, the line is 14 to 22 px tall (one line), and the header does not scroll sideways.
 */
export function headVerdict(p, want) {
  const bad = [];
  const minGap = want.minGap ?? 8;
  if (want.acct === null) {
    if (p.acct) bad.push(`an account line shows ("${p.acct.text}") where there should be none`);
  } else {
    if (!p.acct) return [...bad, 'no account line (.ml-acct)'];
    if (want.acct !== undefined && p.acct.text !== want.acct) bad.push(`account text "${p.acct.text}", wanted "${want.acct}"`);
    if (p.firstTop === null) bad.push('no tabs / title row');
    else {
      if (p.gap < minGap) bad.push(`the name text is ${p.gap.toFixed(1)} px above the tabs / title text (minimum ${minGap})`);
      if (p.acct.bottom > p.firstTop) bad.push('the name overlaps the tabs / title');
      for (const t of p.tabs) if (p.acct.bottom > t.top) bad.push(`the name overlaps the tab ${t.name}`);
      if (p.filter && p.acct.bottom > p.filter.top) bad.push('the name overlaps the Filter');
    }
    if (p.acct.top < p.head.top - 0.5) bad.push('the name starts above the header');
    if (p.acct.right > p.listRight + 0.5 || p.acct.left < p.listLeft - 0.5) bad.push('the name leaves the list');
    if (p.acct.height < 14 || p.acct.height > 22) bad.push(`the name line is ${p.acct.height.toFixed(1)} px tall (one line = 14 to 22)`);
    if (p.acct.overflow !== 'ellipsis' || p.acct.ws !== 'nowrap') bad.push(`the name is not cut with an ellipsis (${p.acct.overflow}, ${p.acct.ws})`);
    if (p.acctCut && !p.acct.title) bad.push('a cut name has no tooltip');
    if (p.sub) bad.push('the old line under the title (.ml-sub) is still there');
  }
  if (want.tabs === true && p.tabs.length !== 2) bad.push(`${p.tabs.length} tabs, wanted 2`);
  if (want.tabs === false && (p.tabs.length || !p.h2)) bad.push('tabs where the folder title should be');
  if (p.filter) {
    if (p.tabs.length === 2 && !(p.filter.top < p.tabs[0].bottom && p.filter.bottom > p.tabs[0].top) && p.filter.top < p.tabs[0].bottom - 1) bad.push('the Filter is neither on the tabs row nor below it');
    if (p.filter.right > p.listRight + 0.5) bad.push('the Filter leaves the list');
  }
  if (p.headScrollX || p.rowScrollX) bad.push('the header scrolls sideways');
  return bad;
}
