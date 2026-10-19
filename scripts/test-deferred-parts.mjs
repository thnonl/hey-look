// 1.0.7 D-044: the data of the big pictures and files of a draft comes in requests of its own (src/deferredParts.ts, src-tauri/src/draftopen.rs, tempstore.rs): one answer of
// 25 MB held the app's main thread for 0.3 s while a 19 MB draft opened (a webview round trip of 0.5 to 0.7 s), 14 answers of 1.8 MB hold it for 45 ms at a time.
//   node --experimental-strip-types scripts/test-deferred-parts.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFER_MARK, fillDeferred } from '../src/deferredParts.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const tok = (n) => n.toString(16).padStart(32, '0');

// everything in: the same parts, no request
{
  const parts = { html: '<p>x</p>', text: null, attachments: [{ filename: 'a', mime: 'a/b', dataBase64: 'QUJD' }], deferred: [] };
  const r = await fillDeferred(parts, async () => { throw new Error('no request expected'); });
  ok(r === parts, 'nothing left out: the parts as they are');
}

// markers in the HTML and in an attachment: put back, at most 4 requests at once, every token once
{
  const data = new Map([[tok(1), 'AAAA'.repeat(100)], [tok(2), 'BBBB'.repeat(100)], [tok(3), 'CCCC'.repeat(100)], [tok(4), 'DDDD'.repeat(100)], [tok(5), 'EEEE'.repeat(100)], [tok(6), 'FFFF'.repeat(100)]]);
  const html = `<img src="data:image/png;base64,${DEFER_MARK}${tok(1)}" data-name="a.png"><p>between</p><img src="data:image/png;base64,${DEFER_MARK}${tok(2)}"><img src='data:image/png;base64,${DEFER_MARK}${tok(3)}'>x<img src="data:image/png;base64,${DEFER_MARK}${tok(4)}">`;
  const parts = { html, text: 'hi', attachments: [{ filename: 'f.pdf', mime: 'application/pdf', dataBase64: DEFER_MARK + tok(5) }, { filename: 's.txt', mime: 'text/plain', dataBase64: 'QUJD' }, { filename: 'g.pdf', mime: 'application/pdf', dataBase64: DEFER_MARK + tok(6) }], deferred: [...data.keys()] };
  let running = 0, most = 0; const asked = [];
  const r = await fillDeferred(parts, async (t) => { running++; most = Math.max(most, running); asked.push(t); await new Promise((res) => setTimeout(res, 3)); running--; return data.get(t); });
  ok(most <= 4 && most >= 2, `up to 4 requests on their way at once (${most})`);
  assert.deepEqual([...asked].sort(), [...data.keys()].sort()); checks++;
  ok(r.html === html.replace(new RegExp(DEFER_MARK + '([0-9a-f]{32})', 'g'), (m, t) => data.get(t)), 'every marker of the HTML has its data');
  ok(!r.html.includes(DEFER_MARK) && r.html.includes('data-name="a.png"') && r.html.includes('<p>between</p>'), 'and nothing else of the HTML changed');
  ok(r.attachments[0].dataBase64 === data.get(tok(5)) && r.attachments[1].dataBase64 === 'QUJD' && r.attachments[2].dataBase64 === data.get(tok(6)), 'the attachments: the left-out ones have their data, the small one is as it was');
  ok(r.attachments[0].filename === 'f.pdf' && r.text === 'hi' && r.deferred.length === 0, 'the rest of the parts is as it was; nothing is left out any more');
  ok(parts.html === html && parts.deferred.length === 6, 'the parts that were handed in are not changed');
}

// a piece that is gone: the whole thing rejects (the page asks for the parts whole)
{
  const parts = { html: `<img src="data:image/png;base64,${DEFER_MARK}${tok(1)}"><img src="data:image/png;base64,${DEFER_MARK}${tok(2)}">`, text: null, attachments: [], deferred: [tok(1), tok(2)] };
  await assert.rejects(fillDeferred(parts, async (t) => { if (t === tok(2)) throw new Error('draft data is gone'); return 'AAAA'; }), /gone/); checks++;
  // no html (a text draft with a big file)
  const r = await fillDeferred({ html: null, text: 'x', attachments: [{ filename: 'f', mime: 'a/b', dataBase64: DEFER_MARK + tok(7) }], deferred: [tok(7)] }, async () => 'ZZZZ');
  ok(r.html === null && r.attachments[0].dataBase64 === 'ZZZZ', 'a draft without HTML');
}

// the wiring
{
  const c = read('src/components/Compose.tsx');
  ok(/const \[first, rc\] = await Promise\.all\(\[api\.draftEditorParts\(m\.id\), api\.draftRecipients\(m\.id\)/.test(c) && /fillDeferred\(first, api\.draftData\)\.catch\(\(\) => api\.draftEditorParts\(m\.id, true\)\)/.test(c), 'Compose reads the parts, fills the left-out data, and asks for the whole parts when a piece is gone');
  const lib = read('src-tauri/src/lib.rs');
  ok(/async fn draft_data\(token: String\) -> R<String>/.test(lib) && /^\s+draft_data,$/m.test(lib), 'the command and its handler');
  ok(/async fn draft_editor_parts\([^)]*all: Option<bool>\)/.test(lib) && /let defer = !all\.unwrap_or\(false\);/.test(lib), 'draft_editor_parts leaves data out unless `all`');
  ok(read('src-tauri/build.rs').includes('"draft_data"'), 'the manifest');
  for (const f of ['default.json', 'popout.json']) ok(read(`src-tauri/capabilities/${f}`).includes('"allow-draft-data"'), `${f}`);
  const rs = read('src-tauri/src/draftopen.rs');
  ok(/pub const MARK: &str = "hl-deferred-";/.test(rs) && DEFER_MARK === 'hl-deferred-', 'the marker is the same in the page and in the backend');
  ok(/pub const DEFER_MIN: usize = 256 \* 1024;/.test(rs), 'the threshold');
}

console.log(`test-deferred-parts: ${checks} checks ok`);
