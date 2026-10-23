#!/usr/bin/env node
// The step-1 timing of 1.0.7 W13.13 (D-064): how long Reply / Reply all / Forward take from the press to the first compose frame and to the filled compose, on the fixture
// mails (scripts/lib/reply-fixtures.mjs), in the dev preview (src/devMock.ts: `window.__mockDelays` stand in for the stub IMAP server: replyHeaders = connect + login + select + fetch,
// quote = one picture, quoteFirst = the download of the whole raw message). The JS side (quote cleaning, Compose + TipTap mount) is the real code of this checkout, in the vite DEV build
// (unoptimised: the release exe is faster, the order of the costs is the same). Prints a JSON table; changes nothing.
//   node scripts/measure-reply-open.mjs [--require-browser] [--delays=1500,1200,40] [--runs=1]
import { sleep, startHarness, arg } from './cdp-harness.mjs';
import { FIXTURES, IDS } from './lib/reply-fixtures.mjs';
import { PROBE_INSTALL, PROBE_PRESS, PROBE_READ, fill } from './lib/reply-open-probe.mjs';

const H = await startHarness('measure-reply-open', { vitePort0: 5990 });
const { evaluate } = H;
const [hdr, first, per] = (arg('delays') ?? '1500,1200,40').split(',').map(Number);
const runs = Number(arg('runs') ?? 1);
const fn = (body) => `(() => { ${body} })()`;
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between two renders */ } await sleep(50); } return false; };
const rows = [];
try {
  await H.openApp('lang=en', 1280, 800);
  await evaluate(FIXTURES);
  await evaluate(`window.__store.getState().refresh().then(() => 1)`);
  await evaluate(`window.__store.getState().select('fx-att'); 1`); await waitFor(`!!document.querySelector('.rp-msg.open button')`, 20000); // (warm-up)
  for (const [name, id, button, cached] of [
    ['F-small Reply', IDS.small, 'Reply', false], ['F-big Reply all', IDS.big, 'Reply all', false], ['F-huge Reply', IDS.huge, 'Reply', false], ['F-huge Reply (cached)', IDS.huge, 'Reply', true],
    ['F-plain Reply', IDS.plain, 'Reply', false], ['F-att Forward', IDS.att, 'Forward', false], ['F-small Reply (cached)', IDS.small, 'Reply', true],
  ]) {
    for (let run = 0; run < runs; run++) {
      await evaluate(`window.__store.getState().openCompose(null, { restore: false }); window.__mockDelays = { replyHeaders: ${cached ? 0 : hdr}, quoteFirst: ${cached ? 0 : first}, quote: ${per} }; window.__attachmentCalls = []; 1`);
      await evaluate(`window.__store.getState().select(${JSON.stringify(id)}); 1`);
      if (!(await waitFor(`!!document.querySelector('.rp-msg.open button')`, 20000))) { rows.push({ name, error: 'the message did not open' }); continue; }
      await sleep(400);
      await evaluate(fn(PROBE_INSTALL));
      const pr = await evaluate(fn(fill(PROBE_PRESS, button)));
      if (!pr.pressed) { rows.push({ name, error: 'no button' }); continue; }
      const done = await waitFor(`window.__replyOpen.filled !== null`, 40000);
      await sleep(500);
      const r = await evaluate(fn(PROBE_READ));
      rows.push({ name, run, ...(({ shellMs, statusMs, statusGoneMs, filledMs, pressMs, gapMax, longTaskMax, toMovedPx }) => ({ shellMs, statusMs, statusGoneMs, filledMs, pressMs, gapMax, longTaskMax, toMovedPx }))(r), done });
    }
  }
  console.log(JSON.stringify({ delays: { replyHeaders: hdr, quoteFirst: first, quotePerPicture: per }, rows }, null, 1));
} finally {
  await H.shutdown();
}
