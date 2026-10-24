import fs from 'node:fs';
const api = fs.readFileSync('src/api.ts', 'utf8');
const map = {};
for (const m of api.matchAll(/^\s{2}(\w+):[^\n]*?invoke(?:<[^>]*(?:<[^>]*>)?[^>]*>)?\("(\w+)"/gm)) map[m[1]] = m[2];
const cmds = new Set(), unknown = new Set();
for (const file of process.argv.slice(2)) {
  const src = fs.readFileSync(file, 'utf8');
  const mine = new Set();
  for (const m of src.matchAll(/\bapi\.(\w+)/g)) { if (map[m[1]]) mine.add(map[m[1]]); else unknown.add(m[1]); }
  for (const m of src.matchAll(/invoke(?:<[^>]*>)?\(\s*["'](\w+)["']/g)) mine.add(m[1]);
  console.log(file, [...mine].sort().join(' '));
  mine.forEach((c) => cmds.add(c));
}
console.log('ALL', [...cmds].sort().join(' '));
console.log('UNKNOWN', [...unknown].sort().join(' '));
