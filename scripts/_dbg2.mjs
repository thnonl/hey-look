import { sleep, startHarness } from './cdp-harness.mjs';
const H = await startHarness('dbg2', { vitePort0: 5700 });
const { evaluate } = H;
const S = (p) => `window.__store.getState().${p}`;
let bad = 0;
for (let i = 0; i < 12; i++) {
  await H.openApp('lang=en&smallmailbox&persist', 1280, 800);
  await evaluate(`localStorage.setItem('hl-mock-settings', JSON.stringify({ prefs: JSON.stringify({ language: 'en', countOtherMail: false, listW: 420 }) })); 1`);
  const stored1 = await evaluate(`localStorage.getItem('hl-mock-settings')`);
  await H.openApp('lang=en&smallmailbox&persist', 1280, 800);
  const listW = await evaluate(S('prefs.listW'));
  const stored2 = await evaluate(`localStorage.getItem('hl-mock-settings')`);
  if (listW !== 420) { bad++; console.log('BAD', i, listW, JSON.parse(JSON.parse(stored2).prefs).listW, JSON.parse(JSON.parse(stored2).prefs).prefsRev, await evaluate(S('prefs.prefsRev'))); }
}
console.log('bad', bad);
await H.shutdown();
