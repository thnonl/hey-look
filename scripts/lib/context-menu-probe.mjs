// The right-click probe for the QA of the native webview menu (D-036, WK-D036): dispatches a synthetic `contextmenu` event on a list of targets of a
// window of a DEBUG build through the test bridge (scripts/test-bridge-client.mjs, scripts/test-bridge.md) and prints JSON:
//   { window, hash, targets: [{ name, found, prevented, want, ok }], frame: { prevented, appMenus, menuAt, expectedAt, ok }, closed, pass }
// `prevented` is `defaultPrevented` after the app's guard: true = the engine shows no menu of its own (the app's menu opens or nothing does), false =
// the engine's own menu would show. A synthetic event cannot open the engine's menu, so the probe says what the engine WOULD do: the real right-click
// steps in the QA list (webkit-checks-107.md section 13) confirm it with the eyes.
//   field    Subject, To, compose body, search box       want prevented false (the engine's menu with spell check and Paste)
//   others   folder label, ribbon button, reading-pane header   want prevented true
//   frame    a word in the message body (the sandboxed iframe: its document never reaches the window's listener): want prevented true, ONE app menu
//            at (frame left + clientX, frame top + clientY): `menuAt` equals `expectedAt` within 2 px
// A debug build keeps the engine's menu only with `#nativemenu=on` in the page address: the probe reports `hash` for that reason.
//
// Three bridge calls, nothing waits inside the page (a window that is covered or in the background runs timers and message ports slowly: a probe that
// waited for the menu inside one call ran into the bridge's timeout): FIRE (synchronous, all targets, the frame last), READ (the menu that is open: where,
// how many; closes it), then CLOSED (no menu left).
//
//   node scripts/lib/context-menu-probe.mjs <data folder | test-bridge.json | port:token> [window=main]
import { bridge, connection } from "../test-bridge-client.mjs";

/** Body of an async function for POST /eval: fires the events and returns the verdicts that need no waiting. */
export const PROBE_FIRE = `
const out = [];
const fire = (doc, el, x, y) => {
  const View = doc.defaultView;
  const ev = new View.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2, view: View });
  el.dispatchEvent(ev);
  return ev.defaultPrevented;
};
const q = (s) => document.querySelector(s);
const target = (name, el, want) => {
  if (!el) { out.push({ name, found: false, ok: null }); return; }
  const prevented = fire(document, el, 20, 12);
  out.push({ name, found: true, prevented, want, ok: prevented === want });
};
target('folder label', q('.fp-row:not([data-own-menu]) .fp-lbl'), true); // (1.0.10: One Inbox, the first row, has a menu of its own)
target('ribbon button', q('.ribbon-row button'), true);
// (not the top bar: on a custom-frame window - Windows - a right click there opens the system's window menu, a modal native menu that blocks the host's message loop and with it the bridge)
target('reading-pane header', q('.rp-head h2'), true);
target('settings / dialog text', q('.modal .settings label, .modal .settings .set-label, .modal h2'), true);
target('search box (field)', q('.topbar input'), false);
target('compose Subject (field)', q('.cf-subject input'), false);
target('compose body (field)', q('.ProseMirror'), false);
let frame = null;
const f = q('iframe.msg-frame');
if (f && f.contentDocument && f.contentDocument.body) {
  const d = f.contentDocument;
  const el = d.querySelector('p, div, td, span') || d.body;
  const r = f.getBoundingClientRect();
  const x = 30, y = 20;
  const prevented = fire(d, el, x, y);
  frame = { prevented, expectedAt: [Math.round(r.left + x), Math.round(r.top + y)], frameAt: [Math.round(r.left), Math.round(r.top)] };
}
return { hash: location.hash, ua: navigator.userAgent, targets: out, frame, targetsPass: out.filter((t) => t.found).every((t) => t.ok) };
`;

/** Body of the second call (some time after the first: the menu is drawn by then): where the open menu is, and closes it. */
export const PROBE_READ = `
const ms = [...document.querySelectorAll('.ctx-menu')];
// offsetLeft / offsetTop: the layout position, not the box of the opening animation (a transform moves getBoundingClientRect for the first 100 ms or so)
const at = ms[0] ? [ms[0].offsetLeft, ms[0].offsetTop] : null;
document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
return { appMenus: ms.length, menuAt: at };
`;

/** Body of the third call: how many app menus are still open. */
export const PROBE_CLOSED = `return document.querySelectorAll('.ctx-menu').length;`;

/** The three calls in order; `run(body)` evaluates a body in the window and `pause(ms)` waits. Returns the JSON of the probe. */
export async function runProbe(run, pause) {
  const fire = await run(PROBE_FIRE);
  await pause(400);
  const read = await run(PROBE_READ);
  await pause(300);
  const left = await run(PROBE_CLOSED);
  let frame = null;
  if (fire.frame) {
    const near = (a, b) => !!a && Math.abs(a[0] - b[0]) <= 2 && Math.abs(a[1] - b[1]) <= 2;
    frame = { ...fire.frame, appMenus: read.appMenus, menuAt: read.menuAt, ok: fire.frame.prevented === true && read.appMenus === 1 && near(read.menuAt, fire.frame.expectedAt) };
  }
  const { frame: _frame, targetsPass, ...rest } = fire;
  return { ...rest, frame, closed: left === 0, pass: targetsPass && !!frame && frame.ok && left === 0 };
}

if (process.argv[1] && process.argv[1].endsWith("context-menu-probe.mjs")) {
  const [where, win = "main"] = process.argv.slice(2);
  if (!where) { console.error("usage: node scripts/lib/context-menu-probe.mjs <data folder | test-bridge.json | port:token> [window]"); process.exit(2); }
  const conn = /^\d+:[0-9a-f]{64}$/.test(where) ? { port: Number(where.split(":")[0]), token: where.split(":")[1] } : connection(where);
  const b = bridge(conn);
  const res = await runProbe((body) => b.evalIn(win, body, { timeoutMs: 15000 }), (ms) => new Promise((r) => setTimeout(r, ms)));
  console.log(JSON.stringify({ window: win, ...res }, null, 2));
  process.exit(res.pass ? 0 : 1);
}
