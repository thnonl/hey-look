#!/usr/bin/env node
// 1.0.7 fix39 (D-103; Mac QA bisect: the main page's WebContent grew by about the size of every big get_thread answer, 80 calls of a 2 MB conversation +35 MB dirty, while Windows / Chrome stay flat): a conversation
// reaches the page as ONE raw buffer, not as a JSON string with the bodies in it (src-tauri/src/lib.rs `get_thread_packed`, src/threadPack.ts `unpackThread`).
//   - the packing round trip: bodies byte for byte (multi-byte text, an empty body, no body, a leading U+FEFF, 2 MB), metadata without bodies, a cut or padded buffer throws, a plain list of bytes is accepted
//   - the wiring: api.getThread asks get_thread_packed and nothing else in the page asks get_thread, the command is in the three places and in the capabilities of the windows that read conversations,
//     the page keeps no raw buffer (no module-level store of the answer), the dev preview packs the same way
//   node --experimental-strip-types scripts/test-thread-pack.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packThread, unpackThread } from '../src/threadPack.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let n = 0;
const check = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`FAIL ${name}: ${e.message}`); process.exitCode = 1; } };
const msg = (id, html, text) => ({ id, accountId: 'a1', folder: 'inbox', subject: `S ${id}`, fromName: 'Ann', fromEmail: 'ann@example.com', to: 'me@example.com', cc: '', date: 1, html, text, seen: true, flagged: false, attachments: [], canUnsubscribe: false, security: null, confidential: false, invite: null, importance: 'normal' });

check('the round trip gives the same messages: multi-byte text, an empty body, no body, a leading BOM', () => {
  const big = `<p>${'é€😀 '.repeat(500_000)}</p>`; // about 2.5 MB
  const list = [msg('a', big, 'plain ü'), msg('b', null, ''), msg('c', '<p>x</p>', null), msg('d', '﻿<p>bom</p>', '﻿text'), msg('e', null, null)];
  const out = unpackThread(packThread(list));
  assert.deepEqual(out, list);
  assert.equal(out[0].html.length, big.length);
  assert.equal(out[3].html.charCodeAt(0), 0xfeff, 'a BOM in a body is kept');
  assert.equal(out[1].text, '', 'an empty body is not none');
  assert.equal(out[1].html, null);
});

check('an empty conversation', () => {
  assert.deepEqual(unpackThread(packThread([])), []);
});

check('the metadata part carries no body', () => {
  const buf = packThread([msg('a', '<p>SECRETBODY</p>', 'SECRETTEXT')]);
  const metaLen = new DataView(buf).getUint32(0, true);
  const meta = new TextDecoder().decode(new Uint8Array(buf, 4, metaLen));
  assert.ok(!meta.includes('SECRETBODY') && !meta.includes('SECRETTEXT'), meta);
  assert.equal(JSON.parse(meta)[0].html, null);
  assert.ok(metaLen < 600, `${metaLen} bytes of metadata`);
});

check('a cut or padded answer throws, a plain list of bytes is read', () => {
  const buf = packThread([msg('a', '<p>one</p>', 'one'), msg('b', '<p>two</p>', null)]);
  for (const cut of [0, 3, 10, buf.byteLength - 1]) assert.throws(() => unpackThread(buf.slice(0, cut)), /cut short/, `cut at ${cut}`);
  const padded = new Uint8Array(buf.byteLength + 1); padded.set(new Uint8Array(buf));
  assert.throws(() => unpackThread(padded.buffer), /left over/);
  assert.deepEqual(unpackThread(Array.from(new Uint8Array(buf))).map((m) => m.id), ['a', 'b']);
});

check('the layout is the one the backend writes (lib.rs documents and writes the same words)', () => {
  const lib = read('src-tauri/src/lib.rs');
  assert.ok(lib.includes('u32 length of the metadata JSON') && lib.includes('(0 = none, n + 1 = n bytes)'), 'the layout comment');
  assert.ok(/out\.extend_from_slice\(&code\(h\)\?\.to_le_bytes\(\)\);\s*out\.extend_from_slice\(&code\(t\)\?\.to_le_bytes\(\)\);/.test(lib), 'html code then text code, little-endian');
  const ts = read('src/threadPack.ts');
  assert.ok(ts.includes('getUint32(at, true)') && ts.includes('getUint32(at + 4, true)') && ts.includes('getUint32(0, true)'), 'little-endian reads');
});

check('api.getThread asks the packed command; nothing else in the page asks get_thread; the page keeps no raw buffer', () => {
  const api = read('src/api.ts');
  assert.ok(/getThread: async[\s\S]{0,400}unpackThread\(await invoke<ArrayBuffer>\("get_thread_packed", \{ threadId, scope: scope \?\? null, light: light \?\? null \}\)\)/.test(api), 'getThread');
  const files = [];
  const walk = (d) => { for (const f of fs.readdirSync(path.join(root, d), { withFileTypes: true })) { const p = `${d}/${f.name}`; if (f.isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f.name)) files.push(p); } };
  walk('src');
  for (const f of files) {
    if (f === 'src/devMock.ts') continue;
    assert.ok(!/["']get_thread["']/.test(read(f)), `${f} asks get_thread (the JSON form)`);
  }
  const dev = read('src/devMock.ts');
  assert.ok(dev.includes('if (cmd === "get_thread_packed")') && dev.includes('packThread('), 'the dev preview packs the same way');
  // (a module-level store of the answer would keep the 2 MB alive: the only cache of a body is the bounded CLEANED map of the reading pane)
  assert.ok(!/new Map<[^>]*ArrayBuffer/.test(api) && !/let\s+\w*[Bb]uffer\w*\s*:\s*ArrayBuffer/.test(api + read('src/threadPack.ts')), 'no kept buffer');
});

check('the command is in the three places and in the capability of every window that reads a conversation', () => {
  const lib = read('src-tauri/src/lib.rs');
  assert.ok(lib.includes('async fn get_thread_packed(') && /generate_handler!\[[\s\S]*?\bget_thread_packed,/.test(lib));
  assert.ok(read('src-tauri/build.rs').includes('"get_thread_packed"'));
  const caps = (f) => JSON.parse(read(`src-tauri/capabilities/${f}.json`)).permissions;
  for (const f of ['default', 'popout']) assert.ok(caps(f).includes('allow-get-thread') && caps(f).includes('allow-get-thread-packed'), `${f}: both`);
  for (const f of ['settings', 'event', 'search', 'scheduled']) assert.ok(!caps(f).includes('allow-get-thread-packed'), `${f} must not read bodies`);
});

console.log(`${process.exitCode ? 'FAILED' : 'ok'} - test-thread-pack (${n} checks)`);
