#!/usr/bin/env node
// The toast "AI Assistant is not set up" goes when the AI settings are saved (v1.0.6 QA round 3, observation O-2: it is sticky, and stayed on screen after
// Settings > AI Assistant was saved with an address and a model). Any other AI problem (a refused key ...) stays: saving does not say that it is fixed.
//
// Real UI in the dev preview with the mock backend (src/devMock.ts): Summarize with nothing set up -> the toast; Settings > AI Assistant opened; the
// address and model typed; Save -> the toast is gone and "saved" is shown. Then Summarize with a refused key (#failai=auth) -> toast; Save -> still there.
//   node scripts/test-ai-save-toast.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import { inputs, sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-ai-save-toast', { vitePort0: 5740, cdpPort0: 9740 });
const { evaluate, cdp, base } = H;
const { clickAt, typeText } = inputs(H, null, 'ai');
const failures = [];
const check = (name, ok, msg) => { if (!ok) failures.push(`${name}: ${msg}`); };

async function open(hash) {
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  for (let attempt = 0; attempt < 5; attempt++) {
    await cdp('Page.navigate', { url: 'about:blank' });
    await cdp('Page.navigate', { url: `${base}#${hash}` });
    await sleep(600);
    try { await evaluate(`new Promise((ok, no) => { const t0 = Date.now(), t = setInterval(() => { if (window.__store && window.__store.getState().accounts.length && window.__store.getState().loaded) { clearInterval(t); ok(1); } else if (Date.now() - t0 > 15000) { clearInterval(t); no(new Error('page did not start')); } }, 100); })`); return; } catch (e) { if (attempt === 4) throw e; }
  }
}
const click = async (expr) => { const pt = await evaluate(`(() => { const e = ${expr}; if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`); if (!pt) throw new Error(`nothing to click: ${expr}`); await clickAt(pt[0], pt[1]); };
const guide = () => evaluate(`[...document.querySelectorAll('.toasts .toast.guide')].map((t) => t.querySelector('.toast-title')?.textContent ?? '')`);
const toastTexts = () => evaluate(`[...document.querySelectorAll('.toasts .toast')].map((t) => t.innerText.replace(/\\s+/g, ' '))`);
const waitFor = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(100); } return false; };
const type = async (id, text) => { await evaluate(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.focus(); e.select(); return 1; })()`); await typeText(text, 3); };

async function summarize() {
  await evaluate(`window.__store.getState().openMail('t1'); 1`);
  await evaluate(`new Promise((ok) => { const t = setInterval(() => { if (document.querySelector('.rp-tools .ai-btn')) { clearInterval(t); ok(1); } }, 50); })`);
  await sleep(400);
  await click(`document.querySelector('.rp-tools .ai-btn')`);
}
async function saveSettings() {
  // (opened from the menu, not from the toast: its own button takes the toast away when it is pressed)
  await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'ai' }); 1`);
  await waitFor(() => evaluate(`!!document.getElementById('set-aiBaseUrl')`));
  await sleep(500);
  await type('set-aiBaseUrl', 'http://127.0.0.1:11434/v1');
  await type('set-aiModel', 'qa-model');
  await sleep(300);
  await click(`[...document.querySelectorAll('.modal button, [role=dialog] button')].find((b) => /^Save$/.test(b.textContent.trim()))`);
  await sleep(1200);
}

try {
  // 1. nothing set up: the toast, then Save with an address and a model
  await open('lang=en');
  await summarize();
  check('not set up: the toast comes', await waitFor(async () => (await guide()).length === 1), `toasts: ${JSON.stringify(await guide())}`);
  check('not set up: it is the not-set-up toast', (await guide())[0] === 'AI Assistant is not set up', JSON.stringify(await guide()));
  await saveSettings();
  check('not set up: the store knows the Assistant is set up now', await evaluate(`window.__store.getState().aiConfigured === true`), 'aiConfigured is still false (the settings were not saved?)');
  check('not set up: the toast is gone after Save', (await guide()).length === 0, `still on screen: ${JSON.stringify(await guide())}`);
  check('not set up: "saved" is shown', (await toastTexts()).some((t) => /saved/i.test(t)), JSON.stringify(await toastTexts()));

  // 2. a refused key: saving the settings does not clear it
  await open('lang=en&aiset&failai=auth');
  await summarize();
  check('refused key: the toast comes', await waitFor(async () => (await guide()).length === 1, 9000), `toasts: ${JSON.stringify(await guide())}`);
  await saveSettings();
  check('refused key: the toast stays after Save', (await guide()).length === 1, `toasts: ${JSON.stringify(await guide())}`);
} finally { await H.shutdown(); }

if (failures.length) { console.error(`test-ai-save-toast: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-ai-save-toast: ok');
