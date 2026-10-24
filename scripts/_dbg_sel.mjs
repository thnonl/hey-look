import { sleep, startHarness } from './cdp-harness.mjs';
const H = await startHarness('dbg', { vitePort0: 5262 });
const { evaluate } = H;
try {
  await H.openApp('lang=en', 1280, 800);
  const html = await evaluate(`(() => { const para = (i) => '<p>Paragraph ' + i + ': the quarterly figures were reviewed on Monday and the open points are listed below. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p>'; let s = ''; let i = 0; while (s.length < 2*1024*1024) s += para(i++); return s; })()`);
  const t0 = Date.now();
  await evaluate(`window.__big = ${JSON.stringify(html)}; window.__store.getState().openCompose({ accountId: 'a1', to: ['a@b.c'], subject: 'big', bodyHtml: window.__big }); 1`);
  await sleep(12000);
  console.log(await evaluate(`(() => { const ed = document.querySelector('.cp-editor .tiptap')?.editor; if (!ed) return 'no editor'; const r = []; for (let i = 0; i < 3; i++) { const t = performance.now(); ed.getText(); r.push(Math.round(performance.now() - t)); } return JSON.stringify(r); })()`));
} finally { await H.shutdown(); }
