import { sleep, startHarness } from './cdp-harness.mjs';
const H = await startHarness('dbg-fold', { vitePort0: 5198 });
await H.openApp('lang=en&nativemenu=off', 1280, 800); await sleep(2000);
console.log(await H.evaluate(`JSON.stringify(window.__store.getState().folders.filter((f) => f.accountId === window.__store.getState().accounts[0].id).map((f) => [f.role, f.path, f.name]).slice(0, 12))`));
await H.shutdown(); process.exit(0);
