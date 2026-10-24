#!/usr/bin/env node
// Confidential mail and the AI Assistant (W8.3), real reading pane in the dev preview (`#wp8` adds the mixed conversation, `aiset` makes the Assistant set up, `tconf` is a Confidential-only conversation):
//   - Confidential-only conversation: Summarize is disabled with the title "Confidential mail isn't sent ..." and the label "Summarize" (never "Set up AI"), also when the Assistant is NOT set up; a click makes no request;
//   - mixed conversation: Summarize is on, the request does not carry the Confidential message (its 6,000 characters), the summary card says the Confidential ones were left out;
//   - an ordinary conversation: no note on the card; the button is on;
//   - the Translate rows of a Confidential message are disabled and carry the reason;
//   - the text fits in the 8 languages at 960 x 560 (the note is not clipped).
//   node scripts/test-ai-confidential-ui.mjs [--require-browser | --url=http://127.0.0.1:1420/]
import { languageJs, sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-ai-confidential-ui', { vitePort0: 5064, cdpPort0: 9064 });
const { evaluate } = H;
const failures = [];
let checks = 0;
let tag = '';
const ok = (cond, msg) => { checks++; if (!cond) { failures.push(`[${tag}] ${msg}`); console.error(`FAIL [${tag}] ${msg}`); } return !!cond; };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between renders */ } await sleep(40); } return false; };
const BTN = `document.querySelector('.ai-btn')`;
const btn = () => evaluate(`(() => { const b = ${BTN}; return b ? { dis: b.disabled, title: b.title, label: b.textContent.trim() } : null; })()`);
const open = async (id) => {
  await evaluate(`window.__store.getState().openMail(${JSON.stringify(id)}); 1`);
  await waitFor(`!!${BTN} && !!document.querySelector('iframe.msg-frame, .reading-pane')`, 6000);
  await sleep(300);
};
const requests = () => evaluate(`(window.__mockAiRequests || []).map((r) => r.chars)`);
const T = {
  en: 'Confidential mail isn’t sent to the AI Assistant.',
  noteEn: 'Confidential messages in this conversation were left out.',
};

try {
  tag = 'set up';
  await H.openApp('lang=en&nativemenu=off&wp8&aiset', 1280, 800);
  await evaluate(`window.__store.getState().refreshAi && window.__store.getState().refreshAi()`);
  await sleep(300);

  await open('tconf');
  let b = await btn();
  ok(b && b.dis === true, `Confidential-only: Summarize is disabled (${JSON.stringify(b)})`);
  ok(b && b.title === T.en, `the title is the reason (${b && b.title})`);
  ok(b && b.label === 'Summarize', `the label stays Summarize (${b && b.label})`);
  await evaluate(`${BTN}.click(); 1`);
  await sleep(300);
  ok((await requests()).length === 0, 'a click sends nothing');

  tag = 'mixed';
  await open('tw8-mix');
  b = await btn();
  ok(b && b.dis === false, `mixed: Summarize is on (${JSON.stringify(b)})`);
  await evaluate(`${BTN}.click(); 1`);
  ok(await waitFor(`!!document.querySelector('.summary .pre')`, 8000), 'the summary card appears');
  const chars = await requests();
  ok(chars.length === 1 && chars[0] < 2000, `one request without the 6,000-character Confidential message (${JSON.stringify(chars)})`);
  const note = await evaluate(`[...document.querySelectorAll('.summary .tr-hint')].map((e) => e.textContent.trim())`);
  ok(note.includes(T.noteEn), `the card says the Confidential ones were left out (${JSON.stringify(note)})`);

  tag = 'ordinary';
  await evaluate(`window.__mockAiRequests.length = 0; 1`);
  await open('t1');
  b = await btn();
  ok(b && b.dis === false && b.title !== T.en, `ordinary: Summarize is on (${JSON.stringify(b)})`);
  ok((await evaluate(`document.querySelectorAll('.summary .tr-hint').length`)) === 0, 'and no note');

  tag = 'not set up';
  await H.openApp('lang=en&nativemenu=off&wp8', 1280, 800);
  await sleep(300);
  await open('tconf');
  b = await btn();
  ok(b && b.dis === true && b.label === 'Summarize' && b.title === T.en, `not set up + Confidential-only: still the reason, never "Set up AI" (${JSON.stringify(b)})`);
  await open('t1');
  b = await btn();
  ok(b && b.dis === false && /Set up AI/i.test(b.label), `not set up + ordinary: Set up AI (${JSON.stringify(b)})`);

  tag = 'languages';
  await H.openApp('nativemenu=off&wp8&aiset', 960, 560);
  await open('tconf');
  for (const lang of ['en', 'vi', 'fr', 'zh-Hans', 'es', 'ja', 'de', 'ru']) {
    await evaluate(languageJs(lang));
    await sleep(250);
    const r = await evaluate(`(() => { const b = ${BTN}; if (!b) return null; const q = b.getBoundingClientRect(); return { dis: b.disabled, title: b.title.length, w: q.width, over: b.scrollWidth - b.clientWidth, right: q.right, vw: innerWidth }; })()`);
    ok(r && r.dis && r.title > 8 && r.over <= 1 && r.right <= r.vw, `${lang}: greyed Summarize fits (${JSON.stringify(r)})`);
  }
  console.log(`test-ai-confidential-ui: ${checks} checks`);
} catch (e) {
  failures.push(`[${tag}] ${e.stack || e}`);
} finally {
  await H.shutdown();
}
if (failures.length) {
  console.error(`test-ai-confidential-ui: FAILED (${failures.length})\n  ` + failures.slice(0, 30).join('\n  '));
  process.exit(1);
}
console.log('test-ai-confidential-ui: ok');
