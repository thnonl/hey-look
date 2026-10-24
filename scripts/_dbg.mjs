import { startHarness } from './cdp-harness.mjs';
const H = await startHarness('dbg', { vitePort0: 5997 });
try {
  await H.openApp('lang=en', 1280, 800);
  const r = await H.evaluate(`(async () => {
    const m = await import('/src/editor/quoteClean.ts');
    const para = (i) => '<p>Paragraph ' + i + ': the quarterly figures were reviewed on Monday and the open points are listed below. ' + 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor. '.repeat(3) + '</p>';
    let html = '<div>'; let i = 0; while (html.length < 2 * 1024 * 1024) html += para(i++); html += '</div>';
    const out = [];
    for (let k = 0; k < 3; k++) { const t = performance.now(); const q = m.quoteOf({ html, text: null }, 'cut'); out.push([Math.round(performance.now() - t), q.html.length]); }
    return JSON.stringify({ htmlBytes: html.length, runs: out });
  })()`);
  console.log(r);
} finally { await H.shutdown(); }
