import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const rev = process.argv[2];
const read = (f) => { if (!rev) { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } } try { return execFileSync('git', ['show', `${rev}:${f}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1e8 }); } catch { return null; } };
const seen = new Set();
function resolve(from, spec) {
  const base = path.posix.join(path.posix.dirname(from), spec);
  for (const c of [base, base + '.ts', base + '.tsx', base + '/index.ts', base.replace(/\.js$/, '.ts')]) if (read(c) !== null && /\.(ts|tsx)$/.test(c)) return c;
  return null;
}
function walk(f) {
  if (seen.has(f)) return;
  const src = read(f);
  if (src === null) return;
  seen.add(f);
  const stat = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const m of stat.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^;'"]*?from\s*["'](\.[^"']+)["']|(?:^|\n)\s*import\s*["'](\.[^"']+)["']/g)) {
    const r = resolve(f, m[1] ?? m[2]);
    if (r) walk(r);
  }
}
walk('src/main.tsx');
console.log([...seen].sort().join('\n'));
