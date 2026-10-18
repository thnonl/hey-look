#!/usr/bin/env node
// The UI test harness gives every test its own dev server and its own browser (scripts/cdp-harness.mjs, REQ-9.3.1). Two tests that were started at
// the same moment used to pick the same "free" port (checked, closed, used later) and then drive each other's dev server, or attach to each other's browser.
//
// This starts TWO harnesses in one process with the same starting ports (5010 / 9010) and checks that each got its own dev server and its own debugging
// port, that each browser lists only its own page, and that a page opened in one is not seen by the other.
//
//   node scripts/test-harness-isolation.mjs --require-browser
import { startHarness } from './cdp-harness.mjs';

let failures = 0;
const ok = (cond, msg) => { if (!cond) { failures++; console.error(`FAIL ${msg}`); } else console.log(`ok   ${msg}`); };

// both at the same moment, with the same hint
const [a, b] = await Promise.all([startHarness('test-harness-isolation', { vitePort0: 5010 }), startHarness('test-harness-isolation', { vitePort0: 5010 })]);
try {
  ok(a.vitePort && b.vitePort && a.vitePort !== b.vitePort, `different dev-server ports (${a.vitePort}, ${b.vitePort})`);
  ok(a.cdpPort && b.cdpPort && a.cdpPort !== b.cdpPort, `different debugging ports (${a.cdpPort}, ${b.cdpPort})`);
  ok(a.base !== b.base, 'different base URLs');
  // each browser has its own targets only: open the app in A with a marker, a different one in B
  await a.cdp('Page.enable'); await b.cdp('Page.enable');
  await Promise.all([a.cdp('Page.navigate', { url: `${a.base}#marker-a` }), b.cdp('Page.navigate', { url: `${b.base}#marker-b` })]);
  const list = async (h) => (await (await fetch(`http://127.0.0.1:${h.cdpPort}/json/list`)).json()).filter((t) => t.type === 'page');
  const until = async (cond, cap = 20000) => { const t0 = Date.now(); for (;;) { if (await cond()) return true; if (Date.now() - t0 > cap) return false; await new Promise((r) => setTimeout(r, 100)); } };
  const seen = await until(async () => (await list(a)).some((t) => t.url.includes('marker-a')) && (await list(b)).some((t) => t.url.includes('marker-b')));
  ok(seen, 'each browser shows the page that was opened in it');
  const la = await list(a), lb = await list(b);
  ok(!la.some((t) => t.url.includes(String(b.vitePort)) || t.url.includes('marker-b')), 'browser A shows nothing of B');
  ok(!lb.some((t) => t.url.includes(String(a.vitePort)) || t.url.includes('marker-a')), 'browser B shows nothing of A');
  // each page was served by its own dev server
  ok((await a.evaluate('location.port')) === String(a.vitePort) && (await b.evaluate('location.port')) === String(b.vitePort), 'each page comes from its own dev server');
} finally {
  await Promise.all([a.shutdown(), b.shutdown()]);
}
console.log(failures ? `${failures} check(s) FAILED` : 'harness isolation: ok');
process.exit(failures ? 1 : 0);
