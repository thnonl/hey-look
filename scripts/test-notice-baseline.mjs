#!/usr/bin/env node
// A link inside a sentence of a notice sits on the baseline of that sentence (1.0.7 owner report: "This looks like a newsletter. Unsubscribe" had the link
// lower than the words in front of it, because `.notice .link` was an inline-block with a 24 px line-height and `vertical-align: middle`). The reading pane
// shows each notice in the dev preview (src/devMock.ts); for every link in it the baseline of its text is measured against the baseline of the text in front of
// it (scripts/lib/baseline-probe.mjs): at most 1 px apart, in light and dark, in English, German, Russian, Japanese and Vietnamese, with the notice 360, 600
// and 1000 px wide and at the smallest window the app has (960 px, minWidth in tauri.conf.json; a window of 360 px does not exist, the panes would be 47 px).
// A link that wraps to a line of its own must be one normal line below the sentence (the same distance two lines of plain text have), and every link keeps
// a click box of at least 24 px.
//
//   node scripts/test-notice-baseline.mjs [--require-browser | --url=http://127.0.0.1:1420/] [--quick] [--json=report.json] [--shots=dir]
//   --only=id,id --langs=en,de --widths=360,window-960 --themes=light  narrow the matrix (to take screenshots, or to look at one case)
//   --quick  English, German and Japanese, light and dark, the notice 360 px wide and at the smallest window; the full run (no flag) is all five languages and four widths
import fs from 'node:fs';
import path from 'node:path';
import { flag, arg, sleep, startHarness } from './cdp-harness.mjs';
import { PROBE_JS } from './lib/baseline-probe.mjs';

const list = (name, all) => (arg(name) ? arg(name).split(',').map((x) => (/^\d+$/.test(x) ? Number(x) : x)) : all);
const LANGS = list('langs', flag('quick') ? ['en', 'de', 'ja'] : ['en', 'de', 'ru', 'ja', 'vi']);
const WIDTHS = list('widths', flag('quick') ? [360, 'window-960'] : [360, 600, 1000, 'window-960']);
const THEMES = list('themes', flag('quick') ? ['light', 'dark'] : ['light', 'dark']);
const TOLERANCE = 1;
const MIN_BOX = 24;

// what each notice needs to be on screen: the thread to open (or the hash of the dev preview), and the part of the page that holds it (`pick`: which of the matches)
const MSG = '.rp-msg-body .notice:not(.conf-banner)';
const SCENARIOS = [
  { id: 'newsletter', thread: 'nl1', root: '.rp-msg-body > .notice:not(.conf-banner)', pick: 0, links: 1 },
  { id: 'blocked-pictures', thread: 'nl1', root: '.rp-msg-body > .notice:not(.conf-banner)', pick: 1, links: 2 },
  { id: 'signature-invalid', thread: 't12', root: MSG, pick: 0, links: 1 },
  { id: 'signature-unknown-key', thread: 't13', root: MSG, pick: 0, links: 2 },
  { id: 'invite-not-on-list', thread: 't22', root: MSG, pick: 0, links: 1 },
  { id: 'invite-published', thread: 't19', root: MSG, pick: 0, links: 1 },
  { id: 'update-offline', hash: 'settings=about&update=offline', root: '.settings .notice.bad', pick: 0, links: 1 },
  { id: 'update-error', hash: 'settings=about&update=error', root: '.settings .notice.bad', pick: 0, links: 1 },
  { id: 'update-notes-cut', hash: 'settings=about&update=long', root: '.settings .update-notes', pick: 0, links: 1, box: false }, // a plain `.link` in running text: the control (its click box is not part of this test)
  { id: 'update-no-release', hash: 'settings=about&update=norelease', root: '.settings .notice.info', pick: 0, links: 1 },
];

const H = await startHarness('test-notice-baseline', { vitePort0: 5740 });
const { evaluate } = H;
const failures = [];
let checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failures.push(msg); console.error(`FAIL ${msg}`); } };
const rows = [];

try {
  for (const sc of SCENARIOS) {
    if (arg('only') && !arg('only').split(',').includes(sc.id)) continue;
    await H.openApp(sc.hash ?? 'lang=en&light', 1800, 800);
    await evaluate(PROBE_JS);
    if (sc.thread) await evaluate(`window.__store.getState().select(${JSON.stringify(sc.thread)}).then(() => 1)`);
    for (const theme of THEMES) for (const lang of LANGS) for (const width of WIDTHS) {
      await evaluate(`window.__store.getState().setPrefs({ theme: ${JSON.stringify(theme)}, language: ${JSON.stringify(lang)} }); 1`);
      const forced = typeof width === 'number';
      await H.cdp('Emulation.setDeviceMetricsOverride', { width: forced ? 1800 : 960, height: 800, deviceScaleFactor: 1, mobile: false });
      let found = 0;
      for (let i = 0; i < 100 && !found; i++) { await sleep(100); found = await evaluate(`document.querySelectorAll(${JSON.stringify(sc.root)}).length > ${sc.pick ?? 0} ? 1 : 0`); }
      const tag = `${sc.id} ${theme} ${lang} ${forced ? `${width}px` : width}`;
      ok(found > 0, `${tag}: the notice is not on screen`);
      if (!found) continue;
      await sleep(150);
      // a forced width is the width of the notice itself (the window is wide, so the pane has room): what the sentence does in a narrow pane
      await evaluate(`document.querySelectorAll(${JSON.stringify(sc.root)}).forEach((n) => { n.style.width = ${forced ? `'${width}px'` : `''`}; n.style.boxSizing = 'border-box'; }); 1`);
      const noticeW = await evaluate(`Math.round(document.querySelectorAll(${JSON.stringify(sc.root)})[${sc.pick ?? 0}].getBoundingClientRect().width)`);
      const got = await evaluate(`window.__baselines(document.querySelectorAll(${JSON.stringify(sc.root)})[${sc.pick ?? 0}])`);
      ok(got.length >= sc.links, `${tag}: expected ${sc.links} link(s) in the notice, found ${got.length}`);
      if (arg('shots')) {
        const r = await evaluate(`(() => { const b = document.querySelectorAll(${JSON.stringify(sc.root)})[${sc.pick ?? 0}].getBoundingClientRect(); return { x: Math.max(0, b.left - 6), y: Math.max(0, b.top - 6), width: b.width + 12, height: b.height + 12, scale: 3 }; })()`);
        fs.mkdirSync(arg('shots'), { recursive: true });
        fs.writeFileSync(path.join(arg('shots'), `${sc.id}-${theme}-${lang}-${width}.png`), Buffer.from((await H.cdp('Page.captureScreenshot', { format: 'png', clip: r })).data, 'base64'));
      }
      for (const g of got) {
        rows.push({ scenario: sc.id, theme, lang, width, noticeW: noticeW, ...g });
        if (g.sameLine === null) continue;
        if (g.sameLine) ok(Math.abs(g.offset) <= TOLERANCE, `${tag}: "${g.label}" is ${g.offset} px off the baseline of the sentence (at most ${TOLERANCE})`);
        // a link on a line of its own (or wrapped inside) makes that line no taller than a line of plain text: its box is the line-height of the sentence, not more
        ok(Math.abs(g.lineH - g.refPitch) <= TOLERANCE, `${tag}: "${g.label}" takes ${g.lineH} px of its line${g.sameLine ? '' : ` (it wraps, ${g.pitch} px below the sentence)`}, a line of text is ${g.refPitch} px`);
        if (sc.box !== false) ok(g.h >= MIN_BOX - 0.5, `${tag}: "${g.label}" has a click box of ${g.h} px high (at least ${MIN_BOX})`);
      }
    }
  }
  if (arg('json')) fs.writeFileSync(arg('json'), JSON.stringify(rows, null, 1));
} catch (e) {
  ok(false, `threw: ${e.message}`);
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-notice-baseline: ${failures.length} failure(s) in ${checks} checks`); process.exit(1); }
console.log(`test-notice-baseline: ${checks} checks passed`);
