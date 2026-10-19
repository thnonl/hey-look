// Measures, in the page, the unread numbers on the Focused / Other tabs of the message list (1.0.7 W13.12, test-focus-tabs.mjs; WebKit rows WK-13.06 / WK-13.08
// in webkit-checks-107.md). DOM only; nothing is added to the page for good (the width test adds and removes one hidden span inside a tab).
//
// `TABN_JS` is an expression: it evaluates to a JSON string, so it runs through a CDP `Runtime.evaluate` and through the test bridge's `/eval` alike
// (`scripts/test-bridge.md`). The baseline of a text is measured, not guessed: the box of a character (Range.getClientRects) is the font's content area, so
// its bottom edge minus the font's descent (a canvas with the same font reports it) is the baseline of that text, whatever the line height around it is.
//
// The result: { lang, theme, width, height, listW, rowOk, headOk, filterText, filterTitle, filterAria, filterIcon, filterClipped, strongColor, mutedColor, listBg, tabs: [...] }
//   tabs[i]: name (aria-label or text), title, badge (text or null), clipped, labelLines, offset (px, badge baseline minus label baseline), sameLine,
//            color, weight, fvn, family, ratio (badge font size / tab font size), tabular (digits 1 and 8 take the same width), inside (inside the list box), top, bottom
//   tabsOk   both tabs lie in one row; rowOk: the Filter button lies in that row too; filterBelow: it has a line of its own under them (the last resort, see MessageList.tsx)
//   headOk   the header row (.ml-title) does not scroll sideways
//   filterIcon  the Filter shows as its icon only; then filterTitle (and the accessible name) must be the full text
//   strongColor / mutedColor  colour of the side menu's Inbox number and Junk number (a plain copy of .fp-badge.strong / .fp-badge); Focused must have the first, Other the second
export const TABN_JS = `(() => {
  const list = document.querySelector('.msg-list');
  const tabs = [...list.querySelectorAll('.pivots [role=tab]')];
  const ctx = document.createElement('canvas').getContext('2d');
  const desc = (el) => { const cs = getComputedStyle(el); ctx.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily; return ctx.measureText('0').fontBoundingBoxDescent; };
  const textIn = (root, skipBadge) => { const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) if (n.data.trim() && !(skipBadge && n.parentElement.closest('.fp-badge'))) return n; return null; };
  const rangeOf = (n) => { const r = document.createRange(); r.selectNodeContents(n); return r; };
  const baseOf = (n) => { const r = document.createRange(); r.setStart(n, 0); r.setEnd(n, 1); return r.getBoundingClientRect().bottom - desc(n.parentElement); };
  const lb = list.getBoundingClientRect();
  const out = tabs.map((t) => {
    const label = textIn(t, true), badge = t.querySelector('.fp-badge'), bt = badge && textIn(badge, false);
    const tr = t.getBoundingClientRect();
    const o = { name: t.getAttribute('aria-label') || t.textContent.trim(), title: t.title, badge: badge ? badge.textContent : null, clipped: t.scrollWidth > t.clientWidth + 1, top: tr.top, bottom: tr.bottom, left: tr.left, right: tr.right };
    if (label) { const rs = [...rangeOf(label).getClientRects()]; o.labelLines = new Set(rs.map((x) => Math.round(x.top))).size; o.labelRect = rs[0] && { top: rs[0].top, bottom: rs[0].bottom }; }
    if (badge && bt && label) {
      const cs = getComputedStyle(badge), bb = badge.getBoundingClientRect();
      o.offset = +(baseOf(bt) - baseOf(label)).toFixed(2);
      o.sameLine = !!o.labelRect && bb.top < o.labelRect.bottom && bb.bottom > o.labelRect.top;
      o.color = cs.color; o.weight = cs.fontWeight; o.fvn = cs.fontVariantNumeric; o.family = cs.fontFamily;
      o.ratio = +(parseFloat(cs.fontSize) / parseFloat(getComputedStyle(t).fontSize)).toFixed(2);
      const s = document.createElement('span'); s.className = badge.className; s.style.position = 'absolute'; s.style.visibility = 'hidden'; t.appendChild(s);
      s.textContent = '111'; const w1 = s.getBoundingClientRect().width; s.textContent = '888'; const w8 = s.getBoundingClientRect().width; s.remove();
      o.tabular = Math.abs(w1 - w8) <= 0.5;
      o.inside = bb.left >= lb.left - 0.5 && bb.right <= lb.right + 0.5;
    }
    return o;
  });
  const filter = list.querySelector('.ml-tools .dd > button');
  const fr = filter && filter.getBoundingClientRect();
  const row = list.querySelector('.ml-title');
  const tabsOk = out.length === 2 && Math.abs(out[0].top - out[1].top) < 1;
  const sameRow = tabsOk && !!fr && fr.top < out[0].bottom && fr.bottom > out[0].top;
  const below = tabsOk && !!fr && fr.top >= out[0].bottom - 1; // the last resort: even the icon does not fit beside the tabs, the button has a line of its own
  const textEl = filter && filter.querySelector('.ml-filter-text');
  const iconOnly = !!list.querySelector('.ml-tools.icon-only');
  // the colours of the side menu's numbers (Inbox = .fp-badge.strong, Junk = .fp-badge), read from a plain copy: in the icon column the real ones are pills
  const colorOf = (cls) => { const s = document.createElement('span'); s.className = cls; s.style.cssText = 'position:absolute;visibility:hidden'; list.querySelector('.ml-head').appendChild(s); const c = getComputedStyle(s).color; s.remove(); return c; };
  const bg = getComputedStyle(list).backgroundColor;
  return JSON.stringify({
    lang: document.documentElement.lang, theme: document.documentElement.getAttribute('data-theme'), width: innerWidth, height: innerHeight, listW: Math.round(lb.width),
    tabsOk, rowOk: sameRow, filterBelow: below, headOk: !!row && row.scrollWidth <= row.clientWidth + 1 && fr && fr.right <= lb.right + 0.5 && fr.left >= lb.left - 0.5,
    filterText: textEl ? textEl.textContent.trim() : null, filterTitle: filter && filter.title, filterAria: filter && filter.getAttribute('aria-label'), filterIcon: iconOnly,
    filterClipped: !iconOnly && textEl ? (textEl.getBoundingClientRect().right > lb.right + 0.5 || filter.scrollWidth > filter.clientWidth + 1) : false,
    strongColor: colorOf('fp-badge strong'), mutedColor: colorOf('fp-badge'), listBg: bg, tabs: out,
  });
})()`;

/** The pass criteria of WK-13.06 on one probe result: the list of problems (empty = pass). `mixed` = the machine under test has both numbers on show. */
export function verdict(p) {
  const bad = [];
  if (p.tabs.length !== 2) bad.push(`${p.tabs.length} tabs (Focused Inbox on, Inbox of a mailbox, no search, nothing ticked?)`);
  if (!p.tabsOk) bad.push('the two tabs are not in one row');
  if (!p.rowOk && !p.filterBelow) bad.push('the Filter is neither in the row of the tabs nor on a line of its own under them');
  if (!p.headOk) bad.push('the header scrolls sideways or the Filter is outside the list');
  if (p.filterIcon && !(p.filterTitle && p.filterTitle === p.filterAria)) bad.push(`icon-only Filter without its full text as tooltip and name (${p.filterTitle} / ${p.filterAria})`);
  if (!p.filterIcon && p.filterClipped) bad.push('the Filter text is clipped');
  for (const t of p.tabs) {
    if (t.clipped) bad.push(`${t.name}: clipped`);
    if (t.labelLines !== 1) bad.push(`${t.name}: label on ${t.labelLines} lines`);
    if (t.badge === null) continue; // a tab at 0 has no number
    if (!(Math.abs(t.offset) <= 1.0)) bad.push(`${t.name}: baseline offset ${t.offset}`);
    if (!t.sameLine) bad.push(`${t.name}: number not on the label's line`);
    if (!t.tabular) bad.push(`${t.name}: digits are not tabular`);
    if (!(Math.abs(t.ratio - 0.86) <= 0.01)) bad.push(`${t.name}: font ratio ${t.ratio}`);
    if (!t.inside) bad.push(`${t.name}: number outside the list`);
  }
  const [f, o] = p.tabs;
  if (f && f.badge !== null && f.color !== p.strongColor) bad.push(`Focused colour ${f.color} is not the Inbox number colour ${p.strongColor}`);
  if (o && o.badge !== null && o.color !== p.mutedColor) bad.push(`Other colour ${o.color} is not the muted colour ${p.mutedColor}`);
  return bad;
}

//   node scripts/lib/tab-number-probe.mjs <data folder | test-bridge.json | port:token> [window=main]
// One bridge call; prints the measurements and the verdict as JSON, exit 1 when there is a problem. Open the Inbox (Focused Inbox on) first.
if (process.argv[1] && process.argv[1].endsWith('tab-number-probe.mjs')) {
  const { bridge, connection } = await import('../test-bridge-client.mjs');
  const [where, win = 'main'] = process.argv.slice(2);
  if (!where) { console.error('usage: node scripts/lib/tab-number-probe.mjs <data folder | test-bridge.json | port:token> [window]'); process.exit(2); }
  const conn = /^\d+:[0-9a-f]{64}$/.test(where) ? { port: Number(where.split(':')[0]), token: where.split(':')[1] } : connection(where);
  const raw = await bridge(conn).evalIn(win, `return ${TABN_JS};`, { timeoutMs: 15000 });
  const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const problems = verdict(p);
  console.log(JSON.stringify({ window: win, ...p, problems, pass: problems.length === 0 }, null, 2));
  process.exit(problems.length === 0 ? 0 : 1);
}
