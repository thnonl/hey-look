import { sleep, startHarness, languageJs } from './cdp-harness.mjs';
const H = await startHarness('dbg-lang', { vitePort0: 5860 });
const { evaluate } = H;
await H.openApp('lang=en&light&nativemenu=off', 1280, 800); await sleep(1500);
await evaluate(languageJs('ru')); await sleep(1500);
console.log(await evaluate(`document.documentElement.lang + ' | ' + (document.querySelector('.fp-row .fp-lbl')||{}).textContent + ' | ' + JSON.stringify(window.__store.getState().prefs.language)`));
await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Hello' }); 1`); await sleep(2000);
console.log(await evaluate(`[...document.querySelectorAll('.compose-pane .cp-bar button')].map((b) => (b.getAttribute('aria-label') || b.textContent).trim().slice(0, 20)).join(' | ')`));
await H.shutdown(); process.exit(0);
