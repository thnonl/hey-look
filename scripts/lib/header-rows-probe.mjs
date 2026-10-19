// The probe of the scrolled header of the compose pane with Meeting on (1.0.7 D-012 / D-003 / D-018, test-header-rows.mjs; WebKit rows WK-F5.01 to WK-F5.03 in
// webkit-checks-107.md). DOM only, nothing is added to the page.
//
// `HEADER_PROBE_BODY` is the body of an async function (`return {...}`): it runs through the test bridge's `/eval` (scripts/test-bridge.md) and, wrapped by the CDP test,
// through `Runtime.evaluate`. Open a message with Meeting on (More actions > Meeting, or a reply / draft that has it), put the focus where the step says, run it:
//   node scripts/lib/header-rows-probe.mjs <data folder | test-bridge.json | port:token> [window=main]
//
// The result: { top, bottom, band, scroll, scrollH, clientH, focus: { name, t, b, hit }, cut: [rows cut by the top of the part that shows], to: { t, b },
//               toInSight, toNeeded, more, cueOpacity, bodyH, paneH }
//   top / bottom   the part of the header that shows: under the sticky action row, above the formatting row (px from the top of the window)
//   band           bottom - top;  toNeeded: To down to the focused control + 12 px (the margin the browser keeps under a focused field)
//   cut            []: no row of the header is cut by `top` (a row is whole or wholly out of the part that shows)
//   toInSight      To is whole inside [top, bottom]
//   more / cueOpacity  `data-more-below` of the header and the opacity of its `::after` (the shade): "1" when more of the header is below the box
// Pass: focus.t >= top - 1 && focus.b <= bottom + 1, cut is empty, toInSight when band >= toNeeded, !toInSight (and To wholly above top) when it is not, and the shade
// (cueOpacity "1") exactly when scrollH > clientH + scroll.
export const HEADER_PROBE_BODY = `
const head = document.querySelector('.cp-head');
if (!head) return { error: 'no compose header: open a message first' };
const bar = head.querySelector(':scope > .cp-bar'), fmt = document.querySelector('.cp-fmt'), a = document.activeElement;
const H = head.getBoundingClientRect(), F = fmt.getBoundingClientRect();
const top = H.top + (getComputedStyle(bar).position === 'sticky' ? bar.getBoundingClientRect().height : 0), bottom = Math.min(H.bottom, F.top);
const R = (e) => { const r = e.getBoundingClientRect(); return { t: r.top, b: r.bottom }; };
const rows = [...head.querySelectorAll('.cp-fields > .cf-field, .cp-fields > .cf-links, .cp-fields > .note, .cp-event > .when, .cp-event > input, .cp-head > .note, .cp-head > .sec-strip')].filter((e) => e.getBoundingClientRect().height > 0);
const toEl = document.querySelector('.cp-fields .rcpt');
const to = toEl ? R(toEl.querySelector('.chips') || toEl) : null;
const r = a && head.contains(a) ? a.getBoundingClientRect() : null;
let hit = false;
if (r) {
  const y = Math.max(top + 1, Math.min(bottom - 1, r.top + r.height / 2));
  const t = document.elementFromPoint(r.left + Math.min(r.width / 2, 40), y);
  hit = !!t && (a === t || a.contains(t) || t.contains(a) || !!(a.closest('label, .switch') && a.closest('label, .switch').contains(t)));
}
const focus = r ? { name: a.tagName.toLowerCase() + (a.id ? '#' + a.id : '') + '.' + String(a.className).trim().split(/\\s+/)[0], t: r.top, b: r.bottom, hit } : null;
const cut = rows.filter((e) => { const q = e.getBoundingClientRect(); return q.top < top - 0.75 && q.bottom > top + 0.75; }).map((e) => e.tagName.toLowerCase() + '.' + String(e.className).trim().split(/\\s+/)[0] + ' ' + Math.round(R(e).t) + '-' + Math.round(R(e).b));
const toNeeded = focus && to ? Math.round(focus.b - to.t + 12) : null;
const editor = document.querySelector('.cp-editor'), pane = document.querySelector('.compose-pane');
return {
  top: Math.round(top), bottom: Math.round(bottom), band: Math.round(bottom - top), scroll: Math.round(head.scrollTop), scrollH: head.scrollHeight, clientH: head.clientHeight,
  focus, cut, to, toInSight: !!to && to.t >= top - 1 && to.b <= bottom + 1, toNeeded,
  more: head.hasAttribute('data-more-below'), cueOpacity: getComputedStyle(head, '::after').opacity,
  bodyH: Math.round(editor.getBoundingClientRect().height), paneH: Math.round(pane.getBoundingClientRect().height),
  paneClass: pane.className.trim().replace(/\\s+/g, ' '), vw: innerWidth, vh: innerHeight, ua: navigator.userAgent,
};
`;

/** The same as an expression (JSON string) for `Runtime.evaluate`. */
export const HEADER_PROBE_JS = `(() => { const f = new Function(${JSON.stringify(HEADER_PROBE_BODY)}); return f(); })()`;

if (process.argv[1] && process.argv[1].endsWith('header-rows-probe.mjs')) {
  const { bridge, connection } = await import('../test-bridge-client.mjs');
  const [where, win = 'main'] = process.argv.slice(2);
  if (!where) { console.error('usage: node scripts/lib/header-rows-probe.mjs <data folder | test-bridge.json | port:token> [window]'); process.exit(2); }
  const conn = /^\d+:[0-9a-f]{64}$/.test(where) ? { port: Number(where.split(':')[0]), token: where.split(':')[1] } : connection(where);
  const res = await bridge(conn).evalIn(win, HEADER_PROBE_BODY, { timeoutMs: 15000 });
  console.log(JSON.stringify(res, null, 2));
  process.exit(res && !res.error ? 0 : 1);
}
