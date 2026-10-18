#!/usr/bin/env node
// No control character in the sources. A raw backspace (0x08) typed where `\b` was meant sat inside four test regexes for a week and made the
// three CSP guards of test-csp-ready.mjs unable to fail; a raw NUL in src/readIntent.ts made grep and code search treat the file as binary.
// Anything below U+0020 other than tab, LF and CR in src/, src-tauri/src/ and scripts/ (.ts .tsx .rs .mjs .cjs .js .css .html .json; scripts/fixtures/ left out,
// they hold test inputs on purpose) fails with the file and line. Write the escape (`\b`, `\u0000`) instead.
//
//   node scripts/test-source-chars.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = new Set(['.ts', '.tsx', '.rs', '.mjs', '.cjs', '.js', '.css', '.html', '.json']);
const DIRS = ['src', 'src-tauri/src', 'scripts'];
const SKIP = (rel) => rel.startsWith('scripts/fixtures/') || rel.startsWith('src-tauri/vendor/') || rel.includes('/node_modules/');

/** Returns [{ file, line, code }] for every forbidden character under `root`. */
export function scan(root) {
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (SKIP(rel + (e.isDirectory() ? '/' : ''))) continue;
      if (e.isDirectory()) walk(rel);
      else if (EXT.has(path.extname(e.name))) {
        const text = fs.readFileSync(path.join(root, rel), 'utf8');
        if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) continue;
        text.split('\n').forEach((l, i) => {
          const m = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.exec(l);
          if (m) found.push({ file: rel, line: i + 1, code: m[0].charCodeAt(0) });
        });
      }
    }
  };
  for (const d of DIRS) if (fs.existsSync(path.join(root, d))) walk(d);
  return found;
}

// the check can fail: a scratch tree with a backspace in src/ and one in a fixture (left out)
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-chars-'));
  try {
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'scripts/fixtures'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src/a.ts'), 'const ok = 1;\nconst re = /<style\u0008/;\n');
    fs.writeFileSync(path.join(tmp, 'scripts/fixtures/x.json'), '{"a":"\u0001"}');
    fs.writeFileSync(path.join(tmp, 'src/tabs.ts'), 'a\tb\r\n');
    const r = scan(tmp);
    if (r.length !== 1 || r[0].file !== 'src/a.ts' || r[0].line !== 2 || r[0].code !== 8) {
      console.error(`test-source-chars: the check itself is broken: ${JSON.stringify(r)}`);
      process.exit(1);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const bad = scan(ROOT);
if (bad.length) {
  console.error('test-source-chars: control characters in the sources (write the escape instead: \b, \u0000 ...):\n  ' + bad.map((b) => `${b.file}:${b.line} has U+${b.code.toString(16).padStart(4, '0')}`).join('\n  '));
  process.exit(1);
}
console.log('test-source-chars: ok');
