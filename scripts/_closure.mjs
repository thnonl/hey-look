import fs from 'node:fs';
import zlib from 'node:zlib';
const dir = 'dist/assets/';
const html = fs.readFileSync('dist/index.html', 'utf8');
const entry = [...html.matchAll(/assets\/([^"]+\.js)/g)].map((m) => m[1]);
const seen = new Map();
function walk(f) {
  if (seen.has(f)) return;
  const src = fs.readFileSync(dir + f, 'utf8');
  seen.set(f, zlib.gzipSync(src, { level: 9 }).length);
  // static imports only: import ... from "./x.js" / import "./x.js" at the top (not import("..."))
  for (const m of src.matchAll(/(?:^|[;}\n])\s*import\s*(?:[^"'(]*?from\s*)?["']\.\/([^"']+\.js)["']/g)) walk(m[1]);
}
entry.forEach(walk);
const rows = [...seen].sort((a, b) => b[1] - a[1]);
console.log(rows.reduce((n, r) => n + r[1], 0), rows.length);
for (const [f, n] of rows.slice(0, 40)) console.log(n, f.replace(/-[A-Za-z0-9_]{6,}\.js$/, ''));
