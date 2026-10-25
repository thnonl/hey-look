import fs from 'node:fs';
import { sleep, startHarness } from './cdp-harness.mjs';
const H = await startHarness('dbg', { vitePort0: 5095 });
const { evaluate, cdp } = H;
try {
  await H.openApp('lang=en&nativemenu=off&wp8', 1280, 800);
  await evaluate(`window.__store.getState().openMail('tw8-sel'); 1`);
  await sleep(2500);
  const info = await evaluate(`(() => { const f = document.querySelector('iframe.msg-frame'), d = f.contentDocument, a = d.getElementById('mail'); const q = a.getBoundingClientRect(), fr = f.getBoundingClientRect(); return JSON.stringify({ q: [q.left, q.top, q.width, q.height], fr: [fr.left, fr.top, fr.width, fr.height], html: a.outerHTML, n: a.firstChild && a.firstChild.nodeValue, bodyH: d.body.scrollHeight }); })()`);
  console.log(info);
  await evaluate(`window.__ctxlog = []; const f = document.querySelector('iframe.msg-frame'); f.contentDocument.addEventListener('contextmenu', (e) => window.__ctxlog.push([e.target.tagName, e.defaultPrevented]), false); 1`);
  const [qx, qy] = JSON.parse(info).q; const [fx, fy] = JSON.parse(info).fr;
  const x = fx + qx + 10, y = fy + qy + 6;
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
  await sleep(500);
  console.log(await evaluate(`(() => { const e = document.elementFromPoint(${x}, ${y}); return e ? e.tagName + '.' + e.className + ' ' + innerWidth + 'x' + innerHeight : null; })()`));
  console.log(await evaluate(`JSON.stringify({ log: window.__ctxlog, menu: !!document.querySelector('.ctx-menu'), items: [...document.querySelectorAll('.ctx-menu [role=menuitem]')].map((e) => e.textContent) })`));
const shot = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync('C:/Users/namth/AppData/Local/Temp/claude/E--hey-mail/5dee273c-ea7d-4367-9fe0-8d27861b3478/scratchpad/dbg1.png', Buffer.from(shot.data, 'base64')); } finally { await H.shutdown(); }
