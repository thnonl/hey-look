import fs from 'node:fs';
const p = 'scripts/test-quit-key-ui.mjs';
let s = fs.readFileSync(p, 'utf8');
// header comment
s = s.replace("focus in a text box and in the document of a message frame (main window and a reader window), and the key press is taken (preventDefault) only where it quits.",
"focus in a text box and in the document of a message frame (main window and a reader window; a plain and a Confidential mail, also after the mail has changed and the frame is\n//   written again: D-112, the frame of a Confidential mail had no guard), and the key press is taken (preventDefault) only where it quits.");
// helpers
s = s.replace("const openFirstThread = async", `/** every message frame of the page: a Ctrl+Q keydown in its document, was it taken? (array, one entry per frame) */
const allFrameKeys = () => evaluate(\`[...document.querySelectorAll('iframe.msg-frame')].map((f) => { const d = f.contentDocument; const ev = new KeyboardEvent('keydown', { key: 'q', code: 'KeyQ', ctrlKey: true, bubbles: true, cancelable: true, view: d.defaultView }); d.body.dispatchEvent(ev); return ev.defaultPrevented; })\`);
/** the page is the real thing when the person focuses a frame and presses the key: the frame gets the focus, the press goes to its document */
const focusFrame = (i) => evaluate(\`(() => { const f = document.querySelectorAll('iframe.msg-frame')[\${i}]; f.contentWindow.focus(); return f.contentDocument.hasFocus(); })()\`);
const frameCount = () => evaluate(\`document.querySelectorAll('iframe.msg-frame').length\`);
/** opens the thread and waits until its frames hold the text (a frame that still shows the mail before is not the new one) */
const openThread = async (id, needles) => {
  await evaluate(\`window.__store.getState().openMail(\${JSON.stringify(id)}); 1\`);
  const ok = await waitFor(\`(() => { const t = [...document.querySelectorAll('iframe.msg-frame')].map((f) => f.contentDocument?.body?.textContent || ''); return \${JSON.stringify(needles)}.every((n) => t.some((x) => x.includes(n))); })()\`, 10000);
  assert.ok(ok, \`no frame with \${needles} for \${id}\`);
  await sleep(500); // (the document is hooked a few ms after it is parsed)
};
const openFirstThread = async`);
// new checks before "Windows: a press in the frame is not taken"
const marker = "  await check('Windows: a press in the frame is not taken and sends nothing'";
const add = `  await check('Linux: every frame takes Ctrl+Q - plain and Confidential mail, also after the mail changed (D-112)', async () => {
    await H.openApp('lang=en&os=linux&wp8', 1280, 800);
    await spy();
    const steps = [['tw8-sel', ['Quarterly budget'], 'plain'], ['tconf', ['Revenue is down'], 'Confidential'], ['tw8-sel', ['Quarterly budget'], 'plain again'], ['tconf', ['Revenue is down'], 'Confidential again'], ['tw8-att-conf', ['Four attachments'], 'Confidential with attachments']];
    for (const [id, needles, what] of steps) {
      await openThread(id, needles);
      assert.equal(await frameCount(), 1, what);
      await evaluate('window.__emits.length = 0; 1');
      assert.deepEqual(await allFrameKeys(), [true], \`\${what}: the press in the frame is taken\`);
      await sleep(100);
      assert.equal(await emits(), 1, \`\${what}: one quit-key (dispatched)\`);
      assert.equal(await focusFrame(0), true, \`\${what}: the frame has the focus\`);
      await key('q', 'KeyQ', 81);
      assert.equal(await emits(), 2, \`\${what}: one more quit-key (real key with the focus in the frame)\`);
    }
  });
  await check('Linux: a conversation of a plain and a Confidential message: both frames take Ctrl+Q', async () => {
    await H.openApp('lang=en&os=linux&wp8', 1280, 800);
    await spy();
    await openThread('tw8-mix', ['Plain first message', 'ZEBRA-CONF']);
    assert.equal(await frameCount(), 2);
    await evaluate('window.__emits.length = 0; 1');
    assert.deepEqual(await allFrameKeys(), [true, true]);
    await sleep(100);
    assert.equal(await emits(), 2, 'one quit-key per press');
    for (const i of [0, 1]) {
      assert.equal(await focusFrame(i), true, \`frame \${i} has the focus\`);
      await key('q', 'KeyQ', 81);
    }
    assert.equal(await emits(), 4);
  });
  await check('Linux: the frame of a reader window takes Ctrl+Q - plain and Confidential mail', async () => {
    for (const [thread, needle] of [['t1', ''], ['tconf', 'Revenue is down']]) {
      await cdp('Page.navigate', { url: 'about:blank' });
      await cdp('Page.navigate', { url: \`\${H.base}?w=reader&thread=\${thread}#lang=en&os=linux\` });
      assert.ok(await waitFor(\`!!document.querySelector('.reader-win iframe.msg-frame') && \${FRAME_READY} && document.querySelector('iframe.msg-frame').contentDocument.body.textContent.includes(\${JSON.stringify(needle)})\`, 25000), \`no reader frame for \${thread}\`);
      await sleep(500);
      await spy();
      assert.deepEqual(await allFrameKeys(), [true], \`\${thread}: taken\`);
      await sleep(100);
      assert.equal(await emits(), 1, \`\${thread}: dispatched\`);
      assert.equal(await focusFrame(0), true);
      await key('q', 'KeyQ', 81);
      assert.equal(await emits(), 2, \`\${thread}: real key\`);
    }
  });
`;
if (!s.includes(marker)) throw new Error('marker');
s = s.replace(marker, add + marker);
fs.writeFileSync(p, s);
