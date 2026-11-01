import { sleep, startHarness } from './cdp-harness.mjs';
const H = await startHarness('dbg-ux1d', { vitePort0: 5799 });
const { evaluate, cdp } = H;
await H.openApp('lang=en', 1100, 720);
const A = JSON.parse(await evaluate(`(async () => { const l = await window.__TAURI_INTERNALS__.invoke('list_threads', { filter: { accountId: null, folder: 'inbox', search: '', focus: null, flat: false, unreadOnly: false, flaggedOnly: false }, limit: 50, offset: 0 }); return JSON.stringify((l.threads || l).slice(0, 8).map((t) => [t.threadId, t.subject, t.count ?? t.messageCount])); })()`));
console.log(JSON.stringify(A));
await H.shutdown(); process.exit(0);
