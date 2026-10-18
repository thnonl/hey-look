#!/usr/bin/env node
// Draws the website's social preview and icon files with a headless Chrome (no dependencies, Node 22+). Run:  node scripts/make-site-images.mjs
//   docs/assets/og-image.jpg          1200x630, the picture Open Graph / Twitter cards show (og:image, twitter:image)
//   docs/assets/apple-touch-icon.png  180x180, opaque (iOS draws its own corners)
//   docs/assets/icon-48.png           48x48, a bitmap favicon next to favicon.svg (search engines ask for a multiple of 48 px)
// The inputs are docs/assets/favicon.svg and docs/media/poster.webp, so a new poster gives a new preview picture. The files are committed:
// CI does not run this (it needs a browser); test-site-seo.mjs checks that they exist, their size in pixels and in bytes.
// CHROME_PATH overrides the browser lookup.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DOCS = fileURLToPath(new URL('../docs/', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function findChrome() {
  const env = process.env.CHROME_PATH; if (env && fs.existsSync(env)) return env;
  const win = [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
  const list = [
    ...win.map((b) => path.join(b, 'Google/Chrome/Application/chrome.exe')), ...win.map((b) => path.join(b, 'Microsoft/Edge/Application/msedge.exe')),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ];
  return list.find((p) => fs.existsSync(p)) || null;
}
const freePort = (from) => new Promise((ok) => { const s = net.createServer(); s.once('error', () => ok(freePort(from + 1))); s.listen(from, '127.0.0.1', () => s.close(() => ok(from))); });

const svg = fs.readFileSync(path.join(DOCS, 'assets/favicon.svg'), 'utf8');
const mark = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
const poster = pathToFileURL(path.join(DOCS, 'media/poster.webp')).href;

// 1200x630: text on the left, the real app window (cropped from the film's poster) bleeding off the right and bottom edge
const OG = `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
html,body{width:1200px;height:630px;overflow:hidden;font-family:"Segoe UI Variable Display","Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;color:#fff}
body{position:relative;background:radial-gradient(900px 600px at 85% 10%,#1d7fd6 0%,rgba(29,127,214,0) 60%),linear-gradient(135deg,#0c4a86 0%,#082f57 55%,#06223f 100%)}
.brand{position:absolute;left:64px;top:56px;display:flex;align-items:center;gap:18px;font-size:44px;font-weight:700;letter-spacing:-.02em}
.brand img{width:68px;height:68px}
h1{position:absolute;left:64px;top:196px;width:520px;font-size:78px;line-height:1.04;font-weight:800;letter-spacing:-.035em}
h1 em{font-style:normal;color:#ffc94d}
p{position:absolute;left:64px;top:430px;width:480px;font-size:30px;line-height:1.35;color:#d7e8fb}
.os{position:absolute;left:64px;bottom:52px;display:flex;gap:12px;font-size:23px;font-weight:600}
.os span{padding:7px 18px;border-radius:999px;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.28)}
.win{position:absolute;left:590px;top:104px;width:1000px;height:480px;border-radius:18px;overflow:hidden;box-shadow:0 30px 80px rgba(0,10,30,.55),0 0 0 1px rgba(255,255,255,.18);background:url("${poster}") -331px -63px/1344px 756px no-repeat}
</style>
<div class="brand"><img src="${mark}" alt="">Hey Look!</div>
<h1>Mail without the <em>rent.</em></h1>
<p>Free, open-source desktop email. No account, no ads.</p>
<div class="os"><span>Windows</span><span>macOS</span><span>Linux</span></div>
<div class="win"></div>`;

const icon = (size, bg) => `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:${size}px;height:${size}px;overflow:hidden;background:${bg}}img{display:block;width:${size}px;height:${size}px}</style><img src="${mark}" alt="">`;

const chrome = findChrome();
if (!chrome) { console.error('make-site-images: no Chrome/Chromium/Edge found (set CHROME_PATH)'); process.exit(1); }
const port = await freePort(9610);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-img-'));
const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', '--allow-file-access-from-files', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--remote-allow-origins=*', ...(process.platform === 'linux' ? ['--no-sandbox'] : []), 'about:blank'], { stdio: 'ignore' });
try {
  let wsUrl = null;
  for (let i = 0; i < 100 && !wsUrl; i++) { try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; } catch { await sleep(150); } }
  if (!wsUrl) throw new Error('Chrome did not start');
  const ws = new WebSocket(wsUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let nextId = 1; const waiting = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { const { ok, bad } = waiting.get(m.id); waiting.delete(m.id); m.error ? bad(new Error(m.error.message)) : ok(m.result); } };
  const send = (method, params = {}, sessionId) => new Promise((ok, bad) => { const id = nextId++; waiting.set(id, { ok, bad }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const cdp = (m, p) => send(m, p, sessionId);
  await cdp('Page.enable');
  // the HTML goes through a temp file so that file:// images (the poster) load
  const shoot = async (html, w, h, out, format, quality) => {
    const f = path.join(profile, 'page.html'); fs.writeFileSync(f, html);
    await cdp('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', { url: pathToFileURL(f).href });
    await sleep(900);
    await cdp('Runtime.evaluate', { expression: 'Promise.all([...document.images].map(i => i.decode().catch(() => {}))).then(() => document.fonts.ready)', awaitPromise: true });
    const { data } = await cdp('Page.captureScreenshot', { format, ...(quality ? { quality } : {}), clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
    fs.writeFileSync(path.join(DOCS, out), Buffer.from(data, 'base64'));
    console.log(`wrote docs/${out} (${w}x${h}, ${fs.statSync(path.join(DOCS, out)).size} bytes)`);
  };
  await shoot(OG, 1200, 630, 'assets/og-image.jpg', 'jpeg', 86);
  await shoot(icon(180, '#0f6cbd'), 180, 180, 'assets/apple-touch-icon.png', 'png');
  await shoot(icon(48, 'transparent'), 48, 48, 'assets/icon-48.png', 'png');
  ws.close();
} finally {
  try { proc.kill(); } catch { /* ignore */ }
  await sleep(400);
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp folder anyway */ }
}
