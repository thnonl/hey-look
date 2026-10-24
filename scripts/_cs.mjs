import { sleep, startHarness } from './cdp-harness.mjs';
const H = await startHarness('cs', { vitePort0: 6130 });
const { evaluate } = H;
await H.openApp('lang=en', 1280, 800);
await evaluate(`(async () => { window.__mockAddThread('n1', 'Newsletter', { html: '<div><picture><source media="(prefers-color-scheme: dark)" srcset="data:image/png;base64,BBBB"><img id="pic" src="data:image/png;base64,AAAA"></picture></div>', fromName: 'News', fromEmail: 'news@example.org' }); await window.__store.getState().refresh(); await window.__store.getState().select('n1'); window.__store.getState().setPrefs({ mailCanvas: 'dark' }); return 1; })()`);
await sleep(2500);
console.log(await evaluate(`(() => { const s = document.querySelector('.msg-frame').getAttribute('srcdoc'); const i = s.indexOf('<picture'); return s.slice(i - 20, i + 400); })()`));
await H.shutdown();
