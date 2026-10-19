// 1.0.7 D-045: the big pictures and attachments of a draft are sent ahead of the save, one request each (src/draftUpload.ts, src-tauri/src/draftupload.rs).
// One request with a 19 MB draft held the app's main thread for 0.3 to 0.5 s (QA round 4: a webview round trip of 530 ms during the save).
//   node --experimental-strip-types scripts/test-draft-upload.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { slimDraft, UPLOAD_MIN } from '../src/draftUpload.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

const big = (n, ch = 'A') => ch.repeat(n);
const mk = (inline, attachments = []) => ({ accountId: 'a1', to: ['x@example.com'], cc: [], bcc: [], subject: 's', html: '<p>x</p>', text: 'x', references: [], attachments, inline });
const pic = (i, data) => ({ cid: `c${i}@x`, filename: `p${i}.png`, mime: 'image/png', dataBase64: data });
const file = (name, data) => ({ filename: name, mime: 'application/pdf', dataBase64: data });

// a draft without a big part: the same draft, nothing sent
{
  const sent = [];
  const d = mk([pic(0, 'AAAA')], [file('a.pdf', 'BBBB')]);
  const r = await slimDraft(d, async (id, data) => { sent.push([id, data]); });
  ok(r.draft === d && r.uploads.length === 0 && sent.length === 0, 'small parts travel with the draft');
  const r2 = await slimDraft({ ...d, inline: undefined }, async () => { throw new Error('nothing to send'); });
  ok(r2.uploads.length === 0, 'a draft without a list of pictures');
}

// big parts: data left out, named in `uploads` (position and id), small ones kept; one request at a time, in the order of the draft
{
  const sent = [];
  let running = 0, most = 0, n = 0;
  const d = mk([pic(0, big(UPLOAD_MIN)), pic(1, 'tiny'), pic(2, big(UPLOAD_MIN + 5, 'B'))], [file('big.pdf', big(UPLOAD_MIN + 1, 'C')), file('small.txt', 'QUJD')]);
  const r = await slimDraft(d, async (id, data) => { running++; most = Math.max(most, running); await new Promise((res) => setTimeout(res, 2)); sent.push([id, data.length, data[0]]); running--; }, () => `id${n++}`);
  ok(most === 1, `one request at a time (${most} at once)`);
  assert.deepEqual(r.uploads, [{ inline: false, index: 0, id: 'id0' }, { inline: true, index: 0, id: 'id1' }, { inline: true, index: 2, id: 'id2' }]); checks++;
  assert.deepEqual(sent, [['id0', UPLOAD_MIN + 1, 'C'], ['id1', UPLOAD_MIN, 'A'], ['id2', UPLOAD_MIN + 5, 'B']]); checks++;
  ok(r.draft.attachments[0].dataBase64 === '' && r.draft.attachments[1].dataBase64 === 'QUJD', 'the big attachment is left out, the small one stays');
  ok(r.draft.inline[0].dataBase64 === '' && r.draft.inline[1].dataBase64 === 'tiny' && r.draft.inline[2].dataBase64 === '', 'the big pictures are left out, the small one stays');
  ok(r.draft.inline[0].cid === 'c0@x' && r.draft.inline[2].filename === 'p2.png' && r.draft.subject === 's' && r.draft.html === '<p>x</p>', 'everything else of the draft is as it was');
  ok(d.inline[0].dataBase64.length === UPLOAD_MIN && d.attachments[0].dataBase64.length === UPLOAD_MIN + 1, 'the draft that was handed in is not changed');
}

// a part that could not be sent stays in the draft (the save still has everything: in the one big request of before)
{
  const d = mk([pic(0, big(UPLOAD_MIN)), pic(1, big(UPLOAD_MIN, 'B'))]);
  let n = 0;
  const r = await slimDraft(d, async (id) => { if (id === 'id0') throw new Error('refused'); }, () => `id${n++}`);
  ok(r.draft.inline[0].dataBase64.length === UPLOAD_MIN, 'the part that was refused keeps its data');
  ok(r.draft.inline[1].dataBase64 === '' && r.uploads.length === 1 && r.uploads[0].id === 'id1', 'the other one was sent');
}

// the wiring: the page sends ahead, then names the parts; the backend has the command everywhere a command must be
{
  const api = read('src/api.ts');
  ok(/saveDraft: async[\s\S]{0,700}slimDraft\(draft[\s\S]{0,300}invoke<void>\("draft_upload"[\s\S]{0,300}invoke<DraftSaveResult>\("save_draft", \{ draft: slim, replaces: replaces \?\? null, uploads/.test(api), 'api.saveDraft sends ahead with draft_upload, then save_draft with `uploads`');
  const lib = read('src-tauri/src/lib.rs');
  ok(/fn draft_upload\(id: String, data_base64: String\)/.test(lib) && /draftupload::resolve\(&mut draft, uploads\)\?;\s*ensure_draft_has_content/.test(lib), 'save_draft puts the uploads back before anything looks at the draft');
  ok(/^\s+draft_upload,$/m.test(lib), 'the command is in the handler');
  ok(read('src-tauri/build.rs').includes('"draft_upload"'), 'in the command manifest (build.rs)');
  for (const f of ['default.json', 'popout.json']) ok(read(`src-tauri/capabilities/${f}`).includes('"allow-draft-upload"'), `${f} allows it (the compose window saves its own drafts)`);
  const mock = read('src/devMock.ts');
  ok(/case "draft_upload"/.test(mock) && /draft upload missing/.test(mock), 'the dev preview mock has it');
  ok(/catch \(e\) \{[\s\S]{0,260}draft upload missing[\s\S]{0,200}invoke<DraftSaveResult>\("save_draft", \{ draft, replaces: replaces \?\? null, uploads: null \}\)/.test(api), 'an upload that is gone: the draft is sent whole');
  ok(!/DRAFT_UPLOAD_MISSING/.test(lib), 'no new code for the person: the error is internal (no dictionary entry needed)');
}

console.log(`test-draft-upload: ${checks} checks ok`);
