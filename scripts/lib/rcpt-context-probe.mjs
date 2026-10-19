// The right-click probe for the recipient fields To / Cc / Bcc of a compose (D-038: on a Mac a REAL right-click in the To field fired no `contextmenu` event and opened no
// menu; Subject and the body were fine). A synthetic event cannot tell (it is always delivered), so this probe records the REAL events and what sits under the pointer.
// WebKit on a Mac does not send `contextmenu` when the press that starts the right-click was cancelled (preventDefault on pointerdown or mousedown), or when the press landed
// on something that is not the input (an overlay, a disabled or inert element); the verdicts below name which of these it is.
//
// Three steps through the test bridge (scripts/test-bridge-client.mjs, scripts/test-bridge.md) of a DEBUG build with a compose open in the window:
//   node scripts/lib/rcpt-context-probe.mjs <data folder | test-bridge.json | port:token> static [window=main]
//        no click needed: for To, Cc, Bcc the input, its box, what is hit at the middle of the box (the input itself?), disabled / read-only / inert, pointer-events, and
//        whether an ancestor is draggable. `ok` true for every field that is on screen.
//   node scripts/lib/rcpt-context-probe.mjs <...> arm [window]
//        starts recording (window, capture phase: pointerdown, mousedown, mouseup, auxclick, contextmenu); then RIGHT-CLICK in the field with the mouse (a real click;
//        Ctrl+click is the same on a Mac), then
//   node scripts/lib/rcpt-context-probe.mjs <...> read [window]
//        prints every event that reached the window: its type, whether it is trusted, its target, what was hit at the pointer, and `prevented` (read now, after the whole
//        dispatch: true = some listener cancelled it). Expected: pointerdown, mousedown, mouseup, contextmenu, all `prevented` false, `appMenus` 0.
//   Reading: no event at all = the press never reached the page (a native layer above the web view); pointerdown/mousedown `prevented` true = the page cancelled the press;
//   events but no contextmenu with nothing prevented = the engine did not send it (send the whole JSON).
// The same bodies run in the dev preview with real clicks (scripts/test-recipient-menu.mjs).

/** Body of an eval: starts (or restarts) the recorder. */
export const ARM = `
const w = window;
const describe = (el) => { if (!el || !el.tagName) return String(el); return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.') : '') + (el.getAttribute && el.getAttribute('aria-label') ? '[' + el.getAttribute('aria-label') + ']' : ''); };
w.__rcpt = w.__rcpt || { log: [], armed: false };
w.__rcpt.log.length = 0;
if (!w.__rcpt.armed) {
  w.__rcpt.armed = true;
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'auxclick', 'contextmenu']) {
    w.addEventListener(type, (e) => { w.__rcpt.log.push({ e, type, button: e.button, trusted: e.isTrusted, target: describe(e.target), hit: describe(document.elementFromPoint(e.clientX, e.clientY)), active: describe(document.activeElement), x: Math.round(e.clientX), y: Math.round(e.clientY) }); }, true);
  }
}
return true;
`;

/** Body of an eval: what the recorder saw. */
export const READ = `
const log = (window.__rcpt && window.__rcpt.log) || [];
return { armed: !!(window.__rcpt && window.__rcpt.armed), hash: location.hash, ua: navigator.userAgent, appMenus: document.querySelectorAll('.ctx-menu').length,
  events: log.map((l) => ({ type: l.type, button: l.button, trusted: l.trusted, prevented: l.e.defaultPrevented, target: l.target, hit: l.hit, active: l.active, x: l.x, y: l.y })) };
`;

/** Body of an eval: the state of the three recipient inputs. */
export const STATIC = `
const names = ['to', 'cc', 'bcc'];
const describe = (el) => (el && el.tagName ? el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.') : '') : String(el));
const fields = [...document.querySelectorAll('.cf-field.rcpt')].map((box, i) => {
  const input = box.querySelector('input');
  if (!input) return { field: names[i], found: false, ok: false };
  const r = input.getBoundingClientRect();
  const x = r.left + Math.min(r.width / 2, 40), y = r.top + r.height / 2;
  const onScreen = r.width > 0 && r.height > 0 && y >= 0 && y <= innerHeight;
  const hit = document.elementFromPoint(x, y);
  const cs = getComputedStyle(input);
  const s = { field: names[i], found: true, onScreen, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], hit: describe(hit), hitIsInput: hit === input,
    disabled: input.disabled, readOnly: input.readOnly, inert: !!input.closest('[inert]'), pointerEvents: cs.pointerEvents, userSelect: cs.userSelect, visibility: cs.visibility,
    draggableAncestor: !!input.closest('[draggable="true"]'), role: input.getAttribute('role'), type: input.type, value: input.value.length, focused: document.activeElement === input };
  s.ok = onScreen ? s.hitIsInput && !s.disabled && !s.readOnly && !s.inert && s.pointerEvents !== 'none' && s.visibility === 'visible' : null;
  return s;
});
return { hash: location.hash, ua: navigator.userAgent, fields, pass: fields.filter((f) => f.ok !== null).every((f) => f.ok) };
`;

if (process.argv[1] && process.argv[1].endsWith("rcpt-context-probe.mjs")) {
  const { bridge, connection } = await import("../test-bridge-client.mjs");
  const [where, mode, win = "main"] = process.argv.slice(2);
  if (!where || !["static", "arm", "read"].includes(mode)) { console.error("usage: node scripts/lib/rcpt-context-probe.mjs <data folder | test-bridge.json | port:token> static|arm|read [window]"); process.exit(2); }
  const conn = /^\d+:[0-9a-f]{64}$/.test(where) ? { port: Number(where.split(":")[0]), token: where.split(":")[1] } : connection(where);
  const b = bridge(conn);
  const res = await b.evalIn(win, { static: STATIC, arm: ARM, read: READ }[mode], { timeoutMs: 15000 });
  console.log(JSON.stringify({ window: win, mode, result: res }, null, 2));
  process.exit(mode === "static" && !res.pass ? 1 : 0);
}
