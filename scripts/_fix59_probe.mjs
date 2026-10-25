// scratch: reproduce V107-R10A-1 on the dev mock (not committed)
import { sleep, startHarness } from './cdp-harness.mjs';
const H = await startHarness('fix59-probe', { vitePort0: 5700 });
const { evaluate } = H;
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(js)) return true; await sleep(100); } return false; };
const up = `!!document.querySelector('.cp-editor .tiptap')?.editor && !!document.querySelector('.sig-select')`;
const shape = () => evaluate(`(() => { const ed = document.querySelector('.cp-editor .tiptap').editor; return ed.getJSON().content.map((n) => n.type === 'paragraph' ? 'p(' + (n.content ?? []).map((c) => c.text ?? c.type).join('') + ')' : n.type).join(' | '); })()`);
const clickButton = (re) => evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => ${re}.test((x.getAttribute('aria-label') || x.textContent).trim())); if (!b) return false; b.click(); return true; })()`);
try {
  await H.openApp('lang=en' + (process.argv.includes('--nosig') ? '&nodefaultsig' : ''), 1280, 800);
  await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Failed [smtpfail]' }); 1`);
  console.log('up', await waitFor(up, 15000));
  await sleep(800);
  console.log('start', await shape());
  await evaluate(`(() => { const ed = document.querySelector('.cp-editor .tiptap').editor; ed.commands.focus('end'); ed.commands.insertContent('below'); return 1; })()`);
  await sleep(300);
  console.log('typed below', await shape());
  console.log('html', await evaluate(`(async () => { const m = await import('/src/editor/messageBody.ts'); const ed = document.querySelector('.cp-editor .tiptap').editor; return m.messageHtml(ed.getJSON(), { sig: '<p>SIGTEXT</p>', base: { family: 'x', size: 'y' }, pictures: 'data' }).html; })()`).catch((e) => String(e)));
  await clickButton(/^Send$/);
  const back = await waitFor(`document.body.innerText.includes('Send failed') && ${up}`, 40000);
  await sleep(1200);
  console.log('after failed send', back, await shape());
} finally { await H.shutdown(); }
