#!/usr/bin/env node
// An SVG written as a data URI must have its `#` (colours), `<` and `>` percent-encoded (%23 %3C %3E): WebKit (and Firefox) read a raw `#` as the start of the URL fragment and the picture
// is cut off, so an icon that paints in Chromium is simply missing on macOS and Linux (1.0.10: the shield of the hidden-picture box). A data URI made at run time with encodeURIComponent is fine.
// Looks at every tracked source file of src/, public/ and docs/ (css, ts, tsx, js, html).
//   node scripts/test-svg-data-uri.mjs
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './cdp-harness.mjs';

const files = execSync('git ls-files -- src public docs', { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((f) => /\.(css|ts|tsx|js|mjs|html)$/.test(f));
let uris = 0;
const bad = [];
for (const f of files) {
  const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const re = /data:image\/svg\+xml[;,][^"`)]*/g;
  let m;
  while ((m = re.exec(text))) {
    const chunk = m[0];
    if (chunk.includes('${') || chunk.includes('encodeURIComponent')) continue; // made at run time
    uris++;
    const line = text.slice(0, m.index).split('\n').length;
    for (const [ch, name] of [['#', 'a raw # (use %23)'], ['<', 'a raw < (use %3C)'], ['>', 'a raw > (use %3E)']]) if (chunk.includes(ch)) bad.push(`${f}:${line}: ${name}: ${chunk.slice(0, 90)}`);
  }
}
if (bad.length) { console.error(`test-svg-data-uri: FAILED\n  ${bad.join('\n  ')}`); process.exit(1); }
console.log(`test-svg-data-uri: ok (${uris} SVG data URIs in ${files.length} files, all percent-encoded)`);
