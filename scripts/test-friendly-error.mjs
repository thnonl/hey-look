#!/usr/bin/env node
// 1.0.11 RC1 QA O-2: the toast of a failed move of a message showed the operating system's words, "Failed: No connection could be made because the target machine actively refused it. (os error 10061)".
// friendlyError (src/store.ts) turns a refused / reset / unreachable connection into the sentence of "errors.unreachable" in the language of the app, with no "os error" and no raw OS text. Run in the
// dev preview (the real friendlyError and the real texts of the 8 languages).
//   node scripts/test-friendly-error.mjs [--require-browser]
import assert from 'node:assert/strict';
import { languageJs, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-friendly-error', { vitePort0: 6210 });
const { evaluate } = H;
const failures = [];
const RAW = [
  'No connection could be made because the target machine actively refused it. (os error 10061)',
  'Error: Connection refused (os error 111)',
  'An existing connection was forcibly closed by the remote host. (os error 10054)',
  'Connection reset by peer (os error 104)',
  'A socket operation was attempted to an unreachable network. (os error 10051)',
  'Network is unreachable (os error 101)',
];
try {
  await H.openApp('lang=en', 1280, 800);
  for (const lang of ['en', 'de', 'es', 'fr', 'ja', 'ru', 'vi', 'zh-Hans']) {
    await evaluate(languageJs(lang));
    const r = await evaluate(`import('/src/store.ts').then(async (s) => { const i = await import('/src/i18n/index.ts'); return JSON.stringify({ want: i.t('errors.unreachable'), got: ${JSON.stringify(RAW)}.map((x) => s.friendlyError(new Error(x))) }); })`).then((x) => JSON.parse(x));
    for (const [k, g] of r.got.entries()) {
      try {
        assert.equal(g, r.want, `${lang}: ${RAW[k]}`);
        assert.ok(!/os error|actively refused|10061/i.test(g), `${lang}: raw OS text in "${g}"`);
      } catch (e) {
        failures.push(String(e.message));
      }
    }
    // a text that is not a connection failure is still cut as before (the generic path is untouched)
    const other = await evaluate(`import('/src/store.ts').then((s) => s.friendlyError(new Error('Something else went wrong')))`);
    if (!/Something else went wrong/.test(other)) failures.push(`${lang}: generic text changed: ${other}`);
  }
} catch (e) {
  failures.push(String(e && e.stack ? e.stack : e));
} finally {
  await H.shutdown();
}
if (failures.length) {
  console.error(`test-friendly-error: FAILED (${failures.length})\n  ${failures.slice(0, 8).join('\n  ')}`);
  process.exit(1);
}
console.log('test-friendly-error: ok');
process.exit(0);
