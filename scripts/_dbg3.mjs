import { startHarness, sleep } from './cdp-harness.mjs';
const H = await startHarness('dbg3', { vitePort0: 5997 });
const ev = H.evaluate;
H.on((m) => { if (m.method === 'Runtime.exceptionThrown') console.log('EXC', JSON.stringify(m.params.exceptionDetails).slice(0, 500)); });
try {
  await H.openApp('lang=en', 1100, 760);
  for (const url of ['?w=scheduled', '?w=search&q=invoice', '?w=event', '?w=settings&tab=appearance']) {
    await H.cdp('Page.navigate', { url: 'about:blank' });
    await H.cdp('Page.navigate', { url: `${H.base}${url}#lang=en` });
    await sleep(3500);
    console.log(url, await ev(`JSON.stringify({ title: document.title, root: document.querySelector('[data-popout]')?.dataset.popout, text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 160), rows: document.querySelectorAll('.ml-row').length })`));
  }
} finally { await H.shutdown(); }
