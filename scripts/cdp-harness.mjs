// The browser side of the layout tests (test-settings-layout.mjs, test-preview-layer.mjs): finds Chrome / Chromium / Edge, starts a vite dev server of
// this checkout (the dev preview has the mock backend, src/devMock.ts) and a headless browser, and gives the test a Chrome DevTools Protocol
// session. No dependencies (Node 22+, global WebSocket). A test that finds no browser (or no dev server) SKIPS instead of failing, like the
// site test, unless it is run with --require-browser.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const arg = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
export const flag = (name) => process.argv.includes(`--${name}`);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const env = process.env.CHROME_PATH; if (env && fs.existsSync(env)) return env;
  const win = [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
  const list = [
    ...win.map((b) => path.join(b, 'Google/Chrome/Application/chrome.exe')),
    ...win.map((b) => path.join(b, 'Chromium/Application/chrome.exe')),
    ...win.map((b) => path.join(b, 'Microsoft/Edge/Application/msedge.exe')),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
  ];
  return list.find((p) => fs.existsSync(p)) || null;
}
const freePort = async (from) => { for (let p = from; p < from + 100; p++) { const ok = await new Promise((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(p, '127.0.0.1', () => s.close(() => r(true))); }); if (ok) return p; } throw new Error(`no free port from ${from}`); };

/**
 * Starts the dev server (unless `--url=` names one that already runs) and the browser. Returns
 * `{ base, cdp, evaluate, shutdown, openApp }`; exits the process with a "SKIPPED" line when there is no browser.
 * `openApp(hash, w, h)` loads the dev preview with that hash at that window size and waits until the store has its accounts.
 */
export async function startHarness(name, { vitePort0 = 5480, cdpPort0 = 9500 } = {}) {
  const skip = (why) => { if (flag('require-browser')) { console.error(`${name}: ${why}`); process.exit(1); } console.log(`${name}: SKIPPED, ${why} (pass --require-browser to fail instead)`); process.exit(0); };
  const chrome = findChrome();
  if (!chrome) skip('no Chrome/Chromium/Edge found (set CHROME_PATH)');
  let vite = null, base = arg('url');
  if (!base) {
    const vitePort = await freePort(vitePort0);
    vite = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
    base = `http://127.0.0.1:${vitePort}/`;
  }
  const cdpPort = await freePort(cdpPort0);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-cdp-'));
  const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', `--user-data-dir=${profile}`, `--remote-debugging-port=${cdpPort}`, '--remote-allow-origins=*', ...(process.platform === 'linux' ? ['--no-sandbox'] : []), 'about:blank'], { stdio: 'ignore' });
  let closed = false;
  const shutdown = async () => {
    if (closed) return; closed = true;
    try { proc.kill(); } catch { /* ignore */ }
    try { vite?.kill(); } catch { /* ignore */ }
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* it is in the temp folder anyway */ }
  };
  process.on('exit', () => { try { proc.kill(); } catch { /* ignore */ } try { vite?.kill(); } catch { /* ignore */ } });

  let wsUrl = null;
  for (let i = 0; i < 100 && !wsUrl; i++) { try { wsUrl = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json()).webSocketDebuggerUrl; } catch { await sleep(150); } }
  if (!wsUrl) { await shutdown(); skip('Chrome did not start'); }
  let up = false;
  for (let i = 0; i < 200 && !up; i++) { try { up = (await fetch(base)).ok; } catch { await sleep(300); } }
  if (!up) { await shutdown(); skip(`the dev server did not answer at ${base}`); }

  const ws = new WebSocket(wsUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let nextId = 1; const waiting = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { const { ok, bad } = waiting.get(m.id); waiting.delete(m.id); m.error ? bad(new Error(m.error.message)) : ok(m.result); } };
  const send = (method, params = {}, sessionId) => new Promise((ok, bad) => { const id = nextId++; waiting.set(id, { ok, bad }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const cdp = (method, params) => send(method, params, sessionId);
  const evaluate = async (expression) => { const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  await cdp('Runtime.enable'); await cdp('Page.enable');

  /** Loads the dev preview (`hash` without the #) in a window of w x h and waits for the app. */
  const openApp = async (hash, w, h) => {
    await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    // the first request of a fresh dev server may reload the page once while vite optimises its dependencies: wait for the store
    for (let attempt = 0; attempt < 5; attempt++) {
      await cdp('Page.navigate', { url: 'about:blank' }); // a change of the hash alone would keep the page (and the mock's memory)
      await cdp('Page.navigate', { url: `${base}#${hash}` });
      await sleep(600);
      try { await evaluate(`new Promise((ok, no) => { const t0 = Date.now(), t = setInterval(() => { if (window.__store && window.__store.getState().accounts.length) { clearInterval(t); ok(1); } else if (Date.now() - t0 > 15000) { clearInterval(t); no(new Error('app did not start')); } }, 100); })`); return; } catch (e) { if (attempt === 4) throw e; }
    }
  };
  return { base, cdp, evaluate, shutdown, openApp };
}

/** Mouse, keyboard and screenshots on a CDP session. */
export function inputs({ cdp, evaluate }, shotDir, tag) {
  const typeText = async (text, gap = 25) => { for (const ch of text) { await cdp('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }); await sleep(gap); } };
  const press = async (key, code, modifiers = 0) => { await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers }); };
  const clickAt = async (x, y) => {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const click = async (selector, which = 'first') => {
    // a control that is not under its own centre (below the fold of the pane) is scrolled to first, as a person would; one in view is clicked where it is
    const [x, y] = await evaluate(`(() => { const all = document.querySelectorAll(${JSON.stringify(selector)}), e = ${which === 'last' ? 'all[all.length - 1]' : 'all[0]'}; let r = e.getBoundingClientRect(); const hit = (x, y) => { const t = document.elementFromPoint(x, y); return !!t && e.contains(t); }; if (!hit(r.left + r.width / 2, r.top + r.height / 2)) { e.scrollIntoView({ block: 'nearest' }); r = e.getBoundingClientRect(); } return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    await clickAt(x, y);
  };
  const shot = async (name) => { if (!shotDir) return; fs.mkdirSync(shotDir, { recursive: true }); const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shotDir, `${tag}-${name}.png`), Buffer.from(r.data, 'base64')); };
  return { typeText, press, click, clickAt, shot };
}
