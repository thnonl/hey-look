// The probe of the browser autofill (1.0.8, scripts/test-no-autofill.mjs; WebKit rows WK-AF.01 to WK-AF.03 in webkit-checks-107.md). DOM only, nothing is added to the page.
//
// `AUTOFILL_PROBE_BODY` is the body of an async function (`return {...}`): it runs through the test bridge's `/eval` (scripts/test-bridge.md) and, wrapped, through CDP.
//   node scripts/lib/autofill-probe.mjs <data folder | test-bridge.json | port:token> [window=main]
//
// The result: { total, missing: [text fields without an autocomplete attribute], bad: [autocomplete other than off / new-password], named: [fields with a name attribute],
//               search: { autocomplete, autocorrect, autocapitalize, spellcheck, type, name, open } | null, ua }
// PASS: total > 0 in a window that has fields, missing = [], bad = [], named = [], search (main window with a mailbox): "off", "off", "off", false, "text", null.
// Windows only: the setting itself is read by `GET /native` of the bridge (`autofill.<window>.off` must be true for every window); WKWebView and WebKitGTK have no dropdown to switch off.
export const AUTOFILL_PROBE_BODY = `
const NOT_TEXT = ['checkbox', 'radio', 'color', 'file', 'range', 'button', 'submit', 'reset', 'hidden', 'image'];
const els = [...document.querySelectorAll('input, textarea')].filter((e) => !NOT_TEXT.includes(e.type));
const name = (e) => e.id || e.getAttribute('aria-label') || e.outerHTML.slice(0, 60);
const s = document.getElementById('search-input');
return {
  total: els.length,
  missing: els.filter((e) => e.getAttribute('autocomplete') === null).map(name),
  bad: els.filter((e) => e.getAttribute('autocomplete') !== null && !['off', 'new-password'].includes(e.getAttribute('autocomplete'))).map(name),
  named: els.filter((e) => e.getAttribute('name') !== null).map(name),
  search: s && { autocomplete: s.getAttribute('autocomplete'), autocorrect: s.getAttribute('autocorrect'), autocapitalize: s.getAttribute('autocapitalize'), spellcheck: s.spellcheck, type: s.type, name: s.getAttribute('name'), open: !!document.querySelector('.sb-panel') },
  ua: navigator.userAgent,
};
`;

/** The same as an expression (JSON string) for `Runtime.evaluate`. */
export const AUTOFILL_PROBE_JS = `(() => { const f = new Function(${JSON.stringify(AUTOFILL_PROBE_BODY)}); return f(); })()`;

if (process.argv[1] && process.argv[1].endsWith('autofill-probe.mjs')) {
  const { bridge, connection } = await import('../test-bridge-client.mjs');
  const [where, win = 'main'] = process.argv.slice(2);
  if (!where) { console.error('usage: node scripts/lib/autofill-probe.mjs <data folder | test-bridge.json | port:token> [window]'); process.exit(2); }
  const conn = /^\d+:[0-9a-f]{64}$/.test(where) ? { port: Number(where.split(':')[0]), token: where.split(':')[1] } : connection(where);
  const res = await bridge(conn).evalIn(win, AUTOFILL_PROBE_BODY, { timeoutMs: 15000 });
  console.log(JSON.stringify(res, null, 2));
  const ok = res && res.missing.length === 0 && res.bad.length === 0 && res.named.length === 0 && (!res.search || (res.search.autocomplete === 'off' && res.search.autocorrect === 'off' && res.search.autocapitalize === 'off' && res.search.spellcheck === false && res.search.name === null));
  process.exit(ok ? 0 : 1);
}
