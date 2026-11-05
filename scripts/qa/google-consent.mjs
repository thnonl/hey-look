// QA tooling only (never shipped): drives a Google sign-in / consent page in a DEDICATED Chrome profile, so a QA run needs no manual clicks.
//
//   node scripts/qa/google-consent.mjs start                      start the QA Chrome (own profile, DevTools port); idempotent
//   node scripts/qa/google-consent.mjs check  [--email=...]       is the QA profile signed in to the test account? (exit 0 yes, 3 no)
//   node scripts/qa/google-consent.mjs consent --action=allow|deny [--email=...] (--url=<consent url> | --from-uia [--since=<file>])
//   node scripts/qa/google-consent.mjs snapshot --out=<file>      remember the Google URLs open now (so --from-uia ignores old tabs)
//
// Safety rules (owner, 2026-11-05):
//   - Profile: D:\qa-chrome-profile\heylook (or --profile / QA_CHROME_PROFILE), never the owner's default Chrome profile.
//   - It clicks ONLY the account tile whose address is exactly --email (default thnonline@gmail.com), and checks that address is on each consent
//     page before Continue / Allow. Any other account, or none: it stops.
//   - It NEVER types anything: no password, no 2FA code, no CAPTCHA. A password / challenge / CAPTCHA / "enter your email" page stops it with
//     NEED_OWNER; the owner signs in once by hand in the QA profile (`start` opens it) and Google keeps that session.
//   - It stores no credentials and prints no token. The loopback redirect is shown without its query (only "code" / "error=..." is reported).
//
// The app opens the consent URL with the system default browser (tauri opener) and has no override. So `--from-uia` reads the URL from a browser
// address bar (UI Automation, read-only; the same idea as reports/v1-0-1/qa-1014-consent-helper.ps1) and opens it again in the QA profile. The tab
// in the default browser is left alone: nobody clicks in it. Take a `snapshot` before the app's sign-in click so older Google tabs are ignored.
//
// Exit codes: 0 done, 2 usage, 3 NEED_OWNER (sign-in needed / password / challenge), 4 wrong or missing account (stopped), 5 timeout, 6 other error.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const arg = (n, d = null) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const flag = (n) => process.argv.includes(`--${n}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const cmd = process.argv[2];
const PROFILE = arg('profile', process.env.QA_CHROME_PROFILE || 'D:\\qa-chrome-profile\\heylook');
const EMAIL = (arg('email', 'thnonline@gmail.com') || '').trim().toLowerCase();
const TIMEOUT = Number(arg('timeout', '180')) * 1000;

class Stop extends Error { constructor(code, msg) { super(msg); this.code = code; } }

function chromePath() {
  const env = process.env.CHROME_PATH; if (env && fs.existsSync(env)) return env;
  const bases = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
  const hit = bases.map((b) => path.join(b, 'Google/Chrome/Application/chrome.exe')).find((p) => fs.existsSync(p));
  if (!hit) throw new Stop(6, 'Chrome not found (set CHROME_PATH)');
  return hit;
}

// guard: never the owner's default profile
function checkProfile() {
  const p = path.resolve(PROFILE).toLowerCase();
  if (p.includes('\\google\\chrome\\user data') || p.includes('/google/chrome')) throw new Stop(2, `refused: ${PROFILE} looks like the default Chrome profile`);
}

async function devtoolsPort() {
  const f = path.join(PROFILE, 'DevToolsActivePort');
  if (!fs.existsSync(f)) return null;
  const port = Number(fs.readFileSync(f, 'utf8').split(/\r?\n/)[0]);
  try { const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) }); if (r.ok) return port; } catch { /* not running */ }
  return null;
}

async function start(url = 'about:blank') {
  checkProfile();
  let port = await devtoolsPort();
  if (port) return port;
  fs.mkdirSync(PROFILE, { recursive: true });
  try { fs.rmSync(path.join(PROFILE, 'DevToolsActivePort'), { force: true }); } catch { /* stale file */ }
  const p = spawn(chromePath(), [`--user-data-dir=${PROFILE}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--lang=en-US', url],
    { detached: true, stdio: 'ignore' });
  p.unref();
  for (let i = 0; i < 60 && !port; i++) { await sleep(500); port = await devtoolsPort(); }
  if (!port) throw new Stop(6, 'QA Chrome did not open its DevTools port');
  log(`QA Chrome up, profile ${PROFILE}, pid ${p.pid}, devtools port ${port}`);
  return port;
}

// --- minimal CDP over the global WebSocket (Node 22+) ---
async function attach(port, url) {
  const r = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURI(url)}`, { method: 'PUT' });
  const t = await r.json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Stop(6, 'CDP connect failed')); });
  let id = 0; const wait = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
  const send = (method, params = {}) => new Promise((ok, bad) => {
    const n = ++id; wait.set(n, (d) => (d.error ? bad(new Stop(6, `${method}: ${d.error.message}`)) : ok(d.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }); return r.result?.value; };
  return { id: t.id, ws, send, evaluate, close: async () => { try { await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`); } catch { /* closed */ } ws.close(); } };
}

// what the page is, in the page itself; read only
const READ_PAGE = `(() => {
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const q = (s) => [...document.querySelectorAll(s)].filter(vis);
  const text = (document.body?.innerText || '').replace(/\\s+/g, ' ');
  const tiles = q('[data-identifier], [data-email]').map((e) => ({ email: (e.getAttribute('data-identifier') || e.getAttribute('data-email') || '').trim().toLowerCase(),
    signedOut: /signed out/i.test(e.innerText || '') }));
  const buttons = q('button, [role=button], a').map((e) => (e.innerText || e.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 40);
  return {
    href: location.href, host: location.host, path: location.pathname, text: text.slice(0, 4000), tiles, buttons,
    password: q('input[type=password]').length > 0,
    identifier: q('#identifierId, input[type=email]').length > 0,
    challenge: /\\/challenge\\//.test(location.pathname) || q('#captchaimg, iframe[src*="recaptcha"], input[name=totpPin], input[type=tel]').length > 0,
    selectAll: q('input[type=checkbox]').length,
    unchecked: q('input[type=checkbox]').filter((c) => !c.checked && !c.disabled).length,
  };
})()`;

// centre of the first visible element that matches; the click itself is a real mouse event
const FIND = (kind, needle) => `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  let els;
  if (${JSON.stringify(kind)} === 'tile') els = [...document.querySelectorAll('[data-identifier], [data-email]')].filter((e) =>
    (e.getAttribute('data-identifier') || e.getAttribute('data-email') || '').trim().toLowerCase() === ${JSON.stringify(needle)});
  else if (${JSON.stringify(kind)} === 'checkbox') els = [...document.querySelectorAll('input[type=checkbox]')].filter((c) => !c.checked && !c.disabled)
    .map((c) => c.closest('label, [role=checkbox], div') || c);
  else { const re = new RegExp(${JSON.stringify(needle)}, 'i');
    els = [...document.querySelectorAll('button, [role=button], a')].filter((e) => re.test((e.innerText || e.getAttribute('aria-label') || '').trim())); }
  const e = els.find(vis); if (!e) return null;
  e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: (e.innerText || '').trim().slice(0, 60) };
})()`;

async function click(page, kind, needle) {
  const at = await page.evaluate(FIND(kind, needle));
  if (!at) return null;
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
  }
  return at;
}

const CONTINUE = '^(continue|allow|tiếp tục|cho phép)$';
const CANCEL = '^(cancel|deny|hủy|từ chối)$';

// the consent loop: one decision per page state, at most one click per pass
async function drive(port, url, action) {
  const u = new URL(url);
  if (u.host !== 'accounts.google.com') throw new Stop(2, `not a Google URL: ${u.host}`);
  if (!u.searchParams.has('hl')) u.searchParams.set('hl', 'en');
  const page = await attach(port, u.toString());
  await page.send('Page.enable'); await page.send('Runtime.enable');
  const until = Date.now() + TIMEOUT;
  let last = '';
  try {
    while (Date.now() < until) {
      await sleep(1200);
      let s;
      try { s = await page.evaluate(READ_PAGE); } catch { continue; } // navigating
      if (!s) continue;
      if (/^127\.0\.0\.1|^localhost/.test(s.host)) {
        const back = new URL(s.href);
        const err = back.searchParams.get('error');
        log(`RESULT redirect to ${back.origin}${back.pathname} ${err ? `error=${err}` : back.searchParams.has('code') ? 'code=(present, not shown)' : '(no code)'}`);
        return { ok: true, error: err };
      }
      const state = `${s.path}|${s.tiles.map((t) => t.email).join(',')}|${s.buttons.join('/')}`;
      if (state !== last) { log(`page ${s.host}${s.path} buttons=[${s.buttons.slice(0, 8).join(' | ')}]`); last = state; }
      if (s.password || s.challenge) throw new Stop(3, 'NEED_OWNER: Google asks for a password, a code or a CAPTCHA. Sign in once by hand in the QA profile (node scripts/qa/google-consent.mjs start).');
      const hasConsentButtons = s.buttons.some((b) => new RegExp(CONTINUE, 'i').test(b) || new RegExp(CANCEL, 'i').test(b));
      if (s.tiles.length && !hasConsentButtons) { // the account chooser
        const mine = s.tiles.find((t) => t.email === EMAIL);
        if (!mine) throw new Stop(4, `STOP: no account tile for ${EMAIL} (tiles: ${s.tiles.length}); nothing clicked`);
        if (mine.signedOut) throw new Stop(3, `NEED_OWNER: ${EMAIL} is signed out in the QA profile; sign in once by hand`);
        const c = await click(page, 'tile', EMAIL); if (c) { log(`clicked account tile ${EMAIL}`); continue; }
      }
      if (s.identifier) throw new Stop(3, `NEED_OWNER: the QA profile is not signed in. Sign in to ${EMAIL} once by hand (node scripts/qa/google-consent.mjs start).`);
      if (/hasn.t verified this app/i.test(s.text)) {
        if (action === 'deny') { const c = await click(page, 'button', '^(back to safety)$'); if (c) { log('clicked Back to safety'); continue; } }
        const adv = await click(page, 'button', '^advanced$'); if (adv) { log('clicked Advanced (unverified-app page)'); await sleep(600); }
        const go = await click(page, 'button', '^go to .*\\(unsafe\\)$'); if (go) { log(`clicked ${go.label}`); continue; }
      }
      // a consent page: it must name the test account before anything is allowed
      if (!hasConsentButtons) continue;
      if (!s.text.toLowerCase().includes(EMAIL)) throw new Stop(4, `STOP: this consent page does not name ${EMAIL}; nothing clicked`);
      if (action === 'deny') { const c = await click(page, 'button', CANCEL); if (c) { log(`clicked ${c.label}`); continue; } }
      else {
        if (s.unchecked > 0 && /select all|choose what|access to/i.test(s.text)) {
          const sa = await click(page, 'button', '^select all$') || await click(page, 'checkbox', '');
          if (sa) { log(`ticked ${sa.label || 'a scope box'}`); await sleep(400); continue; }
        }
        const c = await click(page, 'button', CONTINUE); if (c) { log(`clicked ${c.label}`); continue; }
      }
    }
    throw new Stop(5, `TIMEOUT after ${TIMEOUT / 1000} s on ${last.split('|')[0]}`);
  } finally { await page.close(); }
}

// --- UI Automation (Windows): the Google consent URLs now in any browser address bar ---
function uiaUrls() {
  const ps = `Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes;
$c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Address and search bar');
foreach ($e in [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, $c)) {
  try { $v = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value; if ($v -match 'accounts\\.google\\.com' -and $v -match 'client_id=') { $v } } catch {} }`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 30000 });
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((v) => (v.startsWith('http') ? v : `https://${v}`));
}
// the loopback port in a consent URL identifies one sign-in attempt
const portOf = (u) => { try { return new URL(new URL(u).searchParams.get('redirect_uri') || '').port; } catch { return ''; } };

async function fromUia(sinceFile) {
  const old = new Set(sinceFile && fs.existsSync(sinceFile) ? JSON.parse(fs.readFileSync(sinceFile, 'utf8')) : []);
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    const fresh = uiaUrls().filter((u) => portOf(u) && !old.has(portOf(u)));
    if (fresh.length) { log(`consent URL read from a browser address bar (loopback port ${portOf(fresh[0])}); that tab is left untouched`); return fresh[0]; }
    await sleep(1500);
  }
  throw new Stop(5, 'TIMEOUT: no new Google consent URL in any address bar within 60 s');
}

async function check(port) {
  const page = await attach(port, 'https://accounts.google.com/AccountChooser?hl=en');
  try {
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      const s = await page.evaluate(READ_PAGE).catch(() => null);
      if (!s) continue;
      if (s.tiles.some((t) => t.email === EMAIL && !t.signedOut)) { log(`OK: the QA profile is signed in to ${EMAIL}`); return true; }
      if (s.identifier || s.tiles.length) break;
    }
    log(`NEED_OWNER: the QA profile is not signed in to ${EMAIL}. Sign in once by hand in the QA Chrome window.`);
    return false;
  } finally { await page.close(); }
}

try {
  if (!['start', 'check', 'consent', 'snapshot'].includes(cmd)) throw new Stop(2, 'usage: start | check | consent --action=allow|deny (--url=... | --from-uia [--since=file]) | snapshot --out=file');
  if (cmd === 'snapshot') {
    const out = arg('out'); if (!out) throw new Stop(2, 'snapshot needs --out=<file>');
    const ports = [...new Set(uiaUrls().map(portOf).filter(Boolean))];
    fs.writeFileSync(out, JSON.stringify(ports)); log(`snapshot: ${ports.length} Google consent tab(s) open now, ignored later`);
    process.exit(0);
  }
  if (!EMAIL.includes('@')) throw new Stop(2, '--email must be an address');
  const port = await start(cmd === 'start' ? 'https://accounts.google.com/?hl=en' : 'about:blank');
  if (cmd === 'start') process.exit(0);
  if (cmd === 'check') process.exit((await check(port)) ? 0 : 3);
  const action = arg('action');
  if (!['allow', 'deny'].includes(action)) throw new Stop(2, '--action=allow or --action=deny');
  if (!(await check(port))) throw new Stop(3, 'NEED_OWNER: sign in once by hand in the QA profile');
  const url = arg('url') || (flag('from-uia') ? await fromUia(arg('since')) : null);
  if (!url) throw new Stop(2, 'give --url=<consent url> or --from-uia');
  const r = await drive(port, url, action);
  log(`DONE action=${action} ${r.error ? `refused (${r.error})` : 'allowed'}`);
  process.exit(0);
} catch (e) {
  console.error(e instanceof Stop ? e.message : `ERROR ${e?.stack || e}`);
  process.exit(e instanceof Stop ? e.code : 6);
}
