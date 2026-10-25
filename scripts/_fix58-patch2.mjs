import fs from 'node:fs';
const p = 'scripts/test-quit-key-ui.mjs';
let s = fs.readFileSync(p, 'utf8');
s = s.replace("    await openThread('tw8-mix', ['Plain first message', 'ZEBRA-CONF']);\n    assert.equal(await frameCount(), 2);",
"    await openThread('tw8-mix', ['ZEBRA-CONF']); // (the older message is folded: open it)\n    await evaluate(`(document.querySelector('.rp-msg:not(.open) .rp-msg-head') || document.querySelector('.rp-msg:not(.open)')).click(); 1`);\n    assert.ok(await waitFor(`document.querySelectorAll('iframe.msg-frame').length === 2 && [...document.querySelectorAll('iframe.msg-frame')].every((f) => f.contentDocument?.body?.textContent.trim())`, 8000), 'no second frame');\n    await sleep(500);");
fs.writeFileSync(p, s);
