import { sleep, startHarness } from './cdp-harness.mjs';
import { FIXTURES, IDS } from './lib/reply-fixtures.mjs';
import { PROBE_INSTALL, PROBE_PRESS, PROBE_READ, fill } from './lib/reply-open-probe.mjs';
const rate = Number(process.argv[2] ?? 4);
const H = await startHarness('dbg-trace', { vitePort0: 5993 });
const { evaluate, cdp } = H;
const fn = (b) => `(() => { ${b} })()`;
const waitFor = async (js, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch {} await sleep(30); } return false; };
try {
  await H.openApp('lang=en', 1280, 800);
  await evaluate(FIXTURES);
  await evaluate(`window.__store.getState().refresh().then(() => 1)`);
  for (let i = 0; i < 4; i++) { await evaluate(`window.__store.getState().select('fx-att'); 1`); if (await waitFor(`!!document.querySelector('.rp-msg.open button')`, 6000)) break; }
  await sleep(5000); // quoteClean prefetch
  for (const r of [1, rate]) {
    await evaluate(`window.__store.getState().openCompose(null, { restore: false }); 1`);
    await evaluate(`window.__store.getState().select(${JSON.stringify(IDS.huge)}); 1`);
    await waitFor(`!!document.querySelector('.rp-msg.open button')`);
    await sleep(500);
    await evaluate(`window.__mockDelays = { replyHeaders: 2500, quoteFirst: 300, quote: 10 }; 1`);
    await cdp('Emulation.setCPUThrottlingRate', { rate: r });
    await evaluate(fn(PROBE_INSTALL));
    await cdp('Profiler.enable'); await cdp('Profiler.setSamplingInterval', { interval: 500 }); await cdp('Profiler.start');
    await evaluate(fn(fill(PROBE_PRESS, 'Reply')));
    await waitFor(`window.__replyOpen.filled !== null`, 30000);
    const prof = (await cdp('Profiler.stop')).profile;
    const res = await evaluate(fn(PROBE_READ));
    await cdp('Emulation.setCPUThrottlingRate', { rate: 1 });
    // aggregate self time by function, split at shellMs / statusMs relative to the first sample
    const byId = new Map(prof.nodes.map((n) => [n.id, n]));
    let t = 0; const t0 = prof.startTime; const phases = { beforeShell: new Map(), betweenShellAndFill: new Map(), idle: 0 };
    prof.samples.forEach((id, i) => {
      const dt = prof.timeDeltas[i] / 1000; t += dt;
      const n = byId.get(id); const name = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').slice(-1)[0].split('?')[0]}`;
      if (name.startsWith('(idle)') || name.startsWith('(program)')) { phases.idle += dt; return; }
      const url = n.callFrame.url.split('/').slice(-1)[0].split('?')[0] || '(native)'; const ph = t <= (res.shellMs + 40) ? phases.beforeShell : phases.betweenShellAndFill;
      ph.set(name, (ph.get(name) || 0) + dt); const bu = ph === phases.beforeShell ? (phases.urlBefore ??= new Map()) : (phases.urlAfter ??= new Map()); bu.set(url, (bu.get(url) || 0) + dt);
    });
    const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${Math.round(v)}ms ${k}`);
    console.log(JSON.stringify({ rate: r, shellMs: res.shellMs, pressMs: res.pressMs, statusMs: res.statusMs, filledMs: res.filledMs, longTaskMax: res.longTaskMax, gapMax: res.gapMax, beforeByFile: top(phases.urlBefore ?? new Map()), beforeShellTop: top(phases.beforeShell), afterShellTop: top(phases.betweenShellAndFill) }, null, 1));
  }
} finally { await H.shutdown(); }
