#!/usr/bin/env node
// The step-1 timing of 1.0.7 W13.6 (REQ-13.6, spec-107-wp13.md): how long a mail takes from the click to the status "Opening message…" and to its visible frame, and what each phase costs
// (R1 get_thread, R2 DOMPurify, R3 picture placeholders, R5 buildDarkSheet, R6 first measurement; the marks of src/perfMarks.ts), on the fixture mails (scripts/lib/reply-fixtures.mjs), in the dev
// preview (src/devMock.ts: `window.__mockDelays.thread` stands in for the read of the conversation). The JS side is the real code of this checkout in the vite DEV build (unoptimised: the release
// exe is faster, the order of the costs is the same). Prints a JSON table; changes nothing.
//   node scripts/measure-open-mail.mjs [--require-browser] [--thread=300] [--runs=2] [--dark]   (--dark: the mail is shown on the dark canvas, R5 buildDarkSheet)
import { sleep, startHarness, arg, flag } from './cdp-harness.mjs';
import { FIXTURES, IDS } from './lib/reply-fixtures.mjs';
import { PROBE_INSTALL, PROBE_PRESS, PROBE_READ, fill } from './lib/open-mail-probe.mjs';

const H = await startHarness('measure-open-mail', { vitePort0: 5990 });
const { evaluate } = H;
const thread = Number(arg('thread') ?? 300);
const runs = Number(arg('runs') ?? 2);
const fn = (body) => `(() => { ${body} })()`;
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between two renders */ } await sleep(50); } return false; };
const rows = [];
try {
  await H.openApp('lang=en', 1280, 800);
  await evaluate(FIXTURES);
  if (flag('dark')) await evaluate(`window.__store.getState().setPrefs({ mailCanvas: 'dark' }); 1`);
  await evaluate(`window.__store.getState().refresh().then(() => 1)`);
  for (const [name, id] of [['F-small 20 KB', IDS.small], ['F-big 500 KB', IDS.big], ['F-huge 2 MB', IDS.huge], ['F-plain 1 MB', IDS.plain]]) {
    for (let run = 0; run < runs; run++) {
      await evaluate(`window.__store.getState().select(null); window.__mockDelays = { thread: ${thread} }; 1`);
      await sleep(600);
      await evaluate(fn(PROBE_INSTALL));
      await evaluate(fn(fill(PROBE_PRESS, id)));
      const done = await waitFor(`window.__openMail.frame !== null`, 60000);
      await sleep(700);
      const r = await evaluate(fn(PROBE_READ));
      await evaluate(`window.__openMail.stop(); 1`);
      rows.push({ name, run, ...r, done });
    }
  }
  console.log(JSON.stringify({ thread, rows }, null, 1));
} finally {
  await H.shutdown();
}
