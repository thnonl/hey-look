// scratch (never committed): runs the "second probe" of webkit-checks-107.md on the AI tab
import fs from 'node:fs';
import { startHarness, languageJs, sleep, inputs } from './cdp-harness.mjs';
const md = fs.readFileSync('E:/hey-mail/reports/v1-0-1/webkit-checks-107.md', 'utf8');
const line = md.split('\n').find((l) => l.startsWith('Second probe (fix53'));
const probe = line.slice(line.indexOf('`(()=>') + 1, line.indexOf('()`') + 2);
const H = await startHarness('fix53-probe2', { vitePort0: 5190, cdpPort0: 9190 });
const { evaluate } = H; const { typeText, click } = inputs(H, null, 'p');
try {
  for (const [w, h] of [[960, 560], [1280, 800]]) {
    await H.openApp('lang=en&modelsms=100', w, h);
    await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'ai' }); 1`);
    for (let i = 0; i < 100; i++) { if (await evaluate(`!!document.querySelector('.settings-body details.advanced')`)) break; await sleep(100); }
    await sleep(500);
    console.log(w, 'closed', await evaluate(probe));
    await click('.settings-body details.advanced summary'); await sleep(300);
    console.log(w, 'open', await evaluate(probe));
    await evaluate(`(() => { const e = document.getElementById('set-aiModelsUrl'); e.focus(); })()`);
    await typeText('http://127.0.0.1:31842/v1/models', 5); await sleep(900); console.log('value', await evaluate(`document.getElementById('set-aiModelsUrl').value + ' | sw=' + !!document.querySelector('details.advanced .switch')`));
    console.log(w, 'other server', await evaluate(probe));
  }
} finally { await H.shutdown(); }
