#!/usr/bin/env node
// Header text made from received data: a Subject or a name with a line break or another control character (v1.0.6 QA round 2, BUG-1: a reply to a message
// whose Subject held CR LF was sent with those two bytes inside the encoded Subject, which decodes to two lines). src/headerText.ts, the cleaning the front end
// does where an answer is made (actions.ts, Compose.tsx), and the same rule of the backend (src-tauri/src/smtp.rs `clean_header_text`, checked in cargo test).
//   node --experimental-strip-types scripts/test-header-text.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanHeaderText } from '../src/headerText.ts';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// one space for every kind of line break, a tab, VT, FF; CR LF counts once
assert.equal(cleanHeaderText('O04\r\nBcc: bcc@x.test'), 'O04 Bcc: bcc@x.test');
assert.equal(cleanHeaderText('a\nb'), 'a b');
assert.equal(cleanHeaderText('a\rb'), 'a b');
assert.equal(cleanHeaderText('a\tb\vc\fd'), 'a b c d');
assert.equal(cleanHeaderText('a\u0085b\u2028c\u2029d'), 'a b c d');
assert.equal(cleanHeaderText('a\n\nb'), 'a  b', 'two breaks are two spaces (nothing is collapsed: a typed double space is kept as well)');
// other controls are dropped
assert.equal(cleanHeaderText('a\u0000b\u0001c\u001bd\u007fe\u0080f\u009fg'), 'abcdefg');
// nothing else changes
for (const s of ['', 'Re: plain', '  two  spaces  ', 'Đỗ Văn Ánh <a@x.test>', '東京 🚀 Привет', '"Doe, John" <john@x.test>', 'a b', 'tab in text']) assert.equal(cleanHeaderText(s), s);
// hostile subjects and names: no CR, no LF, no control character is left, whatever the input
const hostile = ['x\r\nBcc: evil@x.test', 'x\r\n\r\nBody injection', 'x\n\rBcc: a', '\r\n\r\n', 'a\r\n b\r\n\tc', 'x\u0085Bcc: a', 'x\u2028Bcc: a', 'a\u0000\r\nb', '\u001b[31mred', 'name\r\n" <evil@x.test>'];
for (const h of hostile) assert.ok(!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(cleanHeaderText(h)), `control left in ${JSON.stringify(h)} -> ${JSON.stringify(cleanHeaderText(h))}`);
assert.equal(cleanHeaderText('Re: O04\r\nBcc: bcc@x.test'), 'Re: O04 Bcc: bcc@x.test', 'the subject of the QA repro');

// the answer is made with it: subject, To and Cc of a reply, the subject of a forward, and again when Compose opens (a draft, a link)
const actions = read('../src/actions.ts');
assert.match(actions, /const subject = cleanHeaderText\(m\.subject\);\s*const reSubject = \/\^re:\/i\.test\(subject\) \? subject : `Re: \$\{subject\}`;[\s\S]*subject: reSubject,/, 'a reply uses the cleaned subject');
assert.match(actions, /const subject = cleanHeaderText\(m\.subject\);\s*const fwdSubject = \/\^fwd\?:\/i\.test\(subject\) \? subject : `Fwd: \$\{subject\}`;[\s\S]*subject: fwdSubject,/, 'a forward uses the cleaned subject');
assert.match(actions, /to: targets\.to\.map\(cleanHeaderText\),\s*cc: targets\.cc\.map\(cleanHeaderText\),/, 'a reply cleans its recipients');
const compose = read('../src/components/Compose.tsx');
assert.match(compose, /useState\(cleanHeaderText\(init\.subject \?\? ""\)\)/, 'Compose cleans the subject it opens with');
assert.match(compose, /\(init\.to \?\? \[\]\)\.map\(cleanHeaderText\)/);
assert.match(compose, /\(init\.cc \?\? \[\]\)\.map\(cleanHeaderText\)/);
assert.match(compose, /\(init\.bcc \?\? \[\]\)\.map\(cleanHeaderText\)/);
// the backend does the same when the MIME is built
const smtp = read('../src-tauri/src/smtp.rs');
assert.match(smtp, /fn clean_header_text\(/, 'the backend has the same rule');
assert.match(smtp, /\.subject\(clean_header_text\(&d\.subject\)\)/, 'the subject of every message built is cleaned');
console.log('ok - test-header-text');
