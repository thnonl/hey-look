// scratch (never committed): how many resource entries does the compose window make in the dev server, and is Compose.tsx among the first 250?
import { startHarness } from './cdp-harness.mjs';
const H = await startHarness('fix53-res', { vitePort0: 5390, cdpPort0: 9390 });
const { cdp, evaluate } = H;
try {
  await cdp('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: 'about:blank' });
  await cdp('Page.navigate', { url: `${H.base}?w=compose&mock=new#lang=en` });
  for (let i = 0; i < 100; i++) { if (await evaluate(`!!document.querySelector('.compose-pane .ProseMirror')`)) break; await new Promise((r) => setTimeout(r, 300)); }
  const r = await evaluate(`(() => { const e = performance.getEntriesByType('resource').map((x) => x.name); return { n: e.length, compose: e.findIndex((n) => /Compose\.tsx/.test(n)), tiptap: e.findIndex((n) => /tiptap/i.test(n)) }; })()`);
  console.log(JSON.stringify(r));
} finally { await H.shutdown(); }
